import json
import re
import shutil
import subprocess
import tomllib

import pytest
import yaml

from agent_org import launch
from agent_org.hub import Hub

from .conftest import TEAM


@pytest.fixture
def team_file(tmp_path):
    (tmp_path / "project").mkdir()
    data = json.loads(json.dumps(TEAM))
    data["roles"]["leader"].update(model="opus", effort="high", duties="Plan it; don't code.")
    data["roles"]["worker-a"].update(model="gpt-6-luna", effort="low")
    path = tmp_path / "team.yaml"
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    return path


def run_dry(team_file, *roles):
    assert launch.main(["--team", str(team_file), "--dry-run", *roles]) == 0
    return team_file.parent / ".agent-org" / "launch"


@pytest.mark.parametrize("value", [
    "plain", "quotes \" and 'single'", "back\\slash C:\\x\\y", "line one\nline two\ttab", "中文 ✓",
    ["-m", "agent_org.mcp_server", "C:\\a b\\team.yaml"], {"PYTHONPATH": "E:\\code\\agent-org"}, 3600,
])
def test_toml_values_round_trip(value):
    assert tomllib.loads(f"x = {launch.toml(value)}")["x"] == value


def test_ps_literal_doubles_single_quotes():
    assert launch.ps("it's") == "'it''s'"


