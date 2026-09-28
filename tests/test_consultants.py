import pytest

from agent_org.cards import role_card
from agent_org.hub import HubError, LockConflict, PermissionDenied


@pytest.fixture
def summoned(hub):
    """worker-a asks tech-lead for help; tech-lead attaches a 'medium' consultant."""
    request = hub.session("worker-a").ask_help("tests fail on Windows paths")
    role = hub.session("tech-lead").summon_consultant(request.id, "medium", "look at path joining")
    return request, role


# summoning


def test_consultant_joins_the_tree_under_the_agent_it_helps(hub, summoned, opener):
    request, role = summoned
    assert (role.name, role.superior, role.tier) == ("consultant-1", "worker-a", "medium")
    assert (role.harness, role.model, role.effort) == ("claude", "claude-opus-5-5", "medium")
    assert opener.opened == ["consultant-1"]
    team = hub.team
    assert team.subordinates_of("worker-a") == ["consultant-1"]
    assert "consultant-1" in team.subtree_of("leader")
    assert any("consultant-1  [claude / claude-opus-5-5]  (consultant, medium)" in line
               for line in team.tree_lines())


def test_consultant_gets_the_request_and_the_brief_and_the_helped_agent_is_told(hub, summoned):
    request, _ = summoned
    [task] = hub.session("consultant-1").read_inbox()
    assert task.sender == "tech-lead" and task.reply_to == request.id
    assert "tests fail on Windows paths" in task.text and "look at path joining" in task.text
    [notice] = hub.session("worker-a").read_inbox()
    assert "consultant-1" in notice.text and "hand_over_file" in notice.text


def test_only_the_superior_who_got_the_request_can_summon(hub):
    request = hub.session("worker-a").ask_help("help")
    for other in ("leader", "worker-b", "worker-a"):
        with pytest.raises(PermissionDenied, match="not a help request sent to you"):
            hub.session(other).summon_consultant(request.id, "medium")
    report = hub.session("worker-a").send("tech-lead", "just a report")
    with pytest.raises(PermissionDenied, match="not a help request"):
        hub.session("tech-lead").summon_consultant(report.id, "medium")


def test_owner_can_summon_for_the_leader(hub):
    request = hub.session("leader").ask_help("which architecture?")
    role = hub.session("you").summon_consultant(request.id, "high")
    assert role.superior == "leader"


def test_unknown_tier_is_refused(hub):
    request = hub.session("worker-a").ask_help("help")
    with pytest.raises(HubError, match="no consultant tier 'max'. Tiers: medium, high"):
        hub.session("tech-lead").summon_consultant(request.id, "max")


def test_max_active_per_tier(hub):
    lead = hub.session("tech-lead")
    first = hub.session("worker-a").ask_help("one")
    second = hub.session("worker-b").ask_help("two")
    lead.summon_consultant(first.id, "high")
    with pytest.raises(HubError, match="all 1 'high' consultants are busy"):
        lead.summon_consultant(second.id, "high")
    lead.summon_consultant(second.id, "medium")  # another tier still has room
    hub.session("worker-a").dismiss_consultant("consultant-1")
    third = hub.session("worker-a").ask_help("three")
    assert lead.summon_consultant(third.id, "high").name == "consultant-3"  # room again


def test_one_consultant_per_request(hub, summoned):
    request, _ = summoned
    with pytest.raises(HubError, match="already working on"):
        hub.session("tech-lead").summon_consultant(request.id, "high")


def test_consultants_cannot_get_consultants(hub, summoned):
    question = hub.session("consultant-1").ask_help("what is the expected output?")
    assert question.recipient == "worker-a"
    with pytest.raises(PermissionDenied, match="cannot get consultants of their own"):
        hub.session("worker-a").summon_consultant(question.id, "medium")


def test_failed_tab_leaves_no_consultant_behind(hub, opener):
    opener.fail = True
    request = hub.session("worker-a").ask_help("help")
    with pytest.raises(HubError, match="could not start consultant-1: no terminal"):
        hub.session("tech-lead").summon_consultant(request.id, "medium")
    assert hub.team.subordinates_of("worker-a") == []
    assert hub.session("worker-a").read_inbox() == []


# talking


def test_consultant_talks_only_with_the_agent_it_helps(hub, summoned):
    consultant = hub.session("consultant-1")
    assert consultant.send("worker-a", "found it").kind == "report"
    for other in ("tech-lead", "leader", "worker-b"):
        with pytest.raises(PermissionDenied, match="You can message: worker-a."):
            consultant.send(other, "hi")
    assert hub.session("worker-a").send("consultant-1", "try this").kind == "instruction"
    # and everyone above can reach and look at it, like any role in their subtree
    assert hub.session("leader").send("consultant-1", "keep it short").kind == "instruction"
    assert hub.session("tech-lead").view("consultant-1").superior == "worker-a"
    with pytest.raises(PermissionDenied):
        hub.session("worker-b").view("consultant-1")


