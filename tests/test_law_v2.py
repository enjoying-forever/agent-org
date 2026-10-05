"""The upgraded law: task lifecycle, dependencies, review, leases, threads, search, watchdog."""

import time

import pytest

from agent_org import hooks, watchdog
from agent_org.hub import MAX_REVISIONS, HubError, LockConflict, PermissionDenied


def give(hub, frm, to, title, **kw):
    return hub.session(frm).assign_task(to, title, **kw)


# the lifecycle (after A2A)


def test_reading_a_task_starts_it(hub):
    task = give(hub, "tech-lead", "worker-a", "Build the form", done_when="the form posts to /login")
    assert task.state == "open"
    [message] = hub.session("worker-a").read_inbox()
    assert "Done when: the form posts to /login" in message.text
    assert "outcome 'rejected'" in message.text  # law 4: take it or turn it down
    task = hub.store.get_task(task.id)
    assert task.state == "working" and task.started_at


@pytest.mark.parametrize("outcome", ["failed", "rejected"])
def test_failed_and_rejected_are_final(hub, outcome):
    task = give(hub, "tech-lead", "worker-a", "x")
    closed = hub.session("worker-a").finish_task(task.id, "not possible here", outcome=outcome)
    assert closed.state == outcome and not closed.is_open
    [result] = hub.session("tech-lead").read_inbox()
    assert result.kind == "result" and ("FAILED" in result.text or "REJECTED" in result.text)
    with pytest.raises(HubError, match=f"already {outcome}"):
        hub.session("worker-a").finish_task(task.id, "again")


# law 6: results are checked


def test_done_waits_for_review_then_is_accepted(hub):
    task = give(hub, "tech-lead", "worker-a", "Build it")
    hub.session("worker-a").finish_task(task.id, "built")
    lead = hub.session("tech-lead")
    assert [t.id for t in lead.to_review()] == [task.id]
    reason = hooks.on_stop(lead, {"stop_hook_active": True}, wait=0.1, poll=0.05)["reason"]
    assert "new messages" in reason  # the result itself arrives first
    reason = hooks.on_stop(lead, {"stop_hook_active": False}, wait=0.1, poll=0.05)["reason"]
    assert f"Task #{task.id} you gave to worker-a (Build it) is done and waits for your review" in reason
    assert lead.review_task(task.id, accept=True).state == "accepted"
    assert lead.to_review() == [] and lead.given_tasks() == []


def test_sending_back_needs_feedback_and_has_a_limit(hub):
    task = give(hub, "tech-lead", "worker-a", "Build it")
    worker, lead = hub.session("worker-a"), hub.session("tech-lead")
    worker.read_inbox()
    worker.finish_task(task.id, "built")
    with pytest.raises(HubError, match="needs feedback"):
        lead.review_task(task.id, accept=False)
    for round_no in range(1, MAX_REVISIONS + 1):
        back = lead.review_task(task.id, accept=False, feedback=f"fix {round_no}")
        assert (back.state, back.revisions) == ("working", round_no)
        note = worker.read_inbox()[-1]
        assert f"sent back to you (round {round_no} of {MAX_REVISIONS})" in note.text and note.task_id == task.id
        worker.finish_task(task.id, f"fixed {round_no}")
    with pytest.raises(HubError, match="Decide differently"):
        lead.review_task(task.id, accept=False, feedback="again")


def test_only_the_assigner_or_above_reviews(hub):
    task = give(hub, "tech-lead", "worker-a", "Build it")
    hub.session("worker-a").finish_task(task.id, "built")
    with pytest.raises(PermissionDenied, match="reviews task"):
        hub.session("worker-b").review_task(task.id, accept=True)
    assert hub.session("leader").review_task(task.id, accept=True).state == "accepted"


def test_only_done_tasks_are_reviewed(hub):
    task = give(hub, "tech-lead", "worker-a", "x")
    with pytest.raises(HubError, match="only a done task is reviewed"):
        hub.session("tech-lead").review_task(task.id, accept=True)


# dependencies (after Beads)


