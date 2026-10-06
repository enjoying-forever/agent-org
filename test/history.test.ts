// Verification checks before 'done', what each task changed, and one commit per accepted task.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { roleCard } from '../src/cards.ts';
import * as gitops from '../src/gitops.ts';
import * as hooks from '../src/hooks.ts';
import { Hub, HubError } from '../src/hub.ts';
import { Store } from '../src/store.ts';
import { Team, TeamError } from '../src/team.ts';
import * as verify from '../src/verify.ts';
import { cleanup, raises, rejects, team as example, tmpDir } from './helpers.ts';

const NODE = `"${process.execPath}"`;

function makeHub(t: TestContext, dir: string, extra: Record<string, unknown> = {}): Hub {
  mkdirSync(path.join(dir, 'project'), { recursive: true });
  const team = Team.fromDict({ ...example(), ...extra }, dir);
  const hub = new Hub(team, new Store(team.database));
  cleanup(t, () => hub.close());
  return hub;
}

const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

// team.yaml

test('checks and settings are read', (t) => {
  const hub = makeHub(t, tmpDir(t), { checks: [{ name: 'tests', run: 'pytest -q', when: '*.py', timeout: 60 }], autostart: true, max_running: 3,
    commit_on_accept: false });
  const [check] = hub.baseTeam.checks;
  assert.deepEqual([check.name, check.run, [...check.when], check.timeout], ['tests', 'pytest -q', ['*.py'], 60]);
  const s = hub.baseTeam.settings;
  assert.deepEqual([s.autostart, s.max_running, s.commit_on_accept], [true, 3, false]);
});

for (const [bad, error] of [[{ checks: 'pytest' }, 'must be a list'], [{ checks: [{ name: 'x' }] }, "'run' must be the command"],
  [{ checks: [{ run: 'x', colour: 1 }] }, 'unknown keys'], [{ max_running: -1 }, 'whole number']] as [object, string][]) {
  test(`bad settings are refused: ${error}`, (t) => {
    raises(() => Team.fromDict({ ...example(), ...bad }, tmpDir(t)), TeamError, error);
  });
}

// what each task changed

test('edits and claims are recorded against the current task', (t) => {
  const hub = makeHub(t, tmpDir(t));
  const task = hub.session('tech-lead').assignTask('worker-a', 'Build it');
  const worker = hub.session('worker-a');
  worker.readInbox();
  worker.claim('src/a.py');
  hooks.onPreEdit(worker, { tool_name: 'Write', cwd: hub.baseTeam.project_root, tool_input: { file_path: 'tests/test_a.py' } });
  assert.deepEqual(hub.store.taskFiles(task.id), ['src/a.py', 'tests/test_a.py']);
});

// verification checks (a gate before 'done')

test('a failing check keeps the task open', async (t) => {
  const fail = `${NODE} -e "console.log('2 tests failed'); process.exit(1)"`;
  const hub = makeHub(t, tmpDir(t), { checks: [{ name: 'tests', run: fail }] });
  const task = hub.session('tech-lead').assignTask('worker-a', 'Build it');
  const worker = hub.session('worker-a');
  worker.readInbox();
  await rejects(() => worker.finishTask(task.id, 'built'), HubError, /is not done yet: tests FAILED[\s\S]*2 tests failed[\s\S]*try again/);
  assert.equal(hub.store.getTask(task.id)?.state, 'working');
  await worker.finishTask(task.id, 'cannot make the tests pass', 'blocked'); // blocked needs no checks
});

test('agents see the checks before they run into them', async (t) => {
  const fail = `${NODE} -e "process.exit(1)"`;
  const hub = makeHub(t, tmpDir(t), { checks: [{ name: 'tests', run: fail, when: ['*.py'] }] });
  assert.ok(roleCard(hub.session('tech-lead')).includes(`tests: \`${fail}\` (when a task changes *.py)`));
  const task = hub.session('tech-lead').assignTask('worker-a', 'Build it');
  const worker = hub.session('worker-a');
  const [given] = worker.readInbox();
  assert.ok(given.text.includes("the hub runs the team's checks") && given.text.includes(fail));
  worker.claim('src/a.py');
  const refused = await rejects(() => worker.finishTask(task.id, 'built'), HubError);
  assert.ok(refused.message.includes(`--- tests: \`${fail}\` (run in ${hub.baseTeam.project_root}) ---`)); // what to run to see why
});

