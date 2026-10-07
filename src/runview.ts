/**
 * Show a run of an agent program that works in print mode, as it happens.
 *
 * DeepSeek Harness (`dsh --profile headless --json`) and Antigravity (`agy -p ... --output-format stream-json`)
 * print only their final answer in plain print mode. With JSON output they write one event per line instead:
 * thinking, each tool call and its result, the text as it is written. Their start scripts pipe that through
 * this, so their terminal shows the agent at work like any other agent's. For DeepSeek, --session-file keeps
 * the run's session id, so the next run continues the same conversation.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const BLUE = '\x1b[38;5;69m';
export const RESULT_LINES = 4; // lines of a tool result shown

type Event = Record<string, any>;

const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value) ?? String(value));

export function short(value: unknown, limit = 160): string {
  const t = text(value).split(/\s+/).filter((w) => w).join(' ');
  return [...t].length <= limit ? t : `${[...t].slice(0, limit - 1).join('')}…`;
}

/** agent-org's tools read as org.<tool> whatever the program calls them. */
export function toolName(name: string): string {
  for (const prefix of ['mcp__org__', 'mcp_org_', 'org__', 'org_']) {
    if (name.startsWith(prefix)) return `org.${name.slice(prefix.length)}`;
  }
  return name;
}

export function callLine(name: string, args: unknown): string {
  let shown = name;
  let given = args;
  if (name === 'call_mcp_tool' && typeof args === 'object' && args !== null && (args as Event).ToolName) { // Antigravity's wrapper
    const a = args as Event;
    const server = String(a.ServerName ?? '');
    let inner = a.Arguments ?? {};
    if (typeof inner === 'string') {
      try {
        inner = JSON.parse(inner);
      } catch {
        // shown as it is
      }
    }
    shown = server.endsWith('org') ? `org.${a.ToolName}` : `${server}.${a.ToolName}`;
    given = inner;
  }
  if (typeof given === 'object' && given !== null && !Array.isArray(given)) {
    given = Object.entries(given).map(([k, v]) => `${k}=${short(v, 60)}`).join(', ');
  }
  return `${CYAN}● ${BOLD}${toolName(shown)}${RESET}${CYAN}(${short(given || '', 140)})${RESET}`;
}

export function resultLines(value: unknown, ok: boolean, status = ''): string[] {
  const lines = text(value).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) lines.push('(nothing)');
  const color = ok ? DIM : RED;
  const shown = lines.slice(0, RESULT_LINES).map((l) => `${color}  ⎿ ${short(l, 150)}${RESET}`);
  if (lines.length > RESULT_LINES) shown.push(`${DIM}    … ${lines.length - RESULT_LINES} more lines${RESET}`);
  if (!ok) shown[0] = `${RED}  ⎿ ${status || 'failed'}: ${short(lines[0], 140)}${RESET}`;
  return shown;
}

/** Turns events into terminal text; `session` is the conversation the run belongs to. */
export class View {
  session: string | null = null;
  midLine = false; // text is being streamed: the next line must start on a new one
  lastText = '';
  used: Record<string, number> = {}; // this run's token counts (DeepSeek reports them per step)
  /** Told of each tool call as it starts (with its name and input) and as it ends (without). */
  onTool: (name?: string, input?: unknown) => void = () => {};
  private readonly out: Writable;

  constructor(out: Writable) {
    this.out = out;
  }

  line(t = ''): void {
    if (this.midLine) {
      this.out.write('\n');
      this.midLine = false;
    }
    this.out.write(`${t}\n`);
  }

  stream(t: string): void {
    this.out.write(t);
    this.midLine = !t.endsWith('\n');
  }

  show(event: Event): void {
    if ('event' in event) this.antigravity(event);
    else this.deepseek(event);
  }

  // DeepSeek Harness: {"type": session | status | thinking | tool_call | tool_result | text | final | error}
  private deepseek(e: Event): void {
    const kind = e.type;
    if (kind === 'session') {
      this.session = e.sessionId ?? null; // kept for the next run, not shown
    } else if (kind === 'thinking') {
      for (const t of String(e.text ?? '').trim().split(/\r?\n/)) if (t.trim()) this.line(`${DIM}✻ ${t}${RESET}`);
    } else if (kind === 'tool_call') {
      this.line(callLine(String(e.tool ?? '?'), e.input));
      this.onTool(String(e.tool ?? '?'), e.input);
    } else if (kind === 'tool_result') {
      this.onTool();
      const ok = e.status == null || ['completed', 'ok', 'success'].includes(e.status);
      for (const t of resultLines(e.result ?? e.error ?? '', ok, String(e.status ?? ''))) this.line(t);
    } else if (kind === 'text' || kind === 'final') {
      const t = String(e.text ?? '').trim();
      if (t && !(kind === 'final' && t === this.lastText)) {
        this.line();
        for (const part of t.split(/\r?\n/)) this.line(part);
      }
      this.lastText = t || this.lastText;
    } else if (kind === 'error') {
      this.line(`${RED}✗ ${short(e.message || e.error || e, 300)}${RESET}`);
    } else if (kind === 'status') {
      const used = e.usage;
      if (e.phase === 'step_end' && typeof used === 'object' && used !== null) {
        const n = (k: string): number => Math.trunc(Number(used[k]) || 0);
        for (const [key, value] of [['in', n('inputTokens') + n('cacheWriteTokens')], ['cached', n('cacheReadTokens')],
          ['out', n('outputTokens')], ['steps', 1]] as [string, number][]) {
          this.used[key] = (this.used[key] ?? 0) + value;
        }
      }
    } else {
      this.line(`${DIM}· ${short(e, 200)}${RESET}`);
    }
  }

