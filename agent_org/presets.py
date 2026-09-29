"""Role presets: a role's settings (program, model, effort, duties, instructions, files) kept
once and reused in any team - from the team editor, or by a manager's hire_agent.

A few come ready-made; the owner's own live in ~/.agent-org/roles/<name>.yaml.
"""

from __future__ import annotations

import re
from typing import Any

import yaml

from . import templates

MINE = "my:"
FIELDS = ("harness", "model", "effort", "duties", "instructions", "write_scope")

BUILT_IN: dict[str, dict[str, Any]] = {
    "planner": {
        "title": "Planner / leader", "harness": "claude", "model": "opus", "effort": "high",
        "duties": "Understand what the owner wants, plan it in PLAN.md, split the work into tasks for your team, "
                  "review what comes back, and report the result to the owner.",
        "instructions": "Keep PLAN.md short: the goal, the tasks with their 'done when', and what is decided.\n"
                        "Give each task to the cheapest agent that can do it well. Review every result against "
                        "its 'done when' before you build on it; send it back with specific feedback if needed.",
        "write_scope": ["PLAN.md", "docs/*"],
    },
    "coder": {
        "title": "Coder", "harness": "codex", "model": "gpt-6-luna", "effort": "medium",
        "duties": "Implement the tasks you are given, check that they work, and report back.",
        "instructions": "Read the code around a change before you make it and follow its style.\n"
                        "Keep each change as small as the task allows. Run the code or its tests before you "
                        "finish, and say in your result what you ran and what it showed.",
        "write_scope": ["*"],
    },
    "reviewer": {
        "title": "Reviewer", "harness": "claude", "model": "claude-sonnet-5", "effort": "medium",
        "duties": "Review finished work when asked: read the changes, run them or their tests, and report a "
                  "clear verdict.",
        "instructions": "Check, in this order: does it meet the task's 'done when'; bugs and missing cases; "
                        "security (secrets, unsafe input handling); readability. Do not fix the code yourself. "
                        "Write the review to reviews/task-<number>.md and give a verdict: ready, or exactly "
                        "what must change.",
        "write_scope": ["reviews/*"],
    },
    "tester": {
        "title": "Tester", "harness": "claude", "model": "sonnet", "effort": "medium",
        "duties": "Write and run tests for the features you are given, and report what passes and what fails.",
        "instructions": "Test the behaviour a user relies on, including edge cases and errors, not the "
                        "implementation details. Keep tests fast and independent. Report failures with the exact "
                        "command and output.",
        "write_scope": ["tests/*"],
    },
    "researcher": {
        "title": "Researcher", "harness": "grok", "model": "grok-4.7",
        "duties": "Research what you are asked: current facts, libraries, APIs and examples.",
        "instructions": "Prefer primary sources (official docs, release notes, the code itself) and give every "
                        "claim its source. Write findings to research/<topic>.md and report the path with a "
                        "short summary.",
        "write_scope": ["research/*"],
    },
    "gemini-coder": {
        "title": "Coder (Gemini)", "harness": "antigravity", "model": "gemini-3.8-flash-medium",
        "duties": "Implement the tasks you are given, check that they work, and report back.",
        "instructions": "Keep each change as small as the task allows, and run what you changed before you finish.",
        "write_scope": ["*"],
    },
}


def roles_dir():
    return templates.home_dir() / "roles"


def _saved() -> dict[str, dict[str, Any]]:
    found = {}
    for path in sorted(roles_dir().glob("*.yaml")):
        try:
            spec = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            continue
        if isinstance(spec, dict) and spec.get("harness"):
            found[MINE + path.stem] = spec
    return found


def get(preset: str) -> dict[str, Any]:
    """The role settings of `preset` (no superior: that belongs to the team)."""
    spec = _saved().get(preset) if preset.startswith(MINE) else BUILT_IN.get(preset)
    if spec is None:
        raise KeyError(preset)
    return {k: (list(v) if k == "write_scope" else v) for k, v in spec.items() if k in FIELDS and v not in (None, "")}


def catalogue() -> list[dict[str, Any]]:
    mine = [{"id": key, "title": key[len(MINE):], "mine": True, **get(key)} for key in _saved()]
    built = [{"id": key, "title": spec["title"], "mine": False, **get(key)} for key, spec in BUILT_IN.items()]
    return mine + built


def names() -> list[str]:
    return [*_saved(), *BUILT_IN]


def save(name: str, role: dict[str, Any]) -> str:
    stem = re.sub(r"[^A-Za-z0-9_ -]", "", name).strip()
    if not stem:
        raise ValueError("give the preset a name (letters, digits, spaces, - and _)")
    spec = {k: role[k] for k in FIELDS if role.get(k) not in (None, "", [])}
    if not spec.get("harness"):
        raise ValueError("a preset needs a program (harness)")
    roles_dir().mkdir(parents=True, exist_ok=True)
    (roles_dir() / f"{stem}.yaml").write_text(yaml.safe_dump(spec, sort_keys=False, allow_unicode=True, width=100),
                                              encoding="utf-8")
    return MINE + stem


def delete(preset: str) -> None:
    if not preset.startswith(MINE):
        raise KeyError(preset)
    (roles_dir() / f"{preset[len(MINE):]}.yaml").unlink(missing_ok=True)
