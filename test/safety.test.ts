// The guards: protected files, dangerous commands, secrets and scope.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as hooks from '../src/hooks.ts';
import * as safety from '../src/safety.ts';
import { Team } from '../src/team.ts';
import { makeHub, team } from './helpers.ts';
import path from 'node:path';

const ROOT = ['E:/work/app'];

for (const rel of ['team.yaml', './team.yaml', 'Team.YAML', 'team.yaml.bak', '.agent-org/hub.db', '.agents/plugins/agent-org/hooks.json',
  '.grok/config.toml', '.git/config']) {
  test(`the team's own configuration is protected: ${rel}`, () => assert.ok(safety.isProtected(rel)));
}

for (const rel of ['src/team.py', 'docs/team.yaml.md', '.agents/other/x.json', 'gitignore', '.github/workflows/ci.yml']) {
  test(`an ordinary file is not: ${rel}`, () => assert.ok(!safety.isProtected(rel)));
}

for (const command of ['git push', 'git push --force origin main', 'cd x && git push -u origin HEAD', 'rm -rf /', 'rm -rf ~',
  'sudo rm -fr /*', 'rd /s /q C:\\', 'Remove-Item -Recurse -Force C:\\', 'Remove-Item -Recurse -Force ~', 'format D:',
  'shutdown /s /t 0', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda', 'rm -rf E:/work/other',
  'Remove-Item -Recurse -Force C:\\Users\\me\\Documents', 'python -c "import shutil; shutil.rmtree(\'D:/data\')"']) {
  test(`a dangerous command is refused: ${command}`, () => assert.ok(safety.checkCommand(command, ROOT, false)));
}

for (const command of ['git status', 'git diff main...HEAD', 'git log --oneline', "git commit -m 'push the button'", 'ls -la',
  'python -m pytest -q', 'npm run build', 'rm -rf build', 'rm -rf node_modules dist', 'rm -r E:/work/app/tmp',
  'Remove-Item -Recurse -Force .\\out', 'echo shutdown later > notes.txt', 'git reset --hard', "grep -rn 'format' src", 'cat README.md | head']) {
  test(`an everyday command is not: ${command}`, () => assert.equal(safety.checkCommand(command, ROOT, false), null));
}

for (const command of ['git reset --hard', 'git reset --hard HEAD~1', 'git clean -fd', 'git checkout .', 'git checkout -- .', 'git restore .', 'git stash']) {
  test(`wiping a shared folder is refused: ${command}`, () => {
    assert.ok(safety.checkCommand(command, ROOT, true)?.includes("other agents' unsaved work"));
  });
}

test('command text from each harness', () => {
  assert.equal(safety.commandOf({ command: 'ls' }), 'ls'); // Claude, Grok
  assert.equal(safety.commandOf({ command: ['bash', '-lc', 'git push'] }), 'bash -lc git push'); // Codex
  assert.equal(safety.commandOf({ CommandLine: 'dir' }), 'dir'); // Antigravity
});

test('secrets added by a diff are found without showing them', () => {
  const diff = "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1,2 +1,4 @@\n import os\n"
    + "+KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'\n-old = 1\n+password = \"hunter2hunter2!\"\n+aws = 'AKIAABCDEFGHIJKLMNOP'\n";
  const found = safety.findSecrets(diff);
  assert.deepEqual(found, ['app.py:2 (API key (sk-...))', 'app.py:3 (password or token in the code)', 'app.py:4 (AWS access key)']);
  assert.ok(found.every((f) => !f.includes('hunter2')));
  assert.deepEqual(safety.findSecrets("+++ b/x.py\n@@ -0,0 +1 @@\n+password = os.environ['PASSWORD']\n"), []);
});

test('scope', () => {
  assert.deepEqual(safety.outsideScope(['src/a.py', 'README.md', 'tests/t.py'], ['src/*', 'tests/*']), ['README.md']);
  assert.deepEqual(safety.scopeWithin(['src/api/*', 'tests/*', '*'], ['src/*']), ['tests/*', '*']);
  assert.deepEqual(safety.scopeWithin(['src/*'], ['*']), []);
});

test('git push with options before it', () => {
  assert.ok(safety.checkCommand('git -C E:/work/app push origin main', ROOT, false));
  assert.ok(safety.checkCommand('git -c http.proxy=x push', ROOT, false));
});

// the guards at work

const shell = (command: string, cwd: string) => ({ tool_name: 'Bash', cwd, tool_input: { command } });
const refused = (out: hooks.HookOut): boolean => out !== null && (out.hookSpecificOutput as Record<string, unknown>)?.permissionDecision === 'deny';

test('the hook refuses dangerous commands', (t) => {
  const { hub } = makeHub(t);
  const me = hub.session('worker-a');
  const root = hub.baseTeam.project_root;
  assert.ok(refused(hooks.onPreEdit(me, shell('git push origin main', root))));
  assert.ok(refused(hooks.onPreEdit(me, shell('git reset --hard', root)))); // shared folder
  assert.equal(hooks.onPreEdit(me, shell('python -m pytest -q', root)), null);
  assert.ok(hub.store.eventsAfter(0).some((e) => e.text.includes('refused a command: git push')));
  assert.ok(refused(hooks.onPreEdit(me, { toolCall: { name: 'run_command', args: { CommandLine: 'git push' } } })));
});

test('the owner can turn the command guard off', (t) => {
  const { hub } = makeHub(t);
  hub.baseTeam = Team.fromDict({ ...team(), guard_commands: false }, path.dirname(hub.baseTeam.project_root));
  assert.equal(hooks.onPreEdit(hub.session('worker-a'), shell('git push', hub.baseTeam.project_root)), null);
});

test("agents never edit the team's configuration", (t) => {
  const { hub } = makeHub(t);
  const data = team();
  data.roles['worker-a'].write_scope = ['*'];
  hub.baseTeam = Team.fromDict(data, path.dirname(hub.baseTeam.project_root));
  const out = hooks.onPreEdit(hub.session('worker-a'), { tool_name: 'Write', cwd: hub.baseTeam.project_root, tool_input: { file_path: 'team.yaml' } });
  assert.ok(refused(out) && String((out!.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason).includes("team's own configuration"));
});

test('Antigravity keeps asking about commands that pass', () => {
  assert.deepEqual(hooks.forAntigravity('pre-edit', null, { toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }), { decision: 'ask' });
  assert.deepEqual(hooks.forAntigravity('pre-edit', null, { toolCall: { name: 'write_to_file', args: { TargetFile: 'a.py' } } }), { decision: 'allow' });
});

for (const command of ['git stash list', 'git stash show -p', 'git stash pop']) {
  test(`looking at stashes is fine: ${command}`, () => assert.equal(safety.checkCommand(command, ROOT, true), null));
}

for (const command of ['git stash', 'git stash push -m wip', 'git stash -u', 'git stash && git pull']) {
  test(`stashing a shared folder is not: ${command}`, () => assert.ok(safety.checkCommand(command, ROOT, true)));
}
