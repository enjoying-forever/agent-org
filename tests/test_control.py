"""Stopping agents and checking the setup."""

import os
import shutil
import subprocess
import sys
import time

import pytest

from agent_org import doctor, launch

needs_windows = pytest.mark.skipif(os.name != "nt", reason="uses tasklist/taskkill")


@needs_windows
@pytest.mark.skipif(shutil.which("node") is None, reason="needs node to stand in for a harness")
def test_stop_ends_the_harness_program(hub):
    stand_in = subprocess.Popen(["node", "-e", "setTimeout(() => {}, 60000)"])
    try:
        hub.store.check_in(999_001, "worker-a", stand_in.pid)
        assert launch.program_name(stand_in.pid) == "node.exe"
        assert launch.stop_role(hub, "worker-a") == 1
        stand_in.wait(timeout=15)
        assert hub.store.online().get("worker-a", 0) == 0
    finally:
        stand_in.kill()


@needs_windows
def test_stop_never_touches_other_programs(hub):
    bystander = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        hub.store.check_in(999_002, "worker-b", bystander.pid)
        assert launch.stop_role(hub, "worker-b") == 0  # python.exe is not a harness
        time.sleep(0.5)
        assert bystander.poll() is None
        assert hub.store.online().get("worker-b", 0) == 0  # but the stale check-in is gone
    finally:
        bystander.kill()


def test_program_name_of_a_missing_process():
    assert launch.program_name(4_000_000) == ""


# setup checks


def test_a_missing_program_says_how_to_install_it(monkeypatch):
    monkeypatch.setattr(doctor.shutil, "which", lambda name: None)
    check = doctor.check_codex({"codex"})
    assert (check.ok, check.detail, check.needed) == (False, "not installed", True)
    assert "npm install -g @openai/codex" in check.fix


def test_a_broken_claude_install_gets_the_repair_command(monkeypatch, tmp_path):
    shim = tmp_path / "claude.cmd"
    shim.write_text("")
    script = tmp_path / "node_modules" / "@anthropic-ai" / "claude-code" / "install.cjs"
    script.parent.mkdir(parents=True)
    script.write_text("")
    monkeypatch.setattr(doctor.shutil, "which", lambda name: str(shim))
    monkeypatch.setattr(doctor, "run", lambda command, timeout=40: (1, "not a valid application"))
    check = doctor.check_claude({"claude"})
    assert not check.ok and check.detail.startswith("installed but does not start")
    assert check.fix == f'An update did not finish. Repair it with: node "{script}"'


def test_unused_programs_are_not_required(monkeypatch):
    monkeypatch.setattr(doctor.shutil, "which", lambda name: None)
    assert doctor.check_grok({"claude"})[0].needed is False


def test_grok_sign_in_and_hooks_are_checked(monkeypatch, tmp_path):
    monkeypatch.setattr(doctor.shutil, "which", lambda name: "grok")
    monkeypatch.setattr(doctor, "run", lambda command, timeout=40:
                        (0, "You are not authenticated.") if "models" in command else (0, "grok 1.0.13"))
    monkeypatch.setattr(doctor.Path, "home", classmethod(lambda cls: tmp_path))
    names = {c.name: c for c in doctor.check_grok({"grok"})}
    assert names["Grok"].ok and not names["Grok sign-in"].ok
    assert names["Grok sign-in"].fix == "Run: grok login"
    assert not names["Grok message delivery"].ok


def test_antigravity_sign_in_problem_is_explained(monkeypatch):
    monkeypatch.setattr(doctor.shutil, "which", lambda name: "agy")
    monkeypatch.setattr(doctor, "_agy_signin", (0.0, None))
    monkeypatch.setattr(doctor, "run", lambda command, timeout=40: (0, "agy 1.2.7") if "--version" in command
                        else (1, "Please verify your account in your browser to continue: https://..."))
    checks = {c.name: c for c in doctor.check_antigravity({"antigravity"})}
    assert checks["Antigravity"].ok and not checks["Antigravity sign-in"].ok
    assert "finish the sign-in" in checks["Antigravity sign-in"].fix
    assert doctor.check_antigravity(set())[0].needed is False  # not used: no sign-in test at all


def test_the_antigravity_sign_in_test_runs_no_model(monkeypatch):
    ran = []
    monkeypatch.setattr(doctor.shutil, "which", lambda name: "agy")
    monkeypatch.setattr(doctor, "_agy_signin", (0.0, None))

    def run(command, timeout=40):
        ran.append(command[1:])
        return (0, "agy 1.2.7") if "--version" in command else (0, "Fetching...\ngemini-3.8-flash-high\tGemini 3.8 Flash")

    monkeypatch.setattr(doctor, "run", run)
    checks = {c.name: c for c in doctor.check_antigravity({"antigravity"})}
    assert checks["Antigravity sign-in"].ok
    assert ["models"] in ran and not any("-p" in c for c in ran)  # it lists models; it never prompts one


def test_with_no_team_open_any_one_program_will_do(monkeypatch):
    present = {"claude"}
    monkeypatch.setattr(doctor.shutil, "which", lambda name: name if name in present | {"pwsh"} else None)
    monkeypatch.setattr(doctor, "run", lambda command, timeout=40: (0, "1.0"))
    monkeypatch.setattr(launch, "deepseek_command", lambda: None)
    checks = {c.name: c for c in doctor.run_checks()}
    assert checks["Claude Code"].ok and not checks["Codex"].ok
    assert all(not c.needed for name, c in checks.items() if name in ("Codex", "Grok", "Antigravity"))  # no red
    assert "Agent programs" not in checks
    present.clear()  # nothing at all: that one is a real problem
    checks = {c.name: c for c in doctor.run_checks()}
    assert not checks["Agent programs"].ok and checks["Agent programs"].needed


def test_no_agent_starts_without_powershell_7(monkeypatch):
    monkeypatch.setattr(launch.shutil, "which", lambda name: None if name == "pwsh" else name)
    assert "winget install Microsoft.PowerShell" in launch.cannot_start(in_window=True)
    monkeypatch.setattr(launch.shutil, "which", lambda name: None if name == "wt" else name)
    assert launch.cannot_start(in_window=True) == ""  # the window hosts the agents itself
    assert "Windows Terminal" in launch.cannot_start(in_window=False)


def test_each_starting_team_says_which_programs_it_uses():
    from agent_org import templates
    programs = {t["id"]: t["programs"] for t in templates.catalogue() if not t["mine"]}
    assert programs["solo"] == ["claude"] and programs["pair"] == ["claude", "codex"]
