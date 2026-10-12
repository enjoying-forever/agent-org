// Problems found in a review (2026-10-12), each reproduced here as it was reported: what a task lands in main,
// whose task an edit belongs to, a task cancelled while its checks run, file names git escapes, DeepSeek's loop
// after a failed start, and the Board's tasks.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';
import * as hooks from '../src/hooks.ts';
import { HubError } from '../src/hub.ts';
import * as runview from '../src/runview.ts';
import { edit, git, mainText, makeHub, start } from './branch_helpers.ts';
import { rejects } from './helpers.ts';

const NODE = `"${process.execPath}"`;
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';

test('a secret taken out again does not reach main through an earlier commit', async (t) => {
  // reported: the final diff was clean, but `git log -p` in main still held the key
  const hub = makeHub(t);
  const a = start(hub, 'worker-a');
  edit(a.wt, 'return 1', `return '${SECRET}'`);
  await rejects(() => hub.session('worker-a').finishTask(a.task.id, 'done'), HubError, 'would put secrets into git history');
  edit(a.wt, `return '${SECRET}'`, "return 'one'"); // the agent takes it out and tries again
  const done = await hub.session('worker-a').finishTask(a.task.id, 'done');
  assert.equal(done.state, 'done');
  assert.ok(mainText(hub).includes("return 'one'"));
  assert.ok(!git(hub.baseTeam.project_root, 'log', '-p', '--all').includes('sk-ant'), 'the secret is nowhere in the history');
});

test('what lands is what was checked: main moving on during the checks is checked again', async (t) => {
  // reported: main changed while the checks ran, the merge went through unchecked and the task said "passed"
  const hub = makeHub(t, { checks: [{ name: 'tests', run: `${NODE} -e "require(process.env.AO_BREAKER)"` }] });
  const main = hub.baseTeam.project_root;
  process.env.AO_BREAKER = path.join(main, '..', 'breaker.cjs');
  t.after(() => { delete process.env.AO_BREAKER; });
  // The check: fails where bad.txt is; on its first run it also puts bad.txt into main, as another agent landing would.
  writeFileSync(path.join(main, '..', 'breaker.cjs'), `
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const main = ${JSON.stringify(main)};
const flag = path.join(main, '..', 'broke-main');
if (!fs.existsSync(flag)) {
  fs.writeFileSync(flag, '');
  fs.writeFileSync(path.join(main, 'bad.txt'), 'breaks the tests');
  execFileSync('git', ['-C', main, 'add', 'bad.txt']);
  execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'meanwhile']);
}
process.exit(fs.existsSync('bad.txt') ? 1 : 0);
`);
  const a = start(hub, 'worker-a');
  edit(a.wt, 'return 1', "return 'one'");
  await rejects(() => hub.session('worker-a').finishTask(a.task.id, 'done'), HubError, /is not done yet: tests FAILED/);
  assert.ok(!mainText(hub).includes("return 'one'"), 'the unchecked combination did not land');
});

test('an urgent task read through the hooks starts, and its edits are its own', async (t) => {
  // reported: the urgent task stayed open, and its edits were recorded against the normal task before it
  const hub = makeHub(t);
  const lead = hub.session('tech-lead');
  const normal = lead.assignTask('worker-a', 'The normal one');
  const worker = hub.session('worker-a');
  worker.readInbox();
  const urgent = lead.assignTask('worker-a', 'Drop everything', '', null, '', [], 1);
  hooks.onPostTool(worker, {}); // the hook hands the urgent mail over in full
  assert.equal(hub.store.getTask(urgent.id)?.state, 'working');
  worker.noteEdit('src/hotfix.py');
  assert.deepEqual(hub.store.taskFiles(urgent.id), ['src/hotfix.py']);
  assert.deepEqual(hub.store.taskFiles(normal.id), []);
});

test('a task cancelled while its checks run is not set back to done, and does not land', async (t) => {
  // reported: the finish went on after the cancel, merged the work and turned "cancelled" back into "done"
  const slow = `${NODE} -e "setTimeout(() => {}, 1500)"`;
  const hub = makeHub(t, { checks: [{ name: 'tests', run: slow }] });
  const a = start(hub, 'worker-a');
  edit(a.wt, 'return 1', "return 'one'");
  const finishing = hub.session('worker-a').finishTask(a.task.id, 'done');
  await new Promise((r) => setTimeout(r, 400));
  hub.session('tech-lead').cancelTask(a.task.id, 'not needed after all');
  await assert.rejects(finishing, /while its checks ran/);
  assert.equal(hub.store.getTask(a.task.id)?.state, 'cancelled');
  assert.ok(!mainText(hub).includes("return 'one'"), 'the cancelled work is not in main');
});

test('file names with spaces or other letters are read whole', async (t) => {
  // reported: "src/my module.py" was refused as outside the scope; a new Chinese .py file skipped the Python check
  const hub = makeHub(t, { checks: [{ name: 'python', run: `${NODE} -e 0`, when: ['*.py'] }] });
  const a = start(hub, 'worker-a'); // may write src/* and tests/*
  const fs = await import('node:fs');
  fs.mkdirSync(path.join(a.wt, 'src'), { recursive: true });
  writeFileSync(path.join(a.wt, 'src', 'my module.py'), 'x = 1\n');
  writeFileSync(path.join(a.wt, 'src', '模块.py'), 'y = 2\n'); // written through the shell: no hook saw it
  const done = await hub.session('worker-a').finishTask(a.task.id, 'done');
  assert.deepEqual([done.state, done.checks], ['done', 'python passed']);
  const tracked = git(hub.baseTeam.project_root, '-c', 'core.quotePath=false', 'ls-files', 'src');
  assert.ok(tracked.includes('src/my module.py') && tracked.includes('src/模块.py'), tracked);
});

test("a DeepSeek run that did nothing says so, and the role's loop waits before the next", async () => {
  // reported: a start that failed (sign-in) read no mail, so the loop started it again at once, over and over
  const run = async (lines: string[]) => runview.main([], Readable.from(lines.map((l) => `${l}\n`)), new PassThrough());
  assert.equal(await run(['error: not signed in']), runview.NO_RUN);
  // reported after: an error event said the same and counted as a run, so the loop went on at once
  assert.equal(await run([JSON.stringify({ type: 'error', message: 'invalid API key' })]), runview.NO_RUN);
  assert.equal(await run([JSON.stringify({ type: 'session', sessionId: 's1' }), JSON.stringify({ type: 'error', message: 'x' })]), runview.NO_RUN);
  assert.equal(await run([JSON.stringify({ type: 'session', sessionId: 's1' }), JSON.stringify({ type: 'text', text: 'hi' })]), 0);
  assert.equal(await run([JSON.stringify({ type: 'tool_call', tool: 'read_inbox', input: {} })]), 0);
  const launch = await import('../src/launch.ts');
  const script = String(launch.deepseekLaunch.toString());
  assert.ok(script.includes('NO_RUN') && script.includes('Start-Sleep'), 'the loop backs off after such a run');
});
