"""Branch mode: every agent in its own git worktree; finished work lands in main at once."""

import copy
import subprocess

import pytest

from agent_org import gitops, hooks
from agent_org.hub import Hub, HubError
from agent_org.store import Store
from agent_org.team import Team

from .conftest import TEAM

pytestmark = pytest.mark.skipif(subprocess.run(["git", "--version"], capture_output=True).returncode != 0,
                                reason="needs git")

SHARED = "tests/test_shared.py"
BASE = "def first():\n    return 1\n\n\ndef middle():\n    return 'untouched'\n\n\ndef last():\n    return 3\n"


@pytest.fixture
def hub(tmp_path):
    data = copy.deepcopy(TEAM)
    data["isolation"] = "branches"
    root = tmp_path / "project"
    (root / "tests").mkdir(parents=True)
    (root / SHARED).write_text(BASE, encoding="utf-8")
    team = Team.from_dict(data, base_dir=tmp_path)
    hub = Hub(team, Store(team.database))
    yield hub
    hub.close()


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=True).stdout


def start(hub, role, title="Change the shared file"):
    task = hub.session("tech-lead").assign_task(role, title)
    wt = hub.prepare_root(role)
    hub.session(role).read_inbox()
    return task, wt


def edit(wt, old, new):
    path = wt / SHARED
    path.write_text(path.read_text(encoding="utf-8").replace(old, new), encoding="utf-8")


def main_text(hub):
    return (hub.base_team.project_root / SHARED).read_text(encoding="utf-8")


def test_each_agent_gets_its_own_copy_on_its_own_branch(hub):
    wt = hub.prepare_root("worker-a")
    root = hub.base_team.project_root
    assert gitops.is_own_repo(root)  # history turned on by itself
    assert wt == root / ".agent-org" / "worktrees" / "worker-a" and (wt / SHARED).read_text(encoding="utf-8") == BASE
    assert git(wt, "rev-parse", "--abbrev-ref", "HEAD").strip() == "agent/worker-a"
    assert hub.root_of("worker-a") == wt and hub.root_of("you") == root


def test_two_agents_change_one_file_in_different_places(hub):
    a_task, a = start(hub, "worker-a")
    b_task, b = start(hub, "worker-b")
    edit(a, "return 1", "return 'one'")
    edit(b, "return 3", "return 'three'")
    done_a = hub.session("worker-a").finish_task(a_task.id, "first() says one")
    assert done_a.commit_id and "return 'one'" in main_text(hub)  # in main at once, before any review
    done_b = hub.session("worker-b").finish_task(b_task.id, "last() says three")
    text = main_text(hub)
    assert "return 'one'" in text and "return 'three'" in text and "'untouched'" in text  # merged by git
    assert done_b.commit_id != done_a.commit_id
    log = git(hub.base_team.project_root, "log", "--oneline", "--first-parent")
    assert f"task #{a_task.id}" in log and f"task #{b_task.id}" in log


def test_same_lines_come_back_to_the_agent_to_settle(hub):
    a_task, a = start(hub, "worker-a")
    b_task, b = start(hub, "worker-b")
    edit(a, "'untouched'", "'from a'")
    edit(b, "'untouched'", "'from b'")
    hub.session("worker-a").finish_task(a_task.id, "a's version")
    with pytest.raises(HubError, match="(?s)both changed the same lines in tests/test_shared.py.*<<<<<<<"):
        hub.session("worker-b").finish_task(b_task.id, "b's version")
    assert "'from a'" in main_text(hub) and "'from b'" not in main_text(hub)  # main untouched
    conflicted = (b / SHARED).read_text(encoding="utf-8")
    assert "<<<<<<<" in conflicted and "|||||||" in conflicted  # both sides and the original
    with pytest.raises(HubError, match="still hold conflict markers"):
        hub.session("worker-b").finish_task(b_task.id, "b's version")
    (b / SHARED).write_text(BASE.replace("'untouched'", "'from a and b'"), encoding="utf-8")
    hub.session("worker-b").finish_task(b_task.id, "settled it")
    assert "'from a and b'" in main_text(hub)


def test_copies_take_in_main_as_they_go(hub):
    a_task, a = start(hub, "worker-a")
    b_task, b = start(hub, "worker-b")
    edit(a, "return 1", "return 'one'")
    hub.session("worker-a").finish_task(a_task.id, "done")
    edit(b, "return 3", "return 'three'")  # b's own unsaved work survives the sync
    note = hub.sync_role("worker-b")
    assert "includes the latest main" in note and SHARED in note
    text = (b / SHARED).read_text(encoding="utf-8")
    assert "return 'one'" in text and "return 'three'" in text
    assert hub.sync_role("worker-b") == ""  # nothing new since


