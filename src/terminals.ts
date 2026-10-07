/**
 * Agents' terminals inside the agent-org window.
 *
 * Each agent runs in a pseudo-terminal this process owns (Windows ConPTY, through node-pty) instead of a
 * Windows Terminal tab. The page shows it with xterm.js: one long-poll fetches the new output of all of them
 * (`TerminalHost.readMany`), and keystrokes (`write`) and sizes (`resize`) go back.
 *
 * Agents started this way live as long as agent-org runs: closing the window ends them (their conversations
 * are kept, so the next start resumes them).
 */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registryValues, which } from './runtime.ts';
import { dict } from './dict.ts';

type Pty = import('@lydell/node-pty').IPty;
type PtyModule = typeof import('@lydell/node-pty');

let ptyModule: PtyModule | null | undefined;

/** node-pty, loaded when first needed (null where it cannot run). */
function pty(): PtyModule | null {
  if (ptyModule === undefined) {
    try {
      ptyModule = createRequire(import.meta.url)('@lydell/node-pty') as PtyModule;
    } catch {
      ptyModule = null;
    }
  }
  return ptyModule;
}

export const GATHER_MS = 40; // terminal output is answered at most this often (see readMany)
export const KEEP = 400_000; // characters of output kept per terminal: what a page opened later still sees
let nextId = 1;
const ESCAPES = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bO.|\x1b./g; // keys and replies, not text

export function available(): boolean {
  return process.platform === 'win32' && pty() !== null;
}

// What a program started by Claude Code (or its desktop app), or by the Electron app itself, inherits. Inside
// an agent's terminal it would make that agent believe it is a sub-session of someone else's session.
const SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_', 'CLAUDE_AGENT_SDK', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_PREVIEW',
  'MCP_CONNECTION_NONBLOCKING', 'MCP_SERVER_CONNECTION_BATCH_SIZE', 'ELECTRON_'];

// How agent-org reaches the internet: the agents need the same (a proxy can decide whether a service is
// available at all - Antigravity refuses some regions).
const NETWORK_VARS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_USE_ENV_PROXY']);

export type Env = Record<string, string>;

/** Windows' own proxy setting (what a proxy app's "system proxy" mode sets), as a URL. */
export const net = {
  systemProxy(): string | null {
    const values = registryValues('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings');
    if (!values.ProxyEnable || !Number(values.ProxyEnable.value)) return null;
    let server = (values.ProxyServer?.value ?? '').trim();
    if (server.includes('=')) { // per protocol: "http=host:port;https=host:port"
      const parts = Object.fromEntries(server.split(';').filter((p) => p.includes('=')).map((p) => {
        const at = p.indexOf('=');
        return [p.slice(0, at), p.slice(at + 1)];
      }));
      server = parts.https || parts.http || '';
    }
    if (!server) return null;
    return server.includes('://') ? server : `http://${server}`;
  },
};

/** `env` with agent-org's own proxy and certificate settings, or Windows' system proxy. */
export function networkEnv(env: Env): Env {
  const result: Env = Object.fromEntries(Object.entries(env).filter(([k]) => !NETWORK_VARS.has(k.toUpperCase())));
  const carried = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => NETWORK_VARS.has(k.toUpperCase()) && v !== undefined)) as Env;
  Object.assign(result, carried);
  if (!Object.keys(carried).some((k) => ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].includes(k.toUpperCase()))) {
    const proxy = net.systemProxy();
    if (proxy) {
      Object.assign(result, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy });
      if (!Object.keys(result).some((k) => k.toUpperCase() === 'NO_PROXY')) result.NO_PROXY = 'localhost,127.0.0.1,::1';
    }
  }
  return result;
}

/** The environment a newly started program of this user gets (as a new Windows Terminal tab does), not
 * agent-org's own - whatever started agent-org must not leak into its agents - but with agent-org's way to
 * the internet (its proxy). */
export function freshEnv(): Env {
  return networkEnv(userEnv());
}

/** Set `name` in `env`, replacing a variable of the same name in other letter case (Windows names are). */
function put(env: Env, name: string, value: string): void {
  const same = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  if (same !== undefined) delete env[same];
  env[name] = value;
}

function expand(value: string, env: Env): string {
  const upper = new Map(Object.entries(env).map(([k, v]) => [k.toUpperCase(), v]));
  return value.replace(/%([^%]+)%/g, (whole, name: string) => upper.get(name.toUpperCase()) ?? whole);
}

/** This user's environment as Windows gives a new program: agent-org's own, without what its starter set, with
 * the variables (PATH above all) as they are set now - a program installed since agent-org started is found. */