test('passing checks are recorded', async (t) => {
  const ok = `${NODE} -e "console.log('fine')"`;
  const hub = makeHub(t, tmpDir(t), { checks: [{ name: 'tests', run: ok }, { name: 'lint', run: ok, when: '*.js' }] });
  const task = hub.session('tech-lead').assignTask('worker-a', 'Build it');
  hub.session('worker-a').readInbox();
  hub.session('worker-a').claim('src/a.py');
  const done = await hub.session('worker-a').finishTask(task.id, 'built');
  assert.deepEqual([done.state, done.checks], ['done', 'tests passed']); // lint skipped: no .js file changed
});

test('checks run in the project folder', async (t) => {
  const dir = tmpDir(t);
  const hub = makeHub(t, dir);
  writeFileSync(path.join(hub.baseTeam.project_root, 'marker.txt'), 'here');
  const team = Team.fromDict({ ...example(), checks: [{ name: 'look', run: `${NODE} -e "require('fs').readFileSync('marker.txt')"` }] }, dir);
  assert.ok((await verify.run(team, []))[0].ok);
});

test('a check that runs too long is stopped, with its whole process tree', async (t) => {
  const team = Team.fromDict({ ...example(), checks: [{ name: 'slow', run: `${NODE} -e "setTimeout(() => {}, 60000)"`, timeout: 1 }] }, tmpDir(t));
  const started = performance.now();
  const [outcome] = await verify.run(team, [], tmpDir(t));
  assert.ok(!outcome.ok && outcome.output.includes('did not finish within 1 seconds'));
  assert.ok(performance.now() - started < 20_000);
});

// history

function repo(t: TestContext): { dir: string; root: string } {
  const dir = tmpDir(t);
  const root = path.join(dir, 'project');
  mkdirSync(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'me@example.com');
  git(root, 'config', 'user.name', 'Me');
  writeFileSync(path.join(root, 'README.md'), 'hello\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'start');
  return { dir, root };
}

test("only a project's own repository is used", (t) => {
  const { root } = repo(t);
  assert.ok(gitops.isOwnRepo(root));
  const inner = path.join(root, 'sub');
  mkdirSync(inner);
  assert.ok(!gitops.isOwnRepo(inner)); // inside someone else's repository: hands off
  assert.equal(gitops.commit(inner, ['x'], 'no'), null);
});

test('a diff shows changed and new files', (t) => {
  const { root } = repo(t);
  writeFileSync(path.join(root, 'README.md'), 'hello world\n');
  writeFileSync(path.join(root, 'new.py'), 'print(1)\n');
  const text = gitops.diff(root, ['README.md', 'new.py']);
  assert.ok(text.includes('-hello\n+hello world') && text.includes('+print(1)'));
});

test('accepting a task commits exactly its files', async (t) => {
  const { dir, root } = repo(t);
  const hub = makeHub(t, dir);
  const task = hub.session('tech-lead').assignTask('worker-a', 'Add the greeting');
  const worker = hub.session('worker-a');
  worker.readInbox();
  worker.claim('src/greet.py');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'greet.py'), "def greet(): return 'hi'\n");
  writeFileSync(path.join(root, 'unrelated.txt'), "someone else's work\n");
  await worker.finishTask(task.id, 'greet() added');
  const accepted = hub.session('tech-lead').reviewTask(task.id, true);
  assert.ok(accepted.commit_id);
  const log = git(root, 'log', '-1', '--format=%s%n%b');
  assert.ok(log.startsWith(`task #${task.id}: Add the greeting`) && log.includes('accepted by tech-lead'));
  assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').split(/\s+/).filter((x) => x), ['src/greet.py']);
  assert.ok(git(root, 'status', '--porcelain').includes('unrelated.txt')); // left alone
});

test('turning history on', (t) => {
  const root = path.join(tmpDir(t), 'fresh');
  mkdirSync(path.join(root, '.agent-org'), { recursive: true });
  writeFileSync(path.join(root, 'app.py'), 'x = 1\n');
  writeFileSync(path.join(root, '.agent-org', 'hub.db'), 'db');
  assert.equal(gitops.init(root), 'on');
  assert.ok(gitops.isOwnRepo(root));
  const tracked = git(root, 'ls-files').split(/\s+/);
  assert.ok(tracked.includes('app.py') && !tracked.some((x) => x.startsWith('.agent-org')));
  assert.equal(gitops.init(root), 'already on');
});

test('no commit when the team does not keep history', async (t) => {
  const { dir, root } = repo(t);
  const hub = makeHub(t, dir, { commit_on_accept: false });
  const task = hub.session('tech-lead').assignTask('worker-a', 'x');
  hub.session('worker-a').readInbox();
  hub.session('worker-a').claim('src/a.txt');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'a.txt'), 'a');
  await hub.session('worker-a').finishTask(task.id, 'done');
  assert.equal(hub.session('tech-lead').reviewTask(task.id, true).commit_id, '');
});
