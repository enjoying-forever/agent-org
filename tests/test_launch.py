import json
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
    data["roles"]["worker-a"].update(model="gpt-6-astra", effort="low")
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
    assert "'--model' 'opus' '--effort' 'high' '--name' 'leader' 'You are the ''leader'' agent" in script


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


def test_unsupported_harnesses_are_skipped(team_file, capsys):
    base = run_dry(team_file)
    assert "skipping researcher: grok" in capsys.readouterr().err
    assert sorted(p.name for p in base.iterdir()) == ["leader", "tech-lead", "worker-a", "you"]


def test_owner_console(team_file):
    script = (run_dry(team_file) / "you" / "start.ps1").read_text(encoding="utf-8")
    assert "function org {" in script and "org tree" in script
    assert "org send leader" in script


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
