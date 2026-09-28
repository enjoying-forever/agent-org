import json
from pathlib import Path
import threading
import urllib.error
import urllib.request

import pytest
import yaml

from agent_org import launch, ui

from .conftest import TEAM, FakeOpener


@pytest.fixture
def server(tmp_path, monkeypatch):
    (tmp_path / "project").mkdir()
    team_file = tmp_path / "team.yaml"
    team_file.write_text(yaml.safe_dump(TEAM, sort_keys=False), encoding="utf-8")
    opened_tabs = []
    monkeypatch.setattr(launch, "open_tab", opened_tabs.append)
    srv, app, token = ui.serve(team_file, 0, token="secret", load_models=False)
    app.hub.opener = FakeOpener()
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    port = srv.server_address[1]

    class Client:
        base = f"http://127.0.0.1:{port}"

        def __init__(self):
            self.app, self.team_file, self.opened_tabs = app, team_file, opened_tabs

        def request(self, path, body=None, token="secret", host=None):
            headers = {"X-Org-Token": token} if token else {}
            if host:
                headers["Host"] = host
            data = None
            if body is not None:
                data = json.dumps(body).encode()
                headers["Content-Type"] = "application/json"
            req = urllib.request.Request(self.base + path, data=data, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=10) as res:
                    raw = res.read()
                    status = res.status
            except urllib.error.HTTPError as e:
                raw, status = e.read(), e.code
            try:
                return status, json.loads(raw)
            except json.JSONDecodeError:
                return status, raw.decode()

        def ok(self, path, body=None):
            status, data = self.request(path, body)
            assert status == 200, data
            return data

    yield Client()
    srv.shutdown()
    srv.server_close()
    app.hub.close()


def test_api_needs_the_token(server):
    assert server.request("/api/state", token=None)[0] == 403
    assert server.request("/api/state", token="wrong")[0] == 403
    assert server.request("/api/send", {"to": "leader", "text": "hi"}, token=None)[0] == 403
    assert server.request("/api/state")[0] == 200


def test_other_host_names_are_refused(server):
    assert server.request("/api/state", host="evil.example:80")[0] == 403
    assert server.request("/", host="evil.example:80")[0] == 403


def test_page_and_static_files(server):
    status, page = server.request("/", token=None)
    assert status == 200 and "<title>agent-org</title>" in page
    status, js = server.request("/static/app.js", token=None)
    assert status == 200 and "function h(" in js
    assert server.request("/static/../ui.py", token=None)[0] == 404
    assert server.request("/static/missing.css", token=None)[0] == 404


def test_state_lists_the_tree(server):
    state = server.ok("/api/state")
    assert state["owner"] == "you" and state["leader"] == "leader"
    assert [r["name"] for r in state["roles"]] == ["leader", "tech-lead", "researcher", "worker-a", "worker-b"]
    assert [t["name"] for t in state["tiers"]] == ["medium", "high"]
    assert state["launchable"] == ["claude", "codex", "grok"]


def test_owner_messages_and_inbox(server):
    [sent] = server.ok("/api/send", {"to": "worker-b", "text": "你好, please write tests"})["sent"]
    assert (sent["sender"], sent["kind"]) == ("you", "instruction")
    server.app.hub.session("leader").send("you", "plan is ready")
    messages = server.ok("/api/messages?after=0")["messages"]
    assert [m["text"] for m in messages] == ["你好, please write tests", "plan is ready"]
    assert server.ok(f"/api/messages?after={messages[0]['id']}")["messages"][0]["text"] == "plan is ready"
    assert server.ok("/api/state")["owner_unread"] == 1
    assert [m["text"] for m in server.ok("/api/inbox/read", {})["messages"]] == ["plan is ready"]
    assert server.ok("/api/state")["owner_unread"] == 0


def test_refusals_come_back_as_errors(server):
    status, data = server.request("/api/send", {"to": "ghost", "text": "hi"})
    assert status == 409 and "not in this team" in data["error"]
    status, data = server.request("/api/send", {"to": "leader"})
    assert status == 400 and "'text' is required" in data["error"]
    assert server.request("/api/nothing")[0] == 404


