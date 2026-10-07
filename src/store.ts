/**
 * SQLite state shared by every agent's hub connection.
 *
 * Each harness starts its own hub process, so they all meet in one database file. WAL mode lets them
 * read concurrently, and writes that must not interleave (taking a lock, draining an inbox) run inside
 * BEGIN IMMEDIATE transactions. A database made by an earlier version is upgraded in place when opened.
 * Times are seconds since the epoch (as the Python version wrote them), so old databases still read.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fnmatchcase } from './fnmatch.ts';
import { CONSULTANT_PREFIX } from './team.ts';
import { dict } from './dict.ts';

export const LEASE = 3600; // seconds a file lock lasts without the holder doing anything (renewed by its activity)

// Task states, after the A2A task lifecycle.
export const ACTIVE = ['waiting', 'open', 'working', 'blocked'] as const; // the assignee still owes work
export const REVIEW = ['done'] as const; // the assigner owes a review
export const CLOSED = ['accepted', 'failed', 'rejected', 'cancelled'] as const;

/** Seconds since the epoch, as a float. */
export const now = (): number => Date.now() / 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at   REAL NOT NULL,
    sender    TEXT NOT NULL,
    recipient TEXT NOT NULL,
    kind      TEXT NOT NULL,
    text      TEXT NOT NULL,
    reply_to  INTEGER REFERENCES messages(id),
    read_at   REAL,
    urgent    INTEGER NOT NULL DEFAULT 0,
    task_id   INTEGER
);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages(recipient, read_at);

