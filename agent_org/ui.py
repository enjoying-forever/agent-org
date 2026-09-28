"""The owner's web UI: org chart, messages, file locks, consultants and the team editor.

    python -m agent_org.ui --team path/to/team.yaml [--port 8765] [--no-browser]

It serves on 127.0.0.1 only and opens your browser. The page is opened with a
token in its URL and every API call must carry it, so other programs on this
machine (including the agents' shells) can't act as you through it.
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

from . import launch
from .hub import Hub, HubError
from .store import Lock, Message
from .team import HARNESSES, Team, TeamError

STATIC = Path(__file__).resolve().parent / "ui_static"
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml"}
MAX_BODY = 1_000_000

# Effort levels each harness accepts (suggestions in the editor; any text is allowed).
EFFORTS = {
    "claude": ["low", "medium", "high", "xhigh", "max"],
    "codex": ["minimal", "low", "medium", "high", "xhigh"],
    "grok": [],
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
            "kind": m.kind, "text": m.text, "reply_to": m.reply_to, "read": m.read_at is not None}


def _lock(lock: Lock) -> dict[str, Any]:
    return {"path": lock.path, "owner": lock.owner, "claimed_at": lock.claimed_at}


class App:
    """Everything the owner can do from the browser, as plain methods returning JSON-able data."""

    def __init__(self, team_file: Path, load_models: bool = True):
        self.team_file = team_file
        self.hub = Hub.open(team_file, opener=launch.tab_opener(team_file))
        self.catalog = ModelCatalog(load_models)

    @property
    def me(self):
        return self.hub.session(self.hub.base_team.owner)

    # reading

    def state(self) -> dict[str, Any]:
        team = self.hub.team
        store = self.hub.store
        statuses = store.statuses()
        unread = store.unread_counts()
        locks = store.locks()
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
            })
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
            "owner_unread": unread.get(team.owner, 0),
            "launchable": list(launch.BUILDERS),
        }

    def messages(self, after: int) -> dict[str, Any]:
        return {"messages": [_message(m) for m in self.hub.store.messages_after(after)]}

    def team_config(self) -> dict[str, Any]:
        data = yaml.safe_load(self.team_file.read_text(encoding="utf-8")) or {}
        return {"config": data, "harnesses": list(HARNESSES), "models": self.catalog.models,
                "efforts": EFFORTS}

    # acting as the owner

    def send(self, body: dict[str, Any]) -> dict[str, Any]:
        return _message(self.me.send(_str(body, "to"), _str(body, "text"), body.get("reply_to")))

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
        """Open terminal tabs: the given roles, or every role in team.yaml."""
        team = self.hub.team
        names = body.get("roles") or list(self.hub.base_team.roles)
        tabs, skipped = [], []
        for name in names:
            if name not in team.roles:
                raise ApiError(f"'{name}' is not a role")
            try:
                tabs.append(launch.role_tab(self.hub, self.team_file, name))
            except HubError as e:
                skipped.append(f"{name}: {e}")

        def open_all() -> None:
            for tab in tabs:
                try:
                    launch.open_tab(tab)
                except (HubError, OSError, subprocess.SubprocessError) as e:
                    print(f"could not open a tab: {e}", file=sys.stderr)
                time.sleep(1)  # let the named window exist before the next tab joins it

        threading.Thread(target=open_all, daemon=True).start()
        return {"opening": [t[t.index("--title") + 1] for t in tabs], "skipped": skipped}

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


GET_ROUTES = {"/api/state": lambda app, q: app.state(),
              "/api/messages": lambda app, q: app.messages(int(q.get("after", ["0"])[0])),
              "/api/team": lambda app, q: app.team_config()}
POST_ROUTES = {"/api/send": App.send, "/api/summon": App.summon, "/api/dismiss": App.dismiss,
               "/api/release": App.release, "/api/inbox/read": App.read_inbox,
               "/api/launch": App.launch, "/api/team": App.save_team}


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


def serve(team_file: Path, port: int, token: str | None = None,
          load_models: bool = True) -> tuple[ThreadingHTTPServer, App, str]:
    """Build the server (not started). Port 0 picks a free port."""
    app = App(team_file, load_models)
    token = token or secrets.token_urlsafe(24)
    port_holder = [port]
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app, token, port_holder))
    port_holder[0] = server.server_address[1]
    return server, app, token


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="The agent-org web UI")
    parser.add_argument("--team", default="team.yaml")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)
    try:
        server, app, token = serve(Path(args.team).resolve(), args.port)
    except TeamError as e:
        print(f"team error: {e}", file=sys.stderr)
        return 2
    except OSError as e:
        print(f"cannot listen on port {args.port}: {e}. Try --port 0 for any free port.", file=sys.stderr)
        return 1
    url = f"http://127.0.0.1:{server.server_address[1]}/?token={token}"
    print(f"agent-org UI for {app.team_file}\n  {url}\nKeep this window open; press Ctrl+C to stop.")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.hub.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
