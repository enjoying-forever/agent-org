"""Open one visible Windows Terminal tab per role, each running its real harness.

    python -m agent_org.launch --team path/to/team.yaml            # every role + an owner tab
    python -m agent_org.launch --team path/to/team.yaml leader     # just some roles
    python -m agent_org.launch --team path/to/team.yaml --dry-run  # write scripts, open nothing

For each role it writes .agent-org/launch/<role>/start.ps1 (plus the files that
script needs) and opens it in a tab. You can also run a start.ps1 yourself in
any PowerShell 7 window.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import os
import sys
import time
import tomllib
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from . import sessions
from .cards import SERVER_NAME, role_card
from .hooks import STOP_WAIT
from .hub import Hub, HubError, Opener
from .team import Role, Team

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
HOOK_SCRIPT = PACKAGE_ROOT / "org_hook.py"
WINDOW = "agent-org"
WAIT_LIMIT = 3600  # seconds a single wait_for_messages call may take; harness tool timeouts are set to this
TAB_COLORS = {"claude": "#D97757", "codex": "#10A37F", "grok": "#8B8B8B", "antigravity": "#4285F4", "deepseek": "#4D6BFE",
              "owner": "#F2C94C"}


@dataclass
class Launch:
    role: str
    harness: str
    command: str
    args: list[str]
    env: dict[str, str] = field(default_factory=dict)
    setup: list[list[str]] = field(default_factory=list)  # commands run first, in the project folder
    cwd: Path | None = None  # where it works (branch mode: its own worktree); default the project folder
    script: str | None = None  # PowerShell that runs it, when one command line is not enough (DeepSeek)


# A started agent gets one first prompt, the kickoff, so it reads its role and carries on - except
# in the agent-org window ("quiet"): there it starts with no prompt (its role is in its system
# prompt) and agent-org types a line into its terminal only when work arrives (agent_org.waker).


def kickoff(role: str) -> str:
    return (f"You are the '{role}' agent in a team. Call the {SERVER_NAME} tool my_role to read "
            "your role, the message law and where you left off. Then carry on with your open tasks, "
            "or end your turn: new messages will be delivered to you. If you have no tool called "
            f"my_role (the {SERVER_NAME} tools did not load), say so and stop: do not search the computer "
            "for it.")


def resume_kickoff(role: str) -> str:
    return (f"agent-org: the team was restarted and you are back as '{role}'. Your role or the team "
            f"may have changed, so call the {SERVER_NAME} tool my_role first. Then read_inbox, check "
            "list_tasks, and carry on where you left off. If you have no tool called my_role, say so and "
            "stop: do not search the computer for it.")


def plan_session(hub: Hub, role: str, fresh: bool = False) -> tuple[str | None, str | None]:
    """(conversation to resume, id for a new one) for a role about to start.

    A role resumes its last conversation if its harness still has it, unless `fresh`.
    Codex picks the id of a new conversation itself; the hooks record it later.
    """
    spec = hub.team.roles[role]
    if not fresh:
        found = resumable_session(hub, role)
        if found:
            return found, None
    return None, (str(uuid.uuid4()) if spec.harness in sessions.CAN_CHOOSE_ID else None)


def resumable_session(hub: Hub, role: str) -> str | None:
    """The conversation `role` would resume, if its harness still has one.

    Prefers the id on record; otherwise searches the harness's saved conversations for
    this role's kickoff (a team from before ids were kept, or Codex before its hooks
    were trusted) and records what it finds.
    """
    spec = hub.team.roles[role]
    if spec.harness == "deepseek":  # its runs keep their conversation's id in the launch folder
        kept = hub.team.database.parent / "launch" / role / DSH_SESSION
        sid = kept.read_text(encoding="utf-8").strip() if kept.is_file() else ""
        return sid or None
    if spec.harness not in sessions.RESUMABLE:
        return None
    record = hub.store.get_session(role)
    if record is not None and record.harness == spec.harness and sessions.exists(spec.harness, record.session_id):
        own = sessions.main_session(spec.harness, record.session_id)
        if own == record.session_id:
            return own
        if own and sessions.exists(spec.harness, own):  # the record named a helper conversation: fix it
            hub.store.record_session_id(role, spec.harness, own)
            return own
    database = hub.team.database
    since = sessions.born(database) - 60 if database.is_file() else 0.0  # not another team's (see find)
    found = sessions.find(spec.harness, hub.root_of(role), role, since)
    if found and sessions.exists(spec.harness, found):
        hub.store.record_session_id(role, spec.harness, found)
        return found
    return None


def mcp_server(team_file: Path | None = None, role: str | None = None) -> tuple[str, list[str], dict[str, str]]:
    """The command every harness runs to start this role's hub connection.

    Without a team file and role, the server takes them from AGENT_ORG_TEAM and
    AGENT_ORG_ROLE, which every start script sets.
    """
    args = ["-m", "agent_org.mcp_server"]
    if team_file is not None and role is not None:
        args += ["--team", str(team_file), "--role", role]
    return sys.executable, args, {"PYTHONPATH": str(PACKAGE_ROOT)}


def hook_command(event: str) -> str:
    """The command a harness runs for one of our hooks.

    Harnesses hand it to different shells - PowerShell (Grok, Codex), cmd, bash - so it uses
    the one form all of them run: unquoted forward-slash paths. A quoted program path is a
    parse error in PowerShell ("ParserError") unless prefixed with '&', which cmd rejects.
    """
    return f"{shell_path(Path(sys.executable))} {shell_path(HOOK_SCRIPT)} {event}"


def shell_path(path: Path) -> str:
    """`path` with forward slashes and no quotes; on Windows a path with spaces uses its short name."""
    text = path.as_posix()
    if " " in text and os.name == "nt":
        import ctypes
        buf = ctypes.create_unicode_buffer(1024)
        if ctypes.windll.kernel32.GetShortPathNameW(str(path), buf, len(buf)) and " " not in buf.value:
            text = Path(buf.value).as_posix()
    return text if " " not in text else f'"{text}"'  # no short name: quoting is the best left


def hook_table(edit_matcher: str | None) -> dict[str, list[dict[str, object]]]:
    """Hooks in the Claude Code layout, which Codex and Grok share.

    Stop hands new messages to an agent that ends its turn, PostToolUse mentions mail
    that arrived meanwhile, and PreToolUse makes sure an edited file's lock is held.
    """
    pre: dict[str, object] = {"hooks": [{"type": "command", "command": hook_command("pre-edit"), "timeout": 30}]}
    if edit_matcher:
        pre["matcher"] = edit_matcher
    return {
        "SessionStart": [{"hooks": [{"type": "command", "command": hook_command("session"), "timeout": 30}]}],
        "Stop": [{"hooks": [{"type": "command", "command": hook_command("stop"), "timeout": STOP_WAIT + 300}]}],
        "PostToolUse": [{"hooks": [{"type": "command", "command": hook_command("post-tool"), "timeout": 30}]}],
        "PreToolUse": [pre],
    }


def install_grok_hooks() -> Path:
    """Grok reads hooks only globally or at a git root, so ours go in ~/.grok/hooks.

    Outside an agent-org tab (no AGENT_ORG_ROLE) every one of them does nothing.
    """
    path = grok_hooks_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_grok_hooks_text(), encoding="utf-8")
    return path


def grok_hooks_file() -> Path:
    return Path.home() / ".grok" / "hooks" / "agent-org.json"


def _grok_hooks_text() -> str:
    return json.dumps({"hooks": hook_table("Edit|Write|MultiEdit|Bash|Shell|run_terminal_cmd|run_command")},
                      indent=2) + "\n"


def grok_hooks_state() -> str:
    """'missing', 'outdated' (written by an older agent-org) or 'current'."""
    path = grok_hooks_file()
    if not path.exists():
        return "missing"
    try:
        return "current" if path.read_text(encoding="utf-8") == _grok_hooks_text() else "outdated"
    except OSError:
        return "outdated"


# An agent's terminal shows its work, not your personal extras: no mods of yours (their
# status lines, such as a token counter, show in yellow under every agent) and no spinner tips.
# These go in the agent's own settings because Claude Code applies your settings' "env"
# over whatever environment it starts with.
AGENT_CLAUDE_SETTINGS = {"env": {"CLAUDE_CODE_PLUGIN_DIRS": ""}, "spinnerTipsEnabled": False}
# A teammate works with the shell, files and the web, and with the team through the org tools. Your own
# MCP servers and connectors, Claude in Chrome, and Claude Code's other built-in tools (artifacts,
# workflows, schedules, its own subagents...) are left out: they are sent with every request (a
# request measured 41.7k tokens with them, 13.2k without) and would let an agent reach past the team.
AGENT_CLAUDE_TOOLS = ("Bash", "PowerShell", "Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit",
                      "WebFetch", "WebSearch", "ToolSearch")


def claude_model(model: str) -> str:
    """Claude model ids write versions with dashes: 'claude-sonnet-5.5' (as people write it) is claude-sonnet-5-5."""
    return re.sub(r"(?<=\d)\.(?=\d)", "-", model) if model.lower().startswith("claude-") else model


def claude_launch(hub: Hub, team_file: Path, role: str, out: Path,
                  resume: str | None = None, new_id: str | None = None, quiet: bool = False) -> Launch:
    spec = hub.team.roles[role]
    card = out / "role.md"
    card.write_text(role_card(hub.session(role)) + "\n", encoding="utf-8")
    command, args, env = mcp_server(team_file, role)
    config = out / "mcp.json"
    config.write_text(json.dumps(
        {"mcpServers": {SERVER_NAME: {"type": "stdio", "command": command, "args": args, "env": env}}},
        indent=2), encoding="utf-8")
    settings = out / "settings.json"
    settings.write_text(json.dumps(AGENT_CLAUDE_SETTINGS | {"hooks": hook_table("Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell")},
                                   indent=2), encoding="utf-8")
    cli = ["--mcp-config", str(config), "--strict-mcp-config", "--allowedTools", f"mcp__{SERVER_NAME}",
           "--tools", ",".join(AGENT_CLAUDE_TOOLS), "--no-chrome",
           "--append-system-prompt-file", str(card), "--settings", str(settings)]
    if spec.model:
        cli += ["--model", claude_model(spec.model)]
    if spec.effort:
        cli += ["--effort", spec.effort]
    if resume:
        cli += ["--resume", resume]
    elif new_id:
        cli += ["--session-id", new_id]
    # --mcp-config and --allowedTools take several values, so a plain option must
    # come between them and the prompt or they would swallow it.
    cli += ["--name", role]
    if not quiet:
        cli.append(resume_kickoff(role) if resume else kickoff(role))
    # Several agents share one Claude Code install; an update started by one tab can't
    # replace the program while the others run it, and leaves a broken install behind.
    env = {"MCP_TOOL_TIMEOUT": str(WAIT_LIMIT * 1000), "DISABLE_AUTOUPDATER": "1"}
    return Launch(role, "claude", "claude", cli, env)


def codex_extras_off(config: Path | None = None) -> list[str]:
    """-c overrides that leave your own Codex plugins, MCP servers and memories out of an agent.

    They are sent with every request (a request measured 21.4k tokens with them, 16.4k without),
    some reach past the team (a browser, computer use), and an agent's work would fill your own
    memories. Your config.toml is not changed: each agent starts with them off.
    """
    path = config or Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "config.toml"
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    off: list[str] = []
    # Codex splits a -c key at its dots and takes quotes literally: a name goes in as it is, and one it
    # would split (or another odd one) is left alone.
    plain = re.compile(r"[A-Za-z0-9_@-]+")
    for name in (data.get("plugins") or {}):
        if plain.fullmatch(name):
            off += ["-c", f"plugins.{name}.enabled=false"]
    for name in (data.get("mcp_servers") or {}):
        if name != SERVER_NAME and plain.fullmatch(name):
            off += ["-c", f"mcp_servers.{name}.enabled=false"]
    if data.get("memories") or (data.get("features") or {}).get("memories"):
        off += ["-c", "memories.use_memories=false", "-c", "memories.generate_memories=false"]
    return off


def codex_launch(hub: Hub, team_file: Path, role: str, out: Path,
                 resume: str | None = None, new_id: str | None = None, quiet: bool = False) -> Launch:
    spec = hub.team.roles[role]
    command, args, env = mcp_server(team_file, role)
    key = f"mcp_servers.{SERVER_NAME}"
    cli = [
        "-c", f"{key}.command={toml(command)}",
        "-c", f"{key}.args={toml(args)}",
        "-c", f"{key}.env={toml(env)}",
        "-c", f"{key}.tool_timeout_sec={WAIT_LIMIT}",
        "-c", f'{key}.default_tools_approval_mode="approve"',
        "-c", f"developer_instructions={toml(role_card(hub.session(role)))}",
        # several agents share one install: an update offered at start would wait for a key (and
        # replacing the program while others run it breaks them)
        "-c", "check_for_update_on_startup=false",
        *codex_extras_off(),
    ]
    # Codex asks you once to review and trust new hooks; the commands are the same for
    # every role, so one "Trust all" covers them all.
    for event, groups in hook_table(None).items():  # no matcher: pre-edit picks out edits itself
        cli += ["-c", f"hooks.{event}={toml(groups)}"]
    if spec.model:
        cli += ["-m", spec.model]
    if spec.effort:
        cli += ["-c", f"model_reasoning_effort={toml(spec.effort)}"]
    if resume:  # codex resume [OPTIONS] SESSION_ID [PROMPT]
        return Launch(role, "codex", "codex", ["resume", *cli, resume, *([] if quiet else [resume_kickoff(role)])])
    if not quiet:
        cli.append(kickoff(role))
    return Launch(role, "codex", "codex", cli)


def grok_launch(hub: Hub, team_file: Path, role: str, out: Path,
                resume: str | None = None, new_id: str | None = None, quiet: bool = False) -> Launch:
    spec = hub.team.roles[role]
    if grok_hooks_state() == "outdated":  # the owner installed them once; keep them working
        install_grok_hooks()
    # Grok loads MCP servers only from config files, so register one 'org' server in the
    # project's .grok/config.toml ("add" also updates it). The entry names no role: every
    # Grok tab passes its own AGENT_ORG_* variables on to the server it starts.
    # Grok asks you to trust the folder the first time it sees this project server.
    command, args, env = mcp_server()
    register = ["grok", "mcp", "add", "--scope", "project", SERVER_NAME, command,
                *(f"--env={k}={v}" for k, v in env.items()), "--", *args]
    cli = ["--rules", role_card(hub.session(role)), "--allow", f"MCPTool({SERVER_NAME}__*)"]
    if spec.model:
        cli += ["-m", spec.model]
    if spec.effort:
        cli += ["--reasoning-effort", spec.effort]
    if resume:
        cli += ["--resume", resume]
    elif new_id:
        cli += ["--session-id", new_id]
    if not quiet:
        cli.append(resume_kickoff(role) if resume else kickoff(role))
    return Launch(role, "grok", "grok", cli, {"GROK_DISABLE_AUTOUPDATER": "1"}, setup=[register])


AGY_EDIT_MATCHER = ("write_to_file|replace_file_content|multi_replace_file_content|code_action|file_change|"
                    "propose_code|edit_notebook|run_command")  # run_command: the command guard


def antigravity_plugin(folder: Path) -> Path:
    """Write agent-org's Antigravity plugin into `folder`: its MCP server and hooks.

    The plugin names no role: each agent's server and hooks take it from AGENT_ORG_ROLE,
    and outside agent-org terminals both do nothing (the server offers no tools, the hooks
    exit at once). Its hooks run through `cmd /c`, which strips one pair of outer quotes,
    so each command gets an extra pair.
    """
    folder.mkdir(parents=True, exist_ok=True)
    command, args, env = mcp_server()
    def run(event: str, timeout: int) -> dict[str, object]:
        command = f"{hook_command(event)} agy"
        if '"' in command:  # Antigravity runs it through cmd /c, which strips one outer pair of quotes
            command = f'"{command}"'
        return {"type": "command", "command": command, "timeout": timeout}

    files = {
        "plugin.json": {"name": "agent-org"},
        "mcp_config.json": {"mcpServers": {SERVER_NAME: {"command": command, "args": args, "env": env}}},
        "hooks.json": {"agent-org": {
            # only edits: a PreToolUse answer must carry a decision, so hooking every tool
            # would replace Antigravity's own permission handling for all of them
            "PreToolUse": [{"matcher": AGY_EDIT_MATCHER, "hooks": [run("pre-edit", 30)]}],
            "PreInvocation": [run("invocation", 30)],
            "Stop": [run("stop", STOP_WAIT + 300)],
        }},
    }
    for name, content in files.items():
        (folder / name).write_text(json.dumps(content, indent=2) + "\n", encoding="utf-8")
    return folder


def antigravity_plugin_dir() -> Path:
    from . import templates  # noqa: PLC0415 - agent-org's home folder

    return templates.home_dir() / "antigravity-plugin"


def install_antigravity_plugin() -> None:
    """Make agent-org's plugin a user-level Antigravity plugin, if it is not already the current one.

    Interactive Antigravity loads user-level plugins only (not a project's .agents/plugins), and an
    agent-org agent runs interactively - its own full terminal. Outside agent-org the plugin does
    nothing, so the owner's own `agy` sessions are not affected.
    """
    folder = antigravity_plugin(antigravity_plugin_dir())
    wanted = "".join((folder / name).read_text(encoding="utf-8") for name in ("plugin.json", "mcp_config.json", "hooks.json"))
    marker = folder / ".installed"
    agy = shutil.which("agy")
    if agy is None or os.environ.get("PYTEST_CURRENT_TEST"):  # a test never changes the real Antigravity
        return
    listed = subprocess.run([agy, "plugin", "list"], capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=60, stdin=subprocess.DEVNULL).stdout
    if '"agent-org"' in listed and marker.is_file() and marker.read_text(encoding="utf-8") == wanted:
        return
    if '"agent-org"' in listed:  # an older copy: replace it
        subprocess.run([agy, "plugin", "uninstall", "agent-org"], capture_output=True, timeout=60, stdin=subprocess.DEVNULL)
    done = subprocess.run([agy, "plugin", "install", str(folder)], capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=60, stdin=subprocess.DEVNULL)
    if done.returncode != 0:
        raise HubError(f"could not install agent-org's Antigravity plugin: {(done.stdout + done.stderr).strip()[:200]}")
    marker.write_text(wanted, encoding="utf-8")


def antigravity_kickoff(role: str, resume: bool) -> str:
    where = (" In Antigravity the team tools are on the MCP server agent-org_org (call them with call_mcp_tool); "
             "their descriptions are in your tool list.")
    return (resume_kickoff(role) if resume else kickoff(role)) + where


def antigravity_launch(hub: Hub, team_file: Path, role: str, out: Path,
                       resume: str | None = None, new_id: str | None = None, quiet: bool = False) -> Launch:
    spec = hub.team.roles[role]
    install_antigravity_plugin()
    cli: list[str] = []
    if spec.model:
        cli += ["--model", spec.model]
    if spec.effort:
        cli += ["--effort", spec.effort]
    if resume:
        cli += ["--conversation", resume]
    # Antigravity has no flag for extra instructions: the kickoff (or, quiet, the first line
    # agent-org types) sends it to my_role. Interactive: its own full terminal, typeable like any
    # agent's. Its tools and hooks come from the user-level plugin (install_antigravity_plugin);
    # the Stop hook delivers new messages.
    if not quiet:
        cli += ["-i", antigravity_kickoff(role, bool(resume))]
    return Launch(role, "antigravity", "agy", cli)


# ---- DeepSeek Harness ----
# Its terminal mode ("headless") answers one task and exits, with no hooks; agent-org's tools come
# in through its MCP client plugin, added for each role by a patch file. Its start script waits -
# with agent_org.wake, no model - until the role has a new message (or, at the start, unfinished
# tasks), then runs it, and waits again (until the role is stopped). Each run continues the same conversation
# (--session-id) and writes its steps as JSON events, which agent_org.runview shows as they
# happen: plain headless mode prints only the final answer. The `dsh` command (0.2 or later) runs
# it; without one, the desktop app's own copy (an older `dsh` cannot read the app's credentials).

DSH_EFFORTS = ("off", "low", "high", "max")
DSH_SESSION = "dsh.session"  # in a role's launch folder: the conversation its runs continue
STOP_MARKER = "stopped"  # in a role's launch folder: its start script does not run it again
QUIET_STOP_WAIT = 45  # seconds a Stop hook waits for mail in the agent-org window (the window wakes it later)


def deepseek_kickoff(role: str) -> str:
    return (f"You are the '{role}' agent in a team. Call the {SERVER_NAME} tool my_role to read your role, "
            "the message law and where you left off, then read_inbox and list_tasks, and carry on with your "
            "open tasks. When nothing is left to do, end your answer: agent-org starts you again when a new "
            f"message arrives. If you have no tool called my_role (the {SERVER_NAME} tools did not load), "
            "say so and stop: do not search the computer for it.")


def deepseek_wake(role: str) -> str:
    return (f"agent-org: '{role}', you have new messages. Call read_inbox and handle them (and list_tasks; "
            f"my_role if you need your role again). When nothing is left to do, end your answer: agent-org "
            "starts you again when a new message arrives.")


def deepseek_version(command: str, base: list[str]) -> str:
    """The dsh version, for the banner ('' if it cannot tell)."""
    for key, version in _dsh_versions.items():
        if version and key.startswith(base[0] if base else command):
            return ".".join(str(x) for x in version)
    return ""


DSH_MIN_VERSION = (0, 2)
_dsh_versions: dict[str, tuple[int, ...] | None] = {}


def dsh_cli() -> tuple[str, list[str]] | None:
    """The `dsh` command line (node and its bin.js), if one new enough is installed."""
    shim = shutil.which("dsh")
    if shim is None:
        return None
    folder = Path(shim).parent
    bin_js = folder / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
    node = str(folder / "node.exe") if (folder / "node.exe").is_file() else shutil.which("node")
    if not bin_js.is_file() or node is None:
        return None
    key = f"{bin_js}|{bin_js.stat().st_mtime}"
    if key not in _dsh_versions:
        try:
            out = subprocess.run([node, str(bin_js), "--version"], capture_output=True, text=True, timeout=60,
                                 stdin=subprocess.DEVNULL).stdout
            found = re.match(r"\s*(\d+)\.(\d+)", out)
            _dsh_versions[key] = tuple(int(x) for x in found.groups()) if found else None
        except (OSError, subprocess.SubprocessError):
            _dsh_versions[key] = None
    version = _dsh_versions[key]
    return (node, [str(bin_js)]) if version is not None and version >= DSH_MIN_VERSION else None


def deepseek_app() -> Path | None:
    """DeepSeek Harness.exe of the installed desktop app (its uninstall entry says where), if any."""
    override = os.environ.get("AGENT_ORG_DEEPSEEK_APP")
    if override:
        return Path(override) if Path(override).is_file() else None
    if os.name != "nt":
        return None
    try:
        import winreg  # noqa: PLC0415 - Windows only

        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                base = winreg.OpenKey(hive, r"Software\Microsoft\Windows\CurrentVersion\Uninstall")
            except OSError:
                continue
            with base:
                for i in range(winreg.QueryInfoKey(base)[0]):
                    try:
                        with winreg.OpenKey(base, winreg.EnumKey(base, i)) as key:
                            if not str(winreg.QueryValueEx(key, "DisplayName")[0]).startswith("DeepSeek Harness"):
                                continue
                            icon = str(winreg.QueryValueEx(key, "DisplayIcon")[0]).split(",")[0].strip('"')
                    except OSError:
                        continue
                    if icon.lower().endswith(".exe") and Path(icon).is_file():
                        return Path(icon)
    except ImportError:
        pass
    return None


def deepseek_command() -> tuple[str, list[str], dict[str, str]] | None:
    """How to run `dsh`: the `dsh` command (0.2 or later), else the desktop app's own copy (its exe as Node)."""
    cli = dsh_cli()
    if cli is not None:
        return cli[0], cli[1], {}
    app = deepseek_app()
    if app is not None:
        asar = app.parent / "resources" / "app.asar"
        if asar.is_file():
            cli = asar / "dsh" / "node_modules" / "@deepseek-ai" / "dsh-desktop-host" / "lib" / "cli.js"
            return str(app), ["--expose-internals", str(cli)], {"ELECTRON_RUN_AS_NODE": "1"}
    return None


def yaml_text(value: str) -> str:
    """A YAML single-quoted string."""
    return "'" + value.replace("'", "''") + "'"


def deepseek_patch(hub: Hub, team_file: Path, role: str) -> str:
    """The patch file that gives a DeepSeek role agent-org's tools (and its model)."""
    spec = hub.team.roles[role]
    command, args, env = mcp_server(team_file, role)
    env = {**env, "AGENT_ORG_TEAM": str(team_file), "AGENT_ORG_ROLE": role}
    lines = [
        "# agent-org: the org tools (and model) for this role. Written by agent_org.launch.",
        "- insert:",
        "    - id: agent-org-tools",
        "      name: '@deepseek-ai/dsh-mcp-client'",
        "      config:",
        f"        serverName: {SERVER_NAME}",
        "        transport: stdio",
        f"        command: {yaml_text(command)}",
        "        args: [" + ", ".join(yaml_text(a) for a in args) + "]",
        "        env:",
        *(f"          {k}: {yaml_text(v)}" for k, v in env.items()),
        f"        toolCallTimeoutMs: {(WAIT_LIMIT + 120) * 1000}",
        "        failOnStartupError: true",
    ]
    if spec.model or spec.effort:
        lines += ["- id: agent-default-model", "  config:", "    provider: deepseek-official",
                  f"    model: {yaml_text(spec.model or 'deepseek-flash')}"]
        if spec.effort:
            lines.append(f"    reasoningEffort: {yaml_text(spec.effort)}")
    return "\n".join(lines) + "\n"


def deepseek_launch(hub: Hub, team_file: Path, role: str, out: Path,
                    resume: str | None = None, new_id: str | None = None, quiet: bool = False) -> Launch:
    found = deepseek_command()
    if found is None:
        raise HubError("DeepSeek Harness is not installed (install the desktop app, or the dsh command)")
    command, base, env = found
    patch_file = out / "dsh.patch.yml"
    patch_file.write_text(deepseek_patch(hub, team_file, role), encoding="utf-8")
    session_file = out / DSH_SESSION
    if not resume:
        session_file.unlink(missing_ok=True)  # Start fresh (or its first start): a new conversation
    env = {**env, "PYTHONPATH": str(PACKAGE_ROOT), "PYTHONIOENCODING": "utf-8"}
    if os.environ.get("ALL_PROXY", os.environ.get("all_proxy", "")).lower().startswith("socks"):
        env["ALL_PROXY"] = ""  # dsh cannot use a SOCKS proxy and says so on every run; it uses HTTPS_PROXY
    dsh = " ".join(ps(a) for a in [command, *base, "--profile", "headless", "--patch", str(patch_file), "--json"])
    viewer = " ".join(ps(a) for a in [sys.executable, "-m", "agent_org.runview", "--session-file", str(session_file)])
    waiter = " ".join(ps(a) for a in [sys.executable, "-m", "agent_org.wake", "--team", str(team_file),
                                      "--role", role, "--stop", str(out / STOP_MARKER), "--input"])
    spec = hub.team.roles[role]
    shown_model = ", ".join(x for x in (spec.model or "deepseek-flash", spec.effort and f"{spec.effort} effort") if x)
    folder = hub.root_of(role)
    shown_folder = str(folder) if len(str(folder)) <= 48 else f"…\\{folder.parent.name}\\{folder.name}"
    banner = " ".join(ps(a) for a in [sys.executable, "-m", "agent_org.runview", "--banner", "DeepSeek Harness",
                                      deepseek_version(command, base), shown_model, shown_folder])
    sid = ps(str(session_file))

    marker = ps(str(out / STOP_MARKER))
    # Nothing runs at the start: the waiter returns when there is work (at once for unfinished tasks).
    # A run continues its conversation if it has one; the first run of a new one is told its role.
    script = "\n".join([
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
        f"& {banner}",
        "$first = @('--first')",
        f"while (-not (Test-Path -LiteralPath {marker})) {{",
        f"    & {waiter} @first",
        "    if ($LASTEXITCODE -ne 0) { break }",
        "    $first = @()",
        f"    $sid = if (Test-Path -LiteralPath {sid}) {{ (Get-Content -LiteralPath {sid} -Raw).Trim() }} else {{ '' }}",
        "    $resume = if ($sid) { @('--session-id', $sid) } else { @() }",
        f"    $prompt = if ($sid) {{ {ps(deepseek_wake(role))} }} else {{ {ps(deepseek_kickoff(role))} }}",
        f"    & {dsh} @resume $prompt | & {viewer}",
        "}",
    ])
    return Launch(role, "deepseek", command, [], env=env, script=script)


BUILDERS = {"claude": claude_launch, "codex": codex_launch, "grok": grok_launch,
            "antigravity": antigravity_launch, "deepseek": deepseek_launch}


def toml(value: object) -> str:
    """A TOML value for `codex -c key=value`. JSON strings are valid TOML basic strings."""
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ", ".join(f"{k} = {toml(v)}" for k, v in value.items()) + "}"
    raise TypeError(f"cannot write {type(value).__name__} as TOML")


def ps(text: str) -> str:
    """A PowerShell single-quoted literal: nothing inside is expanded."""
    return "'" + text.replace("'", "''") + "'"


def role_script(launch: Launch, team: Team, team_file: Path) -> str:
    from .terminals import network_env  # noqa: PLC0415

    # its way to the internet (agent-org's proxy, or Windows' own), as no profile sets one (tab_command)
    env = {"AGENT_ORG_TEAM": str(team_file), "AGENT_ORG_ROLE": launch.role, **network_env({}), **launch.env}
    run = launch.script or f"& {ps(launch.command)} " + " ".join(ps(a) for a in launch.args)
    return "\n".join([
        f"# agent-org: role '{launch.role}' on {launch.harness}. Written by agent_org.launch; rerunning it overwrites this.",
        f"$Host.UI.RawUI.WindowTitle = {ps(launch.role)}",
        *(f"$env:{name} = {ps(value)}" for name, value in env.items()),
        f"Set-Location -LiteralPath {ps(str(launch.cwd or team.project_root))}",
        *(" ".join(["&", *(ps(a) for a in cmd), "| Out-Null"]) for cmd in launch.setup),
        run,
        "",
    ])


def owner_script(team: Team, team_file: Path) -> str:
    return "\n".join([
        "# agent-org: the owner's console. Written by agent_org.launch.",
        f"$Host.UI.RawUI.WindowTitle = {ps(team.owner)}",
        f"$env:AGENT_ORG_TEAM = {ps(str(team_file))}",
        f"$env:PYTHONPATH = {ps(str(PACKAGE_ROOT))}",
        f"function org {{ & {ps(sys.executable)} -m agent_org.cli @args }}",
        f"Set-Location -LiteralPath {ps(str(team.project_root))}",
        "org tree",
        "Write-Host ''",
        f"Write-Host 'You are {team.owner}. Talk to the team with the org command:'",
        f"Write-Host '  org send {team.leader} \"what you want built\"   org inbox   org wait'",
        "Write-Host '  org view <role>   org locks   org --help'",
        "",
    ])


def tab_command(title: str, color: str, cwd: Path, script: Path) -> list[str]:
    # -NoProfile: the start script sets all an agent needs (its proxy comes from agent-org); your
    # PowerShell profile would slow each start and could change its network settings.
    return ["wt", "-w", WINDOW, "new-tab", "--title", title, "--suppressApplicationTitle",
            "--tabColor", color, "-d", str(cwd),
            "pwsh", "-NoLogo", "-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(script)]


def tab_parts(tab: list[str]) -> tuple[str, str, Path, list[str]]:
    """(title, color, folder, program and arguments) of a tab command, to run it elsewhere
    (in a terminal inside the agent-org window)."""
    at = tab.index("-d")
    return tab[tab.index("--title") + 1], tab[tab.index("--tabColor") + 1], Path(tab[at + 1]), tab[at + 2:]


def tab_role(tab: list[str]) -> str:
    """The role a tab command starts: its start script lives in launch/<role>/."""
    return Path(tab[-1]).parent.name


def role_tab(hub: Hub, team_file: Path, role: str, fresh: bool = False, quiet: bool = False) -> list[str]:
    """Write one role's start script and return the tab command that opens it.

    The role resumes its last conversation when it can (see plan_session). `quiet`: it starts with
    no first prompt, for the agent-org window, which wakes it when work arrives (agent_org.waker).
    """
    team = hub.team
    spec = team.roles[role]
    if spec.harness not in BUILDERS:
        raise HubError(f"{spec.harness} is not supported yet")
    out = team.database.parent / "launch" / role
    out.mkdir(parents=True, exist_ok=True)
    cwd = hub.prepare_root(role)  # branch mode: its own worktree
    resume, new_id = plan_session(hub, role, fresh)
    launch = BUILDERS[spec.harness](hub, team_file, role, out, resume, new_id, quiet=quiet)
    launch.cwd = cwd
    if quiet:  # its Stop hook lets it rest when no message comes: the window wakes it, at no cost meanwhile
        launch.env["AGENT_ORG_STOP_IDLE"] = "1"
        # A short wait catches a quick reply; then it rests at its prompt, where you can type to it (a
        # waiting hook holds your typing back, and its timer makes an idle agent look busy).
        launch.env["AGENT_ORG_STOP_WAIT"] = str(QUIET_STOP_WAIT)
    if not resume:
        hub.store.start_session(role, spec.harness, new_id)
    script = out / "start.ps1"
    (out / STOP_MARKER).unlink(missing_ok=True)  # starting it again lifts an earlier Stop
    script.write_text(role_script(launch, team, team_file), encoding="utf-8")
    title = f"{role} ({spec.tier})" if spec.is_consultant else role
    return tab_command(title, TAB_COLORS[spec.harness], cwd, script)


def prepare(hub: Hub, team_file: Path, roles: list[str], owner_tab: bool, force: bool = False,
            fresh: bool = False, limit: int = 0, quiet: bool = False) -> tuple[list[list[str]], list[str]]:
    """Write the start scripts and return (tab commands to open, reasons for roles skipped).

    A role that is already running is skipped unless `force`: a second session of the
    same role would split its messages between the two. With a `limit`, no more than
    that many agents run at once (Gas Town's scheduler).
    """
    team = hub.team
    online = hub.store.online()
    running = sum(1 for n in online if n in team.roles)
    tabs, skipped = [], []
    if owner_tab:
        script = team.database.parent / "launch" / team.owner / "start.ps1"
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text(owner_script(team, team_file), encoding="utf-8")
        tabs.append(tab_command(team.owner, TAB_COLORS["owner"], team.project_root, script))
    for role in roles:
        if online.get(role) and not force:
            skipped.append(f"{role}: already running")
            continue
        if limit and running + len(tabs) >= limit:
            skipped.append(f"{role}: {limit} agents are running already (the team's limit)")
            continue
        try:
            tabs.append(role_tab(hub, team_file, role, fresh, quiet))
        except HubError as e:
            skipped.append(f"{role}: {e}")
    return tabs, skipped


def open_tab(tab: list[str]) -> None:
    if os.environ.get("PYTEST_CURRENT_TEST"):  # a test must never start real agents
        raise HubError("refusing to open a real terminal tab inside a test")
    wt = shutil.which("wt")
    if wt is None or shutil.which("pwsh") is None:
        raise HubError("needs Windows Terminal (wt) and PowerShell 7 (pwsh) on PATH")
    subprocess.run([wt, *tab[1:]], check=True, stdin=subprocess.DEVNULL)


HARNESS_PROGRAMS = {"claude.exe", "codex.exe", "grok.exe", "agy.exe", "node.exe", "deepseek harness.exe"}


def program_name(pid: int) -> str:
    """The executable name of a running process ('' if there is none)."""
    try:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                             capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL).stdout
    except (OSError, subprocess.SubprocessError):
        return ""
    first = out.strip().splitlines()[0] if out.strip() else ""
    return first.split('","')[0].strip('"').lower() if first.startswith('"') else ""


def stop_role(hub: Hub, role: str) -> int:
    """End every running session of `role` by stopping its harness program. Returns how many.

    Only processes that are really a harness program are stopped, so a reused process id
    can never take something else down. The tab stays open at a PowerShell prompt.
    """
    stopped = 0
    marker = hub.team.database.parent / "launch" / role / STOP_MARKER
    if marker.parent.is_dir():  # a program its start script runs again (DeepSeek) stays stopped
        marker.write_text("stopped by agent-org\n", encoding="utf-8")
    sessions = hub.store.sessions_of(role)
    for pid, ppid in sessions:
        if ppid and program_name(ppid) in HARNESS_PROGRAMS:
            subprocess.run(["taskkill", "/PID", str(ppid), "/T", "/F"], capture_output=True, timeout=30,
                           stdin=subprocess.DEVNULL)
            stopped += 1
        hub.store.check_out(pid)
    if sessions and role in hub.team.roles and hub.team.roles[role].harness == "deepseek":
        stopped = 1  # one agent: a run, or its waiter between runs (which ends on the marker)
    return stopped


LAUNCHER_HEADER = "X-Agent-Org-Launcher"


def window_start(team_file: Path, role: str, timeout: float = 20.0) -> bool:
    """Ask the running agent-org window to start `role` in a terminal of its own. True if it did.

    An agent that hires a teammate or summons a consultant does it through its own tool server,
    which cannot reach the window's terminals; the window says how to reach it in instance.json.
    """
    if os.environ.get("PYTEST_CURRENT_TEST"):  # a test must never start real agents
        return False
    import urllib.request  # noqa: PLC0415

    from . import templates  # noqa: PLC0415

    try:
        info = json.loads((templates.home_dir() / "instance.json").read_text(encoding="utf-8"))
        req = urllib.request.Request(
            f"http://127.0.0.1:{int(info['port'])}/api/launcher/start", method="POST",
            data=json.dumps({"team": str(team_file), "role": role}).encode("utf-8"),
            headers={"Content-Type": "application/json", LAUNCHER_HEADER: str(info["launcher"])})
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 - our own local server
            return res.status == 200
    except (OSError, ValueError, KeyError, TypeError):
        return False


def tab_opener(team_file: Path, opener: Callable[[list[str]], None] | None = None, quiet: bool = False) -> Opener:
    """What the hub calls to show a newly summoned consultant: in its own tab, or with
    `opener` (the agent-org window opens it in a terminal of its own, `quiet`)."""

    def open_consultant(role: Role) -> None:
        if opener is None and window_start(team_file, role.name):  # an agent asked: into the window, if it runs
            return
        hub = Hub.open(team_file)  # a fresh connection sees the consultant just registered
        try:
            tab = role_tab(hub, team_file, role.name, quiet=quiet)
        finally:
            hub.close()
        (opener or open_tab)(tab)

    return open_consultant


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Open one terminal tab per role")
    parser.add_argument("--team", default="team.yaml")
    parser.add_argument("roles", nargs="*", help="roles to start (default: all)")
    parser.add_argument("--no-owner", action="store_true", help="do not open the owner's console tab")
    parser.add_argument("--dry-run", action="store_true", help="write the scripts but open nothing")
    parser.add_argument("--force", action="store_true", help="also start roles that are already running")
    parser.add_argument("--fresh", action="store_true",
                        help="start new conversations instead of resuming each role's last one")
    parser.add_argument("--install-grok-hooks", action="store_true",
                        help="install agent-org's hooks for Grok in ~/.grok/hooks, then exit")
    args = parser.parse_args(argv)

    if args.install_grok_hooks:
        print(f"installed {install_grok_hooks()}")
        return 0
    team_file = Path(args.team).resolve()
    hub = Hub.open(team_file)  # also creates the database before any agent connects
    try:
        unknown = [r for r in args.roles if r not in hub.team.roles]
        if unknown:
            print(f"not roles in this team: {', '.join(unknown)}", file=sys.stderr)
            return 2
        tabs, skipped = prepare(hub, team_file, args.roles or list(hub.base_team.roles),
                                not args.no_owner, args.force, args.fresh)
    finally:
        hub.close()
    for reason in skipped:
        print(f"skipping {reason}", file=sys.stderr)

    if args.dry_run:
        for tab in tabs:
            print(subprocess.list2cmdline(tab))
        return 0
    try:
        for tab in tabs:
            open_tab(tab)
            time.sleep(1)  # let the named window exist before the next tab joins it
    except HubError as e:
        print(e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
