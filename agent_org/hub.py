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

import hashlib
import json
import os
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from fnmatch import fnmatchcase
from pathlib import Path, PurePosixPath

from . import presets, safety, verify
import yaml

from .filelock import file_lock
from .store import ACTIVE, CLOSED, Consultant, Lock, Message, Status, Store, Task
from .team import HARNESSES, NAME_RE, Role, Team, TeamError


class _OnFirstUse:
    """A module imported when first used: a hook (a new process on every tool call) that never needs
    git starts faster without it."""

    def __init__(self, name: str) -> None:
        self._name = name

    def __getattr__(self, attr: str):
        import importlib  # noqa: PLC0415

        module = importlib.import_module(self._name)
        globals()[self._name.rsplit(".", 1)[-1]] = module
        return getattr(module, attr)


gitops = _OnFirstUse("agent_org.gitops")

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
     "Leases run out when their holder stops working. Closing your last task releases your files; "
     "release_file one earlier if someone needs it."),
    ("Everyone sees the team", "Anyone can see every role's status, tasks and files "
     "(team_status). Messages stay private to the sender, the receiver and their superiors."),
    ("Silence is a problem", "A task that shows no progress gets a reminder, then its assigner "
     "is told. Report a blocker as soon as you hit it instead of waiting. When an agent is out of "
     "its usage limit, whoever gave its tasks moves them (reassign_task) to someone who can work, "
     "preferably on another subscription, or lets them wait for the reset."),
    ("Urgent is rare", "Only messages going down may be urgent. They interrupt the receiver's "
     "current work, so use them only to stop or redirect it."),
]


BRANCH_RULE = ("Your own copy", "You work in your own copy of the project, on git branch agent/<you>: edit any "
               "file in your scope, no locks, no waiting. When you finish a task as done (or call share_work), the "
               "hub merges the latest main into your copy, runs the checks, and puts your work into main for "
               "everyone. Where you and someone else changed the same lines, you resolve the conflict markers.")


def law_text(branches: bool = False) -> str:
    rules = [BRANCH_RULE if branches and title == "One writer per file" else (title, rule) for title, rule in LAW]
    return "\n".join(f"{i}. {title}. {rule}" for i, (title, rule) in enumerate(rules, 1))


GIT_ERRORS = (subprocess.CalledProcessError, subprocess.TimeoutExpired, RuntimeError, TimeoutError, OSError)


