/**
 * Where each harness keeps its conversations, so a restarted team can resume them.
 *
 * - Claude Code: ~/.claude/projects/<folder>/<session id>.jsonl
 * - Codex:       ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<session id>.jsonl
 * - Grok:        ~/.grok/sessions/<folder>/<session id>/
 * - Antigravity: ~/.gemini/antigravity-cli/conversations/<session id>.db
 */

import { closeSync, globSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const UUID_RE = /^[0-9a-fA-F-]{8,64}$/;
export const RESUMABLE = ['claude', 'codex', 'grok', 'antigravity']; // harnesses whose conversations a start resumes
export const CAN_CHOOSE_ID = ['claude', 'grok']; // these accept an id for a new conversation; Codex picks its own
const SCAN_BYTES = 400_000; // how far into a conversation file to look for the role's first prompt
const SCAN_DAYS = 45; // how old a Codex conversation may be to still be found by searching
const LINE_PIECE = 64 * 1024; // a Codex conversation's first line is some 20 kB
const DAY_MS = 86_400_000;

/** The user's home folder (tests point it elsewhere). */
export const where = {
  home: (): string => os.homedir(),
  /** When a file was created (Windows keeps it; elsewhere the last change of its metadata). */
  born(file: string): number {
    const st = statSync(file);
    return (st.birthtimeMs || st.ctimeMs) / 1000;
  },
};

export function home(): string {
  return where.home();
}

/** Files under `folder` matching `pattern` (a glob with forward slashes), as full paths. */
export function glob(folder: string, pattern: string): string[] {
  try {
    return globSync(pattern, { cwd: folder }).map((p) => path.join(folder, p));
  } catch {
    return [];
  }
}

/** True if `harness` still has the conversation `sessionId` on disk. */
export function exists(harness: string, sessionId: string | null | undefined): boolean {
  if (!sessionId || !UUID_RE.test(sessionId)) return false;
  const h = home();
  if (harness === 'claude') return glob(path.join(h, '.claude', 'projects'), `*/${sessionId}.jsonl`).length > 0;
  if (harness === 'codex') return codexFile(sessionId) !== null;
  if (harness === 'grok') return glob(path.join(h, '.grok', 'sessions'), `*/${sessionId}`).some(isDir);
  if (harness === 'antigravity') return glob(path.join(h, '.gemini', 'antigravity-cli', 'conversations'), `${sessionId}.*`).length > 0;
  return false;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The first line of a file (up to `limit` bytes), read a piece at a time without loading the rest. */
export function firstLine(file: string, limit = 1_000_000): string {
  const fd = openSync(file, 'r');
  try {
    const pieces: Buffer[] = [];
    let size = 0;
    while (size < limit) {
      const buf = Buffer.alloc(Math.min(LINE_PIECE, limit - size));
      const n = readSync(fd, buf, 0, buf.length, size);
      if (n === 0) break;
      const end = buf.subarray(0, n).indexOf(10);
      pieces.push(buf.subarray(0, end >= 0 ? end : n));
      size += n;
      if (end >= 0) break;
    }
    return Buffer.concat(pieces).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Up to `bytes` from the start of a file, as text. */
export function readHead(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

type Meta = Record<string, unknown>;

/** The first record (session_meta) of a Codex conversation, or null if it is not on disk yet. */
export function codexMeta(sessionId: string): Meta | null {
  const file = codexFile(sessionId);
  if (file === null) return null;
  try {
    const meta = JSON.parse(firstLine(file)).payload;
    return typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta : null;
  } catch {
    return null;
  }
}

/** The file of Codex conversation `sessionId`, or null if it is not on disk (yet). Codex files it under the day it
 * began; the days are read newest first, and as Codex's ids (UUID v7) carry when they began, none before that.
 * (Globbing every day took 33 ms of each Codex hook's 86.) */
export function codexFile(sessionId: string): string | null {
  const suffix = `-${sessionId}.jsonl`;
  for (const [dir, names] of codexDays(uuidTime(sessionId) ?? 0)) {
    const name = names.find((n) => n.startsWith('rollout-') && n.endsWith(suffix));
    if (name !== undefined) return path.join(dir, name);
  }
  return null;
}

/** [folder, file names] of each day in ~/.codex/sessions/<yyyy>/<mm>/<dd>, newest first, back to the day of
 * `since` (ms since 1970; a day earlier, as a clock or time zone may differ). */
function* codexDays(since: number): Generator<[string, string[]]> {
  const root = path.join(home(), '.codex', 'sessions');
  const t = new Date(since - DAY_MS);
  const from = since ? `${t.getFullYear()}/${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')}` : '';
  const numbered = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const y of numbered(root)) {
    if (y < from.slice(0, 4)) return;
    for (const m of numbered(path.join(root, y))) {
      if (`${y}/${m}` < from.slice(0, 7)) break;
      for (const d of numbered(path.join(root, y, m))) {
        if (`${y}/${m}/${d}` < from) break;
        const dir = path.join(root, y, m, d);
        try {
          yield [dir, readdirSync(dir)];
        } catch {
          // gone meanwhile
        }
      }
    }
  }
}

/** When a UUID v7 was made (ms since 1970), or null for another kind of id. */
export function uuidTime(id: string): number | null {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-/i.exec(id);
  return m ? parseInt(m[1] + m[2], 16) : null;
}

/** A conversation Codex runs on the agent's behalf (its auto-review, a sub-agent), not the agent itself. */
export function isSubSession(meta: Meta): boolean {
  const source = meta.source;
  return Boolean(meta.parent_thread_id) || (typeof source === 'object' && source !== null && 'subagent' in source);
}

/** The agent's own conversation for `sessionId`. Codex runs helpers such as its auto-reviewer ("guardian") as
 * separate conversations in the same process; they fire the same hooks but have no tools. For one of those this
 * is the conversation it belongs to (null if that is unknown). A conversation not on disk yet is taken as it is;
 * resuming checks it again. */
export function mainSession(harness: string, sessionId: string): string | null {
  if (harness !== 'codex') return sessionId;
  const meta = codexMeta(sessionId);
  if (meta === null) return sessionId;
  if (isSubSession(meta)) {
    const parent = meta.parent_thread_id || meta.session_id;
    return parent && parent !== sessionId ? String(parent) : null;
  }
  return sessionId;
}

/** Text only a conversation started by agent-org for `role` contains: its kickoff prompts, or the line agent-org
 * types to wake it (an agent in the window starts with no prompt). */
export function markers(role: string): string[] {
  return [`You are the '${role}' agent in a team`, `you are back as '${role}'`, `agent-org: '${role}', `];
}

/** When a file was created. */
export function born(file: string): number {
  return where.born(file);
}

/** Python's urllib.parse.quote(text, safe=''): Grok names project folders this way. */
export function pyQuote(text: string): string {
  return Array.from(Buffer.from(text, 'utf8'))
    .map((b) => (/[A-Za-z0-9_.~-]/.test(String.fromCharCode(b)) && b < 128 ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`))
    .join('');
}

/** The id of the newest conversation `harness` had as `role` in this project, if any. Used when the hub has no id
 * on record: a team started before agent-org kept them, or a Codex agent whose hooks were not trusted yet. Only
 * conversations begun after `since` (when the team's hub was made) count: another team in the same folder may have
 * roles of the same names, and its conversations are not this team's. */
export function find(harness: string, projectRoot: string, role: string, since = 0): string | null {
  const wanted = markers(role);
  // Antigravity keeps every project's conversations together: also require this project's path.
  const places = harness === 'antigravity' ? [projectRoot, projectRoot.replace(/\\/g, '\\\\'), projectRoot.replace(/\\/g, '/')] : [];
  const found: [number, string, string][] = []; // [last change (ms), file, conversation id]
  for (const [file, sessionId] of candidates(harness, projectRoot, since)) {
    try {
      if (since && born(file) < since) continue;
      found.push([statSync(file).mtimeMs, file, sessionId]);
    } catch {
      continue;
    }
  }
  // Newest first, so the first that matches is the one; a fresh team (most of a harness's conversations older
  // than it) reads none.
  found.sort((a, b) => b[0] - a[0]);
  const cutoff = Date.now() - SCAN_DAYS * DAY_MS;
  for (const [mtime, file, known] of found) {
    if (harness === 'codex' && mtime < cutoff) break;
    let sessionId = known;
    let head: string;
    try {
      if (harness === 'codex') { // its id and folder are in its first record: only this project's are read further
        const meta: Meta = JSON.parse(firstLine(file)).payload ?? {};
        if (isSubSession(meta)) continue; // an auto-review quotes the agent's history, kickoff included
        if (String(meta.cwd ?? '').toLowerCase() !== projectRoot.toLowerCase() || !meta.id) continue;
        sessionId = String(meta.id);
      }
      head = readHead(file, SCAN_BYTES);
    } catch {
      continue;
    }
    if (wanted.some((m) => head.includes(m)) && (!places.length || places.some((p) => head.includes(p)))) return sessionId;
  }
  return null;
}

/** [file to search, conversation id ('' for Codex: it is inside the file)] for each conversation `harness` had in
 * the project, or for Codex, of any project since `since` (seconds since 1970). */
function* candidates(harness: string, projectRoot: string, since: number): Generator<[string, string]> {
  const h = home();
  if (harness === 'claude') {
    for (const file of glob(path.join(h, '.claude', 'projects', projectRoot.replace(/[^A-Za-z0-9]/g, '-')), '*.jsonl')) {
      yield [file, path.basename(file, '.jsonl')];
    }
  } else if (harness === 'grok') {
    for (const file of glob(path.join(h, '.grok', 'sessions', pyQuote(projectRoot)), '*/chat_history.jsonl')) {
      yield [file, path.basename(path.dirname(file))];
    }
  } else if (harness === 'antigravity') {
    for (const file of glob(path.join(h, '.gemini', 'antigravity-cli', 'conversations'), '*.*')) {
      yield [file, path.basename(file).replace(/\.[^.]*$/, '')];
    }
  } else if (harness === 'codex') {
    for (const [dir, names] of codexDays(since * 1000)) {
      for (const name of names) if (name.startsWith('rollout-') && name.endsWith('.jsonl')) yield [path.join(dir, name), ''];
    }
  }
}
