from pathlib import Path

import pytest

from agent_org.hub import Hub
from agent_org.store import Store
from agent_org.team import Team

# you
# └── leader
#     ├── tech-lead
#     │   ├── worker-a
#     │   └── worker-b
#     └── researcher
TEAM = {
    "owner": "you",
    "project_root": "project",
    "roles": {
        "leader": {"superior": "you", "harness": "claude", "write_scope": ["PLAN.md", "docs/*"]},
        "tech-lead": {"superior": "leader", "harness": "codex", "write_scope": ["src/*"]},
        "worker-a": {"superior": "tech-lead", "harness": "codex", "write_scope": ["src/*", "tests/*"]},
        "worker-b": {"superior": "tech-lead", "harness": "antigravity", "write_scope": ["tests/*", "docs/*"]},
        "researcher": {"superior": "leader", "harness": "grok", "write_scope": []},
    },
    "consultants": {
        "medium": {"harness": "claude", "model": "claude-opus-5-5", "effort": "medium", "max_active": 2,
                   "use_for": "questions a strong model answers quickly"},
        "high": {"harness": "codex", "model": "gpt-6-luna", "effort": "high",
                 "use_for": "tricky bugs and failing tests"},
    },
}


@pytest.fixture(autouse=True)
def private_recent_list(tmp_path_factory, monkeypatch):
    """Never touch the real ~/.agent-org/recent.json from tests."""
    from agent_org import ui

    path = tmp_path_factory.mktemp("home") / "recent.json"
    monkeypatch.setattr(ui, "recent_file", lambda: path)
    from agent_org import launch
    grok = path.parent / ".grok" / "hooks" / "agent-org.json"  # nor the real ~/.grok hooks
    monkeypatch.setattr(launch, "grok_hooks_file", lambda: grok)


@pytest.fixture
def team(tmp_path: Path) -> Team:
    (tmp_path / "project").mkdir()
    return Team.from_dict(TEAM, base_dir=tmp_path)


class FakeOpener:
    """Records the consultants the hub asks to open, instead of opening terminal tabs."""

    def __init__(self):
        self.opened = []
        self.fail = False

    def __call__(self, role):
        if self.fail:
            raise RuntimeError("no terminal")
        self.opened.append(role.name)


@pytest.fixture
def opener() -> FakeOpener:
    return FakeOpener()


@pytest.fixture
def hub(team: Team, opener: FakeOpener):
    hub = Hub(team, Store(team.database), opener)
    yield hub
    hub.close()
