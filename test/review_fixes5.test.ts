// Problems found in a fifth review (2026-10-13), each reproduced here as it was reported: terminal input for
// another team, history begun with a secret in it, an empty repository, a task moved in branch mode, and the
// command line past max_running.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as gitops from '../src/gitops.ts';
import * as launch from '../src/launch.ts';
import * as safety from '../src/safety.ts';
import type * as terminals from '../src/terminals.ts';
import { edit, git, makeHub as branchHub, readIn, SHARED, start } from './branch_helpers.ts';
import { team, tmpDir, writeTeamFile } from './helpers.ts';
import { startServer } from './web.ts';

const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';

test("keys typed for one team's terminal do not reach another's, nor a later one", async (t) => {
  // reported: a paste still going when the team was switched sent its rest and its Enter to the other team
  const server = await startServer(t);
  const typed: string[] = [];
  const term = { id: 7, typed: (d: string) => typed.push(d) } as unknown as terminals.Terminal;
  server.app.terminals.get = () => term;
  await server.ok('/api/term-input', { role: 'leader', data: 'a', team: server.teamFile, terminal: 7 });
  const [other] = await server.request('/api/term-input', { role: 'leader', data: 'b', team: 'C:/another/team.yaml', terminal: 7 });
  const [again] = await server.request('/api/term-input', { role: 'leader', data: 'c', team: server.teamFile, terminal: 6 });
  assert.deepEqual([other, again, typed], [409, 409, ['a']]);
});

test('history begun in a project with a secret leaves that file out', (t) => {
  // reported: turning history on committed everything, a .env with a key included, scan_secrets or not
  const root = tmpDir(t);
  writeFileSync(path.join(root, 'app.py'), 'print("hi")\n');
  writeFileSync(path.join(root, '.env'), `API_KEY='${SECRET}'\n`);
  const left: string[] = [];
  assert.equal(gitops.init(root, safety.findSecrets, left), 'on');
  assert.deepEqual(left, ['.env']);
  assert.ok(!git(root, 'log', '-p', '--all').includes('sk-ant'), 'the key is nowhere in history');
  assert.ok(git(root, 'ls-files').includes('app.py'));
  assert.match(readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\/\.env$/m);
  assert.ok(existsSync(path.join(root, '.env')), 'the file itself stays');
});

test('a repository made with no commit yet gets its first one', (t) => {
  // reported: git init done, nothing committed - branch mode failed with "invalid reference: master"
  const root = tmpDir(t);
  writeFileSync(path.join(root, 'app.py'), 'x = 1\n');
  execFileSync('git', ['-C', root, 'init', '-q']);
  assert.ok(gitops.isOwnRepo(root) && !gitops.hasCommits(root));
  assert.equal(gitops.init(root), 'on');
  assert.ok(gitops.hasCommits(root));
  assert.equal(gitops.init(root), 'already on');
});

test('branch mode: an empty repository still gives each agent its copy', (t) => {
  const hub = branchHub(t);
  execFileSync('git', ['-C', hub.baseTeam.project_root, 'init', '-q']);
  const wt = hub.prepareRoot('worker-a');
  assert.ok(existsSync(path.join(wt, SHARED)));
});

test('branch mode: a moved task takes its work along to the new copy', (t) => {
  // reported: moved from A to B, B's copy had none of A's changes, and the task's changes seemed gone
  const hub = branchHub(t);
  const a = start(hub, 'worker-a');
  edit(a.wt, 'return 1', "return 'from a'");
  hub.session('worker-a').noteEdit(SHARED);
  const moved = hub.session('tech-lead').reassignTask(a.task.id, 'worker-b', 'worker-a is out of its usage');
  const b = hub.rootOf('worker-b');
  assert.ok(readIn(b).includes("return 'from a'"), "B's copy has A's work");
  assert.ok(!readIn(a.wt).includes("return 'from a'"), "and A's copy no longer does: its next landing will not bring it");
  assert.ok(hub.session('tech-lead').taskChanges(moved.id).diff.includes("from a"), "the task's changes are where it is now");
  const told = hub.session('worker-b').readInbox().map((m) => m.text).join('\n');
  assert.match(told, /in your copy as worker-a left them/);
});

test('the command line keeps to max_running', async (t) => {
  // reported: max_running 1, and a dry run still meant to start three agents
  const file = writeTeamFile(t, { ...team(), max_running: 1 });
  const written: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((s: string) => { written.push(String(s)); return true; }) as typeof process.stdout.write;
  const err = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal(await launch.main(['--team', file, '--dry-run', '--no-owner']), 0);
  } finally {
    process.stdout.write = write;
    process.stderr.write = err;
  }
  assert.equal(written.join('').trim().split('\n').filter(Boolean).length, 1, written.join(''));
});
