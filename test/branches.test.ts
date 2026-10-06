// Branch mode: every agent in its own git worktree; finished work lands in main at once.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { roleCard } from '../src/cards.ts';
import * as gitops from '../src/gitops.ts';
import * as hooks from '../src/hooks.ts';
import { Hub, HubError } from '../src/hub.ts';
import { Store } from '../src/store.ts';
import { Team } from '../src/team.ts';
import { cleanup, rejects, team as example, tmpDir } from './helpers.ts';

const SHARED = 'tests/test_shared.py';
const BASE = "def first():\n    return 1\n\n\ndef middle():\n    return 'untouched'\n\n\ndef last():\n    return 3\n";

function makeHub(t: TestContext, extra: Record<string, unknown> = {}): Hub {
  const dir = tmpDir(t);
  const root = path.join(dir, 'project');
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  writeFileSync(path.join(root, SHARED), BASE);
  const team = Team.fromDict({ ...example(), isolation: 'branches', ...extra }, dir);
  const hub = new Hub(team, new Store(team.database));
  cleanup(t, () => hub.close());
  return hub;
}

const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

function start(hub: Hub, role: string, title = 'Change the shared file') {
  const task = hub.session('tech-lead').assignTask(role, title);
  const wt = hub.prepareRoot(role);
  hub.session(role).readInbox();
  return { task, wt };
}

function edit(wt: string, old: string, fresh: string): void {
  const file = path.join(wt, SHARED);
  writeFileSync(file, readFileSync(file, 'utf8').replace(old, fresh));
}

const mainText = (hub: Hub): string => readFileSync(path.join(hub.baseTeam.project_root, SHARED), 'utf8');
// (git may write a copy with Windows line endings: core.autocrlf)
const readIn = (wt: string): string => readFileSync(path.join(wt, SHARED), 'utf8').replace(/\r\n/g, '\n');

test('each agent gets its own copy on its own branch', (t) => {
  const hub = makeHub(t);
  const wt = hub.prepareRoot('worker-a');
  const root = hub.baseTeam.project_root;
  assert.ok(gitops.isOwnRepo(root)); // history turned on by itself
  assert.equal(wt, path.join(root, '.agent-org', 'worktrees', 'worker-a'));
  assert.equal(readIn(wt), BASE);
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'agent/worker-a');
  assert.ok(hub.rootOf('worker-a') === wt && hub.rootOf('you') === root);
});

test('two agents change one file in different places', async (t) => {
  const hub = makeHub(t);
  const a = start(hub, 'worker-a');
  const b = start(hub, 'worker-b');
  edit(a.wt, 'return 1', "return 'one'");
  edit(b.wt, 'return 3', "return 'three'");
  const doneA = await hub.session('worker-a').finishTask(a.task.id, 'first() says one');
  assert.ok(doneA.commit_id && mainText(hub).includes("return 'one'")); // in main at once, before any review
  const doneB = await hub.session('worker-b').finishTask(b.task.id, 'last() says three');
  const text = mainText(hub);
  assert.ok(text.includes("return 'one'") && text.includes("return 'three'") && text.includes("'untouched'")); // merged by git
  assert.notEqual(doneB.commit_id, doneA.commit_id);
  const log = git(hub.baseTeam.project_root, 'log', '--oneline', '--first-parent');
  assert.ok(log.includes(`task #${a.task.id}`) && log.includes(`task #${b.task.id}`));
});

test('the same lines come back to the agent to settle', async (t) => {
  const hub = makeHub(t);
  const a = start(hub, 'worker-a');
  const b = start(hub, 'worker-b');
  edit(a.wt, "'untouched'", "'from a'");
  edit(b.wt, "'untouched'", "'from b'");
  await hub.session('worker-a').finishTask(a.task.id, "a's version");
  await rejects(() => hub.session('worker-b').finishTask(b.task.id, "b's version"), HubError, /both changed the same lines in tests\/test_shared.py[\s\S]*<<<<<<</);
  assert.ok(mainText(hub).includes("'from a'") && !mainText(hub).includes("'from b'")); // main untouched
  const conflicted = readIn(b.wt);
  assert.ok(conflicted.includes('<<<<<<<') && conflicted.includes('|||||||')); // both sides and the original
  await rejects(() => hub.session('worker-b').finishTask(b.task.id, "b's version"), HubError, 'still hold conflict markers');
  writeFileSync(path.join(b.wt, SHARED), BASE.replace("'untouched'", "'from a and b'"));
  await hub.session('worker-b').finishTask(b.task.id, 'settled it');
  assert.ok(mainText(hub).includes("'from a and b'"));
});

test('copies take in main as they go', async (t) => {
  const hub = makeHub(t);
  const a = start(hub, 'worker-a');
  const b = start(hub, 'worker-b');
  edit(a.wt, 'return 1', "return 'one'");
  await hub.session('worker-a').finishTask(a.task.id, 'done');
  edit(b.wt, 'return 3', "return 'three'"); // b's own unsaved work survives the sync
  const note = hub.syncRole('worker-b');
  assert.ok(note.includes('includes the latest main') && note.includes(SHARED));
  const text = readIn(b.wt);
  assert.ok(text.includes("return 'one'") && text.includes("return 'three'"));
  assert.equal(hub.syncRole('worker-b'), ''); // nothing new since
});

test('a coming conflict is mentioned once and left for later', async (t) => {
  const hub = makeHub(t);
  const a = start(hub, 'worker-a');
  const b = start(hub, 'worker-b');
  edit(a.wt, "'untouched'", "'from a'");
  await hub.session('worker-a').finishTask(a.task.id, 'done');
  edit(b.wt, "'untouched'", "'from b'");
  assert.ok(hub.syncRole('worker-b').includes('touches the same lines'));
  assert.ok(readIn(b.wt).includes("'from b'")); // its work is as it was
  assert.equal(hub.syncRole('worker-b'), '');
});