def test_a_task_waits_for_the_tasks_it_depends_on(hub):
    lead = hub.session("tech-lead")
    api = lead.assign_task("worker-a", "Build the API")
    tests = lead.assign_task("worker-b", "Test the API", after=[api.id])
    assert tests.state == "waiting" and tests.message_id is None
    assert hub.session("worker-b").read_inbox() == []  # nothing delivered yet
    assert [t.id for t in hub.session("worker-b").queued_tasks()] == [tests.id]
    with pytest.raises(HubError, match="has not started"):
        hub.session("worker-b").finish_task(tests.id, "done?")
    hub.session("worker-a").finish_task(api.id, "API ready")
    assert hub.store.get_task(tests.id).state == "open"
    [delivered] = hub.session("worker-b").read_inbox()
    assert delivered.text.startswith(f"Task #{tests.id}: Test the API")


def test_a_task_waits_for_all_of_them(hub):
    lead = hub.session("tech-lead")
    one, two = lead.assign_task("worker-a", "one"), lead.assign_task("worker-b", "two")
    both = lead.assign_task("worker-a", "after both", after=[one.id, two.id])
    hub.session("worker-a").finish_task(one.id, "ok")
    assert hub.store.get_task(both.id).state == "waiting"
    hub.session("worker-b").finish_task(two.id, "ok")
    assert hub.store.get_task(both.id).state == "open"


def test_a_failed_dependency_is_reported(hub):
    lead = hub.session("tech-lead")
    first = lead.assign_task("worker-a", "first")
    then = lead.assign_task("worker-b", "then", after=[first.id])
    lead.read_inbox()
    hub.session("worker-a").finish_task(first.id, "impossible", outcome="failed")
    notes = [m for m in lead.read_inbox() if m.sender == "hub"]
    assert f"Task #{then.id} (then) waits for #{first.id}, which ended as failed" in notes[0].text
    with pytest.raises(HubError, match="will never be done"):
        lead.assign_task("worker-b", "later", after=[first.id])


def test_priority_one_is_urgent(hub):
    task = give(hub, "tech-lead", "worker-a", "Hotfix", priority=1)
    [message] = hub.session("worker-a").read_inbox()
    assert message.urgent and "[urgent priority]" in message.text
    with pytest.raises(HubError, match="priority must be"):
        give(hub, "tech-lead", "worker-a", "x", priority=7)
    assert task.priority == 1


def test_cancelling_a_waiting_task_is_quiet(hub):
    lead = hub.session("tech-lead")
    first = lead.assign_task("worker-a", "first")
    later = lead.assign_task("worker-b", "later", after=[first.id])
    lead.cancel_task(later.id)
    assert hub.session("worker-b").read_inbox() == []  # it never reached worker-b


# threads and search (after MCP Agent Mail)


def test_a_task_keeps_its_conversation_together(hub):
    task = give(hub, "tech-lead", "worker-a", "Build it")
    worker = hub.session("worker-a")
    [assignment] = worker.read_inbox()
    worker.send("tech-lead", "Which port?", reply_to=assignment.id)
    worker.finish_task(task.id, "built")
    task, thread = hub.session("leader").task_details(task.id)
    assert [m.kind for m in thread] == ["task", "report", "result"]
    with pytest.raises(PermissionDenied, match="you can see its status with team_status"):
        hub.session("researcher").task_details(task.id)


def test_search_finds_only_what_you_may_read(hub):
    hub.session("tech-lead").send("worker-a", "The database password is in vault")
    hub.session("leader").send("researcher", "Research the database options")
    assert [m.recipient for m in hub.session("worker-a").search("database")] == ["worker-a"]
    assert len(hub.session("leader").search("database")) == 2
    assert len(hub.session("you").search("DATABASE")) == 2  # case does not matter
    assert hub.session("worker-b").search("database") == []


# leases (after MCP Agent Mail)


def test_a_folder_lease_covers_every_file_in_it(hub, team):
    worker = hub.session("worker-a")
    lease = worker.claim("src/api/*", reason="task #7")
    assert lease.pattern and lease.reason == "task #7"
    assert worker.can_write("src/api/users.py")
    assert not hub.session("tech-lead").can_write("src/api/users.py")
    with pytest.raises(LockConflict, match="being written by worker-a for task #7"):
        hub.session("tech-lead").claim("src/api/users.py")
    with pytest.raises(LockConflict):
        hub.session("tech-lead").claim("src/*")  # overlaps the folder
    hub.session("tech-lead").claim("src/web/app.py")  # elsewhere is fine
    denied = hooks.on_pre_edit(hub.session("tech-lead"), {"tool_name": "Edit", "cwd": str(team.project_root),
                                                          "tool_input": {"file_path": "src/api/users.py"}})
    assert "its lease on src/api/* covers it" in denied["hookSpecificOutput"]["permissionDecisionReason"]
    with pytest.raises(HubError, match="covered by worker-a's lease on src/api/\\*"):
        worker.release("src/api/users.py")
    worker.release("src/api/*")
    assert not worker.can_write("src/api/users.py")


