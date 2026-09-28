"""Git history for a team's project: what each task changed, and one commit per accepted task.

agent-org only uses git when the project folder is the top of its own repository, so
it never commits into a larger repository the project happens to sit inside.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

MAX_DIFF = 200_000  # characters of diff shown for one task
IGNORE = [".agent-org/", ".agents/plugins/agent-org/"]  # the hub's own files never go into history
NAME = {"GIT_AUTHOR_NAME": "agent-org", "GIT_AUTHOR_EMAIL": "agent-org@localhost",
        "GIT_COMMITTER_NAME": "agent-org", "GIT_COMMITTER_EMAIL": "agent-org@localhost"}


def git(root: Path, *args: str, check: bool = False, env_extra: dict[str, str] | None = None,
        timeout: float = 60) -> subprocess.CompletedProcess[str]:
    exe = shutil.which("git")
    if exe is None:
        raise FileNotFoundError("git is not installed")
    env = {**os.environ, **(env_extra or {})}
    return subprocess.run([exe, "-C", str(root), *args], capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout, check=check, env=env, stdin=subprocess.DEVNULL)


def is_own_repo(root: Path) -> bool:
    """True if `root` is the top folder of a git repository."""
    try:
        r = git(root, "rev-parse", "--show-toplevel")
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return False
    if r.returncode != 0:
        return False
    return Path(r.stdout.strip()).resolve() == root.resolve()


def has_commits(root: Path) -> bool:
    return git(root, "rev-parse", "--verify", "HEAD").returncode == 0


def _identity(root: Path) -> dict[str, str]:
    """Use the person's own git name if they set one; otherwise sign as agent-org."""
    if git(root, "config", "user.email").stdout.strip():
        return {}
    return NAME


def init(root: Path) -> str:
    """Turn on history: a repository in the project folder with everything so far as its first commit."""
    if is_own_repo(root):
        return "already on"
    git(root, "init", check=True)
    ignore = root / ".gitignore"
    lines = ignore.read_text(encoding="utf-8").splitlines() if ignore.exists() else []
    missing = [p for p in IGNORE if p not in lines]
    if missing:
        ignore.write_text("\n".join(lines + missing) + "\n", encoding="utf-8")
    git(root, "add", "-A", check=True)
    git(root, "commit", "-m", "agent-org: starting point", "--allow-empty", check=True, env_extra=_identity(root))
    return "on"


def diff(root: Path, paths: list[str]) -> str:
    """What changed in `paths` since the last commit, as a unified diff (new files shown whole)."""
    if not paths or not is_own_repo(root):
        return ""
    parts = []
    tracked = git(root, "ls-files", "--", *paths).stdout.split("\n")
    tracked = {p for p in tracked if p}
    if has_commits(root):
        parts.append(git(root, "diff", "HEAD", "--", *paths).stdout)
    for path in paths:
        if path in tracked:
            continue
        file = root / path
        if file.is_file():
            try:
                body = file.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            parts.append(f"diff --git a/{path} b/{path}\nnew file\n--- /dev/null\n+++ b/{path}\n"
                         + "\n".join("+" + line for line in body) + "\n")
    text = "".join(parts)
    return text if len(text) <= MAX_DIFF else text[:MAX_DIFF] + "\n... (diff cut short)\n"


def commit(root: Path, paths: list[str], message: str) -> str | None:
    """Commit exactly `paths` (added, changed or deleted). Returns the short hash, or None if nothing changed."""
    if not paths or not is_own_repo(root):
        return None
    existing = [p for p in paths if (root / p).exists()]
    gone = [p for p in paths if not (root / p).exists()]
    if existing:
        git(root, "add", "--", *existing, check=True)
    if gone:
        git(root, "rm", "--cached", "--ignore-unmatch", "-q", "--", *gone)
    staged = git(root, "diff", "--cached", "--name-only", "--", *paths).stdout.strip()
    if not staged:
        return None
    git(root, "commit", "-m", message, "--", *paths, check=True, env_extra=_identity(root))
    return git(root, "rev-parse", "--short", "HEAD").stdout.strip()