def test_claude_role_files(team_file):
    out = run_dry(team_file, "leader") / "leader"
    config = json.loads((out / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]["org"]
    assert config["args"][-2:] == ["--role", "leader"]
    assert config["env"]["PYTHONPATH"] == str(launch.PACKAGE_ROOT)
    assert "You are 'leader'" in (out / "role.md").read_text(encoding="utf-8")
    script = (out / "start.ps1").read_text(encoding="utf-8")
    assert "$env:AGENT_ORG_ROLE = 'leader'" in script
    assert "$env:MCP_TOOL_TIMEOUT = '3600000'" in script
    assert "$env:DISABLE_AUTOUPDATER = '1'" in script  # agents must not update the shared install
    assert re.search(r"'--model' 'opus' '--effort' 'high' '--session-id' '[0-9a-f-]{36}' '--name' 'leader' "
                     r"'You are the ''leader'' agent", script)


def test_codex_script_passes_valid_toml(team_file, tmp_path):
    out = run_dry(team_file, "worker-a") / "worker-a"
    script = (out / "start.ps1").read_text(encoding="utf-8")
    assert "& 'codex' " in script
    hub = Hub.open(team_file)
    try:
        built = launch.codex_launch(hub, team_file.resolve(), "worker-a", tmp_path)
    finally:
        hub.close()
    overrides = [built.args[i + 1] for i, a in enumerate(built.args) if a == "-c"]
    parsed = {}
    for override in overrides:
        key, _, value = override.partition("=")
        parsed[key] = tomllib.loads(f"v = {value}")["v"]
    assert parsed["mcp_servers.org.args"][-2:] == ["--role", "worker-a"]
    assert parsed["mcp_servers.org.tool_timeout_sec"] == launch.WAIT_LIMIT
    assert parsed["model_reasoning_effort"] == "low"
    assert "You are 'worker-a'" in parsed["developer_instructions"]
    assert built.args[-1] == launch.kickoff("worker-a")


def test_grok_registers_the_project_server_then_starts(team_file):
    base = run_dry(team_file, "researcher")
    script = (base / "researcher" / "start.ps1").read_text(encoding="utf-8")
    head, register, start = script.partition("& 'grok' 'mcp' 'add'")[0], *script.partition("| Out-Null\n")[::2]
    assert "Set-Location" in head  # registered in the project folder
    # the server entry carries no role; '--' stays quoted so PowerShell passes it on
    assert "'--scope' 'project' 'org' " in register
    assert "'--' '-m' 'agent_org.mcp_server'" in register and "--role" not in register
    start = start.strip()
    assert start.startswith("& 'grok' '--rules' 'You are ''researcher''")
    assert "'--allow' 'MCPTool(org__*)'" in start
    assert start.endswith(launch.ps(launch.kickoff("researcher")))


def test_every_harness_is_launched(team_file, capsys):
    base = run_dry(team_file)
    assert "skipping" not in capsys.readouterr().err
    assert sorted(p.name for p in base.iterdir()) == ["leader", "researcher", "tech-lead", "worker-a",
                                                      "worker-b", "you"]


def test_owner_console(team_file):
    script = (run_dry(team_file) / "you" / "start.ps1").read_text(encoding="utf-8")
    assert "function org {" in script and "org tree" in script
    assert "org send leader" in script


def test_consultant_tab_uses_its_tier(team_file):
    hub = Hub.open(team_file)
    try:
        request = hub.session("worker-a").ask_help("stuck")
        hub.session("tech-lead").summon_consultant(request.id, "medium")  # no opener: nothing opens
        tab = launch.role_tab(hub, team_file.resolve(), "consultant-1")
    finally:
        hub.close()
    assert tab[tab.index("--title") + 1] == "consultant-1 (medium)"
    out = team_file.parent / ".agent-org" / "launch" / "consultant-1"
    script = (out / "start.ps1").read_text(encoding="utf-8")
    assert re.search(r"'--model' 'claude-opus-5-5' '--effort' 'medium' '--session-id' '[0-9a-f-]{36}' "
                     r"'--name' 'consultant-1'", script)
    assert "temporary medium consultant" in (out / "role.md").read_text(encoding="utf-8")


def test_claude_gets_the_hooks_through_settings(team_file):
    out = run_dry(team_file, "leader") / "leader"
    hooks = json.loads((out / "settings.json").read_text(encoding="utf-8"))["hooks"]
    assert set(hooks) == {"SessionStart", "Stop", "PostToolUse", "PreToolUse"}
    assert hooks["PreToolUse"][0]["matcher"] == "Edit|Write|MultiEdit|NotebookEdit"
    stop = hooks["Stop"][0]["hooks"][0]
    assert stop["command"].endswith("org_hook.py stop") and stop["timeout"] > launch.STOP_WAIT
    script = (out / "start.ps1").read_text(encoding="utf-8")
    assert f"'--settings' '{out / 'settings.json'}'" in script


def test_codex_gets_the_hooks_through_config_overrides(team_file, tmp_path):
    hub = Hub.open(team_file)
    try:
        built = launch.codex_launch(hub, team_file.resolve(), "worker-a", tmp_path)
    finally:
        hub.close()
    overrides = [built.args[i + 1] for i, a in enumerate(built.args) if a == "-c"]
    hooks = {}
    for override in overrides:
        key, _, value = override.partition("=")
        if key.startswith("hooks."):
            hooks[key.removeprefix("hooks.")] = tomllib.loads(f"v = {value}")["v"]
    assert set(hooks) == {"SessionStart", "Stop", "PostToolUse", "PreToolUse"}
    assert "matcher" not in hooks["PreToolUse"][0]  # pre-edit picks out edits itself
    assert hooks["PostToolUse"][0]["hooks"][0]["command"].endswith("org_hook.py post-tool")


def test_running_roles_are_not_started_twice(team_file, capsys):
    hub = Hub.open(team_file)
    hub.store.check_in(123, "worker-a")
    try:
        tabs, skipped = launch.prepare(hub, team_file.resolve(), ["leader", "worker-a"], owner_tab=False)
        assert [t[t.index("--title") + 1] for t in tabs] == ["leader"]
        assert skipped == ["worker-a: already running"]
        tabs, skipped = launch.prepare(hub, team_file.resolve(), ["worker-a"], owner_tab=False, force=True)
        assert len(tabs) == 1 and skipped == []
    finally:
        hub.close()


def test_grok_hooks_install_into_the_home_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(launch.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.undo()  # drop conftest's stand-in to check the real location, under the fake home
    monkeypatch.setattr(launch.Path, "home", classmethod(lambda cls: tmp_path))
    path = launch.install_grok_hooks()
    assert path == tmp_path / ".grok" / "hooks" / "agent-org.json"
    hooks = json.loads(path.read_text(encoding="utf-8"))["hooks"]
    assert hooks["PreToolUse"][0]["matcher"] == "Edit|Write|MultiEdit"


def test_unknown_roles_are_refused(team_file):
    assert launch.main(["--team", str(team_file), "--dry-run", "ghost"]) == 2


@pytest.mark.skipif(shutil.which("pwsh") is None, reason="needs PowerShell 7")
def test_generated_scripts_parse_in_powershell(team_file):
    base = run_dry(team_file)
    for script in base.glob("*/start.ps1"):
        check = (
            "$errors = $null; "
            f"[System.Management.Automation.Language.Parser]::ParseFile('{script}', [ref]$null, [ref]$errors) | Out-Null; "
            "if ($errors) { $errors | ForEach-Object { $_.Message }; exit 1 }"
        )
        result = subprocess.run(["pwsh", "-NoProfile", "-Command", check], capture_output=True, text=True)
        assert result.returncode == 0, f"{script}: {result.stdout}{result.stderr}"


def test_antigravity_gets_a_project_plugin_and_starts_interactively(team_file):
    base = run_dry(team_file, "worker-b")  # worker-b runs on antigravity
    plugin = team_file.parent / "project" / ".agents" / "plugins" / "agent-org"
    assert json.loads((plugin / "plugin.json").read_text(encoding="utf-8")) == {"name": "agent-org"}
    server = json.loads((plugin / "mcp_config.json").read_text(encoding="utf-8"))["mcpServers"]["org"]
    assert server["args"] == ["-m", "agent_org.mcp_server"]  # the role comes from each tab
    hooks = json.loads((plugin / "hooks.json").read_text(encoding="utf-8"))["agent-org"]
    assert set(hooks) == {"PreToolUse", "PreInvocation", "Stop"}
    stop = hooks["Stop"][0]["command"]
    assert '"' not in stop and stop.endswith("org_hook.py stop agy")  # runs as it is in cmd /c
    script = (base / "worker-b" / "start.ps1").read_text(encoding="utf-8")
    assert "& 'agy' '--prompt-interactive' 'You are the ''worker-b'' agent" in script


def test_antigravity_resumes_by_conversation(team_file, tmp_path, monkeypatch):
    from agent_org import sessions
    monkeypatch.setattr(sessions, "home", lambda: tmp_path / "home")
    sid = "0eee4d8d-dfcd-442e-a1f7-97d6c580cb62"
    folder = tmp_path / "home" / ".gemini" / "antigravity-cli" / "conversations"
    folder.mkdir(parents=True)
    (folder / f"{sid}.db").write_bytes(b"...")
    hub = Hub.open(team_file)
    try:
        hub.store.record_session_id("worker-b", "antigravity", sid)
        tab = launch.role_tab(hub, team_file.resolve(), "worker-b")
    finally:
        hub.close()
    script = (team_file.parent / ".agent-org" / "launch" / "worker-b" / "start.ps1").read_text(encoding="utf-8")
    assert f"'--conversation' '{sid}' '--prompt-interactive' 'agent-org: the team was restarted" in script
    assert tab


def test_hook_commands_run_in_powershell_cmd_and_bash():
    """Grok and Codex run hooks through PowerShell, where a quoted program path is a ParserError."""
    command = launch.hook_command("stop")
    assert '"' not in command and "\\" not in command
    assert command.endswith("org_hook.py stop")


def test_outdated_grok_hooks_are_reported_and_refreshed():
    path = launch.grok_hooks_file()
    assert launch.grok_hooks_state() == "missing"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"hooks": {"Stop": [{"hooks": [{"command": "\\"python\\" \\"org_hook.py\\" stop"}]}]}}',
                    encoding="utf-8")  # the quoted form PowerShell cannot parse
    assert launch.grok_hooks_state() == "outdated"
    launch.install_grok_hooks()
    assert launch.grok_hooks_state() == "current"