def test_patterns_must_stay_in_the_project(hub):
    with pytest.raises(PermissionDenied, match="relative to the project folder"):
        hub.session("worker-a").claim("../src/*")


def test_a_lease_names_the_task_it_is_for(hub):
    task = give(hub, "tech-lead", "worker-a", "Build it")
    hub.session("worker-a").read_inbox()
    assert hub.session("worker-a").claim("src/app.py").reason == f"task #{task.id}"


def test_expired_leases_free_the_file(hub):
    worker = hub.session("worker-a")
    worker.claim("src/app.py")
    hub.store._db.execute("UPDATE locks SET expires_at = ?", (time.time() - 1,))
    assert hub.store.locks() == []
    assert hub.session("tech-lead").claim("src/app.py").owner == "tech-lead"


def test_activity_renews_leases(hub):
    worker = hub.session("worker-a")
    worker.claim("src/app.py")
    hub.store._db.execute("UPDATE locks SET expires_at = ?", (time.time() + 5,))
    hooks.on_post_tool(worker, {})
    assert hub.store.locks()[0].expires_at > time.time() + 3000
    assert "worker-a" in hub.store.activity()


# the watchdog (after Gas Town's Witness)


def test_watchdog_releases_expired_leases_without_waking_the_holder(hub):
    hub.session("worker-a").claim("src/app.py")
    hub.store._db.execute("UPDATE locks SET expires_at = ?", (time.time() - 1,))
    watchdog.patrol(hub)
    assert hub.store.locks() == []
    assert hub.session("worker-a").read_inbox() == []  # no message: it would wake an idle agent for nothing
    assert any("lease on src/app.py ran out" in e.text for e in hub.store.events_after(0))


def test_watchdog_lists_agents_that_stopped_with_work(hub):
    give(hub, "tech-lead", "worker-a", "Build it")
    problems = watchdog.patrol(hub)
    stopped = [p for p in problems if p.kind == "stopped"]
    assert stopped and stopped[0].role == "worker-a" and stopped[0].action == "start"
    hub.store.check_in(1, "worker-a")
    assert not [p for p in watchdog.patrol(hub) if p.kind == "stopped"]


def test_watchdog_nudges_a_stalled_task_then_tells_the_assigner(hub):
    task = give(hub, "tech-lead", "worker-a", "Build it")
    hub.session("worker-a").read_inbox()
    hub.session("tech-lead").read_inbox()
    hub.store.check_in(1, "worker-a")
    later = time.time() + watchdog.STALL + 5
    watchdog.patrol(hub, now=later)
    [nudge] = hub.session("worker-a").read_inbox()
    assert nudge.sender == "hub" and f"Task #{task.id} (Build it) has shown no progress" in nudge.text
    watchdog.patrol(hub, now=later + 60)  # still inside the grace period: nothing more
    assert hub.session("tech-lead").read_inbox() == []
    hub.store.check_in(1, "worker-a")
    problems = watchdog.patrol(hub, now=later + watchdog.STALL + 5)
    [told] = hub.session("tech-lead").read_inbox()
    assert "has stalled" in told.text
    assert any(p.kind == "stalled" and p.task_id == task.id for p in problems)
    watchdog.patrol(hub, now=later + watchdog.STALL + 90)
    assert hub.session("tech-lead").read_inbox() == []  # told once


def test_progress_resets_the_nudge(hub):
    task = give(hub, "tech-lead", "worker-a", "Build it")
    hub.session("worker-a").read_inbox()
    hub.store.check_in(1, "worker-a")
    later = time.time() + watchdog.STALL + 5
    watchdog.patrol(hub, now=later)
    hub.store._db.execute("UPDATE activity SET at = ? WHERE role = 'worker-a'", (later + 10,)) \
        if hub.store.activity() else hub.store._db.execute(
            "INSERT INTO activity (role, at) VALUES ('worker-a', ?)", (later + 10,))
    watchdog.patrol(hub, now=later + 20)
    assert hub.store.get_task(task.id).nudged_at is None