def test_summon_and_dismiss_a_consultant_for_the_leader(server):
    request = server.app.hub.session("leader").ask_help("which database should we use?")
    summoned = server.ok("/api/summon", {"help_id": request.id, "tier": "high", "brief": "we need SQL"})
    assert summoned == {"name": "consultant-1", "tier": "high", "superior": "leader"}
    assert server.app.hub.opener.opened == ["consultant-1"]
    role = next(r for r in server.ok("/api/state")["roles"] if r["name"] == "consultant-1")
    assert (role["tier"], role["help_id"], role["superior"]) == ("high", request.id, "leader")
    assert server.ok("/api/dismiss", {"name": "consultant-1"}) == {"name": "consultant-1", "returned": []}


def test_release_a_lock(server):
    server.app.hub.session("worker-a").claim("src/app.py")
    assert server.ok("/api/state")["locks"][0]["owner"] == "worker-a"
    assert server.ok("/api/release", {"path": "src/app.py"})["path"] == "src/app.py"
    assert server.ok("/api/state")["locks"] == []


def test_state_shows_who_is_running(server):
    server.app.hub.store.check_in(11, "tech-lead")
    server.app.hub.store.check_in(12, "tech-lead")
    online = {r["name"]: r["online"] for r in server.ok("/api/state")["roles"]}
    assert online == {"leader": 0, "tech-lead": 2, "researcher": 0, "worker-a": 0, "worker-b": 0}


def test_launch_skips_running_roles_unless_forced(server):
    server.app.hub.store.check_in(21, "leader")
    result = server.ok("/api/launch", {"roles": ["leader", "worker-a"]})
    assert (result["opening"], result["skipped"]) == (["worker-a"], ["leader: already running"])
    assert server.ok("/api/launch", {"roles": ["leader"], "force": True})["opening"] == ["leader"]


def test_launch_opens_tabs_for_supported_roles(server):
    result = server.ok("/api/launch", {})
    assert result["opening"] == ["leader", "tech-lead", "worker-a", "researcher"]
    assert result["skipped"] == ["worker-b: antigravity is not supported yet"]
    one = server.ok("/api/launch", {"roles": ["worker-a"]})
    assert one["opening"] == ["worker-a"]
    assert server.request("/api/launch", {"roles": ["ghost"]})[0] == 400


def test_team_editor_round_trip(server):
    data = server.ok("/api/team")
    assert data["config"]["owner"] == "you"
    assert data["harnesses"] == ["claude", "codex", "grok", "antigravity"]
    config = data["config"]
    config["roles"]["worker-c"] = {"superior": "tech-lead", "harness": "codex", "write_scope": ["docs/*"]}
    saved = server.ok("/api/team", {"config": config})
    assert saved["backup"].endswith("team.yaml.bak")
    assert "worker-c" in yaml.safe_load(server.team_file.read_text(encoding="utf-8"))["roles"]
    assert "worker-c" in [r["name"] for r in server.ok("/api/state")["roles"]]
    # the hub applies the new tree straight away
    assert server.app.hub.session("tech-lead").send("worker-c", "hello").kind == "instruction"


def test_invalid_team_is_not_saved(server):
    config = server.ok("/api/team")["config"]
    before = server.team_file.read_text(encoding="utf-8")
    config["roles"]["researcher"]["superior"] = "you"  # a second leader
    status, data = server.request("/api/team", {"config": config})
    assert status == 400 and "exactly one role must report to the owner" in data["error"]
    assert server.team_file.read_text(encoding="utf-8") == before


def test_model_output_parsers():
    assert ui._parse_grok("Default model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n") == [
        "grok-4.7", "grok-4.6"]
    assert ui._parse_agy("Fetching...\ngemini-3.8-flash-high\tGemini\nclaude-opus-4-6\tClaude\n") == [
        "gemini-3.8-flash-high", "claude-opus-4-6"]
    assert ui._parse_codex('{"models": [{"slug": "gpt-6-luna"}, {"id": "gpt-6-sol"}]}') == ["gpt-6-luna", "gpt-6-sol"]


