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
from dataclasses import dataclass, field
from pathlib import Path

from .cards import SERVER_NAME, role_card
from .hub import Hub, HubError, Opener
from .team import Role, Team

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
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


def kickoff(role: str) -> str:
    return (f"You are the '{role}' agent in a team. Call the {SERVER_NAME} tool my_role to read "
            "your role and the rules, then call wait_for_messages and act on what arrives.")


def mcp_server(team_file: Path, role: str) -> tuple[str, list[str], dict[str, str]]:
    """The command every harness runs to start this role's hub connection."""
    args = ["-m", "agent_org.mcp_server", "--team", str(team_file), "--role", role]
    return sys.executable, args, {"PYTHONPATH": str(PACKAGE_ROOT)}


def claude_launch(hub: Hub, team_file: Path, role: str, out: Path) -> Launch:
    spec = hub.team.roles[role]
    card = out / "role.md"
    card.write_text(role_card(hub.session(role)) + "\n", encoding="utf-8")
    command, args, env = mcp_server(team_file, role)
    config = out / "mcp.json"
    config.write_text(json.dumps(
        {"mcpServers": {SERVER_NAME: {"type": "stdio", "command": command, "args": args, "env": env}}},
        indent=2), encoding="utf-8")
    cli = ["--mcp-config", str(config), "--allowedTools", f"mcp__{SERVER_NAME}",
           "--append-system-prompt-file", str(card)]
    if spec.model:
        cli += ["--model", spec.model]
    if spec.effort:
        cli += ["--effort", spec.effort]
    # --mcp-config and --allowedTools take several values, so a plain option must
    # come between them and the prompt or they would swallow it.
    cli += ["--name", role, kickoff(role)]
    return Launch(role, "claude", "claude", cli, {"MCP_TOOL_TIMEOUT": str(WAIT_LIMIT * 1000)})


def codex_launch(hub: Hub, team_file: Path, role: str, out: Path) -> Launch:
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
    if spec.model:
        cli += ["-m", spec.model]
    if spec.effort:
        cli += ["-c", f"model_reasoning_effort={toml(spec.effort)}"]
    cli.append(kickoff(role))
    return Launch(role, "codex", "codex", cli)


BUILDERS = {"claude": claude_launch, "codex": codex_launch}


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


def role_tab(hub: Hub, team_file: Path, role: str) -> list[str]:
    """Write one role's start script and return the tab command that opens it."""
    team = hub.team
    spec = team.roles[role]
    if spec.harness not in BUILDERS:
        raise HubError(f"{spec.harness} is not supported yet")
    out = team.database.parent / "launch" / role
    out.mkdir(parents=True, exist_ok=True)
    launch = BUILDERS[spec.harness](hub, team_file, role, out)
    script = out / "start.ps1"
    script.write_text(role_script(launch, team, team_file), encoding="utf-8")
    title = f"{role} ({spec.tier})" if spec.is_consultant else role
    return tab_command(title, TAB_COLORS[spec.harness], team.project_root, script)


def prepare(hub: Hub, team_file: Path, roles: list[str], owner_tab: bool) -> list[list[str]]:
    """Write every start script and return the tab commands that would open them."""
    team = hub.team
    tabs = []
    if owner_tab:
        script = team.database.parent / "launch" / team.owner / "start.ps1"
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text(owner_script(team, team_file), encoding="utf-8")
        tabs.append(tab_command(team.owner, TAB_COLORS["owner"], team.project_root, script))
    for role in roles:
        try:
            tabs.append(role_tab(hub, team_file, role))
        except HubError as e:
            print(f"skipping {role}: {e}", file=sys.stderr)
    return tabs


def open_tab(tab: list[str]) -> None:
    wt = shutil.which("wt")
    if wt is None or shutil.which("pwsh") is None:
        raise HubError("needs Windows Terminal (wt) and PowerShell 7 (pwsh) on PATH")
    subprocess.run([wt, *tab[1:]], check=True)


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
    args = parser.parse_args(argv)

    team_file = Path(args.team).resolve()
    hub = Hub.open(team_file)  # also creates the database before any agent connects
    try:
        unknown = [r for r in args.roles if r not in hub.team.roles]
        if unknown:
            print(f"not roles in this team: {', '.join(unknown)}", file=sys.stderr)
            return 2
        tabs = prepare(hub, team_file, args.roles or list(hub.base_team.roles), not args.no_owner)
    finally:
        hub.close()

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
