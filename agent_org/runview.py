"""Show a run of an agent program that works in print mode, as it happens.

DeepSeek Harness (`dsh --profile headless --json`) and Antigravity (`agy -p ... --output-format
stream-json`) print only their final answer in plain print mode - and print mode is how agent-org
runs them (DeepSeek has no other terminal mode; Antigravity loads agent-org's tools only in it).
With JSON output they write one event per line instead: thinking, each tool call and its result,
the text as it is written. Their start scripts pipe that through this, so their terminal shows
the agent at work like any other agent's. For DeepSeek, --session-file keeps the run's session id,
so the next run continues the same conversation.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

DIM, BOLD, RESET = "\x1b[2m", "\x1b[1m", "\x1b[0m"
CYAN, RED = "\x1b[36m", "\x1b[31m"
RESULT_LINES = 4  # lines of a tool result shown


def short(value: object, limit: int = 160) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def tool_name(name: str) -> str:
    """agent-org's tools read as org.<tool> whatever the program calls them."""
    for prefix in ("mcp__org__", "mcp_org_", "org__", "org_"):
        if name.startswith(prefix):
            return "org." + name[len(prefix):]
    return name


def call_line(name: str, args: object) -> str:
    if name == "call_mcp_tool" and isinstance(args, dict) and args.get("ToolName"):  # Antigravity's wrapper
        server = str(args.get("ServerName", ""))
        inner = args.get("Arguments", {})
        if isinstance(inner, str):
            try:
                inner = json.loads(inner)
            except ValueError:
                pass
        name = f"org.{args['ToolName']}" if server.endswith("org") else f"{server}.{args['ToolName']}"
        args = inner
    if isinstance(args, dict):
        args = ", ".join(f"{k}={short(v, 60)}" for k, v in args.items())
    return f"{CYAN}● {BOLD}{tool_name(name)}{RESET}{CYAN}({short(args or '', 140)}){RESET}"


def result_lines(text: object, ok: bool, status: str = "") -> list[str]:
    text = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    lines = [line for line in text.splitlines() if line.strip()] or ["(nothing)"]
    color = DIM if ok else RED
    shown = [f"{color}  ⎿ {short(line, 150)}{RESET}" for line in lines[:RESULT_LINES]]
    if len(lines) > RESULT_LINES:
        shown.append(f"{DIM}    … {len(lines) - RESULT_LINES} more lines{RESET}")
    if not ok:
        shown[0] = f"{RED}  ⎿ {status or 'failed'}: {short(lines[0], 140)}{RESET}"
    return shown


class View:
    """Turns events into terminal text; `session` is the conversation the run belongs to."""

    def __init__(self, out) -> None:
        self.out = out
        self.session: str | None = None
        self.mid_line = False  # text is being streamed: the next line must start on a new one
        self.last_text = ""

    def line(self, text: str = "") -> None:
        if self.mid_line:
            self.out.write("\n")
            self.mid_line = False
        self.out.write(text + "\n")

    def stream(self, text: str) -> None:
        self.out.write(text)
        self.mid_line = not text.endswith("\n")

    def show(self, event: dict) -> None:
        if "event" in event:
            self.antigravity(event)
        else:
            self.deepseek(event)

    # DeepSeek Harness: {"type": session | status | thinking | tool_call | tool_result | text | final | error}
    def deepseek(self, e: dict) -> None:
        kind = e.get("type")
        if kind == "session":
            self.session = e.get("sessionId")  # kept for the next run, not shown
        elif kind == "thinking":
            for text in str(e.get("text") or "").strip().splitlines():
                if text.strip():
                    self.line(f"{DIM}✻ {text}{RESET}")
        elif kind == "tool_call":
            self.line(call_line(str(e.get("tool", "?")), e.get("input")))
        elif kind == "tool_result":
            for text in result_lines(e.get("result", e.get("error", "")), e.get("status") in (None, "completed", "ok", "success"),
                                     str(e.get("status") or "")):
                self.line(text)
        elif kind in ("text", "final"):
            text = str(e.get("text") or "").strip()
            if text and not (kind == "final" and text == self.last_text):
                self.line()
                for part in text.splitlines():
                    self.line(part)
            self.last_text = text or self.last_text
        elif kind == "error":
            self.line(f"{RED}✗ {short(e.get('message') or e.get('error') or e, 300)}{RESET}")
        elif kind != "status":
            self.line(f"{DIM}· {short(e, 200)}{RESET}")

    # Antigravity: {"event": init | step_update | result, ...}
    def antigravity(self, e: dict) -> None:
        kind = e["event"]
        if kind == "init":
            self.session = e.get("conversation_id")
            self.line(f"{DIM}· conversation {self.session}{RESET}")
            return
        if kind == "result":
            body = e.get("result") or {}
            if str(body.get("status", "SUCCESS")).upper() != "SUCCESS":
                self.line(f"{RED}✗ {body.get('status')}: {short(body.get('response') or body.get('error') or '', 300)}{RESET}")
            elif self.mid_line:
                self.line()
            return
        step = e.get(kind) if isinstance(e.get(kind), dict) else {}
        state = str(step.get("state", "")).upper()
        kind = step.get("step_type")
        if kind == "agent_response" and step.get("text_delta"):
            if not self.mid_line:
                self.line()
            self.stream(str(step["text_delta"]))
        elif kind == "tool":
            info = step.get("tool_info") or {}
            if state == "ACTIVE":
                self.line(call_line(str(step.get("tool_name") or info.get("name") or "?"), info.get("parameters")))
            elif state in ("DONE", "ERROR", "FAILED", "CANCELLED"):
                for text in result_lines(info.get("output") or info.get("error") or "done", state == "DONE", state.lower()):
                    self.line(text)


BLUE = "\x1b[38;5;69m"
WHALE = ["   ▄▄▄▄▄▄   ", " ▄█▀▀▀▀▀▀█▄▄", "▐█ ●     ▀▀█", " ▀█▄▄▄▄▄▄█▀ "]


def banner(out, program: str, version: str, model: str, folder: str) -> None:
    """The heading an interactive program shows when it starts: what runs, with which model, where."""
    info = [f"{BOLD}{BLUE}{program}{RESET} {DIM}{version}{RESET}", model, f"{DIM}{folder}{RESET}", ""]
    for art, text in zip(WHALE, info):
        out.write(f"{BLUE}{art}{RESET}  {text}\n")
    out.write("\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="show an agent program's JSON events as they happen")
    parser.add_argument("--session-file", help="keep the run's session id here, for the next run to continue")
    parser.add_argument("--banner", nargs=4, metavar=("PROGRAM", "VERSION", "MODEL", "FOLDER"),
                        help="print the start banner and exit")
    args = parser.parse_args(argv)
    out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)
    if args.banner:
        banner(out, *args.banner)
        out.flush()
        out.detach()
        return 0
    view = View(out)
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            view.line(line)  # not an event (a warning, say): show it as it is
            continue
        if isinstance(event, dict):
            before = view.session
            view.show(event)
            out.flush()
            if args.session_file and view.session and view.session != before:
                Path(args.session_file).write_text(view.session, encoding="utf-8")
    if view.mid_line:
        out.write("\n")
    out.flush()
    out.detach()  # leave the terminal's output open for whatever runs next
    return 0


if __name__ == "__main__":
    sys.exit(main())
