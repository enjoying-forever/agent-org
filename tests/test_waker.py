"""Quiet starts in the agent-org window, and the waker that types a line when work arrives."""

import json
import time

import pytest
import yaml

from agent_org import hooks, launch, terminals, waker, wake
from agent_org.hub import Hub

from .conftest import TEAM


@pytest.fixture
def team_file(tmp_path):
    (tmp_path / "project").mkdir()
    path = tmp_path / "team.yaml"
    path.write_text(yaml.safe_dump(json.loads(json.dumps(TEAM))), encoding="utf-8")
    return path


@pytest.fixture
def hub(team_file):
    h = Hub.open(team_file)
    yield h
    h.close()


class FakeTerm:
    """What the waker reads of a terminal: when it started, wrote and was typed in; its output."""

    _ids = iter(range(1, 1000))

    def __init__(self, now, output="> ", started=60.0, quiet=10.0, typed=None):
        self.id = next(self._ids)
        self.alive = True
        self.started, self.last_output = now - started, now - quiet
        self.last_input = 0.0 if typed is None else now - typed
        self.output, self.got = output, []

    @property
    def end(self):
        return len(self.output)

    def chunk(self, offset):
        return {"data": self.output[offset:]}

    def write(self, data):
        self.got.append(data)


class FakeHost:
    def __init__(self, **terms):
        self.terms = terms

    def items(self):
        return list(self.terms.items())


@pytest.fixture(autouse=True)
def no_typing_pause(monkeypatch):
    monkeypatch.setattr(waker.time, "sleep", lambda s: None)


def later():
    return time.time() + 10  # mail sent now has waited ten seconds by then


# ---- quiet starts ----

def test_a_quiet_start_sends_no_first_message(hub, team_file):
    for role in ("leader", "worker-a", "worker-b", "researcher"):
        tab = launch.role_tab(hub, team_file.resolve(), role, quiet=True)
        script = (team_file.parent / ".agent-org" / "launch" / role / "start.ps1").read_text(encoding="utf-8")
        assert "You are the ''" not in script and "the team was restarted" not in script, role
        assert "$env:AGENT_ORG_STOP_IDLE = '1'" in script  # its Stop hook lets it rest
        assert f"$env:AGENT_ORG_STOP_WAIT = '{launch.QUIET_STOP_WAIT}'" in script  # soon: you can type to it
        assert tab[-1].endswith("start.ps1")
    leader = (team_file.parent / ".agent-org" / "launch" / "leader" / "start.ps1").read_text(encoding="utf-8")
    assert leader.rstrip().endswith("'--name' 'leader'")  # Claude still gets its role card as system prompt
    assert "'--append-system-prompt-file'" in leader
    agy = (team_file.parent / ".agent-org" / "launch" / "worker-b" / "start.ps1").read_text(encoding="utf-8")
    assert "'-i'" not in agy


def test_outside_the_window_an_agent_still_gets_its_kickoff(hub, team_file):
    launch.role_tab(hub, team_file.resolve(), "leader")
    script = (team_file.parent / ".agent-org" / "launch" / "leader" / "start.ps1").read_text(encoding="utf-8")
    assert "You are the ''leader'' agent" in script and "AGENT_ORG_STOP_IDLE" not in script


def test_a_resting_agents_stop_hook_lets_it_rest(hub, monkeypatch):
    me = hub.session("worker-a")
    monkeypatch.setenv("AGENT_ORG_STOP_IDLE", "1")
    assert hooks.on_stop(me, {"stop_hook_active": True}, wait=0.05, poll=0.01) is None
    monkeypatch.delenv("AGENT_ORG_STOP_IDLE")
    assert hooks.on_stop(me, {"stop_hook_active": True}, wait=0.05, poll=0.01)["decision"] == "block"


def test_a_conversation_woken_by_agent_org_is_found_again():
    assert "agent-org: 'leader', " in waker.wake_line("claude", "leader")
    assert any(m in waker.wake_line("claude", "leader") for m in launch.sessions.markers("leader"))


# ---- the waker ----

def test_mail_nobody_takes_wakes_an_idle_agent(hub):
    hub.session("leader").send("researcher", "look into X")
    now = later()
    term = FakeTerm(now)
    assert waker.Waker().tick(hub, FakeHost(researcher=term), now) == ["researcher"]
    line, enter = term.got
    assert line.startswith("agent-org: 'researcher', you have new messages") and "read_inbox" in line
    assert enter == "\r"  # pressed apart from the text
    assert hub.session("researcher").read_inbox()  # the mail itself is left for the agent to read


@pytest.mark.parametrize("term_kw", [
    {"quiet": 1.0},  # still writing: it is at work (or a Stop hook is waiting, with its timer)
    {"typed": 5.0},  # you typed in it a moment ago
    {"started": 2.0},  # just started: still drawing its screen
    {"output": "Do you want to make this edit to app.py?\n❯ 1. Yes\n  2. No (esc)\n"},  # asking you
])
def test_an_agent_that_is_busy_or_asking_is_left_alone(hub, term_kw):
    hub.session("leader").send("researcher", "look into X")
    now = later()
    term = FakeTerm(now, **term_kw)
    assert waker.Waker().tick(hub, FakeHost(researcher=term), now) == [] and term.got == []


