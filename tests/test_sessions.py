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
    assert command.endswith('org_hook.py" session')
    assert json.dumps(launch.hook_table("Edit"))  # serialisable for settings files
