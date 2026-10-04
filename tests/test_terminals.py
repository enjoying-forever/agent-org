"""Agents' terminals inside the agent-org window (pseudo-terminals the UI server owns)."""

import json
import time
from pathlib import Path

import pytest

from agent_org import launch, terminals

from .test_ui import server  # noqa: F401 - the running UI fixture

needs_pty = pytest.mark.skipif(not terminals.available(), reason="needs Windows and pywinpty")
SHELL = ["pwsh", "-NoLogo", "-NoProfile", "-NoExit", "-Command"]


def collect(host, name, seconds, until=None):
    """Read a terminal for a while, answering the terminal queries a real page answers."""
    out, at, term_id = "", 0, 0
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        got = host.read_many({name: (term_id, at)}, wait=0.3).get(name)
        if not got:
            continue
        if "\x1b[c" in got["data"]:
            host.get(name).write("\x1b[?1;2c")  # "I am a VT100": PowerShell waits for it
        out += got["data"]
        at, term_id = got["next"], got["id"]
        if until and until in out:
            break
    return out


def test_fresh_env_leaves_out_the_session_that_started_agent_org(monkeypatch):
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("CLAUDE_CODE_CHILD_SESSION", "1")
    env = terminals.fresh_env()
    assert not any(k.upper().startswith(("CLAUDECODE", "CLAUDE_CODE_")) for k in env)
    assert {"PATH"} & {k.upper() for k in env}


def test_tab_parts_turn_a_tab_into_a_terminal(tmp_path):
    script = tmp_path / "launch" / "worker-a" / "start.ps1"
    tab = launch.tab_command("worker-a", "#10A37F", tmp_path, script)
    title, color, cwd, argv = launch.tab_parts(tab)
    assert (title, color, cwd) == ("worker-a", "#10A37F", tmp_path)
    assert argv[0] == "pwsh" and argv[-1] == str(script)
    assert launch.tab_role(tab) == "worker-a"


@needs_pty
def test_a_terminal_streams_output_takes_keys_and_remembers_its_size(tmp_path):
    host = terminals.TerminalHost()
    try:
        host.open("a", [*SHELL, "Write-Host ready-$((2+3))"], tmp_path)
        assert "ready-5" in collect(host, "a", 15, until="ready-5")
        host.get("a").write("Write-Host typed-$((6*7))\r")
        assert "typed-42" in collect(host, "a", 15, until="typed-42")
        host.resize("a", 90, 20)
        assert (host.get("a").cols, host.get("a").rows) == (90, 20)
        first = host.get("a").id
        host.open("a", [*SHELL, "Write-Host again"], tmp_path)  # a restart replaces it, at the same size
        term = host.get("a")
        assert term.id != first and (term.cols, term.rows) == (90, 20)
        assert host.read_many({"a": (first, 999)}, wait=1)["a"]["reset"]  # the page learns to clear its screen
        assert host.read_many({"ghost": (0, 0)}, wait=0) == {"ghost": {"none": True}}
    finally:
        host.close_all()
    time.sleep(0.5)
    assert not term.alive


@needs_pty
def test_pane_sizes_outlive_a_restart_of_agent_org(tmp_path):
    sizes = tmp_path / "terminal-sizes.json"
    host = terminals.TerminalHost(sizes)
    try:
        host.open("a", [*SHELL, "Write-Host hi"], tmp_path)
        host.resize("a", 88, 21)
    finally:
        host.close_all()
    again = terminals.TerminalHost(sizes)  # agent-org started again: the agent starts as big as its pane
    try:
        term = again.open("a", [*SHELL, "Write-Host hi"], tmp_path)
        assert (term.cols, term.rows) == (88, 21)
    finally:
        again.close_all()
    sizes.write_text("not json", encoding="utf-8")
    assert terminals.TerminalHost(sizes)._sizes == {}  # a broken file is only forgotten


@needs_pty
def test_the_window_runs_agents_in_its_terminals(server, tmp_path):  # noqa: F811
    app = server.app
    app.in_window = True  # tests run with tabs; this one opens a harmless stand-in for the agent
    script = tmp_path / "launch" / "leader" / "start.ps1"
    script.parent.mkdir(parents=True)
    script.write_text("Write-Host stand-in-agent\n", encoding="utf-8")
    try:
        app._open_tab(launch.tab_command("leader", "#D97757", tmp_path, script))
        leader = next(r for r in server.ok("/api/state")["roles"] if r["name"] == "leader")
        assert leader["terminal"]["alive"] and server.ok("/api/state")["in_window"]
        term_id, out, at = leader["terminal"]["id"], "", 0
        end = time.monotonic() + 15
        while "stand-in-agent" not in out and time.monotonic() < end:
            got = server.ok(f"/api/terms?w=%7B%22leader%22%3A%5B{term_id}%2C{at}%5D%7D")["terms"].get("leader")
            if got:
                if "\x1b[c" in got["data"]:
                    server.ok("/api/term-input", {"role": "leader", "data": "\x1b[?1;2c"})
                out, at = out + got["data"], got["next"]
        assert "stand-in-agent" in out
        server.ok("/api/term-resize", {"role": "leader", "cols": 100, "rows": 30})
        assert (app.terminals.get("leader").cols, app.terminals.get("leader").rows) == (100, 30)
        assert server.request("/api/term-input", {"role": "worker-a", "data": "x"})[0] == 400  # it has none
        assert server.request("/api/terms?w=nonsense")[0] == 400
    finally:
        app.terminals.close_all()


