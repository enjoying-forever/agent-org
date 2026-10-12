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

/** The lock file made (its descriptor), or null while someone else holds it. One left by a process that died is
 * taken over. */
function take(file: string): number | null {
  for (;;) {
    try {
      return openSync(file, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(file).mtimeMs <= STALE * 1000) return null;
        unlinkSync(file);
      } catch {
        return null; // gone meanwhile, or unreadable: the next try tells
      }
    }
  }
}

function holding<T>(file: string, fd: number, body: () => T): T {
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

/** Run `body` while holding the lock file `file`; others wait up to `timeout` seconds, then get `busy`. The wait
 * holds up this process's event loop: for locks kept a moment only (the team file's). */
export function withFileLock<T>(file: string, body: () => T, timeout = 120, busy = 'someone else is busy with this'): T {
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeout * 1000;
  let fd: number | null;
  while ((fd = take(file)) === null) {
    if (Date.now() > deadline) throw new LockTimeout(`${busy}; try again in a moment`);
    sleepSync(200);
  }
  return holding(file, fd, body);
}

/** withFileLock that waits without holding up the event loop - for a lock kept for seconds (main's, while a merge
 * runs), whose waiters' processes have more to do meanwhile (seen: a 20 ms timer of the window ran 410 ms late). */
export async function withFileLockAsync<T>(file: string, body: () => T, timeout = 120, busy = 'someone else is busy with this'): Promise<T> {
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeout * 1000;
  let fd: number | null;
  while ((fd = take(file)) === null) {
    if (Date.now() > deadline) throw new LockTimeout(`${busy}; try again in a moment`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return holding(file, fd, body);
}
