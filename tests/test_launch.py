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
    assert hooks["PreToolUse"][0]["matcher"] == "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell"
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
    assert hooks["PreToolUse"][0]["matcher"] == "Edit|Write|MultiEdit|Bash|Shell|run_terminal_cmd|run_command"


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
    # print mode loads the plugin; its steps come as JSON events, shown by runview
    assert "& 'agy' '--print-timeout' '0s' '--output-format' 'stream-json' '-p' 'You are the ''worker-b'' agent" in script
    assert "| & " in script and "'agent_org.runview'" in script


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
    assert f"'--conversation' '{sid}' '--print-timeout' '0s' '--output-format' 'stream-json' '-p' 'agent-org: the team was restarted" in script
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



def test_tests_can_never_open_real_agent_tabs():
    with pytest.raises(launch.HubError, match="inside a test"):
        launch.open_tab(["wt", "new-tab", "pwsh"])


def test_deepseek_runs_headless_with_org_tools_shown_live_and_again_until_stopped(team_file, monkeypatch):
    monkeypatch.setattr(launch, "deepseek_command", lambda: ("node.exe", ["bin.js"], {}))
    config = yaml.safe_load(team_file.read_text(encoding="utf-8"))
    config["roles"]["worker-a"].update(harness="deepseek", model="deepseek-v4-pro", effort="high")
    team_file.write_text(yaml.safe_dump(config), encoding="utf-8")
    hub = Hub.open(team_file)
    try:
        launch.role_tab(hub, team_file.resolve(), "worker-a")
        out = team_file.parent / ".agent-org" / "launch" / "worker-a"
        patch = yaml.safe_load((out / "dsh.patch.yml").read_text(encoding="utf-8"))
        tools = patch[0]["insert"][0]
        assert tools["name"] == "@deepseek-ai/dsh-mcp-client" and tools["config"]["serverName"] == "org"
        assert tools["config"]["args"][-2:] == ["--role", "worker-a"]
        assert tools["config"]["env"]["AGENT_ORG_ROLE"] == "worker-a"
        assert tools["config"]["toolCallTimeoutMs"] > launch.WAIT_LIMIT * 1000  # a long wait_for_messages fits
        assert patch[1] == {"id": "agent-default-model", "config": {
            "provider": "deepseek-official", "model": "deepseek-v4-pro", "reasoningEffort": "high"}}
        script = (out / "start.ps1").read_text(encoding="utf-8")
        # each run: JSON events shown live by runview, continuing the conversation kept in dsh.session
        assert "'--profile' 'headless' '--patch'" in script and "'--json' @resume" in script
        assert "'agent_org.runview' '--session-file'" in script and str(out / "dsh.session") in script
        assert "'--session-id', $sid" in script
        # after each run: wait for new messages without a model, then run again with the wake prompt
        assert "'agent_org.wake'" in script and "you have new messages" in script
        assert str(out / "stopped") in script and "$LASTEXITCODE -ne 0" in script
        launch.stop_role(hub, "worker-a")
        assert (out / "stopped").exists()
        (out / "dsh.session").write_text("session-1234", encoding="utf-8")  # a run kept its conversation
        assert launch.resumable_session(hub, "worker-a") == "session-1234"
        launch.role_tab(hub, team_file.resolve(), "worker-a")  # Start: lifts the stop, resumes it
        assert not (out / "stopped").exists() and (out / "dsh.session").exists()
        assert "agent-org: the team was restarted" in (out / "start.ps1").read_text(encoding="utf-8")
        launch.role_tab(hub, team_file.resolve(), "worker-a", fresh=True)  # Start fresh: a new conversation
        assert not (out / "dsh.session").exists()
    finally:
        hub.close()


