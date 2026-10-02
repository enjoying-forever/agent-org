"""Agents' terminals inside the agent-org window (pseudo-terminals the UI server owns)."""

import time

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