def test_role_cards(hub, summoned):
    card = role_card(hub.session("consultant-1"))
    assert "temporary medium consultant" in card
    assert "tech-lead summoned you to help worker-a with its help request #1" in card
    assert "You can message only worker-a" in card
    lead_card = role_card(hub.session("tech-lead"))
    assert "summon_consultant(help_id, tier, brief)" in lead_card
    assert "high (codex / gpt-6-astra, high effort, up to 1 at once): tricky bugs and failing tests" in lead_card
    assert "summon_consultant" not in role_card(hub.session("worker-a"))


# files


def test_consultant_edits_only_files_handed_to_it(hub, summoned):
    worker, consultant = hub.session("worker-a"), hub.session("consultant-1")
    with pytest.raises(PermissionDenied, match="consultants can only edit files handed to them"):
        consultant.claim("src/paths.py")
    worker.claim("src/paths.py")
    lock = worker.hand_over("src/paths.py", "consultant-1")
    assert lock.owner == "consultant-1"
    assert consultant.can_write("src/paths.py") and not worker.can_write("src/paths.py")
    assert any("I handed src/paths.py over to you" in m.text for m in consultant.read_inbox())
    with pytest.raises(LockConflict, match="being written by consultant-1"):
        worker.claim("src/paths.py")
    back = consultant.hand_over("src/paths.py", "worker-a")
    assert back.owner == "worker-a"


def test_consultant_release_hands_the_file_back(hub, summoned):
    worker, consultant = hub.session("worker-a"), hub.session("consultant-1")
    worker.claim("tests/test_paths.py")
    worker.hand_over("tests/test_paths.py", "consultant-1")
    assert consultant.release("tests/test_paths.py").owner == "worker-a"
    assert worker.can_write("tests/test_paths.py")


def test_hand_over_rules(hub):
    worker, lead = hub.session("worker-a"), hub.session("tech-lead")
    with pytest.raises(HubError, match="you do not hold src/a.py"):
        worker.hand_over("src/a.py", "tech-lead")
    worker.claim("src/a.py")
    with pytest.raises(PermissionDenied, match="direct superior or a direct subordinate"):
        worker.hand_over("src/a.py", "worker-b")  # sibling
    with pytest.raises(PermissionDenied, match="direct superior or a direct subordinate"):
        worker.hand_over("src/a.py", "leader")  # two levels up
    assert worker.hand_over("src/a.py", "tech-lead").owner == "tech-lead"
    worker.claim("tests/b.py")
    with pytest.raises(PermissionDenied, match="outside tech-lead's write scope"):
        worker.hand_over("tests/b.py", "tech-lead")
    assert lead.hand_over("src/a.py", "worker-a").owner == "worker-a"


# dismissing


def test_dismissal_returns_files_and_ends_the_consultant(hub, summoned):
    worker = hub.session("worker-a")
    worker.claim("src/paths.py")
    worker.hand_over("src/paths.py", "consultant-1")
    consultant = hub.session("consultant-1")
    role, returned = worker.dismiss_consultant("consultant-1")
    assert (role.name, returned) == ("consultant-1", ["src/paths.py"])
    assert worker.can_write("src/paths.py")
    assert hub.team.subordinates_of("worker-a") == []
    for action in (lambda: consultant.read_inbox(), lambda: consultant.send("worker-a", "hi"),
                   lambda: consultant.set_status("working")):
        with pytest.raises(PermissionDenied, match="you were dismissed by worker-a"):
            action()


def test_a_waiting_consultant_learns_it_was_dismissed(hub, summoned, team):
    import threading
    import time

    from agent_org.hub import Hub
    from agent_org.store import Store

    consultant = hub.session("consultant-1")
    consultant.read_inbox()

    def dismiss_later():
        time.sleep(0.3)
        other = Hub(team, Store(team.database))  # another agent's process
        other.session("worker-a").dismiss_consultant("consultant-1")
        other.close()

    thread = threading.Thread(target=dismiss_later)
    thread.start()
    with pytest.raises(PermissionDenied, match="dismissed"):
        consultant.wait_for_messages(timeout=5, poll=0.05)
    thread.join()


def test_who_can_dismiss(hub, summoned):
    with pytest.raises(PermissionDenied, match="only worker-a, or someone above it"):
        hub.session("worker-b").dismiss_consultant("consultant-1")
    with pytest.raises(PermissionDenied):
        hub.session("consultant-1").dismiss_consultant("consultant-1")
    with pytest.raises(HubError, match="not an active consultant"):
        hub.session("tech-lead").dismiss_consultant("worker-a")
    hub.session("worker-a").read_inbox()
    hub.session("leader").dismiss_consultant("consultant-1")  # from above: worker-a is told
    [notice] = hub.session("worker-a").read_inbox()
    assert notice.text == "I dismissed consultant-1."
