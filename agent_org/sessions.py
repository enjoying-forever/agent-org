"""Where each harness keeps its conversations, so a restarted team can resume them.

- Claude Code: ~/.claude/projects/<folder>/<session id>.jsonl
- Codex:       ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<session id>.jsonl
- Grok:        ~/.grok/sessions/<folder>/<session id>/
"""

from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import quote

UUID_RE = re.compile(r"^[0-9a-fA-F-]{8,64}$")
CAN_CHOOSE_ID = ("claude", "grok")  # these accept an id for a new conversation; Codex picks its own
SCAN_BYTES = 400_000  # how far into a conversation file to look for the role's first prompt
SCAN_DAYS = 45  # how old a Codex conversation may be to still be found by searching


def home() -> Path:
    """The user's home folder - even for a hook that Codex starts without USERPROFILE or HOME."""
    try:
        return Path.home()
    except RuntimeError:
        pass
    if os.name == "nt":
        import ctypes
        buf = ctypes.create_unicode_buffer(260)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 0x0028, None, 0, buf) == 0:  # CSIDL_PROFILE
            return Path(buf.value)
    return Path(os.path.expanduser("~"))


def exists(harness: str, session_id: str | None) -> bool:
    """True if `harness` still has the conversation `session_id` on disk."""
    if not session_id or not UUID_RE.match(session_id):
        return False
    if harness == "claude":
        return any((home() / ".claude" / "projects").glob(f"*/{session_id}.jsonl"))
    if harness == "codex":
        return any((home() / ".codex" / "sessions").glob(f"*/*/*/rollout-*-{session_id}.jsonl"))
    if harness == "grok":
        return any(p.is_dir() for p in (home() / ".grok" / "sessions").glob(f"*/{session_id}"))
    if harness == "antigravity":
        return any((home() / ".gemini" / "antigravity-cli" / "conversations").glob(f"{session_id}.*"))
    return False


def codex_meta(session_id: str) -> dict | None:
    """The first record (session_meta) of a Codex conversation, or None if it is not on disk yet."""
    for path in (home() / ".codex" / "sessions").glob(f"*/*/*/rollout-*-{session_id}.jsonl"):
        try:
            with path.open(encoding="utf-8", errors="replace") as f:
                meta = json.loads(f.readline()).get("payload")
        except (OSError, ValueError):
            return None
        return meta if isinstance(meta, dict) else None
    return None


def is_sub_session(meta: dict) -> bool:
    """A conversation Codex runs on the agent's behalf (its auto-review, a sub-agent), not the agent itself."""
    source = meta.get("source")
    return bool(meta.get("parent_thread_id")) or (isinstance(source, dict) and "subagent" in source)


def main_session(harness: str, session_id: str) -> str | None:
    """The agent's own conversation for `session_id`.

    Codex runs helpers such as its auto-reviewer ("guardian") as separate conversations in
    the same process; they fire the same hooks but have no tools. For one of those this is
    the conversation it belongs to (None if that is unknown). A conversation not on disk yet
    is taken as it is; resuming checks it again.
    """
    if harness != "codex":
        return session_id
    meta = codex_meta(session_id)
    if meta is None:
        return session_id
    if is_sub_session(meta):
        parent = meta.get("parent_thread_id") or meta.get("session_id")
        return str(parent) if parent and parent != session_id else None
    return session_id


def markers(role: str) -> tuple[str, ...]:
    """Text only a conversation started by agent-org for `role` contains: its kickoff prompts."""
    return (f"You are the '{role}' agent in a team", f"you are back as '{role}'")


def find(harness: str, project_root: Path, role: str) -> str | None:
    """The id of the newest conversation `harness` had as `role` in this project, if any.

    Used when the hub has no id on record: a team started before agent-org kept them,
    or a Codex agent whose hooks were not trusted yet.
    """
    wanted = markers(role)
    # Antigravity keeps every project's conversations together: also require this project's path.
    places = ((str(project_root), str(project_root).replace("\\", "\\\\"), project_root.as_posix())
              if harness == "antigravity" else ())
    best: tuple[float, str] | None = None
    for path, session_id in _candidates(harness, project_root):
        try:
            mtime = path.stat().st_mtime
            if best and mtime <= best[0]:
                continue
            with path.open("rb") as f:
                head = f.read(SCAN_BYTES).decode("utf-8", errors="replace")
        except OSError:
            continue
        if any(m in head for m in wanted) and (not places or any(p in head for p in places)):
            best = (mtime, session_id)
    return best[1] if best else None


def _candidates(harness: str, project_root: Path) -> Iterator[tuple[Path, str]]:
    """(file to search, conversation id) for each conversation `harness` had in the project."""
    root = str(project_root)
    if harness == "claude":
        folder = home() / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", root)
        for path in folder.glob("*.jsonl"):
            yield path, path.stem
    elif harness == "grok":
        folder = home() / ".grok" / "sessions" / quote(root, safe="")
        for path in folder.glob("*/chat_history.jsonl"):
            yield path, path.parent.name
    elif harness == "antigravity":
        for path in (home() / ".gemini" / "antigravity-cli" / "conversations").glob("*.*"):
            yield path, path.stem
    elif harness == "codex":
        cutoff = time.time() - SCAN_DAYS * 86400
        for path in (home() / ".codex" / "sessions").glob("*/*/*/rollout-*.jsonl"):
            try:
                if path.stat().st_mtime < cutoff:
                    continue
                with path.open(encoding="utf-8", errors="replace") as f:
                    meta = json.loads(f.readline()).get("payload", {})
            except (OSError, ValueError):
                continue
            if is_sub_session(meta):
                continue  # an auto-review quotes the agent's history, kickoff included
            if str(meta.get("cwd", "")).lower() == root.lower() and meta.get("id"):
                yield path, str(meta["id"])
