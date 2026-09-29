import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
import yaml

from agent_org import hooks
from agent_org.store import Store

from .conftest import TEAM

ROOT = Path(__file__).resolve().parent.parent


# stop: remind once, then deliver mail


def test_mail_already_waiting_comes_before_reminders(hub):
    hub.session("tech-lead").send("worker-a", "build the login form")
    hub.session("worker-a").claim("src/app.py")
    out = hooks.on_stop(hub.session("worker-a"), {"stop_hook_active": False}, wait=0.1, poll=0.05)
    assert "#1 [instruction] from tech-lead:\nbuild the login form" in out["reason"]
    assert "Before you finish" not in out["reason"]


def test_stop_reminds_to_report_before_going_quiet(hub):
    hub.session("tech-lead").send("worker-a", "build the login form")
    worker = hub.session("worker-a")
    worker.read_inbox()
    out = hooks.on_stop(worker, {"stop_hook_active": False}, wait=0.1, poll=0.05)
    assert out["decision"] == "block"
    assert "tech-lead's message #1 has no answer from you" in out["reason"]
    worker.send("tech-lead", "login form done")
    out = hooks.on_stop(worker, {"stop_hook_active": False}, wait=0.1, poll=0.05)
    assert "no answer" not in out["reason"]  # nothing owed now: straight to waiting


def test_stop_reminds_to_release_files(hub):
    worker = hub.session("worker-a")
    worker.claim("src/app.py")
    out = hooks.on_stop(worker, {"stop_hook_active": False}, wait=0.1, poll=0.05)
    assert "You still hold the write lock on src/app.py" in out["reason"]


def test_reminders_come_once_per_turn(hub):
    worker = hub.session("worker-a")
    worker.claim("src/app.py")
    out = hooks.on_stop(worker, {"stopHookActive": True}, wait=0.1, poll=0.05)  # Grok spelling
    assert out["reason"].startswith("agent-org: no new messages yet")


def test_stop_waits_and_hands_over_new_messages(hub, team):
    worker = hub.session("worker-a")
    worker.set_status("done", "login form")

    def send_later():
        time.sleep(0.3)
        store = Store(team.database)  # another agent's process
        store.add_message("tech-lead", "worker-a", "instruction", "now add tests")
        store.close()

    thread = threading.Thread(target=send_later)
    thread.start()
    out = hooks.on_stop(worker, {"stop_hook_active": True}, wait=5, poll=0.05)
    thread.join()
    assert out["decision"] == "block"
    assert "#1 [instruction] from tech-lead:\nnow add tests" in out["reason"]
    assert worker.read_inbox() == []  # handed over, so read
    assert hub.store.get_status("worker-a").state == "working"


def test_waiting_shows_in_the_status_and_keeps_the_task(hub, team):
    worker = hub.session("worker-a")
    worker.set_status("done", "login form")
    seen = []

    def look():
        time.sleep(0.2)
        store = Store(team.database)
        seen.append(store.get_status("worker-a"))
        store.close()

    thread = threading.Thread(target=look)
    thread.start()
    hooks.on_stop(worker, {"stop_hook_active": True}, wait=0.5, poll=0.05)
    thread.join()
    assert (seen[0].state, seen[0].task) == ("waiting", "login form")


# post-tool: mention new mail once


def test_post_tool_mentions_each_new_message_once(hub):
    worker = hub.session("worker-a")
    assert hooks.on_post_tool(worker, {}) is None
    hub.session("tech-lead").send("worker-a", "one")
    hub.session("worker-b").send("worker-a", "two")
    out = hooks.on_post_tool(worker, {})
    context = out["hookSpecificOutput"]["additionalContext"]
    assert "2 new message(s) for you from tech-lead, worker-b (#1, #2)" in context
    assert hooks.on_post_tool(worker, {}) is None


# pre-edit: one writer per file


def edit(path, tool="Edit", cwd=None):
    payload = {"tool_name": tool, "tool_input": {"file_path": str(path)}}
    if cwd:
        payload["cwd"] = str(cwd)
    return payload


def denied(out):
    spec = (out or {}).get("hookSpecificOutput", {})
    return spec.get("permissionDecision") == "deny" and spec["permissionDecisionReason"]


