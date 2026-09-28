"""Hooks that bring the hub into an agent's own harness.

Harnesses run these at fixed moments, passing the event as JSON on stdin. The role
comes from AGENT_ORG_TEAM / AGENT_ORG_ROLE, which every start script sets; outside an
agent-org tab each hook does nothing. Any failure lets the harness carry on.

- stop       The agent is ending its turn. Once per turn, remind it of unfinished
             duties (reporting to its superior, releasing its files). Then wait for new
             messages and hand them over, so an idle agent wakes up when mail arrives.
- post-tool  After each tool call: mention messages that arrived meanwhile, once each.
- pre-edit   Before a file edit: the agent must hold the file's lock. A free file in
             its write scope is claimed for it; anything else is refused with the reason.

    python org_hook.py stop < event.json
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from .hub import Hub, HubError, RoleSession
from .store import Message

STOP_WAIT = 1800  # seconds a Stop hook waits for messages before letting the agent go round again
EDIT_TOOLS = {"edit", "write", "multiedit", "notebookedit", "apply_patch", "search_replace",
              "write_file", "edit_file", "create_file", "str_replace_editor"}
PATH_KEYS = ("file_path", "path", "notebook_path", "target_file", "filePath", "targetFile", "notebookPath")
PATCH_FILE = re.compile(r"^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$", re.M)
HUB_DIR = ".agent-org"


def field(payload: dict[str, Any], key: str) -> Any:
    """Claude and Codex send snake_case fields; Grok sends camelCase."""
    if key in payload:
        return payload[key]
    head, *rest = key.split("_")
    return payload.get(head + "".join(part.title() for part in rest))


def fmt_messages(messages: list[Message]) -> str:
    return "\n\n".join(
        f"#{m.id} [{m.kind}] from {m.sender}" + (f" (reply to #{m.reply_to})" if m.reply_to else "")
        + f":\n{m.text}" for m in messages)


def block(reason: str) -> dict[str, Any]:
    return {"decision": "block", "reason": reason}


# stop


def duties_left(me: RoleSession) -> list[str]:
    """What the message law still asks of an agent that is about to go quiet."""
    left = []
    for task in me.my_tasks():
        if task.state in ("open", "working"):
            check = f" Done when: {task.done_when}." if task.done_when else ""
            left.append(
                f"Task #{task.id} from {task.assigner} ({task.title}) is still open.{check} If it is "
                f"finished, call finish_task({task.id}, result). If you cannot go on, use outcome "
                "\"blocked\" and say what you need (or \"failed\" / \"rejected\" with the reason). If you "
                "are still working on it or waiting for your own subtasks, carry on.")
    for task in me.to_review():
        check = f" against its 'done when' ({task.done_when})" if task.done_when else ""
        left.append(
            f"Task #{task.id} you gave to {task.assignee} ({task.title}) is done and waits for your "
            f"review. Check it{check}, then review_task({task.id}, accept=true), or "
            f"review_task({task.id}, accept=false, feedback=...) to send it back.")
    for task in me.given_tasks():
        if task.state == "blocked":
            left.append(
                f"Task #{task.id} you gave to {task.assignee} ({task.title}) is blocked: "
                f"{task.result[:300]}. Help them, reassign it, or cancel_task({task.id}).")
    for request in me.unanswered_help():
        left.append(
            f"{request.sender} asked you for help (#{request.id}) and has no answer yet. Answer with "
            f"send_message(to=\"{request.sender}\", reply_to={request.id}), pass it up with "
            f"ask_help(..., reply_to={request.id}), or summon a consultant.")
    superior = me.superior
    last_word = me.store.last_message(sender=superior, recipient=me.name, kinds=("instruction", "reply"))
    if superior and last_word:
        answered = me.store.last_message(sender=me.name, recipient=superior)
        if answered is None or answered.id < last_word.id:
            left.append(
                f"{superior}'s message #{last_word.id} has no answer from you. If it needs one, "
                f"send it with send_message(to=\"{superior}\", reply_to={last_word.id}): "
                f"{superior} only receives what you send, not what you write here.")
    held = [lock.path for lock in me.store.locks(me.name)]
    if held:
        left.append(
            f"You still hold the write lock on {', '.join(held)}. release_file each file you are "
            "done with (or hand_over_file it), so others can work on it.")
    return left


def deliver(me: RoleSession, messages: list[Message]) -> dict[str, Any]:
    me.set_status("working", "")
    return block("agent-org: new messages for you. Act on them (the sender is waiting for your "
                 "reply), then end your turn; later messages are delivered the same way.\n\n"
                 + fmt_messages(messages))


def on_stop(me: RoleSession, payload: dict[str, Any], wait: float | None = None, poll: float = 1.0):
    # Mail first: an agent can't finish work it hasn't read yet.
    waiting = me.read_inbox()
    if waiting:
        return deliver(me, waiting)
    if not field(payload, "stop_hook_active"):
        left = duties_left(me)
        if left:
            return block("Before you finish:\n" + "\n".join(f"- {x}" for x in left)
                         + "\nWhen these are done (or don't apply), end your turn again.")
    before = me.store.get_status(me.name)
    me.set_status("waiting", before.task if before else "")
    messages = me.wait_for_messages(stop_wait() if wait is None else wait, poll)
    if not messages:
        return block("agent-org: no new messages yet. End your turn again to keep waiting; "
                     "you will be woken as soon as a message arrives.")
    return deliver(me, messages)


def stop_wait() -> float:
    try:
        return float(os.environ.get("AGENT_ORG_STOP_WAIT", STOP_WAIT))
    except ValueError:
        return STOP_WAIT


# post-tool


def on_post_tool(me: RoleSession, payload: dict[str, Any]):
    me.store.touch(me.name)  # progress, for the watchdog
    me.store.renew(me.name)  # an agent at work keeps its file leases
    new = me.store.unnoticed(me.name)
    if not new:
        return None
    urgent = [m for m in new if m.urgent]
    rest = [m for m in new if not m.urgent]
    parts = []
    if urgent:  # law 9: urgent messages interrupt the current work, in full
        me.store.mark_read([m.id for m in urgent])
        parts.append("agent-org: URGENT message(s) for you. Deal with them before you continue:\n\n"
                     + fmt_messages(urgent))
    if rest:
        senders = ", ".join(dict.fromkeys(m.sender for m in rest))
        parts.append(f"agent-org: {len(rest)} new message(s) for you from {senders} "
                     f"({', '.join(f'#{m.id}' for m in rest)}). Read them with the org tool "
                     "read_inbox at a good stopping point.")
    return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "\n\n".join(parts)}}


# pre-edit


def edited_paths(payload: dict[str, Any]) -> list[str]:
    tool = str(field(payload, "tool_name") or "")
    if tool.rsplit("__", 1)[-1].lower() not in EDIT_TOOLS:
        return []
    tool_input = field(payload, "tool_input") or {}
    if not isinstance(tool_input, dict):
        tool_input = {"input": tool_input}
    paths = [tool_input[k] for k in PATH_KEYS if isinstance(tool_input.get(k), str)]
    for value in tool_input.values():  # apply_patch carries its files inside the patch text
        if isinstance(value, str) and "*** " in value:
            paths += [a or b for a, b in PATCH_FILE.findall(value)]
    return [p.strip() for p in dict.fromkeys(paths) if p.strip()]


def deny(reason: str) -> dict[str, Any]:
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                   "permissionDecisionReason": reason}}


def on_pre_edit(me: RoleSession, payload: dict[str, Any]):
    root = me.hub.base_team.project_root
    cwd = Path(field(payload, "cwd") or root)
    claimed = []
    for raw in edited_paths(payload):
        full = (cwd / raw).resolve()
        try:
            rel = full.relative_to(root).as_posix()
        except ValueError:
            continue  # outside the project: not the team's business
        if rel == HUB_DIR or rel.startswith(HUB_DIR + "/"):
            return deny(f"{rel} belongs to the agent-org hub; use the org tools instead of editing it.")
        key, _ = me.hub.lock_key(full)
        lock = me.store.covering(key)
        if lock is not None and lock.owner == me.name:
            continue
        if lock is not None:
            why = f" for {lock.reason}" if lock.reason else ""
            covered = f" (its lease on {lock.path} covers it)" if lock.pattern else ""
            return deny(f"{rel} is being written by {lock.owner}{why}{covered}; only one agent may write a "
                        f"file. Do not edit it: ask {me.superior} (or {lock.owner} directly if they are your peer).")
        try:
            me.claim(full)
        except HubError as e:
            return deny(f"You may not edit {rel}: {e}")
        claimed.append(rel)
    if claimed:
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext":
                f"agent-org: you now hold the write lock on {', '.join(claimed)}; "
                "release_file it when you are done."}}
    return None


def remember_session(me: RoleSession, payload: dict[str, Any]) -> None:
    """Note which conversation the harness is in, so a restarted team can resume it."""
    session_id = field(payload, "session_id")
    role = me.hub.team.roles.get(me.name)
    if isinstance(session_id, str) and session_id and role is not None:
        me.store.record_session_id(me.name, role.harness, session_id)


def on_session(me: RoleSession, payload: dict[str, Any]):
    return None  # remember_session already did the work


HANDLERS = {"stop": on_stop, "post-tool": on_post_tool, "pre-edit": on_pre_edit, "session": on_session}


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    event = argv[0] if argv else ""
    team_file, role = os.environ.get("AGENT_ORG_TEAM"), os.environ.get("AGENT_ORG_ROLE")
    if event not in HANDLERS or not team_file or not role:
        return 0
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        payload = {}
    try:
        hub = Hub.open(team_file)
    except Exception:  # noqa: BLE001 - a broken hub must never stop the agent's harness
        return 0
    payload = payload if isinstance(payload, dict) else {}
    try:
        me = hub.session(role)
        remember_session(me, payload)
        out = HANDLERS[event](me, payload)
    except HubError:
        return 0  # e.g. a dismissed consultant
    finally:
        hub.close()
    if out:
        sys.stdout.write(json.dumps(out))  # ASCII-escaped, whatever the console code page
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
