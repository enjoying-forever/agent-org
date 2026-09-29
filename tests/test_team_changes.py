"""Managers change the team while it runs: hire, change and let go of agents below them."""

import copy

import pytest
import yaml

from agent_org.hub import Hub, HubError, PermissionDenied

from .conftest import TEAM, FakeOpener


@pytest.fixture
def team_file(tmp_path):
    (tmp_path / "project").mkdir()
    path = tmp_path / "team.yaml"
    path.write_text(yaml.safe_dump(copy.deepcopy(TEAM), sort_keys=False), encoding="utf-8")
    return path


@pytest.fixture
def hub(team_file, monkeypatch):
    monkeypatch.setattr(Hub, "RELOAD_EVERY", 0)
    stopped = []
    hub = Hub.open(team_file, opener=FakeOpener(), stopper=stopped.append)
    hub.stopped = stopped
    yield hub
    hub.close()


def roles_in(team_file):
    return yaml.safe_load(team_file.read_text(encoding="utf-8"))["roles"]


def test_a_manager_hires_an_agent_that_starts_at_once(hub, team_file):
    role = hub.session("tech-lead").hire("tester", "claude", "Write and run the tests.", model="sonnet",
                                         write_scope=["tests/*"])
    assert (role.superior, role.harness, role.model, role.write_scope) == ("tech-lead", "claude", "sonnet", ("tests/*",))
    assert roles_in(team_file)["tester"]["superior"] == "tech-lead"  # saved in team.yaml
    assert hub.opener.opened == ["tester"]
    [told] = hub.session("you").read_inbox()
    assert "Team change by tech-lead: hired tester" in told.text
    hub.session("tech-lead").assign_task("tester", "Test the parser")  # usable straight away


def test_every_other_process_sees_the_change(hub, team_file):
    other = Hub.open(team_file)
    try:
        assert "tester" not in other.team.roles
        hub.session("leader").hire("tester", "codex", "Tests.")
        assert other.team.roles["tester"].harness == "codex"  # reloaded from team.yaml
    finally:
        other.close()


def test_hiring_only_below_yourself(hub):
    with pytest.raises(PermissionDenied, match="under yourself or someone below you"):
        hub.session("worker-a").hire("helper", "claude", "Help.", superior="leader")
    with pytest.raises(HubError, match="already a 'worker-b'"):
        hub.session("leader").hire("worker-b", "claude", "Again.")
    with pytest.raises(HubError, match="harness must be one of"):
        hub.session("leader").hire("helper", "zcode", "Help.")
    with pytest.raises(HubError, match="simple name"):
        hub.session("leader").hire("consultant-x", "claude", "Help.")
    hub.session("leader").hire("helper", "grok", "Research.", superior="tech-lead")  # below the leader: fine


def test_the_owner_can_turn_team_changes_off(hub, team_file):
    data = yaml.safe_load(team_file.read_text(encoding="utf-8"))
    data["team_changes"] = False
    team_file.write_text(yaml.safe_dump(data), encoding="utf-8")
    with pytest.raises(PermissionDenied, match="turned team changes off"):
        hub.session("leader").hire("helper", "claude", "Help.")


def test_changing_an_agent_below_you(hub, team_file):
    lead = hub.session("tech-lead")
    role = lead.change_role("worker-a", duties="Only the API.", model="gpt-6-luna", write_scope=["src/api/*"])
    assert (role.duties, role.model, role.write_scope) == ("Only the API.", "gpt-6-luna", ("src/api/*",))
    assert roles_in(team_file)["worker-a"]["write_scope"] == ["src/api/*"]
    [told] = hub.session("worker-a").read_inbox()
    assert "changed your role" in told.text
    with pytest.raises(PermissionDenied):
        lead.change_role("leader", duties="x")  # not below it
    with pytest.raises(PermissionDenied, match="only move under you"):
        lead.change_role("worker-a", superior="researcher")
    with pytest.raises(HubError, match="say what to change"):
        lead.change_role("worker-a")


def test_letting_go_of_an_agent(hub, team_file):
    leader = hub.session("leader")
    task = hub.session("tech-lead").assign_task("worker-a", "Build it")
    hub.session("worker-a").claim("src/a.py")
    with pytest.raises(HubError, match="unfinished tasks"):
        hub.session("tech-lead").let_go("worker-a")
    hub.session("tech-lead").cancel_task(task.id)
    assert hub.session("tech-lead").let_go("worker-a", "the work is done") == []
    assert "worker-a" not in roles_in(team_file) and hub.stopped == ["worker-a"]
    assert hub.store.locks("worker-a") == []  # its files are free again
    moved = leader.let_go("tech-lead")  # a manager: its people move up
    assert moved == ["worker-b"] and roles_in(team_file)["worker-b"]["superior"] == "leader"
    with pytest.raises(PermissionDenied):
        leader.let_go("leader")
