"""The owner's web UI: team, tasks, messages, files, consultants, the team editor and setup.

    python -m agent_org.ui [--team path/to/team.yaml] [--port 8765] [--no-browser]

Without a team it opens on a welcome page, where you open or create one.

Only your browser can act as you through it - not other web sites, and not other programs
on this PC (the agents' shells included):
- It serves on 127.0.0.1, and refuses other Host names (DNS rebinding).
- The browser is opened with a sign-in code that works once, for two minutes; it is traded
  for an HttpOnly, SameSite=Strict session cookie. The session secret is never printed or
  put on a command line (which any process can read). Enter in its window prints a new link.
- Every API call needs that cookie plus the page's own header; POSTs must be JSON with a
  known size, and requests another site's page sends (Origin, Sec-Fetch-Site) are refused.
- Strict headers on everything: a Content-Security-Policy (only its own scripts, no framing),
  nosniff, no referrer, no caching. Errors never show internals; stalled connections time out.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from collections.abc import Callable
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import yaml

from . import doctor, gitops, launch, presets, templates, terminals, usage, wake, waker, watchdog
from .hub import BRANCH_RULE, LAW, Hub, HubError, describe_stuck
from .store import Lock, Message, Task
from .team import HARNESSES, Team, TeamError

STATIC = Path(__file__).resolve().parent / "ui_static"
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml"}
MAX_BODY = 1_000_000
NO_TEAM = "no_team"  # error the page answers by showing the welcome screen
WATCH_EVERY = 30  # seconds between watchdog patrols
AUTOSTART_GAP = 600  # seconds before the same agent is started automatically again

# Effort levels each harness accepts (suggestions in the editor; any text is allowed).
EFFORTS = {
    "claude": ["low", "medium", "high", "xhigh", "max"],
    "codex": ["minimal", "low", "medium", "high", "xhigh"],
    "grok": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    "antigravity": ["low", "medium", "high"],
    "deepseek": list(launch.DSH_EFFORTS),
}
DEEPSEEK_MODELS = ["deepseek-flash", "deepseek-v4-pro"]  # what its API accepts
# No Haiku: it has no auto mode, so a Haiku agent stops to ask you before every edit and command.
CLAUDE_MODELS = ["opus", "sonnet", "fable", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]


class ApiError(Exception):
    def __init__(self, message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


class ModelCatalog:
    """Asks each installed harness which models it offers, once, in the background."""

    def __init__(self, load: bool = True) -> None:
        self.models: dict[str, list[str]] = {"claude": CLAUDE_MODELS, "codex": [], "grok": [], "antigravity": [],
                                             "deepseek": DEEPSEEK_MODELS}
        if load:
            threading.Thread(target=self._load, daemon=True).start()

    def _load(self) -> None:
        for harness, command, parse in (
            ("codex", ["codex", "debug", "models"], _parse_codex),
            ("grok", ["grok", "models"], _parse_grok),
            ("antigravity", ["agy", "models"], _parse_agy),
        ):
            exe = shutil.which(command[0])
            if exe is None:
                continue
            try:
                out = subprocess.run([exe, *command[1:]], capture_output=True, text=True,
                                     encoding="utf-8", errors="replace", timeout=30,
                                     stdin=subprocess.DEVNULL).stdout
                self.models[harness] = parse(out)
            except (OSError, subprocess.SubprocessError, ValueError):
                pass


def _parse_codex(out: str) -> list[str]:
    data = json.loads(out)
    items = data.get("models", []) if isinstance(data, dict) else data
    return [m.get("slug") or m.get("id") for m in items if isinstance(m, dict) and (m.get("slug") or m.get("id"))]


def _parse_grok(out: str) -> list[str]:
    return [line.strip()[2:].split(" ")[0] for line in out.splitlines()
            if line.strip()[:2] in ("* ", "- ")]


def _parse_agy(out: str) -> list[str]:
    return [line.split("\t")[0] for line in out.splitlines() if "\t" in line]


def _message(m: Message) -> dict[str, Any]:
    return {"id": m.id, "sent_at": m.sent_at, "sender": m.sender, "recipient": m.recipient,
            "kind": m.kind, "text": m.text, "reply_to": m.reply_to, "read": m.read_at is not None,
            "urgent": m.urgent, "task_id": m.task_id}


def _lock(lock: Lock) -> dict[str, Any]:
    return {"path": lock.path, "owner": lock.owner, "claimed_at": lock.claimed_at}


def _task(t: Task) -> dict[str, Any]:
    return {"id": t.id, "assigner": t.assigner, "assignee": t.assignee, "title": t.title,
            "details": t.details, "state": t.state, "result": t.result, "parent_id": t.parent_id,
            "created_at": t.created_at, "updated_at": t.updated_at, "done_when": t.done_when,
            "priority": t.priority, "after": list(t.depends_on), "revisions": t.revisions,
            "checks": t.checks, "commit_id": t.commit_id}


def recent_file() -> Path:
    return Path.home() / ".agent-org" / "recent.json"


def load_recent() -> list[str]:
    try:
        data = json.loads(recent_file().read_text(encoding="utf-8"))
        return [p for p in data if isinstance(p, str)]
    except (OSError, ValueError):
        return []


def forget_recent(path: str) -> None:
    """Take a team off the recent list (its files stay as they are)."""
    paths = [p for p in load_recent() if p != path]
    recent_file().parent.mkdir(parents=True, exist_ok=True)
    recent_file().write_text(json.dumps(paths, indent=2), encoding="utf-8")


def remember_recent(team_file: Path) -> None:
    paths = [str(team_file)] + [p for p in load_recent() if Path(p) != team_file]
    recent_file().parent.mkdir(parents=True, exist_ok=True)
    recent_file().write_text(json.dumps(paths[:10], indent=2), encoding="utf-8")


class App:
    """Everything the owner can do from the browser, as plain methods returning JSON-able data."""

    def __init__(self, team_file: Path | None = None, load_models: bool = True, watch: bool = True):
        self.team_file: Path | None = None
        self._hub: Hub | None = None
        self.catalog = ModelCatalog(load_models)
        self._checks: tuple[float, list[dict[str, object]]] | None = None
        self._resumable: dict[str, tuple[str | None, bool, float]] = {}
        self._problems: tuple[float, list[dict[str, object]]] = (0.0, [])
        self._history: tuple[float, bool] = (0.0, False)
        self._autostarted: dict[str, float] = {}
        # Agents run in terminals inside the agent-org window when it can host them (Windows with
        # pywinpty); otherwise, or with AGENT_ORG_TABS=1, each opens in a Windows Terminal tab.
        self.in_window = (terminals.available() and not os.environ.get("AGENT_ORG_TABS")
                          and not os.environ.get("PYTEST_CURRENT_TEST"))
        self._hosts: dict[Path, terminals.TerminalHost] = {}  # one per team: switching teams keeps them running
        self.window = WindowControl()
        self.waker = waker.Waker()
        if watch:
            threading.Thread(target=self._watch, name="watchdog", daemon=True).start()
            if self.in_window:
                threading.Thread(target=self._wake, name="waker", daemon=True).start()
        if team_file is not None:
            self._open(team_file)

    # opening and creating teams

    @property
    def hub(self) -> Hub:
        if self._hub is None:
            raise ApiError(NO_TEAM, HTTPStatus.PRECONDITION_FAILED)
        return self._hub

    @property
    def me(self):
        return self.hub.session(self.hub.base_team.owner)

    def _open(self, team_file: Path) -> None:
        team_file = team_file.resolve()
        hub = Hub.open(team_file, opener=launch.tab_opener(team_file, self._open_tab, quiet=self.in_window))  # raises TeamError
        hub.stopper = lambda role: launch.stop_role(hub, role)
        if self._hub is not None:
            self._hub.close()
        self._hub, self.team_file = hub, team_file
        self._resumable.clear()
        remember_recent(team_file)

    @property
    def terminals(self) -> terminals.TerminalHost:
        """The terminals of the open team's agents."""
        self.hub  # noqa: B018 - needs an open team
        return self._host(self.team_file)

    def _host(self, team_file: Path) -> terminals.TerminalHost:
        """The terminals of one team's agents; their pane sizes are kept next to its hub."""
        if team_file not in self._hosts:
            try:
                sizes: Path | None = Team.load(team_file).database.parent / "terminal-sizes.json"
            except (TeamError, OSError, ValueError):
                sizes = None
            self._hosts[team_file] = terminals.TerminalHost(sizes)
        return self._hosts[team_file]

    def _open_tab(self, tab: list[str]) -> None:
        """Start an agent: in a terminal in the window, or in a Windows Terminal tab."""
        if not self.in_window:
            launch.open_tab(tab)
            return
        title, color, cwd, argv = launch.tab_parts(tab)
        self.terminals.open(launch.tab_role(tab), argv, cwd, title, color)

    def start_for_agent(self, body: dict[str, Any]) -> dict[str, Any]:
        """Start a role an agent just hired or summoned, in a terminal of this window.

        The agent's own tool server asks (launch.window_start): it cannot reach the window's
        terminals itself. Only for a team whose agents run here; otherwise it opens a tab.
        """
        team_file, role = Path(_str(body, "team")).resolve(), _str(body, "role")
        if not self.in_window or (team_file not in self._hosts and team_file != self.team_file):
            raise ApiError("that team's agents do not run in this window", HTTPStatus.CONFLICT)
        why = launch.cannot_start(in_window=True)
        if why:
            raise ApiError(why, HTTPStatus.CONFLICT)
        own = team_file == self.team_file and self._hub is not None
        hub = self._hub if own else Hub.open(team_file)
        try:
            if role not in hub.team.roles:
                raise ApiError(f"'{role}' is not a role", HTTPStatus.NOT_FOUND)
            tab = launch.role_tab(hub, team_file, role, quiet=True)
        finally:
            if not own:
                hub.close()
        title, color, cwd, argv = launch.tab_parts(tab)
        self._host(team_file).open(role, argv, cwd, title, color)
        return {"started": role}

    def term_read(self, wants: str) -> dict[str, Any]:
        """New output of the terminals the page shows. `wants` is JSON: {role: [terminal id, offset]}."""
        try:
            raw = json.loads(wants)
            parsed = {str(k): (int(v[0]), int(v[1])) for k, v in raw.items()} if isinstance(raw, dict) else None
        except (ValueError, TypeError, IndexError, KeyError):
            parsed = None
        if not parsed or len(parsed) > 64:
            raise ApiError("say which terminals: {role: [id, offset]}")
        return {"terms": self.terminals.read_many(parsed, wait=15.0)}

    def term_input(self, body: dict[str, Any]) -> dict[str, Any]:
        term = self.terminals.get(_str(body, "role"))
        data = body.get("data")
        if term is None or not isinstance(data, str) or len(data) > 65536:
            raise ApiError("That agent has no terminal here.")
        term.typed(data)
        return {}

    def open_url(self, body: dict[str, Any]) -> dict[str, Any]:
        """Open a web link from an agent's terminal in the owner's own browser (a sign-in page, say)."""
        url = _str(body, "url").strip()
        if not url.lower().startswith(("http://", "https://")) or len(url) > 4000 or any(c in url for c in "\r\n\"<> "):
            raise ApiError("Only web links (http or https) can be opened.")
        webbrowser.open(url)
        return {}

    def term_resize(self, body: dict[str, Any]) -> dict[str, Any]:
        self.terminals.resize(_str(body, "role"), int(body["cols"]), int(body["rows"]))
        return {}

    def _watch(self) -> None:
        """Patrol the open team every half minute: nudge, escalate, release expired leases."""
        while True:
            time.sleep(WATCH_EVERY)
            hub = self._hub
            if hub is None:
                continue
            try:
                hub.store.prune(wake.alive)
                problems = watchdog.patrol(hub)
                if hub.base_team.settings.autostart:
                    self._autostart(hub, problems)
            except Exception as e:  # noqa: BLE001 - a failed patrol must not end the UI
                print(f"watchdog: {e}", file=sys.stderr)

    def _wake(self) -> None:
        """Type a line into agents resting at their prompt when work waits for them (agent_org.waker)."""
        hubs: dict[Path, Hub] = {}  # its own connections: a team you switched away from keeps running
        while True:
            time.sleep(waker.EVERY)
            for team_file, host in list(self._hosts.items()):
                if not any(term.alive for _, term in host.items()):
                    continue
                try:
                    if team_file not in hubs:
                        hubs[team_file] = Hub.open(team_file)
                    self.waker.tick(hubs[team_file], host)
                except Exception as e:  # noqa: BLE001 - a failed look must not end the UI
                    print(f"waker: {e}", file=sys.stderr)
                    stale = hubs.pop(team_file, None)  # opened afresh next time (team.yaml may have changed)
                    if stale is not None:
                        stale.close()

    def _autostart(self, hub: Hub, problems: list[watchdog.Problem]) -> None:
        """Start agents that have work but are not running (Gas Town's 'sling'), within the cap,
        and restart agents left idle at their prompt by a usage limit that has reset or an API error."""
        if launch.cannot_start(self.in_window):
            return  # nothing could start (the Launch button says why)
        now = time.time()
        for p in problems:
            if p.kind not in ("stopped", "stuck") or now - self._autostarted.get(p.role, 0) < AUTOSTART_GAP:
                continue
            if hub.team.roles[p.role].harness not in launch.BUILDERS:
                continue
            if p.kind == "stuck":
                launch.stop_role(hub, p.role)
                if hub.store.online().get(p.role):  # its program did not stop: leave it for a while
                    self._autostarted[p.role] = now
                    hub.event("agent", p.role, "could not be restarted automatically: its program did not stop")
                    continue
            tabs, _ = launch.prepare(hub, self.team_file, [p.role], owner_tab=False,
                                     limit=hub.base_team.settings.max_running, quiet=self.in_window)
            if not tabs:
                continue  # at the cap: it waits for a free place
            self._autostarted[p.role] = now
            self._open_tab(tabs[0])
            hub.event("agent", p.role, "restarted automatically: it was stuck with work waiting" if p.kind == "stuck"
                      else "started automatically: it has work waiting")

    def history(self) -> bool:
        """Whether the project keeps git history (cached: it runs git)."""
        if time.time() - self._history[0] > 30:
            self._history = (time.time(), gitops.is_own_repo(self.hub.base_team.project_root))
        return self._history[1]

    def enable_history(self, body: dict[str, Any]) -> dict[str, Any]:
        state = gitops.init(self.hub.base_team.project_root)
        self._history = (0.0, False)
        self.hub.event("git", self.hub.base_team.owner, "turned history on")
        return {"history": state}

    def task_changes(self, task_id: int) -> dict[str, Any]:
        task, _ = self.me.task_details(task_id)  # the owner may see every task; this checks it exists
        files = self.hub.store.task_files(task_id)
        if self.hub.branches:  # landed: the merge into main; still working: its branch against main
            root = self.hub.base_team.project_root
            try:
                diff = (gitops.commit_diff(root, task.commit_id) if task.commit_id
                        else gitops.branch_diff(self.hub.root_of(task.assignee), gitops.main_branch(root))
                        if (self.hub.root_of(task.assignee) / ".git").exists() else "")
            except (OSError, RuntimeError, subprocess.SubprocessError):
                diff = ""
            return {"files": files, "history": True, "diff": diff, "branch": True}
        return {"files": files, "history": self.history(),
                "diff": gitops.diff(self.hub.base_team.project_root, files) if self.history() else ""}

    def problems(self) -> list[dict[str, object]]:
        if time.time() - self._problems[0] > 5:
            self._problems = (time.time(), [p.to_dict() for p in watchdog.patrol(self.hub, act=False)])
        return self._problems[1]

    def close(self) -> None:
        if self._hub is not None:
            self._hub.close()
        self._hub = self.team_file = None

    def live_agents(self) -> list[str]:
        """Agents running in this window's terminals, in any team."""
        return [name for host in self._hosts.values() for name, t in host.listing().items() if t["alive"]]

    def window_action(self, body: dict[str, Any]) -> dict[str, Any]:
        action = _str(body, "action")
        if action == "hide":
            self.window.hide()
        elif action == "quit":
            self.window.quit()
        elif action == "show":
            self.window.show()
        else:
            raise ApiError("action must be hide, quit or show")
        return {}

    def shutdown(self) -> None:
        """agent-org is ending: its agents' terminals end with it."""
        self.close()
        for host in self._hosts.values():
            host.close_all()

    def home(self) -> dict[str, Any]:
        recent = [{"path": p, "name": Path(p).parent.name, "exists": Path(p).is_file()} for p in load_recent()]
        return {"open": self._hub is not None, "team_file": str(self.team_file or ""),
                "recent": recent, "templates": templates.catalogue(), "default": templates.default_template()}

    def open_team(self, body: dict[str, Any]) -> dict[str, Any]:
        path = Path(_str(body, "path").strip().strip('"'))
        if path.is_dir():
            path = path / "team.yaml"
        if not path.is_file():
            raise ApiError(f"There is no team.yaml at {path}. Create a team there instead.")
        try:
            self._open(path)
        except TeamError as e:
            raise ApiError(f"That team.yaml has a problem: {e}") from None
        return {"team_file": str(self.team_file)}

    def create_team(self, body: dict[str, Any]) -> dict[str, Any]:
        folder = Path(_str(body, "folder").strip().strip('"'))
        picked = body.get("roles")
        template = "" if picked else _str(body, "template")
        if not picked and template not in templates.ids():
            raise ApiError(f"Unknown team template '{template}'.")
        if not folder.is_absolute():
            raise ApiError("Choose a full folder path, for example E:\\projects\\my-app.")
        team_file = folder / "team.yaml"
        if team_file.exists() and not body.get("overwrite"):
            raise ApiError(f"{team_file} already exists. Open it instead, or choose another folder.")
        config = self._team_from_roles(picked) if picked else templates.team_config(template)
        try:
            Team.from_dict(config, base_dir=folder)
        except TeamError as e:
            raise ApiError(f"That team is not complete yet: {e}") from None
        folder.mkdir(parents=True, exist_ok=True)
        team_file.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True, width=100), encoding="utf-8")
        self._open(team_file)
        return {"team_file": str(self.team_file)}

    @staticmethod
    def _team_from_roles(picked: object) -> dict[str, Any]:
        """A team.yaml built from market roles: [{id, name, superior}], superiors by name ('you' = leader)."""
        if not isinstance(picked, list) or not picked:
            raise ApiError("Pick at least one role for the team.")
        roles: dict[str, Any] = {}
        for item in picked:
            if not isinstance(item, dict):
                raise ApiError("Each picked role needs an id, a name and whom it reports to.")
            try:
                name = str(item.get("name") or "").strip() or presets.role_name(str(item.get("id")), set(roles))
                roles[name] = presets.team_role(str(item.get("id")), str(item.get("superior") or "you"))
            except KeyError:
                raise ApiError(f"There is no role '{item.get('id')}' in the market.") from None
        return {"owner": "you", "project_root": ".", "roles": roles, "consultants": templates.CONSULTANTS}

    def desktop_shortcut(self, body: dict[str, Any]) -> dict[str, Any]:
        """Put an 'agent-org' shortcut on the Windows desktop that opens this UI."""
        starter = launch.PACKAGE_ROOT / "agent-org-ui.cmd"
        script = (
            "$s = (New-Object -ComObject WScript.Shell).CreateShortcut("
            "[IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'agent-org.lnk')); "
            f"$s.TargetPath = {launch.ps(str(starter))}; "
            f"$s.WorkingDirectory = {launch.ps(str(starter.parent))}; "
            "$s.Description = 'Run your team of AI agents'; $s.Save(); $s.FullName")
        shell = shutil.which("pwsh") or shutil.which("powershell")
        if shell is None:
            raise ApiError("PowerShell is needed to create the shortcut.")
        r = subprocess.run([shell, "-NoProfile", "-Command", script], capture_output=True, text=True, timeout=60,
                           stdin=subprocess.DEVNULL)
        if r.returncode != 0:
            raise ApiError(f"Could not create the shortcut: {r.stderr.strip()[:300]}")
        return {"shortcut": r.stdout.strip()}

    def forget_recent(self, body: dict[str, Any]) -> dict[str, Any]:
        forget_recent(_str(body, "path"))
        return {}

    def close_team(self, body: dict[str, Any]) -> dict[str, Any]:
        self.close()
        return {"open": False}

    def pick_folder(self, body: dict[str, Any]) -> dict[str, Any]:
        """Show Windows' own folder picker on this computer and return what was chosen."""
        try:
            import tkinter
            from tkinter import filedialog
        except ImportError:
            raise ApiError("The folder picker is not available here; type the folder path instead.") from None
        root = tkinter.Tk()
        try:
            root.withdraw()
            root.attributes("-topmost", True)
            chosen = filedialog.askdirectory(parent=root, title=body.get("title") or "Choose a folder",
                                             mustexist=False)
        finally:
            root.destroy()
        return {"path": str(Path(chosen)) if chosen else ""}

    # setup checks

    def checks(self, fresh: bool = False) -> dict[str, Any]:
        used = {r.harness for r in self._hub.team.roles.values()} if self._hub else None
        if fresh or self._checks is None or time.time() - self._checks[0] > 60:
            self._checks = (time.time(), [c.to_dict() for c in doctor.run_checks(used)])
        return {"checks": self._checks[1]}

    def install_grok_hooks(self, body: dict[str, Any]) -> dict[str, Any]:
        path = launch.install_grok_hooks()
        self._checks = None
        return {"installed": str(path)}

    # reading

    def _resumes(self, role: str, harness: str) -> bool:
        """Whether the role's next start resumes a conversation (cached: it looks at files)."""
        record = self.hub.store.get_session(role)
        sid = record.session_id if record and record.harness == harness else None
        cached = self._resumable.get(role)
        if cached and cached[0] == sid and time.time() - cached[2] < (30 if sid else 300):
            return cached[1]
        found = launch.resumable_session(self.hub, role) is not None
        self._resumable[role] = (sid, found, time.time())
        return found

    def state(self) -> dict[str, Any]:
        team = self.hub.team
        store = self.hub.store
        statuses = store.statuses()
        unread = store.unread_counts()
        locks = store.locks()
        store.prune(wake.alive)  # a process killed with its terminal is not a second session
        online = store.online()
        open_tasks = store.tasks(open_only=True)
        stuck = self.hub.stuck()
        terms = self.terminals.listing() if self.in_window else {}
        roles = []
        for name in [team.leader, *team.subtree_of(team.leader)]:
            r = team.roles[name]
            s = statuses.get(name)
            consultant = store.get_consultant(name) if r.is_consultant else None
            roles.append({
                "name": name, "superior": r.superior, "harness": r.harness, "model": r.model,
                "effort": r.effort, "duties": r.duties, "write_scope": list(r.write_scope),
                "tier": r.tier, "help_id": consultant.help_id if consultant else None,
                "status": {"state": s.state, "task": s.task, "updated_at": s.updated_at} if s else None,
                "unread": unread.get(name, 0),
                "locks": [lock.path for lock in locks if lock.owner == name],
                "online": online.get(name, 0),
                "open_tasks": sum(1 for t in open_tasks if t.assignee == name),
                "notes": store.get_notes(name),
                "resumes": self._resumes(name, r.harness),
                "usage": self._usage(name, r.harness),
                "stuck": ({**stuck[name], "describe": describe_stuck(stuck[name])} if name in stuck else None),
                "terminal": terms.get(name),
            })
        recent_tasks = store.tasks(limit=60)
        return {
            "owner": team.owner,
            "leader": team.leader,
            "project_root": str(team.project_root),
            "team_file": str(self.team_file),
            "roles": roles,
            "tiers": [{"name": t.name, "harness": t.harness, "model": t.model, "effort": t.effort,
                       "use_for": t.use_for, "max_active": t.max_active,
                       "active": sum(1 for r in roles if r["tier"] == t.name)}
                      for t in team.tiers.values()],
            "locks": [_lock(x) for x in locks],
            "tasks": [_task(t) for t in recent_tasks],
            "problems": self.problems(),
            "history": self.history(),
            "settings": {"autostart": team.settings.autostart, "max_running": team.settings.max_running,
                         "commit_on_accept": team.settings.commit_on_accept,
                         "isolation": team.settings.isolation,
                         "team_changes": team.settings.team_changes,
                         "checks": [c.name for c in team.checks]},
            "last_event": store.last_event_id(),
            "owner_unread": unread.get(team.owner, 0),
            "launchable": list(launch.BUILDERS),
            "in_window": self.in_window,
        }

    def _usage(self, role: str, harness: str) -> dict[str, object] | None:
        """Everything the role has used: every conversation it has had (a fresh start keeps the count),
        in whichever program it ran then, and its DeepSeek runs."""
        parts = [found for h, sid in self.hub.store.conversations(role) if h != "deepseek"
                 for found in [usage.usage(h, sid)] if found is not None]
        dsh = self.hub.team.database.parent / "launch" / role / usage.DSH_USAGE
        if dsh.is_file():
            parts.append(usage.deepseek(dsh))
        if not parts:
            return None
        record = self.hub.store.get_session(role)
        current = usage.usage(harness, record.session_id) if record and record.harness == harness else None
        return {**usage.total(parts).to_dict(), "conversations": len(parts),
                "limits": current.limits if current else []}

    def events(self, after: int) -> dict[str, Any]:
        return {"events": [{"id": e.id, "at": e.at, "kind": e.kind, "role": e.role, "text": e.text,
                            "task_id": e.task_id} for e in self.hub.store.events_after(after)]}

    def task_details(self, task_id: int) -> dict[str, Any]:
        task, thread = self.me.task_details(task_id)
        return {"task": _task(task), "thread": [_message(m) for m in thread],
                "dependents": [_task(t) for t in self.hub.store.dependents(task_id)]}

    def search(self, words: str) -> dict[str, Any]:
        return {"messages": [_message(m) for m in self.me.search(words, 60)]}

    def messages(self, after: int) -> dict[str, Any]:
        return {"messages": [_message(m) for m in self.hub.store.messages_after(after)]}

    def law(self) -> dict[str, Any]:
        branches = self._hub is not None and self.hub.branches
        rules = [BRANCH_RULE if branches and t == "One writer per file" else (t, r) for t, r in LAW]
        return {"law": [{"title": t, "rule": r} for t, r in rules]}

    def team_config(self) -> dict[str, Any]:
        self.hub  # noqa: B018 - needs an open team
        data = yaml.safe_load(self.team_file.read_text(encoding="utf-8")) or {}
        return {"config": data, "harnesses": list(HARNESSES), "models": self.catalog.models,
                "efforts": EFFORTS, "presets": presets.catalogue()}

    # acting as the owner

    def send(self, body: dict[str, Any]) -> dict[str, Any]:
        to, text, urgent = _str(body, "to"), _str(body, "text"), bool(body.get("urgent"))
        if to == "@all":
            return {"sent": [_message(m) for m in self.me.broadcast("@all", text, urgent)]}
        return {"sent": [_message(self.me.send(to, text, body.get("reply_to"), urgent))]}

    def assign(self, body: dict[str, Any]) -> dict[str, Any]:
        return _task(self.me.assign_task(
            _str(body, "to"), _str(body, "title"), body.get("details") or "", None,
            body.get("done_when") or "", [int(x) for x in body.get("after") or []], int(body.get("priority") or 2)))

    def review(self, body: dict[str, Any]) -> dict[str, Any]:
        return _task(self.me.review_task(int(body["task_id"]), bool(body.get("accept")), body.get("feedback") or ""))

    def cancel_task(self, body: dict[str, Any]) -> dict[str, Any]:
        return _task(self.me.cancel_task(int(body["task_id"]), body.get("reason") or ""))

    def reassign(self, body: dict[str, Any]) -> dict[str, Any]:
        return _task(self.me.reassign_task(int(body["task_id"]), _str(body, "to"), body.get("reason") or ""))

    def restart(self, body: dict[str, Any]) -> dict[str, Any]:
        """Stop a role's agent and start it again on the same conversation (after a limit or an error)."""
        role = _str(body, "role")
        if role not in self.hub.team.roles:
            raise ApiError(f"'{role}' is not a role")
        why = launch.cannot_start(self.in_window)
        if why:
            raise ApiError(why)  # before stopping it: it could not come back
        stopped = launch.stop_role(self.hub, role)
        result = self.launch({"roles": [role]})
        self.hub.event("agent", role, "restarted by the owner")
        return {"stopped": stopped, **result}

    def summon(self, body: dict[str, Any]) -> dict[str, Any]:
        role = self.me.summon_consultant(int(body["help_id"]), _str(body, "tier"), body.get("brief") or "")
        return {"name": role.name, "tier": role.tier, "superior": role.superior}

    def dismiss(self, body: dict[str, Any]) -> dict[str, Any]:
        role, returned = self.me.dismiss_consultant(_str(body, "name"))
        return {"name": role.name, "returned": returned}

    def release(self, body: dict[str, Any]) -> dict[str, Any]:
        return _lock(self.me.release(_str(body, "path")))

    def read_inbox(self, body: dict[str, Any]) -> dict[str, Any]:
        return {"messages": [_message(m) for m in self.me.read_inbox()]}

    def launch(self, body: dict[str, Any]) -> dict[str, Any]:
        """Open terminal tabs: the given roles, or every role in team.yaml.

        Each role resumes its last conversation unless `fresh`; roles that are already
        running are skipped unless `force`.
        """
        team = self.hub.team
        names = body.get("roles") or list(self.hub.base_team.roles)
        for name in names:
            if name not in team.roles:
                raise ApiError(f"'{name}' is not a role")
        why = launch.cannot_start(self.in_window)
        if why:
            raise ApiError(why)
        tabs, skipped = launch.prepare(self.hub, self.team_file, names, owner_tab=False,
                                       force=bool(body.get("force")), fresh=bool(body.get("fresh")),
                                       limit=self.hub.base_team.settings.max_running, quiet=self.in_window)
        self._resumable.clear()

        in_window = self.in_window
        opener = self._open_tab if in_window else launch.open_tab  # fixed now: the thread outlives this call

        def open_all() -> None:
            for tab in tabs:
                try:
                    opener(tab)
                except (HubError, OSError, subprocess.SubprocessError) as e:
                    print(f"could not open a tab: {e}", file=sys.stderr)
                if not in_window:
                    time.sleep(1)  # let the named window exist before the next tab joins it

        threading.Thread(target=open_all, daemon=True).start()
        return {"opening": [t[t.index("--title") + 1] for t in tabs], "skipped": skipped}

    def stop(self, body: dict[str, Any]) -> dict[str, Any]:
        """Stop one role's agent, or every running agent (role '@all')."""
        role = _str(body, "role")
        team = self.hub.team
        names = [n for n in team.roles if self.hub.store.online().get(n)] if role == "@all" else [role]
        if role != "@all" and role not in team.roles:
            raise ApiError(f"'{role}' is not a role")
        return {"stopped": {n: launch.stop_role(self.hub, n) for n in names}}

    def save_template(self, body: dict[str, Any]) -> dict[str, Any]:
        """Keep the open team (as saved in team.yaml) to start new projects from."""
        config = yaml.safe_load(self.team_file.read_text(encoding="utf-8")) or {}
        try:
            template = templates.save(_str(body, "name"), config, bool(body.get("default")))
        except ValueError as e:
            raise ApiError(str(e)) from None
        return {"template": template, "default": templates.default_template()}

    # the Role Market

    def roles(self) -> dict[str, Any]:
        return {"roles": presets.catalogue(), "harnesses": list(HARNESSES), "models": self.catalog.models,
                "efforts": EFFORTS, "deleted_built_ins": len(presets.hidden()), "team_open": self._hub is not None,
                "team_roles": list(self.hub.team.roles) if self._hub is not None else [],
                "owner": self.hub.base_team.owner if self._hub is not None else ""}

    def role_save(self, body: dict[str, Any]) -> dict[str, Any]:
        role = body.get("role")
        if not isinstance(role, dict):
            raise ApiError("send the role's settings")
        try:
            preset = presets.save(str(role.get("title") or ""), role, body.get("id") or None)
        except presets.RoleError as e:
            raise ApiError(str(e)) from None
        return {"id": preset, "roles": presets.catalogue()}

    def role_duplicate(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            preset = presets.duplicate(_str(body, "id"))
        except KeyError:
            raise ApiError("There is no such role.") from None
        return {"id": preset, "roles": presets.catalogue()}

    def role_import(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            preset = presets.import_text(_str(body, "text"))
        except presets.RoleError as e:
            raise ApiError(str(e)) from None
        return {"id": preset, "roles": presets.catalogue()}

    def role_export(self, preset: str) -> dict[str, Any]:
        try:
            filename, text = presets.export_text(preset)
        except KeyError:
            raise ApiError("There is no such role.") from None
        return {"filename": filename, "text": text}

    def role_place(self, body: dict[str, Any]) -> dict[str, Any]:
        """Put a market role into the open team, under `superior` (the owner makes it the leader)."""
        preset, superior = _str(body, "id"), _str(body, "superior")
        team = self.hub.team
        if superior != team.owner and superior not in team.roles:
            raise ApiError(f"'{superior}' is not in this team")
        try:
            name = (body.get("name") or "").strip() or presets.role_name(preset, set(team.roles))
            spec = presets.team_role(preset, superior)
        except KeyError:
            raise ApiError("There is no such role.") from None
        if name in team.roles or name == team.owner:
            raise ApiError(f"There is already a '{name}' in the team.")

        def add(config: dict[str, Any]) -> None:
            config.setdefault("roles", {})[name] = spec

        self.hub.edit_team(add)
        self.hub.event("team", team.owner, f"placed {name} ({spec['harness']}) under {superior} from the Role Market")
        return {"name": name}

    def save_preset(self, body: dict[str, Any]) -> dict[str, Any]:
        """Keep one role's settings in the library, to reuse in any team."""
        role = body.get("role")
        if not isinstance(role, dict):
            raise ApiError("send the role's settings")
        try:
            preset = presets.save(_str(body, "name"), role)
        except ValueError as e:
            raise ApiError(str(e)) from None
        return {"preset": preset, "presets": presets.catalogue()}

    def delete_preset(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            presets.delete(_str(body, "id"))
        except KeyError:
            raise ApiError("There is no such role.") from None
        return {"presets": presets.catalogue()}

    def role_reset(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            presets.reset(_str(body, "id"))
        except KeyError:
            raise ApiError("Only a ready-made role can be reset.") from None
        return {"roles": presets.catalogue()}

    def role_restore(self, body: dict[str, Any]) -> dict[str, Any]:
        return {"restored": presets.restore(), "roles": presets.catalogue()}

    def default_template(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            templates.set_default(_str(body, "id"))
        except KeyError:
            raise ApiError("There is no such team.") from None
        return {"default": templates.default_template()}

    def delete_template(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            templates.delete(_str(body, "id"))
        except KeyError:
            raise ApiError("Only your own saved teams can be deleted.") from None
        return {"default": templates.default_template()}

    # one teammate at a time (its card on the Team page, and dragging in the team list)

    def teammate_update(self, body: dict[str, Any]) -> dict[str, Any]:
        """Change one teammate in team.yaml: its program, model, effort, duties, instructions, files
        or whom it reports to. An empty value removes the setting (its program's default)."""
        name = _str(body, "name")
        changes = body.get("changes")
        if not isinstance(changes, dict) or not changes:
            raise ApiError("say what to change")
        unknown = set(changes) - set(TEAMMATE_FIELDS)
        if unknown:
            raise ApiError(f"cannot change {', '.join(sorted(unknown))} here")
        if name not in self.hub.base_team.roles:
            raise ApiError(f"'{name}' is not in team.yaml (a consultant comes from its tier: change that in Edit team)")
        for key, value in changes.items():
            if key == "write_scope":
                if isinstance(value, str):
                    value = [x.strip() for x in value.replace("\n", ",").split(",") if x.strip()]
                if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
                    raise ApiError("files must be a list of patterns")
                changes[key] = value
            elif value is not None and not isinstance(value, str):
                raise ApiError(f"'{key}' must be text")
        if not changes.get("superior", "x") or not changes.get("harness", "x"):
            raise ApiError("a teammate needs a program and someone to report to")

        def change(config: dict[str, Any]) -> None:
            role = config.setdefault("roles", {})[name]
            for key, value in changes.items():
                if value in ("", None, []) and key != "write_scope":
                    role.pop(key, None)
                else:
                    role[key] = value.strip() if isinstance(value, str) else value

        try:
            self.hub.edit_team(change)
        except HubError as e:
            raise ApiError(str(e)) from None
        self.hub.event("team", self.hub.base_team.owner, f"changed {name}: {', '.join(sorted(changes))}")
        return {"name": name}

    def teammate_remove(self, body: dict[str, Any]) -> dict[str, Any]:
        """Take a teammate out of team.yaml; the ones who reported to it now report to its superior."""
        name = _str(body, "name")
        team = self.hub.base_team
        if name not in team.roles:
            raise ApiError(f"'{name}' is not in team.yaml")
        if self.hub.store.online().get(name):
            raise ApiError(f"{name} is running: stop it first.")
        # its unfinished tasks would stay open with nobody to do them (and keep their assigners waiting)
        busy = self.hub.store.tasks(assignee=name, open_only=True)
        if busy:
            raise ApiError(f"{name} still has unfinished tasks ({', '.join(f'#{t.id}' for t in busy)}): move them "
                           "to someone else or cancel them first (Tasks).")
        superior = team.roles[name].superior

        def change(config: dict[str, Any]) -> None:
            roles = config.setdefault("roles", {})
            roles.pop(name, None)
            for spec in roles.values():
                if isinstance(spec, dict) and spec.get("superior") == name:
                    spec["superior"] = superior

        try:
            self.hub.edit_team(change)
        except HubError as e:
            raise ApiError(str(e)) from None
        for lock in self.hub.store.locks(name):
            self.hub.store.release(self.hub.lock_key(lock.path)[0])
        self.hub.event("team", team.owner, f"removed {name} from the team")
        return {"removed": name, "moved_to": superior}

    def save_team(self, body: dict[str, Any]) -> dict[str, Any]:
        config = body.get("config")
        try:
            team = Team.from_dict(config, base_dir=self.team_file.parent)
        except TeamError as e:
            raise ApiError(str(e)) from None
        if team.database != self.hub.base_team.database:
            raise ApiError("changing 'database' from the UI is not supported")
        backup = self.team_file.with_suffix(self.team_file.suffix + ".bak")
        backup.write_text(self.team_file.read_text(encoding="utf-8"), encoding="utf-8")
        self.team_file.write_text(
            yaml.safe_dump(config, sort_keys=False, allow_unicode=True, width=100), encoding="utf-8")
        self.hub.base_team = team
        return {"saved": str(self.team_file), "backup": str(backup)}


def _str(body: dict[str, Any], key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ApiError(f"'{key}' is required")
    return value


GET_ROUTES = {
    "/api/home": lambda app, q: app.home(),
    "/api/state": lambda app, q: app.state(),
    "/api/messages": lambda app, q: app.messages(int(q.get("after", ["0"])[0])),
    "/api/team": lambda app, q: app.team_config(),
    "/api/law": lambda app, q: app.law(),
    "/api/checks": lambda app, q: app.checks(fresh=q.get("fresh", ["0"])[0] == "1"),
    "/api/events": lambda app, q: app.events(int(q.get("after", ["0"])[0])),
    "/api/task": lambda app, q: app.task_details(int(q["id"][0])),
    "/api/search": lambda app, q: app.search(q.get("q", [""])[0]),
    "/api/task-changes": lambda app, q: app.task_changes(int(q["id"][0])),
    "/api/roles": lambda app, q: app.roles(),
    "/api/role-export": lambda app, q: app.role_export(q.get("id", [""])[0]),
    "/api/terms": lambda app, q: app.term_read(q.get("w", [""])[0]),
}
POST_ROUTES = {
    "/api/open": App.open_team, "/api/create": App.create_team, "/api/close": App.close_team,
    "/api/forget-recent": App.forget_recent,
    "/api/pick-folder": App.pick_folder, "/api/install-grok-hooks": App.install_grok_hooks,
    "/api/desktop-shortcut": App.desktop_shortcut,
    "/api/send": App.send, "/api/task": App.assign, "/api/cancel-task": App.cancel_task,
    "/api/summon": App.summon, "/api/dismiss": App.dismiss, "/api/release": App.release,
    "/api/inbox/read": App.read_inbox, "/api/launch": App.launch, "/api/stop": App.stop,
    "/api/team": App.save_team, "/api/review": App.review, "/api/history": App.enable_history,
    "/api/reassign": App.reassign, "/api/restart": App.restart, "/api/save-template": App.save_template,
    "/api/default-template": App.default_template, "/api/delete-template": App.delete_template,
    "/api/save-preset": App.save_preset, "/api/delete-preset": App.delete_preset,
    "/api/role-save": App.role_save, "/api/role-duplicate": App.role_duplicate,
    "/api/role-delete": App.delete_preset, "/api/role-import": App.role_import, "/api/role-place": App.role_place,
    "/api/role-reset": App.role_reset, "/api/role-restore": App.role_restore,
    "/api/term-input": App.term_input, "/api/term-resize": App.term_resize, "/api/open-url": App.open_url,
    "/api/window": App.window_action,
    "/api/teammate": App.teammate_update, "/api/teammate-remove": App.teammate_remove,
}


COOKIE = "agent_org_session"
CODE_TTL = 120  # seconds a sign-in link works (and it works once)
PAGE_HEADER = "X-Agent-Org"  # the page sends it; a form or a plain link from another site cannot
SECURITY_HEADERS = {
    "Content-Security-Policy": ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                                "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; "
                                "form-action 'self'; frame-ancestors 'none'"),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
}


LAUNCHER_HEADER = launch.LAUNCHER_HEADER
TEAMMATE_FIELDS = ("harness", "model", "effort", "duties", "instructions", "write_scope", "superior")


class WindowControl:
    """agent-org's window: hidden while its agents run in the background, shown again when the
    owner starts agent-org a second time (that launcher holds `launcher`, a secret good for
    nothing but asking to be shown), and closed for good."""

    def __init__(self) -> None:
        self.window = None  # the pywebview window, when there is one
        self.launcher = secrets.token_urlsafe(32)
        self.quitting = False
        self.sign_in: Callable[[], str] | None = None  # a fresh sign-in link, for the browser

    def show(self) -> str:
        if self.window is None:
            if self.sign_in is not None:
                webbrowser.open(self.sign_in())
            return "browser"
        self.window.show()
        try:
            self.window.restore()  # if it was minimized
        except Exception:  # noqa: BLE001 - not minimized, or not supported
            pass
        return "window"

    def hide(self) -> None:
        if self.window is None:
            raise ApiError("agent-org is not running in a window.")
        self.window.hide()
        print("agent-org keeps running in the background with its agents. "
              "Start agent-org again (agent-org-ui.cmd) to bring the window back.", flush=True)

    def quit(self) -> None:
        if self.window is None:
            raise ApiError("agent-org is not running in a window.")
        self.quitting = True
        self.window.destroy()


class Access:
    """Who may use the page: the browser you signed in with, and nobody else.

    The session secret never leaves this process except as an HttpOnly cookie. What the
    browser is opened with is a sign-in code that works once and for two minutes, so even
    a program that reads the browser's command line (any process on the PC can) is too late.
    """

    def __init__(self, session: str | None = None):
        self.session = session or secrets.token_urlsafe(32)
        self._codes: dict[str, float] = {}
        self._lock = threading.Lock()

    def new_code(self) -> str:
        code = secrets.token_urlsafe(24)
        with self._lock:
            now = time.time()
            self._codes = {c: t for c, t in self._codes.items() if t > now}
            self._codes[code] = now + CODE_TTL
        return code

    def redeem(self, code: str) -> bool:
        with self._lock:
            expires = self._codes.pop(code, 0)
        return expires > time.time()

    def cookie_ok(self, header: str) -> bool:
        for part in header.split(";"):
            name, _, value = part.strip().partition("=")
            if name == COOKIE and secrets.compare_digest(value, self.session):
                return True
        return False


def make_handler(app: App, access: Access, port_holder: list[int]) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "agent-org"
        sys_version = ""
        timeout = 30  # a stalled or very slow connection is dropped

        def log_message(self, fmt: str, *args: Any) -> None:
            if self.command != "GET":  # polling would drown out everything else
                sys.stderr.write(f"{time.strftime('%H:%M:%S')} {self.command} {urlparse(self.path).path}\n")

        def _origin(self) -> str:
            return f"http://127.0.0.1:{port_holder[0]}"

        def _host_ok(self) -> bool:
            # refuse other Host names, so a web page can't reach this server through DNS rebinding
            port = port_holder[0]
            return self.headers.get("Host", "") in (f"127.0.0.1:{port}", f"localhost:{port}")

        def _same_site(self) -> bool:
            """The request comes from this page (or is typed/opened directly), never from another site."""
            origin = self.headers.get("Origin")
            if origin is not None and origin not in (self._origin(), f"http://localhost:{port_holder[0]}"):
                return False
            return self.headers.get("Sec-Fetch-Site", "same-origin") in ("same-origin", "none")

        def _signed_in(self) -> bool:
            if secrets.compare_digest(self.headers.get("X-Org-Token", ""), access.session):
                return True  # a program that started this server itself (tests, scripts)
            return access.cookie_ok(self.headers.get("Cookie", "")) and self.headers.get(PAGE_HEADER) == "1"

        def _send(self, status: HTTPStatus, body: bytes, content_type: str,
                  extra: dict[str, str] | None = None) -> None:
            try:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                for name, value in {**SECURITY_HEADERS, **(extra or {})}.items():
                    self.send_header(name, value)
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                self.close_connection = True  # the page went away (closed, reloaded) while it waited

        def _json(self, status: HTTPStatus, data: Any) -> None:
            self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")

        def _api(self, routes: dict, path: str, arg: Any) -> None:
            if not self._same_site():
                return self._json(HTTPStatus.FORBIDDEN, {"error": "requests must come from the agent-org page"})
            if not self._signed_in():
                return self._json(HTTPStatus.FORBIDDEN, {"error": "not signed in"})
            route = routes.get(path)
            if route is None:
                return self._json(HTTPStatus.NOT_FOUND, {"error": f"no such endpoint: {path}"})
            self._call(lambda: route(app, arg), path)

        def _call(self, run: Callable[[], Any], path: str) -> None:
            """Answer with what `run` returns, or with its error - never a traceback."""
            try:
                self._json(HTTPStatus.OK, run())
            except ApiError as e:
                self._json(e.status, {"error": str(e)})
            except HubError as e:
                self._json(HTTPStatus.CONFLICT, {"error": str(e)})
            except TeamError as e:
                self._json(HTTPStatus.BAD_REQUEST, {"error": f"team problem: {e}"})
            except (KeyError, ValueError, TypeError) as e:
                self._json(HTTPStatus.BAD_REQUEST, {"error": f"bad request: {e}"})
            except Exception as e:  # noqa: BLE001 - never a traceback to the browser
                print(f"error in {path}: {e!r}", file=sys.stderr)
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "something went wrong; see the agent-org window"})

        def do_GET(self) -> None:
            if not self._host_ok():
                return self._send(HTTPStatus.FORBIDDEN, b"bad host", "text/plain")
            url = urlparse(self.path)
            if url.path.startswith("/api/"):
                return self._api(GET_ROUTES, url.path, parse_qs(url.query))
            code = parse_qs(url.query).get("code", [""])[0]
            if url.path == "/" and code:  # a sign-in link: trade the one-time code for the session cookie
                if access.redeem(code):
                    cookie = f"{COOKIE}={access.session}; HttpOnly; SameSite=Strict; Path=/"
                    return self._send(HTTPStatus.SEE_OTHER, b"", "text/plain", {"Location": "/", "Set-Cookie": cookie})
                return self._send(HTTPStatus.SEE_OTHER, b"", "text/plain", {"Location": "/"})  # used or expired
            name = "index.html" if url.path == "/" else url.path.removeprefix("/static/")
            file = STATIC / name
            if "/" in name or "\\" in name or not file.is_file() or file.suffix not in CONTENT_TYPES:
                return self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")
            self._send(HTTPStatus.OK, file.read_bytes(), CONTENT_TYPES[file.suffix])

        do_HEAD = do_GET

        def do_POST(self) -> None:
            if not self._host_ok():
                return self._send(HTTPStatus.FORBIDDEN, b"bad host", "text/plain")
            if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
                return self._json(HTTPStatus.LENGTH_REQUIRED, {"error": "send the body with a Content-Length"})
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                return self._json(HTTPStatus.LENGTH_REQUIRED, {"error": "Content-Length is required"})
            if length < 0:
                return self._json(HTTPStatus.BAD_REQUEST, {"error": "bad Content-Length"})
            if length > MAX_BODY:
                return self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "too large"})
            if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
                return self._json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "the body must be JSON"})
            if not self._same_site():  # before reading anything from a cross-site request
                return self._json(HTTPStatus.FORBIDDEN, {"error": "requests must come from the agent-org page"})
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except (json.JSONDecodeError, UnicodeDecodeError, RecursionError):
                return self._json(HTTPStatus.BAD_REQUEST, {"error": "body must be JSON"})
            if not isinstance(body, dict):
                return self._json(HTTPStatus.BAD_REQUEST, {"error": "body must be a JSON object"})
            path = urlparse(self.path).path
            if path == "/api/launcher/show":  # agent-org started again: show this one's window instead
                if not secrets.compare_digest(self.headers.get(LAUNCHER_HEADER, ""), app.window.launcher):
                    return self._json(HTTPStatus.FORBIDDEN, {"error": "not this agent-org's launcher"})
                return self._json(HTTPStatus.OK, {"shown": app.window.show()})
            if path == "/api/launcher/start":  # an agent hired one or summoned a consultant: start it here
                if not secrets.compare_digest(self.headers.get(LAUNCHER_HEADER, ""), app.window.launcher):
                    return self._json(HTTPStatus.FORBIDDEN, {"error": "not this agent-org's launcher"})
                return self._call(lambda: app.start_for_agent(body), path)
            self._api(POST_ROUTES, path, body)

        def do_PUT(self) -> None:
            self._send(HTTPStatus.METHOD_NOT_ALLOWED, b"not allowed", "text/plain", {"Allow": "GET, HEAD, POST"})

        do_DELETE = do_PATCH = do_OPTIONS = do_PUT  # no CORS preflight is ever answered

    return Handler


