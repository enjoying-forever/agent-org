// Problems found in a second review (2026-10-13), each reproduced here as it was reported: what a task may land
// in main (a secret added in a merge, main moving while it is taken in, a cancel during the merge), and the
// scope a manager may hand on. A git hook puts the other agent's move at the exact moment it was seen.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { roleCard } from '../src/cards.ts';
import { HubError } from '../src/hub.ts';
import { teamTree } from '../src/teamtree.ts';
import { edit, git, mainText, makeHub, SHARED, start } from './branch_helpers.ts';
import { makeHub as plainHub, rejects, team as example } from './helpers.ts';

const NODE = `"${process.execPath}"`;
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const slash = (p: string): string => p.replace(/\\/g, '/');

/** A git hook of the project (every copy shares them): a shell script that runs once. */
function hook(root: string, name: string, body: string): void {
  const flag = slash(path.join(root, '..', `${name}.ran`));
  writeFileSync(path.join(git(root, 'rev-parse', '--git-common-dir').trim().replace(/^\.git$/, path.join(root, '.git')), 'hooks', name),
    `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\n[ -f "${flag}" ] && exit 0\n: > "${flag}"\n${body}\n`,
    { mode: 0o755 });
}

/** A commit in main made by someone else (the project folder is main's). */
function commitInMain(root: string, file: string, text: string): void {
  writeFileSync(path.join(root, file), text);
  git(root, 'add', file);
  git(root, ...ID, 'commit', '-q', '-m', `meanwhile: ${file}`);
}

test('a secret added in a merge, and taken out after, does not reach main', async (t) => {
  // reported: the history scan skipped merge commits; the task was done and main's history held the key
  const hub = makeHub(t);
  const root = hub.baseTeam.project_root;
  const a = start(hub, 'worker-a');
  commitInMain(root, 'other.txt', 'from main\n');
  git(a.wt, ...ID, 'merge', '--no-commit', '--no-ff', git(root, 'branch', '--show-current').trim()); // the agent takes main in, and in the same merge...
  edit(a.wt, 'return 1', `return '${SECRET}'`);
  git(a.wt, 'add', '-A');
  git(a.wt, ...ID, 'commit', '-q', '--no-edit');
  edit(a.wt, `return '${SECRET}'`, "return 'one'"); // ...then takes it out again
  const done = await hub.session('worker-a').finishTask(a.task.id, 'done');
  assert.equal(done.state, 'done');
  assert.ok(mainText(hub).includes("return 'one'"));
  assert.ok(!git(root, 'log', '-p', '--cc', '--all').includes('sk-ant'), 'the secret is nowhere in the history');
});

test('main moving while it is taken in is not taken for the main that was checked', async (t) => {
  // reported: main moved between taking it in and reading it; "passed" was recorded, the same check failed after
  const hub = makeHub(t, { checks: [{ name: 'tests', run: `${NODE} -e "process.exit(require('fs').existsSync('bad.txt') ? 1 : 0)"` }] });
  const root = hub.baseTeam.project_root;
  const a = start(hub, 'worker-a');
  edit(a.wt, 'return 1', "return 'one'");
  commitInMain(root, 'other.txt', 'from main\n'); // so taking main in is a real merge, which runs the hook
  hook(root, 'post-merge', `cd "${slash(root)}" && echo bad > bad.txt && git add bad.txt && git ${ID.join(' ')} commit -q -m meanwhile`);
  await rejects(() => hub.session('worker-a').finishTask(a.task.id, 'done'), HubError, /is not done yet: tests FAILED/);
  assert.ok(!mainText(hub).includes("return 'one'"), 'the unchecked combination did not land');
});

test('a task cancelled while it goes into main: the cancel waits, and what the task says is what main has', async (t) => {
  // reported: the cancel came during the merge; the task stayed cancelled and its code was in main
  const hub = makeHub(t);
  const root = hub.baseTeam.project_root;
  const a = start(hub, 'worker-a');
  edit(a.wt, 'return 1', "return 'one'");
  const dir = path.dirname(root);
  const config = path.join(dir, 'team.json');
  writeFileSync(config, JSON.stringify({ ...example(), isolation: 'branches' }));
  const said = path.join(dir, 'cancel.out');
  const src = (f: string): string => pathToFileURL(path.resolve('src', f)).href;
  const script = path.join(dir, 'cancel.ts'); // the lead cancels from its own process, as it would
  writeFileSync(script, `
import { readFileSync, writeFileSync } from 'node:fs';
import { Hub } from '${src('hub.ts')}';
import { Store } from '${src('store.ts')}';
import { Team } from '${src('team.ts')}';
const team = Team.fromDict(JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8')), ${JSON.stringify(dir)});
const hub = new Hub(team, new Store(team.database));
try { hub.session('tech-lead').cancelTask(${a.task.id}, 'not needed'); writeFileSync(${JSON.stringify(said)}, 'cancelled'); }
catch (e) { writeFileSync(${JSON.stringify(said)}, String(e.message)); }
hub.close();
`);
  hook(root, 'pre-merge-commit', `"${slash(process.execPath)}" "${slash(script)}"`); // main's merge, before it is made
  const done = await hub.session('worker-a').finishTask(a.task.id, 'done');
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(said, 'utf8'), /is going into main right now; cancel it in a moment/);
  assert.equal(done.state, 'done');
  assert.ok(mainText(hub).includes("return 'one'"));
  hub.session('tech-lead').cancelTask(a.task.id, 'not needed'); // after: it can be
  assert.equal(hub.store.getTask(a.task.id)?.state, 'cancelled');
  void SHARED;
});

test('a role named like a built-in of objects has its own line in the team tree', (t) => {
  // reported: a role named constructor with a task made team_tree and my_role fail with ".push is not a function"
  const config = example() as ReturnType<typeof example> & { roles: Record<string, unknown> };
  config.roles.constructor = { superior: 'tech-lead', harness: 'codex', write_scope: ['src/*'] };
  config.roles.toString = { superior: 'tech-lead', harness: 'codex', write_scope: ['tests/*'] };
  const { hub } = plainHub(t, config);
  const lead = hub.session('tech-lead');
  lead.assignTask('constructor', 'Build the parser');
  lead.assignTask('toString', 'Test the parser');
  hub.session('constructor').claim('src/parser.ts');
  const me = hub.session('constructor');
  const tree = teamTree(me, { detail: 'full' });
  assert.ok(tree.includes('- constructor [codex]') && tree.includes('<- you'), tree);
  assert.ok(tree.includes('Build the parser') && tree.includes('src/parser.ts'), tree);
  assert.ok(teamTree(lead).includes('- toString [codex]'));
  assert.ok(roleCard(me).includes("You are 'constructor'"));
});

test("a check's output is kept by its end only", async () => {
  // reported: a check that wrote 8 MiB was held whole in memory, for the 1500 characters passed on
  const { command } = await import('../src/verify.ts');
  const loud = `${NODE} -e "process.stdout.write('x'.repeat(8 * 1024 * 1024)); process.stdout.write('THE END')"`;
  const { code, output } = await command(loud, process.cwd(), 60);
  assert.equal(code, 0);
  assert.ok(output.length <= 64 * 1024 && output.endsWith('THE END'), String(output.length));
});
