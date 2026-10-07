/**
 * How agent-org runs its own programs (the tool server, hooks, DeepSeek's waiter), finds others on PATH, and
 * reads the few Windows settings it needs.
 *
 * Its programs run on the Node that runs agent-org: plain Node, or the agent-org app's own Electron (as Node,
 * with ELECTRON_RUN_AS_NODE), so nothing else has to be installed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const HERE = fileURLToPath(import.meta.url);
export const CODE_DIR = path.dirname(HERE); // src/ when run from source, dist/ when compiled
const EXT = path.extname(HERE); // .ts or .js: entry points sit beside this file
export const IN_ELECTRON = Boolean(process.versions.electron);

/** One of agent-org's entry points (org_server, org_hook, wake, runview, cli). */
export function entry(name: string): string {
  return path.join(CODE_DIR, `${name}${EXT}`);
}

/** The environment Node needs to run our scripts: Electron's executable runs as Node only when told. */
export function nodeEnv(): Record<string, string> {
  return IN_ELECTRON ? { ELECTRON_RUN_AS_NODE: '1' } : {};
}

/** [command, args, env] that run entry point `name` with `args`. */
export function nodeCommand(name: string, args: string[] = []): [string, string[], Record<string, string>] {
  return [process.execPath, [entry(name), ...args], nodeEnv()];
}

const shortNames = new Map<string, string>();

/** `p` with forward slashes and no quotes, for a command line any shell runs as it is (PowerShell, cmd,
 * bash); on Windows a path with spaces uses its short (8.3) name. Quoted only if there is none. */
export function shellPath(p: string): string {
  let text = p.replace(/\\/g, '/');
  if (text.includes(' ') && process.platform === 'win32') {
    let short = shortNames.get(p);
    if (short === undefined) {
      const out = spawnSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`],
        { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, timeout: 15_000 });
      short = (out.stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '';
      shortNames.set(p, short);
    }
    if (short && !short.includes(' ') && existsSync(short)) text = short.replace(/\\/g, '/');
  }
  return text.includes(' ') ? `"${text}"` : text;
}

/** The command line a harness runs for one of our hooks (`event` and any more words after it). Harnesses hand
 * it to different shells - PowerShell (Grok, Codex), cmd (Antigravity), bash (Claude Code) - so it is in the
 * one form all of them run: unquoted forward-slash paths. Inside the app, a small .cmd file starts Electron
 * as Node (an environment variable cannot be set on a command line every shell reads). */
export function hookCommand(event: string): string {
  if (!IN_ELECTRON) return `${shellPath(process.execPath)} ${shellPath(entry('org_hook'))} ${event}`;
  const node = systemNode(); // a hook runs on every tool step: the .cmd and its cmd.exe add about 55 ms
  if (node !== null) return `${shellPath(node)} ${shellPath(entry('org_hook'))} ${event}`;
  return `${shellPath(hookShim())} ${event}`;
}

let nodeFound: string | null | undefined;

/** The computer's own Node.js (installing agent-org needs one), if it is new enough for agent-org's code. */
export function systemNode(): string | null {
  if (nodeFound !== undefined) return nodeFound;
  nodeFound = null;
  const node = which('node');
  if (node !== null && /\.exe$/i.test(node)) {
    const out = spawnSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    const [major, minor] = (out.stdout ?? '').trim().split('.').map(Number);
    if (major > 22 || (major === 22 && minor >= 13)) nodeFound = node;
  }
  return nodeFound;
}

/** org_hook.cmd in agent-org's home folder, written when missing or out of date. */
function hookShim(): string {
  const home = process.env.AGENT_ORG_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.agent-org');
  const file = path.join(home, 'bin', 'org_hook.cmd');
  const text = `@set ELECTRON_RUN_AS_NODE=1\r\n@"${process.execPath}" "${entry('org_hook')}" %*\r\n`;
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // not written yet
  }
  if (current !== text) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
  }
  return file;
}

/** The full path of program `name` on `searchPath` (default this process's PATH), as a shell would find it. */
export function which(name: string, searchPath?: string): string | null {
  return lookup.which(name, searchPath);
}

/** How programs are found (a test may stand in for it). */
export const lookup = { which: findProgram };

function findProgram(name: string, searchPath: string | undefined = process.env.PATH ?? process.env.Path): string | null {
  const windows = process.platform === 'win32';
  const exts = windows ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter((x) => x) : [''];
  const hasExt = windows && exts.some((x) => name.toLowerCase().endsWith(x.toLowerCase()));
  const candidates = (dir: string): string[] => {
    const base = path.join(dir, name);
    return windows ? [...(hasExt ? [base] : []), ...exts.map((x) => base + x.toLowerCase())] : [base];
  };
  const isFile = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      try { // an app execution alias (Windows Terminal's wt.exe): a link that only Windows itself follows
        return lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    }
  };
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) return candidates('').find(isFile) ?? (isFile(name) ? name : null);
  for (const dir of (searchPath ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const found = candidates(dir.replace(/^"|"$/g, '')).find(isFile);
    if (found) return found;
  }
  return null;
}

/** The values under a registry key ({} if it cannot be read), as `reg query` shows them. */
export function registryValues(key: string): Record<string, { type: string; value: string }> {
  if (process.platform !== 'win32') return {};
  const out = spawnSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  const values: Record<string, { type: string; value: string }> = {};
  for (const line of (out.stdout ?? '').split(/\r?\n/)) {
    const m = /^ {4}(.+?) {4}(REG_\w+) {4}(.*)$/.exec(line) ?? /^ {4}(.+?) {4}(REG_\w+)$/.exec(line);
    if (m) values[m[1]] = { type: m[2], value: m[3] ?? '' };
  }
  return values;
}

/** Whether this runs inside agent-org's tests, which must never start real agents or change real programs. */
export function inTest(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT || process.env.AGENT_ORG_TESTING);
}

const POSTER = `
const { workerData } = require('node:worker_threads');
const http = require('node:http');
const result = new Int32Array(workerData.result);
const finish = (status) => { Atomics.store(result, 0, status); Atomics.notify(result, 0); };
const req = http.request(workerData.url, { method: 'POST', agent: false, headers: workerData.headers }, (res) => {
  res.resume();
  res.on('end', () => finish(res.statusCode || -1));
});
req.on('error', () => finish(-1));
req.end(workerData.body);
`;

/** POST `body` to a local http `url` and wait for the answer, blocking this thread (as the hub's synchronous
 * callers need): the request runs in a worker. Returns the status, or 0 if none came within `timeout` seconds. */
export function postSync(url: string, body: string, headers: Record<string, string>, timeout: number): number {
  const shared = new SharedArrayBuffer(4);
  const result = new Int32Array(shared);
  const worker = new Worker(POSTER, { eval: true, workerData: { url, body, headers, result: shared } });
  try {
    Atomics.wait(result, 0, 0, timeout * 1000);
    return Math.max(0, Atomics.load(result, 0));
  } finally {
    void worker.terminate();
  }
}
