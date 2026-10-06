/** A lock across every agent's process: a file that exists while someone holds it. */

import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const STALE = 300; // seconds after which a lock left by a process that died is taken over

const pause = new Int32Array(new SharedArrayBuffer(4));

/** Sleep without returning to the event loop: the callers hold no async state across it. */
export function sleepSync(ms: number): void {
  Atomics.wait(pause, 0, 0, ms);
}

export class LockTimeout extends Error {
  override name = 'LockTimeout';
}

/** Run `body` while holding the lock file `file`; others wait up to `timeout` seconds, then get `busy`. */
export function withFileLock<T>(file: string, body: () => T, timeout = 120, busy = 'someone else is busy with this'): T {
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeout * 1000;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(file, 'wx');
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(file).mtimeMs > STALE * 1000) {
          unlinkSync(file);
          continue;
        }
      } catch {
        // gone meanwhile, or unreadable: try again
      }
      if (Date.now() > deadline) throw new LockTimeout(`${busy}; try again in a moment`);
      sleepSync(200);
    }
  }
  try {
    return body();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }
}
