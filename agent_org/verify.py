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

import os
import subprocess
from dataclasses import dataclass
from fnmatch import fnmatchcase
from pathlib import Path

from .team import CheckSpec, Team

TAIL = 1500  # characters of a failing check's output passed back to the agent


@dataclass
class Outcome:
    name: str
    ok: bool
    output: str
    command: str = ""


def applies(check: CheckSpec, files: list[str]) -> bool:
    if not check.when:
        return True
    return any(fnmatchcase(f.lower(), w.lower().removeprefix("./")) for f in files for w in check.when)


def run(team: Team, files: list[str], cwd: Path | None = None) -> list[Outcome]:
    """Run every check that applies to a task which changed `files`, in `cwd` (the project folder)."""
    outcomes = []
    for check in team.checks:
        if not applies(check, files):
            continue
        try:
            code, output = command(check.run, cwd or team.project_root, check.timeout)
        except OSError as e:
            outcomes.append(Outcome(check.name, False, f"could not run: {e}", check.run))
            continue
        if code is None:
            outcomes.append(Outcome(check.name, False, f"did not finish within {check.timeout} seconds", check.run))
        else:
            outcomes.append(Outcome(check.name, code == 0, output.strip()[-TAIL:], check.run))
    return outcomes


def command(line: str, cwd: Path, timeout: float) -> tuple[int | None, str]:
    """Run a shell command; (exit code, output), or (None, output) if it ran out of time.

    The hub runs inside an agent's MCP server, whose stdin is the harness's pipe: a child
    that inherits it can hang on Windows before it even starts, so it gets an empty stdin.
    When time runs out the whole process tree goes, so no grandchild keeps the output open.
    """
    proc = subprocess.Popen(line, shell=True, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    try:
        out, _ = proc.communicate(timeout=timeout)
        return proc.returncode, out or ""
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        try:
            out, _ = proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            out = ""
        return None, out or ""


def kill_tree(proc: subprocess.Popen) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], stdin=subprocess.DEVNULL,
                       capture_output=True, timeout=30)
    proc.kill()


def describe(check: CheckSpec) -> str:
    """One line an agent can act on: the check's name, its command, and when it runs."""
    when = f" (when a task changes {', '.join(check.when)})" if check.when else ""
    return f"{check.name}: `{check.run}`{when}"


def summary(outcomes: list[Outcome]) -> str:
    return ", ".join(f"{o.name} {'passed' if o.ok else 'FAILED'}" for o in outcomes)
