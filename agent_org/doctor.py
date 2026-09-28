"""Checks that the programs agent-org drives are installed and working, with plain fixes."""

from __future__ import annotations

import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    fix: str = ""
    needed: bool = True  # False: only matters if your team uses it

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def run(command: list[str], timeout: float = 40) -> tuple[int, str]:
    try:
        r = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).strip()
    except (OSError, subprocess.SubprocessError) as e:
        return -1, str(e)


def first_line(text: str) -> str:
    return text.splitlines()[0][:120] if text else ""


def check_program(name: str, command: str, install: str) -> Check:
    path = shutil.which(command)
    if path is None:
        return Check(name, False, "not installed", install)
    code, out = run([path, "--version"])
    if code != 0:
        return Check(name, False, f"installed but does not start: {first_line(out)}", "")
    return Check(name, True, first_line(out))


def check_claude(harnesses: set[str]) -> Check:
    c = check_program("Claude Code", "claude", "Install it: npm install -g @anthropic-ai/claude-code")
    c.needed = "claude" in harnesses
    if not c.ok and c.detail.startswith("installed"):
        path = shutil.which("claude")
        script = Path(path).parent / "node_modules" / "@anthropic-ai" / "claude-code" / "install.cjs" if path else None
        c.fix = (f'An update did not finish. Repair it with: node "{script}"' if script and script.exists()
                 else "Reinstall it: npm install -g @anthropic-ai/claude-code")
    return c


def check_codex(harnesses: set[str]) -> Check:
    c = check_program("Codex", "codex", "Install it: npm install -g @openai/codex")
    c.needed = "codex" in harnesses
    if not c.ok and c.detail.startswith("installed"):
        c.fix = "Reinstall it: npm install -g @openai/codex"
    return c


def check_grok(harnesses: set[str]) -> list[Check]:
    c = check_program("Grok", "grok", "Install Grok Build and sign in with: grok login")
    c.needed = "grok" in harnesses
    checks = [c]
    if c.ok:
        code, out = run([shutil.which("grok") or "grok", "models"])
        if "not authenticated" in out.lower():
            checks.append(Check("Grok sign-in", False, "Grok is not signed in", "Run: grok login",
                                needed=c.needed))
        hooks = Path.home() / ".grok" / "hooks" / "agent-org.json"
        checks.append(Check(
            "Grok message delivery", hooks.exists(),
            "installed" if hooks.exists() else "not installed: Grok agents only see messages when they check",
            "" if hooks.exists() else "Click 'Install Grok hooks' (they do nothing outside agent-org tabs).",
            needed=c.needed))
    return checks


def run_checks(harnesses: set[str] | None = None) -> list[Check]:
    """All checks, in parallel. `harnesses`: the ones the open team uses (all if None)."""
    used = set(harnesses) if harnesses is not None else {"claude", "codex", "grok"}
    basics = [
        Check("Windows Terminal", shutil.which("wt") is not None,
              "found" if shutil.which("wt") else "not found",
              "Install 'Windows Terminal' from the Microsoft Store."),
        Check("PowerShell 7", shutil.which("pwsh") is not None,
              "found" if shutil.which("pwsh") else "not found",
              "Install it: winget install Microsoft.PowerShell"),
    ]
    with ThreadPoolExecutor(3) as pool:
        claude = pool.submit(check_claude, used)
        codex = pool.submit(check_codex, used)
        grok = pool.submit(check_grok, used)
        return basics + [claude.result(), codex.result(), *grok.result()]