def test_editing_a_free_file_claims_it(hub, team):
    worker = hub.session("worker-a")
    out = hooks.on_pre_edit(worker, edit(team.project_root / "src" / "app.py"))
    assert not denied(out)
    assert "you now hold the write lock on src/app.py" in out["hookSpecificOutput"]["additionalContext"]
    assert worker.can_write("src/app.py")
    assert hooks.on_pre_edit(worker, edit("src/app.py", cwd=team.project_root)) is None  # already held


def test_editing_someone_elses_file_is_refused(hub, team):
    hub.session("worker-a").claim("tests/test_app.py")
    reason = denied(hooks.on_pre_edit(hub.session("worker-b"), edit("tests/test_app.py", "Write", team.project_root)))
    assert "tests/test_app.py is being written by worker-a" in reason
    assert "ask tech-lead (or worker-a directly if they are your peer)" in reason


def test_editing_outside_the_write_scope_is_refused(hub, team):
    reason = denied(hooks.on_pre_edit(hub.session("worker-b"), edit(team.project_root / "src" / "app.py")))
    assert "You may not edit src/app.py" in reason and "outside your write scope" in reason
    reason = denied(hooks.on_pre_edit(hub.session("researcher"), edit(team.project_root / "notes.md")))
    assert "write scope (nothing)" in reason


def test_consultants_edit_only_what_they_are_handed(hub, team):
    request = hub.session("worker-a").ask_help("stuck")
    hub.session("tech-lead").summon_consultant(request.id, "medium")
    consultant = hub.session("consultant-1")
    assert "handed to them" in denied(hooks.on_pre_edit(consultant, edit(team.project_root / "src" / "a.py")))
    hub.session("worker-a").claim("src/a.py")
    hub.session("worker-a").hand_over("src/a.py", "consultant-1")
    assert hooks.on_pre_edit(consultant, edit(team.project_root / "src" / "a.py")) is None


def test_files_outside_the_project_are_not_the_hubs_business(hub, team, tmp_path):
    assert hooks.on_pre_edit(hub.session("worker-b"), edit(tmp_path / "scratch.txt")) is None


def test_the_hub_folder_is_off_limits(hub, team):
    reason = denied(hooks.on_pre_edit(hub.session("you"), edit(team.project_root / ".agent-org" / "hub.db")))
    assert "belongs to the agent-org hub" in reason


def test_non_edit_tools_are_ignored(hub, team):
    worker = hub.session("worker-b")
    assert hooks.on_pre_edit(worker, edit(team.project_root / "src" / "app.py", tool="Read")) is None
    assert hooks.on_pre_edit(worker, {"tool_name": "Bash", "tool_input": {"command": "ls"}}) is None


def test_apply_patch_files_are_checked(hub, team):
    patch = ("*** Begin Patch\n*** Update File: src/app.py\n@@\n-a\n+b\n"
             "*** Add File: tests/test_new.py\n+x\n*** End Patch")
    payload = {"tool_name": "apply_patch", "tool_input": {"input": patch}, "cwd": str(team.project_root)}
    assert set(hooks.edited_paths(payload)) == {"src/app.py", "tests/test_new.py"}
    out = hooks.on_pre_edit(hub.session("worker-a"), payload)
    assert "src/app.py, tests/test_new.py" in out["hookSpecificOutput"]["additionalContext"]
    reason = denied(hooks.on_pre_edit(hub.session("worker-b"), payload))
    assert "outside your write scope" in reason or "being written by" in reason


def test_grok_payload_spelling(hub, team):
    payload = {"toolName": "search_replace", "toolInput": {"path": "src/x.py"}, "cwd": str(team.project_root)}
    assert hooks.edited_paths(payload) == ["src/x.py"]


# the command harnesses run


def run_hook(event, payload, env_extra, cwd=ROOT):
    env = {k: v for k, v in os.environ.items() if not k.startswith("AGENT_ORG_")}
    env.update(env_extra)
    return subprocess.run([sys.executable, str(ROOT / "org_hook.py"), event], cwd=cwd, env=env,
                          input=json.dumps(payload).encode(), capture_output=True, timeout=30)


@pytest.fixture
def team_file(tmp_path):
    (tmp_path / "project").mkdir()
    path = tmp_path / "team.yaml"
    path.write_text(yaml.safe_dump(TEAM), encoding="utf-8")
    return path


def test_hooks_do_nothing_outside_an_agent_org_tab(tmp_path):
    result = run_hook("pre-edit", {"tool_name": "Edit", "tool_input": {"file_path": "x"}}, {}, cwd=tmp_path)
    assert (result.returncode, result.stdout) == (0, b"")