def test_agents_keep_agent_orgs_way_to_the_internet(monkeypatch):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7897")
    env = terminals.network_env({"PATH": "x", "https_proxy": "http://stale:1"})
    assert env["HTTPS_PROXY"] == "http://127.0.0.1:7897" and "https_proxy" not in env
    monkeypatch.delenv("HTTPS_PROXY")  # none of its own: Windows' system proxy, if one is on
    monkeypatch.setattr(terminals, "system_proxy", lambda: "http://127.0.0.1:7890")
    env = terminals.network_env({"PATH": "x"})
    assert env["HTTP_PROXY"] == env["HTTPS_PROXY"] == "http://127.0.0.1:7890" and "127.0.0.1" in env["NO_PROXY"]
    monkeypatch.setattr(terminals, "system_proxy", lambda: None)
    assert "HTTPS_PROXY" not in terminals.network_env({"PATH": "x"})


def test_links_from_a_terminal_open_in_the_browser(server, monkeypatch):  # noqa: F811
    from agent_org import ui
    opened = []
    monkeypatch.setattr(ui.webbrowser, "open", opened.append)
    server.ok("/api/open-url", {"url": "https://claude.ai/oauth/authorize?code=1"})
    assert opened == ["https://claude.ai/oauth/authorize?code=1"]
    for bad in ("file:///C:/Windows/system32/calc.exe", "javascript:alert(1)", "https://x.test/a b", "ms-settings:"):
        assert server.request("/api/open-url", {"url": bad})[0] == 400
    assert len(opened) == 1


def test_the_window_comes_back_where_it_was():
    from agent_org.ui import window_geometry
    screens = [(0, 0, 2560, 1440)]
    assert window_geometry({}, screens) == {"width": 1520, "height": 950, "maximized": False}
    assert window_geometry({"x": 100, "y": 50, "width": 1200, "height": 800, "maximized": True}, screens) == {
        "width": 1200, "height": 800, "maximized": True, "x": 100, "y": 50}
    assert "x" not in window_geometry({"x": 3000, "y": 50}, screens)  # that monitor is gone
    assert window_geometry({"width": 300, "height": 200}, screens)["width"] == 900  # never below the minimum


def test_an_agent_hired_by_an_agent_starts_in_the_window(server, monkeypatch):  # noqa: F811
    import urllib.error
    import urllib.request

    from agent_org import launch, terminals, ui
    app = server.app

    def post(secret):
        req = urllib.request.Request(server.base + "/api/launcher/start", method="POST",
                                     data=json.dumps({"team": str(app.team_file), "role": "worker-a"}).encode(),
                                     headers={"Content-Type": "application/json", ui.LAUNCHER_HEADER: secret})
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return res.status
        except urllib.error.HTTPError as e:
            return e.code

    assert post("guess") == 403  # only with this agent-org's launcher secret
    assert post(app.window.launcher) == 409  # its agents run in tabs here: the tool server opens one
    opened = []
    monkeypatch.setattr(terminals.TerminalHost, "open", lambda self, *a: opened.append(a))
    app.in_window = True
    assert post(app.window.launcher) == 200
    (role, argv, cwd, title, color), = opened
    assert role == "worker-a" and argv[-1].endswith("start.ps1")
    assert "AGENT_ORG_STOP_IDLE" in Path(argv[-1]).read_text(encoding="utf-8")  # quiet: the window wakes it
    assert not launch.window_start(app.team_file, "worker-a")  # and a test never reaches a real window


class FakeWindow:
    def __init__(self):
        self.calls = []

    def show(self):
        self.calls.append("show")

    def restore(self):
        self.calls.append("restore")

    def hide(self):
        self.calls.append("hide")

    def destroy(self):
        self.calls.append("destroy")


def test_the_window_hides_with_agents_running_and_a_second_start_brings_it_back(server):  # noqa: F811
    from agent_org import ui
    app = server.app
    assert server.request("/api/window", {"action": "hide"})[0] == 400  # no window in this test server
    window = app.window.window = FakeWindow()
    server.ok("/api/window", {"action": "hide"})
    assert window.calls == ["hide"]
    # a second agent-org start finds this one and asks for its window, with the launcher secret only
    ui.instance_file().parent.mkdir(parents=True, exist_ok=True)
    port = int(server.base.rsplit(":", 1)[1])
    ui.instance_file().write_text(f'{{"pid": 1, "port": {port}, "launcher": "{app.window.launcher}"}}', encoding="utf-8")
    assert ui.show_running()
    assert window.calls[-2:] == ["show", "restore"]
    ui.instance_file().write_text(f'{{"pid": 1, "port": {port}, "launcher": "guess"}}', encoding="utf-8")
    assert not ui.show_running()  # a wrong secret gets nothing
    status, _ = server.request("/api/launcher/show", {}, token=None)
    assert status == 403
    server.ok("/api/window", {"action": "quit"})
    assert app.window.quitting and window.calls[-1] == "destroy"
    assert server.request("/api/window", {"action": "explode"})[0] == 400
