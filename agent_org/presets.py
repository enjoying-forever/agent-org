"""The Role Market: packaged, reusable roles - a role's program, model, reasoning effort,
duties (its tasks), instructions (its prompt) and files, with a name, icon, description and
tags to find it by. Place one in any team from the Roles page, build a new team from them,
or let a manager hire one (hire_agent preset=...).

A few come ready-made; the owner's own live in ~/.agent-org/roles/<id>.yaml, and can be
exported to a file and imported again (to share them, or keep them safe). The ready-made ones
can be edited too (the edited copy lives in roles/built-in/<id>.yaml, and "reset" goes back to
the original) and deleted (hidden; "restore" brings every deleted one back).
"""

from __future__ import annotations

import json
import re
from typing import Any

import yaml

from . import templates
from .team import HARNESSES, NAME_RE

MINE = "my:"
FIELDS = ("harness", "model", "effort", "duties", "instructions", "write_scope")  # what a team role gets
META = ("title", "icon", "description", "tags")  # what the market shows
MAX_TEXT = 8000

BUILT_IN: dict[str, dict[str, Any]] = {
    "planner": {
        "title": "Planner / leader", "icon": "🧭", "tags": ["lead", "planning"],
        "description": "Turns your goal into a plan, hands out tasks and checks every result.",
        "harness": "claude", "model": "opus", "effort": "high",
        "duties": "Understand what the owner wants, plan it in PLAN.md, split the work into tasks for your team, "
                  "review what comes back, and report the result to the owner.",
        "instructions": "Keep PLAN.md short: the goal, the tasks with their 'done when', and what is decided.\n"
                        "Give each task to the cheapest agent that can do it well. Review every result against "
                        "its 'done when' before you build on it; send it back with specific feedback if needed.",
        "write_scope": ["PLAN.md", "docs/*"],
    },
    "coder": {
        "title": "Coder", "icon": "⌨️", "tags": ["code"],
        "description": "Implements tasks in small, tested steps.",
        "harness": "codex", "model": "gpt-6-luna", "effort": "medium",
        "duties": "Implement the tasks you are given, check that they work, and report back.",
        "instructions": "Read the code around a change before you make it and follow its style.\n"
                        "Keep each change as small as the task allows. Run the code or its tests before you "
                        "finish, and say in your result what you ran and what it showed.",
        "write_scope": ["*"],
    },
    "reviewer": {
        "title": "Reviewer", "icon": "🔍", "tags": ["quality", "review"],
        "description": "Checks finished work for bugs, gaps and security issues, without touching the code.",
        "harness": "claude", "model": "claude-sonnet-5", "effort": "medium",
        "duties": "Review finished work when asked: read the changes, run them or their tests, and report a "
                  "clear verdict.",
        "instructions": "Check, in this order: does it meet the task's 'done when'; bugs and missing cases; "
                        "security (secrets, unsafe input handling); readability. Do not fix the code yourself. "
                        "Write the review to reviews/task-<number>.md and give a verdict: ready, or exactly "
                        "what must change.",
        "write_scope": ["reviews/*"],
    },
    "tester": {
        "title": "Tester", "icon": "🧪", "tags": ["quality", "tests"],
        "description": "Writes and runs tests, and reports exactly what passes and what fails.",
        "harness": "claude", "model": "sonnet", "effort": "medium",
        "duties": "Write and run tests for the features you are given, and report what passes and what fails.",
        "instructions": "Test the behaviour a user relies on, including edge cases and errors, not the "
                        "implementation details. Keep tests fast and independent. Report failures with the exact "
                        "command and output.",
        "write_scope": ["tests/*"],
    },
    "researcher": {
        "title": "Researcher", "icon": "📚", "tags": ["research", "web"],
        "description": "Finds current facts, libraries and examples, with sources.",
        "harness": "grok", "model": "grok-4.7",
        "duties": "Research what you are asked: current facts, libraries, APIs and examples.",
        "instructions": "Prefer primary sources (official docs, release notes, the code itself) and give every "
                        "claim its source. Write findings to research/<topic>.md and report the path with a "
                        "short summary.",
        "write_scope": ["research/*"],
    },
    "gemini-coder": {
        "title": "Coder (Gemini)", "icon": "✨", "tags": ["code"],
        "description": "A second coder on your Google plan, for parallel work.",
        "harness": "antigravity", "model": "gemini-3.8-flash-medium",
        "duties": "Implement the tasks you are given, check that they work, and report back.",
        "instructions": "Keep each change as small as the task allows, and run what you changed before you finish.",
        "write_scope": ["*"],
    },
}


class RoleError(ValueError):
    pass


def roles_dir():
    return templates.home_dir() / "roles"


def _edited_dir():
    return roles_dir() / "built-in"


def _hidden_file():
    return roles_dir() / "hidden-built-ins.json"


