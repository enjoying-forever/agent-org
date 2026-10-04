"""Hooks that bring the hub into an agent's own harness.

Harnesses run these at fixed moments, passing the event as JSON on stdin. The role
comes from AGENT_ORG_TEAM / AGENT_ORG_ROLE, which every start script sets; outside an
agent-org tab each hook does nothing. Any failure lets the harness carry on.

- stop       The agent is ending its turn. Once per turn, remind it of unfinished
             duties (reporting to its superior, releasing its files). Then wait for new
             messages and hand them over, so an idle agent wakes up when mail arrives.
             In the agent-org window (AGENT_ORG_STOP_IDLE) a wait that runs out lets the
             agent rest; the window wakes it later (agent_org.waker).
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
import time
from pathlib import Path
from typing import Any

from . import safety, sessions, usage
from .hub import Hub, HubError, RoleSession
from .store import Message

STOP_WAIT = 1800  # seconds a Stop hook waits for messages before letting the agent go round again
EDIT_TOOLS = {"edit", "write", "multiedit", "notebookedit", "apply_patch", "search_replace",
              "write_file", "edit_file", "create_file", "str_replace_editor",
              # Antigravity
              "write_to_file", "replace_file_content", "multi_replace_file_content", "code_action",
              "file_change", "propose_code", "edit_notebook"}
PATH_KEYS = ("file_path", "path", "notebook_path", "target_file", "filePath", "targetFile", "notebookPath",
             "TargetFile", "AbsolutePath", "FilePath", "Path")
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


def out_of_usage(me: RoleSession, payload: dict[str, Any]) -> bool:
    """True if this conversation just ran into its subscription's usage limit."""
    role = me.hub.team.roles.get(me.name)
    session_id = field(payload, "session_id") or payload.get("conversationId")
    if role is None or not isinstance(session_id, str):
        return False
    s = usage.stuck(role.harness, session_id)
    return s is not None and s.kind == "limit" and (s.until or 0) > time.time()


def on_stop(me: RoleSession, payload: dict[str, Any], wait: float | None = None, poll: float = 1.0):
    if out_of_usage(me, payload):
        return None  # a new turn would fail at once and use up its mail; it is restarted after the reset
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
    if not messages and os.environ.get("AGENT_ORG_STOP_IDLE"):
        return None  # in the agent-org window: rest at the prompt; the window wakes it when mail comes
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
    synced = me.hub.sync_role(me.name)  # branch mode: keep its copy close to main
    new = me.store.unnoticed(me.name)
    if not new and not synced:
        return None
    urgent = [m for m in new if m.urgent]
    rest = [m for m in new if not m.urgent]
    parts = [synced] if synced else []
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
    call = payload.get("toolCall")  # Antigravity: {"toolCall": {"name": ..., "args": {...}}}
    if isinstance(call, dict):
        tool, tool_input = str(call.get("name") or ""), call.get("args") or {}
    else:
        tool, tool_input = str(field(payload, "tool_name") or ""), field(payload, "tool_input") or {}
    if tool.rsplit("__", 1)[-1].lower() not in EDIT_TOOLS:
        return []
    if not isinstance(tool_input, dict):
        tool_input = {"input": tool_input}
    paths = [tool_input[k] for k in PATH_KEYS if isinstance(tool_input.get(k), str)]
    for value in tool_input.values():  # apply_patch carries its files inside the patch text
        if isinstance(value, str) and "*** " in value:
            paths += [a or b for a, b in PATCH_FILE.findall(value)]
    return [p.strip() for p in dict.fromkeys(paths) if p.strip()]


def tool_call(payload: dict[str, Any]) -> tuple[str, Any]:
    """(tool name, its input), in any harness's dialect."""
    call = payload.get("toolCall")  # Antigravity
    if isinstance(call, dict):
        return str(call.get("name") or ""), call.get("args") or {}
    return str(field(payload, "tool_name") or ""), field(payload, "tool_input") or {}


def is_shell(tool: str) -> bool:
    return tool.rsplit("__", 1)[-1].lower() in safety.SHELL_TOOLS


def guard_command(me: RoleSession, payload: dict[str, Any]):
    """Refuse a shell command that publishes, wipes shared work, or deletes outside the project."""
    tool, tool_input = tool_call(payload)
    if not is_shell(tool) or not me.team.settings.guard_commands:
        return None
    command = safety.command_of(tool_input)
    roots = [me.hub.base_team.project_root, me.hub.root_of(me.name)]
    why = safety.check_command(command, roots, shared_folder=not me.hub.branches)
    if why is None:
        return None
    me.hub.event("safety", me.name, f"refused a command: {command[:200]}")
    return deny(f"agent-org refused this command. {why} If it really is needed, ask {me.superior}.")


def guard_protected(me: RoleSession, rel: str):
    if safety.protected(rel, me.hub.team_file.name if me.hub.team_file else "team.yaml"):
        me.hub.event("safety", me.name, f"refused an edit of {rel}")
        return deny(f"{rel} is the team's own configuration; agents never edit it. If the team needs "
                    f"changing, ask {me.superior} (managers have hire_agent / change_agent).")
    return None


def deny(reason: str) -> dict[str, Any]:
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                   "permissionDecisionReason": reason}}


