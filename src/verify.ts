/**
 * The team's checks: commands that must pass before a task may be closed as done.
 *
 * Like the verification gates of Gas Town's merge queue: set them in team.yaml,
 *
 *     checks:
 *       - name: tests
 *         run: python -m pytest -q
 *         when: ["*.py"]     # only when the task changed a Python file (optional)
 *         timeout: 300
 *
 * and finish_task(done) runs every check that applies, in the project folder.
 */

import { spawn, spawnSync } from 'node:child_process';
import { fnmatchcase } from './fnmatch.ts';
import type { CheckSpec, Team } from './team.ts';

const TAIL = 1500; // characters of a failing check's output passed back to the agent

export interface Outcome {
  name: string;
  ok: boolean;
  output: string;
  command: string;
}

export function applies(check: CheckSpec, files: readonly string[]): boolean {
  if (!check.when.length) return true;
  return files.some((f) => check.when.some((w) => fnmatchcase(f.toLowerCase(), w.toLowerCase().replace(/^\.\//, ''))));
}

/** Run every check that applies to a task which changed `files`, in `cwd` (the project folder). */
export async function run(team: Team, files: readonly string[], cwd: string | null = null): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const check of team.checks) {
    if (!applies(check, files)) continue;
    let result: { code: number | null; output: string };
    try {
      result = await command(check.run, cwd ?? team.project_root, check.timeout);
    } catch (e) {
      outcomes.push({ name: check.name, ok: false, output: `could not run: ${(e as Error).message}`, command: check.run });
      continue;
    }
    if (result.code === null) {
      outcomes.push({ name: check.name, ok: false, output: `did not finish within ${check.timeout} seconds`, command: check.run });
    } else {
      outcomes.push({ name: check.name, ok: result.code === 0, output: result.output.trim().slice(-TAIL), command: check.run });
    }
  }
  return outcomes;
}

/**
 * Run a shell command: its exit code and output, or code null if it ran out of time.
 *
 * The hub runs inside an agent's tool server, whose stdin is the harness's pipe: a child that inherits it
 * can hang on Windows before it even starts, so it gets an empty stdin. When time runs out the whole
 * process tree goes, so no grandchild keeps the output open.
 */
export function command(line: string, cwd: string, timeout: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(line, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => chunks.push(d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      setTimeout(() => resolve({ code: null, output: Buffer.concat(chunks).toString('utf8') }), 10_000).unref();
    }, timeout * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : (code ?? 1), output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 30_000, windowsHide: true });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** One line an agent can act on: the check's name, its command, and when it runs. */
export function describe(check: CheckSpec): string {
  const when = check.when.length ? ` (when a task changes ${check.when.join(', ')})` : '';
  return `${check.name}: \`${check.run}\`${when}`;
}

export function summary(outcomes: readonly Outcome[]): string {
  return outcomes.map((o) => `${o.name} ${o.ok ? 'passed' : 'FAILED'}`).join(', ');
}