def test_a_question_only_written_in_an_answer_does_not_block_waking(hub):
    hub.session("leader").send("researcher", "look into X")
    now = later()
    term = FakeTerm(now, output="Done. Would you like to deploy it as well?\n> ")
    assert waker.Waker().tick(hub, FakeHost(researcher=term), now) == ["researcher"]


def test_fresh_mail_waits_for_a_stop_hook_and_a_woken_agent_is_not_pushed_again(hub):
    hub.session("leader").send("researcher", "look into X")
    w, now = waker.Waker(), time.time() + 1  # a waiting Stop hook would have taken it by now+1
    term = FakeTerm(now)
    assert w.tick(hub, FakeHost(researcher=term), now) == []
    assert w.tick(hub, FakeHost(researcher=term), now + 10) == ["researcher"]
    assert w.tick(hub, FakeHost(researcher=term), now + 20) == []  # given time to act on it
    # still unread: it is tried again, each time after twice as long (it may be unable to act on it)
    assert w.tick(hub, FakeHost(researcher=term), now + 10 + waker.AGAIN) == []
    at = now + 10 + 2 * waker.AGAIN
    assert w.tick(hub, FakeHost(researcher=term), at) == ["researcher"]
    assert w.tick(hub, FakeHost(researcher=term), at + 2 * waker.AGAIN) == []
    assert w.tick(hub, FakeHost(researcher=term), at + 4 * waker.AGAIN) == ["researcher"]
    hub.session("researcher").read_inbox()  # it read that mail; new mail is woken for at the usual pace
    hub.session("leader").send("researcher", "and Y")
    later_at = at + 4 * waker.AGAIN + waker.AGAIN + waker.UNREAD_FOR
    assert w.tick(hub, FakeHost(researcher=term), max(later_at, time.time() + 10)) == ["researcher"]


def test_a_stuck_agent_is_not_woken(hub):
    hub.session("leader").send("researcher", "look into X")
    hub.set_stuck({"researcher": {"kind": "limit", "text": "out of usage", "at": time.time()}})
    now = later()
    term = FakeTerm(now)
    assert waker.Waker().tick(hub, FakeHost(researcher=term), now) == [] and term.got == []


def test_a_note_alone_does_not_wake_an_agent(hub):
    hub.note("researcher", "leader changed your role (duties). Call my_role to see it now.")
    now = later()
    term = FakeTerm(now)
    assert waker.Waker().tick(hub, FakeHost(researcher=term), now) == [] and term.got == []


def test_an_idle_agent_without_mail_is_left_alone(hub):
    now = later()
    term = FakeTerm(now)
    assert waker.Waker().tick(hub, FakeHost(researcher=term), now) == [] and term.got == []


def test_a_restarted_agent_with_unfinished_tasks_carries_on_once(hub):
    task = hub.session("leader").assign_task("researcher", "Compare the two libraries")
    hub.session("researcher").read_inbox()  # it had read the task before the restart
    w, now = waker.Waker(), later()
    term = FakeTerm(now)
    assert w.tick(hub, FakeHost(researcher=term), now) == ["researcher"]
    assert "unfinished work" in term.got[0] and f"#{task.id} Compare the two libraries" in term.got[0]
    assert w.tick(hub, FakeHost(researcher=term), now + 2 * waker.AGAIN) == []  # only at its start


def test_antigravity_learns_its_role_from_the_line(hub):
    hub.session("tech-lead").send("worker-b", "write the tests")
    now = later()
    term = FakeTerm(now)
    assert waker.Waker().tick(hub, FakeHost(**{"worker-b": term}), now) == ["worker-b"]
    assert "call my_role first" in term.got[0] and "call_mcp_tool" in term.got[0]
    assert "my_role" not in waker.wake_line("claude", "leader")  # the others have it as system prompt


def test_deepseek_is_left_to_its_own_waiter(hub, team_file):
    config = yaml.safe_load(team_file.read_text(encoding="utf-8"))
    config["roles"]["researcher"]["harness"] = "deepseek"
    team_file.write_text(yaml.safe_dump(config), encoding="utf-8")
    h = Hub.open(team_file)
    try:
        h.session("leader").send("researcher", "look into X")
        now = later()
        term = FakeTerm(now)
        assert waker.Waker().tick(h, FakeHost(researcher=term), now) == [] and term.got == []
    finally:
        h.close()


def test_only_typed_text_counts_as_the_owner_typing():
    term = terminals.Terminal.__new__(terminals.Terminal)
    term.alive, term.last_input = False, 0.0
    for reply in ("\x1b[?1;2c", "\x1b[12;40R", "\x1b[I", "\x1b[A", "\x03", "\r"):  # replies, keys, Ctrl+C
        term.typed(reply)
    assert term.last_input == 0.0
    term.typed("fix the bug")
    assert term.last_input > 0


def test_deepseek_starts_at_once_only_with_unfinished_tasks(hub, team_file, tmp_path):
    marker = tmp_path / "stopped"
    args = ["--team", str(team_file), "--role", "worker-a", "--stop", str(marker), "--first"]
    marker.write_text("stopped")  # with nothing to do it would wait; stopped, it ends at once
    assert wake.main(args) == wake.STOPPED
    marker.unlink()
    hub.session("tech-lead").assign_task("worker-a", "Fix the parser")
    hub.session("worker-a").read_inbox()
    assert wake.main(args) == 0  # unfinished work: run now