def on_pre_edit(me: RoleSession, payload: dict[str, Any]):
    refused = guard_command(me, payload)
    if refused is not None:
        return refused
    if me.hub.branches:
        return on_pre_edit_branch(me, payload)
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
        refused = guard_protected(me, rel)
        if refused is not None:
            return refused
        key, _ = me.hub.lock_key(full)
        lock = me.store.covering(key)
        if lock is not None and lock.owner == me.name:
            me.note_edit(rel)
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


def on_pre_edit_branch(me: RoleSession, payload: dict[str, Any]):
    """Branch mode: an agent edits its own copy freely, within its write scope; no leases."""
    root = me.hub.root_of(me.name)
    cwd = Path(field(payload, "cwd") or root)
    for raw in edited_paths(payload):
        full = (cwd / raw).resolve()
        try:
            rel = full.relative_to(root.resolve()).as_posix()
        except ValueError:
            main = me.hub.base_team.project_root.resolve()
            if full.is_relative_to(main):
                return deny(f"Edit your own copy of the project in {root}, not the shared main folder: your "
                            "work reaches main when you finish the task (or share_work).")
            continue  # outside the project: not the team's business
        if rel == ".git" or rel.startswith(".git/"):
            return deny("Leave git's own files alone; the hub handles commits and merges.")
        refused = guard_protected(me, rel)
        if refused is not None:
            return refused
        if not me._in_scope(me.team, me.name, rel):
            return deny(f"{rel} is outside the files you may write ({', '.join(me._scope(me.team, me.name)) or 'none'}). "
                        f"Ask {me.superior} if it needs changing.")
        me.note_edit(rel)
    return None


def remember_session(me: RoleSession, payload: dict[str, Any]) -> None:
    """Note which conversation the harness is in, so a restarted team can resume it."""
    session_id = field(payload, "session_id") or payload.get("conversationId")
    role = me.hub.team.roles.get(me.name)
    if isinstance(session_id, str) and session_id and role is not None:
        # Codex's auto-reviewer runs as its own conversation and fires these hooks too: record
        # the agent's conversation, never the helper's (resuming that gives an agent with no tools).
        own = sessions.main_session(role.harness, session_id)
        if own:
            me.store.record_session_id(me.name, role.harness, own)


def on_session(me: RoleSession, payload: dict[str, Any]):
    return None  # remember_session already did the work


HANDLERS = {"stop": on_stop, "post-tool": on_post_tool, "pre-edit": on_pre_edit, "session": on_session,
            "invocation": on_post_tool}


def for_antigravity(event: str, out: dict[str, Any] | None, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Antigravity's hooks speak a different dialect: translate our answer, and always answer.

    A pre-tool answer must carry a decision: an edit the lease allows is "allow"; a shell
    command that passed our guard is "ask", so Antigravity's own permission check still runs.
    """
    shell = is_shell(tool_call(payload or {})[0])
    if not out:
        return ({"decision": "ask" if shell else "allow"}) if event == "pre-edit" else {}
    spec = out.get("hookSpecificOutput") or {}
    if event == "stop" and out.get("decision") == "block":
        return {"decision": "continue", "reason": out.get("reason", "")}
    if event == "pre-edit" and spec.get("permissionDecision") == "deny":
        return {"decision": "deny", "reason": spec.get("permissionDecisionReason", "")}
    if event == "pre-edit":
        return {"decision": "ask" if shell else "allow"}  # a missing decision would count as "deny"
    if event == "invocation" and spec.get("additionalContext"):
        return {"injectSteps": [{"ephemeralMessage": spec["additionalContext"]}]}
    return {}


HOOK_LOG = "hook-errors.log"


def log_error(hub: Hub, event: str, role: str) -> None:
    """Keep the traceback next to the hub's database, and in the Activity list, instead of failing."""
    import traceback
    text = traceback.format_exc()
    try:
        path = hub.base_team.database.parent / HOOK_LOG
        with path.open("a", encoding="utf-8") as f:
            f.write(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')} {role} {event}\n{text}\n")
        hub.event("agent", role, f"a {event} hook failed ({text.strip().splitlines()[-1][:160]}); "
                                 f"details in {path}")
    except Exception:  # noqa: BLE001
        pass


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    event = argv[0] if argv else ""
    antigravity = "agy" in argv[1:]
    team_file, role = os.environ.get("AGENT_ORG_TEAM"), os.environ.get("AGENT_ORG_ROLE")
    if event not in HANDLERS or not team_file or not role:
        if antigravity:  # Antigravity expects an answer from every hook; outside our tabs, change nothing
            sys.stdout.write('{"decision": "ask"}' if event == "pre-edit" else "{}")
        return 0
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        payload = {}
    payload = payload if isinstance(payload, dict) else {}
    if antigravity and "stop_hook_active" not in payload:  # its Stop counts loops instead
        payload["stop_hook_active"] = int(payload.get("executionNum") or 1) > 1
    out = None
    try:
        hub = Hub.open(team_file)
    except Exception:  # noqa: BLE001 - a broken hub must never stop the agent's harness
        hub = None
    if hub is not None:
        try:
            me = hub.session(role)
            remember_session(me, payload)
            out = HANDLERS[event](me, payload)
        except HubError:
            out = None  # e.g. a dismissed consultant
        except Exception:  # noqa: BLE001 - a failing hook shows up in the agent's tab on every step
            log_error(hub, event, role)
            out = None
        finally:
            hub.close()
    if antigravity:
        out = for_antigravity(event, out, payload)
    if out is not None and (out or antigravity):
        sys.stdout.write(json.dumps(out))  # ASCII-escaped, whatever the console code page
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
