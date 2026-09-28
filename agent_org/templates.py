"""Ready-made teams for the UI's "Create a team" page."""

from __future__ import annotations

from typing import Any

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


def team_config(template: str) -> dict[str, Any]:
    """A team.yaml body for `template`, with the project in the same folder."""
    spec = TEMPLATES[template]
    config: dict[str, Any] = {"owner": "you", "project_root": ".", "roles": spec["roles"]}
    if spec.get("consultants"):
        config["consultants"] = spec["consultants"]
    return config


def catalogue() -> list[dict[str, str]]:
    return [{"id": key, "title": t["title"], "summary": t["summary"], "roles": ", ".join(t["roles"])}
            for key, t in TEMPLATES.items()]
