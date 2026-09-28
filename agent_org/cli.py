"""Command line access to the hub, for you (the owner) and for testing roles by hand.

    python -m agent_org.cli tree
    python -m agent_org.cli --as worker-a send tech-lead "tests are green"
    python -m agent_org.cli --as tech-lead inbox

The team file and role default to $AGENT_ORG_TEAM (else ./team.yaml) and
$AGENT_ORG_ROLE (else the owner).
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from .hub import Hub, HubError, RoleSession, RoleView
from .launch import tab_opener
from .store import Lock, Message
from .team import TeamError


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(errors="replace")  # type: ignore[union-attr]
    args = _parser().parse_args(argv)
    team_file = Path(args.team).resolve()
    try:
        hub = Hub.open(team_file, opener=tab_opener(team_file))
    except TeamError as e:
        print(f"team error: {e}", file=sys.stderr)
        return 2
    try:
        me = hub.session(args.role or hub.team.owner)
        return _run(args, hub, me)
    except HubError as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1
    finally:
        hub.close()


def _run(args: argparse.Namespace, hub: Hub, me: RoleSession) -> int:
    cmd = args.command
    if cmd == "tree":
        print("\n".join(hub.team.tree_lines()))
    elif cmd == "send":
        print(_fmt_message(me.send(args.to, args.text, args.reply_to)))
    elif cmd == "help":
        print(_fmt_message(me.ask_help(args.text, args.reply_to)))
    elif cmd == "inbox":
        _print_messages(me.read_inbox(), "no new messages")
    elif cmd == "wait":
        _print_messages(me.wait_for_messages(args.timeout), "no messages before timeout")
    elif cmd == "status":
        s = me.set_status(args.state, args.task)
        print(f"{s.role}: {s.state}" + (f" - {s.task}" if s.task else ""))
    elif cmd == "view":
        _print_view(me.view(args.role_name))
    elif cmd == "claim":
        print(_fmt_lock(me.claim(args.path)))
    elif cmd == "release":
        print(f"released {me.release(args.path).path}")
    elif cmd == "locks":
        locks = hub.store.locks()
        print("\n".join(_fmt_lock(lock) for lock in locks) if locks else "no locks")
    elif cmd == "hand-over":
        print(f"handed over: {_fmt_lock(me.hand_over(args.path, args.to))}")
    elif cmd == "summon":
        role = me.summon_consultant(args.help_id, args.tier, args.brief)
        print(f"summoned {role.name} ({role.tier}, {role.harness}) under {role.superior}")
    elif cmd == "dismiss":
        role, returned = me.dismiss_consultant(args.name)
        print(f"dismissed {role.name}" + (f"; files back to {role.superior}: {', '.join(returned)}"
                                          if returned else ""))
    elif cmd == "can-write":
        return 0 if me.can_write(args.path) else 1
    return 0


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="agent-org", description="Chain-of-command hub for AI agents")
    p.add_argument("--team", default=os.environ.get("AGENT_ORG_TEAM", "team.yaml"))
    p.add_argument("--as", dest="role", default=os.environ.get("AGENT_ORG_ROLE"),
                   help="act as this role (default: the owner)")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("tree", help="show the role tree")
    s = sub.add_parser("send", help="message your superior or anyone below you")
    s.add_argument("to")
    s.add_argument("text")
    s.add_argument("--reply-to", type=int)
    s = sub.add_parser("help", help="ask your direct superior for help")
    s.add_argument("text")
    s.add_argument("--reply-to", type=int)
    sub.add_parser("inbox", help="read (and mark read) your new messages")
    s = sub.add_parser("wait", help="wait for new messages")
    s.add_argument("--timeout", type=float, default=300)
    s = sub.add_parser("status", help="set your status")
    s.add_argument("state")
    s.add_argument("task", nargs="?", default="")
    s = sub.add_parser("view", help="look at yourself or a role below you")
    s.add_argument("role_name")
    s = sub.add_parser("claim", help="take the write lock on a file")
    s.add_argument("path")
    s = sub.add_parser("release", help="release a write lock")
    s.add_argument("path")
    sub.add_parser("locks", help="list all write locks")
    s = sub.add_parser("hand-over", help="give a lock you hold to your superior or a direct subordinate")
    s.add_argument("path")
    s.add_argument("to")
    s = sub.add_parser("summon", help="attach a consultant to the sender of a help request you received")
    s.add_argument("help_id", type=int)
    s.add_argument("tier")
    s.add_argument("--brief", default="")
    s = sub.add_parser("dismiss", help="dismiss a consultant working for you or below you")
    s.add_argument("name")
    s = sub.add_parser("can-write", help="exit 0 if you hold the lock on PATH, else 1")
    s.add_argument("path")
    return p


def _fmt_time(t: float) -> str:
    return time.strftime("%H:%M:%S", time.localtime(t))


def _fmt_message(m: Message) -> str:
    reply = f" (re #{m.reply_to})" if m.reply_to else ""
    return f"#{m.id} {_fmt_time(m.sent_at)} [{m.kind}] {m.sender} -> {m.recipient}{reply}: {m.text}"


def _fmt_lock(lock: Lock) -> str:
    return f"{lock.path}  held by {lock.owner} since {_fmt_time(lock.claimed_at)}"


def _print_messages(messages: list[Message], empty: str) -> None:
    print("\n".join(_fmt_message(m) for m in messages) if messages else empty)


def _print_view(v: RoleView) -> None:
    header = v.name if v.role is None else f"{v.name}  [{v.role.harness}" + (
        f" / {v.role.model}]" if v.role.model else "]")
    print(header)
    print(f"  superior:     {v.superior or '-'}")
    print(f"  subordinates: {', '.join(v.subordinates) or '-'}")
    if v.role and v.role.duties:
        print(f"  duties:       {v.role.duties}")
    if v.role:
        print(f"  write scope:  {', '.join(v.role.write_scope) or 'nothing'}")
    if v.status:
        task = f" - {v.status.task}" if v.status.task else ""
        print(f"  status:       {v.status.state}{task} ({_fmt_time(v.status.updated_at)})")
    print(f"  session:      {'running' if v.online else 'not running'}")
    print(f"  locks:        {', '.join(lock.path for lock in v.locks) or '-'}")
    if v.limited:
        print("  (its messages are visible only to itself and the roles above it)")
        return
    print(f"  unread:       {v.unread}")
    if v.recent:
        print("  recent messages:")
        for m in v.recent:
            print("    " + _fmt_message(m))


if __name__ == "__main__":
    sys.exit(main())
