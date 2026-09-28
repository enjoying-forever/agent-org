"""Role-bound access to the hub. Every rule of the chain of command is enforced here.

- A role may message its direct superior (a report, or a request for help) and anyone
  below it in the tree (an instruction). Nobody else: no skipping levels upward,
  no talking to siblings or cousins.
- A role may look at itself and anyone below it: status, recent messages, locks.
- A file has at most one writer. A role may only claim files inside its write scope,
  and a lock can be released by its holder or by anyone above the holder.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from fnmatch import fnmatchcase
from pathlib import Path

from .store import Lock, Message, Status, Store
from .team import Role, Team

STATES = ("idle", "working", "waiting", "blocked", "done")


class HubError(Exception):
    """Base for every refusal the hub hands back to an agent."""


class PermissionDenied(HubError):
    pass


class LockConflict(HubError):
    pass


@dataclass(frozen=True)
class RoleView:
    name: str
    role: Role | None  # None for the owner
    superior: str | None
    subordinates: list[str]
    status: Status | None
    unread: int
    recent: list[Message]
    locks: list[Lock]


class Hub:
    def __init__(self, team: Team, store: Store):
        self.team = team
        self.store = store

    @classmethod
    def open(cls, team_path: str | Path) -> Hub:
        team = Team.load(team_path)
        return cls(team, Store(team.database))

    def close(self) -> None:
        self.store.close()

    def session(self, name: str) -> RoleSession:
        if not self.team.is_member(name):
            raise PermissionDenied(f"'{name}' is not in this team")
        return RoleSession(self, name)

    def lock_key(self, path: str | Path) -> tuple[str, str]:
        """Map a path to (lock key, display path), relative to the project root.

        Windows paths are case-insensitive, so the key is lowercased there:
        'SRC/App.py' and 'src/app.py' are the same file and share one lock.
        """
        root = self.team.project_root
        full = (root / path).resolve()
        try:
            rel = full.relative_to(root).as_posix()
        except ValueError:
            raise PermissionDenied(f"{path} is outside the project folder {root}") from None
        if rel == ".":
            raise PermissionDenied("claim a file, not the whole project folder")
        return (rel.lower() if os.name == "nt" else rel), rel


class RoleSession:
    """Everything one role is allowed to do. Agents only ever get one of these."""

    def __init__(self, hub: Hub, name: str):
        self.hub = hub
        self.team = hub.team
        self.store = hub.store
        self.name = name

    @property
    def is_owner(self) -> bool:
        return self.name == self.team.owner

    @property
    def superior(self) -> str | None:
        return self.team.superior_of(self.name)

    # messaging

    def send(self, to: str, text: str, reply_to: int | None = None) -> Message:
        if not self.team.is_member(to):
            raise PermissionDenied(f"'{to}' is not in this team")
        if to == self.name:
            raise PermissionDenied("you cannot message yourself")
        if to == self.superior:
            kind = "report"
        elif self.team.is_above(self.name, to):
            kind = "instruction"
        else:
            raise PermissionDenied(f"you cannot message '{to}'. {self._reach()}")
        return self.store.add_message(self.name, to, kind, _text(text), self._check_reply(reply_to))

    def ask_help(self, question: str, reply_to: int | None = None) -> Message:
        if self.superior is None:
            raise PermissionDenied("the owner has no superior to ask")
        return self.store.add_message(
            self.name, self.superior, "help", _text(question), self._check_reply(reply_to)
        )

    def read_inbox(self) -> list[Message]:
        return self.store.take_unread(self.name)

    def wait_for_messages(self, timeout: float, poll: float = 0.5) -> list[Message]:
        """Block until at least one message arrives or `timeout` seconds pass."""
        deadline = time.monotonic() + timeout
        while True:
            messages = self.store.take_unread(self.name)
            if messages or time.monotonic() >= deadline:
                return messages
            time.sleep(min(poll, max(0.0, deadline - time.monotonic())))

    def _check_reply(self, reply_to: int | None) -> int | None:
        if reply_to is None:
            return None
        original = self.store.get_message(reply_to)
        if original is None or self.name not in (original.sender, original.recipient):
            raise PermissionDenied(f"message #{reply_to} is not one of yours")
        return reply_to

    def _reach(self) -> str:
        allowed = ([self.superior] if self.superior else []) + self.team.subtree_of(self.name)
        if not allowed:
            return "You can message nobody."
        return "You can message: " + ", ".join(allowed) + "."

    # looking

    def set_status(self, state: str, task: str = "") -> Status:
        if state not in STATES:
            raise HubError(f"state must be one of {list(STATES)}")
        return self.store.set_status(self.name, state, task.strip())

    def view(self, name: str, recent: int = 20) -> RoleView:
        if name != self.name and not self.team.is_above(self.name, name):
            raise PermissionDenied(f"you can only look at yourself and roles below you, not '{name}'")
        return RoleView(
            name=name,
            role=self.team.roles.get(name),
            superior=self.team.superior_of(name),
            subordinates=self.team.subordinates_of(name),
            status=self.store.get_status(name),
            unread=self.store.unread_count(name),
            recent=self.store.messages_involving(name, recent),
            locks=self.store.locks(name),
        )

    # file locks

    def claim(self, path: str | Path) -> Lock:
        key, rel = self.hub.lock_key(path)
        if not self._in_scope(rel):
            scope = ", ".join(self._scope()) or "nothing"
            raise PermissionDenied(f"{rel} is outside your write scope ({scope})")
        lock = self.store.claim(key, rel, self.name)
        if lock.owner != self.name:
            raise LockConflict(f"{lock.path} is being written by {lock.owner}")
        return lock

    def release(self, path: str | Path) -> Lock:
        key, rel = self.hub.lock_key(path)
        lock = self.store.lock_for(key)
        if lock is None:
            raise HubError(f"{rel} is not locked")
        if lock.owner != self.name and not self.team.is_above(self.name, lock.owner):
            raise PermissionDenied(f"{lock.path} is held by {lock.owner}; only they or their superiors can release it")
        self.store.release(key)
        return lock

    def can_write(self, path: str | Path) -> bool:
        """True only if this role currently holds the lock on `path`. Used by pre-edit hooks."""
        try:
            key, _ = self.hub.lock_key(path)
        except PermissionDenied:
            return False
        lock = self.store.lock_for(key)
        return lock is not None and lock.owner == self.name

    def _scope(self) -> tuple[str, ...]:
        if self.is_owner:
            return ("**",)
        return self.team.roles[self.name].write_scope

    def _in_scope(self, rel: str) -> bool:
        # '*' matches across folders here, so 'src/*' and 'src/**' both cover all of src.
        fold = str.lower if os.name == "nt" else str
        return any(fnmatchcase(fold(rel), fold(p.removeprefix("./"))) for p in self._scope())


def _text(text: str) -> str:
    text = text.strip()
    if not text:
        raise HubError("message is empty")
    return text
