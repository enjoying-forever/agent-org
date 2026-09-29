"""Verification checks before 'done', what each task changed, and one commit per accepted task."""

import copy
import subprocess
import sys

import pytest

from agent_org import gitops, hooks, verify
from agent_org.hub import Hub, HubError
from agent_org.store import Store
from agent_org.team import Team, TeamError

from .conftest import TEAM


def make_hub(tmp_path, **extra):
    data = copy.deepcopy(TEAM)
    data.update(extra)
    (tmp_path / "project").mkdir(exist_ok=True)
    team = Team.from_dict(data, base_dir=tmp_path)
    return Hub(team, Store(team.database))


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=True).stdout


# team.yaml


def test_checks_and_settings_are_read(tmp_path):
    hub = make_hub(tmp_path, checks=[{"name": "tests", "run": "pytest -q", "when": "*.py", "timeout": 60}],
                   autostart=True, max_running=3, commit_on_accept=False)
    [check] = hub.base_team.checks
    assert (check.name, check.run, check.when, check.timeout) == ("tests", "pytest -q", ("*.py",), 60)
    s = hub.base_team.settings
    assert (s.autostart, s.max_running, s.commit_on_accept) == (True, 3, False)
    hub.close()


@pytest.mark.parametrize("bad, error", [
    ({"checks": "pytest"}, "must be a list"),
    ({"checks": [{"name": "x"}]}, "'run' must be the command"),
    ({"checks": [{"run": "x", "colour": 1}]}, "unknown keys"),
    ({"max_running": -1}, "whole number"),
])
def test_bad_settings_are_refused(tmp_path, bad, error):
    data = copy.deepcopy(TEAM)
    data.update(bad)
    with pytest.raises(TeamError, match=error):
        Team.from_dict(data, base_dir=tmp_path)


# what each task changed


def test_edits_and_claims_are_recorded_against_the_current_task(tmp_path):
    hub = make_hub(tmp_path)
    task = hub.session("tech-lead").assign_task("worker-a", "Build it")
    worker = hub.session("worker-a")
    worker.read_inbox()
    worker.claim("src/a.py")
    hooks.on_pre_edit(worker, {"tool_name": "Write", "cwd": str(hub.base_team.project_root),
                               "tool_input": {"file_path": "tests/test_a.py"}})
    assert hub.store.task_files(task.id) == ["src/a.py", "tests/test_a.py"]
    hub.close()


# verification checks (a gate before 'done')


def test_a_failing_check_keeps_the_task_open(tmp_path):
    fail = f'"{sys.executable}" -c "import sys; print(\'2 tests failed\'); sys.exit(1)"'
    hub = make_hub(tmp_path, checks=[{"name": "tests", "run": fail}])
    task = hub.session("tech-lead").assign_task("worker-a", "Build it")
    worker = hub.session("worker-a")
    worker.read_inbox()
    with pytest.raises(HubError, match="(?s)is not done yet: tests FAILED.*2 tests failed.*try again"):
        worker.finish_task(task.id, "built")
    assert hub.store.get_task(task.id).state == "working"
    worker.finish_task(task.id, "cannot make the tests pass", outcome="blocked")  # blocked needs no checks
    hub.close()


def test_agents_see_the_checks_before_they_run_into_them(tmp_path):
    fail = f'"{sys.executable}" -c "import sys; sys.exit(1)"'
    hub = make_hub(tmp_path, checks=[{"name": "tests", "run": fail, "when": ["*.py"]}])
    from agent_org.cards import role_card
    assert f"tests: `{fail}` (when a task changes *.py)" in role_card(hub.session("tech-lead"))
    task = hub.session("tech-lead").assign_task("worker-a", "Build it")
    worker = hub.session("worker-a")
    [given] = worker.read_inbox()
    assert "the hub runs the team's checks" in given.text and fail in given.text
    worker.claim("src/a.py")
    with pytest.raises(HubError) as refused:
        worker.finish_task(task.id, "built")
    assert f"--- tests: `{fail}` (run in {hub.base_team.project_root}) ---" in str(refused.value)  # what to run to see why
    hub.close()


