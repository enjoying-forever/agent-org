"""Role presets: keep a role's settings once, reuse them in any team."""

import pytest

from agent_org import presets
from agent_org.cards import role_card
from agent_org.hub import HubError

from .test_team_changes import hub, roles_in, team_file  # noqa: F401 - the same real team.yaml fixtures


def test_ready_made_presets_are_listed():
    ids = [p["id"] for p in presets.catalogue()]
    assert {"planner", "coder", "reviewer", "tester", "researcher", "gemini-coder"} <= set(ids)
    reviewer = presets.get("reviewer")
    assert reviewer["harness"] == "claude" and reviewer["write_scope"] == ["reviews/*"] and reviewer["instructions"]


def test_save_use_and_delete_your_own():
    preset = presets.save("My Tester!", {"harness": "codex", "model": "gpt-6-luna", "duties": "Test it.",
                                         "instructions": "Be thorough.", "write_scope": ["tests/*"],
                                         "superior": "ignored"})
    assert preset == "my:my-tester"
    assert presets.get(preset) == {"harness": "codex", "model": "gpt-6-luna", "duties": "Test it.",
                                   "instructions": "Be thorough.", "write_scope": ["tests/*"]}
    assert presets.catalogue()[0]["mine"]  # yours come first
    presets.delete(preset)
    with pytest.raises(KeyError):
        presets.get(preset)
    with pytest.raises(KeyError):
        presets.delete("reviewer")  # the ready-made ones stay
    with pytest.raises(ValueError):
        presets.save("x", {"duties": "no program"})


def test_hiring_from_a_preset(hub, team_file):  # noqa: F811
    role = hub.session("leader").hire("rev", preset="reviewer", write_scope=["docs/*"])
    assert (role.harness, role.model) == ("claude", "claude-sonnet-5")
    assert role.write_scope == ("docs/*",)  # what you give overrides the preset
    assert "reviews/task-<number>.md" in roles_in(team_file)["rev"]["instructions"]
    with pytest.raises(HubError, match="no role preset 'nope'"):
        hub.session("leader").hire("x", preset="nope")


def test_instructions_reach_the_agent(hub):  # noqa: F811
    hub.session("leader").hire("helper", "claude", "Help out.", instructions="Answer in English. Keep it short.")
    card = role_card(hub.session("helper"))
    assert "Your instructions (from the owner):" in card and "Keep it short." in card
