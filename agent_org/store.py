"""SQLite state shared by every agent's hub connection.

Each harness starts its own hub process, so they all meet in one database file.
WAL mode lets them read concurrently, and writes that must not interleave
(taking a lock, draining an inbox) run inside BEGIN IMMEDIATE transactions.
A database made by an earlier version is upgraded in place when it is opened.
"""

from __future__ import annotations

import functools
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from fnmatch import fnmatchcase
from pathlib import Path
from typing import ParamSpec, TypeVar

from .team import CONSULTANT_PREFIX

P = ParamSpec("P")
R = TypeVar("R")

LEASE = 3600  # seconds a file lock lasts without the holder doing anything (renewed by its activity)

# Task states, after the A2A task lifecycle.
ACTIVE = ("waiting", "open", "working", "blocked")  # the assignee still owes work
REVIEW = ("done",)                                  # the assigner owes a review
CLOSED = ("accepted", "failed", "rejected", "cancelled")

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at   REAL NOT NULL,
    sender    TEXT NOT NULL,
    recipient TEXT NOT NULL,
    kind      TEXT NOT NULL,
    text      TEXT NOT NULL,
    reply_to  INTEGER REFERENCES messages(id),
    read_at   REAL,
    urgent    INTEGER NOT NULL DEFAULT 0,
    task_id   INTEGER
);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages(recipient, read_at);

