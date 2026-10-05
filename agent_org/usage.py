"""How much each agent's conversation has used, read from the harness's own session files.

- Claude Code: token counts on every reply (deduplicated by message id).
- Codex: the running total, and - when the provider reports them - how much of each
  subscription limit window is used.
- Grok: no token counts on disk; the number of messages and the model instead.
- Antigravity: each model call's counts, in its conversation's database (protobuf records).
- DeepSeek Harness: each step's counts from its JSON events, which agent_org.runview keeps
  in the role's launch folder (its own session files are compressed).

`total` adds up every conversation a role has had, so an agent's cost survives a fresh start.

`stuck` tells whether a conversation's last turn ended on an API error - most often the
subscription's usage limit, with the time it resets - so the team can move the work
elsewhere and wake the agent once it can work again.
"""

from __future__ import annotations

import json
import re
import sqlite3
import time
import zoneinfo
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, tzinfo
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


_paths: dict[tuple[str, str, str], Path] = {}  # where a conversation's file was found (the search is slow)


def session_file(harness: str, session_id: str | None) -> Path | None:
    if not session_id or not sessions.UUID_RE.match(session_id):
        return None
    key = (str(sessions.home()), harness, session_id)
    known = _paths.get(key)
    if known is not None and known.exists():
        return known
    found = _find(harness, session_id)
    if found is not None:
        _paths[key] = found
    return found


def _find(harness: str, session_id: str) -> Path | None:
    home = sessions.home()
    patterns = {
        "claude": (home / ".claude" / "projects", f"*/{session_id}.jsonl"),
        "codex": (home / ".codex" / "sessions", f"*/*/*/rollout-*-{session_id}.jsonl"),
        "grok": (home / ".grok" / "sessions", f"*/{session_id}/summary.json"),
        "antigravity": (home / ".gemini" / "antigravity-cli" / "conversations", f"{session_id}.db"),
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
    reader = {"claude": _claude, "codex": _codex, "grok": _grok, "antigravity": _antigravity}[harness]
    try:
        result = reader(path)
    except (OSError, ValueError, sqlite3.Error):
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


def _antigravity(path: Path) -> Usage:
    """One gen_metadata row per model call. In its record, field 1 holds field 4 (that call's usage:
    2 input, 3 output with thinking, 5 cache reads) and field 19 (the model). Matched against the
    usage `agy -p --output-format stream-json` reports for the same call."""
    u = Usage()
    db = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=5)
    try:
        rows = db.execute("SELECT data FROM gen_metadata ORDER BY idx").fetchall()
    finally:
        db.close()
    for (data,) in rows:
        call = _field(_proto(data or b""), 1)
        fields = _proto(call) if isinstance(call, bytes) else []
        counts = _field(fields, 4)
        counts = _proto(counts) if isinstance(counts, bytes) else []
        u.tokens_in += int(_field(counts, 2) or 0)
        u.tokens_out += int(_field(counts, 3) or 0)
        u.tokens_cached += int(_field(counts, 5) or 0)
        model = _field(fields, 19)
        if isinstance(model, bytes):
            u.model = model.decode("utf-8", "replace")
        u.messages += 1
    return u


def _proto(data: bytes) -> list[tuple[int, object]]:
    """The top-level fields of a protobuf message: (number, int or bytes). [] if it is not one."""
    out, i = [], 0

    def varint() -> int:
        nonlocal i
        n = shift = 0
        while True:
            c = data[i]
            i += 1
            n |= (c & 0x7F) << shift
            shift += 7
            if c < 0x80:
                return n

    try:
        while i < len(data):
            key = varint()
            number, wire = key >> 3, key & 7
            if wire == 0:
                out.append((number, varint()))
            elif wire == 2:
                n = varint()
                out.append((number, data[i:i + n]))
                i += n
            elif wire in (1, 5):
                i += 8 if wire == 1 else 4
            else:
                return []
    except IndexError:
        return []
    return out


def _field(fields: list[tuple[int, object]], number: int) -> object:
    return next((v for n, v in fields if n == number), None)


DSH_USAGE = "dsh.usage.json"  # in a DeepSeek role's launch folder: {session id: counts}, kept by runview


def deepseek(path: Path) -> Usage:
    """A DeepSeek role's usage, every conversation in its launch folder's usage file."""
    u = Usage()
    try:
        kept = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return u
    for counts in (kept.values() if isinstance(kept, dict) else []):
        if isinstance(counts, dict):
            u.tokens_in += int(counts.get("in") or 0)
            u.tokens_cached += int(counts.get("cached") or 0)
            u.tokens_out += int(counts.get("out") or 0)
            u.messages += int(counts.get("steps") or 0)
    return u


def total(parts: list[Usage]) -> Usage:
    """Several conversations' usage as one (the model and limits of the last that has them)."""
    u = Usage()
    for part in parts:
        u.tokens_in += part.tokens_in
        u.tokens_cached += part.tokens_cached
        u.tokens_out += part.tokens_out
        u.messages += part.messages
        u.model = part.model or u.model
        u.limits = part.limits or u.limits
    return u


# why an agent stopped working

TAIL = 256 * 1024          # bytes read from the end of a session file
SESSION_WINDOW = 5 * 3600  # a usage limit whose reset time is not given lasts at most this long
LIMIT_TEXT = re.compile(r"hit your .{0,40}limit|usage limit|limit (?:reached|exceeded)", re.I)
RESETS = re.compile(r"resets?\s+(?:at\s+)?(?:(?P<mon>[A-Z][a-z]{2,8})\s+(?P<day>\d{1,2}),?\s+(?:at\s+)?)?"
                    r"(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s*(?P<ap>[ap]m)(?:\s*\((?P<tz>[^)]+)\))?", re.I)
