"""Between two runs of an agent whose program does one task per run (DeepSeek Harness).

Its start script runs this first, and again after each run: it waits - without a model, so at
no cost - until the role has a new message (a task arrives as one too), then exits 0 and the
script starts a run. At the start (--first) unfinished tasks count too: the team was restarted. Stopping the role (its stop marker appears) ends it with 3.
While it waits, it keeps the role checked in, so the team sees the agent as running and the
watchdog does not start a second one.
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from pathlib import Path

from .hub import Hub
from .waker import unfinished

HEARTBEAT = 10  # seconds between check-ins (presence counts the last 30)
STOPPED = 3


def alive(pid: int) -> bool:
    """Whether process `pid` still runs (without touching it)."""
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True
    import ctypes  # noqa: PLC0415 - Windows only

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def read_owner(hub: Hub, role: str) -> None:
    """Lines typed into the agent's terminal while it waits go to it as messages from the owner."""
    owner = hub.base_team.owner
    for line in sys.stdin:
        text = line.strip()
        if text:
            hub.session(owner).send(role, text)  # the wait sees it and starts the agent
            return


def prompt_line(role: str) -> str:
    width = 72
    return (f"\x1b[2m{'─' * width}\x1b[0m\n"
            f"\x1b[2m  {role} is waiting. Type a message for it and press Enter (no model runs meanwhile).\x1b[0m\n"
            f"\x1b[2m{'─' * width}\x1b[0m\n\x1b[38;5;69m›\x1b[0m ")


def wait_for_work(hub: Hub, role: str, stop_marker: Path, poll: float = 1.0) -> int:
    pid = os.getpid()
    for gone, _ in hub.store.sessions_of(role):  # the run that just ended may not have checked out
        if gone != pid and not alive(gone):
            hub.store.check_out(gone)
    last_beat = 0.0
    try:
        while True:
            if stop_marker.exists():
                return STOPPED
            if hub.store.unread_counts().get(role, 0) > 0:
                return 0
            if time.time() - last_beat > HEARTBEAT:
                hub.store.check_in(pid, role)
                last_beat = time.time()
            time.sleep(poll)
    finally:
        hub.store.check_out(pid)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="wait until a role has something new to do")
    parser.add_argument("--team", required=True)
    parser.add_argument("--role", required=True)
    parser.add_argument("--stop", required=True, help="the role's stop marker file")
    parser.add_argument("--input", action="store_true", help="show an input line: what the owner types is sent to the role")
    parser.add_argument("--first", action="store_true", help="the agent's start: unfinished tasks are work too")
    args = parser.parse_args(argv)
    hub = Hub.open(Path(args.team))
    stop = Path(args.stop)
    if args.first and not stop.exists() and unfinished(hub.session(args.role)):
        hub.close()
        print(f"\x1b[2m{args.role} has unfinished tasks: carrying on with them\x1b[0m", flush=True)
        return 0
    if args.input:  # an input line, as an interactive program has one
        sys.stdout.write(prompt_line(args.role))
        sys.stdout.flush()
        typing = Hub.open(Path(args.team))  # its own connection: the reader runs in another thread
        threading.Thread(target=read_owner, args=(typing, args.role), daemon=True).start()
    else:
        print(f"agent-org: {args.role} is waiting for messages (no model runs meanwhile).", flush=True)
    try:
        code = wait_for_work(hub, args.role, stop)
    except KeyboardInterrupt:
        code = STOPPED
    finally:
        hub.close()
    if code == 0:
        print(f"\n\x1b[2mnew messages for {args.role}: working on them\x1b[0m", flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