def hidden() -> list[str]:
    """The ready-made roles the owner deleted."""
    try:
        data = json.loads(_hidden_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [x for x in data if x in BUILT_IN] if isinstance(data, list) else []


def _set_hidden(ids: list[str]) -> None:
    roles_dir().mkdir(parents=True, exist_ok=True)
    _hidden_file().write_text(json.dumps(sorted(set(ids))), encoding="utf-8")


def _edited(preset: str) -> dict[str, Any] | None:
    try:
        spec = yaml.safe_load((_edited_dir() / f"{preset}.yaml").read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return None
    return spec if isinstance(spec, dict) and spec.get("harness") else None


def _built_in() -> dict[str, dict[str, Any]]:
    """The ready-made roles still in the market, with the owner's edits."""
    gone = set(hidden())
    return {k: _edited(k) or v for k, v in BUILT_IN.items() if k not in gone}


def _write(path, spec: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(spec, sort_keys=False, allow_unicode=True, width=100), encoding="utf-8")


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9_-]+", "-", text.lower()).strip("-")[:40]


def clean(spec: dict[str, Any]) -> dict[str, Any]:
    """A role package with only known fields, checked; raises RoleError."""
    if not isinstance(spec, dict):
        raise RoleError("a role must be a mapping of its settings")
    out: dict[str, Any] = {}
    harness = spec.get("harness")
    if harness not in HARNESSES:
        raise RoleError(f"a role needs a program: one of {', '.join(HARNESSES)}")
    out["harness"] = harness
    for key in ("title", "icon", "description", "model", "effort", "duties", "instructions"):
        value = spec.get(key)
        if value not in (None, ""):
            if not isinstance(value, (str, int, float)):
                raise RoleError(f"'{key}' must be text")
            out[key] = str(value).strip()[:MAX_TEXT if key in ("duties", "instructions") else 200]
    for key in ("tags", "write_scope"):
        value = spec.get(key) or []
        if isinstance(value, str):
            value = [v for v in re.split(r"[,\n]", value)]
        if not isinstance(value, list):
            raise RoleError(f"'{key}' must be a list")
        items = [str(v).strip() for v in value if str(v).strip()]
        if items:
            out[key] = items[:30]
    if not out.get("title"):
        raise RoleError("give the role a name")
    return out


def _saved() -> dict[str, dict[str, Any]]:
    found = {}
    for path in sorted(roles_dir().glob("*.yaml")):
        try:
            spec = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            continue
        if isinstance(spec, dict) and spec.get("harness"):
            spec.setdefault("title", path.stem)
            found[MINE + path.stem] = spec
    return found


def package(preset: str) -> dict[str, Any]:
    """Everything about a role in the market (settings and description)."""
    spec = _saved().get(preset) if preset.startswith(MINE) else _built_in().get(preset)
    if spec is None:
        raise KeyError(preset)
    return dict(spec)


def get(preset: str) -> dict[str, Any]:
    """The team-role settings of `preset` (no superior: that belongs to the team)."""
    spec = package(preset)
    return {k: (list(v) if k == "write_scope" else v) for k, v in spec.items() if k in FIELDS and v not in (None, "")}


def catalogue() -> list[dict[str, Any]]:
    def card(key: str, mine: bool) -> dict[str, Any]:
        spec = package(key)
        return {"id": key, "mine": mine, "edited": not mine and _edited(key) is not None,
                "title": spec.get("title", key), "icon": spec.get("icon", ""),
                "description": spec.get("description", ""), "tags": list(spec.get("tags") or []), **get(key)}
    return [card(k, True) for k in _saved()] + [card(k, False) for k in _built_in()]


def names() -> list[str]:
    return [*_saved(), *_built_in()]


def save(name: str, role: dict[str, Any], preset: str | None = None) -> str:
    """Keep a role in your market: a new one (named `name`), or - with `preset` - change an existing
    one (yours, or a ready-made one: its edited copy is kept beside the original)."""
    spec = clean({**role, "title": role.get("title") or name})
    if preset and not preset.startswith(MINE):
        if preset not in _built_in():
            raise RoleError("there is no such role")
        _write(_edited_dir() / f"{preset}.yaml", spec)
        return preset
    if preset:
        stem = preset[len(MINE):]
    else:
        stem = _slug(spec["title"]) or "role"
        base, n = stem, 2
        while (roles_dir() / f"{stem}.yaml").exists():
            stem, n = f"{base}-{n}", n + 1
    _write(roles_dir() / f"{stem}.yaml", spec)
    return MINE + stem


def duplicate(preset: str) -> str:
    spec = package(preset)
    return save(f"{spec.get('title', preset)} (copy)", {**spec, "title": f"{spec.get('title', preset)} (copy)"})


def delete(preset: str) -> None:
    """Remove a role from the market. Teams that use it keep their own copy of its settings."""
    if preset.startswith(MINE):
        (roles_dir() / f"{preset[len(MINE):]}.yaml").unlink(missing_ok=True)
        return
    if preset not in _built_in():
        raise KeyError(preset)
    _set_hidden([*hidden(), preset])


def reset(preset: str) -> None:
    """Undo the owner's edits to a ready-made role."""
    if preset not in _built_in():
        raise KeyError(preset)
    (_edited_dir() / f"{preset}.yaml").unlink(missing_ok=True)


def restore() -> list[str]:
    """Bring back every deleted ready-made role (with its edits, if it had any); returns their ids."""
    back = hidden()
    if back:
        _set_hidden([])
    return back


def export_text(preset: str) -> tuple[str, str]:
    """(file name, file text) to download: an agent-org role package."""
    spec = package(preset)
    body = yaml.safe_dump({"agent-org-role": 1, **spec}, sort_keys=False, allow_unicode=True, width=100)
    return f"{_slug(spec.get('title', preset)) or 'role'}.role.yaml", body


def import_text(text: str) -> str:
    """Add a role package (from export_text, or written by hand) to your market."""
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise RoleError(f"that file is not a role package: {e}") from None
    if not isinstance(data, dict):
        raise RoleError("that file is not a role package")
    data.pop("agent-org-role", None)
    spec = clean(data)
    return save(spec["title"], spec)


def team_role(preset: str, superior: str) -> dict[str, Any]:
    """A team.yaml role made from a market role, reporting to `superior`."""
    return {"superior": superior, **get(preset)}


def role_name(preset: str, taken: set[str]) -> str:
    """A free team-role name for a market role."""
    base = _slug(package(preset).get("title", preset).split("/")[0]) or "role"
    if not NAME_RE.match(base):
        base = "role"
    name, n = base, 2
    while name in taken:
        name, n = f"{base}-{n}", n + 1
    return name
