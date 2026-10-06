"""The message law: replies, tasks, help, broadcasts, urgency and economy."""

import sqlite3

import pytest

from agent_org import hooks
from agent_org.cards import role_card
from agent_org.hub import MAX_TEXT, HubError, PermissionDenied, law_text
from agent_org.store import Store


def test_the_law_reads_as_numbered_rules():
    text = law_text()
    assert text.startswith("1. Chain of command.")
    assert "5. Every task ends with a result." in text and "6. Results are checked." in text
    assert "12. Urgent is rare." in text


# law 2: answering is always allowed


def test_you_may_answer_whoever_wrote_to_you(hub):
    order = hub.session("leader").send("worker-a", "use SQLite")  # skips tech-lead: allowed downward
    worker = hub.session("worker-a")
    with pytest.raises(PermissionDenied, match="You may also reply to any message sent to you"):
        worker.send("leader", "why SQLite?")  # unsolicited, upward past tech-lead
    reply = worker.send("leader", "done, SQLite it is", reply_to=order.id)
    assert (reply.kind, reply.recipient, reply.reply_to) == ("reply", "leader", order.id)


def test_replying_needs_the_other_side_to_have_written(hub):
    note = hub.session("tech-lead").send("worker-a", "hello")
    with pytest.raises(PermissionDenied):
        hub.session("worker-a").send("leader", "hi", reply_to=note.id)  # tech-lead wrote it, not leader


# laws 3 and 4: tasks go down and always get closed


def test_tasks_go_down_and_their_result_goes_back_to_the_assigner(hub):
    task = hub.session("leader").assign_task("worker-a", "Build the login form", "Email + password")
    assert (task.assigner, task.assignee, task.state) == ("leader", "worker-a", "open")
    [message] = hub.session("worker-a").read_inbox()
    assert message.kind == "task" and message.text.startswith(f"Task #{task.id}: Build the login form")
    assert f"finish_task({task.id}, result)" in message.text
    done = hub.session("worker-a").finish_task(task.id, "Form is in src/login.py")
    assert done.state == "done"
    [result] = hub.session("leader").read_inbox()  # past tech-lead: it is the answer to leader's task
    assert (result.kind, result.reply_to) == ("result", message.id)
    assert result.text.startswith(f"Task #{task.id} is DONE - please review it: Build the login form")
    assert result.task_id == task.id  # the result is in the task's thread


def test_tasks_cannot_go_up_or_sideways(hub):
    with pytest.raises(PermissionDenied, match="Peers coordinate but don't assign work"):
        hub.session("worker-a").assign_task("worker-b", "write tests")
    with pytest.raises(PermissionDenied, match="only assign tasks to people below you"):
        hub.session("worker-a").assign_task("tech-lead", "review")
    with pytest.raises(PermissionDenied, match="not a role"):
        hub.session("leader").assign_task("you", "approve")


def test_the_owner_gives_the_leader_tasks(hub):
    task = hub.session("you").assign_task("leader", "Build a todo app")
    hub.session("leader").finish_task(task.id, "Ready in todo.py")
    [result] = hub.session("you").read_inbox()
    assert result.recipient == "you" and "Ready in todo.py" in result.text


def test_only_the_assignee_closes_a_task_and_only_once(hub):
    task = hub.session("tech-lead").assign_task("worker-a", "x")
    with pytest.raises(PermissionDenied, match="not assigned to you"):
        hub.session("worker-b").finish_task(task.id, "done")
    with pytest.raises(HubError, match="outcome must be"):
        hub.session("worker-a").finish_task(task.id, "hmm", outcome="maybe")
    hub.session("worker-a").finish_task(task.id, "done")
    with pytest.raises(HubError, match="already done"):
        hub.session("worker-a").finish_task(task.id, "again")


def test_a_blocked_task_stays_open_for_the_assigner_to_resolve(hub):
    task = hub.session("tech-lead").assign_task("worker-a", "Deploy")
    blocked = hub.session("worker-a").finish_task(task.id, "Need the server password", outcome="blocked")
    assert blocked.state == "blocked" and blocked.is_open
    [result] = hub.session("tech-lead").read_inbox()
    assert f"Task #{task.id} is BLOCKED: Deploy" in result.text
    assert [t.id for t in hub.session("tech-lead").given_tasks()] == [task.id]
    hub.session("worker-a").finish_task(task.id, "Deployed after all")  # blocked -> done is fine


def test_cancelling(hub):
    task = hub.session("tech-lead").assign_task("worker-a", "Old idea")
    hub.session("worker-a").read_inbox()  # it started: it is told to stop (an unread task is just taken back)
    with pytest.raises(PermissionDenied, match="only tech-lead or someone above worker-a"):
        hub.session("worker-b").cancel_task(task.id)
    hub.session("leader").cancel_task(task.id, "not needed")  # above the assignee
    assert hub.store.get_task(task.id).state == "cancelled"
    notice = hub.session("worker-a").read_inbox()[-1]
    assert "is cancelled; stop working on it. Reason: not needed" in notice.text


def test_subtasks_belong_to_your_own_task(hub):
    big = hub.session("leader").assign_task("tech-lead", "Build the app")
    part = hub.session("tech-lead").assign_task("worker-a", "Build the form", part_of=big.id)
    assert part.parent_id == big.id
    with pytest.raises(PermissionDenied, match="not one of your tasks"):
        hub.session("tech-lead").assign_task("worker-a", "x", part_of=part.id)


# law 5: help goes up and gets an answer


def test_unanswered_help_is_tracked(hub):
    question = hub.session("worker-a").ask_help("Which port?")
    lead = hub.session("tech-lead")
    assert [m.id for m in lead.unanswered_help()] == [question.id]
    lead.send("worker-a", "8080", reply_to=question.id)
    assert lead.unanswered_help() == []


