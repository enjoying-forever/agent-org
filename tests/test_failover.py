"""When a subscription runs out: noticing it, moving the work, and waking the agent again."""

import json
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from agent_org import hooks, sessions, usage, watchdog
from agent_org.hub import HubError, PermissionDenied

SID = "3f2c1a8e-1111-4a2b-9c3d-123456789abc"
SG = ZoneInfo("Asia/Singapore")
LIMIT_TEXT = "You've hit your session limit · resets 7:20pm (Asia/Singapore)"


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(sessions, "home", lambda: tmp_path / "home")
    usage._stuck_cache.clear()
    return tmp_path / "home"


def lines(*records):
    return "".join(json.dumps(r) + "\n" for r in records)


def claude_file(home):
    folder = home / ".claude" / "projects" / "E--proj"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{SID}.jsonl"


def api_error(text, error="rate_limit"):
    return {"type": "assistant", "timestamp": "2026-09-28T11:03:21.085Z", "isApiErrorMessage": True,
            "error": error, "message": {"model": "<synthetic>", "content": [{"type": "text", "text": text}]}}


# reading the harness's own words

def test_reset_time_reads_the_harness_words():
    at = datetime(2026, 9, 28, 11, 3, tzinfo=timezone.utc).timestamp()  # 19:03 in Singapore
    at_sg = lambda t: datetime.fromtimestamp(t, SG).replace(tzinfo=None)  # noqa: E731
    assert at_sg(usage.reset_time(LIMIT_TEXT, at)) == datetime(2026, 9, 28, 19, 20)
    assert at_sg(usage.reset_time("resets 6pm (Asia/Singapore)", at)) == datetime(2026, 9, 29, 18, 0)  # tomorrow
    assert at_sg(usage.reset_time("weekly limit · resets Oct 3, 7pm (Asia/Singapore)", at)) == \
        datetime(2026, 10, 3, 19, 0)
    assert usage.reset_time("You've hit your usage limit. Try again in 2 hours 30 minutes.", at) == at + 9000
    assert usage.reset_time("API Error: 529 overloaded", at) is None


def test_a_claude_conversation_that_ran_into_its_limit(home):
    claude_file(home).write_text(lines(
        {"type": "user", "message": {"role": "user", "content": "go"}},
        {"type": "assistant", "message": {"id": "m1", "content": [{"type": "text", "text": "working"}]}},
        api_error(LIMIT_TEXT)), encoding="utf-8")
    s = usage.stuck("claude", SID)
    assert s.kind == "limit" and "session limit" in s.text
    assert datetime.fromtimestamp(s.until, SG).strftime("%H:%M") == "19:20"


def test_other_api_errors_and_a_new_turn(home):
    path = claude_file(home)
    path.write_text(lines(api_error("API Error: 529 Overloaded", error="overloaded")), encoding="utf-8")
    s = usage.stuck("claude", SID)
    assert (s.kind, s.until) == ("error", None)
    with path.open("a", encoding="utf-8") as f:  # someone typed into its tab: a new turn began
        f.write(lines({"type": "user", "message": {"role": "user", "content": "continue"}}))
    assert usage.stuck("claude", SID) is None


def test_a_codex_window_that_is_full(home):
    day = home / ".codex" / "sessions" / "2026" / "09" / "28"
    day.mkdir(parents=True)
    path = day / f"rollout-2026-09-28T17-17-06-{SID}.jsonl"
    full = {"timestamp": "2026-09-28T11:00:00Z", "type": "event_msg", "payload": {
        "type": "token_count", "rate_limits": {
            "primary": {"used_percent": 40, "window_minutes": 300},
            "secondary": {"used_percent": 100.0, "window_minutes": 10080, "resets_at": 1790000000}}}}
    path.write_text(lines({"type": "session_meta", "payload": {"id": SID}}, full), encoding="utf-8")
    s = usage.stuck("codex", SID)
    assert (s.kind, s.until) == ("limit", 1790000000)
    with path.open("a", encoding="utf-8") as f:
        f.write(lines({"type": "response_item", "payload": {"type": "message"}}))
    assert usage.stuck("codex", SID) is None


def test_harnesses_without_a_readable_record_are_never_stuck(home):
    assert usage.stuck("grok", SID) is None
    assert usage.stuck("claude", SID) is None  # no file


# moving work

def working_task(hub):
    lead, a = hub.session("tech-lead"), hub.session("worker-a")
    task = lead.assign_task("worker-a", "Write the tests", done_when="pytest passes")
    a.read_inbox()  # read: it is working on it now
    for path in ("tests/test_x.py", "src/app.py"):
        a.claim(path)
        a.note_edit(path)
    return task


def test_reassign_moves_the_task_its_leases_and_tells_both(hub):
    task = working_task(hub)
    moved = hub.session("tech-lead").reassign_task(task.id, "worker-b", "worker-a is out of its usage limit")
    assert (moved.assignee, moved.state) == ("worker-b", "open")
    # worker-b may write tests/ but not src/: that lease is freed instead of handed over
    assert {lock.path: lock.owner for lock in hub.store.locks()} == {"tests/test_x.py": "worker-b"}
    [given] = hub.session("worker-b").read_inbox()
    assert given.kind == "task" and given.task_id == task.id
    for words in ("was worker-a's", "usage limit", "tests/test_x.py", f"task_details({task.id})", "pytest passes"):
        assert words in given.text
    [told] = hub.session("worker-a").read_inbox()
    assert "moved to worker-b" in told.text and "stop working on it" in told.text
    assert any("moved #1 from worker-a to worker-b" in e.text for e in hub.store.events_after(0))


