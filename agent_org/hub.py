"""Role-bound access to the hub. The message law (LAW) is enforced here.

- Chain: a role may write to its direct superior (a report, or a request for help), its
  peers (roles with the same superior), and anyone below it (an instruction). Nobody
  else: no skipping levels upward, no writing to other teams. Consultants talk only with
  the agent they help. The hub itself ('hub') may write to anyone.
- Replies: anyone may answer a message addressed to them, whoever sent it.
- Tasks follow the A2A lifecycle: waiting (for tasks it depends on) -> open -> working
  (once the assignee has read it) -> blocked / done / failed / rejected. A done task is
  reviewed by whoever assigned it: accepted, or sent back with feedback.
- Everyone may see the whole tree, every role's status, tasks and file leases. Only a
  role itself and the roles above it may read its messages.
- A file has at most one writer. Leases cover a file or a pattern (src/api/*), last an
  hour without activity, and are renewed while their holder works. A lease can be
  released by its holder or anyone above it, and handed to a direct superior or subordinate.
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
from pathlib import Path, PurePosixPath

from .store import ACTIVE, CLOSED, Consultant, Lock, Message, Status, Store, Task
from .team import Role, Team

STATES = ("idle", "working", "waiting", "blocked", "done")
OUTCOMES = ("done", "blocked", "failed", "rejected")
PRIORITIES = {1: "urgent", 2: "normal", 3: "low"}
MAX_TEXT = 20_000  # characters per message; longer material belongs in a file
MAX_REVISIONS = 3  # send-backs per task before the assigner must decide differently
BROADCAST = {"@team": "your direct subordinates", "@all": "everyone below you"}
HUB = "hub"  # sender name of the hub's own notices (reminders, escalations)

# The message law, as every agent and the owner read it.
LAW = [
    ("Chain of command", "Write to your direct superior, to your peers (same superior) and to "
     "anyone below you. Don't skip levels upward or write to other teams."),
    ("Answering is always allowed", "You may reply (reply_to) to any message sent to you, "
     "whoever sent it. Messages from the owner come first."),
    ("Work is given as tasks", "Give work only downward, with assign_task: one clear, "
     "self-contained task each, with a 'done when' saying how anyone can check it is finished. "
     "Split bigger work into several tasks; 'after' makes a task wait until others are done. "
     "Peers coordinate but never assign work to each other."),
    ("Take it or turn it down", "A task is yours from the moment you read it. If you cannot or "
     "should not do it, close it at once as rejected, with the reason."),
    ("Every task ends with a result", "Close each task with finish_task: done (meeting its "
     "'done when'), blocked (say exactly what you need), failed (say why), or rejected. "
     "Whoever assigned it is told. Never drop a task silently."),
    ("Results are checked", "When a task you gave is done, check it against its 'done when' "
     "and review_task it: accept it, or send it back with specific feedback. After three "
     "send-backs, decide differently: accept, cancel, or assign a new task."),
    ("Help goes up one level", "ask_help goes to your direct superior, who must answer it, "
     "pass it up, or summon a consultant. A question left unanswered is passed up for you."),
    ("Say it once, say it all", "Every message wakes its receiver. Send only what they need to "
     "act on: no 'thanks' or 'ok' messages. Put long material in a file and send its path."),
    ("One writer per file", "You must hold a file's lease to edit it: editing a free file in "
     "your scope takes it, and claim_file can reserve a whole folder (src/api/*) for a task. "
     "Leases run out when their holder stops working. Release files when you are done."),
    ("Everyone sees the team", "Anyone can see every role's status, tasks and files "
     "(team_status). Messages stay private to the sender, the receiver and their superiors."),
    ("Silence is a problem", "A task that shows no progress gets a reminder, then its assigner "
     "is told. Report a blocker as soon as you hit it instead of waiting."),
    ("Urgent is rare", "Only messages going down may be urgent. They interrupt the receiver's "
     "current work, so use them only to stop or redirect it."),
]


def law_text() -> str:
    return "\n".join(f"{i}. {title}. {rule}" for i, (title, rule) in enumerate(LAW, 1))


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
    tasks: list[Task]  # unfinished tasks assigned to this role


Opener = Callable[[Role], None]  # opens a visible session for a newly summoned consultant


def consultant_role(c: Consultant) -> Role:
    return Role(
        name=c.name, superior=c.helped, harness=c.harness, model=c.model, effort=c.effort,
        duties=f"Temporary {c.tier} consultant: help {c.helped} solve its help request #{c.help_id}.",
        tier=c.tier,
    )


def is_pattern(path: str) -> bool:
    return any(ch in path for ch in "*?[")


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
        """Map a path or pattern to (lock key, display form), relative to the project root.

        Windows paths are case-insensitive, so the key is lowercased there:
        'SRC/App.py' and 'src/app.py' are the same file and share one lock.
        """
        root = self.base_team.project_root
        text = str(path)
        if is_pattern(text):
            rel = PurePosixPath(text.replace("\\", "/").removeprefix("./"))
            if rel.is_absolute() or ".." in rel.parts or ":" in text:
                raise PermissionDenied(f"{path}: a pattern must be relative to the project folder")
            display = rel.as_posix()
        else:
            full = (root / path).resolve()
            try:
                display = full.relative_to(root).as_posix()
            except ValueError:
                raise PermissionDenied(f"{path} is outside the project folder {root}") from None
            if display == ".":
                raise PermissionDenied("claim a file or a pattern such as src/*, not the whole project folder")
        return (display.lower() if os.name == "nt" else display), display

    # the hub's own voice

    def notice(self, to: str, text: str, task_id: int | None = None, urgent: bool = False) -> Message:
        """A message from the hub itself: reminders, escalations, expired leases."""
        return self.store.add_message(HUB, to, "notice", text, None, urgent, task_id)

    def event(self, kind: str, role: str, text: str, task_id: int | None = None) -> None:
        self.store.add_event(kind, role, text, task_id)

    def satisfied(self, task_id: int) -> bool:
        dep = self.store.get_task(task_id)
        return dep is not None and dep.state in ("done", "accepted")

    def deliver_task(self, task: Task) -> Task:
        """Hand a task to its assignee as a message."""
        lines = [f"Task #{task.id}: {task.title}"]
        if task.priority != 2:
            lines[0] += f"  [{PRIORITIES.get(task.priority, task.priority)} priority]"
        if task.details:
            lines += ["", task.details]
        if task.done_when:
            lines += ["", f"Done when: {task.done_when}"]
        if task.parent_id:
            lines += ["", f"(Part of task #{task.parent_id}.)"]
        lines += ["", f"When you finish, call finish_task({task.id}, result) - or right away with "
                      "outcome 'rejected' if this is not something you can or should do."]
        message = self.store.add_message(task.assigner, task.assignee, "task", "\n".join(lines)[:MAX_TEXT],
                                         task_id=task.id, urgent=task.priority == 1)
        return self.store.update_task(task.id, state="open", message_id=message.id)

    def release_dependents(self, task: Task) -> list[Task]:
        """Start the tasks that were waiting for `task`, if everything they wait for is done."""
        started = []
        for dep in self.store.dependents(task.id):
            if dep.state == "waiting" and all(self.satisfied(d) for d in dep.depends_on):
                started.append(self.deliver_task(dep))
                self.event("task", dep.assignee, f"#{dep.id} can start now: what it waited for is done", dep.id)
        return started

    def stall_dependents(self, task: Task) -> None:
        """Tell the assigners of tasks waiting for `task` that it will never finish."""
        for dep in self.store.dependents(task.id):
            if dep.state == "waiting":
                self.notice(dep.assigner,
                            f"Task #{dep.id} ({dep.title}) waits for #{task.id}, which ended as {task.state}. "
                            f"It cannot start: cancel_task({dep.id}) and plan again.", dep.id)


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

    def send(self, to: str, text: str, reply_to: int | None = None, urgent: bool = False) -> Message:
        team = self.team
        if to in BROADCAST:
            raise HubError(f"to write to {BROADCAST[to]}, use broadcast")
        if not team.is_member(to):
            raise PermissionDenied(f"'{to}' is not in this team")
        if to == self.name:
            raise PermissionDenied("you cannot message yourself")
        original = self._check_reply(reply_to)
        if to == team.superior_of(self.name):
            kind = "report"
        elif team.is_above(self.name, to):
            kind = "instruction"
        elif to in self._peers(team):
            kind = "peer"
        elif original is not None and original.sender == to and original.recipient == self.name:
            kind = "reply"  # law 2: answering is always allowed
        else:
            raise PermissionDenied(f"you cannot message '{to}'. {self._reach(team)} "
                                   "(You may also reply to any message sent to you.)")
        if urgent and kind != "instruction":
            raise PermissionDenied("only messages to people below you may be urgent")
        thread = original.task_id if original is not None else None
        return self.store.add_message(self.name, to, kind, _text(text), reply_to, urgent, thread)

    def broadcast(self, scope: str, text: str, urgent: bool = False) -> list[Message]:
        """One message to each of your direct subordinates (@team) or everyone below you (@all)."""
        team = self.team
        if scope not in BROADCAST:
            raise HubError(f"broadcast to one of {', '.join(BROADCAST)}")
        names = team.subordinates_of(self.name) if scope == "@team" else team.subtree_of(self.name)
        names = [n for n in names if not team.roles[n].is_consultant]
        if not names:
            raise HubError("there is nobody below you to write to")
        body = _text(text)
        return [self.store.add_message(self.name, n, "instruction", body, None, urgent) for n in names]

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
        original = self._check_reply(reply_to)
        thread = original.task_id if original is not None else None
        return self.store.add_message(self.name, superior, "help", _text(question), reply_to, False, thread)

    def unanswered_help(self) -> list[Message]:
        """Help requests sent to this role that it has neither answered nor sent a consultant for."""
        helped = {c.help_id for c in self.store.active_consultants()}
        return [m for m in self.store.messages_to(self.name, ("help",))
                if m.id not in helped and not self.store.replies_to(m.id, sender=self.name)]

    def read_inbox(self) -> list[Message]:
        """Your new messages. Reading a task makes it yours: it moves to 'working'."""
        self.team  # noqa: B018 - refuses a dismissed consultant
        messages = self.store.take_unread(self.name)
        for m in messages:
            if m.kind == "task" and m.task_id is not None:
                task = self.store.get_task(m.task_id)
                if task is not None and task.assignee == self.name and task.state == "open":
                    self.store.update_task(task.id, state="working", started_at=time.time())
                    self.hub.event("task", self.name, f"started #{task.id}: {task.title}", task.id)
        return messages

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

    def _check_reply(self, reply_to: int | None) -> Message | None:
        if reply_to is None:
            return None
        original = self.store.get_message(reply_to)
        if original is None or self.name not in (original.sender, original.recipient):
            raise PermissionDenied(f"message #{reply_to} is not one of yours")
        return original

    def _reach(self, team: Team) -> str:
        superior = team.superior_of(self.name)
        allowed = ([superior] if superior else []) + self._peers(team) + team.subtree_of(self.name)
        if not allowed:
            return "You can message nobody."
        return "You can message: " + ", ".join(allowed) + "."

    def search(self, words: str, limit: int = 20) -> list[Message]:
        """Messages you may read (yours, and those of roles below you) containing `words`."""
        team = self.team
        found = []
        for m in self.store.search(words, limit * 5):
            if self.is_owner or any(p == self.name or team.is_member(p) and team.is_above(self.name, p)
                                    for p in (m.sender, m.recipient)):
                found.append(m)
            if len(found) >= limit:
                break
        return found

    # tasks

    def assign_task(self, to: str, title: str, details: str = "", part_of: int | None = None,
                    done_when: str = "", after: list[int] | tuple[int, ...] = (), priority: int = 2) -> Task:
        """Give work to someone below you.

        The task starts at once, or - with `after` - when every task it waits for is done.
        """
        team = self.team
        if not team.is_member(to) or to == team.owner:
            raise PermissionDenied(f"'{to}' is not a role in this team")
        if not team.is_above(self.name, to):
            peers = " Peers coordinate but don't assign work to each other." if to in self._peers(team) else ""
            raise PermissionDenied(f"you can only assign tasks to people below you, not '{to}'.{peers}")
        title = _text(title).splitlines()[0][:200]
        if part_of is not None:
            parent = self.store.get_task(part_of)
            if parent is None or parent.assignee != self.name:
                raise PermissionDenied(f"task #{part_of} is not one of your tasks")
        if priority not in PRIORITIES:
            raise HubError(f"priority must be 1 (urgent), 2 (normal) or 3 (low)")
        deps = tuple(dict.fromkeys(int(d) for d in after))
        for d in deps:
            dep = self.store.get_task(d)
            if dep is None:
                raise HubError(f"there is no task #{d} to wait for")
            if dep.state in ("failed", "rejected", "cancelled"):
                raise HubError(f"task #{d} ended as {dep.state}; it will never be done")
        waiting = any(not self.hub.satisfied(d) for d in deps)
        task = self.store.add_task(self.name, to, title, details.strip()[:MAX_TEXT], part_of,
                                   done_when.strip()[:2000], priority, deps, "waiting" if waiting else "open")
        after_text = f" after #{', #'.join(map(str, deps))}" if deps else ""
        self.hub.event("task", self.name, f"gave #{task.id} to {to}{after_text}: {title}", task.id)
        return task if waiting else self.hub.deliver_task(task)

    def finish_task(self, task_id: int, result: str, outcome: str = "done") -> Task:
        """Close one of your tasks: done, blocked (you need something), failed, or rejected."""
        self.team  # noqa: B018 - refuses a dismissed consultant
        task = self.store.get_task(task_id)
        if task is None or task.assignee != self.name:
            raise PermissionDenied(f"task #{task_id} is not assigned to you")
        if outcome not in OUTCOMES:
            raise HubError(f"outcome must be one of: {', '.join(OUTCOMES)}")
        if task.state == "waiting":
            raise HubError(f"task #{task_id} has not started: it waits for #{', #'.join(map(str, task.depends_on))}")
        if task.state not in ("open", "working", "blocked"):
            raise HubError(f"task #{task_id} is already {task.state}")
        result = _text(result)
        task = self.store.update_task(task_id, state=outcome, result=result)
        head = {"done": "is DONE - please review it", "blocked": "is BLOCKED", "failed": "FAILED",
                "rejected": "was REJECTED"}[outcome]
        self.store.add_message(self.name, task.assigner, "result",
                               f"Task #{task.id} {head}: {task.title}\n\n{result}", task.message_id,
                               False, task.id)
        self.hub.event("task", self.name, f"#{task.id} {outcome}: {task.title}", task.id)
        if outcome == "done":
            self.hub.release_dependents(task)
        elif outcome in ("failed", "rejected"):
            self.hub.stall_dependents(task)
        return task

    def review_task(self, task_id: int, accept: bool, feedback: str = "") -> Task:
        """Accept a done task, or send it back to its assignee with what to change."""
        team = self.team
        task = self.store.get_task(task_id)
        if task is None:
            raise HubError(f"there is no task #{task_id}")
        if task.assigner != self.name and not team.is_above(self.name, task.assignee):
            raise PermissionDenied(f"only {task.assigner} (who gave it) or someone above {task.assignee} "
                                   f"reviews task #{task_id}")
        if task.state != "done":
            raise HubError(f"task #{task_id} is {task.state}; only a done task is reviewed")
        if accept:
            task = self.store.update_task(task_id, state="accepted")
            self.hub.event("task", self.name, f"accepted #{task.id}: {task.title}", task.id)
            return task
        feedback = _text(feedback) if feedback.strip() else ""
        if not feedback:
            raise HubError("say what has to change: sending a task back needs feedback")
        if task.revisions >= MAX_REVISIONS:
            raise HubError(f"task #{task_id} was sent back {task.revisions} times already. Decide "
                           "differently: accept it, cancel_task it, or assign a new, clearer task.")
        task = self.store.update_task(task_id, state="working", revisions=task.revisions + 1, nudged_at=None)
        self.store.add_message(self.name, task.assignee, "task",
                               f"Task #{task.id} ({task.title}) is sent back to you (round {task.revisions} "
                               f"of {MAX_REVISIONS}):\n\n{feedback}\n\nFix it and finish_task({task.id}, result) again.",
                               task.message_id, False, task.id)
        self.hub.event("task", self.name, f"sent #{task.id} back to {task.assignee}", task.id)
        return task

    def cancel_task(self, task_id: int, reason: str = "") -> Task:
        """Withdraw a task: its assigner, or anyone above its assignee, may do this."""
        team = self.team
        task = self.store.get_task(task_id)
        if task is None:
            raise HubError(f"there is no task #{task_id}")
        if task.assigner != self.name and not team.is_above(self.name, task.assignee):
            raise PermissionDenied(f"only {task.assigner} or someone above {task.assignee} can cancel task #{task_id}")
        if task.state in CLOSED:
            raise HubError(f"task #{task_id} is already {task.state}")
        delivered = task.state != "waiting"
        task = self.store.update_task(task_id, state="cancelled", result=reason.strip())
        why = f" Reason: {reason.strip()}" if reason.strip() else ""
        if delivered:
            self.store.add_message(self.name, task.assignee, "instruction",
                                   f"Task #{task.id} ({task.title}) is cancelled; stop working on it.{why}",
                                   task.message_id, False, task.id)
        self.hub.event("task", self.name, f"cancelled #{task.id}: {task.title}", task.id)
        self.hub.stall_dependents(task)
        return task

    def task_details(self, task_id: int) -> tuple[Task, list[Message]]:
        """A task and its whole thread, for anyone who may see it (assigner, assignee, above them)."""
        team = self.team
        task = self.store.get_task(task_id)
        if task is None:
            raise HubError(f"there is no task #{task_id}")
        involved = {task.assigner, task.assignee}
        if not (self.name in involved or self.is_owner
                or any(team.is_member(p) and team.is_above(self.name, p) for p in involved)):
            raise PermissionDenied(f"task #{task_id} is between {task.assigner} and {task.assignee}; "
                                   "you can see its status with team_status")
        return task, self.store.thread(task_id)

    def my_tasks(self) -> list[Task]:
        """Tasks you are working on or should start (not the ones still waiting for others)."""
        return self.store.tasks(assignee=self.name, states=("open", "working", "blocked"))

    def queued_tasks(self) -> list[Task]:
        """Tasks given to you that wait for other tasks before they start."""
        return self.store.tasks(assignee=self.name, states=("waiting",))

    def given_tasks(self) -> list[Task]:
        """Tasks you assigned that are not finished (including those waiting for your review)."""
        return self.store.tasks(assigner=self.name, open_only=True)

    def to_review(self) -> list[Task]:
        return self.store.tasks(assigner=self.name, states=("done",))

    # memory

    def save_notes(self, text: str) -> None:
        """Your notes for your next session: what you know and are doing. Replaces the old notes."""
        self.team  # noqa: B018
        if len(text) > MAX_TEXT:
            raise HubError(f"notes are limited to {MAX_TEXT} characters")
        self.store.set_notes(self.name, text.strip())

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
        tasks: dict[str, list[Task]] = {}
        for task in self.store.tasks(open_only=True):
            tasks.setdefault(task.assignee, []).append(task)
        rows: list[Snapshot] = []

        def walk(name: str, depth: int) -> None:
            for child in team.subordinates_of(name):
                rows.append(Snapshot(child, depth, team.roles[child], statuses.get(child),
                                     online.get(child, 0), locks.get(child, 0), tasks.get(child, [])))
                walk(child, depth + 1)

        walk(team.owner, 0)
        return rows

    # file leases

    def current_task(self) -> Task | None:
        """The task this role is most likely working on: its most urgent started task."""
        mine = [t for t in self.my_tasks() if t.state == "working"]
        return min(mine, key=lambda t: (t.priority, t.id)) if mine else None

    def claim(self, path: str | Path, reason: str = "") -> Lock:
        """Take the lease on a file, or on every file matching a pattern such as src/api/*."""
        team = self.team
        key, rel = self.hub.lock_key(path)
        me = team.roles.get(self.name)
        if me is not None and me.is_consultant:
            raise PermissionDenied(
                f"consultants can only edit files handed to them. Ask {me.superior} to hand_over_file {rel} to you.")
        if not self._in_scope(team, self.name, rel):
            scope = ", ".join(self._scope(team, self.name)) or "nothing"
            raise PermissionDenied(f"{rel} is outside your write scope ({scope})")
        if not reason and (task := self.current_task()) is not None:
            reason = f"task #{task.id}"
        lock = self.store.claim(key, rel, self.name, pattern=is_pattern(str(path)), reason=reason.strip()[:200])
        if lock.owner != self.name:
            why = f" for {lock.reason}" if lock.reason else ""
            raise LockConflict(f"{lock.path} is being written by {lock.owner}{why}")
        self.hub.event("file", self.name, f"took {rel}" + (f" ({lock.reason})" if lock.reason else ""))
        return lock

    def release(self, path: str | Path) -> Lock:
        """Release a lease. A consultant's release hands the file back to the agent it helps."""
        team = self.team
        key, rel = self.hub.lock_key(path)
        lock = self.store.lock_for(key)
        if lock is None:
            cover = self.store.covering(key)
            if cover is not None:
                raise HubError(f"{rel} is covered by {cover.owner}'s lease on {cover.path}; release that")
            raise HubError(f"{rel} is not locked")
        if lock.owner != self.name and not team.is_above(self.name, lock.owner):
            raise PermissionDenied(f"{lock.path} is held by {lock.owner}; only they or their superiors can release it")
        holder = team.roles.get(lock.owner)
        if holder is not None and holder.is_consultant:
            moved = self.store.transfer(key, lock.owner, holder.superior)
            return moved or lock
        self.store.release(key)
        self.hub.event("file", self.name, f"released {lock.path}")
        return lock

    def hand_over(self, path: str | Path, to: str) -> Lock:
        """Give a lease you hold to your direct superior or one of your direct subordinates."""
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
        self.hub.event("file", self.name, f"handed {rel} to {to}")
        return moved

    def can_write(self, path: str | Path) -> bool:
        """True only if this role holds a live lease covering `path`. Used by pre-edit hooks."""
        try:
            key, _ = self.hub.lock_key(path)
        except PermissionDenied:
            return False
        lock = self.store.covering(key)
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
        self.hub.event("consultant", self.name, f"summoned {role.name} ({tier}) for {helped}")
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
        self.hub.event("consultant", self.name, f"dismissed {name}")
        return role, returned


def _text(text: str) -> str:
    text = text.strip()
    if not text:
        raise HubError("message is empty")
    if len(text) > MAX_TEXT:
        raise HubError(f"message is {len(text)} characters; the limit is {MAX_TEXT}. Put long "
                       "material in a file and send its path instead.")
    return text