def conflict_text(files: list[str]) -> str:
    return (f"Your work and main both changed the same lines in {', '.join(files)}. Everything else merged; "
            "those spots in your copy now hold both versions between <<<<<<< and >>>>>>> markers (the original "
            "text in the middle, after |||||||). Edit each spot to the right result - `git log main -p -- <file>` "
            "shows who changed what - then try again.")


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
    stuck: str = ""    # why it cannot work right now (usage limit, API error), if it can't


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
    RELOAD_EVERY = 1.0  # seconds between looks at team.yaml for changes made elsewhere

    def __init__(self, team: Team, store: Store, opener: Opener | None = None,
                 team_file: str | Path | None = None, stopper: Callable[[str], object] | None = None):
        self.team_file = Path(team_file).resolve() if team_file else None
        self._base_team = team
        self._stamp = self._fingerprint()
        self._checked = time.time()
        self.store = store
        self.opener = opener
        self.stopper = stopper  # ends a let-go agent's program (the launcher's stop_role)

    @classmethod
    def open(cls, team_path: str | Path, opener: Opener | None = None,
             stopper: Callable[[str], object] | None = None) -> Hub:
        team = Team.load(team_path)
        return cls(team, Store(team.database), opener, team_path, stopper)

    def _fingerprint(self) -> bytes:
        """What team.yaml holds now (its content: two quick writes can share a timestamp on Windows)."""
        try:
            return hashlib.sha1(self.team_file.read_bytes()).digest() if self.team_file else b""
        except OSError:
            return b""

    @property
    def base_team(self) -> Team:
        """The team from team.yaml - reloaded when anyone (an agent, the page) changes the file."""
        if self.team_file and time.time() - self._checked >= self.RELOAD_EVERY:
            self._checked = time.time()
            stamp = self._fingerprint()
            if stamp != self._stamp:
                self._stamp = stamp
                try:
                    self._base_team = Team.load(self.team_file)
                except (TeamError, OSError, yaml.YAMLError):
                    pass  # half-written or broken: keep the last good team
        return self._base_team

    @base_team.setter
    def base_team(self, team: Team) -> None:
        self._base_team = team
        self._stamp = self._fingerprint()

    def edit_team(self, change: Callable[[dict], None]) -> Team:
        """Change team.yaml: `change` edits its content; the result is checked before it is saved."""
        if self.team_file is None:
            raise HubError("this hub was opened without its team.yaml, so the team cannot be changed")
        with file_lock(self.team_file.parent / ".agent-org" / "team.lock", busy="someone else is changing the team"):
            text = self.team_file.read_text(encoding="utf-8")
            config = yaml.safe_load(text) or {}
            change(config)
            try:
                team = Team.from_dict(config, base_dir=self.team_file.parent)
            except TeamError as e:
                raise HubError(f"that change would break the team: {e}") from None
            self.team_file.with_suffix(self.team_file.suffix + ".bak").write_text(text, encoding="utf-8")
            self.team_file.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True, width=100),
                                      encoding="utf-8")
        self.base_team = team
        return team

    def close(self) -> None:
        self.store.close()

    @property
    def team(self) -> Team:
        """The tree as it stands now: the roles from team.yaml plus the active consultants."""
        active = self.store.active_consultants()
        if not active:
            return self.base_team
        return self.base_team.with_roles([consultant_role(c) for c in active])

    # branches: every agent in its own worktree

    @property
    def branches(self) -> bool:
        return self.base_team.settings.branches

    def branch_role(self, role: str) -> str:
        """Whose copy `role` works in: its own, or - for a consultant - the agent it helps."""
        team = self.team
        seen = set()
        while role in team.roles and team.roles[role].is_consultant and role not in seen:
            seen.add(role)
            role = team.roles[role].superior
        return role

    def root_of(self, role: str) -> Path:
        """The folder `role` works in: its own worktree in branch mode, else the project folder."""
        if not self.branches or role == self.base_team.owner:
            return self.base_team.project_root
        return gitops.worktree_path(self.base_team.project_root, self.branch_role(role))

    def prepare_root(self, role: str) -> Path:
        """Make sure the role's folder exists (in branch mode: history on, and its worktree)."""
        root = self.base_team.project_root
        if not self.branches or role == self.base_team.owner:
            return root
        try:
            if not gitops.is_own_repo(root):
                gitops.init(root)
                self.event("git", self.base_team.owner, "turned history on: each agent works on its own branch")
            return gitops.ensure_worktree(root, self.branch_role(role))
        except GIT_ERRORS as e:
            raise HubError(f"could not set up {role}'s copy of the project: {e}") from None

    def sync_role(self, role: str) -> str:
        """Branch mode: take the latest main into the role's copy when main has moved on.

        Returns a line for the agent ('' when nothing happened). A merge that would conflict is
        left for the agent's next finish_task / share_work, and only mentioned once.
        """
        if not self.branches:
            return ""
        owner = self.branch_role(role)
        root, wt = self.base_team.project_root, self.root_of(role)
        if not (wt / ".git").exists():
            return ""
        try:
            main = gitops.main_branch(root)
            now = gitops.head(root, main)
            if (not now or gitops.merging(wt) or self.store.get_setting(f"synced:{owner}") == now
                    or self.store.get_setting(f"sync-conflict:{owner}") == now):
                return ""
            gitops.commit_all(wt, f"{owner}: work in progress (before taking in main)")
            changed, conflicts = gitops.sync(wt, main, abort_on_conflict=True)
        except GIT_ERRORS:
            return ""
        if conflicts:
            self.store.set_setting(f"sync-conflict:{owner}", now)
            return (f"agent-org: main has new work that touches the same lines as yours in {', '.join(conflicts)}. "
                    "Carry on; you will settle those spots when you finish (or share_work).")
        self.store.set_setting(f"synced:{owner}", now)
        if not changed:
            return ""
        return (f"agent-org: your copy now includes the latest main (changed: {', '.join(changed[:12])}"
                f"{' ...' if len(changed) > 12 else ''}). Re-read those files before you edit them.")

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
        """A message from the hub itself: reminders and escalations. It wakes its receiver."""
        return self.store.add_message(HUB, to, "notice", text, None, urgent, task_id)

    def note(self, to: str, text: str) -> Message:
        """Mail from the hub that does not wake its receiver: it comes with the next message that does
        (or the next read_inbox). For news that changes nothing right now - a role changed, say -
        which would otherwise cost an idle agent a turn."""
        return self.store.add_message(HUB, to, "note", text, None, False, None)

    def event(self, kind: str, role: str, text: str, task_id: int | None = None) -> None:
        self.store.add_event(kind, role, text, task_id)

    def stuck(self) -> dict[str, dict]:
        """Agents that cannot work right now, as the watchdog last saw them: role -> kind, text, at, until."""
        try:
            found = json.loads(self.store.get_setting("stuck") or "{}")
        except ValueError:
            return {}
        return found if isinstance(found, dict) else {}

    def set_stuck(self, found: dict[str, dict]) -> None:
        text = json.dumps(found, sort_keys=True)
        if text != (self.store.get_setting("stuck") or "{}"):
            self.store.set_setting("stuck", text)

    def satisfied(self, task_id: int) -> bool:
        dep = self.store.get_task(task_id)
        return dep is not None and dep.state in ("done", "accepted")

    def deliver_task(self, task: Task, preface: str = "") -> Task:
        """Hand a task to its assignee as a message."""
        lines = [preface, ""] if preface else []
        lines += [f"Task #{task.id}: {task.title}"]
        if task.priority != 2:
            lines[-1] += f"  [{PRIORITIES.get(task.priority, task.priority)} priority]"
        if task.details:
            lines += ["", task.details]
        if task.done_when:
            lines += ["", f"Done when: {task.done_when}"]
        if self.base_team.checks:
            lines += ["", "Before it can close as done, the hub runs the team's checks (run them yourself first):"]
            lines += [f"- {verify.describe(c)}" for c in self.base_team.checks]
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
        self.released: list[str] = []  # files the last finish_task let go of

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
        if to.strip().lower() in ("owner", "@owner", "the owner") and not team.is_member(to):
            to = team.owner  # an agent may not know the owner's name; "owner" always reaches them
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
                    self.hub.sync_role(self.name)  # a new task starts from the latest main
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
            self.team  # noqa: B018 - a consultant dismissed meanwhile is told so
            if self.store.unread_count(self.name, waking=True):  # notes alone do not end the wait
                return self.read_inbox()
            if time.monotonic() >= deadline:
                return []
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
        checks, landed = "", {}
        if self.hub.branches and outcome == "done":
            commit, checks = self._integrate(f"task #{task.id}: {task.title}", self.store.task_files(task_id),
                                             f"task #{task_id} is not done yet", task.id)
            landed = {"commit_id": commit} if commit else {}
        elif self.hub.branches:
            self._save_work(f"task #{task.id} ({outcome})")
        elif outcome == "done":
            files, root = self.store.task_files(task_id), self.hub.base_team.project_root
            if files and self.team.settings.scan_secrets and self.team.settings.commit_on_accept:
                self._no_secrets(gitops.diff(root, files), f"task #{task_id} is not done yet", task.id)
            checks = self._checks(files, root, f"task #{task_id} is not done yet", task.id)
        task = self.store.update_task(task_id, state=outcome, result=result, checks=checks, **landed)
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
        self.released = self._release_when_idle() if outcome != "blocked" else []
        return task

    def _release_when_idle(self) -> list[str]:
        """With its last task closed, an agent has nothing to hold files for: they are released for it
        (seen: an agent spent a call per file releasing them by hand). Blocked work keeps its files."""
        if any(t.state in ("open", "working", "blocked") for t in self.my_tasks()):
            return []
        released = []
        for lock in self.store.locks(self.name):
            self.store.release(self.hub.lock_key(lock.path)[0])
            self.hub.event("file", self.name, f"released {lock.path}: its tasks are finished")
            released.append(lock.path)
        return released

    def _checks(self, files: list[str], cwd: Path, refusal: str, task_id: int | None) -> str:
        """Run the team's checks that apply to `files` in `cwd`; refuse with their output if one fails."""
        if not self.team.checks:
            return ""
        outcomes = verify.run(self.team, files, cwd)
        failed = [o for o in outcomes if not o.ok]
        checks = verify.summary(outcomes)
        if failed:
            self.hub.event("check", self.name, f"checks failed: {checks}", task_id)
            details = "\n\n".join(f"--- {o.name}: `{o.command}` (run in {cwd}) ---\n{o.output}" for o in failed)
            raise HubError(f"{refusal}: {checks}.\n\n{details}\n\nRun the command yourself to see what it "
                           "expects, fix it, and try again - or close the task as blocked or failed and say why.")
        return checks

    def _save_work(self, what: str) -> None:
        """Branch mode: commit whatever is in the role's copy, so nothing is lost."""
        try:
            gitops.commit_all(self.hub.root_of(self.name), f"{self.hub.branch_role(self.name)}: {what}")
        except GIT_ERRORS:
            pass

    def _integrate(self, message: str, files: list[str], refusal: str, task_id: int | None) -> tuple[str, str]:
        """Branch mode: commit this role's work, merge the latest main into it, run the checks on the
        result, and put it into main. Returns (commit in main, checks summary)."""
        hub = self.hub
        root, wt = hub.base_team.project_root, hub.root_of(self.name)
        branch = gitops.BRANCH_PREFIX + hub.branch_role(self.name)
        if not (wt / ".git").exists():
            raise HubError(f"{self.name} has no copy of the project yet; restart it from the agent-org page")
        try:
            main = gitops.main_branch(root)
            if gitops.merging(wt):
                left = gitops.with_markers(wt, gitops.conflicted(wt) or
                                           gitops.git(wt, "diff", "--name-only", "HEAD").stdout.split())
                if left:
                    raise HubError(f"{refusal}: {', '.join(left)} still hold conflict markers "
                                   "(<<<<<<< / >>>>>>>). Settle each spot, then try again.")
            gitops.commit_all(wt, f"{hub.branch_role(self.name)}: {message}")
            _, conflicts = gitops.sync(wt, main, abort_on_conflict=False)
            if conflicts:
                hub.event("git", self.name, f"conflicts with main in {', '.join(conflicts)}", task_id)
                raise HubError(f"{refusal}. {conflict_text(conflicts)}")
            changed = gitops.git(wt, "diff", "--name-only", f"{main}...HEAD").stdout.split()
            if not gitops.git(wt, "rev-list", "--count", f"{main}..HEAD").stdout.strip().strip("0"):
                return "", ""  # nothing of its own to put into main
            self._landing_checks(wt, main, changed, refusal, task_id)
            checks = self._checks(sorted(set(files) | set(changed)), wt, refusal, task_id)
            with gitops.land_lock(root):
                commit, why = gitops.land(root, branch, message)
                if commit is None:  # main moved on while the checks ran: take it in and try once more
                    _, conflicts = gitops.sync(wt, main, abort_on_conflict=False)
                    if conflicts:
                        raise HubError(f"{refusal}. {conflict_text(conflicts)}")
                    commit, why = gitops.land(root, branch, message)
                if commit is None:
                    raise HubError(f"{refusal}: your work could not go into main: {why}")
                gitops.sync(wt, main, abort_on_conflict=True)  # a fast-forward: your copy = main again
                hub.store.set_setting(f"synced:{hub.branch_role(self.name)}", gitops.head(root, main))
        except GIT_ERRORS as e:
            raise HubError(f"{refusal}: git failed: {e}") from None
        hub.event("git", self.name, f"merged into main as {commit}: {message}", task_id)
        return commit, checks

    def _landing_checks(self, wt: Path, main: str, changed: list[str], refusal: str, task_id: int | None) -> None:
        """What never goes into main: the team's own configuration, files outside the agent's write
        scope (also written through the shell), and secrets."""
        team = self.team
        name = self.hub.team_file.name if self.hub.team_file else "team.yaml"
        guarded = [f for f in changed if safety.protected(f, name)]
        if guarded:
            self.hub.event("safety", self.name, f"refused to land changes to {', '.join(guarded)}", task_id)
            raise HubError(f"{refusal}: your copy changes {', '.join(guarded)}, the team's own configuration. "
                           f"Undo that (git checkout {main} -- <file>), then try again.")
        outside = safety.outside_scope([f for f in changed if not gitops.is_junk(f)], self._scope(team, self.name))
        if outside:
            self.hub.event("safety", self.name, f"refused to land files outside its scope: {', '.join(outside)}",
                           task_id)
            raise HubError(f"{refusal}: {', '.join(outside)} {'is' if len(outside) == 1 else 'are'} outside the "
                           f"files you may write ({', '.join(self._scope(team, self.name)) or 'none'}). Undo "
                           f"those changes (git checkout {main} -- <file>, or delete new files), or ask "
                           f"{self.superior} to change your scope.")
        self._no_secrets(gitops.git(wt, "diff", f"{main}...HEAD").stdout, refusal, task_id)

    def _no_secrets(self, diff: str, refusal: str, task_id: int | None) -> None:
        if not self.team.settings.scan_secrets:
            return
        found = safety.find_secrets(diff)
        if found:
            self.hub.event("safety", self.name, f"refused to put secrets into history: {', '.join(found)}", task_id)
            raise HubError(f"{refusal}: this would put secrets into git history: {', '.join(found)}. Read them "
                           "from an environment variable or a file that is not committed (add it to .gitignore) "
                           "instead, then try again.")

    def share_work(self, summary: str) -> str:
        """Branch mode: put your work so far into main now, without finishing a task (after the checks)."""
        self.team  # noqa: B018
        if not self.hub.branches:
            raise HubError("this team works in one shared folder: your saved edits are already visible to everyone")
        line = _text(summary).splitlines()[0][:200]
        commit, _ = self._integrate(f"{self.hub.branch_role(self.name)} shares: {line}", [],
                                    "your work was not shared", None)
        return commit

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
            return task if self.hub.branches else self._commit(task)  # branches: it is in main already
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

    def _commit(self, task: Task) -> Task:
        """Commit the files an accepted task changed, if the team keeps history."""
        if not self.team.settings.commit_on_accept:
            return task
        files = self.store.task_files(task.id)
        if not files:
            return task
        message = (f"task #{task.id}: {task.title}\n\nDone by {task.assignee}, accepted by {self.name}."
                   + (f"\n\n{task.result[:1500]}" if task.result else ""))
        try:
            commit_id = gitops.commit(self.hub.base_team.project_root, files, message)
        except Exception as e:  # noqa: BLE001 - history is a bonus; acceptance stands without it
            self.hub.event("git", self.name, f"could not commit #{task.id}: {e}", task.id)
            return task
        if commit_id:
            self.hub.event("git", self.name, f"committed #{task.id} as {commit_id}", task.id)
            return self.store.update_task(task.id, commit_id=commit_id)
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

    def reassign_task(self, task_id: int, to: str, reason: str = "") -> Task:
        """Move an unfinished task to someone else - say, because its assignee is out of its usage limit.

        Its assigner, or anyone above its assignee, may do this; the new assignee must be below
        both the mover and the assigner. Leases the old assignee holds on the task's files move
        with it, and the new assignee is told what was done so far.
        """
        team = self.team
        task = self.store.get_task(task_id)
        if task is None:
            raise HubError(f"there is no task #{task_id}")
        if task.assigner != self.name and not team.is_above(self.name, task.assignee):
            raise PermissionDenied(f"only {task.assigner} or someone above {task.assignee} can move task #{task_id}")
        if task.state not in ACTIVE:
            raise HubError(f"task #{task_id} is {task.state}; only an unfinished task can be moved")
        if not team.is_member(to) or to == team.owner:
            raise PermissionDenied(f"'{to}' is not a role in this team")
        if to == task.assignee:
            raise HubError(f"task #{task_id} is already {to}'s")
        receiver = team.roles[to]
        if receiver.is_consultant:
            raise PermissionDenied(f"{to} is a consultant; it helps with a problem but does not take tasks")
        if not (team.is_above(self.name, to) and (task.assigner == team.owner or team.is_above(task.assigner, to))):
            raise PermissionDenied(f"{to} must be below both you and {task.assigner}, who gave task #{task_id}")
        before = task.assignee
        files = self.store.task_files(task_id)
        moved, freed = [], []
        for f in files:
            try:
                lock = self.store.covering(self.hub.lock_key(f)[0])
            except PermissionDenied:
                continue
            if lock is None or lock.owner != before or lock.path in moved + freed:
                continue
            key = self.hub.lock_key(lock.path)[0]
            if self._in_scope(team, to, lock.path) and self.store.transfer(key, before, to):
                moved.append(lock.path)
            else:
                self.store.release(key)
                freed.append(lock.path)
        why = reason.strip()
        task = self.store.update_task(task_id, assignee=to, started_at=None, nudged_at=None)
        if task.state != "waiting":
            notes = [f"This task was {before}'s and is now yours" + (f": {why}" if why else ".")]
            if task.result:
                notes.append(f"{before}'s last word on it: {task.result[:1500]}")
            if files:
                notes.append(f"Files it changed so far: {', '.join(files)}.")
            if moved:
                notes.append(f"You now hold its leases on: {', '.join(moved)}.")
            notes.append(f"Its whole history: task_details({task.id}).")
            task = self.hub.deliver_task(task, "\n".join(notes))
        if before in team.roles:
            self.store.add_message(self.name, before, "instruction",
                                   f"Task #{task.id} ({task.title}) was moved to {to}; stop working on it."
                                   + (f" Reason: {why}" if why else "")
                                   + (f" Your leases on {', '.join(moved + freed)} went with it." if moved or freed else ""),
                                   None, False, task.id)
        self.hub.event("task", self.name, f"moved #{task.id} from {before} to {to}" + (f": {why}" if why else ""),
                       task.id)
        return task

    # changing the team (hire, change, let go) - only below yourself

    def _may_change_team(self) -> Team:
        team = self.team
        me = team.roles.get(self.name)
        if not team.settings.team_changes:
            raise PermissionDenied("the owner has turned team changes off; ask them instead")
        if me is not None and me.is_consultant:
            raise PermissionDenied("consultants do not change the team")
        return team

    def hire(self, name: str, harness: str = "", duties: str = "", model: str = "", effort: str = "",
             write_scope: list[str] | tuple[str, ...] | None = None, superior: str = "", preset: str = "",
             instructions: str = "") -> Role:
        """Add an agent under yourself (or under someone below you); it starts at once.

        With a `preset` (a role from the owner's library) its settings are the starting point;
        whatever else is given overrides them.
        """
        team = self._may_change_team()
        if preset:
            try:
                base = presets.get(preset)
            except KeyError:
                raise HubError(f"there is no role preset '{preset}'; known: {', '.join(presets.names())}") from None
            harness = harness or base.get("harness", "")
            duties = duties or base.get("duties", "")
            model = model or base.get("model", "")
            effort = effort or base.get("effort", "")
            instructions = instructions or base.get("instructions", "")
            write_scope = base.get("write_scope", []) if write_scope is None else write_scope
        write_scope = write_scope or []
        if not duties.strip():
            raise HubError("say what the new agent is for (duties), or hire from a preset")
        superior = superior or self.name
        if superior != self.name and not team.is_above(self.name, superior):
            raise PermissionDenied(f"you can only hire under yourself or someone below you, not under {superior}")
        if not NAME_RE.match(name) or name.startswith("consultant-"):
            raise HubError("give it a simple name: letters, digits, - and _ (not starting with consultant-)")
        if team.is_member(name):
            raise HubError(f"there is already a '{name}' in the team")
        if harness not in HARNESSES:
            raise HubError(f"harness must be one of {list(HARNESSES)}")
        if len(self.hub.base_team.roles) >= team.settings.max_agents:
            raise HubError(f"the team already has {team.settings.max_agents} agents, the most the owner allows; "
                           "let one go first, or ask the owner")
        self._scope_allowed(team, write_scope)
        spec = {"superior": superior, "harness": harness, "duties": _text(duties)[:2000],
                "write_scope": [str(p) for p in write_scope]}
        if model.strip():
            spec["model"] = model.strip()
        if effort.strip():
            spec["effort"] = effort.strip()
        if instructions.strip():
            spec["instructions"] = _text(instructions)[:8000]
        self.hub.edit_team(lambda c: c.setdefault("roles", {}).__setitem__(name, spec))
        role = self.hub.team.roles[name]
        self._announce(f"hired {name} ({harness}{', ' + model if model else ''}) under {superior}: {duties[:200]}")
        limit = team.settings.max_running
        running = sum(1 for n in self.store.online() if n in team.roles)
        if limit and running >= limit:
            self.hub.event("agent", name, f"not started: {limit} agents are running already (the team's limit)")
        elif self.hub.opener is not None:
            try:
                self.hub.opener(role)
            except Exception as e:  # noqa: BLE001 - the role exists; it can be started from the page
                self.hub.event("agent", self.name, f"could not open {name}'s tab: {e}")
        return role

    def change_role(self, name: str, duties: str | None = None, model: str | None = None,
                    effort: str | None = None, write_scope: list[str] | None = None,
                    superior: str | None = None) -> Role:
        """Change an agent below you. A new model or effort applies from its next start."""
        team = self._may_change_team()
        if not team.is_above(self.name, name) or team.roles[name].is_consultant:
            raise PermissionDenied(f"you can only change agents below you, and '{name}' is not one")
        if superior is not None and superior != self.name and not team.is_above(self.name, superior):
            raise PermissionDenied(f"{name} can only move under you or someone below you")
        if write_scope is not None:
            self._scope_allowed(team, write_scope)
        what = {"duties": duties, "model": model, "effort": effort, "write_scope": write_scope,
                "superior": superior}
        what = {k: v for k, v in what.items() if v is not None}
        if not what:
            raise HubError("say what to change: duties, model, effort, write_scope or superior")

        def change(config: dict) -> None:
            spec = config["roles"][name]
            for key, value in what.items():
                if value in ("", []) and key in ("model", "effort"):
                    spec.pop(key, None)
                else:
                    spec[key] = list(value) if key == "write_scope" else value

        self.hub.edit_team(change)
        self._announce(f"changed {name}: " + ", ".join(f"{k} -> {v}" for k, v in what.items())[:300])
        if superior is not None or duties is not None or write_scope is not None:
            self.hub.note(name, f"{self.name} changed your role ({', '.join(what)}). Call my_role to see it now.")
        return self.hub.team.roles[name]

    def let_go(self, name: str, reason: str = "") -> list[str]:
        """Remove an agent below you. Its subordinates move up to its superior. Returns who moved."""
        team = self._may_change_team()
        if not team.is_above(self.name, name) or team.roles[name].is_consultant:
            raise PermissionDenied(f"you can only let go of agents below you, and '{name}' is not one")
        busy = [t for t in self.store.tasks(assignee=name, open_only=True) if t.state in ACTIVE]
        if busy:
            raise HubError(f"{name} still has unfinished tasks ({', '.join(f'#{t.id}' for t in busy)}): "
                           "reassign_task or cancel_task them first")
        above = team.roles[name].superior
        moved = team.subordinates_of(name)

        def change(config: dict) -> None:
            for sub in moved:
                config["roles"][sub]["superior"] = above
            del config["roles"][name]

        if self.hub.stopper is not None:
            try:
                self.hub.stopper(name)
            except Exception:  # noqa: BLE001 - its tab can be closed by hand
                pass
        for lock in self.store.locks(name):
            self.store.release(self.hub.lock_key(lock.path)[0])
        self.hub.edit_team(change)
        self._announce(f"let go of {name}" + (f": {reason.strip()}" if reason.strip() else "")
                       + (f"; {', '.join(moved)} now report to {above}" if moved else ""))
        for sub in moved:
            self.hub.note(sub, f"{name} has left the team; you now report to {above}. Call my_role.")
        return moved

    def _scope_allowed(self, team: Team, scope: list[str] | tuple[str, ...]) -> None:
        """A manager cannot give anyone more files than it may write itself."""
        beyond = safety.scope_within(list(scope), self._scope(team, self.name))
        if beyond:
            raise PermissionDenied(f"you can only give files you may write yourself; {', '.join(beyond)} "
                                   "reach beyond your own scope")

    def _announce(self, what: str) -> None:
        """Team changes are recorded and told to the owner."""
        self.hub.event("team", self.name, what)
        owner = self.team.owner
        if self.name != owner:
            self.hub.notice(owner, f"Team change by {self.name}: {what}")

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
        stuck = {name: describe_stuck(info) for name, info in self.hub.stuck().items()}
        rows: list[Snapshot] = []

        def walk(name: str, depth: int) -> None:
            for child in team.subordinates_of(name):
                rows.append(Snapshot(child, depth, team.roles[child], statuses.get(child),
                                     online.get(child, 0), locks.get(child, 0), tasks.get(child, []),
                                     stuck.get(child, "")))
                walk(child, depth + 1)

        walk(team.owner, 0)
        return rows

    # file leases

    def current_task(self) -> Task | None:
        """The task this role is most likely working on: its most urgent started task.

        A consultant works on the current task of the agent it helps.
        """
        me = self.team.roles.get(self.name)
        if me is not None and me.is_consultant:
            return self.hub.session(me.superior).current_task()
        mine = [t for t in self.my_tasks() if t.state == "working"]
        return min(mine, key=lambda t: (t.priority, t.id)) if mine else None

    def note_edit(self, rel: str) -> None:
        """Remember that the current task changed `rel`, for its review and its commit."""
        task = self.current_task()
        if task is not None:
            self.store.add_task_file(task.id, rel)

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
        if not lock.pattern:
            self.note_edit(rel)
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
        role = team.roles[name]
        if role.is_consultant and self.hub.branches:  # it works in the copy of the agent it helps
            return self._scope(team, self.hub.branch_role(name))
        return role.write_scope

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


def describe_stuck(info: dict) -> str:
    """'out of its usage limit until 19:20' or 'stopped by an API error'."""
    if info.get("kind") == "limit":
        until = info.get("until")
        if not until:
            return "out of its usage limit"
        if until <= time.time():
            return "its usage limit has reset; it needs a restart"
        fmt = "%H:%M" if until - time.time() < 20 * 3600 else "%b %d %H:%M"
        return f"out of its usage limit until {time.strftime(fmt, time.localtime(until))}"
    return f"stopped by an API error: {str(info.get('text', ''))[:120]}"


def _text(text: str) -> str:
    text = text.strip()
    if not text:
        raise HubError("message is empty")
    if len(text) > MAX_TEXT:
        raise HubError(f"message is {len(text)} characters; the limit is {MAX_TEXT}. Put long "
                       "material in a file and send its path instead.")
    return text
