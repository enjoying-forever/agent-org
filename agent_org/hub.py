"""Role-bound access to the hub. Every rule of the chain of command is enforced here.

- A role may message its direct superior (a report, or a request for help), its peers
  (roles with the same superior), and anyone below it in the tree (an instruction).
  Nobody else: no skipping levels upward, no talking to cousins. Consultants talk only
  with the agent they help.
- Everyone may see the whole tree and every role's status and locks. Only a role itself
  and the roles above it may read its messages.
- A file has at most one writer. A role may only claim files inside its write scope,
  and a lock can be released by its holder or by anyone above the holder. A holder
  can hand a lock to its direct superior or a direct subordinate.
- When a subordinate asks for help, the superior who received the request may summon
  a consultant: a temporary role placed under the subordinate. A consultant edits only
  files handed to it, and when it is dismissed its files go back to the agent it helped.
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from fnmatch import fnmatchcase
from pathlib import Path

from .store import Consultant, Lock, Message, Status, Store
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
    recent: list[Message]  # empty when `limited`
    locks: list[Lock]
    online: int  # live sessions of this role
    limited: bool  # True when the viewer is not above this role: no messages


@dataclass(frozen=True)
class Snapshot:
    """One line of the team overview everyone can see."""

    name: str
    depth: int
    role: Role
    status: Status | None
    online: int
    locks: int


Opener = Callable[[Role], None]  # opens a visible session for a newly summoned consultant


def consultant_role(c: Consultant) -> Role:
    return Role(
        name=c.name, superior=c.helped, harness=c.harness, model=c.model, effort=c.effort,
        duties=f"Temporary {c.tier} consultant: help {c.helped} solve its help request #{c.help_id}.",
        tier=c.tier,
    )


class Hub:
    def __init__(self, team: Team, store: Store, opener: Opener | None = None):
        self.base_team = team
        self.store = store
        self.opener = opener

    @classmethod
    def open(cls, team_path: str | Path, opener: Opener | None = None) -> Hub:
        team = Team.load(team_path)
        return cls(team, Store(team.database), opener)

    def close(self) -> None:
        self.store.close()

    @property
    def team(self) -> Team:
        """The tree as it stands now: the roles from team.yaml plus the active consultants."""
        active = self.store.active_consultants()
        if not active:
            return self.base_team
        return self.base_team.with_roles([consultant_role(c) for c in active])

    def session(self, name: str) -> RoleSession:
        if not self.team.is_member(name):
            raise PermissionDenied(f"'{name}' is not in this team")
        return RoleSession(self, name)

    def lock_key(self, path: str | Path) -> tuple[str, str]:
        """Map a path to (lock key, display path), relative to the project root.

        Windows paths are case-insensitive, so the key is lowercased there:
        'SRC/App.py' and 'src/app.py' are the same file and share one lock.
        """
        root = self.base_team.project_root
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
        self.store = hub.store
        self.name = name

    @property
    def team(self) -> Team:
        """The current tree. Refuses once this role has left it (a dismissed consultant)."""
        team = self.hub.team
        if not team.is_member(self.name):
            c = self.store.get_consultant(self.name)
            if c is not None and c.dismissed_by:
                raise PermissionDenied(
                    f"you were dismissed by {c.dismissed_by}; your work as a consultant is finished. "
                    "Stop working and do not call any more tools.")
            raise PermissionDenied(f"'{self.name}' is no longer in the team")
        return team

    @property
    def is_owner(self) -> bool:
        return self.name == self.hub.base_team.owner

    @property
    def superior(self) -> str | None:
        return self.team.superior_of(self.name)

    # messaging

    def send(self, to: str, text: str, reply_to: int | None = None) -> Message:
        team = self.team
        if not team.is_member(to):
            raise PermissionDenied(f"'{to}' is not in this team")
        if to == self.name:
            raise PermissionDenied("you cannot message yourself")
        if to == team.superior_of(self.name):
            kind = "report"
        elif team.is_above(self.name, to):
            kind = "instruction"
        elif to in self._peers(team):
            kind = "peer"
        else:
            raise PermissionDenied(f"you cannot message '{to}'. {self._reach(team)}")
        return self.store.add_message(self.name, to, kind, _text(text), self._check_reply(reply_to))

    def _peers(self, team: Team) -> list[str]:
        """Roles with the same superior. Consultants have no peers."""
        me = team.roles.get(self.name)
        if me is None or me.is_consultant:
            return []
        return [s for s in team.subordinates_of(me.superior)
                if s != self.name and not team.roles[s].is_consultant]

    def ask_help(self, question: str, reply_to: int | None = None) -> Message:
        superior = self.superior
        if superior is None:
            raise PermissionDenied("the owner has no superior to ask")
        return self.store.add_message(
            self.name, superior, "help", _text(question), self._check_reply(reply_to)
        )

    def read_inbox(self) -> list[Message]:
        self.team  # noqa: B018 - refuses a dismissed consultant
        return self.store.take_unread(self.name)

    def wait_for_messages(
        self, timeout: float, poll: float = 0.5, stop: threading.Event | None = None
    ) -> list[Message]:
        """Block until at least one message arrives, `timeout` seconds pass, or `stop` is set.

        A stopped wait returns without taking anything, so no message is lost to a
        caller that has gone away. A consultant dismissed while waiting is told so.
        """
        deadline = time.monotonic() + timeout
        while True:
            if stop is not None and stop.is_set():
                return []
            messages = self.read_inbox()
            if messages or time.monotonic() >= deadline:
                return messages
            delay = min(poll, max(0.0, deadline - time.monotonic()))
            if stop is not None:
                stop.wait(delay)
            else:
                time.sleep(delay)

    def _check_reply(self, reply_to: int | None) -> int | None:
        if reply_to is None:
            return None
        original = self.store.get_message(reply_to)
        if original is None or self.name not in (original.sender, original.recipient):
            raise PermissionDenied(f"message #{reply_to} is not one of yours")
        return reply_to

    def _reach(self, team: Team) -> str:
        superior = team.superior_of(self.name)
        allowed = ([superior] if superior else []) + self._peers(team) + team.subtree_of(self.name)
        if not allowed:
            return "You can message nobody."
        return "You can message: " + ", ".join(allowed) + "."

    # looking

    def set_status(self, state: str, task: str = "") -> Status:
        self.team  # noqa: B018 - refuses a dismissed consultant
        if state not in STATES:
            raise HubError(f"state must be one of {list(STATES)}")
        return self.store.set_status(self.name, state, task.strip())

    def view(self, name: str, recent: int = 20) -> RoleView:
        """Anyone's status and locks; their messages only for yourself and roles below you."""
        team = self.team
        if not team.is_member(name):
            raise HubError(f"'{name}' is not in this team")
        full = name == self.name or team.is_above(self.name, name)
        return RoleView(
            name=name,
            role=team.roles.get(name),
            superior=team.superior_of(name),
            subordinates=team.subordinates_of(name),
            status=self.store.get_status(name),
            unread=self.store.unread_count(name),
            recent=self.store.messages_involving(name, recent) if full else [],
            locks=self.store.locks(name),
            online=self.store.online().get(name, 0),
            limited=not full,
        )

    def overview(self) -> list[Snapshot]:
        """The whole tree with everyone's status, in tree order. Everyone may see this."""
        team = self.team
        statuses = self.store.statuses()
        online = self.store.online()
        locks: dict[str, int] = {}
        for lock in self.store.locks():
            locks[lock.owner] = locks.get(lock.owner, 0) + 1
        rows: list[Snapshot] = []

        def walk(name: str, depth: int) -> None:
            for child in team.subordinates_of(name):
                rows.append(Snapshot(child, depth, team.roles[child], statuses.get(child),
                                     online.get(child, 0), locks.get(child, 0)))
                walk(child, depth + 1)

        walk(team.owner, 0)
        return rows

    # file locks

    def claim(self, path: str | Path) -> Lock:
        team = self.team
        key, rel = self.hub.lock_key(path)
        me = team.roles.get(self.name)
        if me is not None and me.is_consultant:
            raise PermissionDenied(
                f"consultants can only edit files handed to them. Ask {me.superior} to hand_over_file {rel} to you.")
        if not self._in_scope(team, self.name, rel):
            scope = ", ".join(self._scope(team, self.name)) or "nothing"
            raise PermissionDenied(f"{rel} is outside your write scope ({scope})")
        lock = self.store.claim(key, rel, self.name)
        if lock.owner != self.name:
            raise LockConflict(f"{lock.path} is being written by {lock.owner}")
        return lock

    def release(self, path: str | Path) -> Lock:
        """Release a lock. A consultant's release hands the file back to the agent it helps."""
        team = self.team
        key, rel = self.hub.lock_key(path)
        lock = self.store.lock_for(key)
        if lock is None:
            raise HubError(f"{rel} is not locked")
        if lock.owner != self.name and not team.is_above(self.name, lock.owner):
            raise PermissionDenied(f"{lock.path} is held by {lock.owner}; only they or their superiors can release it")
        holder = team.roles.get(lock.owner)
        if holder is not None and holder.is_consultant:
            moved = self.store.transfer(key, lock.owner, holder.superior)
            return moved or lock
        self.store.release(key)
        return lock

    def hand_over(self, path: str | Path, to: str) -> Lock:
        """Give a lock you hold to your direct superior or one of your direct subordinates."""
        team = self.team
        key, rel = self.hub.lock_key(path)
        lock = self.store.lock_for(key)
        if lock is None or lock.owner != self.name:
            raise HubError(f"you do not hold {rel}; claim_file it first")
        if not team.is_member(to):
            raise PermissionDenied(f"'{to}' is not in this team")
        if to != team.superior_of(self.name) and team.superior_of(to) != self.name:
            raise PermissionDenied("you can hand files only to your direct superior or a direct subordinate")
        receiver = team.roles.get(to)
        # consultants take any file from the agent they help; everyone else keeps to their scope
        if not (receiver and receiver.is_consultant) and not self._in_scope(team, to, rel):
            raise PermissionDenied(f"{rel} is outside {to}'s write scope")
        moved = self.store.transfer(key, self.name, to)
        if moved is None:
            raise LockConflict(f"{rel} changed hands while handing it over; check list_locks")
        self.store.add_message(self.name, to, "report" if to == team.superior_of(self.name) else "instruction",
                               f"I handed {rel} over to you. You may edit it now.")
        return moved

    def can_write(self, path: str | Path) -> bool:
        """True only if this role currently holds the lock on `path`. Used by pre-edit hooks."""
        try:
            key, _ = self.hub.lock_key(path)
        except PermissionDenied:
            return False
        lock = self.store.lock_for(key)
        return lock is not None and lock.owner == self.name

    def _scope(self, team: Team, name: str) -> tuple[str, ...]:
        if name == team.owner:
            return ("**",)
        return team.roles[name].write_scope

    def _in_scope(self, team: Team, name: str, rel: str) -> bool:
        # '*' matches across folders here, so 'src/*' and 'src/**' both cover all of src.
        fold = str.lower if os.name == "nt" else str
        return any(fnmatchcase(fold(rel), fold(p.removeprefix("./"))) for p in self._scope(team, name))

    # consultants

    def summon_consultant(self, help_id: int, tier: str, brief: str = "") -> Role:
        """Attach a temporary consultant under the subordinate who sent help request `help_id`."""
        team = self.team
        request = self.store.get_message(help_id)
        if request is None or request.kind != "help" or request.recipient != self.name:
            raise PermissionDenied(f"#{help_id} is not a help request sent to you")
        helped = request.sender
        if not team.is_member(helped):
            raise HubError(f"{helped} is no longer in the team")
        if team.roles[helped].is_consultant:
            raise PermissionDenied("consultants cannot get consultants of their own; help them yourself")
        spec = team.tiers.get(tier)
        if spec is None:
            tiers = ", ".join(team.tiers) or "none are configured"
            raise HubError(f"there is no consultant tier '{tier}'. Tiers: {tiers}")
        if any(c.help_id == help_id for c in self.store.active_consultants()):
            raise HubError(f"a consultant is already working on #{help_id}")
        consultant = self.store.add_consultant(
            tier, spec.harness, spec.model, spec.effort, helped, self.name, help_id, brief.strip(),
            spec.max_active)
        if consultant is None:
            raise HubError(f"all {spec.max_active} '{tier}' consultants are busy; choose another tier or wait")
        role = consultant_role(consultant)
        if self.hub.opener is not None:
            try:
                self.hub.opener(role)
            except Exception as e:
                self.store.delete_consultant(role.name)
                raise HubError(f"could not start {role.name}: {e}") from e
        task = f"Help {helped} with its request #{help_id}:\n{request.text}"
        if brief.strip():
            task += f"\n\nBrief from {self.name}: {brief.strip()}"
        self.store.add_message(self.name, role.name, "instruction", task, help_id)
        self.store.add_message(
            self.name, helped, "instruction",
            f"{role.name} ({spec.describe()}) will help you with #{help_id}. It is your temporary "
            f"subordinate: message it with send_message, hand it files to edit with hand_over_file, "
            f"and dismiss_consultant it when the problem is solved.", help_id)
        return role

    def dismiss_consultant(self, name: str) -> tuple[Role, list[str]]:
        """Dismiss a consultant. Returns it and the files that went back to the agent it helped."""
        team = self.team
        role = team.roles.get(name)
        if role is None or not role.is_consultant:
            raise HubError(f"'{name}' is not an active consultant")
        if not team.is_above(self.name, name):
            raise PermissionDenied(f"only {role.superior}, or someone above it, can dismiss {name}")
        returned = self.store.dismiss_consultant(name, by=self.name)
        if self.name != role.superior:
            back = f" Its files are yours again: {', '.join(returned)}." if returned else ""
            self.store.add_message(self.name, role.superior, "instruction",
                                   f"I dismissed {name}.{back}")
        return role, returned


def _text(text: str) -> str:
    text = text.strip()
    if not text:
        raise HubError("message is empty")
    return text