def serve(team_file: Path | None, port: int, token: str | None = None,
          load_models: bool = True, watch: bool = True) -> tuple[ThreadingHTTPServer, App, Access]:
    """Build the server (not started). Port 0 picks a free port. `token` fixes the session secret
    (for programs that talk to the API themselves with an X-Org-Token header)."""
    app = App(team_file, load_models, watch)
    access = Access(token)
    port_holder = [port]
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app, access, port_holder))
    server.daemon_threads = True
    port_holder[0] = server.server_address[1]
    return server, app, access


def window_state_file() -> Path:
    return templates.home_dir() / "window" / "state.json"


def load_window_state() -> dict[str, Any]:
    """Where and how big the window was last time ({} the first time)."""
    try:
        state = json.loads(window_state_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(state, dict):
        return {}
    return {k: v for k, v in state.items() if k in ("x", "y", "width", "height", "maximized")
            and (isinstance(v, bool) if k == "maximized" else isinstance(v, int))}


def window_geometry(state: dict[str, Any], screens: list[tuple[int, int, int, int]]) -> dict[str, Any]:
    """create_window arguments from the saved state: its size (at least the minimum), and its
    place only if that is still on one of the `screens` (x, y, width, height) - a monitor may be gone."""
    geo: dict[str, Any] = {"width": max(900, state.get("width", 1520)), "height": max(600, state.get("height", 950)),
                           "maximized": bool(state.get("maximized"))}
    x, y = state.get("x"), state.get("y")
    if x is not None and y is not None and any(sx <= x + 40 < sx + sw and sy <= y + 10 < sy + sh
                                               for sx, sy, sw, sh in screens):
        geo.update(x=x, y=y)
    return geo


def open_window(url: str, control: WindowControl | None = None,
                live_agents: Callable[[], list[str]] = list) -> None:
    """Show agent-org in a window of its own (Windows' WebView2, through pywebview), until it is
    closed, where and as big as it was last time. Closing it while agents run asks first (keep them
    running in the background, or stop them). Raises ImportError or RuntimeError when there is no
    such window to be had."""
    import webview  # noqa: PLC0415 - optional: without it, agent-org opens in the browser

    state = load_window_state()
    try:
        screens = [(int(getattr(m, "x", 0)), int(getattr(m, "y", 0)), int(m.width), int(m.height)) for m in webview.screens]
    except Exception:  # noqa: BLE001 - no screen list: keep the size, let Windows place it
        screens = []
    window = webview.create_window("agent-org", url, min_size=(900, 600), background_color="#0B0C0F",
                                   text_select=True, **window_geometry(state, screens))
    control = control or WindowControl()
    control.window = window

    def normal() -> bool:
        """The window shows at its own size and place: not maximized or minimized. Windows reports
        the move to the maximized place before pywebview's maximized event comes, so ask it."""
        if state.get("maximized"):
            return False
        try:
            import ctypes  # noqa: PLC0415 - Windows only

            hwnd = int(window.native.Handle.ToInt64())
            return not (ctypes.windll.user32.IsZoomed(hwnd) or ctypes.windll.user32.IsIconic(hwnd))
        except Exception:  # noqa: BLE001 - not on Windows' own window: trust the events
            return True

    def resized(width: int, height: int) -> None:
        if normal():
            state.update(width=int(width), height=int(height))

    def moved(x: int, y: int) -> None:
        if normal():
            state.update(x=int(x), y=int(y))

    def save() -> None:
        try:
            window_state_file().parent.mkdir(parents=True, exist_ok=True)
            window_state_file().write_text(json.dumps(state), encoding="utf-8")
        except OSError:
            pass

    window.events.resized += resized
    window.events.moved += moved
    window.events.maximized += lambda: state.update(maximized=True)
    window.events.restored += lambda: state.update(maximized=False)
    def ask() -> None:
        """The page asks (keep running, stop and quit, or cancel); without a page, Windows does."""
        try:
            asked = window.evaluate_js("typeof askClose === 'function' ? (askClose(), 'asked') : 'no page'")
        except Exception:  # noqa: BLE001 - the page is not there
            asked = None
        if asked != "asked" and window.create_confirmation_dialog(
                "Close agent-org?", "Agents are running in its terminals. Stop them and close agent-org? "
                                    "(Their conversations are kept: Start resumes them.)"):
            control.quit()

    def closing() -> bool:
        save()
        if control.quitting or not live_agents():
            return True
        threading.Thread(target=ask, daemon=True).start()  # never wait for the page inside this event
        return False  # stays open until the owner chooses

    window.events.closing += closing
    storage = templates.home_dir() / "window"
    storage.mkdir(parents=True, exist_ok=True)
    webview.start(private_mode=False, storage_path=str(storage))


def instance_file() -> Path:
    """Where a running agent-org says how a second launcher can reach it."""
    return templates.home_dir() / "instance.json"


def show_running(timeout: float = 3.0) -> bool:
    """Ask an agent-org that is already running to show its window. True if one did."""
    try:
        info = json.loads(instance_file().read_text(encoding="utf-8"))
        req = urllib.request.Request(
            f"http://127.0.0.1:{int(info['port'])}/api/launcher/show", data=b"{}", method="POST",
            headers={"Content-Type": "application/json", LAUNCHER_HEADER: str(info["launcher"])})
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 - our own local server
            return res.status == 200
    except (OSError, ValueError, KeyError, TypeError):
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="agent-org: its window (or web page)")
    parser.add_argument("--team", help="team.yaml to open (default: the welcome page)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--browser", action="store_true", help="open in the web browser instead of a window")
    parser.add_argument("--no-browser", action="store_true", help="open nothing; print the sign-in link")
    args = parser.parse_args(argv)
    team_file = Path(args.team).resolve() if args.team else None
    if not args.no_browser and show_running():
        print("agent-org is already running: its window is back in front.")
        return 0
    try:
        server, app, token = serve(team_file, args.port)
    except TeamError as e:
        print(f"team error: {e}", file=sys.stderr)
        return 2
    except OSError:
        try:  # the usual port is taken (another agent-org?): use any free one
            server, app, token = serve(team_file, 0)
        except OSError as e:
            print(f"cannot start agent-org: {e}", file=sys.stderr)
            return 1
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    print("agent-org is running." + (f" Team: {app.team_file}" if app.team_file else ""))

    def new_links() -> None:
        for _ in sys.stdin:
            print(f"  {base}?code={token.new_code()}   (works once, for two minutes)")

    threading.Thread(target=new_links, daemon=True).start()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    app.window.sign_in = lambda: f"{base}?code={token.new_code()}"
    try:
        instance_file().parent.mkdir(parents=True, exist_ok=True)
        instance_file().write_text(json.dumps({"pid": os.getpid(), "port": server.server_address[1],
                                               "launcher": app.window.launcher}), encoding="utf-8")
    except OSError:
        pass
    try:
        if not args.browser and not args.no_browser:
            print("Its window is open. Closing it with agents running asks whether to keep them running.")
            print("Press Enter here for a sign-in link, to open it in a browser too.")
            try:
                open_window(f"{base}?code={token.new_code()}", app.window, app.live_agents)
                return 0
            except Exception as e:  # noqa: BLE001 - no WebView2 or pywebview: the browser still works
                print(f"cannot open a window ({e}); opening the browser instead", file=sys.stderr)
        print("Keep this window open while you use agent-org: closing it ends agent-org and the agents")
        print("in its terminals. Sign-in links work once, for two minutes; press Enter here for a new one.")
        if args.no_browser:
            print(f"  {base}?code={token.new_code()}")
        else:
            webbrowser.open(f"{base}?code={token.new_code()}")
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        app.shutdown()
        try:
            if json.loads(instance_file().read_text(encoding="utf-8")).get("pid") == os.getpid():
                instance_file().unlink()
        except (OSError, ValueError):
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