TRY_IN = re.compile(r"try again in\s+((?:\d+\s*(?:days?|hours?|minutes?|mins?|seconds?|secs?)[\s,and]*)+)", re.I)


@dataclass
class Stuck:
    kind: str             # "limit": the subscription's usage limit; "error": another API failure
    text: str             # what the harness said
    at: float             # when it happened
    until: float | None   # when a limit resets (None for other errors)

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


_stuck_cache: dict[Path, tuple[float, int, Stuck | None]] = {}


def stuck(harness: str, session_id: str | None) -> Stuck | None:
    """Why the conversation's last turn ended on an error, or None if it did not.

    An agent in this state sits at its prompt: it makes no more calls, so its hooks
    never run and nothing wakes it until it is restarted.
    """
    path = session_file(harness, session_id)
    reader = {"claude": _claude_stuck, "codex": _codex_stuck}.get(harness)
    if path is None or reader is None:
        return None
    try:
        stat = path.stat()
    except OSError:
        return None
    cached = _stuck_cache.get(path)
    if cached and cached[0] == stat.st_mtime and cached[1] == stat.st_size:
        return cached[2]
    try:
        result = reader(_tail(path, stat.st_size))
    except OSError:
        return None
    _stuck_cache[path] = (stat.st_mtime, stat.st_size, result)
    return result


def _tail(path: Path, size: int) -> list[dict]:
    """The records at the end of a JSON-lines file, newest first."""
    with path.open("rb") as f:
        if size > TAIL:
            f.seek(size - TAIL)
        data = f.read()
    lines = data.decode("utf-8", errors="replace").splitlines()
    if size > TAIL:
        lines = lines[1:]  # the first line was cut in the middle
    records = []
    for line in reversed(lines):
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def _when(record: dict) -> float:
    try:
        return datetime.fromisoformat(str(record.get("timestamp")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return time.time()


def _zone(name: str | None) -> tzinfo | None:
    try:
        return zoneinfo.ZoneInfo(name) if name else None
    except (zoneinfo.ZoneInfoNotFoundError, ValueError):
        return None


def reset_time(text: str, at: float) -> float | None:
    """When a limit resets, from the harness's words ("resets 7:20pm (Asia/Singapore)", "try again in 2 hours")."""
    m = TRY_IN.search(text)
    if m:
        seconds = 0
        for amount, unit in re.findall(r"(\d+)\s*([a-z]+)", m.group(1), re.I):
            seconds += int(amount) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit[0].lower()]
        return at + seconds
    m = RESETS.search(text)
    if not m:
        return None
    zone = _zone(m["tz"])
    base = datetime.fromtimestamp(at, zone) if zone else datetime.fromtimestamp(at).astimezone()
    hour = int(m["h"]) % 12 + (12 if m["ap"].lower() == "pm" else 0)
    moment = base.replace(hour=hour, minute=int(m["m"] or 0), second=0, microsecond=0)
    if m["mon"]:
        try:
            month = datetime.strptime(m["mon"][:3].title(), "%b").month
            moment = moment.replace(month=month, day=int(m["day"]))
        except ValueError:
            return None
        if moment < base:
            moment = moment.replace(year=moment.year + 1)
    elif moment <= base:
        moment += timedelta(days=1)
    return moment.timestamp()


def _claude_stuck(records: list[dict]) -> Stuck | None:
    for record in records:
        if record.get("type") not in ("user", "assistant"):
            continue
        if record.get("type") == "user" or not record.get("isApiErrorMessage"):
            return None  # the last turn went through, or a new one has started
        message = record.get("message") or {}
        content = message.get("content") or []
        text = " ".join(str(c.get("text", "")) for c in content if isinstance(c, dict)).strip()
        at = _when(record)
        if LIMIT_TEXT.search(text):
            fallback = at + (7 * 86400 if "week" in text.lower() else SESSION_WINDOW)
            return Stuck("limit", text, at, reset_time(text, at) or fallback)
        return Stuck("error", text or str(record.get("error") or "API error"), at, None)
    return None


def _codex_stuck(records: list[dict]) -> Stuck | None:
    for record in records:
        payload = record.get("payload") or {}
        kind = payload.get("type")
        if record.get("type") == "response_item" or kind in ("agent_message", "user_message", "task_started"):
            return None  # it worked after the last limit report
        if kind == "error":
            text = str(payload.get("message") or "error")
            at = _when(record)
            if LIMIT_TEXT.search(text):
                return Stuck("limit", text, at, reset_time(text, at) or at + SESSION_WINDOW)
            return Stuck("error", text, at, None)
        if kind == "token_count":
            limits = payload.get("rate_limits") or {}
            at, ends = _when(record), []
            for name in ("primary", "secondary"):
                window = limits.get(name)
                if isinstance(window, dict) and float(window.get("used_percent") or 0) >= 100:
                    ends.append(_window_end(window, at))
            if limits.get("rate_limit_reached_type") and not ends:
                ends.append(at + SESSION_WINDOW)
            if not ends:
                return None
            reached = limits.get("rate_limit_reached_type") or "a limit window is full"
            return Stuck("limit", f"usage limit reached ({reached})", at, max(ends))
    return None


def _window_end(window: dict, at: float) -> float:
    resets = window.get("resets_at")
    if isinstance(resets, (int, float)):
        return float(resets)
    if isinstance(resets, str):
        try:
            return datetime.fromisoformat(resets.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    if isinstance(window.get("resets_in_seconds"), (int, float)):
        return at + float(window["resets_in_seconds"])
    return at + 60 * float(window.get("window_minutes") or SESSION_WINDOW // 60)