export function userEnv(): Env {
  const env: Env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SESSION_VARS.some((p) => k.toUpperCase().startsWith(p))) env[k] = v;
  }
  if (process.platform !== 'win32') return env;
  const system = registryValues('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
  const user = registryValues('HKCU\\Environment');
  if (!Object.keys(system).length) return env; // the registry cannot be read: keep what there is
  for (const values of [system, user]) {
    for (const [name, { type, value }] of Object.entries(values)) {
      if (name.toUpperCase() === 'PATH' || !['REG_SZ', 'REG_EXPAND_SZ'].includes(type)) continue;
      put(env, name, type === 'REG_EXPAND_SZ' ? expand(value, env) : value);
    }
  }
  const pathOf = (values: typeof system): string => {
    const entry = Object.entries(values).find(([k]) => k.toUpperCase() === 'PATH')?.[1];
    return entry ? (entry.type === 'REG_EXPAND_SZ' ? expand(entry.value, env) : entry.value) : '';
  };
  const joined = [pathOf(system), pathOf(user)].filter((x) => x).join(';');
  if (joined) put(env, 'Path', joined);
  return env;
}

export interface Chunk {
  id: number; data: string; next: number; reset: boolean; alive: boolean; age: number; cols: number; rows: number;
}

/** One program in a pseudo-terminal, with its recent output. */
export class Terminal {
  readonly id = nextId++; // a new one for each start, so a page knows to clear its screen
  readonly title: string;
  readonly color: string;
  cols: number;
  rows: number;
  readonly started = Date.now() / 1000;
  lastOutput = this.started;
  lastInput = 0; // when the owner last typed text here (see typed)
  unsent = false; // the owner typed text and has not sent it (Enter) or cleared it (Ctrl+C)
  alive = true;
  readonly exited: Promise<void>; // resolves when its program has ended
  readonly proc: Pty;
  private buf = '';
  private start = 0; // where buf begins in the whole output

  constructor(argv: string[], cwd: string, title = '', color = '', cols = 120, rows = 32, notify: () => void = () => {},
    extraEnv: Env = {}) {
    const node = pty();
    if (node === null) throw new Error('terminals in the window need node-pty, which could not be loaded');
    this.title = title;
    this.color = color;
    this.cols = cols;
    this.rows = rows;
    const env = freshEnv();
    for (const [name, value] of Object.entries(extraEnv)) put(env, name, value);
    const exe = which(argv[0], env.Path ?? env.PATH) ?? which(argv[0]) ?? argv[0];
    this.proc = node.spawn(exe, argv.slice(1), { name: 'xterm-256color', cols, rows, cwd, env });
    this.proc.onData((data) => {
      this.buf += data;
      this.lastOutput = Date.now() / 1000;
      if (this.buf.length > KEEP) {
        const cut = this.buf.length - KEEP;
        this.buf = this.buf.slice(cut);
        this.start += cut;
      }
      notify();
    });
    let ended = (): void => {};
    this.exited = new Promise((resolve) => { ended = resolve; });
    this.proc.onExit(() => {
      this.alive = false;
      ended();
      notify();
    });
  }

  get end(): number {
    return this.start + this.buf.length;
  }

  /** Output from `offset` on. An offset the terminal no longer has (too old, or from an earlier terminal) gets
   * everything kept, with reset. */
  chunk(offset: number): Chunk {
    const reset = !(this.start <= offset && offset <= this.end);
    const from = reset ? this.start : offset;
    return { id: this.id, data: this.buf.slice(from - this.start), next: this.end, reset, alive: this.alive,
      age: Math.round((Date.now() / 1000 - this.started) * 10) / 10, cols: this.cols, rows: this.rows }; // the size the program draws for
  }

  write(data: string): void {
    if (this.alive) this.proc.write(data);
  }

  /** Input from the owner's keyboard. Text (not the page's own replies to the program's queries, arrow keys or
   * Ctrl keys) counts as typing: agent-org then leaves the prompt alone. */
  typed(data: string): void {
    for (const c of data.replace(ESCAPES, '')) {
      if (c === '\r' || c === '\x03') { // Enter sends what you typed, Ctrl+C clears it
        this.unsent = false;
      } else if (c >= ' ') {
        this.lastInput = Date.now() / 1000;
        this.unsent = true; // text in its input line that you have not sent yet
      }
    }
    this.write(data);
  }

  resize(cols: number, rows: number): void {
    const c = Math.max(10, Math.min(Math.trunc(cols), 500));
    const r = Math.max(4, Math.min(Math.trunc(rows), 200)); // as small as a pane may be
    if (this.alive && (c !== this.cols || r !== this.rows)) {
      this.cols = c;
      this.rows = r;
      this.proc.resize(c, r);
    }
  }

