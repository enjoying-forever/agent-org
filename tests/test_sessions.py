"""A restarted team resumes each role's last conversation instead of starting empty."""

import json

import pytest
import yaml

from agent_org import hooks, launch, sessions
from agent_org.hub import Hub

from .conftest import TEAM


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setattr(sessions, "home", lambda: home)
    return home


@pytest.fixture
def team_file(tmp_path):
    (tmp_path / "project").mkdir()
    path = tmp_path / "team.yaml"
    path.write_text(yaml.safe_dump(TEAM), encoding="utf-8")
    return path


def make_claude_session(home, sid):
    folder = home / ".claude" / "projects" / "E--proj"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{sid}.jsonl").write_text("{}\n", encoding="utf-8")


def test_session_files_are_found_per_harness(fake_home):
    sid = "3f2c1a8e-1111-4a2b-9c3d-123456789abc"
    assert not sessions.exists("claude", sid)
    make_claude_session(fake_home, sid)
    assert sessions.exists("claude", sid)
    codex = fake_home / ".codex" / "sessions" / "2026" / "09" / "28"
    codex.mkdir(parents=True)
    (codex / f"rollout-2026-09-28T17-17-06-{sid}.jsonl").write_text("{}", encoding="utf-8")
    assert sessions.exists("codex", sid)
    (fake_home / ".grok" / "sessions" / "E%3A%5Cproj" / sid).mkdir(parents=True)
    assert sessions.exists("grok", sid)
    assert not sessions.exists("claude", None)
    assert not sessions.exists("claude", "../../etc")  # only ids, never paths


def test_first_launch_starts_a_new_conversation_with_a_known_id(team_file, fake_home):
    hub = Hub.open(team_file)
    try:
        tab = launch.role_tab(hub, team_file.resolve(), "leader")
        record = hub.store.get_session("leader")
    finally:
        hub.close()
    assert record.harness == "claude" and len(record.session_id) == 36
    script = (team_file.parent / ".agent-org" / "launch" / "leader" / "start.ps1").read_text(encoding="utf-8")
    assert f"'--session-id' '{record.session_id}'" in script
    assert "'--resume'" not in script and tab


def test_relaunch_resumes_the_last_conversation(team_file, fake_home):
    hub = Hub.open(team_file)
    try:
        launch.role_tab(hub, team_file.resolve(), "leader")
        sid = hub.store.get_session("leader").session_id
        make_claude_session(fake_home, sid)  # the conversation really happened
        launch.role_tab(hub, team_file.resolve(), "leader")
        assert hub.store.get_session("leader").session_id == sid
        script = (team_file.parent / ".agent-org" / "launch" / "leader" / "start.ps1").read_text(encoding="utf-8")
        assert f"'--resume' '{sid}'" in script and "'--session-id'" not in script
        assert "the team was restarted and you are back as ''leader''" in script
        # asking for a fresh start gives a new conversation
        launch.role_tab(hub, team_file.resolve(), "leader", fresh=True)
        assert hub.store.get_session("leader").session_id != sid
    finally:
        hub.close()


def test_a_lost_conversation_is_replaced_by_a_new_one(team_file, fake_home):
    hub = Hub.open(team_file)
    try:
        launch.role_tab(hub, team_file.resolve(), "leader")
        first = hub.store.get_session("leader").session_id
        launch.role_tab(hub, team_file.resolve(), "leader")  # never ran, so nothing to resume
        assert hub.store.get_session("leader").session_id != first
    finally:
        hub.close()


