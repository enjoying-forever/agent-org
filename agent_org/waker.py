"""Wake an agent that rests at its prompt in the agent-org window when work arrives for it.

In the window an agent starts with no first message: its role is in its system prompt, so it
need not re-read its status, and no model runs until there is work. Mail normally reaches an
agent through its Stop hook, which waits for messages at the end of each turn. When no hook is
waiting - right after a start, after you interrupted a turn, after a long wait ran out - this
types one line into the agent's terminal instead: only when the terminal has gone quiet (the
agent is at its prompt), it is not asking you something there, and you have not typed in it
for a while. At the start it also wakes an agent that has unfinished tasks.

DeepSeek is left out: between runs its own waiter (agent_org.wake) starts it.
"""

from __future__ import annotations

import re
import time

from .cards import SERVER_NAME
from .hub import Hub, RoleSession
from .terminals import Terminal, TerminalHost

EVERY = 2.0  # seconds between looks
QUIET = 3.0  # seconds without output: the agent is at its prompt (an idle Claude redraws every ~13 s)
READY = 6.0  # seconds after a start before its first line: the program is still drawing its screen
UNREAD_FOR = 4.0  # a waiting Stop hook takes mail within a second: older mail has nobody taking it
AGAIN = 90.0  # seconds before the same terminal gets another line (doubling while the same mail waits)
MOST = 1800.0  # the longest it waits before trying once more
TYPED = 30.0  # seconds after you typed in a terminal before it gets a line (you may be mid-sentence)
UNSENT = 600.0  # seconds it waits while you have typed text there and not sent it (a line would send yours too)
TAIL = 1500  # characters of recent output searched for a question: about the last screen update

MOVES = re.compile(r"\x1b\[[0-9;]*[CHf]")  # cursor moves: some programs skip blank cells with them
ANSI = re.compile(r"\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
# What a program waiting for its user shows (as the page's own check, plus Codex's hook review):
# never answer it by typing.
ASKING = re.compile("|".join([
    r"do\s+you\s+want\s+to", r"would\s+you\s+like\s+to", r"do\s+you\s+trust",
    r"trust\s+(?:this|the)\s+(?:folder|directory|files)", r"trust\s+all", r"review\s+(?:the\s+)?hooks",
    r"allow\s+(?:this|command|once|always)", r"\[y/n\]", r"\(y/n\)", r"press\s+enter\s+to\s+(?:continue|confirm)",
    r"waiting\s+for\s+(?:your\s+)?(?:approval|confirmation)"]), re.I)
# ... with its choices: a question the agent only wrote in its answer must not keep it from waking.
CHOICES = re.compile(r"(?:^|\s)[❯›>]?\s*1[.)]\s+\S|\[y/n\]|\(y/n\)|\(esc\)|enter\s+to\s+(?:confirm|select|continue)",
                     re.I | re.M)
# A menu with one choice highlighted (Claude's ❯, Codex's ›) waits for a key, whatever it asks - an
# update, a folder to trust: Enter would pick for you.
MENU = re.compile(r"[❯›]\s*\d[.)]\s+\S|enter\s+(?:to\s+)?(?:continue|confirm|select)\s*·\s*esc", re.I)


def unfinished(me: RoleSession) -> list[str]:
    """Work an agent was in the middle of: tasks it should do, results it should review."""
    mine = [f"#{t.id} {t.title}" for t in me.store.tasks(assignee=me.name, states=("open", "working"))]
    review = [f"#{t.id} {t.title} (to review)" for t in me.to_review()]
    return mine + review


def wake_line(harness: str, role: str, tasks: list[str] | None = None) -> str:
    """The one line typed into an idle agent's terminal: what waits, and how to get it."""
    if tasks:
        shown = "; ".join(tasks[:4]) + (f"; and {len(tasks) - 4} more" if len(tasks) > 4 else "")
        line = (f"agent-org: '{role}', the team was restarted and you have unfinished work: {shown}. "
                "Carry on with it (list_tasks), then end your turn.")
    else:
        line = (f"agent-org: '{role}', you have new messages. Call read_inbox and act on them, then end "
                "your turn.")
    if harness == "antigravity":  # no system prompt of its own: a new conversation learns its role here
        line += (f" If this conversation has not read your role yet, first call_mcp_tool with ServerName "
                 f"agent-org_{SERVER_NAME}, ToolName my_role, Arguments {{}}: it also lists every team tool's "
                 "arguments, so there is no need to open their files.")
    return line


def asking(term: Terminal) -> bool:
    data = term.chunk(max(0, term.end - TAIL))["data"]
    text = ANSI.sub("", MOVES.sub(" ", str(data)))
    return bool(MENU.search(text) or (ASKING.search(text) and CHOICES.search(text)))


class Waker:
    """Decides, every couple of seconds, which resting agents get a line - and types it."""

    def __init__(self) -> None:
        self._typed_at: dict[int, float] = {}  # terminal id -> when it last got a line
        self._tries: dict[int, tuple[float | None, int]] = {}  # terminal id -> (mail it was woken for, times)
        self._started: set[int] = set()  # terminals already checked for unfinished work

    def tick(self, hub: Hub, host: TerminalHost, now: float | None = None) -> list[str]:
        """Wake whoever needs it; returns the roles woken."""
        now = time.time() if now is None else now
        team = hub.team
        unread_since = hub.store.unread_since()
        stuck = hub.stuck()  # out of usage, or broken: a line would change nothing (it is restarted later)
        online = hub.store.online()  # its program runs (its tool server checks in): else the line would go to a shell
        woken = []
        for name, term in host.items():
            spec = team.roles.get(name)
            if spec is None or spec.harness == "deepseek" or not term.alive or name in stuck or not online.get(name):
                continue
            if now - term.started < READY or now - term.last_output < QUIET or now - term.last_input < TYPED:
                continue
            if getattr(term, "unsent", False) and now - term.last_input < UNSENT:
                continue
            since = unread_since.get(name)
            woken_for, times = self._tries.get(term.id, (None, 0))
            if since != woken_for:
                times = 0  # other mail than last time: it did read what it was woken for
            if now - self._typed_at.get(term.id, 0.0) < min(AGAIN * 2 ** times, MOST):
                continue
            first_look = term.id not in self._started
            self._started.add(term.id)
            if since is not None and now - since >= UNREAD_FOR:
                line = wake_line(spec.harness, name)
            elif first_look and (tasks := unfinished(hub.session(name))):
                line = wake_line(spec.harness, name, tasks)
            else:
                continue
            if asking(term):
                self._started.discard(term.id)  # look again once it is answered
                continue
            self._typed_at[term.id] = now
            self._tries[term.id] = (since, times + 1)
            type_line(term, line)
            hub.event("agent", name, "woken: " + ("unfinished work after a restart" if "restarted" in line
                                                  else "new messages"))
            woken.append(name)
        return woken


def type_line(term: Terminal, line: str) -> None:
    """Type `line` and press Enter - apart, so the program takes the text as typed, not pasted."""
    term.write(line)
    time.sleep(0.4)
    term.write("\r")
