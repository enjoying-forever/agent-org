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
import shutil
import subprocess
import sys
import time
import uuid
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
TAB_COLORS = {"claude": "#D97757", "codex": "#10A37F", "grok": "#8B8B8B", "antigravity": "#4285F4",
              "owner": "#F2C94C"}


@dataclass
class Launch:
    role: str
    harness: str
    command: str
    args: list[str]
    env: dict[str, str] = field(default_factory=dict)
    setup: list[list[str]] = field(default_factory=list)  # commands run first, in the project folder


def kickoff(role: str) -> str:
    return (f"You are the '{role}' agent in a team. Call the {SERVER_NAME} tool my_role to read "
            "your role, the message law and where you left off. Then carry on with your open tasks, "
            "or end your turn: new messages will be delivered to you.")


def resume_kickoff(role: str) -> str:
    return (f"agent-org: the team was restarted and you are back as '{role}'. Your role or the team "
            f"may have changed, so call the {SERVER_NAME} tool my_role first. Then read_inbox, check "
            "list_tasks, and carry on where you left off.")


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
    record = hub.store.get_session(role)
    if record is not None and record.harness == spec.harness and sessions.exists(spec.harness, record.session_id):
        return record.session_id
    found = sessions.find(spec.harness, hub.base_team.project_root, role)
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
    """The command a harness runs for one of our hooks. Quoted forward-slash paths work in every shell."""
    return f'"{Path(sys.executable).as_posix()}" "{HOOK_SCRIPT.as_posix()}" {event}'


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
    path = Path.home() / ".grok" / "hooks" / "agent-org.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"hooks": hook_table("Edit|Write|MultiEdit")}, indent=2) + "\n",
                    encoding="utf-8")
    return path


def claude_launch(hub: Hub, team_file: Path, role: str, out: Path,
                  resume: str | None = None, new_id: str | None = None) -> Launch:
    spec = hub.team.roles[role]
    card = out / "role.md"
    card.write_text(role_card(hub.session(role)) + "\n", encoding="utf-8")
    command, args, env = mcp_server(team_file, role)
    config = out / "mcp.json"
    config.write_text(json.dumps(
        {"mcpServers": {SERVER_NAME: {"type": "stdio", "command": command, "args": args, "env": env}}},
        indent=2), encoding="utf-8")
    settings = out / "settings.json"
    settings.write_text(json.dumps({"hooks": hook_table("Edit|Write|MultiEdit|NotebookEdit")}, indent=2),
                        encoding="utf-8")
    cli = ["--mcp-config", str(config), "--allowedTools", f"mcp__{SERVER_NAME}",
           "--append-system-prompt-file", str(card), "--settings", str(settings)]
    if spec.model:
        cli += ["--model", spec.model]
    if spec.effort:
        cli += ["--effort", spec.effort]
    if resume:
        cli += ["--resume", resume]
    elif new_id:
        cli += ["--session-id", new_id]
    # --mcp-config and --allowedTools take several values, so a plain option must
    # come between them and the prompt or they would swallow it.
    cli += ["--name", role, resume_kickoff(role) if resume else kickoff(role)]
    # Several agents share one Claude Code install; an update started by one tab can't
    # replace the program while the others run it, and leaves a broken install behind.
    env = {"MCP_TOOL_TIMEOUT": str(WAIT_LIMIT * 1000), "DISABLE_AUTOUPDATER": "1"}
    return Launch(role, "claude", "claude", cli, env)


def codex_launch(hub: Hub, team_file: Path, role: str, out: Path,
                 resume: str | None = None, new_id: str | None = None) -> Launch:
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
    ]
    # Codex asks you once to review and trust new hooks; the commands are the same for
    # every role, so one "Trust all" covers them all.
    for event, groups in hook_table(None).items():  # no matcher: pre-edit picks out edits itself
        cli += ["-c", f"hooks.{event}={toml(groups)}"]
    if spec.model:
        cli += ["-m", spec.model]
    if spec.effort:
        cli += ["-c", f"model_reasoning_effort={toml(spec.effort)}"]
    if resume:  # codex resume [OPTIONS] SESSION_ID PROMPT
        return Launch(role, "codex", "codex", ["resume", *cli, resume, resume_kickoff(role)])
    cli.append(kickoff(role))
    return Launch(role, "codex", "codex", cli)


def grok_launch(hub: Hub, team_file: Path, role: str, out: Path,
                resume: str | None = None, new_id: str | None = None) -> Launch:
    spec = hub.team.roles[role]
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
    cli.append(resume_kickoff(role) if resume else kickoff(role))
    return Launch(role, "grok", "grok", cli, {"GROK_DISABLE_AUTOUPDATER": "1"}, setup=[register])