def test_a_consultant_counts_as_an_answer(hub):
    question = hub.session("worker-a").ask_help("Race condition?")
    hub.session("tech-lead").summon_consultant(question.id, "medium")
    assert hub.session("tech-lead").unanswered_help() == []


# broadcasts, urgency and economy


def test_broadcast_to_team_or_everyone_below(hub):
    team = hub.session("leader").broadcast("@team", "Freeze at 5pm")
    assert sorted(m.recipient for m in team) == ["researcher", "tech-lead"]
    everyone = hub.session("leader").broadcast("@all", "Freeze at 5pm")
    assert sorted(m.recipient for m in everyone) == ["researcher", "tech-lead", "worker-a", "worker-b"]
    with pytest.raises(HubError, match="nobody below you"):
        hub.session("worker-a").broadcast("@team", "hi")
    with pytest.raises(HubError, match="use broadcast"):
        hub.session("leader").send("@team", "hi")


def test_urgent_only_goes_down(hub):
    assert hub.session("tech-lead").send("worker-a", "STOP: wrong branch", urgent=True).urgent
    with pytest.raises(PermissionDenied, match="only messages to people below you may be urgent"):
        hub.session("worker-a").send("tech-lead", "look!", urgent=True)


def test_urgent_messages_interrupt_in_full(hub):
    worker = hub.session("worker-a")
    hub.session("tech-lead").send("worker-a", "FYI later")
    hub.session("tech-lead").send("worker-a", "STOP: wrong branch", urgent=True)
    context = hooks.on_post_tool(worker, {})["hookSpecificOutput"]["additionalContext"]
    assert "URGENT" in context and "STOP: wrong branch" in context
    assert "1 new message(s) for you from tech-lead (#1)" in context
    assert [m.text for m in worker.read_inbox()] == ["FYI later"]  # the urgent one was delivered


def test_messages_have_a_size_limit(hub):
    with pytest.raises(HubError, match="Put long material in a file"):
        hub.session("worker-a").send("tech-lead", "x" * (MAX_TEXT + 1))


# reminders when an agent goes quiet


def test_reminders_follow_the_law(hub):
    lead = hub.session("tech-lead")
    mine = hub.session("leader").assign_task("tech-lead", "Design the API")
    given = lead.assign_task("worker-a", "Build it")
    hub.session("worker-a").finish_task(given.id, "No database access", outcome="blocked")
    question = hub.session("worker-b").ask_help("Which test runner?")
    lead.read_inbox()
    reason = hooks.on_stop(lead, {"stop_hook_active": False}, wait=0.1, poll=0.05)["reason"]
    assert f"Task #{mine.id} from leader (Design the API) is still open" in reason
    assert f"Task #{given.id} you gave to worker-a (Build it) is blocked: No database access" in reason
    assert f"worker-b asked you for help (#{question.id}) and has no answer yet" in reason


def test_an_agent_waiting_for_the_work_it_gave_out_is_not_pushed_on(hub):
    lead = hub.session("tech-lead")
    mine = hub.session("leader").assign_task("tech-lead", "Design the API")
    lead.read_inbox()
    lead.assign_task("worker-a", "Build it")  # it handed the work down and now waits for the result
    out = hooks.on_stop(lead, {"stop_hook_active": False}, wait=0.1, poll=0.05)
    assert out is None or f"Task #{mine.id}" not in out.get("reason", "")


# memory: where you left off


def test_role_card_carries_the_law_and_where_you_left_off(hub):
    worker = hub.session("worker-a")
    hub.session("tech-lead").assign_task("worker-a", "Build the form")
    worker.claim("src/form.py")
    worker.save_notes("Using Flask. The form posts to /login.")
    card = role_card(worker)
    assert "THE MESSAGE LAW" in card and "2. Answering is always allowed." in card
    assert "WHERE YOU LEFT OFF" in card
    assert "Using Flask. The form posts to /login." in card
    assert "[open] from tech-lead: Build the form" in card
    assert "Files you hold: src/form.py" in card
    assert "[task] tech-lead -> worker-a: Task #1: Build the form" in card


def test_a_new_role_has_nothing_to_recall(hub):
    assert "WHERE YOU LEFT OFF" not in role_card(hub.session("researcher"))


def test_notes_are_replaced_and_limited(hub):
    worker = hub.session("worker-a")
    worker.save_notes("one")
    worker.save_notes("two")
    assert hub.store.get_notes("worker-a") == "two"
    with pytest.raises(HubError, match="limited"):
        worker.save_notes("x" * (MAX_TEXT + 1))


# the team overview shows tasks


def test_overview_lists_open_tasks(hub):
    task = hub.session("tech-lead").assign_task("worker-b", "Write tests")
    rows = {r.name: r for r in hub.session("researcher").overview()}
    assert [t.id for t in rows["worker-b"].tasks] == [task.id]
    assert rows["worker-a"].tasks == []


# older databases keep working


def test_an_old_database_is_upgraded_in_place(tmp_path):
    path = tmp_path / "hub.db"
    old = sqlite3.connect(path)
    old.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sent_at REAL NOT NULL,"
                " sender TEXT NOT NULL, recipient TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,"
                " reply_to INTEGER, read_at REAL)")
    old.execute("INSERT INTO messages (sent_at, sender, recipient, kind, text) VALUES (1, 'a', 'b', 'report', 'hi')")
    old.commit()
    old.close()
    store = Store(path)
    assert store.get_message(1).text == "hi" and not store.get_message(1).urgent
    assert store.add_message("a", "b", "instruction", "go", urgent=True).urgent
    store.close()
