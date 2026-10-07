/**
 * How much each agent's conversation has used, read from the harness's own session files.
 *
 * - Claude Code: token counts on every reply (deduplicated by message id).
 * - Codex: the running total, and - when the provider reports them - how much of each subscription limit
 *   window is used.
 * - Grok: each finished turn's counts, from the conversation's updates.jsonl.
 * - Antigravity: each model call's counts, in its conversation's database (protobuf records).
 * - DeepSeek Harness: each step's counts from its JSON events, which runview keeps in the role's launch folder
 *   (its own session files are compressed).
 *
 * `total` adds up every conversation a role has had, so an agent's cost survives a fresh start.
 *
 * `stuck` tells whether a conversation's last turn ended on an API error - most often the subscription's usage
 * limit, with the time it resets - so the team can move the work elsewhere and wake the agent once it can work.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as sessions from './sessions.ts';
import { dict } from './dict.ts';

export interface Usage {
  tokens_in: number; // fresh input tokens (including what was written to the cache)
  tokens_cached: number; // input tokens read from the cache (much cheaper)
  tokens_out: number;
  messages: number;
  model: string;
  limits: string[]; // e.g. "5h limit: 23% used"
}

export const emptyUsage = (): Usage => ({ tokens_in: 0, tokens_cached: 0, tokens_out: 0, messages: 0, model: '', limits: [] });

const cache = new Map<string, [string, Usage]>();
export const paths = new Map<string, string>(); // where a conversation's file was found (the search is slow)

export function sessionFile(harness: string, sessionId: string | null | undefined): string | null {
  if (!sessionId || !sessions.UUID_RE.test(sessionId)) return null;
  const key = `${sessions.home()}\u0000${harness}\u0000${sessionId}`;
  const known = paths.get(key);
  if (known !== undefined && existsSync(known)) return known;
  const found = findFile(harness, sessionId);
  if (found !== null) paths.set(key, found);
  return found;
}

function findFile(harness: string, sessionId: string): string | null {
  if (harness === 'codex') return sessions.codexFile(sessionId);
  const h = sessions.home();
  const patterns: Record<string, [string, string]> = dict({
    claude: [path.join(h, '.claude', 'projects'), `*/${sessionId}.jsonl`],
    grok: [path.join(h, '.grok', 'sessions'), `*/${sessionId}/summary.json`],
    antigravity: [path.join(h, '.gemini', 'antigravity-cli', 'conversations'), `${sessionId}.db`],
  });
  const spec = patterns[harness];
  if (spec === undefined) return null;
  return sessions.glob(spec[0], spec[1])[0] ?? null;
}

const READERS: Record<string, (file: string) => Usage> = dict({ claude: readClaude, codex: readCodex, grok: readGrok, antigravity: readAntigravity });

/** The conversation's usage so far, or null if its file can't be found. Cached per file version. */
export function usage(harness: string, sessionId: string | null | undefined): Usage | null {
  const file = sessionFile(harness, sessionId);
  const reader = READERS[harness];
  if (file === null || reader === undefined) return null;
  let v: string;
  try {
    v = version(file);
  } catch {
    return null;
  }
  const cached = cache.get(file);
  if (cached && cached[0] === v) return cached[1];
  let result: Usage;
  try {
    result = reader(file);
  } catch {
    return null;
  }
  cache.set(file, [v, result]);
  return result;
}

/** Forget what was read (tests change files within one clock tick). */
export function clearCaches(): void {
  cache.clear();
  grown.clear();
  paths.clear();
  stuckCache.clear();
}

/** What changes when the file does. A database's new rows sit in its -wal file until they are checkpointed into
 * it (seen: an Antigravity agent's count stayed at 0 for its whole task); a Grok conversation's counts are in its
 * updates.jsonl. */
function version(file: string): string {
  const st = statSync(file);
  const side = file.endsWith('.db') ? `${file}-wal` : path.basename(file) === 'summary.json' ? path.join(path.dirname(file), GROK_UPDATES) : null;
  let extra = '';
  if (side !== null && existsSync(side)) {
    const s = statSync(side);
    extra = `|${s.mtimeMs}|${s.size}`;
  }
  return `${st.mtimeMs}|${st.size}${extra}`;
}

type Json = Record<string, unknown>;
const obj = (x: unknown): Json => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Json) : {});
const int = (x: unknown): number => Math.trunc(Number(x) || 0);

// A conversation log only grows while its agent works (a long one: 60 MB, about 250 ms to read whole), and the page
// asks for every agent's usage every second or two. So each log is read a piece at a time: where the last read
// stopped, and what it had counted, are kept; a log that shrank or whose start changed was replaced: read anew.
interface Grown<S> { head: string; offset: number; state: S }
const grown = new Map<string, Grown<unknown>>();
const HEAD_BYTES = 256;

function readGrowing<S>(file: string, start: () => S, take: (state: S, line: string) => void): S {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const headBuf = Buffer.alloc(Math.min(HEAD_BYTES, size));
    readSync(fd, headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString('latin1');
    let kept = grown.get(file) as Grown<S> | undefined;
    const n = Math.min(head.length, kept?.head.length ?? 0);
    if (kept === undefined || size < kept.offset || head.slice(0, n) !== kept.head.slice(0, n)) {
      kept = { head, offset: 0, state: start() };
    }
    if (size > kept.offset) {
      const added = Buffer.alloc(size - kept.offset);
      const got = readSync(fd, added, 0, added.length, kept.offset);
      const end = added.subarray(0, got).lastIndexOf(0x0a) + 1; // whole lines only: the last one may be half written
      if (end > 0) {
        for (const line of added.subarray(0, end).toString('utf8').split('\n')) take(kept.state, line);
        kept.offset += end;
      }
    }
    kept.head = head;
    grown.set(file, kept as Grown<unknown>);
    return kept.state;
  } finally {
    closeSync(fd);
  }
}

interface ClaudeCount { u: Usage; seen: Set<unknown> }

function readClaude(file: string): Usage {
  const count = readGrowing<ClaudeCount>(file, () => ({ u: emptyUsage(), seen: new Set() }), ({ u, seen }, line) => {
    if (!line.includes('"usage"')) return;
    let message: Json;
    try {
      message = obj(JSON.parse(line).message);
    } catch {
      return;
    }
    const t = message.usage;
    if (typeof t !== 'object' || t === null) return;
    const key = message.id || seen.size;
    if (seen.has(key)) return; // one reply is written in several records with the same usage
    seen.add(key);
    const counts = obj(t);
    u.tokens_in += int(counts.input_tokens) + int(counts.cache_creation_input_tokens);
    u.tokens_cached += int(counts.cache_read_input_tokens);
    u.tokens_out += int(counts.output_tokens);
    u.model = (message.model as string) || u.model;
  });
  return { ...count.u, messages: count.seen.size, limits: [...count.u.limits] };
}

interface CodexCount { last: Json | null; messages: number; model: string }

function readCodex(file: string): Usage {
  const count = readGrowing<CodexCount>(file, () => ({ last: null, messages: 0, model: '' }), (c, line) => {
    if (!line.includes('"token_count"') && !line.includes('"turn_context"')) return;
    let record: Json;
    try {
      record = obj(JSON.parse(line));
    } catch {
      return;
    }
    const payload = obj(record.payload);
    if (payload.type === 'token_count') {
      c.last = payload;
      c.messages += 1;
    } else if (record.type === 'turn_context') {
      c.model = (payload.model as string) || c.model;
    }
  });
  const u = emptyUsage();
  u.messages = count.messages;
  u.model = count.model;
  const last = count.last;
  if (last) {
    const total = obj(obj(last.info).total_token_usage);
    const cached = int(total.cached_input_tokens);
    u.tokens_in = int(total.input_tokens) - cached;
    u.tokens_cached = cached;
    u.tokens_out = int(total.output_tokens) + int(total.reasoning_output_tokens);
    for (const name of ['primary', 'secondary']) {
      const window = obj(last.rate_limits)[name];
      if (typeof window !== 'object' || window === null) continue;
      const w = obj(window);
      if (w.used_percent === null || w.used_percent === undefined) continue;
      const minutes = int(w.window_minutes);
      const label = minutes && minutes % 60 === 0 && minutes < 1440 ? `${minutes / 60}h`
        : minutes && minutes % 1440 === 0 ? `${minutes / 1440}d` : 'limit';
      u.limits.push(`${label} limit: ${Math.round(Number(w.used_percent))}% used`);
    }
  }
  return u;
}

export const GROK_UPDATES = 'updates.jsonl';

/** Grok writes each finished turn's usage into the conversation's updates.jsonl (a turn_completed update: its
 * input includes what was read from the cache, its output the reasoning). A turn still running is counted when it
 * ends. Without any yet, the number of messages. */
/** Each line of a text file. */
function lines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n');
}

function readGrok(file: string): Usage {
  const summary = obj(JSON.parse(readFileSync(file, 'utf8')));
  const u = emptyUsage();
  u.model = (summary.current_model_id as string) || '';
  const updates = path.join(path.dirname(file), GROK_UPDATES);
  if (existsSync(updates)) {
    for (const line of lines(updates)) {
      if (!line.includes('"turn_completed"')) continue;
      let turn: Json;
      try {
        turn = obj(obj(obj(JSON.parse(line)).params).update);
      } catch {
        continue;
      }
      if (turn.sessionUpdate !== 'turn_completed' || typeof turn.usage !== 'object' || turn.usage === null) continue;
      const used = obj(turn.usage);
      const cached = int(used.cachedReadTokens);
      u.tokens_cached += cached;
      u.tokens_in += Math.max(0, int(used.inputTokens) - cached);
      u.tokens_out += int(used.outputTokens);
      u.messages += int(used.modelCalls);
    }
  }
  if (!(u.tokens_in || u.tokens_cached || u.tokens_out)) u.messages = int(summary.num_chat_messages);
  return u;
}

/** One gen_metadata row per model call. In its record, field 1 holds field 4 (that call's usage: 2 input, 3 output
 * with thinking, 5 cache reads) and field 19 (the model). Matched against the usage `agy -p --output-format
 * stream-json` reports for the same call. */
function readAntigravity(file: string): Usage {
  const u = emptyUsage();
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  let rows: { data: Uint8Array | null }[];
  try {
    rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx').all() as { data: Uint8Array | null }[];
  } finally {
    db.close();
  }
  for (const { data } of rows) {
    const call = field(proto(data ?? new Uint8Array()), 1);
    const fields = call instanceof Uint8Array ? proto(call) : [];
    const countsRaw = field(fields, 4);
    const counts = countsRaw instanceof Uint8Array ? proto(countsRaw) : [];
    u.tokens_in += Number(field(counts, 2) ?? 0);
    u.tokens_out += Number(field(counts, 3) ?? 0);
    u.tokens_cached += Number(field(counts, 5) ?? 0);
    const model = field(fields, 19);
    if (model instanceof Uint8Array) u.model = Buffer.from(model).toString('utf8');
    u.messages += 1;
  }
  return u;
}

type ProtoField = [number, number | Uint8Array];

/** The top-level fields of a protobuf message: [number, int or bytes]. [] if it is not one. */
export function proto(data: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let i = 0;
  const varint = (): number => {
    let n = 0;
    let shift = 0;
    for (;;) {
      if (i >= data.length) throw new RangeError('truncated');
      const c = data[i];
      i += 1;
      n += (c & 0x7f) * 2 ** shift;
      shift += 7;
      if (c < 0x80) return n;
    }
  };
  try {
    while (i < data.length) {
      const key = varint();
      const number = Math.floor(key / 8);
      const wire = key % 8;
      if (wire === 0) {
        out.push([number, varint()]);
      } else if (wire === 2) {
        const n = varint();
        if (i + n > data.length) return [];
        out.push([number, data.subarray(i, i + n)]);
        i += n;
      } else if (wire === 1 || wire === 5) {
        i += wire === 1 ? 8 : 4;
      } else {
        return [];
      }
    }
  } catch {
    return [];
  }
  return out;
}

function field(fields: ProtoField[], number: number): number | Uint8Array | null {
  return fields.find(([n]) => n === number)?.[1] ?? null;
}

export const DSH_USAGE = 'dsh.usage.json'; // in a DeepSeek role's launch folder: {session id: counts}, kept by runview

/** A DeepSeek role's usage, every conversation in its launch folder's usage file. */
export function deepseek(file: string): Usage {
  const u = emptyUsage();
  let kept: unknown;
  try {
    kept = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return u;
  }
  for (const counts of Object.values(obj(kept))) {
    const c = obj(counts);
    u.tokens_in += int(c.in);
    u.tokens_cached += int(c.cached);
    u.tokens_out += int(c.out);
    u.messages += int(c.steps);
  }
  return u;
}

/** Several conversations' usage as one (the model and limits of the last that has them). */
export function total(parts: Usage[]): Usage {
  const u = emptyUsage();
  for (const part of parts) {
    u.tokens_in += part.tokens_in;
    u.tokens_cached += part.tokens_cached;
    u.tokens_out += part.tokens_out;
    u.messages += part.messages;
    u.model = part.model || u.model;
    u.limits = part.limits.length ? part.limits : u.limits;
  }
  return u;
}

// why an agent stopped working

const TAIL = 256 * 1024; // bytes read from the end of a session file
const SESSION_WINDOW = 5 * 3600; // a usage limit whose reset time is not given lasts at most this long
const LIMIT_TEXT = /hit your .{0,40}limit|usage limit|limit (?:reached|exceeded)/i;
const RESETS = /resets?\s+(?:at\s+)?(?:(?<mon>[A-Z][a-z]{2,8})\s+(?<day>\d{1,2}),?\s+(?:at\s+)?)?(?<h>\d{1,2})(?::(?<m>\d{2}))?\s*(?<ap>[ap]m)(?:\s*\((?<tz>[^)]+)\))?/i;
const TRY_IN = /try again in\s+((?:\d+\s*(?:days?|hours?|minutes?|mins?|seconds?|secs?)[\s,and]*)+)/i;

export interface Stuck {
  kind: string; // "limit": the subscription's usage limit; "error": another API failure
  text: string; // what the harness said
  at: number; // when it happened
  until: number | null; // when a limit resets (null for other errors)
}

const stuckCache = new Map<string, [string, Stuck | null]>();

/** Why the conversation's last turn ended on an error, or null if it did not. An agent in this state sits at its
 * prompt: it makes no more calls, so its hooks never run and nothing wakes it until it is restarted. */
export function stuck(harness: string, sessionId: string | null | undefined): Stuck | null {
  return check.stuck(harness, sessionId);
}

/** Where `stuck` looks (tests put a stand-in here). */
export const check = { stuck: readStuck };

function readStuck(harness: string, sessionId: string | null | undefined): Stuck | null {
  const file = sessionFile(harness, sessionId);
  const reader = harness === 'claude' ? claudeStuck : harness === 'codex' ? codexStuck : null;
  if (file === null || reader === null) return null;
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  const v = `${st.mtimeMs}|${st.size}`;
  const cached = stuckCache.get(file);
  if (cached && cached[0] === v) return cached[1];
  let result: Stuck | null;
  try {
    result = reader(tail(file, st.size));
  } catch {
    return null;
  }
  stuckCache.set(file, [v, result]);
  return result;
}

/** The records at the end of a JSON-lines file, newest first. */
function tail(file: string, size: number): Json[] {
  const fd = openSync(file, 'r');
  let text: string;
  try {
    const start = Math.max(0, size - TAIL);
    const buf = Buffer.alloc(size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    text = buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
  let rows = text.split(/\r?\n/);
  if (size > TAIL) rows = rows.slice(1); // the first line was cut in the middle
  const records: Json[] = [];
  for (const line of rows.reverse()) {
    try {
      const r = JSON.parse(line);
      if (typeof r === 'object' && r !== null && !Array.isArray(r)) records.push(r);
    } catch {
      // not a record
    }
  }
  return records;
}

function when(record: Json): number {
  const t = Date.parse(String(record.timestamp));
  return Number.isNaN(t) ? Date.now() / 1000 : t / 1000;
}

// Wall-clock times in a named zone, with the zone data every JavaScript engine carries.

function zoneOk(name: string | undefined): boolean {
  if (!name) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number }

function wall(epochMs: number, zone: string | undefined): Wall {
  if (!zone) {
    const t = new Date(epochMs);
    return { y: t.getFullYear(), mo: t.getMonth() + 1, d: t.getDate(), h: t.getHours(), mi: t.getMinutes(), s: t.getSeconds() };
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]));
  return { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour % 24, mi: +parts.minute, s: +parts.second };
}

/** The moment whose wall-clock time in `zone` is `w` (local time when `zone` is undefined). */
function fromWall(w: Wall, zone: string | undefined): number {
  if (!zone) return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime();
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  let guess = asUtc;
  for (let i = 0; i < 3; i += 1) {
    const seen = wall(guess, zone);
    const diff = Date.UTC(seen.y, seen.mo - 1, seen.d, seen.h, seen.mi, seen.s) - asUtc;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** When a limit resets, from the harness's words ("resets 7:20pm (Asia/Singapore)", "try again in 2 hours"). */
export function resetTime(text: string, at: number): number | null {
  const tryIn = TRY_IN.exec(text);
  if (tryIn) {
    let seconds = 0;
    for (const m of tryIn[1].matchAll(/(\d+)\s*([a-z]+)/gi)) {
      seconds += Number(m[1]) * ({ d: 86400, h: 3600, m: 60, s: 1 } as Record<string, number>)[m[2][0].toLowerCase()];
    }
    return at + seconds;
  }
  const m = RESETS.exec(text);
  if (!m?.groups) return null;
  const g = m.groups;
  const zone = zoneOk(g.tz) ? g.tz : undefined;
  const base = wall(at * 1000, zone);
  const moment: Wall = { ...base, h: (Number(g.h) % 12) + (g.ap.toLowerCase() === 'pm' ? 12 : 0), mi: Number(g.m ?? 0), s: 0 };
  const baseMs = fromWall({ ...base }, zone);
  if (g.mon) {
    const month = MONTH_NAMES.indexOf(g.mon.slice(0, 3).toLowerCase());
    if (month < 0) return null;
    moment.mo = month + 1;
    moment.d = Number(g.day);
    if (fromWall(moment, zone) < baseMs) moment.y += 1;
    return fromWall(moment, zone) / 1000;
  }
  let result = fromWall(moment, zone);
  if (result <= baseMs) {
    const next = new Date(Date.UTC(moment.y, moment.mo - 1, moment.d + 1));
    result = fromWall({ ...moment, y: next.getUTCFullYear(), mo: next.getUTCMonth() + 1, d: next.getUTCDate() }, zone);
  }
  return result / 1000;
}

function claudeStuck(records: Json[]): Stuck | null {
  for (const record of records) {
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    if (record.type === 'user' || !record.isApiErrorMessage) return null; // the last turn went through, or a new one started
    const content = obj(record.message).content;
    const text = (Array.isArray(content) ? content : []).filter((c) => typeof c === 'object' && c !== null)
      .map((c) => String(obj(c).text ?? '')).join(' ').trim();
    const at = when(record);
    if (LIMIT_TEXT.test(text)) {
      const fallback = at + (text.toLowerCase().includes('week') ? 7 * 86400 : SESSION_WINDOW);
      return { kind: 'limit', text, at, until: resetTime(text, at) ?? fallback };
    }
    return { kind: 'error', text: text || String(record.error || 'API error'), at, until: null };
  }
  return null;
}

function codexStuck(records: Json[]): Stuck | null {
  for (const record of records) {
    const payload = obj(record.payload);
    const kind = payload.type;
    if (record.type === 'response_item' || ['agent_message', 'user_message', 'task_started'].includes(kind as string)) return null;
    if (kind === 'error') {
      const text = String(payload.message || 'error');
      const at = when(record);
      if (LIMIT_TEXT.test(text)) return { kind: 'limit', text, at, until: resetTime(text, at) ?? at + SESSION_WINDOW };
      return { kind: 'error', text, at, until: null };
    }
    if (kind === 'token_count') {
      const limits = obj(payload.rate_limits);
      const at = when(record);
      const ends: number[] = [];
      for (const name of ['primary', 'secondary']) {
        const window = limits[name];
        if (typeof window === 'object' && window !== null && Number(obj(window).used_percent || 0) >= 100) ends.push(windowEnd(obj(window), at));
      }
      if (limits.rate_limit_reached_type && !ends.length) ends.push(at + SESSION_WINDOW);
      if (!ends.length) return null;
      const reached = limits.rate_limit_reached_type || 'a limit window is full';
      return { kind: 'limit', text: `usage limit reached (${reached})`, at, until: Math.max(...ends) };
    }
  }
  return null;
}

function windowEnd(window: Json, at: number): number {
  const resets = window.resets_at;
  if (typeof resets === 'number') return resets;
  if (typeof resets === 'string') {
    const t = Date.parse(resets);
    if (!Number.isNaN(t)) return t / 1000;
  }
  if (typeof window.resets_in_seconds === 'number') return at + window.resets_in_seconds;
  return at + 60 * Number(window.window_minutes || SESSION_WINDOW / 60);
}