def test_antigravity_hooks_only_edit_tools(tmp_path):
    """Antigravity treats a pre-tool answer without a decision as "deny": hooking every tool blocked them all."""
    folder = launch.antigravity_plugin(tmp_path)
    pre = json.loads((folder / "hooks.json").read_text(encoding="utf-8"))["agent-org"]["PreToolUse"][0]
    assert "write_to_file" in pre["matcher"] and "call_mcp_tool" not in pre["matcher"] and pre["matcher"] != "*"


def fake_zcode(tmp_path, monkeypatch):
    base = tmp_path / "Local" / "Programs" / "ZCode"
    (base / "resources" / "glm").mkdir(parents=True)
    (base / "ZCode.exe").write_bytes(b"")
    (base / "resources" / "glm" / "zcode.cjs").write_text("", encoding="utf-8")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    return base


def test_zcode_role_is_the_desktop_app_set_up_for_the_project(team_file, tmp_path, monkeypatch):
    base = fake_zcode(tmp_path, monkeypatch)
    data = yaml.safe_load(team_file.read_text(encoding="utf-8"))
    data["roles"]["worker-b"]["harness"] = "zcode"
    team_file.write_text(yaml.safe_dump(data), encoding="utf-8")
    project = team_file.parent / "project"
    (project / ".zcode").mkdir()
    (project / ".zcode" / "config.json").write_text(json.dumps({"permission": {"mode": "build"}, "hooks": {
        "events": {"Stop": [{"hooks": [{"type": "command", "command": "mine.cmd"}]}]}}}), encoding="utf-8")
    hub = Hub.open(team_file)
    try:
        built = launch.zcode_launch(hub, team_file, "worker-b", tmp_path)
        assert built.command == str(base / "ZCode.exe") and built.args == [str(project)]
        assert built.setup[0][0] == "Set-Clipboard" and "worker-b" in built.setup[0][1]
        config = json.loads((project / ".zcode" / "config.json").read_text(encoding="utf-8"))
        assert config["permission"] == {"mode": "build"}  # the user's own settings stay
        server = config["mcp"]["servers"]["org"]
        assert server["args"][-4:] == ["--team", str(team_file), "--role", "worker-b"]
        stop = config["hooks"]["events"]["Stop"]
        assert stop[0]["hooks"][0]["command"] == "mine.cmd"  # their hook kept, ours added
        ours = stop[1]["hooks"][0]
        assert "org_hook.py stop --team" in ours["command"] and "--role worker-b" in ours["command"]
        assert ours["timeoutMs"] == (launch.ZCODE_STOP_WAIT + 60) * 1000
        launch.zcode_launch(hub, team_file, "worker-b", tmp_path)  # again: ours replaced, not doubled
        again = json.loads((project / ".zcode" / "config.json").read_text(encoding="utf-8"))
        assert len(again["hooks"]["events"]["Stop"]) == 2
    finally:
        hub.close()


def test_only_one_zcode_role(team_file):
    from agent_org.team import Team, TeamError
    data = yaml.safe_load(team_file.read_text(encoding="utf-8"))
    data["roles"]["worker-a"]["harness"] = data["roles"]["worker-b"]["harness"] = "zcode"
    with pytest.raises(TeamError, match="only one role can use zcode"):
        Team.from_dict(data, base_dir=team_file.parent)
