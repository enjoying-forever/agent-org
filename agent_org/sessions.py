"""Where each harness keeps its conversations, so a restarted team can resume them.

- Claude Code: ~/.claude/projects/<folder>/<session id>.jsonl
- Codex:       ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<session id>.jsonl
- Grok:        ~/.grok/sessions/<folder>/<session id>/
"""

from __future__ import annotations

import re
from pathlib import Path

UUID_RE = re.compile(r"^[0-9a-fA-F-]{8,64}$")
CAN_CHOOSE_ID = ("claude", "grok")  # these accept an id for a new conversation; Codex picks its own


def home() -> Path:
    return Path.home()


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
    return False
