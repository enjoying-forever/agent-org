"""How much each agent's conversation has used, read from the harness's own session files.

- Claude Code: token counts on every reply (deduplicated by message id).
- Codex: the running total, and - when the provider reports them - how much of each
  subscription limit window is used.
- Grok: no token counts on disk; the number of messages and the model instead.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import sessions


@dataclass
class Usage:
    tokens_in: int = 0      # fresh input tokens (including what was written to the cache)
    tokens_cached: int = 0  # input tokens read from the cache (much cheaper)
    tokens_out: int = 0
    messages: int = 0
    model: str = ""
    limits: list[str] = field(default_factory=list)  # e.g. "5h limit: 23% used"

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


_cache: dict[Path, tuple[float, int, Usage]] = {}


def session_file(harness: str, session_id: str | None) -> Path | None:
    if not session_id or not sessions.UUID_RE.match(session_id):
        return None
    home = sessions.home()
    patterns = {
        "claude": (home / ".claude" / "projects", f"*/{session_id}.jsonl"),
        "codex": (home / ".codex" / "sessions", f"*/*/*/rollout-*-{session_id}.jsonl"),
        "grok": (home / ".grok" / "sessions", f"*/{session_id}/summary.json"),
    }
    if harness not in patterns:
        return None
    folder, pattern = patterns[harness]
    return next(folder.glob(pattern), None)


def usage(harness: str, session_id: str | None) -> Usage | None:
    """The conversation's usage so far, or None if its file can't be found. Cached per file version."""
    path = session_file(harness, session_id)
    if path is None:
        return None
    try:
        stat = path.stat()
    except OSError:
        return None
    cached = _cache.get(path)
    if cached and cached[0] == stat.st_mtime and cached[1] == stat.st_size:
        return cached[2]
    reader = {"claude": _claude, "codex": _codex, "grok": _grok}[harness]
    try:
        result = reader(path)
    except (OSError, ValueError):
        return None
    _cache[path] = (stat.st_mtime, stat.st_size, result)
    return result


def _claude(path: Path) -> Usage:
    u, seen = Usage(), set()
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            if '"usage"' not in line:
                continue
            try:
                message = json.loads(line).get("message")
            except ValueError:
                continue
            if not isinstance(message, dict) or not isinstance(message.get("usage"), dict):
                continue
            key = message.get("id") or len(seen)
            if key in seen:  # one reply is written in several records with the same usage
                continue
            seen.add(key)
            t = message["usage"]
            u.tokens_in += int(t.get("input_tokens") or 0) + int(t.get("cache_creation_input_tokens") or 0)
            u.tokens_cached += int(t.get("cache_read_input_tokens") or 0)
            u.tokens_out += int(t.get("output_tokens") or 0)
            u.model = message.get("model") or u.model
    u.messages = len(seen)
    return u


def _codex(path: Path) -> Usage:
    u, last = Usage(), None
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            if '"token_count"' not in line and '"turn_context"' not in line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            payload = record.get("payload") or {}
            if payload.get("type") == "token_count":
                last = payload
                u.messages += 1
            elif record.get("type") == "turn_context":
                u.model = payload.get("model") or u.model
    if last:
        total = (last.get("info") or {}).get("total_token_usage") or {}
        cached = int(total.get("cached_input_tokens") or 0)
        u.tokens_in = int(total.get("input_tokens") or 0) - cached
        u.tokens_cached = cached
        u.tokens_out = int(total.get("output_tokens") or 0) + int(total.get("reasoning_output_tokens") or 0)
        for name in ("primary", "secondary"):
            window = (last.get("rate_limits") or {}).get(name)
            if isinstance(window, dict) and window.get("used_percent") is not None:
                minutes = window.get("window_minutes")
                label = (f"{minutes // 60}h" if minutes and minutes % 60 == 0 and minutes < 1440
                         else f"{minutes // 1440}d" if minutes and minutes % 1440 == 0 else "limit")
                u.limits.append(f"{label} limit: {float(window['used_percent']):.0f}% used")
    return u


def _grok(path: Path) -> Usage:
    summary = json.loads(path.read_text(encoding="utf-8"))
    return Usage(messages=int(summary.get("num_chat_messages") or 0), model=summary.get("current_model_id") or "")
