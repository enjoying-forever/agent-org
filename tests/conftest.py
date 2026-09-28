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
}


@pytest.fixture
def team(tmp_path: Path) -> Team:
    (tmp_path / "project").mkdir()
    return Team.from_dict(TEAM, base_dir=tmp_path)


@pytest.fixture
def hub(team: Team):
    hub = Hub(team, Store(team.database))
    yield hub
    hub.close()