def test_waiting_for_subtasks_is_not_stalling(hub):
    task = give(hub, "leader", "tech-lead", "Build the app")
    hub.session("tech-lead").read_inbox()
    hub.session("tech-lead").assign_task("worker-a", "Build a part", part_of=task.id)
    hub.store.check_in(1, "tech-lead")
    watchdog.patrol(hub, now=time.time() + 10 * watchdog.STALL)
    assert all(m.sender != "hub" for m in hub.session("tech-lead").read_inbox())


def test_unanswered_questions_are_passed_up(hub):
    question = hub.session("worker-a").ask_help("Which database?")
    watchdog.patrol(hub, now=time.time() + watchdog.HELP_WAIT + 5)
    [note] = hub.session("leader").read_inbox()
    assert note.sender == "hub" and f"worker-a asked tech-lead for help (#{question.id})" in note.text
    watchdog.patrol(hub, now=time.time() + watchdog.HELP_WAIT + 60)
    assert hub.session("leader").read_inbox() == []  # once


def test_what_waits_for_the_owner_is_listed(hub):
    question = hub.session("leader").ask_help("English or Chinese?")
    task = give(hub, "you", "leader", "Build it")
    hub.session("leader").finish_task(task.id, "built")
    kinds = {p.kind: p for p in watchdog.patrol(hub, act=False)}
    assert kinds["question"].message_id == question.id and kinds["question"].action == "answer"
    assert kinds["review"].task_id == task.id


def test_message_loops_are_flagged(hub):
    a, b = hub.session("worker-a"), hub.session("worker-b")
    for i in range(watchdog.LOOP_LIMIT // 2 + 1):
        a.send("worker-b", f"ping {i}")
        b.send("worker-a", f"pong {i}")
    problems = watchdog.patrol(hub)
    assert any(p.kind == "loop" for p in problems)
    notes = [m for m in hub.session("tech-lead").read_inbox() if m.sender == "hub"]
    assert "going round in circles" in notes[0].text


def test_duplicate_sessions_are_flagged(hub):
    hub.store.check_in(1, "worker-a")
    hub.store.check_in(2, "worker-a")
    assert any(p.kind == "duplicate" and p.action == "stop" for p in watchdog.patrol(hub))


# events: the activity feed


def test_events_record_what_happened(hub):
    task = give(hub, "tech-lead", "worker-a", "Build it")
    hub.session("worker-a").read_inbox()
    hub.session("worker-a").claim("src/app.py")
    hub.session("worker-a").finish_task(task.id, "built")
    texts = [e.text for e in hub.store.events_after(0)]
    assert texts == [f"gave #{task.id} to worker-a: Build it", f"started #{task.id}: Build it",
                     f"took src/app.py (task #{task.id})", f"#{task.id} done: Build it",
                     "released src/app.py: its tasks are finished"]


def test_closing_the_last_task_releases_the_agents_files(hub):
    worker = hub.session("worker-a")
    lead = hub.session("tech-lead")
    first = lead.assign_task("worker-a", "Parser")
    second = lead.assign_task("worker-a", "Writer")
    worker.read_inbox()
    worker.claim("src/parser.py")
    worker.finish_task(first.id, "parsed")
    assert [lock.path for lock in hub.store.locks("worker-a")] == ["src/parser.py"]  # still busy: keeps them
    worker.finish_task(second.id, "written")
    assert hub.store.locks("worker-a") == [] and worker.released == ["src/parser.py"]  # nothing left to hold for


def test_where_you_left_off_carries_only_what_is_still_useful(hub):
    from agent_org.cards import QUIET_RECENT, role_card
    lead = hub.session("tech-lead")
    for i in range(6):
        lead.send("worker-a", f"note {i}")
    worker = hub.session("worker-a")
    card = role_card(worker)
    assert "note 5" in card and "note 1" not in card and card.count("tech-lead -> worker-a") == QUIET_RECENT
    assert "Your last" not in role_card(worker, resumed=True)  # a continued conversation has them already
    task = lead.assign_task("worker-a", "Build the parser")
    card = role_card(worker)
    assert f"Task #{task.id}" in card and "note 5" not in card  # with open work: the messages about it


def test_the_hub_keeps_an_agents_status_without_calls(hub):
    worker = hub.session("worker-a")
    task = hub.session("tech-lead").assign_task("worker-a", "Build the parser")
    worker.read_inbox()
    assert (hub.store.get_status("worker-a").state, hub.store.get_status("worker-a").task) == (
        "working", f"#{task.id} Build the parser")
    worker.finish_task(task.id, "built")
    assert hub.store.get_status("worker-a").state == "idle"
