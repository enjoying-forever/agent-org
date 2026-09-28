import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
import yaml

from agent_org.mcp_server import Server

from .conftest import TEAM

ROOT = Path(__file__).resolve().parent.parent


class Client:
    """Drives a Server through in-memory stdio, the way a harness drives it through pipes."""

    def __init__(self, hub, role):
        self._in: queue.Queue = queue.Queue()
        self._out: queue.Queue = queue.Queue()
        self._next_id = 0
        server = Server(hub.session(role), stdin=iter(self._in.get, None), stdout=self)
        self._thread = threading.Thread(target=server.serve, daemon=True)
        self._thread.start()

    # the server writes here
    def write(self, text):
        for line in text.splitlines():
            self._out.put(json.loads(line))

    def flush(self):
        pass

    def notify(self, method, params=None):
        self._in.put(json.dumps({"jsonrpc": "2.0", "method": method, "params": params or {}}) + "\n")

    def request(self, method, params=None):
        self._next_id += 1
        self._in.put(json.dumps({"jsonrpc": "2.0", "id": self._next_id, "method": method,
                                 "params": params or {}}) + "\n")
        return self._next_id

    def response(self, timeout=5):
        return self._out.get(timeout=timeout)

    def call(self, method, params=None):
        msg_id = self.request(method, params)
        reply = self.response()
        assert reply["id"] == msg_id
        return reply

    def tool(self, name, **arguments):
        result = self.call("tools/call", {"name": name, "arguments": arguments})["result"]
        return result["content"][0]["text"], result["isError"]

    def close(self):
        self._in.put(None)
        self._thread.join(timeout=5)


@pytest.fixture
def client(hub):
    clients = []

    def make(role):
        c = Client(hub, role)
        clients.append(c)
        return c

    yield make
    for c in clients:
        c.close()


def test_initialize_echoes_protocol_and_gives_the_role_card(client):
    reply = client("worker-a").call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
    result = reply["result"]
    assert result["protocolVersion"] == "2025-06-18"
    assert result["capabilities"] == {"tools": {}}
    assert "You are 'worker-a'" in result["instructions"]
    assert "Your superior: tech-lead" in result["instructions"]


def test_tools_are_listed_with_schemas(client):
    tools = client("worker-a").call("tools/list")["result"]["tools"]
    names = {t["name"] for t in tools}
    assert names == {"my_role", "send_message", "ask_help", "read_inbox", "wait_for_messages",
                     "set_status", "view", "claim_file", "release_file", "list_locks"}
    send = next(t for t in tools if t["name"] == "send_message")
    assert send["inputSchema"]["required"] == ["to", "text"]


def test_role_card_lists_the_whole_subtree_for_managers(client):
    text, is_error = client("leader").tool("my_role")
    assert not is_error
    assert "Your direct subordinates: tech-lead, researcher" in text
    assert "Everyone below you: tech-lead, researcher, worker-a, worker-b" in text
    assert "worker-b (antigravity, reports to tech-lead)" in text


def test_tool_calls_follow_the_hub_rules(client, hub):
    worker = client("worker-a")
    text, is_error = worker.tool("send_message", to="tech-lead", text="done")
    assert not is_error and "[report] from worker-a to tech-lead" in text
    text, is_error = worker.tool("send_message", to="leader", text="done")
    assert is_error and text.startswith("Refused: you cannot message 'leader'")
    text, is_error = worker.tool("claim_file", path="src/app.py")
    assert not is_error and "src/app.py (held by worker-a)" in text
    assert [m.text for m in hub.session("tech-lead").read_inbox()] == ["done"]


def test_missing_arguments_and_unknown_tools_are_errors(client):
    worker = client("worker-a")
    assert worker.tool("send_message", to="tech-lead") == ("Missing argument: text", True)
    assert worker.tool("fly") == ("Unknown tool: fly", True)


def test_wait_for_messages_delivers_while_other_calls_still_work(client, hub):
    worker = client("worker-a")
    wait_id = worker.request("tools/call", {"name": "wait_for_messages", "arguments": {"timeout_seconds": 10}})
    time.sleep(0.2)
    # the wait is still open, but the server keeps answering
    assert worker.call("ping")["result"] == {}
    assert hub.session("leader").view("worker-a").status.state == "waiting"
    hub.session("tech-lead").send("worker-a", "please add tests")
    reply = worker.response()
    assert reply["id"] == wait_id
    assert "please add tests" in reply["result"]["content"][0]["text"]


def test_cancelled_wait_leaves_messages_unread(client, hub):
    worker = client("worker-a")
    wait_id = worker.request("tools/call", {"name": "wait_for_messages", "arguments": {"timeout_seconds": 10}})
    time.sleep(0.2)
    worker.notify("notifications/cancelled", {"requestId": wait_id})
    time.sleep(0.8)  # longer than one poll, so the cancelled wait has stopped
    hub.session("tech-lead").send("worker-a", "still there?")
    time.sleep(0.8)
    with pytest.raises(queue.Empty):
        worker.response(timeout=0.2)  # no reply to a cancelled request
    assert [m.text for m in hub.session("worker-a").read_inbox()] == ["still there?"]


def test_closing_stdin_stops_waits_but_finishes_other_calls(client, hub):
    worker = client("worker-a")
    wait_id = worker.request("tools/call", {"name": "wait_for_messages", "arguments": {"timeout_seconds": 10}})
    status_id = worker.request("tools/call", {"name": "set_status", "arguments": {"state": "done"}})
    worker.close()
    replies = []
    while True:
        try:
            replies.append(worker.response(timeout=0.2)["id"])
        except queue.Empty:
            break
    assert status_id in replies and wait_id not in replies
    hub.session("tech-lead").send("worker-a", "after shutdown")
    assert [m.text for m in hub.session("worker-a").read_inbox()] == ["after shutdown"]


def test_unknown_methods_get_an_error(client):
    reply = client("worker-a").call("resources/list")
    assert reply["error"]["code"] == -32601


def test_runs_over_real_stdio(tmp_path):
    (tmp_path / "project").mkdir()
    team_file = tmp_path / "team.yaml"
    team_file.write_text(yaml.safe_dump(TEAM), encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, "-m", "agent_org.mcp_server", "--team", str(team_file), "--role", "worker-a"],
        cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
         "params": {"name": "send_message", "arguments": {"to": "tech-lead", "text": "你好, 测试完成 ✓"}}},
    ]
    for r in requests:
        proc.stdin.write((json.dumps(r, ensure_ascii=False) + "\n").encode("utf-8"))
    proc.stdin.flush()
    replies = [json.loads(proc.stdout.readline().decode("utf-8")) for _ in range(2)]
    proc.stdin.close()
    assert proc.wait(timeout=20) == 0, proc.stderr.read().decode()
    assert replies[0]["result"]["serverInfo"]["name"] == "agent-org"
    assert "你好, 测试完成 ✓" in replies[1]["result"]["content"][0]["text"]


def test_bad_role_exits_with_a_message(tmp_path):
    (tmp_path / "project").mkdir()
    team_file = tmp_path / "team.yaml"
    team_file.write_text(yaml.safe_dump(TEAM), encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, "-m", "agent_org.mcp_server", "--team", str(team_file), "--role", "ghost"],
        cwd=ROOT, capture_output=True, text=True, timeout=20,
    )
    assert proc.returncode == 2
    assert "not in this team" in proc.stderr
