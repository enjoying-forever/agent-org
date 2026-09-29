"""Guards that keep a team inside its limits, whatever an agent types.

- Protected files: the team's own configuration (team.yaml, the hub's folder, agent-org's
  plugin and project configs) is never edited by an agent - that would let it rewrite its
  own permissions or the law.
- Commands: shell commands that publish (git push), wipe other agents' unsaved work in a
  shared folder, or delete things outside the project are refused before they run.
- Secrets: work that adds a private key or an API token is not put into git history.
- Scope: in branch mode an agent's work only reaches main if every file it changed is in
  its write scope (this also catches files written through the shell).
"""

from __future__ import annotations

import re
from fnmatch import fnmatchcase
from pathlib import Path, PureWindowsPath

# relative to the project folder; directories end with "/"
PROTECTED = ("team.yaml", "team.yaml.bak", ".agent-org/", ".agents/plugins/agent-org/", ".grok/config.toml",
             ".git/")


def protected(rel: str, team_file_name: str = "team.yaml") -> bool:
    """True for a file an agent must never edit."""
    low = rel.replace("\\", "/").removeprefix("./").lower()
    names = {p.lower() for p in PROTECTED} | {team_file_name.lower(), team_file_name.lower() + ".bak"}
    for p in names:
        if p.endswith("/"):
            if low == p[:-1] or low.startswith(p):
                return True
        elif low == p:
            return True
    return False


# commands

SHELL_TOOLS = {"bash", "powershell", "shell", "exec_command", "local_shell", "run_command", "run_terminal_cmd",
               "terminal", "run_shell_command", "execute_command"}
COMMAND_KEYS = ("command", "cmd", "CommandLine", "commandLine", "script")

ALWAYS = [
    (re.compile(r"\bgit\s+(?:(?:-C|-c)\s+\S+\s+|--?[\w-]+(?:=\S+)?\s+)*push\b", re.I),
     "Publishing (git push) is the owner's decision. Tell your superior the work is ready instead."),
    (re.compile(r"\b(format|diskpart|mkfs(\.\w+)?|shutdown|reboot|halt)\b(\s+[a-z]:|\s+/|\s+-|\s*$)", re.I),
     "That command can take down the machine or wipe a disk."),
    (re.compile(r"\bdd\b[^\n]*\bof=/dev/", re.I), "That command writes straight to a disk."),
    (re.compile(r"\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(-[a-z]*\s+)*(/|~|\$HOME|/\*|[a-z]:[\\/]?)(\s|$)", re.I),
     "That deletes a whole drive or home folder."),
    (re.compile(r"\b(rd|rmdir)\s+(/s\s+/q|/q\s+/s)\s+\"?[a-z]:[\\/]?\"?(\s|$)", re.I),
     "That deletes a whole drive."),
    (re.compile(r"\bremove-item\b[^\n]*-recurse[^\n]*\s\"?([a-z]:[\\/]?|~|\$home|\$env:userprofile)\"?(\s|$)", re.I),
     "That deletes a whole drive or home folder."),
]
SHARED_FOLDER = [
    (re.compile(r"\bgit\s+(reset\s+[^\n]*--hard|clean\s+-[a-z]*[fdx]|checkout\s+(--\s+)?\.(\s|$)|"
                r"restore\s+[^\n]*\.(\s|$)|stash(\s+(push|save|-[a-z]+)\b[^\n]*)?\s*($|[;&|]))", re.I),
     "In the shared project folder that would throw away other agents' unsaved work. Undo only your own "
     "changes, file by file."),
]
RECURSIVE_DELETE = re.compile(r"\b(rm\s+(-[a-z]*\s+)*-[a-z]*r|remove-item\b[^\n]*-recurse|rd\s+/s|rmdir\s+/s|"
                              r"del\s+/s|shutil\.rmtree)", re.I)
ABSOLUTE = re.compile(r"(?<![\w/\\])([a-zA-Z]:[\\/][^\s\"'|;&<>]*|/[a-z]/[^\s\"'|;&<>]*)")


def command_of(tool_input: object) -> str:
    if isinstance(tool_input, str):
        return tool_input
    if not isinstance(tool_input, dict):
        return ""
    for key in COMMAND_KEYS:
        value = tool_input.get(key)
        if isinstance(value, list):
            return " ".join(str(v) for v in value)
        if isinstance(value, str):
            return value
    return ""


def _as_path(text: str) -> Path | None:
    m = re.match(r"^/([a-zA-Z])/(.*)$", text)  # Git Bash: /e/code -> E:/code
    if m:
        text = f"{m.group(1)}:/{m.group(2)}"
    try:
        return Path(PureWindowsPath(text)).resolve()
    except (OSError, ValueError):
        return None


def check_command(command: str, allowed_roots: list[Path], shared_folder: bool) -> str | None:
    """Why `command` must not run, or None."""
    for rule, why in ALWAYS + (SHARED_FOLDER if shared_folder else []):
        if rule.search(command):
            return why
    if RECURSIVE_DELETE.search(command):
        roots = [r.resolve() for r in allowed_roots]
        for raw in ABSOLUTE.findall(command):
            path = _as_path(raw)
            if path is not None and not any(path == r or path.is_relative_to(r) for r in roots):
                return f"That deletes {raw}, which is outside the project."
    return None


# secrets

SECRET_PATTERNS = [
    ("private key", re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----")),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("API key (sk-...)", re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}")),
    ("GitHub token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("password or token in the code", re.compile(
        r"""(?i)\b(?:api[_-]?key|secret|passw(?:or)?d|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{12,}["']""")),
]


def find_secrets(diff: str) -> list[str]:
    """Secrets that lines added in `diff` would put into history: 'file:line (kind)', never the value."""
    found, file, line = [], "?", 0
    for text in diff.splitlines():
        if text.startswith("+++ "):
            file = text[6:] if text.startswith("+++ b/") else text[4:]
            continue
        if text.startswith("@@"):
            m = re.search(r"\+(\d+)", text)
            line = int(m.group(1)) - 1 if m else 0
            continue
        if text.startswith("+"):
            line += 1
            for kind, rule in SECRET_PATTERNS:
                if rule.search(text):
                    found.append(f"{file}:{line} ({kind})")
                    break
        elif not text.startswith("-"):
            line += 1
    return found


# scope

def outside_scope(files: list[str], scope: tuple[str, ...]) -> list[str]:
    """Files not covered by `scope` ('*' matches across folders)."""
    return [f for f in files if not any(fnmatchcase(f.lower(), p.lower().removeprefix("./")) for p in scope)]


def scope_within(granted: list[str] | tuple[str, ...], own: tuple[str, ...]) -> list[str]:
    """Patterns in `granted` that reach beyond `own` (a manager cannot give more than it has)."""
    return [p for p in granted if not any(fnmatchcase(p.lower().removeprefix("./"), o.lower().removeprefix("./"))
                                          for o in own)]
