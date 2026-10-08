// A fault nothing caught goes to errors.log, and the window or tool server it happened in keeps running.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tmpDir } from './helpers.ts';

const RUNTIME = path.resolve(import.meta.dirname, '..', 'src', 'runtime.ts');

test('a stray fault is logged, and the process carries on', (t) => {
  const home = tmpDir(t);
  const script = `
    const { keepRunningOnFaults } = await import(${JSON.stringify(`file:///${RUNTIME.replace(/\\/g, '/')}`)});
    keepRunningOnFaults('test');
    void Promise.reject(new Error('nobody awaited me'));
    setTimeout(() => { throw new Error('out of a timer'); }, 10);
    setTimeout(() => console.log('still running'), 150);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, AGENT_ORG_HOME: home }, timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'still running');
  const log = readFileSync(path.join(home, 'errors.log'), 'utf8');
  assert.match(log, /\[test: unhandled rejection, pid \d+\] Error: nobody awaited me/);
  assert.match(log, /\[test: uncaught exception, pid \d+\] Error: out of a timer/);
});