CREATE TABLE IF NOT EXISTS status (
    role       TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    task       TEXT NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS locks (
    key        TEXT PRIMARY KEY,               -- normalised path, or a pattern such as src/api/*
    path       TEXT NOT NULL,
    owner      TEXT NOT NULL,
    claimed_at REAL NOT NULL,
    expires_at REAL,
    reason     TEXT NOT NULL DEFAULT '',
    pattern    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS presence (
    pid        INTEGER PRIMARY KEY,
    role       TEXT NOT NULL,
    started_at REAL NOT NULL,
    last_seen  REAL NOT NULL,
    ppid       INTEGER
);

CREATE TABLE IF NOT EXISTS activity (
    role TEXT PRIMARY KEY,
    at   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS notices (
    role    TEXT PRIMARY KEY,
    last_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    role        TEXT PRIMARY KEY,
    harness     TEXT NOT NULL,
    session_id  TEXT,
    launched_at REAL NOT NULL,
    updated_at  REAL NOT NULL
);

-- every conversation a role has had (sessions keeps only the current one): its usage adds up over them
CREATE TABLE IF NOT EXISTS conversations (
    role        TEXT NOT NULL,
    harness     TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    PRIMARY KEY (role, harness, session_id)
);
INSERT OR IGNORE INTO conversations (role, harness, session_id)
    SELECT role, harness, session_id FROM sessions WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notes (
    role       TEXT PRIMARY KEY,
    text       TEXT NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    assigner   TEXT NOT NULL,
    assignee   TEXT NOT NULL,
    title      TEXT NOT NULL,
    details    TEXT NOT NULL,
    state      TEXT NOT NULL,
    message_id INTEGER REFERENCES messages(id),
    parent_id  INTEGER REFERENCES tasks(id),
    result     TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    done_when  TEXT NOT NULL DEFAULT '',
    priority   INTEGER NOT NULL DEFAULT 2,
    depends_on TEXT NOT NULL DEFAULT '',       -- ",3,5," : ids of tasks that must finish first
    revisions  INTEGER NOT NULL DEFAULT 0,
    nudged_at  REAL,
    started_at REAL,
    checks     TEXT NOT NULL DEFAULT '',
    commit_id  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee, state);

CREATE TABLE IF NOT EXISTS task_files (
    task_id INTEGER NOT NULL,
    path    TEXT NOT NULL,
    at      REAL NOT NULL,
    PRIMARY KEY (task_id, path)
);

CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      REAL NOT NULL,
    kind    TEXT NOT NULL,
    role    TEXT NOT NULL,
    text    TEXT NOT NULL,
    task_id INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consultants (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tier         TEXT NOT NULL,
    harness      TEXT NOT NULL,
    model        TEXT,
    effort       TEXT,
    helped       TEXT NOT NULL,
    summoned_by  TEXT NOT NULL,
    help_id      INTEGER NOT NULL REFERENCES messages(id),
    brief        TEXT NOT NULL,
    created_at   REAL NOT NULL,
    dismissed_at REAL,
    dismissed_by TEXT
);
`;

// Columns added since the first version: added to older databases on open.
const UPGRADES: Record<string, Record<string, string>> = {
  messages: { urgent: 'INTEGER NOT NULL DEFAULT 0', task_id: 'INTEGER' },
  presence: { ppid: 'INTEGER' },
  locks: { expires_at: 'REAL', reason: "TEXT NOT NULL DEFAULT ''", pattern: 'INTEGER NOT NULL DEFAULT 0' },
  tasks: {
    done_when: "TEXT NOT NULL DEFAULT ''", priority: 'INTEGER NOT NULL DEFAULT 2',
    depends_on: "TEXT NOT NULL DEFAULT ''", revisions: 'INTEGER NOT NULL DEFAULT 0',
    nudged_at: 'REAL', started_at: 'REAL', checks: "TEXT NOT NULL DEFAULT ''", commit_id: "TEXT NOT NULL DEFAULT ''",
  },
};

export interface Message {
  readonly id: number;
  readonly sent_at: number;
  readonly sender: string;
  readonly recipient: string;
  readonly kind: string;
  readonly text: string;
  readonly reply_to: number | null;
  readonly read_at: number | null;
  readonly urgent: boolean;
  readonly task_id: number | null;
}

export interface Task {
  readonly id: number;
  readonly assigner: string;
  readonly assignee: string;
  readonly title: string;
  readonly details: string;
  readonly state: string; // see ACTIVE, REVIEW, CLOSED
  readonly message_id: number | null;
  readonly parent_id: number | null;
  readonly result: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly done_when: string;
  readonly priority: number; // 1 urgent, 2 normal, 3 low
  readonly depends_on: readonly number[];
  readonly revisions: number;
  readonly nudged_at: number | null;
  readonly started_at: number | null;
  readonly checks: string; // what the verification checks said when it was finished
  readonly commit_id: string; // the git commit made when it was accepted
}

/** Not finished yet: the assignee owes work, or the assigner owes a review. */
export const isOpen = (t: Task): boolean => !(CLOSED as readonly string[]).includes(t.state);
export const owesWork = (t: Task): boolean => (ACTIVE as readonly string[]).includes(t.state);

export interface Status {
  readonly role: string;
  readonly state: string;
  readonly task: string;
  readonly updated_at: number;
}

export interface Lock {
  readonly path: string;
  readonly owner: string;
  readonly claimed_at: number;
  readonly expires_at: number | null;
  readonly reason: string;
  readonly pattern: boolean;
}

export interface Event {
  readonly id: number;
  readonly at: number;
  readonly kind: string;
  readonly role: string;
  readonly text: string;
  readonly task_id: number | null;
}

/** The harness conversation a role last ran in, so a restart can resume it. */
export interface Session {
  readonly role: string;
  readonly harness: string;
  readonly session_id: string | null;
  readonly launched_at: number;
}

export interface Consultant {
  readonly id: number;
  readonly tier: string;
  readonly harness: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly helped: string;
  readonly summoned_by: string;
  readonly help_id: number;
  readonly brief: string;
  readonly created_at: number;
  readonly dismissed_at: number | null;
  readonly dismissed_by: string | null;
}

export const consultantName = (c: Consultant): string => `${CONSULTANT_PREFIX}${c.id}`;

/** The fixed start of a pattern, before its first wildcard. */
function prefixOf(pattern: string): string {
  const i = pattern.search(/[*?[]/);
  return i < 0 ? pattern : pattern.slice(0, i);
}

/** Whether two lock keys can cover the same file. */
export function overlaps(a: string, aPattern: boolean, b: string, bPattern: boolean): boolean {
  if (!aPattern && !bPattern) return a === b;
  if (aPattern && !bPattern) return fnmatchcase(b, a);
  if (bPattern && !aPattern) return fnmatchcase(a, b);
  const pa = prefixOf(a);
  const pb = prefixOf(b); // two patterns: overlap unless their fixed parts diverge
  return pa.startsWith(pb) || pb.startsWith(pa);
}

type Row = Record<string, SQLInputValue>;

export interface TaskFields {
  state?: string;
  message_id?: number | null;
  result?: string;
  revisions?: number;
  nudged_at?: number | null;
  started_at?: number | null;
  checks?: string;
  commit_id?: string;
  assignee?: string;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath, { timeout: 30_000 });
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec(SCHEMA);
    this.upgrade();
  }

  /** Bring a database made by an earlier version up to date, keeping its contents. */
  private upgrade(): void {
    for (const [table, columns] of Object.entries(UPGRADES)) {
      const have = new Set(this.all(`PRAGMA table_info(${table})`).map((r) => r.name as string));
      for (const [column, spec] of Object.entries(columns)) {
        if (!have.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
      }
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private all(sql: string, ...args: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }

  private get(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }

  private run(sql: string, ...args: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.db.prepare(sql).run(...args);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** BEGIN IMMEDIATE ... COMMIT around `body`: other processes wait, nothing interleaves. */
  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // messages

  addMessage(sender: string, recipient: string, kind: string, text: string, replyTo: number | null = null,
    urgent = false, taskId: number | null = null): Message {
    const { lastInsertRowid } = this.run(
      'INSERT INTO messages (sent_at, sender, recipient, kind, text, reply_to, urgent, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      now(), sender, recipient, kind, text, replyTo, urgent ? 1 : 0, taskId);
    return this.getMessage(lastInsertRowid) as Message;
  }

  getMessage(messageId: number): Message | null {
    const row = this.get('SELECT * FROM messages WHERE id = ?', messageId);
    return row ? toMessage(row) : null;
  }

  /** Return the recipient's unread messages and mark them read, atomically. */
  takeUnread(recipient: string): Message[] {
    return this.transaction(() => {
      const rows = this.all('SELECT * FROM messages WHERE recipient = ? AND read_at IS NULL ORDER BY id', recipient);
      if (rows.length) {
        const t = now();
        const mark = this.db.prepare('UPDATE messages SET read_at = ? WHERE id = ?');
        for (const r of rows) mark.run(t, r.id);
      }
      return rows.map(toMessage);
    });
  }

  /** Take back the unread deliveries of a task to `recipient` (they count as read). Returns how many. */
  withdraw(recipient: string, taskId: number): number {
    return this.run("UPDATE messages SET read_at = ? WHERE recipient = ? AND task_id = ? AND kind = 'task' AND read_at IS NULL",
      now(), recipient, taskId).changes;
  }

  markRead(ids: number[]): void {
    const mark = this.db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL');
    for (const id of ids) mark.run(now(), id);
  }

  // A "note" is mail that does not wake its receiver (see Hub.note); `waking` counts only the rest.

  unreadCount(recipient: string, waking = false): number {
    const row = this.get(`SELECT COUNT(*) AS n FROM messages WHERE recipient = ? AND read_at IS NULL${waking ? " AND kind != 'note'" : ''}`,
      recipient);
    return Number(row?.n ?? 0);
  }

  unreadCounts(waking = false): Record<string, number> {
    const rows = this.all(`SELECT recipient, COUNT(*) AS n FROM messages WHERE read_at IS NULL${waking ? " AND kind != 'note'" : ''}`
      + ' GROUP BY recipient');
    return dict(rows.map((r) => [r.recipient as string, Number(r.n)] as const));
  }

  /** Each recipient's oldest unread message that wakes it: when it was sent, and its id (which tells one
   * message from another: on Windows two sent within the clock's 15.6 ms tick share a time). */
  unreadSince(): Record<string, [number, number]> {
    const rows = this.all("SELECT recipient, MIN(sent_at) AS since, MIN(id) AS first FROM messages WHERE read_at IS NULL"
      + " AND kind != 'note' GROUP BY recipient");
    return dict(rows.map((r) => [r.recipient as string, [Number(r.since), Number(r.first)] as [number, number]] as const));
  }

  /** Up to `limit` of the newest messages with an id above `after`, oldest first. */
  messagesAfter(after: number, limit = 300): Message[] {
    return this.all('SELECT * FROM messages WHERE id > ? ORDER BY id DESC LIMIT ?', after, limit).reverse().map(toMessage);
  }

  /** The most recent messages sent by or to `role`, oldest first. */
  messagesInvolving(role: string, limit = 20): Message[] {
    return this.all('SELECT * FROM messages WHERE sender = ? OR recipient = ? ORDER BY id DESC LIMIT ?', role, role, limit)
      .reverse().map(toMessage);
  }

  /** Every message about one task, oldest first. */
  thread(taskId: number): Message[] {
    return this.all('SELECT * FROM messages WHERE task_id = ? ORDER BY id', taskId).map(toMessage);
  }

  /** Messages containing every word of `words`, newest first. */
  search(words: string, limit = 50): Message[] {
    const terms = words.split(/\s+/).filter((w) => w).slice(0, 8);
    if (!terms.length) return [];
    const query = `SELECT * FROM messages WHERE ${terms.map(() => "text LIKE ? ESCAPE '\\'").join(' AND ')}`;
    const args = terms.map((t) => `%${t.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`);
    return this.all(`${query} ORDER BY id DESC LIMIT ?`, ...args, limit).map(toMessage);
  }

  repliesTo(messageId: number, sender: string | null = null): Message[] {
    return sender === null
      ? this.all('SELECT * FROM messages WHERE reply_to = ? ORDER BY id', messageId).map(toMessage)
      : this.all('SELECT * FROM messages WHERE reply_to = ? AND sender = ? ORDER BY id', messageId, sender).map(toMessage);
  }

  messagesTo(recipient: string, kinds: readonly string[], limit = 50): Message[] {
    return this.all(`SELECT * FROM messages WHERE recipient = ? AND kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT ?`,
      recipient, ...kinds, limit).reverse().map(toMessage);
  }

  lastMessage(opts: { sender?: string | null; recipient?: string | null; kinds?: readonly string[] | null } = {}): Message | null {
    let query = 'SELECT * FROM messages WHERE 1 = 1';
    const args: SQLInputValue[] = [];
    if (opts.sender != null) { query += ' AND sender = ?'; args.push(opts.sender); }
    if (opts.recipient != null) { query += ' AND recipient = ?'; args.push(opts.recipient); }
    if (opts.kinds?.length) { query += ` AND kind IN (${opts.kinds.map(() => '?').join(', ')})`; args.push(...opts.kinds); }
    const row = this.get(`${query} ORDER BY id DESC LIMIT 1`, ...args);
    return row ? toMessage(row) : null;
  }

  /** Messages exchanged per pair of roles since `since` (either direction), keyed "a\u0000b" with a < b. */
  pairTraffic(since: number): Map<string, [string, string, number]> {
    const rows = this.all('SELECT MIN(sender, recipient) AS a, MAX(sender, recipient) AS b, COUNT(*) AS n FROM messages'
      + ' WHERE sent_at > ? GROUP BY 1, 2', since);
    return new Map(rows.map((r) => [`${r.a}\u0000${r.b}`, [r.a as string, r.b as string, Number(r.n)]]));
  }

  // tasks

  addTask(assigner: string, assignee: string, title: string, details: string, parentId: number | null = null,
    doneWhen = '', priority = 2, dependsOn: readonly number[] = [], state = 'open'): Task {
    const t = now();
    const deps = dependsOn.length ? `,${dependsOn.join(',')},` : '';
    const { lastInsertRowid } = this.run(
      'INSERT INTO tasks (assigner, assignee, title, details, state, parent_id, created_at, updated_at, done_when, priority,'
      + ' depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      assigner, assignee, title, details, state, parentId, t, t, doneWhen, priority, deps);
    return this.getTask(lastInsertRowid) as Task;
  }

  updateTask(taskId: number, fields: TaskFields): Task {
    const keys = Object.keys(fields) as (keyof TaskFields)[];
    const allowed = new Set(['state', 'message_id', 'result', 'revisions', 'nudged_at', 'started_at', 'checks', 'commit_id', 'assignee']);
    for (const k of keys) if (!allowed.has(k)) throw new Error(`cannot set task field ${k}`);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => (fields[k] ?? null) as SQLInputValue);
    this.run(`UPDATE tasks SET ${sets}${keys.length ? ', ' : ''}updated_at = ? WHERE id = ?`, ...values, now(), taskId);
    return this.getTask(taskId) as Task;
  }

  getTask(taskId: number): Task | null {
    const row = this.get('SELECT * FROM tasks WHERE id = ?', taskId);
    return row ? toTask(row) : null;
  }

  tasks(opts: { assignee?: string | null; assigner?: string | null; openOnly?: boolean; limit?: number;
    states?: readonly string[] | null } = {}): Task[] {
    let query = 'SELECT * FROM tasks WHERE 1 = 1';
    const args: SQLInputValue[] = [];
    if (opts.assignee != null) { query += ' AND assignee = ?'; args.push(opts.assignee); }
    if (opts.assigner != null) { query += ' AND assigner = ?'; args.push(opts.assigner); }
    if (opts.openOnly) query += ` AND state NOT IN (${CLOSED.map((s) => `'${s}'`).join(', ')})`;
    if (opts.states?.length) { query += ` AND state IN (${opts.states.map(() => '?').join(', ')})`; args.push(...opts.states); }
    return this.all(`${query} ORDER BY id DESC LIMIT ?`, ...args, opts.limit ?? 200).reverse().map(toTask);
  }

  addTaskFile(taskId: number, file: string): void {
    this.run('INSERT OR IGNORE INTO task_files (task_id, path, at) VALUES (?, ?, ?)', taskId, file, now());
  }

  taskFiles(taskId: number): string[] {
    return this.all('SELECT path FROM task_files WHERE task_id = ? ORDER BY path', taskId).map((r) => r.path as string);
  }

  /** Tasks that wait for `taskId`. */
  dependents(taskId: number): Task[] {
    return this.all('SELECT * FROM tasks WHERE depends_on LIKE ? ORDER BY id', `%,${taskId},%`).map(toTask);
  }

  // status and activity

  setStatus(role: string, state: string, task: string): Status {
    const t = now();
    this.run('INSERT INTO status (role, state, task, updated_at) VALUES (?, ?, ?, ?)'
      + ' ON CONFLICT(role) DO UPDATE SET state = excluded.state, task = excluded.task, updated_at = excluded.updated_at',
      role, state, task, t);
    return { role, state, task, updated_at: t };
  }

  getStatus(role: string): Status | null {
    const r = this.get('SELECT * FROM status WHERE role = ?', role);
    return r ? toStatus(r) : null;
  }

  statuses(): Record<string, Status> {
    return dict(this.all('SELECT * FROM status').map((r) => [r.role as string, toStatus(r)] as const));
  }

  /** Note that `role` just did something (a tool call): the watchdog's sign of progress. */
  touch(role: string): void {
    this.run('INSERT INTO activity (role, at) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET at = excluded.at', role, now());
  }

  activity(): Record<string, number> {
    return dict(this.all('SELECT role, at FROM activity').map((r) => [r.role as string, Number(r.at)] as const));
  }

  // locks: leases on files or patterns, renewed while their holder is active

  /** Take a lease on `key` for `owner` unless someone else's lease overlaps it. Returns the lease as it now
   * stands: the new (or renewed) one, or the one in the way. Expired leases don't count and are cleared. */
  claim(key: string, file: string, owner: string, pattern = false, reason = '', ttl = LEASE): Lock {
    const t = now();
    return this.transaction(() => {
      this.run('DELETE FROM locks WHERE expires_at IS NOT NULL AND expires_at < ?', t);
      for (const row of this.all('SELECT * FROM locks')) {
        if (!overlaps(row.key as string, Boolean(row.pattern), key, pattern)) continue;
        if (row.owner !== owner) return toLock(row);
        if (row.key === key || (row.pattern && !pattern)) {
          this.run('UPDATE locks SET expires_at = ? WHERE key = ?', t + ttl, row.key);
          return toLock(this.get('SELECT * FROM locks WHERE key = ?', row.key) as Row);
        }
      }
      this.run('INSERT INTO locks (key, path, owner, claimed_at, expires_at, reason, pattern) VALUES (?, ?, ?, ?, ?, ?, ?)',
        key, file, owner, t, t + ttl, reason, pattern ? 1 : 0);
      return { path: file, owner, claimed_at: t, expires_at: t + ttl, reason, pattern };
    });
  }

  /** The live lease that covers file `key` (its own, or a pattern), if any. */
  covering(key: string): Lock | null {
    const t = now();
    for (const row of this.all('SELECT * FROM locks')) {
      if (row.expires_at !== null && Number(row.expires_at) < t) continue;
      if (row.key === key || (row.pattern && fnmatchcase(key, row.key as string))) return toLock(row);
    }
    return null;
  }

  release(key: string): void {
    this.run('DELETE FROM locks WHERE key = ?', key);
  }

  /** Move a lease between holders, only if `fromOwner` still holds it. */
  transfer(key: string, fromOwner: string, toOwner: string): Lock | null {
    const t = now();
    const { changes } = this.run('UPDATE locks SET owner = ?, claimed_at = ?, expires_at = ? WHERE key = ? AND owner = ?',
      toOwner, t, t + LEASE, key, fromOwner);
    return changes ? this.lockFor(key) : null;
  }

  lockFor(key: string): Lock | null {
    const row = this.get('SELECT * FROM locks WHERE key = ?', key);
    return row ? toLock(row) : null;
  }

  locks(owner: string | null = null): Lock[] {
    const t = now();
    const rows = owner === null ? this.all('SELECT * FROM locks ORDER BY path')
      : this.all('SELECT * FROM locks WHERE owner = ? ORDER BY path', owner);
    return rows.filter((r) => r.expires_at === null || Number(r.expires_at) >= t).map(toLock);
  }

  renew(owner: string, ttl = LEASE): void {
    this.run('UPDATE locks SET expires_at = ? WHERE owner = ?', now() + ttl, owner);
  }

  /** Remove leases that ran out; returns them. */
  expire(): Lock[] {
    const t = now();
    return this.transaction(() => {
      const rows = this.all('SELECT * FROM locks WHERE expires_at IS NOT NULL AND expires_at < ?', t);
      this.run('DELETE FROM locks WHERE expires_at IS NOT NULL AND expires_at < ?', t);
      return rows.map(toLock);
    });
  }

  // events: what happened, for the activity feed

  addEvent(kind: string, role: string, text: string, taskId: number | null = null): void {
    this.run('INSERT INTO events (at, kind, role, text, task_id) VALUES (?, ?, ?, ?, ?)', now(), kind, role, text, taskId);
  }

  eventsAfter(after: number, limit = 300): Event[] {
    return this.all('SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?', after, limit).reverse().map((r) => ({
      id: Number(r.id), at: Number(r.at), kind: r.kind as string, role: r.role as string, text: r.text as string,
      task_id: r.task_id === null ? null : Number(r.task_id),
    }));
  }

  lastEventId(): number {
    return Number(this.get('SELECT COALESCE(MAX(id), 0) AS n FROM events')?.n ?? 0);
  }

  // settings

  getSetting(key: string, fallback = ''): string {
    const row = this.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? (row.value as string) : fallback;
  }

  setSetting(key: string, value: string): void {
    this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  // presence: every running agent's hub connection checks in while its session lives

  /** `pid` is the hub connection; `ppid` the harness that started it (what "stop" ends). */
  checkIn(pid: number, role: string, ppid: number | null = null): void {
    const t = now();
    this.run('INSERT INTO presence (pid, role, started_at, last_seen, ppid) VALUES (?, ?, ?, ?, ?)'
      + ' ON CONFLICT(pid) DO UPDATE SET role = excluded.role, last_seen = excluded.last_seen,'
      + ' ppid = COALESCE(excluded.ppid, presence.ppid)', pid, role, t, t, ppid);
  }

  checkOut(pid: number): void {
    this.run('DELETE FROM presence WHERE pid = ?', pid);
  }

  /** Forget check-ins of processes that are gone: one killed with its terminal never checks out, and
   * would count as a second session of its role for half a minute. */
  prune(alive: (pid: number) => boolean): void {
    for (const r of this.all('SELECT pid FROM presence')) {
      const pid = Number(r.pid);
      if (!alive(pid)) this.checkOut(pid);
    }
  }

  /** Roles with a live session, and how many sessions each has. */
  online(within = 30): Record<string, number> {
    return dict(this.all('SELECT role, COUNT(*) AS n FROM presence WHERE last_seen > ? GROUP BY role', now() - within)
      .map((r) => [r.role as string, Number(r.n)] as const));
  }

  /** (hub connection pid, harness pid) of each live session of `role`. */
  sessionsOf(role: string, within = 30): [number, number | null][] {
    return this.all('SELECT pid, ppid FROM presence WHERE role = ? AND last_seen > ?', role, now() - within)
      .map((r) => [Number(r.pid), r.ppid === null ? null : Number(r.ppid)]);
  }

  // sessions and notes: what lets a restarted team carry on where it stopped

  /** Record that `role` starts a new conversation (its id may only be known later). */
  startSession(role: string, harness: string, sessionId: string | null): void {
    const t = now();
    this.run('INSERT INTO sessions (role, harness, session_id, launched_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      + ' ON CONFLICT(role) DO UPDATE SET harness = excluded.harness, session_id = excluded.session_id,'
      + ' launched_at = excluded.launched_at, updated_at = excluded.updated_at', role, harness, sessionId, t, t);
    if (sessionId) this.rememberConversation(role, harness, sessionId);
  }

  /** What a hook saw the harness call the current conversation (Codex tells us only this way). */
  recordSessionId(role: string, harness: string, sessionId: string): void {
    const t = now();
    this.run('INSERT INTO sessions (role, harness, session_id, launched_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      + ' ON CONFLICT(role) DO UPDATE SET harness = excluded.harness, session_id = excluded.session_id,'
      + ' updated_at = excluded.updated_at'
      + ' WHERE sessions.session_id IS NOT excluded.session_id OR sessions.harness IS NOT excluded.harness',
      role, harness, sessionId, t, t);
    this.rememberConversation(role, harness, sessionId);
  }

  private rememberConversation(role: string, harness: string, sessionId: string): void {
    this.run('INSERT OR IGNORE INTO conversations (role, harness, session_id) VALUES (?, ?, ?)', role, harness, sessionId);
  }

  /** (harness, conversation id) of every conversation `role` has had. */
  conversations(role: string): [string, string][] {
    return this.all('SELECT harness, session_id FROM conversations WHERE role = ?', role)
      .map((r) => [r.harness as string, r.session_id as string]);
  }

  getSession(role: string): Session | null {
    const r = this.get('SELECT * FROM sessions WHERE role = ?', role);
    return r ? { role: r.role as string, harness: r.harness as string, session_id: (r.session_id as string | null) ?? null,
      launched_at: Number(r.launched_at) } : null;
  }

  setNotes(role: string, text: string): void {
    this.run('INSERT INTO notes (role, text, updated_at) VALUES (?, ?, ?)'
      + ' ON CONFLICT(role) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at', role, text, now());
  }

  getNotes(role: string): string {
    return (this.get('SELECT text FROM notes WHERE role = ?', role)?.text as string | undefined) ?? '';
  }

  // notices: the newest message each role has already been told about

  /** Unread messages for `role` it hasn't been told about yet; marks them as told. Notes are left out: they
   * wait for the next read_inbox (a mention would cost the agent a call for no news). */
  unnoticed(role: string): Message[] {
    return this.transaction(() => {
      const last = this.get('SELECT last_id FROM notices WHERE role = ?', role);
      const rows = this.all("SELECT * FROM messages WHERE recipient = ? AND read_at IS NULL AND id > ? AND kind != 'note' ORDER BY id",
        role, last ? Number(last.last_id) : 0);
      if (rows.length) {
        this.run('INSERT INTO notices (role, last_id) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET last_id = excluded.last_id',
          role, rows[rows.length - 1].id);
      }
      return rows.map(toMessage);
    });
  }

  // consultants

  /** Register a consultant unless `maxActive` of this tier are already working. */
  addConsultant(tier: string, harness: string, model: string | null, effort: string | null, helped: string,
    summonedBy: string, helpId: number, brief: string, maxActive: number): Consultant | null {
    return this.transaction(() => {
      const active = Number(this.get('SELECT COUNT(*) AS n FROM consultants WHERE tier = ? AND dismissed_at IS NULL', tier)?.n ?? 0);
      if (active >= maxActive) return null;
      const { lastInsertRowid } = this.run('INSERT INTO consultants (tier, harness, model, effort, helped, summoned_by, help_id,'
        + ' brief, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', tier, harness, model, effort, helped, summonedBy, helpId, brief, now());
      return toConsultant(this.get('SELECT * FROM consultants WHERE id = ?', lastInsertRowid) as Row);
    });
  }

  getConsultant(name: string): Consultant | null {
    const id = name.startsWith(CONSULTANT_PREFIX) ? name.slice(CONSULTANT_PREFIX.length) : '';
    if (!/^\d+$/.test(id)) return null;
    const row = this.get('SELECT * FROM consultants WHERE id = ?', Number(id));
    return row ? toConsultant(row) : null;
  }

  activeConsultants(): Consultant[] {
    return this.all('SELECT * FROM consultants WHERE dismissed_at IS NULL ORDER BY id').map(toConsultant);
  }

  deleteConsultant(name: string): void {
    const c = this.getConsultant(name);
    if (c !== null) this.run('DELETE FROM consultants WHERE id = ?', c.id);
  }

  /** Dismiss a consultant and give every file it holds back to the agent it helped. Returns those paths. */
  dismissConsultant(name: string, by: string): string[] {
    const c = this.getConsultant(name);
    if (c === null) throw new Error(`no consultant ${name}`);
    return this.transaction(() => {
      this.run('UPDATE consultants SET dismissed_at = ?, dismissed_by = ? WHERE id = ?', now(), by, c.id);
      const paths = this.all('SELECT path FROM locks WHERE owner = ? ORDER BY path', name).map((r) => r.path as string);
      const t = now();
      this.run('UPDATE locks SET owner = ?, claimed_at = ?, expires_at = ? WHERE owner = ?', c.helped, t, t + LEASE, name);
      return paths;
    });
  }
}

const num = (x: SQLInputValue): number | null => (x === null || x === undefined ? null : Number(x));

function toMessage(r: Row): Message {
  return {
    id: Number(r.id), sent_at: Number(r.sent_at), sender: r.sender as string, recipient: r.recipient as string,
    kind: r.kind as string, text: r.text as string, reply_to: num(r.reply_to), read_at: num(r.read_at),
    urgent: Boolean(r.urgent), task_id: num(r.task_id),
  };
}

function toTask(r: Row): Task {
  const deps = String(r.depends_on ?? '').replace(/^,+|,+$/g, '').split(',').filter((x) => x).map(Number);
  return {
    id: Number(r.id), assigner: r.assigner as string, assignee: r.assignee as string, title: r.title as string,
    details: r.details as string, state: r.state as string, message_id: num(r.message_id), parent_id: num(r.parent_id),
    result: r.result as string, created_at: Number(r.created_at), updated_at: Number(r.updated_at),
    done_when: (r.done_when as string) ?? '', priority: Number(r.priority ?? 2), depends_on: deps,
    revisions: Number(r.revisions ?? 0), nudged_at: num(r.nudged_at), started_at: num(r.started_at),
    checks: (r.checks as string) ?? '', commit_id: (r.commit_id as string) ?? '',
  };
}

function toStatus(r: Row): Status {
  return { role: r.role as string, state: r.state as string, task: r.task as string, updated_at: Number(r.updated_at) };
}

function toLock(r: Row): Lock {
  return {
    path: r.path as string, owner: r.owner as string, claimed_at: Number(r.claimed_at), expires_at: num(r.expires_at),
    reason: (r.reason as string) ?? '', pattern: Boolean(r.pattern),
  };
}

function toConsultant(r: Row): Consultant {
  return {
    id: Number(r.id), tier: r.tier as string, harness: r.harness as string, model: (r.model as string | null) ?? null,
    effort: (r.effort as string | null) ?? null, helped: r.helped as string, summoned_by: r.summoned_by as string,
    help_id: Number(r.help_id), brief: r.brief as string, created_at: Number(r.created_at),
    dismissed_at: num(r.dismissed_at), dismissed_by: (r.dismissed_by as string | null) ?? null,
  };
}
