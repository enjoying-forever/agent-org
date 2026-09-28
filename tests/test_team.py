import copy
from pathlib import Path

import pytest

from agent_org.team import Team, TeamError

from .conftest import TEAM

EXAMPLE = Path(__file__).resolve().parent.parent / "team.example.yaml"


def build(tmp_path: Path, **changes) -> Team:
    data = copy.deepcopy(TEAM)
    for role, spec in changes.items():
        if spec is None:
            del data["roles"][role]
        else:
            data["roles"].setdefault(role, {}).update(spec)
    return Team.from_dict(data, base_dir=tmp_path)


def test_example_file_is_valid():
    team = Team.load(EXAMPLE)
    assert team.leader == "leader"
    assert team.roles["worker-b"].harness == "antigravity"


def test_tree_queries(team):
    assert team.leader == "leader"
    assert team.superior_of("worker-a") == "tech-lead"
    assert team.superior_of("you") is None
    assert team.subordinates_of("leader") == ["tech-lead", "researcher"]
    assert team.subtree_of("leader") == ["tech-lead", "researcher", "worker-a", "worker-b"]
    assert team.subtree_of("worker-a") == []
    assert team.chain_of("worker-b") == ["tech-lead", "leader", "you"]
    assert team.is_above("leader", "worker-a")
    assert not team.is_above("worker-a", "leader")
    assert not team.is_above("researcher", "worker-a")


def test_tree_lines(team):
    lines = team.tree_lines()
    assert lines[0] == "you (owner)"
    assert lines[1] == "└── leader  [claude]"
    assert any("worker-b  [antigravity]" in line for line in lines)


def test_paths_are_relative_to_the_team_file(team, tmp_path):
    assert team.project_root == (tmp_path / "project").resolve()
    assert team.database == (tmp_path / ".agent-org" / "hub.db").resolve()


@pytest.mark.parametrize(
    "changes, error",
    [
        ({"worker-a": {"superior": "nobody"}}, "is not a role or the owner"),
        ({"worker-a": {"superior": "worker-a"}}, "own superior"),
        ({"leader": {"superior": "worker-a"}}, "loops back"),
        ({"researcher": {"superior": "you"}}, "exactly one role must report to the owner"),
        ({"worker-a": {"harness": "gpt"}}, "'harness' must be one of"),
        ({"worker-a": {"write_scope": "src/*"}}, "must be a list"),
        ({"worker-a": {"colour": "red"}}, "unknown keys"),
        ({"you": {"superior": "leader", "harness": "claude"}}, "cannot also be a role"),
        ({"bad name!": {"superior": "leader", "harness": "claude"}}, "invalid role name"),
    ],
)
def test_invalid_teams_are_rejected(tmp_path, changes, error):
    with pytest.raises(TeamError, match=error):
        build(tmp_path, **changes)


def test_consultant_tiers_are_parsed(team):
    medium = team.tiers["medium"]
    assert (medium.harness, medium.model, medium.effort, medium.max_active) == (
        "claude", "claude-opus-5-5", "medium", 2)
    assert team.tiers["high"].max_active == 1  # the default
    assert team.can_summon("tech-lead") and team.can_summon("you")
    assert not team.can_summon("worker-a")


@pytest.mark.parametrize(
    "tier, error",
    [
        ({"harness": "gpt"}, "'harness' must be one of"),
        ({"harness": "claude", "max_active": 0}, "at least 1"),
        ({"harness": "claude", "max_active": True}, "at least 1"),
        ({"harness": "claude", "budget": 5}, "unknown keys"),
    ],
)
def test_invalid_tiers_are_rejected(tmp_path, tier, error):
    data = copy.deepcopy(TEAM)
    data["consultants"]["bad"] = tier
    with pytest.raises(TeamError, match=error):
        Team.from_dict(data, base_dir=tmp_path)


def test_consultant_names_are_reserved(tmp_path):
    with pytest.raises(TeamError, match="kept for consultants"):
        build(tmp_path, **{"consultant-9": {"superior": "leader", "harness": "claude"}})


def test_missing_project_root_is_rejected(tmp_path):
    data = copy.deepcopy(TEAM)
    del data["project_root"]
    with pytest.raises(TeamError, match="project_root"):
        Team.from_dict(data, base_dir=tmp_path)
