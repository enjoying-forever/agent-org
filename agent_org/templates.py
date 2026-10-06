"""Ready-made teams for the UI's "Create a team" page."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import yaml

CONSULTANTS: dict[str, Any] = {
    "opus-medium": {"harness": "claude", "model": "claude-opus-5-5", "effort": "medium", "max_active": 2,
                    "use_for": "everyday problems - unclear errors, API questions, small bugs"},
    "luna-high": {"harness": "codex", "model": "gpt-6-luna", "effort": "high", "max_active": 2,
                  "use_for": "tricky code - failing tests, subtle bugs, algorithms"},
    "opus-xhigh": {"harness": "claude", "model": "claude-opus-5-5", "effort": "xhigh", "max_active": 1,
                   "use_for": "the hardest problems - design flaws, deep debugging across many files"},
}

LEADER_DUTIES = ("Understand what the owner wants, plan it in PLAN.md, split the work into tasks for "
                 "your team, review what comes back, and report the result to the owner.")

TEMPLATES: dict[str, dict[str, Any]] = {
    "solo": {
        "title": "Solo",
        "summary": "One Claude agent that does everything itself. The simplest way to start.",
        "roles": {
            "leader": {"superior": "you", "harness": "claude", "model": "opus", "effort": "high",
                       "duties": "Do what the owner asks, then report the result to the owner.",
                       "write_scope": ["*"]},
        },
    },
    "pair": {
        "title": "Leader and worker",
        "summary": "A Claude leader plans and reviews; a Codex worker writes the code. "
                   "Consultants can be called in for hard problems.",
        "roles": {
            "leader": {"superior": "you", "harness": "claude", "model": "opus", "effort": "high",
                       "duties": LEADER_DUTIES, "write_scope": ["PLAN.md"]},
            "worker": {"superior": "leader", "harness": "codex", "model": "gpt-6-luna", "effort": "medium",
                       "duties": "Carry out the tasks you are given, check that they work, and report back.",
                       "write_scope": ["*"]},
        },
        "consultants": CONSULTANTS,
    },
    "team": {
        "title": "Full team",
        "summary": "A leader, a tech lead with two workers, and a Grok researcher. "
                   "Uses all your subscriptions.",
        "roles": {
            "leader": {"superior": "you", "harness": "claude", "model": "opus", "effort": "high",
                       "duties": LEADER_DUTIES, "write_scope": ["PLAN.md", "docs/*"]},
            "tech-lead": {"superior": "leader", "harness": "codex", "model": "gpt-6-luna", "effort": "high",
                          "duties": "Design the code, split it into tasks for your workers, and review "
                                    "their work before reporting up.",
                          "write_scope": ["*"]},
            "worker-a": {"superior": "tech-lead", "harness": "codex", "model": "gpt-6-luna", "effort": "low",
                         "duties": "Write the code you are given as tasks. Keep changes small.",
                         "write_scope": ["*"]},
            "worker-b": {"superior": "tech-lead", "harness": "claude", "model": "sonnet", "effort": "medium",
                         "duties": "Write and run tests, and keep the docs in step with the code.",
                         "write_scope": ["*"]},
            "researcher": {"superior": "leader", "harness": "grok", "model": "grok-4.7",
                           "duties": "Research libraries, APIs and news on the web, and report what you "
                                     "find. You don't edit project files.",
                           "write_scope": []},
        },
        "consultants": CONSULTANTS,
    },
}


MINE = "my:"  # ids of the teams the owner saved
KEEP_OUT = ("owner", "project_root", "database")  # these belong to one project, not to a saved team


def home_dir() -> Path:
    return Path.home() / ".agent-org"


def teams_dir() -> Path:
    return home_dir() / "teams"


def _prefs_file() -> Path:
    return home_dir() / "prefs.json"


def _prefs() -> dict[str, Any]:
    try:
        return json.loads(_prefs_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def default_template() -> str:
    """The team preselected for a new project: the owner's choice, else 'Leader and worker'."""
    chosen = _prefs().get("default_team")
    return chosen if isinstance(chosen, str) and chosen in ids() else "pair"


def set_default(template: str) -> None:
    if template not in ids():
        raise KeyError(template)
    prefs = _prefs()
    prefs["default_team"] = template
    _prefs_file().parent.mkdir(parents=True, exist_ok=True)
    _prefs_file().write_text(json.dumps(prefs, indent=2), encoding="utf-8")


def _saved() -> dict[str, dict[str, Any]]:
    found = {}
    for path in sorted(teams_dir().glob("*.yaml")):
        try:
            config = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            continue
        if isinstance(config, dict) and isinstance(config.get("roles"), dict):
            found[MINE + path.stem] = config
    return found


def ids() -> list[str]:
    return [*TEMPLATES, *_saved()]


def save(name: str, config: dict[str, Any], default: bool = False) -> str:
    """Keep a team (its roles, consultants, checks and settings) to start new projects from."""
    stem = re.sub(r"[^A-Za-z0-9_ -]", "", name).strip()
    if not stem:
        raise ValueError("give the team a name (letters, digits, spaces, - and _)")
    body = {k: v for k, v in config.items() if k not in KEEP_OUT}
    teams_dir().mkdir(parents=True, exist_ok=True)
    (teams_dir() / f"{stem}.yaml").write_text(yaml.safe_dump(body, sort_keys=False, allow_unicode=True, width=100),
                                              encoding="utf-8")
    template = MINE + stem
    if default:
        set_default(template)
    return template


def delete(template: str) -> None:
    if not template.startswith(MINE):
        raise KeyError(template)
    (teams_dir() / f"{template[len(MINE):]}.yaml").unlink(missing_ok=True)


def team_config(template: str) -> dict[str, Any]:
    """A team.yaml body for `template` (built in, or one the owner saved), with the project in the same folder."""
    if template.startswith(MINE):
        saved = _saved().get(template)
        if saved is None:
            raise KeyError(template)
        return {"owner": "you", "project_root": ".", **saved}
    spec = TEMPLATES[template]
    config: dict[str, Any] = {"owner": "you", "project_root": ".", "roles": spec["roles"]}
    if spec.get("consultants"):
        config["consultants"] = spec["consultants"]
    return config


def catalogue() -> list[dict[str, Any]]:
    default = default_template()
    mine = [{"id": key, "title": key[len(MINE):], "summary": "Your saved team.",
             "roles": ", ".join(config["roles"]), "programs": _programs(config), "mine": True,
             "default": key == default} for key, config in _saved().items()]
    built_in = [{"id": key, "title": t["title"], "summary": t["summary"], "roles": ", ".join(t["roles"]),
                 "programs": _programs(t), "mine": False, "default": key == default} for key, t in TEMPLATES.items()]
    return mine + built_in


def _programs(config: dict[str, Any]) -> list[str]:
    """The programs a team's roles run on, in order of first use (its consultants come only when called)."""
    roles = config.get("roles") or {}
    return list(dict.fromkeys(str(r.get("harness", "")) for r in roles.values() if isinstance(r, dict) and r.get("harness")))
