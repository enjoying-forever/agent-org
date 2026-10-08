// Branch mode: every agent in its own git worktree; finished work lands in main at once. This file: what never reaches main, and reading git's files.
// (Two files, run side by side: each test makes real repositories, and git processes are slow on Windows.)
import assert from 'node:assert/strict';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as gitops from '../src/gitops.ts';
import { HubError } from '../src/hub.ts';
import { edit, git, mainText, makeHub, SHARED, start } from './branch_helpers.ts';
import { rejects } from './helpers.ts';

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

test("main's head is read from the repository's files, as git would answer", async (t) => {
  const hub = makeHub(t);
  const a = start(hub, 'worker-a'); // history is on, and worker-a has its copy
  const root = hub.baseTeam.project_root;
  const answer = (): [string, string] => [git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), git(root, 'rev-parse', 'HEAD').trim()];
  assert.deepEqual(gitops.mainHead(root), answer());
  edit(a.wt, 'return 1', "return 'one'");
  await hub.session('worker-a').finishTask(a.task.id, 'done'); // main moves on
  assert.deepEqual(gitops.mainHead(root), answer());
  git(root, 'pack-refs', '--all'); // refs packed into one file
  assert.deepEqual(gitops.mainHead(root), answer());
  git(root, 'checkout', '-q', '--detach');
  assert.equal(gitops.mainHead(root), null); // not on a branch: git is asked instead
});

test("refs are read from git's own files, as git would answer, in the main folder and the copies", async (t) => {
  const hub = makeHub(t);
  const a = start(hub, 'worker-a');
  const b = start(hub, 'worker-b');
  const root = hub.baseTeam.project_root;
  const main = gitops.mainBranch(root);
  const rev = (where: string, ref: string): string => {
    try {
      return git(where, 'rev-parse', '--verify', '--quiet', ref).trim();
    } catch {
      return ''; // git says it does not exist
    }
  };
  const same = (label: string): void => {
    for (const [where, ref] of [[root, 'HEAD'], [root, main], [a.wt, 'HEAD'], [b.wt, 'HEAD'], [root, 'refs/heads/agent/worker-a'],
      [a.wt, main], [a.wt, 'MERGE_HEAD'], [b.wt, 'MERGE_HEAD']] as [string, string][]) {
      assert.equal(gitops.readRef(where, ref) ?? rev(where, ref), rev(where, ref), `${label}: ${ref} in ${path.basename(where)}`);
    }
  };
  assert.equal(main, git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim());
  same('at the start');
  assert.notEqual(gitops.readRef(a.wt, 'HEAD'), null); // a copy's .git is a file pointing at its own git folder: read too
  edit(a.wt, 'return 1', "return 'from a'");
  await hub.session('worker-a').finishTask(a.task.id, 'done'); // main moves on
  same('after a landing');
  edit(b.wt, 'return 1', "return 'from b'"); // the same line: merging main into b conflicts
  gitops.commitAll(b.wt, 'b');
  gitops.sync(b.wt, main, false);
  assert.ok(gitops.merging(b.wt));
  same('during a merge');
  git(b.wt, 'merge', '--abort');
  assert.ok(!gitops.merging(b.wt));
  same('after it');
  git(root, 'pack-refs', '--all');
  same('with the refs packed');
  git(a.wt, 'checkout', '-q', '--detach');
  same('a copy detached');
  assert.equal(gitops.readRef(root, 'HEAD~1'), null); // anything fancier is git's to answer
});

test('a copy whose main has not moved costs no git calls', (t) => {
  const hub = makeHub(t);
  start(hub, 'worker-a');
  hub.syncRole('worker-a'); // the first look takes main in
  const started = performance.now();
  for (let i = 0; i < 20; i++) assert.equal(hub.syncRole('worker-a'), '');
  assert.ok(performance.now() - started < 200, `${(performance.now() - started).toFixed(0)} ms for 20 looks`); // one git call takes 30 ms or more
});