# the message law from the page


def test_owner_gives_tasks_and_sees_them(server):
    task = server.ok("/api/task", {"to": "leader", "title": "Build a todo app", "details": "CLI, JSON file"})
    assert (task["assignee"], task["state"]) == ("leader", "open")
    state = server.ok("/api/state")
    assert [t["title"] for t in state["tasks"]] == ["Build a todo app"]
    assert next(r for r in state["roles"] if r["name"] == "leader")["open_tasks"] == 1
    server.app.hub.session("leader").finish_task(task["id"], "todo.py is ready")
    result = server.ok("/api/messages?after=0")["messages"][-1]
    assert (result["kind"], result["recipient"]) == ("result", "you")
    cancel = server.ok("/api/task", {"to": "worker-a", "title": "Old idea"})
    assert server.ok("/api/cancel-task", {"task_id": cancel["id"]})["state"] == "cancelled"


def test_owner_writes_to_everyone_and_urgently(server):
    sent = server.ok("/api/send", {"to": "@all", "text": "Stop for today"})["sent"]
    assert sorted(m["recipient"] for m in sent) == ["leader", "researcher", "tech-lead", "worker-a", "worker-b"]
    [urgent] = server.ok("/api/send", {"to": "worker-a", "text": "STOP", "urgent": True})["sent"]
    assert urgent["urgent"] is True


def test_the_law_is_served(server):
    law = server.ok("/api/law")["law"]
    assert law[0]["title"] == "Chain of command" and len(law) == 9


def test_roles_show_notes_and_whether_they_resume(server):
    server.app.hub.session("worker-a").save_notes("Using Flask")
    role = next(r for r in server.ok("/api/state")["roles"] if r["name"] == "worker-a")
    assert role["notes"] == "Using Flask" and role["resumes"] is False


def test_stop_needs_a_role(server):
    assert server.ok("/api/stop", {"role": "@all"}) == {"stopped": {}}  # nobody is running
    assert server.request("/api/stop", {"role": "ghost"})[0] == 400


# welcome page: opening and creating teams


def test_welcome_mode_without_a_team(tmp_path, monkeypatch):
    srv, app, token = ui.serve(None, 0, token="t", load_models=False)
    try:
        home = app.home()
        assert home["open"] is False
        assert [t["id"] for t in home["templates"]] == ["solo", "pair", "team"]
        with pytest.raises(ui.ApiError, match=ui.NO_TEAM):
            app.state()
        folder = tmp_path / "my app"
        created = app.create_team({"folder": str(folder), "template": "pair"})
        assert Path(created["team_file"]) == (folder / "team.yaml").resolve()
        assert [r["name"] for r in app.state()["roles"]] == ["leader", "worker"]
        assert app.home()["recent"][0]["name"] == "my app"
        with pytest.raises(ui.ApiError, match="already exists"):
            app.create_team({"folder": str(folder), "template": "solo"})
        app.close_team({})
        app.open_team({"path": str(folder)})  # a folder with a team.yaml works too
        assert app.team_file == (folder / "team.yaml").resolve()
        with pytest.raises(ui.ApiError, match="no team.yaml"):
            app.open_team({"path": str(tmp_path / "nowhere")})
        with pytest.raises(ui.ApiError, match="full folder path"):
            app.create_team({"folder": "relative", "template": "solo"})
    finally:
        srv.server_close()
        app.close()


def test_every_template_is_a_valid_team(tmp_path):
    from agent_org import templates
    from agent_org.team import Team

    for key in templates.TEMPLATES:
        team = Team.from_dict(templates.team_config(key), base_dir=tmp_path)
        assert team.leader == "leader"


def test_setup_checks_report_each_program(server, monkeypatch):
    from agent_org import doctor

    monkeypatch.setattr(doctor, "run_checks", lambda used: [
        doctor.Check("Claude Code", True, "2.1.283"), doctor.Check("Grok", False, "not installed", "Install it")])
    checks = server.ok("/api/checks?fresh=1")["checks"]
    assert [(c["name"], c["ok"]) for c in checks] == [("Claude Code", True), ("Grok", False)]
