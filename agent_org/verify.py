"""The team's checks: commands that must pass before a task may be closed as done.

Like the verification gates of Gas Town's merge queue: set them in team.yaml,

    checks:
      - name: tests
        run: python -m pytest -q
        when: ["*.py"]     # only when the task changed a Python file (optional)
        timeout: 300

and finish_task(done) runs every check that applies, in the project folder.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from fnmatch import fnmatchcase

from .team import CheckSpec, Team

TAIL = 1500  # characters of a failing check's output passed back to the agent


@dataclass
class Outcome:
    name: str
    ok: bool
    output: str


def applies(check: CheckSpec, files: list[str]) -> bool:
    if not check.when:
        return True
    return any(fnmatchcase(f.lower(), w.lower().removeprefix("./")) for f in files for w in check.when)


def run(team: Team, files: list[str]) -> list[Outcome]:
    """Run every check that applies to a task which changed `files`."""
    outcomes = []
    for check in team.checks:
        if not applies(check, files):
            continue
        try:
            r = subprocess.run(check.run, shell=True, cwd=team.project_root, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=check.timeout)
            output = (r.stdout + r.stderr).strip()
            outcomes.append(Outcome(check.name, r.returncode == 0, output[-TAIL:]))
        except subprocess.TimeoutExpired:
            outcomes.append(Outcome(check.name, False, f"did not finish within {check.timeout} seconds"))
        except OSError as e:
            outcomes.append(Outcome(check.name, False, f"could not run: {e}"))
    return outcomes


def summary(outcomes: list[Outcome]) -> str:
    return ", ".join(f"{o.name} {'passed' if o.ok else 'FAILED'}" for o in outcomes)