test('share_work lands without finishing a task', async (t) => {
  const hub = makeHub(t);
  const a = start(hub, 'worker-a');
  edit(a.wt, 'return 1', "return 'one'");
  assert.ok(await hub.session('worker-a').shareWork('first() interface for worker-b'));
  assert.ok(mainText(hub).includes("return 'one'"));
});

test('a failing check keeps main clean', async (t) => {
  const hub = makeHub(t, { checks: [{ name: 'tests', run: `"${process.execPath}" -e "process.exit(1)"` }] });
  const a = start(hub, 'worker-a');
  edit(a.wt, 'return 1', "return 'one'");
  await rejects(() => hub.session('worker-a').finishTask(a.task.id, 'done'), HubError, 'tests FAILED');
  assert.ok(!mainText(hub).includes("return 'one'"));
});

test("edits go to the agent's own copy", (t) => {
  const hub = makeHub(t);
  const a = start(hub, 'worker-a');
  const me = hub.session('worker-a');
  assert.equal(hooks.onPreEdit(me, { tool_name: 'Edit', cwd: a.wt, tool_input: { file_path: SHARED } }), null);
  assert.ok(hub.store.taskFiles(1).includes(SHARED)); // no lease needed
  const reason = (out: hooks.HookOut): string => String((out?.hookSpecificOutput as Record<string, unknown>)?.permissionDecisionReason);
  assert.ok(reason(hooks.onPreEdit(me, { tool_name: 'Edit', cwd: hub.baseTeam.project_root, tool_input: { file_path: SHARED } })).includes('your own copy'));
  assert.ok(reason(hooks.onPreEdit(me, { tool_name: 'Write', cwd: a.wt, tool_input: { file_path: 'README.md' } })).includes('outside the files you may write'));
});

test('the law and the role card describe branches', (t) => {
  const card = roleCard(makeHub(t).session('worker-a'));
  assert.ok(card.includes('Your own copy') && !card.includes('One writer per file') && card.includes('share_work'));
});

test("build output never gets into the agents' commits", async (t) => {
  // Both agents ran the code: each copy had its own __pycache__, which used to conflict.
  const hub = makeHub(t);
  const a = start(hub, 'worker-a');
  const b = start(hub, 'worker-b');
  for (const [wt, old, fresh] of [[a.wt, 'return 1', "return 'one'"], [b.wt, 'return 3', "return 'three'"]]) {
    edit(wt, old, fresh);
    mkdirSync(path.join(wt, 'tests', '__pycache__'));
    writeFileSync(path.join(wt, 'tests', '__pycache__', 'test_shared.cpython-312.pyc'), path.basename(wt).repeat(50));
  }
  await hub.session('worker-a').finishTask(a.task.id, 'done');
  await hub.session('worker-b').finishTask(b.task.id, 'done');
  const tracked = git(hub.baseTeam.project_root, 'ls-files');
  assert.ok(!tracked.includes('__pycache__') && tracked.includes(SHARED));
});

test('junk committed earlier does not block a merge', async (t) => {
  const hub = makeHub(t);
  const root = hub.baseTeam.project_root;
  const a = start(hub, 'worker-a');
  const b = start(hub, 'worker-b');
  for (const [wt, text] of [[a.wt, 'from a'], [b.wt, 'from b']]) { // as an older agent-org would have committed it
    writeFileSync(path.join(wt, 'old.pyc'), text);
    git(wt, 'add', '-f', 'old.pyc');
    git(wt, 'commit', '-q', '-m', 'junk');
  }
  edit(a.wt, 'return 1', "return 'one'");
  edit(b.wt, 'return 3', "return 'three'");
  await hub.session('worker-a').finishTask(a.task.id, 'done');
  await hub.session('worker-b').finishTask(b.task.id, 'done');
  assert.ok(mainText(hub).includes("return 'one'") && mainText(hub).includes("return 'three'"));
  assert.ok(!git(root, 'ls-files').includes('old.pyc'));
});

test('an agent with nothing new lands nothing', async (t) => {
  const hub = makeHub(t);
  const { task } = start(hub, 'worker-a', 'Look into it');
  const done = await hub.session('worker-a').finishTask(task.id, 'nothing needed changing');
  assert.deepEqual([done.state, done.commit_id], ['done', '']);
});

test('nothing outside the scope reaches main', async (t) => {
  const hub = makeHub(t);
  const a = start(hub, 'worker-a'); // may write src/* and tests/*
  edit(a.wt, 'return 1', "return 'one'");
  writeFileSync(path.join(a.wt, 'README.md'), 'written through the shell\n');
  await rejects(() => hub.session('worker-a').finishTask(a.task.id, 'done'), HubError, 'README.md is outside the files you may write');
  unlinkSync(path.join(a.wt, 'README.md'));
  await hub.session('worker-a').finishTask(a.task.id, 'done');
  assert.ok(mainText(hub).includes("return 'one'"));
});

test('the team configuration never reaches main', async (t) => {
  const hub = makeHub(t);
  const a = start(hub, 'worker-a');
  writeFileSync(path.join(a.wt, 'team.yaml'), 'roles: {}\n');
  await rejects(() => hub.session('worker-a').finishTask(a.task.id, 'done'), HubError, "team's own configuration");
});

test('secrets never reach main', async (t) => {
  const hub = makeHub(t);
  const a = start(hub, 'worker-a');
  edit(a.wt, 'return 1', "return 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'");
  await rejects(() => hub.session('worker-a').finishTask(a.task.id, 'done'), HubError, 'would put secrets into git history: tests/test_shared.py:2');
  assert.ok(!mainText(hub).includes('sk-ant'));
});
