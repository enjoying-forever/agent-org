// The org command: the owner's (and a tester's) way to the hub from a terminal.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import * as cli from '../src/cli.ts';
import { entry } from '../src/runtime.ts';
import { cleanup, writeTeamFile } from './helpers.ts';

/** Run `org` in this process: [exit code, what it printed, what it complained]. */
async function org(t: TestContext, file: string, ...argv: string[]): Promise<[number, string, string]> {
  const [out, err] = [process.stdout.write, process.stderr.write];
  let [printed, complained] = ['', ''];
  process.stdout.write = ((c: string) => { printed += c; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => { complained += c; return true; }) as typeof process.stderr.write;
  cleanup(t, () => { [process.stdout.write, process.stderr.write] = [out, err]; });
  try {
    return [await cli.main(['--team', file, ...argv]), printed, complained];
  } finally {
    [process.stdout.write, process.stderr.write] = [out, err];
  }
}

test('the owner talks to the team', async (t) => {
  const file = writeTeamFile(t);
  let [code, out] = await org(t, file, 'tree');
  assert.equal(code, 0);
  assert.ok(out.includes('leader') && out.includes('worker-a'));
  [code, out] = await org(t, file, 'send', 'leader', 'build the parser');
  assert.ok(code === 0 && /#1 \d\d:\d\d:\d\d \[instruction\] you -> leader: build the parser/.test(out), out);
  [code, out] = await org(t, file, '--as', 'leader', 'inbox');
  assert.ok(out.includes('build the parser'));
  [code, out] = await org(t, file, '--as', 'leader', 'send', 'you', 'on it', '--reply-to', '1');
  assert.ok(out.includes('(re #1)'));
  [code, out] = await org(t, file, 'wait', '--timeout', '1');
  assert.ok(out.includes('on it'));
  [code, out] = await org(t, file, 'view', 'leader');
  assert.ok(out.includes('superior:     you') && out.includes('session:      not running'));
});

test('files: claim, check, list, release', async (t) => {
  const file = writeTeamFile(t);
  assert.equal((await org(t, file, '--as', 'worker-a', 'can-write', 'src/a.py'))[0], 1);
  assert.ok((await org(t, file, '--as', 'worker-a', 'claim', 'src/a.py'))[1].includes('src/a.py  held by worker-a since'));
  assert.equal((await org(t, file, '--as', 'worker-a', 'can-write', 'src/a.py'))[0], 0);
  assert.ok((await org(t, file, 'locks'))[1].includes('src/a.py'));
  assert.ok((await org(t, file, '--as', 'worker-a', 'release', 'src/a.py'))[1].includes('released src/a.py'));
  assert.equal((await org(t, file, 'locks'))[1].trim(), 'no locks');
});

test('refusals and mistakes say what went wrong', async (t) => {
  const file = writeTeamFile(t);
  let [code, , err] = await org(t, file, '--as', 'worker-a', 'send', 'leader', 'hi');
  assert.ok(code === 1 && err.startsWith('refused: '), err);
  [code, , err] = await org(t, file, 'fly');
  assert.ok(code === 2 && err.includes('unknown command: fly') && err.includes('usage: org'));
  [code, , err] = await org(t, file, 'send', 'leader');
  assert.ok(code === 2 && err.includes('usage: org send TO TEXT'));
  [code, , err] = await org(t, file, 'wait', '--timeout', 'soon');
  assert.ok(code === 2 && err.includes('--timeout must be a number'));
  [code, , err] = await org(t, `${file}.missing`, 'tree');
  assert.ok(code === 2 && err.startsWith('team error: '), err);
});

test('it runs as a program, the team taken from the environment', (t) => {
  const file = writeTeamFile(t);
  const done = spawnSync(process.execPath, [entry('cli'), 'tree'], { encoding: 'utf8', env: { ...process.env, AGENT_ORG_TEAM: file }, timeout: 20_000 });
  assert.equal(done.status, 0, done.stderr);
  assert.ok(done.stdout.includes('researcher'));
});
