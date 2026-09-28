"""SQLite state shared by every agent's hub connection.

Each harness starts its own hub process, so they all meet in one database file.
WAL mode lets them read concurrently, and writes that must not interleave
(taking a lock, draining an inbox) run inside BEGIN IMMEDIATE transactions.
"""

from __future__ import annotations

import functools
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import ParamSpec, TypeVar

from .team import CONSULTANT_PREFIX

P = ParamSpec("P")
R = TypeVar("R")

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at   REAL NOT NULL,
    sender    TEXT NOT NULL,
    recipient TEXT NOT NULL,
    kind      TEXT NOT NULL,
    text      TEXT NOT NULL,
    reply_to  INTEGER REFERENCES messages(id),
    read_at   REAL
);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages(recipient, read_at);

CREATE TABLE IF NOT EXISTS status (
    role       TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    task       TEXT NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS locks (
    key        TEXT PRIMARY KEY,
    path       TEXT NOT NULL,
    owner      TEXT NOT NULL,
    claimed_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS presence (
    pid        INTEGER PRIMARY KEY,
    role       TEXT NOT NULL,
    started_at REAL NOT NULL,
    last_seen  REAL NOT NULL
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
    state      TEXT NOT NULL,               -- open, done, blocked, cancelled
    message_id INTEGER REFERENCES messages(id),
    parent_id  INTEGER REFERENCES tasks(id),
    result     TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee, state);

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


@dataclass(frozen=True)
class Task:
    id: int
    assigner: str
    assignee: str
    title: str
    details: str
    state: str  # open, done, blocked, cancelled
    message_id: int | None
    parent_id: int | None
    result: str
    created_at: float
    updated_at: float

    @property
    def is_open(self) -> bool:
        return self.state in ("open", "blocked")


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
        columns = {r["name"] for r in self._db.execute("PRAGMA table_info(messages)")}
        if "urgent" not in columns:
            self._db.execute("ALTER TABLE messages ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0")
        columns = {r["name"] for r in self._db.execute("PRAGMA table_info(presence)")}
        if "ppid" not in columns:
            self._db.execute("ALTER TABLE presence ADD COLUMN ppid INTEGER")

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
        urgent: bool = False,
    ) -> Message:
        cur = self._db.execute(
            "INSERT INTO messages (sent_at, sender, recipient, kind, text, reply_to, urgent)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (time.time(), sender, recipient, kind, text, reply_to, int(urgent)),
        )
        message = self.get_message(cur.lastrowid)
        assert message is not None
        return message

    @_locked
    def mark_read(self, ids: list[int]) -> None:
        self._db.executemany("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL",
                             [(time.time(), i) for i in ids])

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

    # tasks

    @_locked
    def add_task(self, assigner: str, assignee: str, title: str, details: str,
                 parent_id: int | None = None) -> Task:
        now = time.time()
        cur = self._db.execute(
            "INSERT INTO tasks (assigner, assignee, title, details, state, parent_id, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, 'open', ?, ?, ?)",
            (assigner, assignee, title, details, parent_id, now, now))
        task = self.get_task(cur.lastrowid)
        assert task is not None
        return task

    @_locked
    def update_task(self, task_id: int, **fields: object) -> Task:
        allowed = {"state", "message_id", "result"}
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
              open_only: bool = False, limit: int = 200) -> list[Task]:
        query, args = "SELECT * FROM tasks WHERE 1 = 1", []
        if assignee is not None:
            query, args = query + " AND assignee = ?", [*args, assignee]
        if assigner is not None:
            query, args = query + " AND assigner = ?", [*args, assigner]
        if open_only:
            query += " AND state IN ('open', 'blocked')"
        rows = self._db.execute(query + " ORDER BY id DESC LIMIT ?", (*args, limit)).fetchall()
        return [_task(r) for r in reversed(rows)]

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
                db.executemany(
                    "UPDATE messages SET read_at = ? WHERE id = ?", [(now, r["id"]) for r in rows]
                )
        return [_message(r) for r in rows]

    @_locked
    def unread_count(self, recipient: str) -> int:
        row = self._db.execute(
            "SELECT COUNT(*) FROM messages WHERE recipient = ? AND read_at IS NULL", (recipient,)
        ).fetchone()
        return row[0]

    @_locked
    def messages_after(self, after: int, limit: int = 300) -> list[Message]:
        """Up to `limit` of the newest messages with an id above `after`, oldest first."""
        rows = self._db.execute(
            "SELECT * FROM messages WHERE id > ? ORDER BY id DESC LIMIT ?", (after, limit)
        ).fetchall()
        return [_message(r) for r in reversed(rows)]

    @_locked
    def unread_counts(self) -> dict[str, int]:
        rows = self._db.execute(
            "SELECT recipient, COUNT(*) FROM messages WHERE read_at IS NULL GROUP BY recipient"
        ).fetchall()
        return {r[0]: r[1] for r in rows}

    @_locked
    def statuses(self) -> dict[str, Status]:
        rows = self._db.execute("SELECT * FROM status").fetchall()
        return {r["role"]: Status(r["role"], r["state"], r["task"], r["updated_at"]) for r in rows}

    @_locked
    def messages_involving(self, role: str, limit: int = 20) -> list[Message]:
        """The most recent messages sent by or to `role`, oldest first."""
        rows = self._db.execute(
            "SELECT * FROM messages WHERE sender = ? OR recipient = ? ORDER BY id DESC LIMIT ?",
            (role, role, limit),
        ).fetchall()
        return [_message(r) for r in reversed(rows)]

    # status

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

    # locks

    @_locked
    def claim(self, key: str, path: str, owner: str) -> Lock:
        """Take the lock on `key` for `owner` unless someone holds it. Returns the lock as it now stands."""
        with self._transaction() as db:
            row = db.execute("SELECT * FROM locks WHERE key = ?", (key,)).fetchone()
            if row is None:
                now = time.time()
                db.execute(
                    "INSERT INTO locks (key, path, owner, claimed_at) VALUES (?, ?, ?, ?)",
                    (key, path, owner, now),
                )
                return Lock(path, owner, now)
        return _lock(row)

    @_locked
    def release(self, key: str) -> None:
        self._db.execute("DELETE FROM locks WHERE key = ?", (key,))

    @_locked
    def transfer(self, key: str, from_owner: str, to_owner: str) -> Lock | None:
        """Move a lock between holders, only if `from_owner` still holds it."""
        cur = self._db.execute(
            "UPDATE locks SET owner = ?, claimed_at = ? WHERE key = ? AND owner = ?",
            (to_owner, time.time(), key, from_owner),
        )
        return self.lock_for(key) if cur.rowcount else None

    @_locked
    def lock_for(self, key: str) -> Lock | None:
        row = self._db.execute("SELECT * FROM locks WHERE key = ?", (key,)).fetchone()
        return _lock(row) if row else None

    @_locked
    def locks(self, owner: str | None = None) -> list[Lock]:
        if owner is None:
            rows = self._db.execute("SELECT * FROM locks ORDER BY path").fetchall()
        else:
            rows = self._db.execute(
                "SELECT * FROM locks WHERE owner = ? ORDER BY path", (owner,)
            ).fetchall()
        return [_lock(r) for r in rows]

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
    def sessions_of(self, role: str, within: float = 30) -> list[tuple[int, int | None]]:
        """(hub connection pid, harness pid) of each live session of `role`."""
        rows = self._db.execute("SELECT pid, ppid FROM presence WHERE role = ? AND last_seen > ?",
                                (role, time.time() - within)).fetchall()
        return [(r[0], r[1]) for r in rows]

    @_locked
    def check_out(self, pid: int) -> None:
        self._db.execute("DELETE FROM presence WHERE pid = ?", (pid,))

    @_locked
    def online(self, within: float = 30) -> dict[str, int]:
        """Roles with a live session, and how many sessions each has."""
        rows = self._db.execute(
            "SELECT role, COUNT(*) FROM presence WHERE last_seen > ? GROUP BY role",
            (time.time() - within,),
        ).fetchall()
        return {r[0]: r[1] for r in rows}

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
        rows = self._db.execute(
            "SELECT * FROM consultants WHERE dismissed_at IS NULL ORDER BY id"
        ).fetchall()
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
            db.execute("UPDATE locks SET owner = ?, claimed_at = ? WHERE owner = ?",
                       (consultant.helped, time.time(), name))
        return paths


def _consultant(row: sqlite3.Row) -> Consultant:
    return Consultant(
        row["id"], row["tier"], row["harness"], row["model"], row["effort"], row["helped"],
        row["summoned_by"], row["help_id"], row["brief"], row["created_at"],
        row["dismissed_at"], row["dismissed_by"],
    )


def _message(row: sqlite3.Row) -> Message:
    return Message(
        row["id"], row["sent_at"], row["sender"], row["recipient"],
        row["kind"], row["text"], row["reply_to"], row["read_at"], bool(row["urgent"]),
    )


def _task(row: sqlite3.Row) -> Task:
    return Task(row["id"], row["assigner"], row["assignee"], row["title"], row["details"],
                row["state"], row["message_id"], row["parent_id"], row["result"],
                row["created_at"], row["updated_at"])


def _lock(row: sqlite3.Row) -> Lock:
    return Lock(row["path"], row["owner"], row["claimed_at"])
