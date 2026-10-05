"""MCP server that gives one agent the tools of its role.

Each harness starts its own copy over stdio, bound to one role:

    python -m agent_org.mcp_server --team path/to/team.yaml --role worker-a

It speaks the small part of MCP that tools need (initialize, tools/list,
tools/call, ping) with the standard library only. Tool calls run on worker
threads so a long wait_for_messages never blocks pings or other calls.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .cards import SERVER_NAME, role_card
from . import presets
from .hub import BROADCAST, OUTCOMES, Hub, HubError, RoleSession
from .launch import stop_role, tab_opener
from .store import Lock, Message
from .team import HARNESSES, TeamError

FALLBACK_PROTOCOL = "2025-06-18"
DEFAULT_WAIT = 1800  # seconds; launchers raise each harness's tool timeout above this
HEARTBEAT = 10  # seconds between presence check-ins; the hub counts a role as running for 30


def _fmt_message(m: Message) -> str:
    reply = f" (reply to #{m.reply_to})" if m.reply_to else ""
    return f"#{m.id} [{m.kind}] from {m.sender} to {m.recipient}{reply}:\n{m.text}"


def _fmt_messages(messages: list[Message], empty: str) -> str:
    return "\n\n".join(_fmt_message(m) for m in messages) if messages else empty


def _fmt_lock(lock: Lock) -> str:
    return f"{lock.path} (held by {lock.owner}" + (f", {lock.reason}" if lock.reason else "") + ")"


class Tools:
    """The tool catalogue, bound to one role."""

    def __init__(self, me: RoleSession):
        self.me = me
        self.specs: list[dict[str, Any]] = []
        self.handlers: dict[str, Callable[[dict[str, Any]], str]] = {}
        text = {"type": "string"}
        reply = {"type": "integer", "description": "id of the message you are answering"}

        self._add("my_role", "Show your role, duties, superior, team and the rules you work under.",
                  {}, [], lambda a: role_card(me) + self.reference())
        self._add("team_status", "The whole team: who reports to whom, what each does, who is running.",
                  {}, [], lambda a: self._team_status())
        self._add("send_message",
                  "Message your superior, a peer (same superior) or anyone below you, or answer anyone who "
                  "wrote to you (reply_to). to='@team': your direct subordinates; '@all': everyone below you. "
                  "Every message wakes its receiver: send only what they need.",
                  {"to": text, "text": text, "reply_to": reply,
                   "urgent": {"type": "boolean", "description": "going down only: interrupts their work"}},
                  ["to", "text"], self._send)
        self._add("list_tasks", "Your tasks, and the unfinished tasks you gave (those to review too).",
                  {}, [], lambda a: self._list_tasks())
        self._add("finish_task",
                  "Close your task. outcome: 'done' (it meets its 'done when': say what you did and where), "
                  "'blocked' (say what you need), 'failed' (why) or 'rejected' (not yours to do: why). Its "
                  "assigner is told. 'done' is refused until the team's checks pass. Closing your last task "
                  "releases your files.",
                  {"task_id": {"type": "integer"}, "result": text,
                   "outcome": {"type": "string", "enum": list(OUTCOMES)}},
                  ["task_id", "result"], self._finish)
        self._add("task_details", "A task and its whole conversation.",
                  {"task_id": {"type": "integer"}}, ["task_id"], self._details)
        self._add("search_messages", "Search the messages you may read.",
                  {"words": text}, ["words"],
                  lambda a: _fmt_messages(me.search(a["words"]), "Nothing found."))
        self._add("save_notes",
                  "Replace your notes: what you know, decided and are doing. A new session of yours starts "
                  "from them.",
                  {"text": text}, ["text"], lambda a: (me.save_notes(a["text"]), "Notes saved.")[1])
        self._add("ask_help", "Ask your direct superior for help.",
                  {"question": text, "reply_to": reply}, ["question"],
                  lambda a: "Sent " + _fmt_message(me.ask_help(a["question"], a.get("reply_to"))))
        self._add("read_inbox", "Your new messages (each returned once).", {}, [],
                  lambda a: _fmt_messages(me.read_inbox(), "No new messages."))
        self._add("wait_for_messages",
                  "Wait for your next message and return it - while you wait for results (no cost meanwhile).",
                  {"timeout_seconds": {"type": "integer", "description": f"default {DEFAULT_WAIT}"}}, [],
                  self._wait)
        self._add("set_status", "Say what you are doing, if it is more than your task (the hub sets that by "
                  "itself when you read a task and when you finish it).",
                  {"state": {"type": "string", "enum": ["idle", "working", "waiting", "blocked", "done"]},
                   "task": text}, ["state"],
                  lambda a: self._status(a))
        self._add("view", "A role's status and files; its messages too if it is you or below you.",
                  {"role": text}, ["role"], self._view)
        self._add("claim_file",
                  "Reserve a file, or a folder pattern like src/api/*, before editing (editing a free file in "
                  "your scope takes it anyway). A lease ends after an hour idle.",
                  {"path": {"type": "string", "description": "relative to the project folder"},
                   "reason": {"type": "string", "description": "e.g. task #12"}},
                  ["path"], self._claim)
        self._add("release_file", "Release a lease held by you or someone below you (path as claimed).",
                  {"path": text}, ["path"], lambda a: "Released " + me.release(a["path"]).path)
        self._add("list_locks", "Who is writing which files.", {}, [],
                  lambda a: "\n".join(_fmt_lock(x) for x in me.store.locks()) or "No files are locked.")
        self._add("hand_over_file",
                  "Give a file you hold to your superior or a direct subordinate (e.g. your consultant).",
                  {"path": text, "to": text}, ["path", "to"],
                  lambda a: "Handed over " + _fmt_lock(me.hand_over(a["path"], a["to"])))

        team = me.team
        role = team.roles.get(me.name)
        if role is not None and role.is_consultant:
            return  # consultants neither assign work, summon nor dismiss
        if any(not team.roles[s].is_consultant for s in team.subordinates_of(me.name)):
            self._add("assign_task",
                      "Give someone below you one clear, self-contained task. They finish_task it; you "
                      "review_task the result.",
                      {"to": text, "title": {"type": "string", "description": "one line"},
                       "details": {"type": "string", "description": "all they need to do it"},
                       "done_when": {"type": "string", "description": "how anyone can check it, e.g. 'pytest passes'"},
                       "after": {"type": "array", "items": {"type": "integer"},
                                 "description": "task ids to wait for"},
                       "priority": {"type": "integer", "enum": [1, 2, 3], "description": "1 urgent, 2 normal, 3 low"},
                       "part_of": {"type": "integer", "description": "your own task this is a piece of"}},
                      ["to", "title"], self._assign)
            self._add("review_task",
                      "Accept a done task you gave, or send it back with specific feedback.",
                      {"task_id": {"type": "integer"}, "accept": {"type": "boolean"}, "feedback": text},
                      ["task_id", "accept"], self._review)
            self._add("cancel_task", "Withdraw a task you gave (or one below you).",
                      {"task_id": {"type": "integer"}, "reason": text}, ["task_id"], self._cancel)
            self._add("reassign_task",
                      "Move an unfinished task below you to another agent below you (say its assignee is out "
                      "of usage: prefer another program). Its leases and history go with it.",
                      {"task_id": {"type": "integer"}, "to": text,
                       "reason": {"type": "string", "description": "the new assignee reads it"}},
                      ["task_id", "to"], self._reassign)
        if team.settings.team_changes and (team.subordinates_of(me.name) or me.name == team.leader):
            role_props = {"duties": text, "model": {"type": "string", "description": "e.g. sonnet, gpt-6-luna, "
                          "gemini-3.8-flash-medium; empty: the program's default"},
                          "effort": text, "write_scope": {"type": "array", "items": {"type": "string"},
                          "description": "files it may write, e.g. [\"src/*\"]; [] for none"}}
            self._add("hire_agent",
                      "Add an agent under you (or below you); it starts at once. Pick the cheapest program and "
                      "model that can do the work: every agent uses the owner's subscriptions.",
                      {"name": text, "harness": {"type": "string", "enum": list(HARNESSES)},
                       "superior": {"type": "string", "description": "default: you"},
                       "preset": {"type": "string", "enum": presets.names(), "description": "a role from the "
                                  "owner's library to start from; what else you give overrides it"},
                       "instructions": {"type": "string", "description": "how it should work"},
                       **role_props}, ["name"],
                      lambda a: self._hired(me.hire(a["name"], a.get("harness") or "", a.get("duties") or "",
                                                    a.get("model") or "", a.get("effort") or "",
                                                    a.get("write_scope"), a.get("superior") or "",
                                                    a.get("preset") or "", a.get("instructions") or "")))
            self._add("change_agent",
                      "Change an agent below you: duties, files, model or effort (from its next start), or "
                      "its superior.",
                      {"name": text, "superior": text, **role_props}, ["name"],
                      lambda a: f"Changed {me.change_role(a['name'], a.get('duties'), a.get('model'), a.get('effort'), a.get('write_scope'), a.get('superior')).name}.")
            self._add("let_go_agent",
                      "Remove an agent below you whose work is over (move or cancel its tasks first). Its "
                      "subordinates move up.",
                      {"name": text, "reason": text}, ["name"],
                      lambda a: "Let go of {}.{}".format(a["name"], (lambda moved: f" {', '.join(moved)} now report "
                                                                     "to its superior." if moved else "")(
                          me.let_go(a["name"], a.get("reason") or ""))))
        if team.can_summon(me.name):
            tiers = "; ".join(f"{t.describe()}: {t.use_for}" if t.use_for else t.describe()
                              for t in team.tiers.values())
            self._add("summon_consultant",
                      "When a subordinate's help request is too hard for it, attach a temporary consultant "
                      f"under that subordinate. Pick the cheapest tier that can solve it. Tiers: {tiers}",
                      {"help_id": {"type": "integer", "description": "id of the help request you received"},
                       "tier": {"type": "string", "enum": list(team.tiers)},
                       "brief": {"type": "string", "description": "your notes for the consultant"}},
                      ["help_id", "tier"], self._summon)
        if me.hub.branches:
            self._add("share_work",
                      "Put your work so far into main now, without finishing a task - for something others "
                      "need before you are done (an interface, a plan, shared types). The hub merges the "
                      "latest main into your copy, runs the checks, and lands your work.",
                      {"summary": {"type": "string", "description": "what you are sharing, in one line"}},
                      ["summary"], lambda a: f"Shared: your work is in main as {me.share_work(a['summary'])}.")
        if team.tiers:  # no tiers: there will never be a consultant to dismiss
            self._add("dismiss_consultant",
                      "Dismiss a consultant working for you (or below you) once its problem is solved; its "
                      "files go back to the agent it helped.",
                      {"name": text}, ["name"], self._dismiss)

    def reference(self) -> str:
        """For a program that keeps tool descriptions out of the model's sight (Antigravity writes them
        to files it must open, one by one): every tool with its arguments, so it can call them at once."""
        role = self.me.hub.team.roles.get(self.me.name)
        if role is None or role.harness != "antigravity":
            return ""
        lines = ["", f"YOUR TEAM TOOLS (call_mcp_tool, ServerName \"agent-org_{SERVER_NAME}\"; '?' marks an "
                     "optional argument; no need to open their files):"]
        for spec in self.specs:
            schema = spec["inputSchema"]
            args = [a if a in schema.get("required", []) else f"{a}?" for a in schema["properties"]]
            lines.append(f"- {spec['name']}({', '.join(args)})")
        return "\n".join(lines)

    def _props(self, name: str) -> list[str]:
        spec = next((s for s in self.specs if s["name"] == name), None)
        return list(spec["inputSchema"]["properties"]) if spec else []

    def _fit_args(self, name: str, args: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        """The arguments under the names the tool knows: a common other name (description for details,
        message for text...) is taken as the one it stands for. Returns them, and the ones left unknown."""
        props = self._props(name)
        fitted, unknown = {}, []
        for key, value in args.items():
            if key in props:
                fitted[key] = value
                continue
            meant = next((p for p in ARG_ALIASES.get(key, ()) if p in props and p not in args), None)
            if meant is not None:
                fitted[meant] = value
            else:
                unknown.append(key)
        types = self._types(name)
        for key, value in fitted.items():  # 4 for "4" and "4" for 4: no call refused (and redone) for it
            want = types.get(key)
            if want == "string" and isinstance(value, (int, float)) and not isinstance(value, bool):
                fitted[key] = str(value)
            elif want == "integer" and isinstance(value, str) and value.strip().lstrip("#").isdigit():
                fitted[key] = int(value.strip().lstrip("#"))
        return fitted, unknown

    def _types(self, name: str) -> dict[str, str]:
        spec = next((s for s in self.specs if s["name"] == name), None)
        props = spec["inputSchema"]["properties"] if spec else {}
        return {k: v.get("type", "") for k, v in props.items() if isinstance(v, dict)}

    def _add(self, name: str, description: str, props: dict[str, Any], required: list[str],
             handler: Callable[[dict[str, Any]], str]) -> None:
        self.specs.append({
            "name": name,
            "description": description,
            "inputSchema": {"type": "object", "properties": props, "required": required},
        })
        self.handlers[name] = handler

    def _wait(self, args: dict[str, Any], cancelled: threading.Event | None = None) -> str:
        timeout = max(1, int(args.get("timeout_seconds") or DEFAULT_WAIT))
        before = self.me.store.get_status(self.me.name)
        self.me.set_status("waiting", before.task if before else "")
        messages = self.me.wait_for_messages(timeout, stop=cancelled)
        if messages:
            self.me.set_status("working", "")
        return _fmt_messages(messages, f"No messages in {timeout} seconds. Call wait_for_messages again.")

    def _summon(self, args: dict[str, Any]) -> str:
        role = self.me.summon_consultant(int(args["help_id"]), args["tier"], args.get("brief") or "")
        return (f"Summoned {role.name} ({role.tier}, {role.harness}) under {role.superior}. "
                f"It has the request and your brief, and {role.superior} has been told.")

    def _dismiss(self, args: dict[str, Any]) -> str:
        role, returned = self.me.dismiss_consultant(args["name"])
        back = f" Files returned to {role.superior}: {', '.join(returned)}." if returned else ""
        return f"Dismissed {role.name}.{back}"

    def _status(self, args: dict[str, Any]) -> str:
        s = self.me.set_status(args["state"], args.get("task") or "")
        return f"Status: {s.state}" + (f" - {s.task}" if s.task else "")

    def _send(self, args: dict[str, Any]) -> str:
        to, urgent = args["to"], bool(args.get("urgent"))
        if to in BROADCAST:
            sent = self.me.broadcast(to, args["text"], urgent)
            return f"Sent to {', '.join(m.recipient for m in sent)}."
        m = self.me.send(to, args["text"], args.get("reply_to"), urgent)
        text = f"Sent #{m.id} ({m.kind}) to {m.recipient}."
        if not self.me.store.online().get(m.recipient) and m.recipient != self.me.team.owner:
            text += f" {m.recipient} is not running right now; it will get this when it starts."
        return text

    def _assign(self, args: dict[str, Any]) -> str:
        task = self.me.assign_task(args["to"], args["title"], args.get("details") or "", args.get("part_of"),
                                   args.get("done_when") or "", args.get("after") or [],
                                   int(args.get("priority") or 2))
        start = (f"It starts when #{', #'.join(map(str, task.depends_on))} are done." if task.state == "waiting"
                 else "They have it now.")
        hint = "" if task.done_when else " (Tip: give tasks a done_when, so the result can be checked.)"
        return f"Assigned task #{task.id} to {task.assignee}: {task.title}. {start}{hint}"

    def _review(self, args: dict[str, Any]) -> str:
        task = self.me.review_task(int(args["task_id"]), bool(args["accept"]), args.get("feedback") or "")
        return (f"Task #{task.id} accepted." if task.state == "accepted"
                else f"Task #{task.id} sent back to {task.assignee} (round {task.revisions}).")

    def _details(self, args: dict[str, Any]) -> str:
        task, thread = self.me.task_details(int(args["task_id"]))
        lines = [f"Task #{task.id} [{task.state}] {task.assigner} -> {task.assignee}: {task.title}"]
        if task.depends_on:
            lines.append(f"after: #{', #'.join(map(str, task.depends_on))}")
        if task.done_when:
            lines.append(f"done when: {task.done_when}")
        if task.details:
            lines += ["", task.details]
        if task.result:
            lines += ["", f"result: {task.result}"]
        lines += ["", "Thread:", _fmt_messages(thread, "(no messages)")]
        return "\n".join(lines)

    def _finish(self, args: dict[str, Any]) -> str:
        task = self.me.finish_task(int(args["task_id"]), args["result"], args.get("outcome") or "done")
        told = "the owner" if task.assigner == self.me.team.owner else task.assigner  # the owner may be called "you"
        freed = f" Your files are released ({', '.join(self.me.released)})." if self.me.released else ""
        return f"Task #{task.id} is {task.state}; {told} has been told.{freed}"

    def _cancel(self, args: dict[str, Any]) -> str:
        task = self.me.cancel_task(int(args["task_id"]), args.get("reason") or "")
        return f"Task #{task.id} is cancelled; {task.assignee} has been told."

    def _claim(self, args: dict[str, Any]) -> str:
        lock = self.me.claim(args["path"], args.get("reason") or "")
        return f"You now hold {lock.path}" + (f" ({lock.reason})" if lock.reason else "") + "."

    def _hired(self, role: Any) -> str:
        return (f"Hired {role.name} ({role.harness}{', ' + role.model if role.model else ''}), reporting to "
                f"{role.superior}. Its tab is opening; give it work with assign_task.")

    def _reassign(self, args: dict[str, Any]) -> str:
        task = self.me.reassign_task(int(args["task_id"]), args["to"], args.get("reason") or "")
        return f"Task #{task.id} is now {task.assignee}'s ({task.state}); both have been told."

    def _list_tasks(self) -> str:
        mine, queued, given = self.me.my_tasks(), self.me.queued_tasks(), self.me.given_tasks()
        lines = ["Your tasks:" if mine else "You have no tasks to do."]
        lines += [f"  #{t.id} [{t.state}] from {t.assigner}: {t.title}"
                  + (f" (done when: {t.done_when})" if t.done_when else "") for t in mine]
        if queued:
            lines.append("Queued for you (they start when what they wait for is done):")
            lines += [f"  #{t.id} after #{', #'.join(map(str, t.depends_on))}: {t.title}" for t in queued]
        if given:
            lines.append("Tasks you gave that are not finished:")
            lines += [f"  #{t.id} [{'waits for your review' if t.state == 'done' else t.state}] to "
                      f"{t.assignee}: {t.title}" + (f" -- {t.result[:200]}" if t.state == "blocked" else "")
                      for t in given]
        return "\n".join(lines)

    def _team_status(self) -> str:
        lines = [f"{self.me.team.owner} (owner)"]
        for row in self.me.overview():
            s = row.status
            state = f"{s.state}" + (f" - {s.task}" if s.task else "") if s else "not started"
            running = "" if row.online else ", not running"
            temp = f", consultant ({row.role.tier})" if row.role.is_consultant else ""
            files = f", writing {row.locks} file(s)" if row.locks else ""
            stuck = f" -- {row.stuck.upper()}" if row.stuck else ""
            me = "  <- you" if row.name == self.me.name else ""
            indent = "  " * (row.depth + 1)
            lines.append(f"{indent}{row.name} [{row.role.harness}{temp}{running}]: {state}{files}{stuck}{me}")
            lines += [f"{indent}    task #{t.id} [{t.state}] from {t.assigner}: {t.title}" for t in row.tasks]
        return "\n".join(lines)

    def _view(self, args: dict[str, Any]) -> str:
        v = self.me.view(args["role"])
        lines = [f"{v.name}: superior {v.superior or '-'}, subordinates {', '.join(v.subordinates) or '-'}",
                 "running" if v.online else "not running"]
        if v.status:
            lines.append(f"status: {v.status.state}" + (f" - {v.status.task}" if v.status.task else ""))
        lines.append(f"locks: {', '.join(x.path for x in v.locks) or '-'}")
        if v.limited:
            lines.append("(Its messages are visible only to itself and the roles above it.)")
        else:
            lines.append(f"unread messages: {v.unread}")
            if v.recent:
                lines.append("recent messages:")
                lines.append(_fmt_messages(v.recent, ""))
        return "\n".join(lines)

    def _mail_notice(self) -> str:
        """A line about messages that arrived since the agent was last told, if any."""
        try:
            new = self.me.store.unnoticed(self.me.name)
        except HubError:
            return ""
        if not new:
            return ""
        senders = ", ".join(dict.fromkeys(m.sender for m in new))
        return (f"\n\n[agent-org] {len(new)} new message(s) for you from {senders} "
                f"({', '.join(f'#{m.id}' for m in new)}). Read them with read_inbox.")

    def call(self, name: str, args: dict[str, Any],
             cancelled: threading.Event | None = None) -> tuple[str, bool]:
        handler = self.handlers.get(name)
        if handler is None:
            return f"Unknown tool: {name}", True
        if name == "wait_for_messages":  # the one tool that must notice the caller giving up
            handler = lambda a: self._wait(a, cancelled)  # noqa: E731
        args, unknown = self._fit_args(name, args if isinstance(args, dict) else {})
        if unknown:  # an argument it has no use for would be dropped without a word: say so instead
            takes = ", ".join(self._props(name)) or "no arguments"
            return f"Unknown argument {', '.join(unknown)} for {name}. It takes: {takes}.", True
        try:
            text, is_error = handler(args), False
        except KeyError as e:
            text, is_error = f"Missing argument: {e.args[0]}", True
        except (ValueError, TypeError) as e:
            text, is_error = f"Bad argument: {e}", True
        except HubError as e:
            text, is_error = f"Refused: {e}", True
        if name not in ("read_inbox", "wait_for_messages"):
            text += self._mail_notice()
        return text, is_error


# Names models reach for instead of a tool's own (seen: assign_task(description=...) lost the details).
ARG_ALIASES = {
    "description": ("details", "summary", "text"), "body": ("text", "details"), "content": ("text", "details"),
    "message": ("text",), "msg": ("text",), "instructions": ("details",), "task": ("title", "task_id"),
    "recipient": ("to",), "assignee": ("to",), "role": ("to", "name"), "id": ("task_id",), "task_number": ("task_id",),
    "summary": ("result", "text"), "status": ("state", "outcome"), "comment": ("feedback", "reason"),
    "acceptance": ("done_when",), "acceptance_criteria": ("done_when",), "done_criteria": ("done_when",),
    "file": ("path",), "file_path": ("path",),
}

CARD_IN_SYSTEM_PROMPT = ("claude", "codex", "grok")  # launch gives these the role card as system prompt
SHORT_INSTRUCTIONS = ("These are your agent-org team tools. Your role card - who you are, your team and the "
                      "message law - is in your system prompt; call my_role if you need it again.")


def server_instructions(me) -> str:
    """What the server tells a program at the start (Claude Code adds it to the system prompt). A
    program that has the role card as its system prompt gets a pointer, not the card a second time."""
    role = me.hub.team.roles.get(me.name)
    if role is not None and role.harness in CARD_IN_SYSTEM_PROMPT:
        return SHORT_INSTRUCTIONS
    return role_card(me) + Tools(me).reference()


class Server:
    """JSON-RPC over stdio: one JSON message per line in, one per line out."""

    def __init__(self, me: RoleSession, stdin=None, stdout=None):
        self.me = me
        self.tools = Tools(me)
        self.stdin = stdin or sys.stdin
        self.stdout = stdout or sys.stdout
        self._write_lock = threading.Lock()
        self._in_flight: dict[Any, threading.Event] = {}
        self._waits: set[Any] = set()

    def serve(self) -> None:
        for line in self.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                self._send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
                continue
            for item in msg if isinstance(msg, list) else [msg]:
                self._dispatch(item)
        # The harness closed stdin: stop open waits (leaving their messages unread)
        # and let other running calls finish.
        for msg_id in list(self._waits):
            if (cancelled := self._in_flight.get(msg_id)) is not None:
                cancelled.set()
        for thread in threading.enumerate():
            if thread.name.startswith("tool-call-"):
                thread.join(timeout=5)

    def _dispatch(self, msg: dict[str, Any]) -> None:
        method, msg_id = msg.get("method"), msg.get("id")
        params = msg.get("params") or {}
        if method == "notifications/cancelled":
            cancelled = self._in_flight.get(params.get("requestId"))
            if cancelled is not None:
                cancelled.set()
            return
        if method is None or msg_id is None:
            return  # another notification, or a response; nothing to answer
        if method == "initialize":
            requested = params.get("protocolVersion")
            self._reply(msg_id, {
                "protocolVersion": requested if isinstance(requested, str) else FALLBACK_PROTOCOL,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "agent-org", "version": "0.2.0"},
                "instructions": server_instructions(self.me),
            })
        elif method == "ping":
            self._reply(msg_id, {})
        elif method == "tools/list":
            self._reply(msg_id, {"tools": self.tools.specs})
        elif method == "tools/call":
            cancelled = self._in_flight[msg_id] = threading.Event()
            if params.get("name") == "wait_for_messages":
                self._waits.add(msg_id)
            threading.Thread(target=self._call, args=(msg_id, params, cancelled),
                             name=f"tool-call-{msg_id}", daemon=True).start()
        else:
            self._send({"jsonrpc": "2.0", "id": msg_id,
                        "error": {"code": -32601, "message": f"method not found: {method}"}})

    def _call(self, msg_id: Any, params: dict[str, Any], cancelled: threading.Event) -> None:
        try:
            text, is_error = self.tools.call(
                params.get("name", ""), params.get("arguments") or {}, cancelled
            )
        except Exception:
            text, is_error = "Internal error:\n" + traceback.format_exc(), True
        finally:
            self._in_flight.pop(msg_id, None)
            self._waits.discard(msg_id)
        if not cancelled.is_set():  # MCP: no response to a cancelled request
            self._reply(msg_id, {"content": [{"type": "text", "text": text}], "isError": is_error})

    def _reply(self, msg_id: Any, result: dict[str, Any]) -> None:
        self._send({"jsonrpc": "2.0", "id": msg_id, "result": result})

    def _send(self, msg: dict[str, Any]) -> None:
        with self._write_lock:
            self.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
            self.stdout.flush()


def serve_idle(stdin, stdout) -> None:
    """A tool-less MCP server for sessions that are not part of an agent-org team."""
    for line in stdin:
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(msg, dict) or msg.get("id") is None:
            continue
        method = msg.get("method")
        if method == "initialize":
            requested = (msg.get("params") or {}).get("protocolVersion")
            result: dict[str, Any] = {
                "protocolVersion": requested if isinstance(requested, str) else FALLBACK_PROTOCOL,
                "capabilities": {"tools": {}}, "serverInfo": {"name": "agent-org", "version": "0.2.0"},
                "instructions": "This session is not part of an agent-org team, so the org tools are off."}
        elif method == "tools/list":
            result = {"tools": []}
        elif method == "ping":
            result = {}
        else:
            stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"],
                                     "error": {"code": -32601, "message": f"method not found: {method}"}}) + "\n")
            stdout.flush()
            continue
        stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
        stdout.flush()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="agent-org MCP server for one role")
    # Harnesses whose MCP config is shared by every session in a folder (Grok) start the
    # server without arguments; it then takes the role from the start script's environment.
    parser.add_argument("--team", default=os.environ.get("AGENT_ORG_TEAM"))
    parser.add_argument("--role", default=os.environ.get("AGENT_ORG_ROLE"))
    args = parser.parse_args(argv)
    # stdio carries UTF-8 JSON no matter what the Windows code page is
    sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[union-attr]
    if not args.team or not args.role:
        # Started by a harness outside an agent-org tab (a project-wide config such as
        # Antigravity's plugin): offer no tools rather than fail loudly.
        serve_idle(sys.stdin, sys.stdout)
        return 0
    try:
        hub = Hub.open(args.team, opener=tab_opener(Path(args.team).resolve()))
        hub.stopper = lambda role: stop_role(hub, role)
        me = hub.session(args.role)
    except (TeamError, HubError) as e:
        print(f"agent-org: {e}", file=sys.stderr)
        return 2
    # Check in while this session lives, so the team and the UI can see who is running.
    pid, done = os.getpid(), threading.Event()
    hub.store.check_in(pid, args.role, os.getppid())

    def heartbeat() -> None:
        while not done.wait(HEARTBEAT):
            try:
                hub.store.check_in(pid, args.role)
            except Exception:  # noqa: BLE001 - a busy database must not kill the session
                pass

    threading.Thread(target=heartbeat, name="heartbeat", daemon=True).start()
    try:
        Server(me).serve()
    finally:
        done.set()
        hub.store.check_out(pid)
        hub.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
