/**
 * Between two runs of an agent whose program does one task per run (DeepSeek Harness).
 *
 * Its start script runs this first, and again after each run: it waits - without a model, so at no cost - until
 * the role has a new message (a task arrives as one too), then exits 0 and the script starts a run. At the start
 * (--first) unfinished tasks count too: the team was restarted. Stopping the role (its stop marker appears) ends
 * it with 3. While it waits, it keeps the role checked in, so the team sees the agent as running and the
 * watchdog does not start a second one.
 */

import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { Hub, sleep } from './hub.ts';
import { unfinished } from './waker.ts';

export const HEARTBEAT = 10; // seconds between check-ins (presence counts the last 30)
export const STOPPED = 3;

/** Whether process `pid` still runs (without touching it). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // it runs, as someone else
  }
}

/** The first line typed into the agent's terminal while it waits goes to it as a message from the owner. */
export async function readOwner(hub: Hub, role: string, input: Readable = process.stdin): Promise<void> {
  const owner = hub.baseTeam.owner;
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const text = line.trim();
    if (text) {
      hub.session(owner).send(role, text); // the wait sees it and starts the agent
      lines.close();
      return;
    }
  }
}

export function promptLine(role: string): string {
  const rule = `\x1b[2m${'─'.repeat(72)}\x1b[0m\n`;
  return `${rule}\x1b[2m  ${role} is waiting. Type a message for it and press Enter (no model runs meanwhile).\x1b[0m\n${rule}\x1b[38;5;69m›\x1b[0m `;
}

export async function waitForWork(hub: Hub, role: string, stopMarker: string, poll = 1.0, signal: AbortSignal | null = null): Promise<number> {
  const pid = process.pid;
  for (const [gone] of hub.store.sessionsOf(role)) { // the run that just ended may not have checked out
    if (gone !== pid && !alive(gone)) hub.store.checkOut(gone);
  }
  let lastBeat = 0;
  try {
    for (;;) {
      if (existsSync(stopMarker) || signal?.aborted) return STOPPED;
      if (hub.store.unreadCount(role, true) > 0) return 0; // a note alone waits for real mail
      if (Date.now() / 1000 - lastBeat > HEARTBEAT) {
        hub.store.checkIn(pid, role);
        lastBeat = Date.now() / 1000;
      }
      await sleep(poll * 1000, signal);
    }
  } finally {
    hub.store.checkOut(pid);
  }
}

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [team, role, stop] = [option(argv, '--team'), option(argv, '--role'), option(argv, '--stop')];
  if (!team || !role || !stop) {
    process.stderr.write('usage: wake --team team.yaml --role name --stop marker [--input] [--first]\n');
    return 2;
  }
  const hub = Hub.open(team);
  if (argv.includes('--first') && !existsSync(stop) && unfinished(hub.session(role)).length) {
    hub.close();
    process.stdout.write(`\x1b[2m${role} has unfinished tasks: carrying on with them\x1b[0m\n`);
    return 0;
  }
  if (argv.includes('--input')) { // an input line, as an interactive program has one
    process.stdout.write(promptLine(role));
    void readOwner(hub, role);
  } else {
    process.stdout.write(`agent-org: ${role} is waiting for messages (no model runs meanwhile).\n`);
  }
  let code: number;
  const interrupted = new AbortController(); // Ctrl+C: stop waiting, as a stop does
  const onInterrupt = (): void => interrupted.abort();
  process.once('SIGINT', onInterrupt);
  try {
    code = await waitForWork(hub, role, stop, 1.0, interrupted.signal);
  } finally {
    process.off('SIGINT', onInterrupt);
    hub.close();
  }
  if (code === 0) process.stdout.write(`\n\x1b[2mnew messages for ${role}: working on them\x1b[0m\n`);
  return code;
}

if (process.argv[1] && import.meta.filename === (await import('node:path')).resolve(process.argv[1])) {
  (await import('node:module')).default.enableCompileCache?.();
  process.exit(await main()); // leave no reader of the terminal behind: the agent's run reads it next
}
