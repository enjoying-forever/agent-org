"""The guards: protected files, dangerous commands, secrets and scope."""

from pathlib import Path

import pytest

from agent_org import safety

ROOT = [Path("E:/work/app")]


@pytest.mark.parametrize("rel", ["team.yaml", "./team.yaml", "Team.YAML", "team.yaml.bak", ".agent-org/hub.db",
                                 ".agents/plugins/agent-org/hooks.json", ".grok/config.toml", ".git/config"])
def test_the_teams_own_configuration_is_protected(rel):
    assert safety.protected(rel)


@pytest.mark.parametrize("rel", ["src/team.py", "docs/team.yaml.md", ".agents/other/x.json", "gitignore",
                                 ".github/workflows/ci.yml"])
def test_ordinary_files_are_not(rel):
    assert not safety.protected(rel)


@pytest.mark.parametrize("command", [
    "git push", "git push --force origin main", "cd x && git push -u origin HEAD",
    "rm -rf /", "rm -rf ~", "sudo rm -fr /*", "rd /s /q C:\\", "Remove-Item -Recurse -Force C:\\",
    "Remove-Item -Recurse -Force ~", "format D:", "shutdown /s /t 0", "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda", "rm -rf E:/work/other", "Remove-Item -Recurse -Force C:\\Users\\me\\Documents",
    "python -c \"import shutil; shutil.rmtree('D:/data')\"",
])
def test_dangerous_commands_are_refused(command):
    assert safety.check_command(command, ROOT, shared_folder=False)


@pytest.mark.parametrize("command", [
    "git status", "git diff main...HEAD", "git log --oneline", "git commit -m 'push the button'", "ls -la",
    "python -m pytest -q", "npm run build", "rm -rf build", "rm -rf node_modules dist", "rm -r E:/work/app/tmp",
    "Remove-Item -Recurse -Force .\\out", "echo shutdown later > notes.txt", "git reset --hard",
    "grep -rn 'format' src", "cat README.md | head",
])
def test_everyday_commands_are_not(command):
    assert safety.check_command(command, ROOT, shared_folder=False) is None


@pytest.mark.parametrize("command", ["git reset --hard", "git reset --hard HEAD~1", "git clean -fd", "git checkout .",
                                     "git checkout -- .", "git restore .", "git stash"])
def test_wiping_a_shared_folder_is_refused(command):
    assert "other agents' unsaved work" in safety.check_command(command, ROOT, shared_folder=True)


def test_command_text_from_each_harness():
    assert safety.command_of({"command": "ls"}) == "ls"  # Claude, Grok
    assert safety.command_of({"command": ["bash", "-lc", "git push"]}) == "bash -lc git push"  # Codex
    assert safety.command_of({"CommandLine": "dir"}) == "dir"  # Antigravity


def test_secrets_added_by_a_diff_are_found_without_showing_them():
    diff = ("diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1,2 +1,4 @@\n import os\n"
            "+KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'\n-old = 1\n+password = \"hunter2hunter2!\"\n"
            "+aws = 'AKIAABCDEFGHIJKLMNOP'\n")
    found = safety.find_secrets(diff)
    assert found == ["app.py:2 (API key (sk-...))", "app.py:3 (password or token in the code)",
                     "app.py:4 (AWS access key)"]
    assert all("hunter2" not in f for f in found)
    assert safety.find_secrets("+++ b/x.py\n@@ -0,0 +1 @@\n+password = os.environ['PASSWORD']\n") == []


def test_scope():
    assert safety.outside_scope(["src/a.py", "README.md", "tests/t.py"], ("src/*", "tests/*")) == ["README.md"]
    assert safety.scope_within(["src/api/*", "tests/*", "*"], ("src/*",)) == ["tests/*", "*"]
    assert safety.scope_within(["src/*"], ("*",)) == []


def test_git_push_with_options_before_it():
    assert safety.check_command("git -C E:/work/app push origin main", ROOT, shared_folder=False)
    assert safety.check_command("git -c http.proxy=x push", ROOT, shared_folder=False)


# the guards at work

from agent_org import hooks  # noqa: E402


def shell(command, cwd):
    return {"tool_name": "Bash", "cwd": str(cwd), "tool_input": {"command": command}}


def refused(out):
    return out is not None and out["hookSpecificOutput"].get("permissionDecision") == "deny"


def test_the_hook_refuses_dangerous_commands(hub):
    me, root = hub.session("worker-a"), hub.base_team.project_root
    assert refused(hooks.on_pre_edit(me, shell("git push origin main", root)))
    assert refused(hooks.on_pre_edit(me, shell("git reset --hard", root)))  # shared folder
    assert hooks.on_pre_edit(me, shell("python -m pytest -q", root)) is None
    assert any("refused a command: git push" in e.text for e in hub.store.events_after(0))
    agy = {"toolCall": {"name": "run_command", "args": {"CommandLine": "git push"}}}
    assert refused(hooks.on_pre_edit(me, agy))


def test_the_owner_can_turn_the_command_guard_off(hub):
    import copy
    from agent_org.team import Team
    from .conftest import TEAM
    hub.base_team = Team.from_dict({**copy.deepcopy(TEAM), "guard_commands": False},
                                   base_dir=hub.base_team.project_root.parent)
    assert hooks.on_pre_edit(hub.session("worker-a"), shell("git push", hub.base_team.project_root)) is None


def test_agents_never_edit_the_teams_configuration(hub):
    import copy
    from agent_org.team import Team
    from .conftest import TEAM
    data = copy.deepcopy(TEAM)
    data["roles"]["worker-a"]["write_scope"] = ["*"]
    hub.base_team = Team.from_dict(data, base_dir=hub.base_team.project_root.parent)
    root = hub.base_team.project_root
    out = hooks.on_pre_edit(hub.session("worker-a"), {"tool_name": "Write", "cwd": str(root),
                                                      "tool_input": {"file_path": "team.yaml"}})
    assert refused(out) and "team's own configuration" in out["hookSpecificOutput"]["permissionDecisionReason"]


def test_antigravity_keeps_asking_about_commands_that_pass():
    run = {"toolCall": {"name": "run_command", "args": {"CommandLine": "ls"}}}
    edit = {"toolCall": {"name": "write_to_file", "args": {"TargetFile": "a.py"}}}
    assert hooks.for_antigravity("pre-edit", None, run) == {"decision": "ask"}  # its own permission check runs
    assert hooks.for_antigravity("pre-edit", None, edit) == {"decision": "allow"}


@pytest.mark.parametrize("command", ["git stash list", "git stash show -p", "git stash pop"])
def test_looking_at_stashes_is_fine(command):
    assert safety.check_command(command, ROOT, shared_folder=True) is None


@pytest.mark.parametrize("command", ["git stash", "git stash push -m wip", "git stash -u", "git stash && git pull"])
def test_stashing_a_shared_folder_is_not(command):
    assert safety.check_command(command, ROOT, shared_folder=True)
