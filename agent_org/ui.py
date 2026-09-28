"""The owner's web UI: team, tasks, messages, files, consultants, the team editor and setup.

    python -m agent_org.ui [--team path/to/team.yaml] [--port 8765] [--no-browser]

Without a team it opens on a welcome page, where you open or create one. It serves on
127.0.0.1 only and opens your browser. The page is opened with a token in its URL and
every API call must carry it, so other programs on this machine (including the agents'
shells) can't act as you through it.
"""

from __future__ import annotations

import argparse
import json
import secrets
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import yaml

from . import doctor, launch, templates, usage, watchdog
from .hub import LAW, Hub, HubError
from .store import Lock, Message, Task
from .team import HARNESSES, Team, TeamError

STATIC = Path(__file__).resolve().parent / "ui_static"
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml"}
MAX_BODY = 1_000_000
NO_TEAM = "no_team"  # error the page answers by showing the welcome screen
WATCH_EVERY = 30  # seconds between watchdog patrols

# Effort levels each harness accepts (suggestions in the editor; any text is allowed).
EFFORTS = {
    "claude": ["low", "medium", "high", "xhigh", "max"],
    "codex": ["minimal", "low", "medium", "high", "xhigh"],
    "grok": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    "antigravity": ["low", "medium", "high"],
}
CLAUDE_MODELS = ["opus", "sonnet", "fable", "haiku", "claude-opus-5-5", "claude-sonnet-5",
                 "claude-fable-5-1", "claude-haiku-4-5"]


class ApiError(Exception):
    def __init__(self, message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


class ModelCatalog:
    """Asks each installed harness which models it offers, once, in the background."""

    def __init__(self, load: bool = True) -> None:
        self.models: dict[str, list[str]] = {"claude": CLAUDE_MODELS, "codex": [], "grok": [], "antigravity": []}
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
                                     encoding="utf-8", errors="replace", timeout=30).stdout
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
            "priority": t.priority, "after": list(t.depends_on), "revisions": t.revisions}


def recent_file() -> Path:
    return Path.home() / ".agent-org" / "recent.json"


def load_recent() -> list[str]:
    try:
        data = json.loads(recent_file().read_text(encoding="utf-8"))
        return [p for p in data if isinstance(p, str)]
    except (OSError, ValueError):
        return []


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
        if watch:
            threading.Thread(target=self._watch, name="watchdog", daemon=True).start()
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
        hub = Hub.open(team_file, opener=launch.tab_opener(team_file))  # raises TeamError
        if self._hub is not None:
            self._hub.close()
        self._hub, self.team_file = hub, team_file
        self._resumable.clear()
        remember_recent(team_file)

    def _watch(self) -> None:
        """Patrol the open team every half minute: nudge, escalate, release expired leases."""
        while True:
            time.sleep(WATCH_EVERY)
            hub = self._hub
            if hub is None:
                continue
            try:
                watchdog.patrol(hub)
            except Exception as e:  # noqa: BLE001 - a failed patrol must not end the UI
                print(f"watchdog: {e}", file=sys.stderr)

    def problems(self) -> list[dict[str, object]]:
        if time.time() - self._problems[0] > 5:
            self._problems = (time.time(), [p.to_dict() for p in watchdog.patrol(self.hub, act=False)])
        return self._problems[1]

    def close(self) -> None:
        if self._hub is not None:
            self._hub.close()
        self._hub = self.team_file = None

    def home(self) -> dict[str, Any]:
        recent = [{"path": p, "name": Path(p).parent.name, "exists": Path(p).is_file()} for p in load_recent()]
        return {"open": self._hub is not None, "team_file": str(self.team_file or ""),
                "recent": recent, "templates": templates.catalogue()}

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
        template = _str(body, "template")
        if template not in templates.TEMPLATES:
            raise ApiError(f"Unknown team template '{template}'.")
        if not folder.is_absolute():
            raise ApiError("Choose a full folder path, for example E:\\projects\\my-app.")
        team_file = folder / "team.yaml"
        if team_file.exists() and not body.get("overwrite"):
            raise ApiError(f"{team_file} already exists. Open it instead, or choose another folder.")
        folder.mkdir(parents=True, exist_ok=True)
        team_file.write_text(yaml.safe_dump(templates.team_config(template), sort_keys=False,
                                            allow_unicode=True, width=100), encoding="utf-8")
        self._open(team_file)
        return {"team_file": str(self.team_file)}

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
        r = subprocess.run([shell, "-NoProfile", "-Command", script], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise ApiError(f"Could not create the shortcut: {r.stderr.strip()[:300]}")
        return {"shortcut": r.stdout.strip()}

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
        online = store.online()
        open_tasks = store.tasks(open_only=True)
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
            "last_event": store.last_event_id(),
            "owner_unread": unread.get(team.owner, 0),
            "launchable": list(launch.BUILDERS),
        }

    def _usage(self, role: str, harness: str) -> dict[str, object] | None:
        record = self.hub.store.get_session(role)
        if record is None or record.harness != harness:
            return None
        found = usage.usage(harness, record.session_id)
        return found.to_dict() if found else None

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
        return {"law": [{"title": t, "rule": r} for t, r in LAW]}

    def team_config(self) -> dict[str, Any]:
        self.hub  # noqa: B018 - needs an open team
        data = yaml.safe_load(self.team_file.read_text(encoding="utf-8")) or {}
        return {"config": data, "harnesses": list(HARNESSES), "models": self.catalog.models,
                "efforts": EFFORTS}

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
        tabs, skipped = launch.prepare(self.hub, self.team_file, names, owner_tab=False,
                                       force=bool(body.get("force")), fresh=bool(body.get("fresh")))
        self._resumable.clear()

        def open_all() -> None:
            for tab in tabs:
                try:
                    launch.open_tab(tab)
                except (HubError, OSError, subprocess.SubprocessError) as e:
                    print(f"could not open a tab: {e}", file=sys.stderr)
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
}
POST_ROUTES = {
    "/api/open": App.open_team, "/api/create": App.create_team, "/api/close": App.close_team,
    "/api/pick-folder": App.pick_folder, "/api/install-grok-hooks": App.install_grok_hooks,
    "/api/desktop-shortcut": App.desktop_shortcut,
    "/api/send": App.send, "/api/task": App.assign, "/api/cancel-task": App.cancel_task,
    "/api/summon": App.summon, "/api/dismiss": App.dismiss, "/api/release": App.release,
    "/api/inbox/read": App.read_inbox, "/api/launch": App.launch, "/api/stop": App.stop,
    "/api/team": App.save_team, "/api/review": App.review,
}


