import os
import threading
import time

import pytest

from agent_org.hub import HubError, LockConflict, PermissionDenied
from agent_org.store import Store

# messaging: who may talk to whom


@pytest.mark.parametrize(
    "sender, to, kind",
    [
        ("worker-a", "tech-lead", "report"),      # to direct superior
        ("tech-lead", "leader", "report"),
        ("leader", "you", "report"),              # the leader reports to the owner
        ("tech-lead", "worker-a", "instruction"),  # to a direct subordinate
        ("leader", "worker-b", "instruction"),     # to a subordinate's subordinate
        ("you", "worker-a", "instruction"),        # the owner reaches everyone
    ],
)
def test_allowed_messages(hub, sender, to, kind):
    message = hub.session(sender).send(to, "hello")
    assert (message.sender, message.recipient, message.kind) == (sender, to, kind)


@pytest.mark.parametrize(
    "sender, to",
    [
        ("worker-a", "leader"),      # skipping a level upward
        ("worker-a", "you"),
        ("worker-a", "worker-b"),    # sibling
        ("worker-a", "researcher"),  # cousin
        ("tech-lead", "researcher"),  # sibling of the superior's other branch
        ("researcher", "worker-a"),  # not in researcher's subtree
    ],
)
def test_forbidden_messages(hub, sender, to):
    with pytest.raises(PermissionDenied, match="you cannot message"):
        hub.session(sender).send(to, "hello")


def test_refusal_tells_the_agent_who_it_can_reach(hub):
    with pytest.raises(PermissionDenied, match=r"You can message: leader, worker-a, worker-b\."):
        hub.session("tech-lead").send("researcher", "hi")


def test_cannot_message_self_or_strangers(hub):
    with pytest.raises(PermissionDenied, match="yourself"):
        hub.session("leader").send("leader", "hi")
    with pytest.raises(PermissionDenied, match="not in this team"):
        hub.session("leader").send("ghost", "hi")
    with pytest.raises(PermissionDenied, match="not in this team"):
        hub.session("ghost")


def test_empty_messages_are_refused(hub):
    with pytest.raises(HubError, match="empty"):
        hub.session("worker-a").send("tech-lead", "   ")


def test_help_goes_to_the_direct_superior(hub):
    message = hub.session("worker-b").ask_help("how do I run the tests?")
    assert (message.recipient, message.kind) == ("tech-lead", "help")
    with pytest.raises(PermissionDenied, match="no superior"):
        hub.session("you").ask_help("anyone?")


def test_superior_can_pass_help_up_as_a_reply_chain(hub):
    question = hub.session("worker-a").ask_help("which database?")
    passed_up = hub.session("tech-lead").ask_help("worker-a asks: which database?", reply_to=question.id)
    assert (passed_up.recipient, passed_up.reply_to) == ("leader", question.id)


def test_reply_to_must_be_your_own_message(hub):
    other = hub.session("worker-b").send("tech-lead", "private")
    with pytest.raises(PermissionDenied, match="not one of yours"):
        hub.session("worker-a").send("tech-lead", "re", reply_to=other.id)


def test_inbox_is_read_once(hub):
    hub.session("tech-lead").send("worker-a", "task 1")
    hub.session("leader").send("worker-a", "task 2")
    worker = hub.session("worker-a")
    assert [m.text for m in worker.read_inbox()] == ["task 1", "task 2"]
    assert worker.read_inbox() == []


def test_wait_returns_when_a_message_arrives(hub, team):
    def send_later():
        time.sleep(0.3)
        other = Store(team.database)  # a separate connection, like another agent's process
        other.add_message("tech-lead", "worker-a", "instruction", "go")
        other.close()

    thread = threading.Thread(target=send_later)
    thread.start()
    started = time.monotonic()
    messages = hub.session("worker-a").wait_for_messages(timeout=5, poll=0.05)
    thread.join()
    assert [m.text for m in messages] == ["go"]
    assert time.monotonic() - started < 3


def test_wait_times_out_empty(hub):
    assert hub.session("worker-a").wait_for_messages(timeout=0.2, poll=0.05) == []


# looking


