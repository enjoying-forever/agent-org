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
import sys
import threading
import traceback
from collections.abc import Callable
from typing import Any

from .hub import Hub, HubError, RoleSession
from .store import Lock, Message
from .team import TeamError

SERVER_NAME = "org"
FALLBACK_PROTOCOL = "2025-06-18"
DEFAULT_WAIT = 1800  # seconds; launchers raise each harness's tool timeout above this


def role_card(me: RoleSession) -> str:
    """Everything an agent needs to know about its place in the team."""
    team = me.team
    lines = [f"You are '{me.name}' in an agent team run by {team.owner} (the owner)."]
    role = team.roles.get(me.name)
    if role and role.duties:
        lines.append(f"Your duties: {role.duties}")
    lines.append(f"Your superior: {me.superior}")
    subs = team.subordinates_of(me.name)
    lines.append(f"Your direct subordinates: {', '.join(subs) or 'none'}")
    below = team.subtree_of(me.name)
    if len(below) > len(subs):
        lines.append(f"Everyone below you: {', '.join(below)}")
    if subs:
        lines.append("Their duties:")
        for name in below:
            r = team.roles[name]
            lines.append(f"  - {name} ({r.harness}, reports to {r.superior}): {r.duties or '-'}")
    scope = ", ".join(role.write_scope) if role else "everything"
    lines.append(f"Files you may write (after claim_file): {scope or 'none - you do not edit files'}")
    lines += [
        "",
        "Rules:",
        f"- Talk to the team only through the '{SERVER_NAME}' tools.",
        f"- Report and ask for help only to your direct superior ({me.superior}). "
        "You cannot skip levels or message siblings.",
        "- You may instruct and view anyone below you. Give clear, self-contained tasks.",
        "- Before editing any file, claim_file it. If someone else holds it, do not edit it: "
        "ask your superior. release_file when you are done with it.",
        "- Keep your status current with set_status.",
        "- When you finish a task, report the result to your superior.",
        "- When you have nothing to do, call wait_for_messages and act on what arrives. "
        "If it returns nothing, call it again.",
        "- If you lose track of your role, call my_role.",
    ]
    return "\n".join(lines)


def _fmt_message(m: Message) -> str:
    reply = f" (reply to #{m.reply_to})" if m.reply_to else ""
    return f"#{m.id} [{m.kind}] from {m.sender} to {m.recipient}{reply}:\n{m.text}"


def _fmt_messages(messages: list[Message], empty: str) -> str:
    return "\n\n".join(_fmt_message(m) for m in messages) if messages else empty


def _fmt_lock(lock: Lock) -> str:
    return f"{lock.path} (held by {lock.owner})"


class Tools:
    """The tool catalogue, bound to one role."""

    def __init__(self, me: RoleSession):
        self.me = me
        self.specs: list[dict[str, Any]] = []
        self.handlers: dict[str, Callable[[dict[str, Any]], str]] = {}
        text = {"type": "string"}
        reply = {"type": "integer", "description": "id of the message you are answering"}

        self._add("my_role", "Show your role, duties, superior, team and the rules you work under.",
                  {}, [], lambda a: role_card(me))
        self._add("send_message",
                  "Send a message to your direct superior (a report) or to anyone below you (an instruction).",
                  {"to": text, "text": text, "reply_to": reply}, ["to", "text"],
                  lambda a: "Sent " + _fmt_message(me.send(a["to"], a["text"], a.get("reply_to"))))
        self._add("ask_help", "Ask your direct superior for help.",
                  {"question": text, "reply_to": reply}, ["question"],
                  lambda a: "Sent " + _fmt_message(me.ask_help(a["question"], a.get("reply_to"))))
        self._add("read_inbox", "Read your new messages (each is returned once).", {}, [],
                  lambda a: _fmt_messages(me.read_inbox(), "No new messages."))
        self._add("wait_for_messages",
                  "Wait until a message arrives for you, then return it. Call this whenever you are idle.",
                  {"timeout_seconds": {"type": "integer", "description": f"default {DEFAULT_WAIT}"}}, [],
                  self._wait)
        self._add("set_status", "Tell your superiors what you are doing.",
                  {"state": {"type": "string", "enum": ["idle", "working", "waiting", "blocked", "done"]},
                   "task": text}, ["state"],
                  lambda a: self._status(a))
        self._add("view", "Look at yourself or a role below you: status, locks and recent messages.",
                  {"role": text}, ["role"], self._view)
        self._add("claim_file", "Take the write lock on a file before editing it. One writer per file.",
                  {"path": {"type": "string", "description": "path relative to the project folder"}},
                  ["path"], lambda a: "You now hold " + _fmt_lock(me.claim(a["path"])))
        self._add("release_file", "Release a write lock you (or someone below you) hold.",
                  {"path": text}, ["path"], lambda a: "Released " + me.release(a["path"]).path)
        self._add("list_locks", "List every file that is currently being written, and by whom.", {}, [],
                  lambda a: "\n".join(_fmt_lock(x) for x in me.store.locks()) or "No files are locked.")

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
        self.me.set_status("waiting", "")
        messages = self.me.wait_for_messages(timeout, stop=cancelled)
        self.me.set_status("working" if messages else "idle", "")
        return _fmt_messages(messages, f"No messages in {timeout} seconds. Call wait_for_messages again.")

    def _status(self, args: dict[str, Any]) -> str:
        s = self.me.set_status(args["state"], args.get("task") or "")
        return f"Status: {s.state}" + (f" - {s.task}" if s.task else "")

    def _view(self, args: dict[str, Any]) -> str:
        v = self.me.view(args["role"])
        lines = [f"{v.name}: superior {v.superior or '-'}, subordinates {', '.join(v.subordinates) or '-'}"]
        if v.status:
            lines.append(f"status: {v.status.state}" + (f" - {v.status.task}" if v.status.task else ""))
        lines.append(f"unread messages: {v.unread}")
        lines.append(f"locks: {', '.join(x.path for x in v.locks) or '-'}")
        if v.recent:
            lines.append("recent messages:")
            lines.append(_fmt_messages(v.recent, ""))
        return "\n".join(lines)

    def call(self, name: str, args: dict[str, Any],
             cancelled: threading.Event | None = None) -> tuple[str, bool]:
        handler = self.handlers.get(name)
        if handler is None:
            return f"Unknown tool: {name}", True
        if name == "wait_for_messages":  # the one tool that must notice the caller giving up
            handler = lambda a: self._wait(a, cancelled)  # noqa: E731
        try:
            return handler(args), False
        except KeyError as e:
            return f"Missing argument: {e.args[0]}", True
        except HubError as e:
            return f"Refused: {e}", True


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
                "instructions": role_card(self.me),
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="agent-org MCP server for one role")
    parser.add_argument("--team", required=True)
    parser.add_argument("--role", required=True)
    args = parser.parse_args(argv)
    # stdio carries UTF-8 JSON no matter what the Windows code page is
    sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[union-attr]
    try:
        hub = Hub.open(args.team)
        me = hub.session(args.role)
    except (TeamError, HubError) as e:
        print(f"agent-org: {e}", file=sys.stderr)
        return 2
    try:
        Server(me).serve()
    finally:
        hub.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