def test_a_coming_conflict_is_mentioned_once_and_left_for_later(hub):
    a_task, a = start(hub, "worker-a")
    b_task, b = start(hub, "worker-b")
    edit(a, "'untouched'", "'from a'")
    hub.session("worker-a").finish_task(a_task.id, "done")
    edit(b, "'untouched'", "'from b'")
    assert "touches the same lines" in hub.sync_role("worker-b")
    assert "'from b'" in (b / SHARED).read_text(encoding="utf-8")  # its work is as it was
    assert hub.sync_role("worker-b") == ""


def test_share_work_lands_without_finishing_a_task(hub):
    _, a = start(hub, "worker-a")
    edit(a, "return 1", "return 'one'")
    commit = hub.session("worker-a").share_work("first() interface for worker-b")
    assert commit and "return 'one'" in main_text(hub)


def test_a_failing_check_keeps_main_clean(hub):
    import sys
    hub.base_team = Team.from_dict({**copy.deepcopy(TEAM), "isolation": "branches", "checks": [
        {"name": "tests", "run": f'"{sys.executable}" -c "import sys; sys.exit(1)"'}]},
        base_dir=hub.base_team.project_root.parent)
    a_task, a = start(hub, "worker-a")
    edit(a, "return 1", "return 'one'")
    with pytest.raises(HubError, match="tests FAILED"):
        hub.session("worker-a").finish_task(a_task.id, "done")
    assert "return 'one'" not in main_text(hub)


def test_edits_go_to_the_agents_own_copy(hub):
    _, a = start(hub, "worker-a")
    me = hub.session("worker-a")
    ok = hooks.on_pre_edit(me, {"tool_name": "Edit", "cwd": str(a), "tool_input": {"file_path": SHARED}})
    assert ok is None and SHARED in hub.store.task_files(1)  # no lease needed
    main = hub.base_team.project_root
    out = hooks.on_pre_edit(me, {"tool_name": "Edit", "cwd": str(main), "tool_input": {"file_path": SHARED}})
    assert "your own copy" in out["hookSpecificOutput"]["permissionDecisionReason"]
    out = hooks.on_pre_edit(me, {"tool_name": "Write", "cwd": str(a), "tool_input": {"file_path": "README.md"}})
    assert "outside the files you may write" in out["hookSpecificOutput"]["permissionDecisionReason"]


def test_the_law_and_role_card_describe_branches(hub):
    from agent_org.cards import role_card
    card = role_card(hub.session("worker-a"))
    assert "Your own copy" in card and "One writer per file" not in card and "share_work" in card


def test_build_output_never_gets_into_the_agents_commits(hub):
    """Both agents ran the code: each copy had its own __pycache__, which used to conflict."""
    a_task, a = start(hub, "worker-a")
    b_task, b = start(hub, "worker-b")
    for wt, old, new in ((a, "return 1", "return 'one'"), (b, "return 3", "return 'three'")):
        edit(wt, old, new)
        (wt / "tests" / "__pycache__").mkdir()
        (wt / "tests" / "__pycache__" / "test_shared.cpython-312.pyc").write_bytes(wt.name.encode() * 50)
    hub.session("worker-a").finish_task(a_task.id, "done")
    hub.session("worker-b").finish_task(b_task.id, "done")
    tracked = git(hub.base_team.project_root, "ls-files")
    assert "__pycache__" not in tracked and SHARED in tracked


def test_junk_committed_earlier_does_not_block_a_merge(hub):
    root = hub.base_team.project_root
    a_task, a = start(hub, "worker-a")
    b_task, b = start(hub, "worker-b")
    for wt, text in ((a, b"from a"), (b, b"from b")):  # as an older agent-org would have committed it
        (wt / "old.pyc").write_bytes(text)
        git(wt, "add", "-f", "old.pyc")
        git(wt, "commit", "-q", "-m", "junk")
    edit(a, "return 1", "return 'one'")
    edit(b, "return 3", "return 'three'")
    hub.session("worker-a").finish_task(a_task.id, "done")
    hub.session("worker-b").finish_task(b_task.id, "done")
    assert "return 'one'" in main_text(hub) and "return 'three'" in main_text(hub)
    assert "old.pyc" not in git(root, "ls-files")


def test_an_agent_with_nothing_new_lands_nothing(hub):
    task, _ = start(hub, "worker-a", "Look into it")
    done = hub.session("worker-a").finish_task(task.id, "nothing needed changing")
    assert done.state == "done" and done.commit_id == ""