def test_passing_checks_are_recorded(tmp_path):
    ok = f'"{sys.executable}" -c "print(\'fine\')"'
    hub = make_hub(tmp_path, checks=[{"name": "tests", "run": ok}, {"name": "lint", "run": ok, "when": "*.js"}])
    task = hub.session("tech-lead").assign_task("worker-a", "Build it")
    hub.session("worker-a").read_inbox()
    hub.session("worker-a").claim("src/a.py")
    done = hub.session("worker-a").finish_task(task.id, "built")
    assert (done.state, done.checks) == ("done", "tests passed")  # lint skipped: no .js file changed
    hub.close()


def test_checks_run_in_the_project_folder(tmp_path):
    hub = make_hub(tmp_path)
    (hub.base_team.project_root / "marker.txt").write_text("here")
    out = verify.run(Team.from_dict({**copy.deepcopy(TEAM), "checks": [
        {"name": "look", "run": f'"{sys.executable}" -c "open(\'marker.txt\')"'}]}, base_dir=tmp_path), [])
    assert out[0].ok
    hub.close()


# history


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    git(root, "init", "-q")
    git(root, "config", "user.email", "me@example.com")
    git(root, "config", "user.name", "Me")
    (root / "README.md").write_text("hello\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "start")
    return root


def test_only_a_projects_own_repository_is_used(tmp_path, repo):
    assert gitops.is_own_repo(repo)
    inner = repo / "sub"
    inner.mkdir()
    assert not gitops.is_own_repo(inner)  # inside someone else's repository: hands off
    assert gitops.commit(inner, ["x"], "no") is None


def test_diff_shows_changed_and_new_files(repo):
    (repo / "README.md").write_text("hello world\n")
    (repo / "new.py").write_text("print(1)\n")
    text = gitops.diff(repo, ["README.md", "new.py"])
    assert "-hello\n+hello world" in text and "+print(1)" in text


def test_accepting_a_task_commits_exactly_its_files(tmp_path, repo):
    hub = make_hub(tmp_path)
    task = hub.session("tech-lead").assign_task("worker-a", "Add the greeting")
    worker = hub.session("worker-a")
    worker.read_inbox()
    worker.claim("src/greet.py")
    (repo / "src").mkdir()
    (repo / "src" / "greet.py").write_text("def greet(): return 'hi'\n")
    (repo / "unrelated.txt").write_text("someone else's work\n")
    worker.finish_task(task.id, "greet() added")
    accepted = hub.session("tech-lead").review_task(task.id, accept=True)
    assert accepted.commit_id
    log = git(repo, "log", "-1", "--format=%s%n%b")
    assert log.startswith(f"task #{task.id}: Add the greeting") and "accepted by tech-lead" in log
    assert git(repo, "show", "--name-only", "--format=", "HEAD").split() == ["src/greet.py"]
    assert "unrelated.txt" in git(repo, "status", "--porcelain")  # left alone
    hub.close()


def test_turning_history_on(tmp_path):
    root = tmp_path / "fresh"
    root.mkdir()
    (root / "app.py").write_text("x = 1\n")
    (root / ".agent-org").mkdir()
    (root / ".agent-org" / "hub.db").write_text("db")
    assert gitops.init(root) == "on"
    assert gitops.is_own_repo(root)
    tracked = git(root, "ls-files").split()
    assert "app.py" in tracked and not any(t.startswith(".agent-org") for t in tracked)
    assert gitops.init(root) == "already on"


def test_no_commit_when_the_team_does_not_keep_history(tmp_path, repo):
    hub = make_hub(tmp_path, commit_on_accept=False)
    task = hub.session("tech-lead").assign_task("worker-a", "x")
    hub.session("worker-a").read_inbox()
    hub.session("worker-a").claim("src/a.txt")
    (repo / "src").mkdir()
    (repo / "src" / "a.txt").write_text("a")
    hub.session("worker-a").finish_task(task.id, "done")
    assert hub.session("tech-lead").review_task(task.id, accept=True).commit_id == ""
    hub.close()
