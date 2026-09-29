"""Git history for a team's project: what each task changed, and one commit per accepted task.

agent-org only uses git when the project folder is the top of its own repository, so
it never commits into a larger repository the project happens to sit inside.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from contextlib import contextmanager
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


# branches: every agent works in its own worktree, and finished work merges into main at once

BRANCH_PREFIX = "agent/"
LAND_LOCK = "land.lock"  # in .agent-org: one landing into main at a time
MARKER = re.compile(r"^(<{7}|>{7})( |$)", re.M)


def main_branch(root: Path) -> str:
    """The branch the project folder has checked out: the team's main line."""
    name = git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    if not name or name == "HEAD":
        raise RuntimeError(f"{root} is not on a branch; check one out (for example: git switch main)")
    return name


def head(root: Path, ref: str = "HEAD") -> str:
    return git(root, "rev-parse", "--verify", "--quiet", ref).stdout.strip()


def worktree_path(root: Path, role: str) -> Path:
    return root / ".agent-org" / "worktrees" / role


def ensure_worktree(root: Path, role: str) -> Path:
    """The role's own copy of the project, on branch agent/<role> (made from main the first time)."""
    wt = worktree_path(root, role)
    if (wt / ".git").exists():
        return wt
    branch = BRANCH_PREFIX + role
    git(root, "worktree", "prune")
    if head(root, f"refs/heads/{branch}"):
        git(root, "worktree", "add", str(wt), branch, check=True)
    else:
        git(root, "worktree", "add", "-b", branch, str(wt), main_branch(root), check=True)
    git(root, "config", "merge.conflictStyle", "zdiff3")  # conflicts show the common base too
    return wt


def merging(wt: Path) -> bool:
    return bool(head(wt, "MERGE_HEAD"))


def conflicted(wt: Path) -> list[str]:
    return [f for f in git(wt, "diff", "--name-only", "--diff-filter=U").stdout.splitlines() if f]


def with_markers(wt: Path, files: list[str]) -> list[str]:
    """Which of `files` still hold conflict markers."""
    left = []
    for f in files:
        try:
            if MARKER.search((wt / f).read_text(encoding="utf-8", errors="replace")):
                left.append(f)
        except OSError:
            pass
    return left


def commit_all(wt: Path, message: str) -> str | None:
    """Commit everything in the worktree (also concludes a merge whose conflicts were resolved)."""
    git(wt, "add", "-A", check=True)
    if not merging(wt) and not git(wt, "diff", "--cached", "--name-only").stdout.strip():
        return None
    git(wt, "commit", "--no-edit", "-m", message, check=True, env_extra=_identity(wt))
    return head(wt)[:9]


def sync(wt: Path, main: str, abort_on_conflict: bool) -> tuple[list[str], list[str]]:
    """Merge the latest main into the worktree: (files it changed, files in conflict).

    With abort_on_conflict the worktree is left as it was; otherwise the conflicted files
    keep git's markers for the agent to resolve.
    """
    before = head(wt)
    r = git(wt, "merge", "--no-edit", main, env_extra=_identity(wt))
    if r.returncode != 0:
        files = conflicted(wt) or [(r.stderr or r.stdout).strip()[:300]]
        if abort_on_conflict:
            git(wt, "merge", "--abort")
        return [], files
    changed = git(wt, "diff", "--name-only", before, "HEAD").stdout.splitlines() if before else []
    return [f for f in changed if f], []


def land(root: Path, branch: str, message: str) -> tuple[str | None, str]:
    """Merge `branch` into main in the project folder: (short commit id, "") or (None, why not)."""
    r = git(root, "merge", "--no-ff", "--no-edit", "-m", message, branch, env_extra=_identity(root))
    if r.returncode != 0:
        why = conflicted(root)
        git(root, "merge", "--abort")
        text = (r.stderr or r.stdout).strip()
        return None, (f"it conflicts with main in {', '.join(why)}" if why else text[:400])
    return head(root)[:9], ""


def branch_diff(wt: Path, main: str) -> str:
    """Everything the worktree's agent changed since it last took main in (including unsaved work)."""
    base = git(wt, "merge-base", main, "HEAD").stdout.strip()
    if not base:
        return ""
    git(wt, "add", "-A", "-N")  # new files show up in the diff too
    text = git(wt, "diff", base).stdout
    return text if len(text) <= MAX_DIFF else text[:MAX_DIFF] + "\n... (diff cut short)\n"


def commit_diff(root: Path, commit: str) -> str:
    """What a landed task brought into main."""
    text = git(root, "diff", f"{commit}^1", commit).stdout
    return text if len(text) <= MAX_DIFF else text[:MAX_DIFF] + "\n... (diff cut short)\n"


@contextmanager
def land_lock(root: Path, timeout: float = 120):
    """One landing into main at a time, across every agent's process."""
    path = root / ".agent-org" / LAND_LOCK
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + timeout
    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                if time.time() - path.stat().st_mtime > 300:  # left behind by a process that died
                    path.unlink()
                    continue
            except OSError:
                pass
            if time.time() > deadline:
                raise TimeoutError("another agent is putting its work into main; try again in a moment") from None
            time.sleep(0.2)
    try:
        yield
    finally:
        os.close(fd)
        path.unlink(missing_ok=True)