  // Antigravity: {"event": init | step_update | result, ...}
  private antigravity(e: Event): void {
    const kind = e.event;
    if (kind === 'init') {
      this.session = e.conversation_id ?? null;
      this.line(`${DIM}· conversation ${this.session}${RESET}`);
      return;
    }
    if (kind === 'result') {
      const body = e.result ?? {};
      if (String(body.status ?? 'SUCCESS').toUpperCase() !== 'SUCCESS') {
        this.line(`${RED}✗ ${body.status}: ${short(body.response || body.error || '', 300)}${RESET}`);
      } else if (this.midLine) {
        this.line();
      }
      return;
    }
    const step = typeof e[kind] === 'object' && e[kind] !== null ? e[kind] : {};
    const state = String(step.state ?? '').toUpperCase();
    const stepType = step.step_type;
    if (stepType === 'agent_response' && step.text_delta) {
      if (!this.midLine) this.line();
      this.stream(String(step.text_delta));
    } else if (stepType === 'tool') {
      const info = step.tool_info ?? {};
      if (state === 'ACTIVE') {
        this.line(callLine(String(step.tool_name || info.name || '?'), info.parameters));
        this.onTool(String(step.tool_name || info.name || '?'), info.parameters);
      } else if (['DONE', 'ERROR', 'FAILED', 'CANCELLED'].includes(state)) {
        this.onTool();
        for (const t of resultLines(info.output || info.error || 'done', state === 'DONE', state.toLowerCase())) this.line(t);
      }
    }
  }
}

const WHALE = ['   ▄▄▄▄▄▄   ', ' ▄█▀▀▀▀▀▀█▄▄', '▐█ ●     ▀▀█', ' ▀█▄▄▄▄▄▄█▀ '];

/** The heading an interactive program shows when it starts: what runs, with which model, where. */
export function banner(out: Writable, program: string, version: string, model: string, folder: string): void {
  const info = [`${BOLD}${BLUE}${program}${RESET} ${DIM}${version}${RESET}`, model, `${DIM}${folder}${RESET}`, ''];
  WHALE.forEach((art, i) => out.write(`${BLUE}${art}${RESET}  ${info[i]}\n`));
  out.write('\n');
}

const counted = new Map<string, Record<string, number>>(); // what this run already added, by session

/** Add this run's counts so far to the session's totals in `file` (written after every step, so a run that is
 * stopped keeps what it used). */
export function keepUsage(file: string, session: string, used: Record<string, number>): void {
  let kept: Record<string, any> = {};
  try {
    kept = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  } catch {
    kept = {};
  }
  if (typeof kept !== 'object' || kept === null || Array.isArray(kept)) kept = {};
  const totals: Record<string, number> = typeof kept[session] === 'object' && kept[session] !== null ? kept[session] : {};
  const before = counted.get(session) ?? {};
  for (const [key, value] of Object.entries(used)) totals[key] = Math.trunc(Number(totals[key]) || 0) + value - (before[key] ?? 0);
  counted.set(session, { ...used });
  kept[session] = totals;
  try {
    writeFileSync(file, JSON.stringify(kept), 'utf8');
  } catch {
    // not kept: the next step writes it again
  }
}

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[] = process.argv.slice(2), input: Readable = process.stdin,
  out: Writable = process.stdout): Promise<number> {
  const at = argv.indexOf('--banner');
  if (at >= 0) {
    const [program = '', version = '', model = '', folder = ''] = argv.slice(at + 1, at + 5);
    banner(out, program, version, model, folder);
    return 0;
  }
  const sessionFile = option(argv, '--session-file');
  const usageFile = option(argv, '--usage-file');
  const view = new View(out);
  const record = await recorder(option(argv, '--team'), option(argv, '--role'));
  if (record !== null) view.onTool = record.tool;
  for await (const raw of createInterface({ input, crlfDelay: Infinity })) {
    const line = raw.trim();
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      view.line(line); // not an event (a warning, say): show it as it is
      continue;
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) continue;
    const [before, steps] = [view.session, view.used.steps ?? 0];
    view.show(event as Event);
    if (sessionFile && view.session && view.session !== before) writeFileSync(sessionFile, view.session, 'utf8');
    if (usageFile && view.session && (view.used.steps ?? 0) !== steps) keepUsage(usageFile, view.session, view.used);
  }
  if (view.midLine) out.write('\n');
  record?.end();
  return 0;
}

/** What a run does, noted in its team's hub as the hooks note other agents' tool calls, for the owner's page.
 * Null without a team and role, or if the hub cannot be opened: the run shows as before. */
async function recorder(teamFile: string | undefined, role: string | undefined): Promise<{ tool: View['onTool']; end(): void } | null> {
  if (!teamFile || !role) return null;
  try {
    const [{ Hub }, { describeAction }] = await Promise.all([import('./hub.ts'), import('./hooks.ts')]);
    const hub = Hub.open(teamFile);
    const root = hub.rootOf(role);
    const running: string[] = []; // calls started and not ended, oldest first
    const safely = (f: () => void): void => {
      try {
        f();
      } catch {
        // only the page misses it
      }
    };
    return {
      tool: (name, input) => safely(() => {
        if (name === undefined) {
          const what = running.shift();
          if (what !== undefined) hub.store.noteAction(role, what, false);
          return;
        }
        const what = describeAction({ tool_name: name, tool_input: input ?? {} }, root);
        if (what === null) return;
        running.push(what);
        hub.store.noteAction(role, what, true);
      }),
      end: () => safely(() => {
        hub.store.endActions(role); // the run is over: nothing of it still runs
        hub.close();
      }),
    };
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.filename === (await import('node:path')).resolve(process.argv[1])) {
  (await import('node:module')).default.enableCompileCache?.();
  process.exitCode = await main();
}