def make_handler(app: App, token: str, port_holder: list[int]) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "agent-org"

        def log_message(self, fmt: str, *args: Any) -> None:
            if self.command != "GET":  # polling would drown out everything else
                sys.stderr.write(f"{time.strftime('%H:%M:%S')} {self.command} {self.path}\n")

        def _host_ok(self) -> bool:
            # refuse other Host names, so a web page can't reach this server through DNS rebinding
            port = port_holder[0]
            return self.headers.get("Host", "") in (f"127.0.0.1:{port}", f"localhost:{port}")

        def _send(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: HTTPStatus, data: Any) -> None:
            self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")

        def _api(self, routes: dict, path: str, arg: Any) -> None:
            if not secrets.compare_digest(self.headers.get("X-Org-Token", ""), token):
                return self._json(HTTPStatus.FORBIDDEN, {"error": "missing or wrong token"})
            route = routes.get(path)
            if route is None:
                return self._json(HTTPStatus.NOT_FOUND, {"error": f"no such endpoint: {path}"})
            try:
                self._json(HTTPStatus.OK, route(app, arg))
            except ApiError as e:
                self._json(e.status, {"error": str(e)})
            except HubError as e:
                self._json(HTTPStatus.CONFLICT, {"error": str(e)})
            except TeamError as e:
                self._json(HTTPStatus.BAD_REQUEST, {"error": f"team problem: {e}"})
            except (KeyError, ValueError, TypeError) as e:
                self._json(HTTPStatus.BAD_REQUEST, {"error": f"bad request: {e}"})

        def do_GET(self) -> None:
            if not self._host_ok():
                return self._send(HTTPStatus.FORBIDDEN, b"bad host", "text/plain")
            url = urlparse(self.path)
            if url.path.startswith("/api/"):
                return self._api(GET_ROUTES, url.path, parse_qs(url.query))
            name = "index.html" if url.path == "/" else url.path.removeprefix("/static/")
            file = STATIC / name
            if "/" in name or "\\" in name or not file.is_file() or file.suffix not in CONTENT_TYPES:
                return self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")
            self._send(HTTPStatus.OK, file.read_bytes(), CONTENT_TYPES[file.suffix])

        def do_POST(self) -> None:
            if not self._host_ok():
                return self._send(HTTPStatus.FORBIDDEN, b"bad host", "text/plain")
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "too large"})
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                return self._json(HTTPStatus.BAD_REQUEST, {"error": "body must be JSON"})
            if not isinstance(body, dict):
                return self._json(HTTPStatus.BAD_REQUEST, {"error": "body must be a JSON object"})
            self._api(POST_ROUTES, urlparse(self.path).path, body)

    return Handler


def serve(team_file: Path | None, port: int, token: str | None = None,
          load_models: bool = True, watch: bool = True) -> tuple[ThreadingHTTPServer, App, str]:
    """Build the server (not started). Port 0 picks a free port."""
    app = App(team_file, load_models, watch)
    token = token or secrets.token_urlsafe(24)
    port_holder = [port]
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app, token, port_holder))
    port_holder[0] = server.server_address[1]
    return server, app, token


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="The agent-org web UI")
    parser.add_argument("--team", help="team.yaml to open (default: the welcome page)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)
    team_file = Path(args.team).resolve() if args.team else None
    try:
        server, app, token = serve(team_file, args.port)
    except TeamError as e:
        print(f"team error: {e}", file=sys.stderr)
        return 2
    except OSError:
        try:  # the usual port is taken (another agent-org window?): use any free one
            server, app, token = serve(team_file, 0)
        except OSError as e:
            print(f"cannot start the UI: {e}", file=sys.stderr)
            return 1
    url = f"http://127.0.0.1:{server.server_address[1]}/?token={token}"
    print("agent-org is running." + (f" Team: {app.team_file}" if app.team_file else ""))
    print(f"  {url}")
    print("Keep this window open while you use agent-org; close it to stop the page (not the agents).")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