def test_hook_command_denies_as_json(team_file):
    Store(team_file.parent / ".agent-org" / "hub.db").close()
    env = {"AGENT_ORG_TEAM": str(team_file), "AGENT_ORG_ROLE": "worker-b"}
    payload = edit(team_file.parent / "project" / "src" / "app.py")
    result = run_hook("pre-edit", payload, env, cwd=team_file.parent)
    assert result.returncode == 0
    out = json.loads(result.stdout)
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_a_broken_team_file_never_blocks_the_harness(tmp_path):
    env = {"AGENT_ORG_TEAM": str(tmp_path / "missing.yaml"), "AGENT_ORG_ROLE": "worker-a"}
    result = run_hook("stop", {}, env, cwd=tmp_path)
    assert (result.returncode, result.stdout) == (0, b"")


# Antigravity speaks its own hook dialect


def test_antigravity_answers_are_translated():
    assert hooks.for_antigravity("stop", {"decision": "block", "reason": "mail"}) == {"decision": "continue", "reason": "mail"}
    denied = {"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "held"}}
    assert hooks.for_antigravity("pre-edit", denied) == {"decision": "deny", "reason": "held"}
    notice = {"hookSpecificOutput": {"additionalContext": "2 new messages"}}
    assert hooks.for_antigravity("invocation", notice) == {"injectSteps": [{"ephemeralMessage": "2 new messages"}]}
    assert hooks.for_antigravity("pre-edit", None) == {"decision": "allow"}  # a pre-tool answer needs a decision
    assert hooks.for_antigravity("stop", None) == {}


def test_antigravity_tool_calls_are_read(hub, team):
    payload = {"toolCall": {"name": "write_to_file", "args": {"TargetFile": str(team.project_root / "src" / "a.py")}},
               "conversationId": "0eee4d8d-dfcd-442e-a1f7-97d6c580cb62"}
    assert hooks.edited_paths(payload) == [str(team.project_root / "src" / "a.py")]
    out = hooks.on_pre_edit(hub.session("worker-b"), payload)  # worker-b may not write src/
    assert "outside your write scope" in hooks.for_antigravity("pre-edit", out)["reason"]
    hooks.remember_session(hub.session("worker-b"), payload)
    assert hub.store.get_session("worker-b").session_id == "0eee4d8d-dfcd-442e-a1f7-97d6c580cb62"
    assert hooks.edited_paths({"toolCall": {"name": "run_command", "args": {"CommandLine": "ls"}}}) == []


def test_antigravity_hooks_always_answer_even_outside_a_tab(tmp_path):
    result = run_hook("stop", {"executionNum": 1}, {}, cwd=tmp_path)
    assert result.stdout == b""
    env = {k: v for k, v in os.environ.items() if not k.startswith("AGENT_ORG_")}
    r = subprocess.run([sys.executable, str(ROOT / "org_hook.py"), "invocation", "agy"], cwd=tmp_path, env=env,
                       input=b"{}", capture_output=True, timeout=30)
    assert r.stdout == b"{}"


def test_hooks_work_without_home_folder_variables(monkeypatch):
    """Codex starts hooks with a trimmed environment: no USERPROFILE or HOME."""
    from agent_org import sessions
    for var in ("USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH"):
        monkeypatch.delenv(var, raising=False)
    assert sessions.home().is_dir()


def test_a_crashing_handler_is_logged_not_fatal(hub, monkeypatch, capsys, tmp_path):
    import yaml
    from .conftest import TEAM
    (tmp_path / "t" / "project").mkdir(parents=True)
    team_file = tmp_path / "t" / "team.yaml"
    team_file.write_text(yaml.safe_dump(TEAM), encoding="utf-8")
    monkeypatch.setenv("AGENT_ORG_TEAM", str(team_file))
    monkeypatch.setenv("AGENT_ORG_ROLE", "worker-a")
    monkeypatch.setattr("sys.stdin", __import__("io").TextIOWrapper(__import__("io").BytesIO(b"{}")))

    def boom(me, payload):
        raise RuntimeError("something odd")

    monkeypatch.setitem(hooks.HANDLERS, "post-tool", boom)
    assert hooks.main(["post-tool"]) == 0
    log = (tmp_path / "t" / ".agent-org" / hooks.HOOK_LOG).read_text(encoding="utf-8")
    assert "RuntimeError: something odd" in log and "worker-a post-tool" in log