CREATE TABLE IF NOT EXISTS status (
    role       TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    task       TEXT NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS locks (
    key        TEXT PRIMARY KEY,               -- normalised path, or a pattern such as src/api/*
    path       TEXT NOT NULL,
    owner      TEXT NOT NULL,
    claimed_at REAL NOT NULL,
    expires_at REAL,
    reason     TEXT NOT NULL DEFAULT '',
    pattern    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS presence (
    pid        INTEGER PRIMARY KEY,
    role       TEXT NOT NULL,
    started_at REAL NOT NULL,
    last_seen  REAL NOT NULL,
    ppid       INTEGER
);

CREATE TABLE IF NOT EXISTS activity (
    role TEXT PRIMARY KEY,
    at   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS notices (
    role    TEXT PRIMARY KEY,
    last_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    role        TEXT PRIMARY KEY,
    harness     TEXT NOT NULL,
    session_id  TEXT,
    launched_at REAL NOT NULL,
    updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
    role       TEXT PRIMARY KEY,
    text       TEXT NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    assigner   TEXT NOT NULL,
    assignee   TEXT NOT NULL,
    title      TEXT NOT NULL,
    details    TEXT NOT NULL,
    state      TEXT NOT NULL,
    message_id INTEGER REFERENCES messages(id),
    parent_id  INTEGER REFERENCES tasks(id),
    result     TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    done_when  TEXT NOT NULL DEFAULT '',
    priority   INTEGER NOT NULL DEFAULT 2,
    depends_on TEXT NOT NULL DEFAULT '',       -- ",3,5," : ids of tasks that must finish first
    revisions  INTEGER NOT NULL DEFAULT 0,
    nudged_at  REAL,
    started_at REAL,
    checks     TEXT NOT NULL DEFAULT '',
    commit_id  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee, state);

CREATE TABLE IF NOT EXISTS task_files (
    task_id INTEGER NOT NULL,
    path    TEXT NOT NULL,
    at      REAL NOT NULL,
    PRIMARY KEY (task_id, path)
);

CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      REAL NOT NULL,
    kind    TEXT NOT NULL,
    role    TEXT NOT NULL,
    text    TEXT NOT NULL,
    task_id INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consultants (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tier         TEXT NOT NULL,
    harness      TEXT NOT NULL,
    model        TEXT,
    effort       TEXT,
    helped       TEXT NOT NULL,
    summoned_by  TEXT NOT NULL,
    help_id      INTEGER NOT NULL REFERENCES messages(id),
    brief        TEXT NOT NULL,
    created_at   REAL NOT NULL,
    dismissed_at REAL,
    dismissed_by TEXT
);
"""

# Columns added since the first version: added to older databases on open.
UPGRADES = {
    "messages": {"urgent": "INTEGER NOT NULL DEFAULT 0", "task_id": "INTEGER"},
    "presence": {"ppid": "INTEGER"},
    "locks": {"expires_at": "REAL", "reason": "TEXT NOT NULL DEFAULT ''",
              "pattern": "INTEGER NOT NULL DEFAULT 0"},
    "tasks": {"done_when": "TEXT NOT NULL DEFAULT ''", "priority": "INTEGER NOT NULL DEFAULT 2",
              "depends_on": "TEXT NOT NULL DEFAULT ''", "revisions": "INTEGER NOT NULL DEFAULT 0",
              "nudged_at": "REAL", "started_at": "REAL", "checks": "TEXT NOT NULL DEFAULT ''",
              "commit_id": "TEXT NOT NULL DEFAULT ''"},
}


@dataclass(frozen=True)
class Message:
    id: int
    sent_at: float
    sender: str
    recipient: str
    kind: str
    text: str
    reply_to: int | None
    read_at: float | None
    urgent: bool = False
    task_id: int | None = None


@dataclass(frozen=True)
class Task:
    id: int
    assigner: str
    assignee: str
    title: str
    details: str
    state: str  # see ACTIVE, REVIEW, CLOSED
    message_id: int | None
    parent_id: int | None
    result: str
    created_at: float
    updated_at: float
    done_when: str = ""
    priority: int = 2  # 1 urgent, 2 normal, 3 low
    depends_on: tuple[int, ...] = ()
    revisions: int = 0
    nudged_at: float | None = None
    started_at: float | None = None
    checks: str = ""      # what the verification checks said when it was finished
    commit_id: str = ""   # the git commit made when it was accepted

    @property
    def is_open(self) -> bool:
        """Not finished yet: the assignee owes work, or the assigner owes a review."""
        return self.state not in CLOSED

    @property
    def owes_work(self) -> bool:
        return self.state in ACTIVE


@dataclass(frozen=True)
class Status:
    role: str
    state: str
    task: str
    updated_at: float


@dataclass(frozen=True)
class Lock:
    path: str
    owner: str
    claimed_at: float
    expires_at: float | None = None
    reason: str = ""
    pattern: bool = False


@dataclass(frozen=True)
class Event:
    id: int
    at: float
    kind: str
    role: str
    text: str
    task_id: int | None


@dataclass(frozen=True)
class Session:
    """The harness conversation a role last ran in, so a restart can resume it."""

    role: str
    harness: str
    session_id: str | None
    launched_at: float


@dataclass(frozen=True)
class Consultant:
    id: int
    tier: str
    harness: str
    model: str | None
    effort: str | None
    helped: str
    summoned_by: str
    help_id: int
    brief: str
    created_at: float
    dismissed_at: float | None
    dismissed_by: str | None

    @property
    def name(self) -> str:
        return f"{CONSULTANT_PREFIX}{self.id}"


def _locked(method: Callable[P, R]) -> Callable[P, R]:
    """One connection may be shared by several threads (parallel tool calls), so use it one at a time."""

    @functools.wraps(method)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        with args[0]._lock:  # type: ignore[attr-defined]
            return method(*args, **kwargs)

    return wrapper


def _prefix(pattern: str) -> str:
    """The fixed start of a pattern, before its first wildcard."""
    for i, ch in enumerate(pattern):
        if ch in "*?[":
            return pattern[:i]
    return pattern


def overlaps(a: str, a_pattern: bool, b: str, b_pattern: bool) -> bool:
    """Whether two lock keys can cover the same file."""
    if not a_pattern and not b_pattern:
        return a == b
    if a_pattern and not b_pattern:
        return fnmatchcase(b, a)
    if b_pattern and not a_pattern:
        return fnmatchcase(a, b)
    pa, pb = _prefix(a), _prefix(b)  # two patterns: overlap unless their fixed parts diverge
    return pa.startswith(pb) or pb.startswith(pa)


class Store:
    def __init__(self, db_path: str | Path):
        self._lock = threading.RLock()
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(db_path, timeout=30, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA)
        self._upgrade()

    def _upgrade(self) -> None:
        """Bring a database made by an earlier version up to date, keeping its contents."""
        for table, columns in UPGRADES.items():
            have = {r["name"] for r in self._db.execute(f"PRAGMA table_info({table})")}
            for column, spec in columns.items():
                if column not in have:
                    self._db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {spec}")

    @_locked
    def close(self) -> None:
        self._db.close()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        self._db.execute("BEGIN IMMEDIATE")
        try:
            yield self._db
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        self._db.execute("COMMIT")

    # messages

    @_locked
    def add_message(
        self, sender: str, recipient: str, kind: str, text: str, reply_to: int | None = None,
        urgent: bool = False, task_id: int | None = None,
    ) -> Message:
        cur = self._db.execute(
            "INSERT INTO messages (sent_at, sender, recipient, kind, text, reply_to, urgent, task_id)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (time.time(), sender, recipient, kind, text, reply_to, int(urgent), task_id),
        )
        message = self.get_message(cur.lastrowid)
        assert message is not None
        return message

    @_locked
    def get_message(self, message_id: int) -> Message | None:
        row = self._db.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
        return _message(row) if row else None

    @_locked
    def take_unread(self, recipient: str) -> list[Message]:
        """Return the recipient's unread messages and mark them read, atomically."""
        with self._transaction() as db:
            rows = db.execute(
                "SELECT * FROM messages WHERE recipient = ? AND read_at IS NULL ORDER BY id",
                (recipient,),
            ).fetchall()
            if rows:
                now = time.time()
                db.executemany("UPDATE messages SET read_at = ? WHERE id = ?", [(now, r["id"]) for r in rows])
        return [_message(r) for r in rows]

    @_locked
    def mark_read(self, ids: list[int]) -> None:
        self._db.executemany("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL",
                             [(time.time(), i) for i in ids])

    # A "note" is mail that does not wake its receiver (see Hub.note); `waking` counts only the rest.

    @_locked
    def unread_count(self, recipient: str, waking: bool = False) -> int:
        row = self._db.execute(
            "SELECT COUNT(*) FROM messages WHERE recipient = ? AND read_at IS NULL"
            + (" AND kind != 'note'" if waking else ""), (recipient,)
        ).fetchone()
        return row[0]

    @_locked
    def unread_counts(self, waking: bool = False) -> dict[str, int]:
        rows = self._db.execute(
            "SELECT recipient, COUNT(*) FROM messages WHERE read_at IS NULL"
            + (" AND kind != 'note'" if waking else "") + " GROUP BY recipient"
        ).fetchall()
        return {r[0]: r[1] for r in rows}

    @_locked
    def unread_since(self) -> dict[str, float]:
        """When each recipient's oldest unread message that wakes it was sent."""
        rows = self._db.execute(
            "SELECT recipient, MIN(sent_at) FROM messages WHERE read_at IS NULL AND kind != 'note' GROUP BY recipient"
        ).fetchall()
        return {r[0]: r[1] for r in rows}

    @_locked
    def messages_after(self, after: int, limit: int = 300) -> list[Message]:
        """Up to `limit` of the newest messages with an id above `after`, oldest first."""
        rows = self._db.execute(
            "SELECT * FROM messages WHERE id > ? ORDER BY id DESC LIMIT ?", (after, limit)
        ).fetchall()
        return [_message(r) for r in reversed(rows)]

    @_locked
    def messages_involving(self, role: str, limit: int = 20) -> list[Message]:
        """The most recent messages sent by or to `role`, oldest first."""
        rows = self._db.execute(
            "SELECT * FROM messages WHERE sender = ? OR recipient = ? ORDER BY id DESC LIMIT ?",
            (role, role, limit),
        ).fetchall()
        return [_message(r) for r in reversed(rows)]

    @_locked
    def thread(self, task_id: int) -> list[Message]:
        """Every message about one task, oldest first."""
        rows = self._db.execute("SELECT * FROM messages WHERE task_id = ? ORDER BY id", (task_id,)).fetchall()
        return [_message(r) for r in rows]

    @_locked
    def search(self, words: str, limit: int = 50) -> list[Message]:
        """Messages containing every word of `words`, newest first."""
        terms = [w for w in words.split() if w][:8]
        if not terms:
            return []
        query = "SELECT * FROM messages WHERE " + " AND ".join("text LIKE ? ESCAPE '\\'" for _ in terms)
        args = ["%" + t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%" for t in terms]
        rows = self._db.execute(query + " ORDER BY id DESC LIMIT ?", (*args, limit)).fetchall()
        return [_message(r) for r in rows]

    @_locked
    def replies_to(self, message_id: int, sender: str | None = None) -> list[Message]:
        query, args = "SELECT * FROM messages WHERE reply_to = ?", [message_id]
        if sender is not None:
            query, args = query + " AND sender = ?", [*args, sender]
        return [_message(r) for r in self._db.execute(query + " ORDER BY id", args).fetchall()]

    @_locked
    def messages_to(self, recipient: str, kinds: tuple[str, ...], limit: int = 50) -> list[Message]:
        rows = self._db.execute(
            f"SELECT * FROM messages WHERE recipient = ? AND kind IN ({', '.join('?' * len(kinds))})"
            " ORDER BY id DESC LIMIT ?", (recipient, *kinds, limit)).fetchall()
        return [_message(r) for r in reversed(rows)]

    @_locked
    def last_message(self, sender: str | None = None, recipient: str | None = None,
                     kinds: tuple[str, ...] | None = None) -> Message | None:
        query, args = "SELECT * FROM messages WHERE 1 = 1", []
        if sender is not None:
            query, args = query + " AND sender = ?", [*args, sender]
        if recipient is not None:
            query, args = query + " AND recipient = ?", [*args, recipient]
        if kinds:
            query += f" AND kind IN ({', '.join('?' * len(kinds))})"
            args += list(kinds)
        row = self._db.execute(query + " ORDER BY id DESC LIMIT 1", args).fetchone()
        return _message(row) if row else None

    @_locked
    def pair_traffic(self, since: float) -> dict[tuple[str, str], int]:
        """Messages exchanged per pair of roles since `since` (either direction)."""
        rows = self._db.execute(
            "SELECT MIN(sender, recipient), MAX(sender, recipient), COUNT(*) FROM messages"
            " WHERE sent_at > ? GROUP BY 1, 2", (since,)).fetchall()
        return {(r[0], r[1]): r[2] for r in rows}

    # tasks

    @_locked
    def add_task(self, assigner: str, assignee: str, title: str, details: str,
                 parent_id: int | None = None, done_when: str = "", priority: int = 2,
                 depends_on: tuple[int, ...] = (), state: str = "open") -> Task:
        now = time.time()
        deps = "," + ",".join(str(d) for d in depends_on) + "," if depends_on else ""
        cur = self._db.execute(
            "INSERT INTO tasks (assigner, assignee, title, details, state, parent_id, created_at, updated_at,"
            " done_when, priority, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (assigner, assignee, title, details, state, parent_id, now, now, done_when, priority, deps))
        task = self.get_task(cur.lastrowid)
        assert task is not None
        return task

    @_locked
    def update_task(self, task_id: int, **fields: object) -> Task:
        allowed = {"state", "message_id", "result", "revisions", "nudged_at", "started_at", "checks", "commit_id",
                   "assignee"}
        assert set(fields) <= allowed, fields
        sets = ", ".join(f"{k} = ?" for k in fields)
        self._db.execute(f"UPDATE tasks SET {sets}, updated_at = ? WHERE id = ?",
                         (*fields.values(), time.time(), task_id))
        task = self.get_task(task_id)
        assert task is not None
        return task

    @_locked
    def get_task(self, task_id: int) -> Task | None:
        row = self._db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return _task(row) if row else None

    @_locked
    def tasks(self, assignee: str | None = None, assigner: str | None = None,
              open_only: bool = False, limit: int = 200, states: tuple[str, ...] | None = None) -> list[Task]:
        query, args = "SELECT * FROM tasks WHERE 1 = 1", []
        if assignee is not None:
            query, args = query + " AND assignee = ?", [*args, assignee]
        if assigner is not None:
            query, args = query + " AND assigner = ?", [*args, assigner]
        if open_only:
            query += f" AND state NOT IN ({', '.join(repr(s) for s in CLOSED)})"
        if states:
            query += f" AND state IN ({', '.join('?' * len(states))})"
            args += list(states)
        rows = self._db.execute(query + " ORDER BY id DESC LIMIT ?", (*args, limit)).fetchall()
        return [_task(r) for r in reversed(rows)]

    @_locked
    def add_task_file(self, task_id: int, path: str) -> None:
        self._db.execute("INSERT OR IGNORE INTO task_files (task_id, path, at) VALUES (?, ?, ?)",
                         (task_id, path, time.time()))

    @_locked
    def task_files(self, task_id: int) -> list[str]:
        rows = self._db.execute("SELECT path FROM task_files WHERE task_id = ? ORDER BY path", (task_id,))
        return [r[0] for r in rows.fetchall()]

    @_locked
    def dependents(self, task_id: int) -> list[Task]:
        """Tasks that wait for `task_id`."""
        rows = self._db.execute("SELECT * FROM tasks WHERE depends_on LIKE ? ORDER BY id",
                                (f"%,{task_id},%",)).fetchall()
        return [_task(r) for r in rows]

    # status and activity

    @_locked
    def set_status(self, role: str, state: str, task: str) -> Status:
        now = time.time()
        self._db.execute(
            "INSERT INTO status (role, state, task, updated_at) VALUES (?, ?, ?, ?)"
            " ON CONFLICT(role) DO UPDATE SET state = excluded.state, task = excluded.task,"
            " updated_at = excluded.updated_at",
            (role, state, task, now),
        )
        return Status(role, state, task, now)

    @_locked
    def get_status(self, role: str) -> Status | None:
        row = self._db.execute("SELECT * FROM status WHERE role = ?", (role,)).fetchone()
        return Status(row["role"], row["state"], row["task"], row["updated_at"]) if row else None

    @_locked
    def statuses(self) -> dict[str, Status]:
        rows = self._db.execute("SELECT * FROM status").fetchall()
        return {r["role"]: Status(r["role"], r["state"], r["task"], r["updated_at"]) for r in rows}

    @_locked
    def touch(self, role: str) -> None:
        """Note that `role` just did something (a tool call): the watchdog's sign of progress."""
        self._db.execute("INSERT INTO activity (role, at) VALUES (?, ?)"
                         " ON CONFLICT(role) DO UPDATE SET at = excluded.at", (role, time.time()))

    @_locked
    def activity(self) -> dict[str, float]:
        return {r[0]: r[1] for r in self._db.execute("SELECT role, at FROM activity").fetchall()}

    # locks: leases on files or patterns, renewed while their holder is active

    @_locked
    def claim(self, key: str, path: str, owner: str, pattern: bool = False, reason: str = "",
              ttl: float = LEASE) -> Lock:
        """Take a lease on `key` for `owner` unless someone else's lease overlaps it.

        Returns the lease as it now stands: the new (or renewed) one, or the one in the way.
        Expired leases don't count and are cleared.
        """
        now = time.time()
        with self._transaction() as db:
            db.execute("DELETE FROM locks WHERE expires_at IS NOT NULL AND expires_at < ?", (now,))
            for row in db.execute("SELECT * FROM locks").fetchall():
                if overlaps(row["key"], bool(row["pattern"]), key, pattern):
                    if row["owner"] != owner:
                        return _lock(row)
                    if row["key"] == key or (row["pattern"] and not pattern):
                        db.execute("UPDATE locks SET expires_at = ? WHERE key = ?", (now + ttl, row["key"]))
                        return _lock(db.execute("SELECT * FROM locks WHERE key = ?", (row["key"],)).fetchone())
            db.execute(
                "INSERT INTO locks (key, path, owner, claimed_at, expires_at, reason, pattern)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)", (key, path, owner, now, now + ttl, reason, int(pattern)))
            return Lock(path, owner, now, now + ttl, reason, pattern)

    @_locked
    def covering(self, key: str) -> Lock | None:
        """The live lease that covers file `key` (its own, or a pattern), if any."""
        now = time.time()
        for row in self._db.execute("SELECT * FROM locks").fetchall():
            if row["expires_at"] is not None and row["expires_at"] < now:
                continue
            if row["key"] == key or (row["pattern"] and fnmatchcase(key, row["key"])):
                return _lock(row)
        return None

    @_locked
    def release(self, key: str) -> None:
        self._db.execute("DELETE FROM locks WHERE key = ?", (key,))

    @_locked
    def transfer(self, key: str, from_owner: str, to_owner: str) -> Lock | None:
        """Move a lease between holders, only if `from_owner` still holds it."""
        now = time.time()
        cur = self._db.execute(
            "UPDATE locks SET owner = ?, claimed_at = ?, expires_at = ? WHERE key = ? AND owner = ?",
            (to_owner, now, now + LEASE, key, from_owner),
        )
        return self.lock_for(key) if cur.rowcount else None

    @_locked
    def lock_for(self, key: str) -> Lock | None:
        row = self._db.execute("SELECT * FROM locks WHERE key = ?", (key,)).fetchone()
        return _lock(row) if row else None

    @_locked
    def locks(self, owner: str | None = None) -> list[Lock]:
        now = time.time()
        if owner is None:
            rows = self._db.execute("SELECT * FROM locks ORDER BY path").fetchall()
        else:
            rows = self._db.execute("SELECT * FROM locks WHERE owner = ? ORDER BY path", (owner,)).fetchall()
        return [_lock(r) for r in rows if r["expires_at"] is None or r["expires_at"] >= now]

    @_locked
    def renew(self, owner: str, ttl: float = LEASE) -> None:
        self._db.execute("UPDATE locks SET expires_at = ? WHERE owner = ?", (time.time() + ttl, owner))

    @_locked
    def expire(self) -> list[Lock]:
        """Remove leases that ran out; returns them."""
        now = time.time()
        with self._transaction() as db:
            rows = db.execute("SELECT * FROM locks WHERE expires_at IS NOT NULL AND expires_at < ?",
                              (now,)).fetchall()
            db.execute("DELETE FROM locks WHERE expires_at IS NOT NULL AND expires_at < ?", (now,))
        return [_lock(r) for r in rows]

    # events: what happened, for the activity feed

    @_locked
    def add_event(self, kind: str, role: str, text: str, task_id: int | None = None) -> None:
        self._db.execute("INSERT INTO events (at, kind, role, text, task_id) VALUES (?, ?, ?, ?, ?)",
                         (time.time(), kind, role, text, task_id))

    @_locked
    def events_after(self, after: int, limit: int = 300) -> list[Event]:
        rows = self._db.execute("SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?",
                                (after, limit)).fetchall()
        return [Event(r["id"], r["at"], r["kind"], r["role"], r["text"], r["task_id"]) for r in reversed(rows)]

    @_locked
    def last_event_id(self) -> int:
        return self._db.execute("SELECT COALESCE(MAX(id), 0) FROM events").fetchone()[0]

    # settings

    @_locked
    def get_setting(self, key: str, default: str = "") -> str:
        row = self._db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row[0] if row else default

    @_locked
    def set_setting(self, key: str, value: str) -> None:
        self._db.execute("INSERT INTO settings (key, value) VALUES (?, ?)"
                         " ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))

    # presence: every running agent's hub connection checks in while its session lives

    @_locked
    def check_in(self, pid: int, role: str, ppid: int | None = None) -> None:
        """`pid` is the hub connection; `ppid` the harness that started it (what "stop" ends)."""
        now = time.time()
        self._db.execute(
            "INSERT INTO presence (pid, role, started_at, last_seen, ppid) VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(pid) DO UPDATE SET role = excluded.role, last_seen = excluded.last_seen,"
            " ppid = COALESCE(excluded.ppid, presence.ppid)",
            (pid, role, now, now, ppid),
        )

    @_locked
    def check_out(self, pid: int) -> None:
        self._db.execute("DELETE FROM presence WHERE pid = ?", (pid,))

    def prune(self, alive: Callable[[int], bool]) -> None:
        """Forget check-ins of processes that are gone: one killed with its terminal never checks out,
        and would count as a second session of its role for half a minute."""
        with self._lock:
            pids = [r[0] for r in self._db.execute("SELECT pid FROM presence").fetchall()]
        for pid in pids:
            if not alive(pid):
                self.check_out(pid)

    @_locked
    def online(self, within: float = 30) -> dict[str, int]:
        """Roles with a live session, and how many sessions each has."""
        rows = self._db.execute(
            "SELECT role, COUNT(*) FROM presence WHERE last_seen > ? GROUP BY role",
            (time.time() - within,),
        ).fetchall()
        return {r[0]: r[1] for r in rows}

    @_locked
    def sessions_of(self, role: str, within: float = 30) -> list[tuple[int, int | None]]:
        """(hub connection pid, harness pid) of each live session of `role`."""
        rows = self._db.execute("SELECT pid, ppid FROM presence WHERE role = ? AND last_seen > ?",
                                (role, time.time() - within)).fetchall()
        return [(r[0], r[1]) for r in rows]

    # sessions and notes: what lets a restarted team carry on where it stopped

    @_locked
    def start_session(self, role: str, harness: str, session_id: str | None) -> None:
        """Record that `role` starts a new conversation (its id may only be known later)."""
        now = time.time()
        self._db.execute(
            "INSERT INTO sessions (role, harness, session_id, launched_at, updated_at) VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(role) DO UPDATE SET harness = excluded.harness, session_id = excluded.session_id,"
            " launched_at = excluded.launched_at, updated_at = excluded.updated_at",
            (role, harness, session_id, now, now),
        )

    @_locked
    def record_session_id(self, role: str, harness: str, session_id: str) -> None:
        """What a hook saw the harness call the current conversation (Codex tells us only this way)."""
        now = time.time()
        self._db.execute(
            "INSERT INTO sessions (role, harness, session_id, launched_at, updated_at) VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(role) DO UPDATE SET harness = excluded.harness, session_id = excluded.session_id,"
            " updated_at = excluded.updated_at"
            " WHERE sessions.session_id IS NOT excluded.session_id OR sessions.harness IS NOT excluded.harness",
            (role, harness, session_id, now, now),
        )

    @_locked
    def get_session(self, role: str) -> Session | None:
        row = self._db.execute("SELECT * FROM sessions WHERE role = ?", (role,)).fetchone()
        return Session(row["role"], row["harness"], row["session_id"], row["launched_at"]) if row else None

    @_locked
    def set_notes(self, role: str, text: str) -> None:
        self._db.execute(
            "INSERT INTO notes (role, text, updated_at) VALUES (?, ?, ?)"
            " ON CONFLICT(role) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
            (role, text, time.time()),
        )

    @_locked
    def get_notes(self, role: str) -> str:
        row = self._db.execute("SELECT text FROM notes WHERE role = ?", (role,)).fetchone()
        return row[0] if row else ""

    # notices: the newest message each role has already been told about

    @_locked
    def unnoticed(self, role: str) -> list[Message]:
        """Unread messages for `role` it hasn't been told about yet; marks them as told."""
        with self._transaction() as db:
            row = db.execute("SELECT last_id FROM notices WHERE role = ?", (role,)).fetchone()
            rows = db.execute(
                "SELECT * FROM messages WHERE recipient = ? AND read_at IS NULL AND id > ? ORDER BY id",
                (role, row[0] if row else 0),
            ).fetchall()
            if rows:
                db.execute(
                    "INSERT INTO notices (role, last_id) VALUES (?, ?)"
                    " ON CONFLICT(role) DO UPDATE SET last_id = excluded.last_id",
                    (role, rows[-1]["id"]),
                )
        return [_message(r) for r in rows]

    # consultants

    @_locked
    def add_consultant(self, tier: str, harness: str, model: str | None, effort: str | None,
                       helped: str, summoned_by: str, help_id: int, brief: str,
                       max_active: int) -> Consultant | None:
        """Register a consultant unless `max_active` of this tier are already working."""
        with self._transaction() as db:
            (active,) = db.execute(
                "SELECT COUNT(*) FROM consultants WHERE tier = ? AND dismissed_at IS NULL", (tier,)
            ).fetchone()
            if active >= max_active:
                return None
            cur = db.execute(
                "INSERT INTO consultants (tier, harness, model, effort, helped, summoned_by, help_id,"
                " brief, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (tier, harness, model, effort, helped, summoned_by, help_id, brief, time.time()),
            )
            row = db.execute("SELECT * FROM consultants WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _consultant(row)

    @_locked
    def get_consultant(self, name: str) -> Consultant | None:
        if not name.startswith(CONSULTANT_PREFIX) or not name[len(CONSULTANT_PREFIX):].isdigit():
            return None
        row = self._db.execute(
            "SELECT * FROM consultants WHERE id = ?", (int(name[len(CONSULTANT_PREFIX):]),)
        ).fetchone()
        return _consultant(row) if row else None

    @_locked
    def active_consultants(self) -> list[Consultant]:
        rows = self._db.execute("SELECT * FROM consultants WHERE dismissed_at IS NULL ORDER BY id").fetchall()
        return [_consultant(r) for r in rows]

    @_locked
    def delete_consultant(self, name: str) -> None:
        consultant = self.get_consultant(name)
        if consultant is not None:
            self._db.execute("DELETE FROM consultants WHERE id = ?", (consultant.id,))

    @_locked
    def dismiss_consultant(self, name: str, by: str) -> list[str]:
        """Dismiss a consultant and give every file it holds back to the agent it helped.

        Returns the paths that went back.
        """
        consultant = self.get_consultant(name)
        assert consultant is not None
        with self._transaction() as db:
            db.execute(
                "UPDATE consultants SET dismissed_at = ?, dismissed_by = ? WHERE id = ?",
                (time.time(), by, consultant.id),
            )
            paths = [r["path"] for r in db.execute(
                "SELECT path FROM locks WHERE owner = ? ORDER BY path", (name,)
            ).fetchall()]
            now = time.time()
            db.execute("UPDATE locks SET owner = ?, claimed_at = ?, expires_at = ? WHERE owner = ?",
                       (consultant.helped, now, now + LEASE, name))
        return paths


def _consultant(row: sqlite3.Row) -> Consultant:
    return Consultant(
        row["id"], row["tier"], row["harness"], row["model"], row["effort"], row["helped"],
        row["summoned_by"], row["help_id"], row["brief"], row["created_at"],
        row["dismissed_at"], row["dismissed_by"],
    )


def _message(row: sqlite3.Row) -> Message:
    return Message(
        row["id"], row["sent_at"], row["sender"], row["recipient"], row["kind"], row["text"],
        row["reply_to"], row["read_at"], bool(row["urgent"]), row["task_id"],
    )


def _task(row: sqlite3.Row) -> Task:
    deps = tuple(int(x) for x in (row["depends_on"] or "").strip(",").split(",") if x)
    return Task(row["id"], row["assigner"], row["assignee"], row["title"], row["details"],
                row["state"], row["message_id"], row["parent_id"], row["result"],
                row["created_at"], row["updated_at"], row["done_when"], row["priority"], deps,
                row["revisions"], row["nudged_at"], row["started_at"], row["checks"], row["commit_id"])


def _lock(row: sqlite3.Row) -> Lock:
    return Lock(row["path"], row["owner"], row["claimed_at"], row["expires_at"], row["reason"],
                bool(row["pattern"]))