def test_who_may_move_a_task_and_where(hub):
    task = working_task(hub)
    with pytest.raises(PermissionDenied):
        hub.session("worker-b").reassign_task(task.id, "worker-b")  # neither its assigner nor above
    with pytest.raises(PermissionDenied):
        hub.session("leader").reassign_task(task.id, "researcher")  # not below tech-lead, who gave it
    with pytest.raises(PermissionDenied):
        hub.session("tech-lead").reassign_task(task.id, "you")
    with pytest.raises(HubError):
        hub.session("tech-lead").reassign_task(task.id, "worker-a")  # already theirs
    moved = hub.session("leader").reassign_task(task.id, "worker-b")  # above both: allowed
    assert moved.assignee == "worker-b"


def test_finished_tasks_stay_put(hub):
    lead = hub.session("tech-lead")
    task = lead.assign_task("worker-a", "Tiny fix")
    hub.session("worker-a").read_inbox()
    hub.session("worker-a").finish_task(task.id, "fixed")
    lead.review_task(task.id, accept=True)
    with pytest.raises(HubError, match="only an unfinished task"):
        lead.reassign_task(task.id, "worker-b")


def test_a_waiting_task_moves_quietly_and_starts_for_its_new_owner(hub):
    lead = hub.session("tech-lead")
    first = lead.assign_task("worker-b", "Design")
    later = lead.assign_task("worker-a", "Build", after=[first.id])
    lead.reassign_task(later.id, "worker-b")
    b = hub.session("worker-b")
    assert [m.task_id for m in b.read_inbox()] == [first.id]  # nothing for the waiting task yet
    b.finish_task(first.id, "designed")
    assert [m.task_id for m in b.read_inbox()] == [later.id]


# the watchdog

def stuck_as(monkeypatch, hub, found):
    """Make `found` (role -> Stuck) what the session files say."""
    for name in found:
        hub.store.record_session_id(name, hub.team.roles[name].harness, f"sid-{name}")
    monkeypatch.setattr(usage, "stuck", lambda harness, sid: found.get(str(sid).removeprefix("sid-")))


def test_an_agent_out_of_its_limit_is_reported_once_with_who_is_free(hub, monkeypatch):
    task = working_task(hub)
    now = time.time()
    stuck_as(monkeypatch, hub, {"worker-a": usage.Stuck("limit", LIMIT_TEXT, now - 60, now + 3600)})
    problems = watchdog.patrol(hub)
    [p] = [p for p in problems if p.role == "worker-a"]
    assert (p.kind, p.action) == ("limit", "reassign")  # not "stopped": starting it would only fail
    [notice] = hub.session("tech-lead").read_inbox()
    assert "out of its usage limit until" in notice.text and f"#{task.id}" in notice.text
    assert "Free to take them: worker-b (antigravity)" in notice.text and "reassign_task" in notice.text
    watchdog.patrol(hub)
    assert hub.session("tech-lead").read_inbox() == []  # once per limit
    assert hub.stuck()["worker-a"]["kind"] == "limit"
    row = next(r for r in hub.session("leader").overview() if r.name == "worker-a")
    assert row.stuck.startswith("out of its usage limit until")


def test_after_the_reset_an_idle_agent_is_listed_for_a_restart(hub, monkeypatch):
    working_task(hub)
    now = time.time()
    stuck_as(monkeypatch, hub, {"worker-a": usage.Stuck("limit", LIMIT_TEXT, now - 7200, now - 60)})
    hub.store.check_in(4242, "worker-a")
    [p] = [p for p in watchdog.patrol(hub) if p.role == "worker-a"]
    assert (p.kind, p.action) == ("stuck", "restart") and "usage limit has reset" in p.text


def test_other_api_errors_get_a_few_minutes_first(hub, monkeypatch):
    working_task(hub)
    now = time.time()
    hub.store.check_in(4242, "worker-a")
    stuck_as(monkeypatch, hub, {"worker-a": usage.Stuck("error", "API Error: 529", now - 30, None)})
    assert not [p for p in watchdog.patrol(hub) if p.role == "worker-a"]
    stuck_as(monkeypatch, hub, {"worker-a": usage.Stuck("error", "API Error: 529", now - 600, None)})
    assert [p.kind for p in watchdog.patrol(hub) if p.role == "worker-a"] == ["stuck"]


def test_an_agent_that_worked_since_is_not_stuck(hub, monkeypatch):
    working_task(hub)
    now = time.time()
    stuck_as(monkeypatch, hub, {"worker-a": usage.Stuck("error", "API Error: 529", now - 600, None)})
    hub.store.touch("worker-a")
    assert watchdog.stuck_agents(hub) == {}


def test_the_stop_hook_keeps_mail_for_later_when_out_of_usage(hub, monkeypatch):
    now = time.time()
    monkeypatch.setattr(usage, "stuck", lambda harness, sid: usage.Stuck("limit", LIMIT_TEXT, now, now + 600))
    hub.session("tech-lead").send("worker-a", "Please also cover the edge cases.")
    out = hooks.on_stop(hub.session("worker-a"), {"session_id": SID, "stop_hook_active": False}, wait=0.1, poll=0.05)
    assert out is None
    assert hub.store.unread_count("worker-a") == 1  # still there for when it can work again