def antigravity_plugin(project_root: Path) -> Path:
    """Write agent-org's Antigravity plugin into the project: its MCP server and hooks.

    Antigravity loads plugins from <project>/.agents/plugins/ once the folder is trusted.
    The plugin names no role: each tab's server and hooks take it from AGENT_ORG_ROLE,
    and outside agent-org tabs both do nothing. Its hooks run through `cmd /c`, which
    strips one pair of outer quotes, so each command gets an extra pair.
    """
    folder = project_root / ".agents" / "plugins" / "agent-org"
    folder.mkdir(parents=True, exist_ok=True)
    command, args, env = mcp_server()
    run = lambda event, timeout: {"type": "command", "command": f'"{hook_command(event)} agy"',  # noqa: E731
                                  "timeout": timeout}
    files = {
        "plugin.json": {"name": "agent-org"},
        "mcp_config.json": {"mcpServers": {SERVER_NAME: {"command": command, "args": args, "env": env}}},
        "hooks.json": {"agent-org": {
            "PreToolUse": [{"matcher": "*", "hooks": [run("pre-edit", 30)]}],
            "PreInvocation": [run("invocation", 30)],
            "Stop": [run("stop", STOP_WAIT + 300)],
        }},
    }
    for name, content in files.items():
        (folder / name).write_text(json.dumps(content, indent=2) + "\n", encoding="utf-8")
    return folder


def antigravity_launch(hub: Hub, team_file: Path, role: str, out: Path,
                       resume: str | None = None, new_id: str | None = None) -> Launch:
    spec = hub.team.roles[role]
    antigravity_plugin(hub.base_team.project_root)
    cli: list[str] = []
    if spec.model:
        cli += ["--model", spec.model]
    if spec.effort:
        cli += ["--effort", spec.effort]
    if resume:
        cli += ["--conversation", resume]
    # Antigravity has no flag for extra instructions: the kickoff sends it to my_role.
    cli += ["--prompt-interactive", resume_kickoff(role) if resume else kickoff(role)]
    return Launch(role, "antigravity", "agy", cli)


BUILDERS = {"claude": claude_launch, "codex": codex_launch, "grok": grok_launch,
            "antigravity": antigravity_launch}


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
    env = {"AGENT_ORG_TEAM": str(team_file), "AGENT_ORG_ROLE": launch.role, **launch.env}
    return "\n".join([
        f"# agent-org: role '{launch.role}' on {launch.harness}. Written by agent_org.launch; rerunning it overwrites this.",
        f"$Host.UI.RawUI.WindowTitle = {ps(launch.role)}",
        *(f"$env:{name} = {ps(value)}" for name, value in env.items()),
        f"Set-Location -LiteralPath {ps(str(team.project_root))}",
        *(" ".join(["&", *(ps(a) for a in cmd), "| Out-Null"]) for cmd in launch.setup),
        f"& {ps(launch.command)} " + " ".join(ps(a) for a in launch.args),
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
    return ["wt", "-w", WINDOW, "new-tab", "--title", title, "--suppressApplicationTitle",
            "--tabColor", color, "-d", str(cwd),
            "pwsh", "-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(script)]


def role_tab(hub: Hub, team_file: Path, role: str, fresh: bool = False) -> list[str]:
    """Write one role's start script and return the tab command that opens it.

    The role resumes its last conversation when it can (see plan_session).
    """
    team = hub.team
    spec = team.roles[role]
    if spec.harness not in BUILDERS:
        raise HubError(f"{spec.harness} is not supported yet")
    out = team.database.parent / "launch" / role
    out.mkdir(parents=True, exist_ok=True)
    resume, new_id = plan_session(hub, role, fresh)
    launch = BUILDERS[spec.harness](hub, team_file, role, out, resume, new_id)
    if not resume:
        hub.store.start_session(role, spec.harness, new_id)
    script = out / "start.ps1"
    script.write_text(role_script(launch, team, team_file), encoding="utf-8")
    title = f"{role} ({spec.tier})" if spec.is_consultant else role
    return tab_command(title, TAB_COLORS[spec.harness], team.project_root, script)


def prepare(hub: Hub, team_file: Path, roles: list[str], owner_tab: bool,
            force: bool = False, fresh: bool = False) -> tuple[list[list[str]], list[str]]:
    """Write the start scripts and return (tab commands to open, reasons for roles skipped).

    A role that is already running is skipped unless `force`: a second session of the
    same role would split its messages between the two.
    """
    team = hub.team
    online = hub.store.online()
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
        try:
            tabs.append(role_tab(hub, team_file, role, fresh))
        except HubError as e:
            skipped.append(f"{role}: {e}")
    return tabs, skipped


def open_tab(tab: list[str]) -> None:
    wt = shutil.which("wt")
    if wt is None or shutil.which("pwsh") is None:
        raise HubError("needs Windows Terminal (wt) and PowerShell 7 (pwsh) on PATH")
    subprocess.run([wt, *tab[1:]], check=True)


HARNESS_PROGRAMS = {"claude.exe", "codex.exe", "grok.exe", "agy.exe", "node.exe"}


def program_name(pid: int) -> str:
    """The executable name of a running process ('' if there is none)."""
    try:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                             capture_output=True, text=True, timeout=15).stdout
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
    for pid, ppid in hub.store.sessions_of(role):
        if ppid and program_name(ppid) in HARNESS_PROGRAMS:
            subprocess.run(["taskkill", "/PID", str(ppid), "/T", "/F"], capture_output=True, timeout=30)
            stopped += 1
        hub.store.check_out(pid)
    return stopped


def tab_opener(team_file: Path) -> Opener:
    """What the hub calls to show a newly summoned consultant in its own tab."""

    def open_consultant(role: Role) -> None:
        hub = Hub.open(team_file)  # a fresh connection sees the consultant just registered
        try:
            tab = role_tab(hub, team_file, role.name)
        finally:
            hub.close()
        open_tab(tab)

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