def test_runview_shows_a_deepseek_run_and_keeps_its_session(tmp_path, monkeypatch):
    import io
    import sys as _sys
    from agent_org import runview
    events = "\n".join(json.dumps(e) for e in [
        {"type": "session", "sessionId": "session-abc"},
        {"type": "status", "phase": "turn_start"},
        {"type": "tool_call", "tool": "mcp__org__send_message", "input": {"to": "you", "text": "done"}},
        {"type": "tool_result", "status": "completed", "result": "Sent #7."},
        {"type": "tool_call", "tool": "read", "input": {"file_path": "x.py"}},
        {"type": "tool_result", "status": "failed", "result": "no such file"},
        {"type": "text", "text": "All done."},
        {"type": "final", "text": "All done."},
    ]) + "\n"
    monkeypatch.setattr(_sys, "stdin", io.TextIOWrapper(io.BytesIO(events.encode("utf-8"))))
    shown = io.BytesIO()
    monkeypatch.setattr(_sys, "stdout", io.TextIOWrapper(shown, encoding="utf-8"))
    assert runview.main(["--session-file", str(tmp_path / "sid")]) == 0
    text = re.sub(r"\x1b\[[0-9;]*m", "", shown.getvalue().decode("utf-8"))  # without its colors
    assert "org.send_message(to=you, text=done)" in text and "Sent #7." in text
    assert "failed: no such file" in text
    assert text.count("All done.") == 1  # the final answer is not shown twice
    assert (tmp_path / "sid").read_text(encoding="utf-8") == "session-abc"


def test_the_deepseek_waiter_wakes_on_a_message_and_ends_on_stop(team_file, tmp_path):
    from agent_org import wake
    hub = Hub.open(team_file)
    try:
        marker = tmp_path / "stopped"
        hub.store.check_in(999999, "worker-a")  # a run that ended without checking out
        hub.session("leader").send("worker-a", "please start")
        assert wake.wait_for_work(hub, "worker-a", marker, poll=0.01) == 0  # something new: run again
        assert hub.store.online().get("worker-a", 0) == 0  # it checked out again, and the leftover is gone
        hub.session("worker-a").read_inbox()
        marker.write_text("stopped")
        assert wake.wait_for_work(hub, "worker-a", marker, poll=0.01) == wake.STOPPED
    finally:
        hub.close()



def test_runview_shows_an_antigravity_run_as_it_streams(monkeypatch):
    import io
    import sys as _sys
    from agent_org import runview
    step = lambda **kw: json.dumps({"event": "step_update", "step_update": kw})  # noqa: E731
    events = "\n".join([
        json.dumps({"event": "init", "conversation_id": "c-1", "init": {"tools": []}}),
        step(step_index=1, state="ACTIVE", step_type="tool", tool_name="mcp_org_read_inbox",
             tool_info={"name": "mcp_org_read_inbox", "parameters": {}}),
        step(step_index=1, state="DONE", step_type="tool", tool_name="mcp_org_read_inbox",
             tool_info={"name": "mcp_org_read_inbox", "output": "1 new message"}),
        step(step_index=3, state="ACTIVE", step_type="tool", tool_name="call_mcp_tool", tool_info={
            "name": "call_mcp_tool", "parameters": {"ServerName": "agent-org_org", "ToolName": "send_message",
                                                    "Arguments": '{"to": "you", "text": "pong"}'}}),
        step(step_index=2, state="ACTIVE", step_type="agent_response", text_delta="Working on "),
        step(step_index=2, state="DONE", step_type="agent_response", text_delta="task #3.\n"),
        json.dumps({"event": "result", "result": {"status": "SUCCESS", "response": "Working on task #3."}}),
    ]) + "\n"
    monkeypatch.setattr(_sys, "stdin", io.TextIOWrapper(io.BytesIO(events.encode("utf-8"))))
    shown = io.BytesIO()
    monkeypatch.setattr(_sys, "stdout", io.TextIOWrapper(shown, encoding="utf-8"))
    assert runview.main([]) == 0
    text = re.sub(r"\x1b\[[0-9;]*m", "", shown.getvalue().decode("utf-8"))  # without its colors
    assert "conversation c-1" in text and "org.read_inbox()" in text and "1 new message" in text
    assert "Working on task #3." in text  # the streamed pieces join into one line
    assert "org.send_message(to=you, text=pong)" in text  # its MCP wrapper reads like the other programs'