def test_codex_resumes_by_the_id_its_hooks_reported(team_file, fake_home):
    hub = Hub.open(team_file)
    try:
        launch.role_tab(hub, team_file.resolve(), "worker-a")
        assert hub.store.get_session("worker-a").session_id is None  # Codex picks its own id
        sid = "01a0e74d-bd00-7fe3-9ca4-856641211825"
        hooks.remember_session(hub.session("worker-a"), {"session_id": sid})
        codex = fake_home / ".codex" / "sessions" / "2026" / "09" / "28"
        codex.mkdir(parents=True)
        (codex / f"rollout-2026-09-28T17-17-06-{sid}.jsonl").write_text("{}", encoding="utf-8")
        launch.role_tab(hub, team_file.resolve(), "worker-a")
        script = (team_file.parent / ".agent-org" / "launch" / "worker-a" / "start.ps1").read_text(encoding="utf-8")
        assert script.splitlines()[-1].startswith("& 'codex' 'resume' '-c'")
        assert f"'{sid}' 'agent-org: the team was restarted" in script
    finally:
        hub.close()


def test_grok_gets_a_session_id_and_resumes_it(team_file, fake_home):
    hub = Hub.open(team_file)
    try:
        launch.role_tab(hub, team_file.resolve(), "researcher")
        sid = hub.store.get_session("researcher").session_id
        (fake_home / ".grok" / "sessions" / "E%3A%5Cproj" / sid).mkdir(parents=True)
        launch.role_tab(hub, team_file.resolve(), "researcher")
        script = (team_file.parent / ".agent-org" / "launch" / "researcher" / "start.ps1").read_text(encoding="utf-8")
        assert f"'--resume' '{sid}'" in script
    finally:
        hub.close()


def test_changing_harness_starts_over(team_file, fake_home):
    hub = Hub.open(team_file)
    try:
        hub.store.record_session_id("leader", "codex", "01a0e74d-bd00-7fe3-9ca4-856641211825")
        resume, new_id = launch.plan_session(hub, "leader")  # leader runs on claude now
        assert resume is None and new_id
    finally:
        hub.close()


def test_hooks_record_the_session_they_run_in(hub):
    worker = hub.session("worker-a")
    hooks.remember_session(worker, {"sessionId": "abc-123"})  # Grok spelling
    assert hub.store.get_session("worker-a").session_id == "abc-123"
    hooks.remember_session(worker, {"session_id": "def-456"})  # after /clear, say
    record = hub.store.get_session("worker-a")
    assert (record.session_id, record.harness) == ("def-456", "codex")


def test_session_hook_is_registered(team_file):
    assert "SessionStart" in launch.hook_table(None)
    command = launch.hook_table(None)["SessionStart"][0]["hooks"][0]["command"]
    assert command.endswith("org_hook.py session")
    assert json.dumps(launch.hook_table("Edit"))  # serialisable for settings files


# finding a conversation the hub never recorded


def claude_folder(home, project_root):
    import re
    folder = home / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(project_root))
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def test_an_unrecorded_claude_conversation_is_found_by_its_kickoff(team_file, fake_home):
    import os

    project = (team_file.parent / "project").resolve()
    folder = claude_folder(fake_home, project)
    old = "11111111-1111-4111-8111-111111111111"
    new = "22222222-2222-4222-8222-222222222222"
    other = "33333333-3333-4333-8333-333333333333"
    (folder / f"{old}.jsonl").write_text(json.dumps({"text": launch.kickoff("leader")}) + "\n", encoding="utf-8")
    (folder / f"{new}.jsonl").write_text(json.dumps({"text": launch.resume_kickoff("leader")}) + "\n", encoding="utf-8")
    (folder / f"{other}.jsonl").write_text(json.dumps({"text": launch.kickoff("tech-lead")}) + "\n", encoding="utf-8")
    os.utime(folder / f"{old}.jsonl", (1, 1))
    assert sessions.find("claude", project, "leader") == new  # the newest one of this role
    assert sessions.find("claude", project, "worker-a") is None
    hub = Hub.open(team_file)
    try:
        assert launch.plan_session(hub, "leader") == (new, None)
        assert hub.store.get_session("leader").session_id == new  # recorded from now on
        resume, new_id = launch.plan_session(hub, "leader", fresh=True)
        assert resume is None and new_id
    finally:
        hub.close()


