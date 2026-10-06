/**
 * Where each harness keeps its conversations, so a restarted team can resume them.
 *
 * - Claude Code: ~/.claude/projects/<folder>/<session id>.jsonl
 * - Codex:       ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<session id>.jsonl
 * - Grok:        ~/.grok/sessions/<folder>/<session id>/
 * - Antigravity: ~/.gemini/antigravity-cli/conversations/<session id>.db
 */

import { closeSync, globSync, openSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const UUID_RE = /^[0-9a-fA-F-]{8,64}$/;
export const RESUMABLE = ['claude', 'codex', 'grok', 'antigravity']; // harnesses whose conversations a start resumes
export const CAN_CHOOSE_ID = ['claude', 'grok']; // these accept an id for a new conversation; Codex picks its own
const SCAN_BYTES = 400_000; // how far into a conversation file to look for the role's first prompt
const SCAN_DAYS = 45; // how old a Codex conversation may be to still be found by searching

/** The user's home folder (tests point it elsewhere). */
export const where = { home: (): string => os.homedir() };

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
  if (harness === 'codex') return glob(path.join(h, '.codex', 'sessions'), `*/*/*/rollout-*-${sessionId}.jsonl`).length > 0;
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

/** The first line of a file, read without loading the rest. */
export function firstLine(file: string, limit = 1_000_000): string {
  return readHead(file, limit).split('\n', 1)[0];
}

/** Up to `bytes` from the start of a file, as text. */
export function readHead(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

type Meta = Record<string, unknown>;

/** The first record (session_meta) of a Codex conversation, or null if it is not on disk yet. */
export function codexMeta(sessionId: string): Meta | null {
  for (const file of glob(path.join(home(), '.codex', 'sessions'), `*/*/*/rollout-*-${sessionId}.jsonl`)) {
    try {
      const meta = JSON.parse(firstLine(file)).payload;
      return typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta : null;
    } catch {
      return null;
    }
  }
  return null;
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

/** When a file was created (Windows keeps it; elsewhere the last change of its metadata). */
export function born(file: string): number {
  const st = statSync(file);
  return (st.birthtimeMs || st.ctimeMs) / 1000;
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
  let best: [number, string] | null = null;
  for (const [file, sessionId] of candidates(harness, projectRoot)) {
    let head: string;
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs / 1000;
      if (best && mtime <= best[0]) continue;
      if (since && born(file) < since) continue;
      head = readHead(file, SCAN_BYTES);
    } catch {
      continue;
    }
    if (wanted.some((m) => head.includes(m)) && (!places.length || places.some((p) => head.includes(p)))) best = [mtime, sessionId];
  }
  return best ? best[1] : null;
}

/** [file to search, conversation id] for each conversation `harness` had in the project. */
function* candidates(harness: string, projectRoot: string): Generator<[string, string]> {
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
    const cutoff = Date.now() / 1000 - SCAN_DAYS * 86400;
    for (const file of glob(path.join(h, '.codex', 'sessions'), '*/*/*/rollout-*.jsonl')) {
      let meta: Meta;
      try {
        if (statSync(file).mtimeMs / 1000 < cutoff) continue;
        meta = JSON.parse(firstLine(file)).payload ?? {};
      } catch {
        continue;
      }
      if (isSubSession(meta)) continue; // an auto-review quotes the agent's history, kickoff included
      if (String(meta.cwd ?? '').toLowerCase() === projectRoot.toLowerCase() && meta.id) yield [file, String(meta.id)];
    }
  }
}