def test_superiors_can_view_their_whole_subtree(hub):
    hub.session("worker-a").set_status("working", "login form")
    hub.session("worker-a").send("tech-lead", "halfway done")
    view = hub.session("leader").view("worker-a")
    assert view.status.state == "working" and view.status.task == "login form"
    assert [m.text for m in view.recent] == ["halfway done"]
    assert view.superior == "tech-lead"


def test_viewing_does_not_mark_messages_read(hub):
    hub.session("worker-a").send("tech-lead", "done")
    assert hub.session("leader").view("tech-lead").unread == 1
    assert [m.text for m in hub.session("tech-lead").read_inbox()] == ["done"]


@pytest.mark.parametrize(
    "viewer, target",
    [("worker-a", "tech-lead"), ("worker-a", "worker-b"), ("tech-lead", "researcher"), ("researcher", "leader")],
)
def test_cannot_view_above_or_sideways(hub, viewer, target):
    with pytest.raises(PermissionDenied, match="only look at yourself"):
        hub.session(viewer).view(target)


def test_status_must_be_a_known_state(hub):
    with pytest.raises(HubError, match="state must be one of"):
        hub.session("worker-a").set_status("napping")


# file locks


def test_one_writer_per_file(hub):
    lock = hub.session("worker-a").claim("tests/test_login.py")
    assert (lock.path, lock.owner) == ("tests/test_login.py", "worker-a")
    with pytest.raises(LockConflict, match="being written by worker-a"):
        hub.session("worker-b").claim("tests/test_login.py")
    assert hub.session("worker-a").claim("tests/test_login.py").owner == "worker-a"  # re-claim is fine


def test_claims_are_limited_to_write_scope(hub):
    with pytest.raises(PermissionDenied, match="outside your write scope"):
        hub.session("worker-b").claim("src/app.py")
    with pytest.raises(PermissionDenied, match=r"write scope \(nothing\)"):
        hub.session("researcher").claim("notes.md")
    assert hub.session("you").claim("anything/at/all.txt").owner == "you"


def test_paths_outside_the_project_are_refused(hub):
    with pytest.raises(PermissionDenied, match="outside the project folder"):
        hub.session("worker-a").claim("../escape.py")


def test_same_file_written_differently_shares_one_lock(hub):
    hub.session("worker-a").claim("src/app.py")
    with pytest.raises(LockConflict):
        hub.session("tech-lead").claim("./src/../src/app.py")


@pytest.mark.skipif(os.name != "nt", reason="Windows paths are case-insensitive")
def test_windows_case_variants_share_one_lock(hub):
    hub.session("worker-a").claim("src/App.py")
    with pytest.raises(LockConflict):
        hub.session("tech-lead").claim("SRC/app.PY")


def test_release_by_holder_or_superiors_only(hub):
    hub.session("worker-a").claim("tests/a.py")
    with pytest.raises(PermissionDenied, match="only they or their superiors"):
        hub.session("worker-b").release("tests/a.py")
    with pytest.raises(PermissionDenied):
        hub.session("researcher").release("tests/a.py")
    hub.session("leader").release("tests/a.py")  # two levels up
    assert hub.session("worker-b").claim("tests/a.py").owner == "worker-b"
    hub.session("worker-b").release("tests/a.py")
    with pytest.raises(HubError, match="not locked"):
        hub.session("worker-b").release("tests/a.py")


def test_can_write_only_while_holding_the_lock(hub):
    worker = hub.session("worker-a")
    assert not worker.can_write("src/app.py")
    worker.claim("src/app.py")
    assert worker.can_write("src/app.py")
    assert not hub.session("tech-lead").can_write("src/app.py")
    assert not worker.can_write("../outside.py")


def test_racing_claims_have_exactly_one_winner(team):
    Store(team.database).close()  # create the database before the racers connect
    winners, barrier = [], threading.Barrier(8)

    def race(role):
        store = Store(team.database)
        barrier.wait()
        if store.claim("src/race.py", "src/race.py", role).owner == role:
            winners.append(role)
        store.close()

    threads = [threading.Thread(target=race, args=(f"r{i}",)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(winners) == 1