  close(): void {
    try {
      if (this.alive) this.proc.kill();
    } catch {
      // already gone
    }
  }
}

/** The terminals of the open team, by role name. */
export class TerminalHost {
  private readonly terms = new Map<string, Terminal>();
  private waiters: (() => void)[] = [];
  private answeredAt = 0; // when readMany last answered with output
  // The size each pane last had: an agent starts at it, even after agent-org restarted (a program started at
  // another size and then resized can leave pieces of its old screen behind).
  private readonly sizesFile: string | null;
  private readonly sizes = new Map<string, [number, number]>();

  constructor(sizesFile: string | null = null) {
    this.sizesFile = sizesFile;
    try {
      const saved = sizesFile ? JSON.parse(readFileSync(sizesFile, 'utf8')) : {};
      for (const [k, v] of Object.entries(saved)) {
        const [c, r] = (v as unknown[]).map(Number);
        if (Number.isInteger(c) && Number.isInteger(r)) this.sizes.set(k, [c, r]);
      }
    } catch {
      // none saved yet
    }
  }

  private readonly notify = (): void => {
    const waiting = this.waiters;
    this.waiters = [];
    for (const wake of waiting) wake();
  };

  /** Start `argv` in a new terminal for `name`, closing the one it had. */
  open(name: string, argv: string[], cwd: string, title = '', color = '', env: Env = {}): Terminal {
    const [cols, rows] = this.sizes.get(name) ?? [120, 32];
    const term = new Terminal(argv, cwd, title || name, color, cols, rows, this.notify, env);
    const old = this.terms.get(name);
    this.terms.set(name, term);
    old?.close();
    this.notify();
    return term;
  }

  resize(name: string, cols: number, rows: number): void {
    const term = this.get(name);
    if (term === undefined) return;
    term.resize(cols, rows);
    const had = this.sizes.get(name);
    if (!had || had[0] !== term.cols || had[1] !== term.rows) {
      this.sizes.set(name, [term.cols, term.rows]);
      this.saveSizes();
    }
  }

  private saveSizes(): void {
    if (this.sizesFile === null) return;
    try {
      mkdirSync(path.dirname(this.sizesFile), { recursive: true });
      writeFileSync(this.sizesFile, JSON.stringify(Object.fromEntries(this.sizes)), 'utf8');
    } catch {
      // not remembered: the next start is resized once its pane reports
    }
  }

  get(name: string): Terminal | undefined {
    return this.terms.get(name);
  }

  /** New output of several terminals: `wants` maps a name to [terminal id, offset] the page has. Returns as
   * soon as any has something new (or is gone), else after `wait` seconds. */
  async readMany(wants: Record<string, [number, number]>, wait = 15, signal: AbortSignal | null = null): Promise<Record<string, Chunk | { none: true }>> {
    const deadline = Date.now() + wait * 1000;
    for (;;) {
      // Busy agents redraw many times a second: within GATHER_MS of the last answer, what more comes goes into one
      // answer (six busy terminals made about 100 a second). After a quiet spell the first output goes at once.
      const early = this.answeredAt + GATHER_MS - Date.now();
      if (early > 0 && !signal?.aborted) await new Promise((r) => setTimeout(r, early));
      const out: Record<string, Chunk | { none: true }> = {};
      for (const [name, [termId, offset]] of Object.entries(wants)) {
        const term = this.get(name);
        if (term === undefined) out[name] = { none: true };
        else if (termId !== term.id || offset !== term.end) out[name] = term.chunk(termId === term.id ? offset : -1);
      }
      if (Object.keys(out).length) {
        this.answeredAt = Date.now();
        return out;
      }
      const left = deadline - Date.now();
      if (left <= 0 || signal?.aborted) return {};
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, left);
        signal?.addEventListener('abort', done, { once: true });
        this.waiters.push(done);
      });
    }
  }

  close(name: string): boolean {
    const term = this.terms.get(name);
    this.terms.delete(name);
    term?.close();
    if (term !== undefined) this.notify();
    return term !== undefined;
  }

  /** Close every terminal; the promise resolves when their programs have ended (or after `wait` seconds). */
  closeAll(wait = 10): Promise<void> {
    const all = [...this.terms.values()];
    this.terms.clear();
    for (const term of all) term.close();
    this.notify();
    return Promise.race([Promise.all(all.map((t) => t.exited)).then(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, wait * 1000).unref())]);
  }

  items(): [string, Terminal][] {
    return [...this.terms.entries()];
  }

  listing(): Record<string, { id: number; alive: boolean; title: string; color: string }> {
    return dict(this.items().map(([n, t]) => [n, { id: t.id, alive: t.alive, title: t.title, color: t.color }] as const));
  }
}