def test_another_teams_conversation_in_the_same_folder_is_not_resumed(team_file, fake_home, monkeypatch):
    project = (team_file.parent / "project").resolve()
    theirs = "44444444-4444-4444-8444-444444444444"
    path = claude_folder(fake_home, project) / f"{theirs}.jsonl"
    path.write_text(json.dumps({"text": launch.kickoff("leader")}) + "\n", encoding="utf-8")
    hub = Hub.open(team_file)  # a new team, in a folder where another team's 'leader' worked before
    try:
        born = sessions.born
        monkeypatch.setattr(sessions, "born", lambda p: born(p) - 86400 if p == path else born(p))  # a day older
        assert launch.plan_session(hub, "leader")[0] is None  # a new conversation, not theirs
    finally:
        hub.close()


def test_codex_conversations_are_matched_by_folder_and_kickoff(team_file, fake_home):
    project = (team_file.parent / "project").resolve()
    day = fake_home / ".codex" / "sessions" / "2026" / "09" / "28"
    day.mkdir(parents=True)
    mine = "01a0e757-c923-7012-b57c-1bdbf15c3690"
    elsewhere = "01a0e757-0000-7012-b57c-1bdbf15c3690"
    for sid, cwd in ((mine, str(project)), (elsewhere, r"C:\other")):
        lines = [json.dumps({"type": "session_meta", "payload": {"id": sid, "cwd": cwd}}),
                 json.dumps({"type": "message", "text": launch.kickoff("worker-a")})]
        (day / f"rollout-2026-09-28T17-28-05-{sid}.jsonl").write_text("\n".join(lines), encoding="utf-8")
    assert sessions.find("codex", project, "worker-a") == mine


def test_grok_conversations_are_found_in_the_folder_they_ran_in(team_file, fake_home):
    from urllib.parse import quote

    project = (team_file.parent / "project").resolve()
    sid = "01a0e757-d1be-7231-8876-a306b504bc97"
    chat = fake_home / ".grok" / "sessions" / quote(str(project), safe="") / sid / "chat_history.jsonl"
    chat.parent.mkdir(parents=True)
    chat.write_text(json.dumps({"content": launch.kickoff("researcher")}), encoding="utf-8")
    assert sessions.find("grok", project, "researcher") == sid


def write_codex(home, sid, meta):
    folder = home / ".codex" / "sessions" / "2026" / "09" / "28"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"rollout-2026-09-28T17-28-05-{sid}.jsonl").write_text(
        json.dumps({"type": "session_meta", "payload": {"id": sid, **meta}}) + "\n", encoding="utf-8")


MAIN = "01a0e757-c7e2-73f3-9cfc-795201ec2236"
REVIEW = "01a0e757-c923-7012-b57c-1bdbf15c3690"


def test_codex_auto_review_is_never_taken_for_the_agent(team_file, fake_home):
    """Codex runs its auto-reviewer as a separate conversation that fires the same hooks.
    Resuming that one gave the user a worker without any org tools."""
    project = str(team_file.parent / "project")
    write_codex(fake_home, MAIN, {"cwd": project, "source": "cli", "thread_source": "user",
                                  "note": "You are the 'worker-a' agent in a team"})
    write_codex(fake_home, REVIEW, {"cwd": project, "source": {"subagent": {"other": "guardian"}},
                                    "thread_source": "guardian_review", "parent_thread_id": MAIN,
                                    "note": "history quoted: You are the 'worker-a' agent in a team"})
    hub = Hub.open(team_file)
    try:
        hooks.remember_session(hub.session("worker-a"), {"session_id": REVIEW})
        assert hub.store.get_session("worker-a").session_id == MAIN
        hub.store.record_session_id("worker-a", "codex", REVIEW)  # a record written before this fix
        assert launch.resumable_session(hub, "worker-a") == MAIN
        assert hub.store.get_session("worker-a").session_id == MAIN  # and repaired
        hub.store.record_session_id("worker-a", "codex", "0000-not-on-disk")
        assert launch.resumable_session(hub, "worker-a") == MAIN  # searching skips the reviewer too
    finally:
        hub.close()

