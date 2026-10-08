// Branch mode: every agent in its own git worktree; finished work lands in main at once. This file: copies, merging, landing.
// (Two files, run side by side: each test makes real repositories, and git processes are slow on Windows.)
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { roleCard } from '../src/cards.ts';
import * as gitops from '../src/gitops.ts';
import * as hooks from '../src/hooks.ts';
import { HubError } from '../src/hub.ts';
import { BASE, edit, git, mainText, makeHub, readIn, SHARED, start } from './branch_helpers.ts';
import { rejects } from './helpers.ts';

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
