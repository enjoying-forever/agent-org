// The lock across agents' processes: main's (held while a merge runs) is waited for without holding up the rest
// of the waiting process.
import assert from 'node:assert/strict';
import { utimesSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { LockTimeout, withFileLock, withFileLockAsync } from '../src/filelock.ts';
import { rejects, tmpDir } from './helpers.ts';

test('waiting for a held lock leaves the event loop free', async (t) => {
  // reported: a 20 ms timer ran 410 ms late while a lock was waited for
  const file = path.join(tmpDir(t), 'land.lock');
  writeFileSync(file, ''); // someone else holds it
  const started = Date.now();
  const timer = new Promise<number>((resolve) => setTimeout(() => resolve(Date.now() - started), 20));
  const waiting = withFileLockAsync(file, () => 'mine', 5);
  setTimeout(() => unlinkSync(file), 500); // ... and lets go
  assert.ok(await timer < 150, 'the timer ran on time');
  assert.equal(await waiting, 'mine');
  assert.ok(!existsSync(file), 'released after');
  writeFileSync(file, '');
  await rejects(() => withFileLockAsync(file, () => 'never', 0.3, 'main is busy'), LockTimeout, 'main is busy; try again in a moment');
  utimesSync(file, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000)); // left by a process that died
  assert.equal(withFileLock(file, () => 'taken over', 1), 'taken over');
});
