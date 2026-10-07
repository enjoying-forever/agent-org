/**
 * Role-bound access to the hub. The message law (LAW) is enforced here.
 *
 * - Chain: a role may write to its direct superior (a report, or a request for help), its peers (roles with
 *   the same superior), and anyone below it (an instruction). Nobody else: no skipping levels upward, no
 *   writing to other teams. Consultants talk only with the agent they help. The hub itself ('hub') may write
 *   to anyone.
 * - Replies: anyone may answer a message addressed to them, whoever sent it.
 * - Tasks follow the A2A lifecycle: waiting (for tasks it depends on) -> open -> working (once the assignee
 *   has read it) -> blocked / done / failed / rejected. A done task is reviewed by whoever assigned it:
 *   accepted, or sent back with feedback.
 * - Everyone may see the whole tree, every role's status, tasks and file leases. Only a role itself and the
 *   roles above it may read its messages.
 * - A file has at most one writer. Leases cover a file or a pattern (src/api/*), last an hour without
 *   activity, and are renewed while their holder works. A lease can be released by its holder or anyone
 *   above it, and handed to a direct superior or subordinate.
 * - When a subordinate asks for help, the superior who received the request may summon a consultant: a
 *   temporary role placed under the subordinate. A consultant edits only files handed to it, and when it is
 *   dismissed its files go back to the agent it helped.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LockTimeout, withFileLock } from './filelock.ts';
import { fnmatchcase } from './fnmatch.ts';
import * as gitops from './gitops.ts';
import * as presets from './presets.ts';
import * as safety from './safety.ts';
import {
  ACTIVE, CLOSED, type Consultant, consultantName, type Lock, type Message, now, type Status, Store, type Task,
} from './store.ts';
import { dumpYaml, HARNESSES, isMapping, NAME_RE, parseYaml, pyList, Role, Team, TeamError } from './team.ts';
import * as verify from './verify.ts';
import { dict } from './dict.ts';

export const STATES = ['idle', 'working', 'waiting', 'blocked', 'done'] as const;
export const OUTCOMES = ['done', 'blocked', 'failed', 'rejected'] as const;
export const PRIORITIES: Record<number, string> = { 1: 'urgent', 2: 'normal', 3: 'low' };
export const MAX_TEXT = 20_000; // characters per message; longer material belongs in a file
export const MAX_REVISIONS = 3; // send-backs per task before the assigner must decide differently
export const BROADCAST: Record<string, string> = dict({ '@team': 'your direct subordinates', '@all': 'everyone below you' });
export const HUB = 'hub'; // sender name of the hub's own notices (reminders, escalations)

// The message law, as every agent and the owner read it.
export const LAW: [string, string][] = [
  ['Chain of command', 'Write to your direct superior, to your peers (same superior) and to '
    + "anyone below you. Don't skip levels upward or write to other teams."],
  ['Answering is always allowed', 'You may reply (reply_to) to any message sent to you, '
    + 'whoever sent it. Messages from the owner come first.'],
  ['Work is given as tasks', 'Give work only downward, with assign_task: one clear, '
    + "self-contained task each, with a 'done when' saying how anyone can check it is finished. "
    + "Split bigger work into several tasks; 'after' makes a task wait until others are done. "
    + 'Peers coordinate but never assign work to each other.'],
  ['Take it or turn it down', 'A task is yours from the moment you read it. If you cannot or '
    + 'should not do it, close it at once as rejected, with the reason.'],
  ['Every task ends with a result', 'Close each task with finish_task: done (meeting its '
    + "'done when'), blocked (say exactly what you need), failed (say why), or rejected. "
    + 'Whoever assigned it is told. Never drop a task silently.'],
  ['Results are checked', "When a task you gave is done, check it against its 'done when' "
    + 'and review_task it: accept it, or send it back with specific feedback. After three '
    + 'send-backs, decide differently: accept, cancel, or assign a new task.'],
  ['Help goes up one level', 'ask_help goes to your direct superior, who must answer it, '
    + 'pass it up, or summon a consultant. A question left unanswered is passed up for you.'],
  ['Say it once, say it all', 'Every message wakes its receiver. Send only what they need to '
    + "act on: no 'thanks' or 'ok' messages. Put long material in a file and send its path."],
  ['One writer per file', "You must hold a file's lease to edit it: editing a free file in "
    + 'your scope takes it, and claim_file can reserve a whole folder (src/api/*) for a task. '
    + 'Leases run out when their holder stops working. Closing your last task releases your files; '
    + 'release_file one earlier if someone needs it.'],
  ['Everyone sees the team', "Anyone can see every role's status, tasks and files "
    + '(team_status). Messages stay private to the sender, the receiver and their superiors.'],
  ['Silence is a problem', 'A task that shows no progress gets a reminder, then its assigner '
    + 'is told. Report a blocker as soon as you hit it instead of waiting. When an agent is out of '
    + 'its usage limit, whoever gave its tasks moves them (reassign_task) to someone who can work, '
    + 'preferably on another subscription, or lets them wait for the reset.'],
  ['Urgent is rare', "Only messages going down may be urgent. They interrupt the receiver's "
    + 'current work, so use them only to stop or redirect it.'],
];

export const BRANCH_RULE: [string, string] = ['Your own copy', 'You work in your own copy of the project, on git branch '
  + 'agent/<you>: edit any file in your scope, no locks, no waiting. When you finish a task as done (or call share_work), '
  + 'the hub merges the latest main into your copy, runs the checks, and puts your work into main for everyone. Where '
  + 'you and someone else changed the same lines, you resolve the conflict markers.'];

export function lawText(branches = false): string {
  const rules = LAW.map(([t, r]) => (branches && t === 'One writer per file' ? BRANCH_RULE : [t, r] as [string, string]));
  return rules.map(([t, r], i) => `${i + 1}. ${t}. ${r}`).join('\n');
}

/** A git step failed (git missing, a command that had to succeed, a busy landing). */
function isGitError(e: unknown): boolean {
  return e instanceof gitops.GitError || e instanceof LockTimeout
    || (e instanceof Error && 'code' in e && typeof (e as NodeJS.ErrnoException).code === 'string');
}

export function conflictText(files: string[]): string {
  return `Your work and main both changed the same lines in ${files.join(', ')}. Everything else merged; `
    + 'those spots in your copy now hold both versions between <<<<<<< and >>>>>>> markers (the original '
    + 'text in the middle, after |||||||). Edit each spot to the right result - `git log main -p -- <file>` '
    + 'shows who changed what - then try again.';
}

/** Base for every refusal the hub hands back to an agent. */
export class HubError extends Error {
  override name = 'HubError';
}

export class PermissionDenied extends HubError {
  override name = 'PermissionDenied';
}

export class LockConflict extends HubError {
  override name = 'LockConflict';
}

export interface RoleView {
  name: string;
  role: Role | null; // null for the owner
  superior: string | null;
  subordinates: string[];
  status: Status | null;
  unread: number;
  recent: Message[]; // empty when `limited`
  locks: Lock[];
  online: number; // live sessions of this role
  limited: boolean; // true when the viewer is not above this role: no messages
}

/** One line of the team overview everyone can see. */
export interface Snapshot {
  name: string;
  depth: number;
  role: Role;
  status: Status | null;
  online: number;
  locks: number;
  tasks: Task[]; // unfinished tasks assigned to this role
  stuck: string; // why it cannot work right now (usage limit, API error), if it can't
}

export type Opener = (role: Role) => void; // opens a visible session for a newly started role
export type StuckInfo = { kind?: string; until?: number | null; text?: string; at?: number };

export function consultantRole(c: Consultant): Role {
  return new Role({
    name: consultantName(c), superior: c.helped, harness: c.harness, model: c.model, effort: c.effort,
    duties: `Temporary ${c.tier} consultant: help ${c.helped} solve its help request #${c.help_id}.`, tier: c.tier,
  });
}

export function isPattern(p: string): boolean {
  return /[*?[]/.test(p);
}

const windows = process.platform === 'win32';
const fold = (s: string): string => (windows ? s.toLowerCase() : s);

export class Hub {
  static RELOAD_EVERY = 1.0; // seconds between looks at team.yaml for changes made elsewhere

  readonly team_file: string | null;
  readonly store: Store;
  opener: Opener | null;
  stopper: ((role: string) => unknown) | null; // ends a let-go agent's program (the launcher's stopRole)
  private base: Team;
  private stamp: string;
  private checked: number;

  constructor(team: Team, store: Store, opener: Opener | null = null, teamFile: string | null = null,
    stopper: ((role: string) => unknown) | null = null) {
    this.team_file = teamFile ? path.resolve(teamFile) : null;
    this.base = team;
    this.stamp = this.fingerprint();
    this.checked = now();
    this.store = store;
    this.opener = opener;
    this.stopper = stopper;
  }

  static open(teamPath: string, opener: Opener | null = null, stopper: ((role: string) => unknown) | null = null): Hub {
    const team = Team.load(teamPath);
    return new Hub(team, new Store(team.database), opener, teamPath, stopper);
  }

  /** What team.yaml holds now (its content: two quick writes can share a timestamp on Windows). */
  private fingerprint(): string {
    try {
      return this.team_file ? createHash('sha1').update(readFileSync(this.team_file)).digest('hex') : '';
    } catch {
      return '';
    }
  }

  /** The team from team.yaml - reloaded when anyone (an agent, the page) changes the file. */
  get baseTeam(): Team {
    if (this.team_file && now() - this.checked >= Hub.RELOAD_EVERY) {
      this.checked = now();
      const stamp = this.fingerprint();
      if (stamp !== this.stamp) {
        this.stamp = stamp;
        try {
          this.base = Team.load(this.team_file);
        } catch {
          // half-written or broken: keep the last good team
        }
      }
    }
    return this.base;
  }

  set baseTeam(team: Team) {
    this.base = team;
    this.stamp = this.fingerprint();
  }

  /** Change team.yaml: `change` edits its content; the result is checked before it is saved. */
  editTeam(change: (config: Record<string, unknown>) => void): Team {
    const file = this.team_file;
    if (file === null) throw new HubError('this hub was opened without its team.yaml, so the team cannot be changed');
    const team = withFileLock(path.join(path.dirname(file), '.agent-org', 'team.lock'), () => {
      const text = readFileSync(file, 'utf8');
      const parsed = parseYaml(text);
      const config = isMapping(parsed) ? parsed : {};
      change(config);
      let made: Team;
      try {
        made = Team.fromDict(config, path.dirname(file));
      } catch (e) {
        if (e instanceof TeamError) throw new HubError(`that change would break the team: ${e.message}`);
        throw e;
      }
      writeFileSync(`${file}.bak`, text, 'utf8');
      writeFileSync(file, dumpYaml(config), 'utf8');
      return made;
    }, 120, 'someone else is changing the team');
    this.baseTeam = team;
    return team;
  }

  close(): void {
    this.store.close();
  }

  /** The tree as it stands now: the roles from team.yaml plus the active consultants. */
  get team(): Team {
    const active = this.store.activeConsultants();
    return active.length ? this.baseTeam.withRoles(active.map(consultantRole)) : this.baseTeam;
  }

  // branches: every agent in its own worktree

  get branches(): boolean {
    return this.baseTeam.settings.branches;
  }

  /** Whose copy `role` works in: its own, or - for a consultant - the agent it helps. */
  branchRole(role: string): string {
    const team = this.team;
    const seen = new Set<string>();
    while (role in team.roles && team.roles[role].is_consultant && !seen.has(role)) {
      seen.add(role);
      role = team.roles[role].superior;
    }
    return role;
  }

  /** The folder `role` works in: its own worktree in branch mode, else the project folder. */
  rootOf(role: string): string {
    if (!this.branches || role === this.baseTeam.owner) return this.baseTeam.project_root;
    return gitops.worktreePath(this.baseTeam.project_root, this.branchRole(role));
  }

  /** Make sure the role's folder exists (in branch mode: history on, and its worktree). */
  prepareRoot(role: string): string {
    const root = this.baseTeam.project_root;
    if (!this.branches || role === this.baseTeam.owner) return root;
    try {
      if (!gitops.isOwnRepo(root)) {
        gitops.init(root);
        this.event('git', this.baseTeam.owner, 'turned history on: each agent works on its own branch');
      }
      return gitops.ensureWorktree(root, this.branchRole(role));
    } catch (e) {
      if (isGitError(e)) throw new HubError(`could not set up ${role}'s copy of the project: ${(e as Error).message}`);
      throw e;
    }
  }

  /** Branch mode: take the latest main into the role's copy when main has moved on. Returns a line for the
   * agent ('' when nothing happened). A merge that would conflict is left for the agent's next finish_task /
   * share_work, and only mentioned once. */
  syncRole(role: string): string {
    if (!this.branches) return '';
    const owner = this.branchRole(role);
    const root = this.baseTeam.project_root;
    const wt = this.rootOf(role);
    if (!existsSync(path.join(wt, '.git'))) return '';
    let latest: string;
    let changed: string[];
    let conflicts: string[];
    try {
      const main = gitops.mainBranch(root);
      latest = gitops.head(root, main);
      if (!latest || gitops.merging(wt) || this.store.getSetting(`synced:${owner}`) === latest
        || this.store.getSetting(`sync-conflict:${owner}`) === latest) return '';
      gitops.commitAll(wt, `${owner}: work in progress (before taking in main)`);
      [changed, conflicts] = gitops.sync(wt, main, true);
    } catch (e) {
      if (isGitError(e)) return '';
      throw e;
    }
    if (conflicts.length) {
      this.store.setSetting(`sync-conflict:${owner}`, latest);
      return `agent-org: main has new work that touches the same lines as yours in ${conflicts.join(', ')}. `
        + 'Carry on; you will settle those spots when you finish (or share_work).';
    }
    this.store.setSetting(`synced:${owner}`, latest);
    if (!changed.length) return '';
    return `agent-org: your copy now includes the latest main (changed: ${changed.slice(0, 12).join(', ')}`
      + `${changed.length > 12 ? ' ...' : ''}). Re-read those files before you edit them.`;
  }

  session(name: string): RoleSession {
    if (!this.team.isMember(name)) throw new PermissionDenied(`'${name}' is not in this team`);
    return new RoleSession(this, name);
  }

  /** Map a path or pattern to [lock key, display form], relative to the project root. Windows paths are
   * case-insensitive, so the key is lowercased there: 'SRC/App.py' and 'src/app.py' share one lock. */
  lockKey(p: string): [string, string] {
    const root = this.baseTeam.project_root;
    const text = String(p);
    let display: string;
    if (isPattern(text)) {
      let rel = text.replace(/\\/g, '/');
      if (rel.startsWith('./')) rel = rel.slice(2);
      rel = path.posix.normalize(rel).replace(/\/$/, '');
      if (rel.startsWith('/') || rel.split('/').includes('..') || text.includes(':')) {
        throw new PermissionDenied(`${p}: a pattern must be relative to the project folder`);
      }
      display = rel;
    } else {
      const full = path.resolve(root, text);
      const rel = path.relative(root, full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new PermissionDenied(`${p} is outside the project folder ${root}`);
      if (rel === '') throw new PermissionDenied('claim a file or a pattern such as src/*, not the whole project folder');
      display = rel.split(path.sep).join('/');
    }
    return [fold(display), display];
  }

  // the hub's own voice

  /** A message from the hub itself: reminders and escalations. It wakes its receiver. */
  notice(to: string, text: string, taskId: number | null = null, urgent = false): Message {
    return this.store.addMessage(HUB, to, 'notice', text, null, urgent, taskId);
  }

  /** Mail from the hub that does not wake its receiver: it comes with the next message that does (or the next
   * read_inbox). For news that changes nothing right now - a role changed, say - which would otherwise cost an
   * idle agent a turn. */
  note(to: string, text: string): Message {
    return this.store.addMessage(HUB, to, 'note', text, null, false, null);
  }

  event(kind: string, role: string, text: string, taskId: number | null = null): void {
    this.store.addEvent(kind, role, text, taskId);
  }

  /** Agents that cannot work right now, as the watchdog last saw them: role -> kind, text, at, until. */
  stuck(): Record<string, StuckInfo> {
    try {
      const found = JSON.parse(this.store.getSetting('stuck') || '{}');
      return dict(isMapping(found) ? (found as Record<string, StuckInfo>) : {});
    } catch {
      return dict();
    }
  }

  setStuck(found: Record<string, StuckInfo>): void {
    const text = JSON.stringify(Object.fromEntries(Object.entries(found).sort(([a], [b]) => (a < b ? -1 : 1))));
    if (text !== (this.store.getSetting('stuck') || '{}')) this.store.setSetting('stuck', text);
  }

  satisfied(taskId: number): boolean {
    const dep = this.store.getTask(taskId);
    return dep !== null && (dep.state === 'done' || dep.state === 'accepted');
  }

  /** Hand a task to its assignee as a message. */
  deliverTask(task: Task, preface = ''): Task {
    const lines = preface ? [preface, ''] : [];
    lines.push(`Task #${task.id}: ${task.title}`);
    if (task.priority !== 2) lines[lines.length - 1] += `  [${PRIORITIES[task.priority] ?? task.priority} priority]`;
    if (task.details) lines.push('', task.details);
    if (task.done_when) lines.push('', `Done when: ${task.done_when}`);
    if (this.baseTeam.checks.length) {
      lines.push('', "Before it can close as done, the hub runs the team's checks (run them yourself first):");
      lines.push(...this.baseTeam.checks.map((c) => `- ${verify.describe(c)}`));
    }
    if (task.parent_id) lines.push('', `(Part of task #${task.parent_id}.)`);
    lines.push('', `When you finish, call finish_task(${task.id}, result) - or right away with `
      + "outcome 'rejected' if this is not something you can or should do.");
    const message = this.store.addMessage(task.assigner, task.assignee, 'task', lines.join('\n').slice(0, MAX_TEXT), null,
      task.priority === 1, task.id);
    return this.store.updateTask(task.id, { state: 'open', message_id: message.id });
  }

  /** Start the tasks that were waiting for `task`, if everything they wait for is done. */
  releaseDependents(task: Task): Task[] {
    const started: Task[] = [];
    for (const dep of this.store.dependents(task.id)) {
      if (dep.state === 'waiting' && dep.depends_on.every((d) => this.satisfied(d))) {
        started.push(this.deliverTask(dep));
        this.event('task', dep.assignee, `#${dep.id} can start now: what it waited for is done`, dep.id);
      }
    }
    return started;
  }

  /** Tell the assigners of tasks waiting for `task` that it will never finish. */
  stallDependents(task: Task): void {
    for (const dep of this.store.dependents(task.id)) {
      if (dep.state === 'waiting') {
        this.notice(dep.assigner, `Task #${dep.id} (${dep.title}) waits for #${task.id}, which ended as ${task.state}. `
          + `It cannot start: cancel_task(${dep.id}) and plan again.`, dep.id);
      }
    }
  }
}

/** Everything one role is allowed to do. Agents only ever get one of these. */
export class RoleSession {
  readonly hub: Hub;
  readonly store: Store;
  readonly name: string;
  released: string[] = []; // files the last finishTask let go of

  constructor(hub: Hub, name: string) {
    this.hub = hub;
    this.store = hub.store;
    this.name = name;
  }

  /** The current tree. Refuses once this role has left it (a dismissed consultant). */
  get team(): Team {
    const team = this.hub.team;
    if (!team.isMember(this.name)) {
      const c = this.store.getConsultant(this.name);
      if (c !== null && c.dismissed_by) {
        throw new PermissionDenied(`you were dismissed by ${c.dismissed_by}; your work as a consultant is finished. `
          + 'Stop working and do not call any more tools.');
      }
      throw new PermissionDenied(`'${this.name}' is no longer in the team`);
    }
    return team;
  }

  get isOwner(): boolean {
    return this.name === this.hub.baseTeam.owner;
  }

  get superior(): string | null {
    return this.team.superiorOf(this.name);
  }

  // messaging

  send(to: string, text: string, replyTo: number | null = null, urgent = false): Message {
    const team = this.team;
    if (['owner', '@owner', 'the owner'].includes(to.trim().toLowerCase()) && !team.isMember(to)) {
      to = team.owner; // an agent may not know the owner's name; "owner" always reaches them
    }
    if (to in BROADCAST) throw new HubError(`to write to ${BROADCAST[to]}, use broadcast`);
    if (!team.isMember(to)) throw new PermissionDenied(`'${to}' is not in this team`);
    if (to === this.name) throw new PermissionDenied('you cannot message yourself');
    const original = this.checkReply(replyTo);
    let kind: string;
    if (to === team.superiorOf(this.name)) kind = 'report';
    else if (team.isAbove(this.name, to)) kind = 'instruction';
    else if (this.peers(team).includes(to)) kind = 'peer';
    else if (original !== null && original.sender === to && original.recipient === this.name) kind = 'reply'; // law 2
    else {
      throw new PermissionDenied(`you cannot message '${to}'. ${this.reach(team)} (You may also reply to any message sent to you.)`);
    }
    if (urgent && kind !== 'instruction') throw new PermissionDenied('only messages to people below you may be urgent');
    return this.store.addMessage(this.name, to, kind, checkText(text), replyTo, urgent, original?.task_id ?? null);
  }

  /** One message to each of your direct subordinates (@team) or everyone below you (@all). */
  broadcast(scope: string, text: string, urgent = false): Message[] {
    const team = this.team;
    if (!(scope in BROADCAST)) throw new HubError(`broadcast to one of ${Object.keys(BROADCAST).join(', ')}`);
    const names = (scope === '@team' ? team.subordinatesOf(this.name) : team.subtreeOf(this.name))
      .filter((n) => !team.roles[n].is_consultant);
    if (!names.length) throw new HubError('there is nobody below you to write to');
    const body = checkText(text);
    return names.map((n) => this.store.addMessage(this.name, n, 'instruction', body, null, urgent));
  }

  /** Roles with the same superior. Consultants have no peers. */
  peers(team: Team): string[] {
    const me = team.roles[this.name];
    if (me === undefined || me.is_consultant) return [];
    return team.subordinatesOf(me.superior).filter((s) => s !== this.name && !team.roles[s].is_consultant);
  }

  askHelp(question: string, replyTo: number | null = null): Message {
    const superior = this.superior;
    if (superior === null) throw new PermissionDenied('the owner has no superior to ask');
    const original = this.checkReply(replyTo);
    return this.store.addMessage(this.name, superior, 'help', checkText(question), replyTo, false, original?.task_id ?? null);
  }

  /** Help requests sent to this role that it has neither answered nor sent a consultant for. */
  unansweredHelp(): Message[] {
    const helped = new Set(this.store.activeConsultants().map((c) => c.help_id));
    return this.store.messagesTo(this.name, ['help'])
      .filter((m) => !helped.has(m.id) && !this.store.repliesTo(m.id, this.name).length);
  }

  /** Your new messages. Reading a task makes it yours: it moves to 'working'. */
  readInbox(): Message[] {
    void this.team; // refuses a dismissed consultant
    const messages = this.store.takeUnread(this.name);
    for (const m of messages) {
      if (m.kind !== 'task' || m.task_id === null) continue;
      const task = this.store.getTask(m.task_id);
      if (task === null || task.assignee !== this.name || !['open', 'working'].includes(task.state)) continue;
      if (task.state === 'open') {
        this.store.updateTask(task.id, { state: 'working', started_at: now() });
        this.hub.event('task', this.name, `started #${task.id}: ${task.title}`, task.id);
        this.hub.syncRole(this.name); // a new task starts from the latest main
      }
      // a new task, or one sent back to it: its status says so with no call for it
      this.store.setStatus(this.name, 'working', `#${task.id} ${task.title}`);
    }
    return messages;
  }

  /** Wait until at least one message arrives, `timeout` seconds pass, or `signal` aborts. An aborted wait returns
   * without taking anything, so no message is lost to a caller that has gone away. A consultant dismissed while
   * waiting is told so. */
  async waitForMessages(timeout: number, poll = 0.5, signal: AbortSignal | null = null): Promise<Message[]> {
    const deadline = performance.now() + timeout * 1000;
    for (;;) {
      if (signal?.aborted) return [];
      void this.team; // a consultant dismissed meanwhile is told so
      if (this.store.unreadCount(this.name, true)) return this.readInbox(); // notes alone do not end the wait
      const left = deadline - performance.now();
      if (left <= 0) return [];
      await sleep(Math.min(poll * 1000, left), signal);
    }
  }

  private checkReply(replyTo: number | null): Message | null {
    if (replyTo === null || replyTo === undefined) return null;
    const original = this.store.getMessage(replyTo);
    if (original === null || ![original.sender, original.recipient].includes(this.name)) {
      throw new PermissionDenied(`message #${replyTo} is not one of yours`);
    }
    return original;
  }

  private reach(team: Team): string {
    const superior = team.superiorOf(this.name);
    const allowed = [...(superior ? [superior] : []), ...this.peers(team), ...team.subtreeOf(this.name)];
    return allowed.length ? `You can message: ${allowed.join(', ')}.` : 'You can message nobody.';
  }

  /** Messages you may read (yours, and those of roles below you) containing `words`. */
  search(words: string, limit = 20): Message[] {
    const team = this.team;
    const found: Message[] = [];
    for (const m of this.store.search(words, limit * 5)) {
      if (this.isOwner || [m.sender, m.recipient].some((p) => p === this.name || (team.isMember(p) && team.isAbove(this.name, p)))) {
        found.push(m);
      }
      if (found.length >= limit) break;
    }
    return found;
  }

  // tasks

  /** Give work to someone below you. The task starts at once, or - with `after` - when every task it waits for
   * is done. */
  assignTask(to: string, title: string, details = '', partOf: number | null = null, doneWhen = '',
    after: readonly number[] = [], priority = 2): Task {
    const team = this.team;
    if (!team.isMember(to) || to === team.owner) throw new PermissionDenied(`'${to}' is not a role in this team`);
    if (!team.isAbove(this.name, to)) {
      const peers = this.peers(team).includes(to) ? " Peers coordinate but don't assign work to each other." : '';
      throw new PermissionDenied(`you can only assign tasks to people below you, not '${to}'.${peers}`);
    }
    title = checkText(title).split(/\r?\n/)[0].slice(0, 200);
    if (partOf !== null && partOf !== undefined) {
      const parent = this.store.getTask(partOf);
      if (parent === null || parent.assignee !== this.name) throw new PermissionDenied(`task #${partOf} is not one of your tasks`);
    }
    if (!(priority in PRIORITIES)) throw new HubError('priority must be 1 (urgent), 2 (normal) or 3 (low)');
    const deps = [...new Set(after.map((d) => Math.trunc(Number(d))))];
    for (const d of deps) {
      const dep = this.store.getTask(d);
      if (dep === null) throw new HubError(`there is no task #${d} to wait for`);
      if (['failed', 'rejected', 'cancelled'].includes(dep.state)) throw new HubError(`task #${d} ended as ${dep.state}; it will never be done`);
    }
    const waiting = deps.some((d) => !this.hub.satisfied(d));
    const task = this.store.addTask(this.name, to, title, details.trim().slice(0, MAX_TEXT), partOf ?? null,
      doneWhen.trim().slice(0, 2000), priority, deps, waiting ? 'waiting' : 'open');
    const afterText = deps.length ? ` after #${deps.join(', #')}` : '';
    this.hub.event('task', this.name, `gave #${task.id} to ${to}${afterText}: ${title}`, task.id);
    return waiting ? task : this.hub.deliverTask(task);
  }

  /** Close one of your tasks: done, blocked (you need something), failed, or rejected. */
  async finishTask(taskId: number, result: string, outcome = 'done'): Promise<Task> {
    void this.team; // refuses a dismissed consultant
    let task = this.store.getTask(taskId);
    if (task === null || task.assignee !== this.name) throw new PermissionDenied(`task #${taskId} is not assigned to you`);
    if (!(OUTCOMES as readonly string[]).includes(outcome)) throw new HubError(`outcome must be one of: ${OUTCOMES.join(', ')}`);
    if (task.state === 'waiting') throw new HubError(`task #${taskId} has not started: it waits for #${task.depends_on.join(', #')}`);
    if (!['open', 'working', 'blocked'].includes(task.state)) throw new HubError(`task #${taskId} is already ${task.state}`);
    result = checkText(result);
    let checks = '';
    let landed: string | null = null;
    if (this.hub.branches && outcome === 'done') {
      [landed, checks] = await this.integrate(`task #${task.id}: ${task.title}`, this.store.taskFiles(taskId),
        `task #${taskId} is not done yet`, task.id);
    } else if (this.hub.branches) {
      this.saveWork(`task #${task.id} (${outcome})`);
    } else if (outcome === 'done') {
      const files = this.store.taskFiles(taskId);
      const root = this.hub.baseTeam.project_root;
      if (files.length && this.team.settings.scan_secrets && this.team.settings.commit_on_accept) {
        this.noSecrets(gitops.diff(root, files), `task #${taskId} is not done yet`, task.id);
      }
      checks = await this.runChecks(files, root, `task #${taskId} is not done yet`, task.id);
    }
    task = this.store.updateTask(taskId, { state: outcome, result, checks, ...(landed ? { commit_id: landed } : {}) });
    const head = { done: 'is DONE - please review it', blocked: 'is BLOCKED', failed: 'FAILED', rejected: 'was REJECTED' }[outcome];
    this.store.addMessage(this.name, task.assigner, 'result', `Task #${task.id} ${head}: ${task.title}\n\n${result}`,
      task.message_id, false, task.id);
    this.hub.event('task', this.name, `#${task.id} ${outcome}: ${task.title}`, task.id);
    if (outcome === 'done') this.hub.releaseDependents(task);
    else if (outcome === 'failed' || outcome === 'rejected') this.hub.stallDependents(task);
    this.released = this.settle();
    return task;
  }

  /** After one of its tasks closes (finished, cancelled or moved away): with nothing left to work on, its status
   * says idle - or blocked - with no call for it; with no task left at all, its files are released (seen: an agent
   * spent a call per file releasing them by hand). Returns those files. */
  settle(): string[] {
    const mine = this.myTasks();
    if (!mine.some((t) => t.state === 'open' || t.state === 'working')) {
      const blocked = mine.find((t) => t.state === 'blocked');
      this.store.setStatus(this.name, blocked ? 'blocked' : 'idle', blocked ? `#${blocked.id} ${blocked.title}` : '');
    }
    return mine.length ? [] : this.releaseAll('its tasks are finished'); // blocked work keeps its files
  }

  /** Let go of every lease this role holds (the hub doing it saves the agent a call per file). */
  releaseAll(why: string): string[] {
    const released: string[] = [];
    for (const lock of this.store.locks(this.name)) {
      this.store.release(this.hub.lockKey(lock.path)[0]);
      this.hub.event('file', this.name, `released ${lock.path}: ${why}`);
      released.push(lock.path);
    }
    return released;
  }

  /** Run the team's checks that apply to `files` in `cwd`; refuse with their output if one fails. */
  private async runChecks(files: string[], cwd: string, refusal: string, taskId: number | null): Promise<string> {
    if (!this.team.checks.length) return '';
    const outcomes = await verify.run(this.team, files, cwd);
    const failed = outcomes.filter((o) => !o.ok);
    const checks = verify.summary(outcomes);
    if (failed.length) {
      this.hub.event('check', this.name, `checks failed: ${checks}`, taskId);
      const details = failed.map((o) => `--- ${o.name}: \`${o.command}\` (run in ${cwd}) ---\n${o.output}`).join('\n\n');
      throw new HubError(`${refusal}: ${checks}.\n\n${details}\n\nRun the command yourself to see what it `
        + 'expects, fix it, and try again - or close the task as blocked or failed and say why.');
    }
    return checks;
  }

  /** Branch mode: commit whatever is in the role's copy, so nothing is lost. */
  private saveWork(what: string): void {
    try {
      gitops.commitAll(this.hub.rootOf(this.name), `${this.hub.branchRole(this.name)}: ${what}`);
    } catch (e) {
      if (!isGitError(e)) throw e;
    }
  }

  /** Branch mode: commit this role's work, merge the latest main into it, run the checks on the result, and put
   * it into main. Returns [commit in main, checks summary]. */
  private async integrate(message: string, files: string[], refusal: string, taskId: number | null): Promise<[string, string]> {
    const hub = this.hub;
    const root = hub.baseTeam.project_root;
    const wt = hub.rootOf(this.name);
    const branch = gitops.BRANCH_PREFIX + hub.branchRole(this.name);
    if (!existsSync(path.join(wt, '.git'))) throw new HubError(`${this.name} has no copy of the project yet; restart it from the agent-org page`);
    let landedAs: string;
    let checks: string;
    try {
      const main = gitops.mainBranch(root);
      if (gitops.merging(wt)) {
        const conflicted = gitops.conflicted(wt);
        const left = gitops.withMarkers(wt, conflicted.length ? conflicted
          : gitops.git(wt, ['diff', '--name-only', 'HEAD']).stdout.split(/\s+/).filter((x) => x));
        if (left.length) throw new HubError(`${refusal}: ${left.join(', ')} still hold conflict markers (<<<<<<< / >>>>>>>). Settle each spot, then try again.`);
      }
      gitops.commitAll(wt, `${hub.branchRole(this.name)}: ${message}`);
      let [, conflicts] = gitops.sync(wt, main, false);
      if (conflicts.length) {
        hub.event('git', this.name, `conflicts with main in ${conflicts.join(', ')}`, taskId);
        throw new HubError(`${refusal}. ${conflictText(conflicts)}`);
      }
      const changed = gitops.git(wt, ['diff', '--name-only', `${main}...HEAD`]).stdout.split(/\s+/).filter((x) => x);
      if (!gitops.git(wt, ['rev-list', '--count', `${main}..HEAD`]).stdout.trim().replace(/^0+|0+$/g, '')) return ['', '']; // nothing of its own
      this.landingChecks(wt, main, changed, refusal, taskId);
      checks = await this.runChecks([...new Set([...files, ...changed])].sort(), wt, refusal, taskId);
      landedAs = gitops.withLandLock(root, () => {
        let [commit, why] = gitops.land(root, branch, message);
        if (commit === null) { // main moved on while the checks ran: take it in and try once more
          [, conflicts] = gitops.sync(wt, main, false);
          if (conflicts.length) throw new HubError(`${refusal}. ${conflictText(conflicts)}`);
          [commit, why] = gitops.land(root, branch, message);
        }
        if (commit === null) throw new HubError(`${refusal}: your work could not go into main: ${why}`);
        gitops.sync(wt, main, true); // a fast-forward: your copy = main again
        hub.store.setSetting(`synced:${hub.branchRole(this.name)}`, gitops.head(root, main));
        return commit;
      });
    } catch (e) {
      if (e instanceof HubError) throw e;
      if (isGitError(e)) throw new HubError(`${refusal}: git failed: ${(e as Error).message}`);
      throw e;
    }
    hub.event('git', this.name, `merged into main as ${landedAs}: ${message}`, taskId);
    return [landedAs, checks];
  }

  /** What never goes into main: the team's own configuration, files outside the agent's write scope (also written
   * through the shell), and secrets. */
  private landingChecks(wt: string, main: string, changed: string[], refusal: string, taskId: number | null): void {
    const team = this.team;
    const name = this.hub.team_file ? path.basename(this.hub.team_file) : 'team.yaml';
    const guarded = changed.filter((f) => safety.isProtected(f, name));
    if (guarded.length) {
      this.hub.event('safety', this.name, `refused to land changes to ${guarded.join(', ')}`, taskId);
      throw new HubError(`${refusal}: your copy changes ${guarded.join(', ')}, the team's own configuration. `
        + `Undo that (git checkout ${main} -- <file>), then try again.`);
    }
    const outside = safety.outsideScope(changed.filter((f) => !gitops.isJunk(f)), this.scope(team, this.name));
    if (outside.length) {
      this.hub.event('safety', this.name, `refused to land files outside its scope: ${outside.join(', ')}`, taskId);
      throw new HubError(`${refusal}: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside the `
        + `files you may write (${this.scope(team, this.name).join(', ') || 'none'}). Undo those changes (git checkout `
        + `${main} -- <file>, or delete new files), or ask ${this.superior} to change your scope.`);
    }
    this.noSecrets(gitops.git(wt, ['diff', `${main}...HEAD`]).stdout, refusal, taskId);
  }

  private noSecrets(diff: string, refusal: string, taskId: number | null): void {
    if (!this.team.settings.scan_secrets) return;
    const found = safety.findSecrets(diff);
    if (found.length) {
      this.hub.event('safety', this.name, `refused to put secrets into history: ${found.join(', ')}`, taskId);
      throw new HubError(`${refusal}: this would put secrets into git history: ${found.join(', ')}. Read them `
        + 'from an environment variable or a file that is not committed (add it to .gitignore) instead, then try again.');
    }
  }

  /** Branch mode: put your work so far into main now, without finishing a task (after the checks). */
  async shareWork(summary: string): Promise<string> {
    void this.team;
    if (!this.hub.branches) throw new HubError('this team works in one shared folder: your saved edits are already visible to everyone');
    const line = checkText(summary).split(/\r?\n/)[0].slice(0, 200);
    const [commit] = await this.integrate(`${this.hub.branchRole(this.name)} shares: ${line}`, [], 'your work was not shared', null);
    return commit;
  }

  /** Accept a done task, or send it back to its assignee with what to change. */
  reviewTask(taskId: number, accept: boolean, feedback = ''): Task {
    const team = this.team;
    let task = this.store.getTask(taskId);
    if (task === null) throw new HubError(`there is no task #${taskId}`);
    if (task.assigner !== this.name && !team.isAbove(this.name, task.assignee)) {
      throw new PermissionDenied(`only ${task.assigner} (who gave it) or someone above ${task.assignee} reviews task #${taskId}`);
    }
    if (task.state !== 'done') throw new HubError(`task #${taskId} is ${task.state}; only a done task is reviewed`);
    if (accept) {
      task = this.store.updateTask(taskId, { state: 'accepted' });
      this.hub.event('task', this.name, `accepted #${task.id}: ${task.title}`, task.id);
      return this.hub.branches ? task : this.commit(task); // branches: it is in main already
    }
    feedback = feedback.trim() ? checkText(feedback) : '';
    if (!feedback) throw new HubError('say what has to change: sending a task back needs feedback');
    if (task.revisions >= MAX_REVISIONS) {
      throw new HubError(`task #${taskId} was sent back ${task.revisions} times already. Decide `
        + 'differently: accept it, cancel_task it, or assign a new, clearer task.');
    }
    task = this.store.updateTask(taskId, { state: 'working', revisions: task.revisions + 1, nudged_at: null });
    this.store.addMessage(this.name, task.assignee, 'task', `Task #${task.id} (${task.title}) is sent back to you (round `
      + `${task.revisions} of ${MAX_REVISIONS}):\n\n${feedback}\n\nFix it and finish_task(${task.id}, result) again.`,
      task.message_id, false, task.id);
    this.hub.event('task', this.name, `sent #${task.id} back to ${task.assignee}`, task.id);
    return task;
  }

  /** Commit the files an accepted task changed, if the team keeps history. */
  private commit(task: Task): Task {
    if (!this.team.settings.commit_on_accept) return task;
    const files = this.store.taskFiles(task.id);
    if (!files.length) return task;
    const message = `task #${task.id}: ${task.title}\n\nDone by ${task.assignee}, accepted by ${this.name}.`
      + (task.result ? `\n\n${task.result.slice(0, 1500)}` : '');
    let commitId: string | null;
    try {
      commitId = gitops.commit(this.hub.baseTeam.project_root, files, message);
    } catch (e) { // history is a bonus; acceptance stands without it
      this.hub.event('git', this.name, `could not commit #${task.id}: ${(e as Error).message}`, task.id);
      return task;
    }
    if (commitId) {
      this.hub.event('git', this.name, `committed #${task.id} as ${commitId}`, task.id);
      return this.store.updateTask(task.id, { commit_id: commitId });
    }
    return task;
  }

  /** Withdraw a task: its assigner, or anyone above its assignee, may do this. */
  cancelTask(taskId: number, reason = ''): Task {
    const team = this.team;
    let task = this.store.getTask(taskId);
    if (task === null) throw new HubError(`there is no task #${taskId}`);
    if (task.assigner !== this.name && !team.isAbove(this.name, task.assignee)) {
      throw new PermissionDenied(`only ${task.assigner} or someone above ${task.assignee} can cancel task #${taskId}`);
    }
    if ((CLOSED as readonly string[]).includes(task.state)) throw new HubError(`task #${taskId} is already ${task.state}`);
    const unseen = this.unseen(task);
    task = this.store.updateTask(taskId, { state: 'cancelled', result: reason.trim() });
    this.hub.event('task', this.name, `cancelled #${task.id}: ${task.title}`, task.id);
    const freed = team.isMember(task.assignee) ? this.hub.session(task.assignee).settle() : [];
    const why = reason.trim() ? ` Reason: ${sentence(reason)}` : '';
    if (!unseen) {
      this.store.addMessage(this.name, task.assignee, 'instruction',
        `Task #${task.id} (${task.title}) is cancelled; stop working on it.${why}`
        + (freed.length ? ` Your files are released (${freed.join(', ')}).` : ''), task.message_id, false, task.id);
    }
    if (![this.name, team.owner].includes(task.assigner) && team.isMember(task.assigner)) {
      // cancelled from above: whoever gave it plans with it, so it hears (and is woken to re-plan)
      this.hub.notice(task.assigner, `${this.who()} cancelled task #${task.id} (${task.title}) that you gave to `
        + `${task.assignee}.${why} Plan without it.`, task.id);
    }
    this.hub.stallDependents(task);
    return task;
  }

  /** Whether its assignee never read the task (it waits for others, or its delivery is unread). Then a cancel or
   * move takes the delivery back and says nothing: a message would wake the agent only to tell it to stop what it
   * never started (seen: a worker woken for that, in a live run). */
  private unseen(task: Task): boolean {
    if (task.state !== 'waiting' && task.state !== 'open') return false;
    this.store.withdraw(task.assignee, task.id);
    return true;
  }

  /** Move an unfinished task to someone else - say, because its assignee is out of its usage limit. Its assigner,
   * or anyone above its assignee, may do this; the new assignee must be below both the mover and the assigner.
   * Leases the old assignee holds on the task's files move with it, and the new assignee is told what was done. */
  reassignTask(taskId: number, to: string, reason = ''): Task {
    const team = this.team;
    let task = this.store.getTask(taskId);
    if (task === null) throw new HubError(`there is no task #${taskId}`);
    if (task.assigner !== this.name && !team.isAbove(this.name, task.assignee)) {
      throw new PermissionDenied(`only ${task.assigner} or someone above ${task.assignee} can move task #${taskId}`);
    }
    if (!(ACTIVE as readonly string[]).includes(task.state)) throw new HubError(`task #${taskId} is ${task.state}; only an unfinished task can be moved`);
    if (!team.isMember(to) || to === team.owner) throw new PermissionDenied(`'${to}' is not a role in this team`);
    if (to === task.assignee) throw new HubError(`task #${taskId} is already ${to}'s`);
    if (team.roles[to].is_consultant) throw new PermissionDenied(`${to} is a consultant; it helps with a problem but does not take tasks`);
    if (!(team.isAbove(this.name, to) && (task.assigner === team.owner || team.isAbove(task.assigner, to)))) {
      throw new PermissionDenied(`${to} must be below both you and ${task.assigner}, who gave task #${taskId}`);
    }
    const before = task.assignee;
    const unseen = this.unseen(task);
    const files = this.store.taskFiles(taskId);
    const moved: string[] = [];
    const freed: string[] = [];
    for (const f of files) {
      let lock: Lock | null;
      try {
        lock = this.store.covering(this.hub.lockKey(f)[0]);
      } catch (e) {
        if (e instanceof PermissionDenied) continue;
        throw e;
      }
      if (lock === null || lock.owner !== before || moved.includes(lock.path) || freed.includes(lock.path)) continue;
      const key = this.hub.lockKey(lock.path)[0];
      if (this.inScope(team, to, lock.path) && this.store.transfer(key, before, to)) {
        moved.push(lock.path);
      } else {
        this.store.release(key);
        freed.push(lock.path);
      }
    }
    const why = reason.trim();
    task = this.store.updateTask(taskId, { assignee: to, started_at: null, nudged_at: null });
    if (task.state !== 'waiting') {
      const notes = [`This task was ${before}'s and is now yours${why ? `: ${why}` : '.'}`];
      if (task.result) notes.push(`${before}'s last word on it: ${task.result.slice(0, 1500)}`);
      if (files.length) notes.push(`Files it changed so far: ${files.join(', ')}.`);
      if (moved.length) notes.push(`You now hold its leases on: ${moved.join(', ')}.`);
      notes.push(`Its whole history: task_details(${task.id}).`);
      task = this.hub.deliverTask(task, notes.join('\n'));
    }
    let rest: string[] = [];
    if (before in team.roles) rest = this.hub.session(before).settle(); // its status (and, with nothing left, its files)
    if (before in team.roles && !unseen) {
      this.store.addMessage(this.name, before, 'instruction', `Task #${task.id} (${task.title}) was moved to ${to}; stop working on it.`
        + (why ? ` Reason: ${sentence(why)}` : '')
        + (moved.length || freed.length ? ` Your leases on ${[...moved, ...freed].join(', ')} went with it.` : '')
        + (rest.length ? ` Your other files are released (${rest.join(', ')}).` : ''), null, false, task.id);
    }
    if (![this.name, team.owner].includes(task.assigner) && team.isMember(task.assigner)) {
      // its result still comes back to whoever gave it: news, but nothing to do now (it does not wake)
      this.hub.note(task.assigner, `${this.who()} moved task #${task.id} (${task.title}), which you gave, from `
        + `${before} to ${to}${why ? `: ${sentence(why)}` : '.'}`);
    }
    this.hub.event('task', this.name, `moved #${task.id} from ${before} to ${to}${why ? `: ${why}` : ''}`, task.id);
    return task;
  }

  // changing the team (hire, change, let go) - only below yourself

  /** This role at the start of a sentence to others: the owner may be called 'you', which an agent would take for
   * itself. */
  private who(): string {
    return this.isOwner ? 'The owner' : this.name;
  }

  private mayChangeTeam(): Team {
    const team = this.team;
    const me = team.roles[this.name];
    if (!team.settings.team_changes) throw new PermissionDenied('the owner has turned team changes off; ask them instead');
    if (me !== undefined && me.is_consultant) throw new PermissionDenied('consultants do not change the team');
    return team;
  }

  /** Add an agent under yourself (or under someone below you); it starts at once. With a `preset` (a role from
   * the owner's library) its settings are the starting point; whatever else is given overrides them. */
  hire(name: string, opts: { harness?: string; duties?: string; model?: string; effort?: string; write_scope?: readonly string[] | null;
    superior?: string; preset?: string; instructions?: string } = {}): Role {
    const team = this.mayChangeTeam();
    let { harness = '', duties = '', model = '', effort = '', instructions = '' } = opts;
    let writeScope = opts.write_scope ?? null;
    if (opts.preset) {
      let base: Record<string, unknown>;
      try {
        base = presets.get(opts.preset);
      } catch {
        throw new HubError(`there is no role preset '${opts.preset}'; known: ${presets.names().join(', ')}`);
      }
      harness = harness || String(base.harness ?? '');
      duties = duties || String(base.duties ?? '');
      model = model || String(base.model ?? '');
      effort = effort || String(base.effort ?? '');
      instructions = instructions || String(base.instructions ?? '');
      if (writeScope === null) writeScope = (base.write_scope as string[] | undefined) ?? [];
    }
    const scope = writeScope ?? [];
    if (!duties.trim()) throw new HubError('say what the new agent is for (duties), or hire from a preset');
    const superior = opts.superior || this.name;
    if (superior !== this.name && !team.isAbove(this.name, superior)) {
      throw new PermissionDenied(`you can only hire under yourself or someone below you, not under ${superior}`);
    }
    if (!NAME_RE.test(name) || name.startsWith('consultant-')) {
      throw new HubError('give it a simple name: letters, digits, - and _ (not starting with consultant-)');
    }
    if (team.isMember(name)) throw new HubError(`there is already a '${name}' in the team`);
    if (!(HARNESSES as readonly string[]).includes(harness)) throw new HubError(`harness must be one of ${pyList(HARNESSES)}`);
    if (asksOwnerForEverything(harness, model)) throw new HubError(NO_HAIKU);
    if (Object.keys(this.hub.baseTeam.roles).length >= team.settings.max_agents) {
      throw new HubError(`the team already has ${team.settings.max_agents} agents, the most the owner allows; let one go first, or ask the owner`);
    }
    this.scopeAllowed(team, scope);
    const spec: Record<string, unknown> = { superior, harness, duties: checkText(duties).slice(0, 2000), write_scope: scope.map(String) };
    if (model.trim()) spec.model = model.trim();
    if (effort.trim()) spec.effort = effort.trim();
    if (instructions.trim()) spec.instructions = checkText(instructions).slice(0, 8000);
    this.hub.editTeam((c) => {
      const roles = isMapping(c.roles) ? c.roles : (c.roles = {});
      (roles as Record<string, unknown>)[name] = spec;
    });
    const role = this.hub.team.roles[name];
    this.announce(`hired ${name} (${harness}${model ? `, ${model}` : ''}) under ${superior}: ${duties.slice(0, 200)}`);
    const limit = team.settings.max_running;
    const running = Object.keys(this.store.online()).filter((n) => n in team.roles).length;
    if (limit && running >= limit) {
      this.hub.event('agent', name, `not started: ${limit} agents are running already (the team's limit)`);
    } else if (this.hub.opener !== null) {
      try {
        this.hub.opener(role);
      } catch (e) { // the role exists; it can be started from the page
        this.hub.event('agent', this.name, `could not open ${name}'s tab: ${(e as Error).message}`);
      }
    }
    return role;
  }

  /** Change an agent below you. A new model or effort applies from its next start. */
  changeRole(name: string, opts: { duties?: string | null; model?: string | null; effort?: string | null;
    write_scope?: readonly string[] | null; superior?: string | null } = {}): Role {
    const team = this.mayChangeTeam();
    if (!team.isAbove(this.name, name) || team.roles[name].is_consultant) {
      throw new PermissionDenied(`you can only change agents below you, and '${name}' is not one`);
    }
    const { superior = null, write_scope: writeScope = null, model = null } = opts;
    if (superior !== null && superior !== this.name && !team.isAbove(this.name, superior)) {
      throw new PermissionDenied(`${name} can only move under you or someone below you`);
    }
    if (writeScope !== null) this.scopeAllowed(team, writeScope);
    if (model !== null && asksOwnerForEverything(team.roles[name].harness, model)) throw new HubError(NO_HAIKU);
    const what = Object.fromEntries(Object.entries({ duties: opts.duties ?? null, model, effort: opts.effort ?? null,
      write_scope: writeScope, superior }).filter(([, v]) => v !== null)) as Record<string, string | readonly string[]>;
    if (!Object.keys(what).length) throw new HubError('say what to change: duties, model, effort, write_scope or superior');
    this.hub.editTeam((config) => {
      const spec = ((config.roles as Record<string, Record<string, unknown>>)[name]);
      for (const [key, value] of Object.entries(what)) {
        if ((value === '' || (Array.isArray(value) && !value.length)) && (key === 'model' || key === 'effort')) delete spec[key];
        else spec[key] = key === 'write_scope' ? [...(value as readonly string[])] : value;
      }
    });
    this.announce(`changed ${name}: ${Object.entries(what).map(([k, v]) => `${k} -> ${pyValue(v)}`).join(', ')}`.slice(0, 300 + `changed ${name}: `.length));
    if (superior !== null || opts.duties != null || writeScope !== null) {
      this.hub.note(name, `${this.name} changed your role (${Object.keys(what).join(', ')}). Call my_role to see it now.`);
    }
    return this.hub.team.roles[name];
  }

  /** Remove an agent below you. Its subordinates move up to its superior. Returns who moved. */
  letGo(name: string, reason = ''): string[] {
    const team = this.mayChangeTeam();
    if (!team.isAbove(this.name, name) || team.roles[name].is_consultant) {
      throw new PermissionDenied(`you can only let go of agents below you, and '${name}' is not one`);
    }
    const busy = this.store.tasks({ assignee: name, openOnly: true }).filter((t) => (ACTIVE as readonly string[]).includes(t.state));
    if (busy.length) {
      throw new HubError(`${name} still has unfinished tasks (${busy.map((t) => `#${t.id}`).join(', ')}): reassign_task or cancel_task them first`);
    }
    const above = team.roles[name].superior;
    const moved = team.subordinatesOf(name);
    if (this.hub.stopper !== null) {
      try {
        this.hub.stopper(name);
      } catch {
        // its tab can be closed by hand
      }
    }
    for (const lock of this.store.locks(name)) this.store.release(this.hub.lockKey(lock.path)[0]);
    this.hub.editTeam((config) => {
      const roles = config.roles as Record<string, Record<string, unknown>>;
      for (const sub of moved) roles[sub].superior = above;
      delete roles[name];
    });
    this.announce(`let go of ${name}${reason.trim() ? `: ${reason.trim()}` : ''}${moved.length ? `; ${moved.join(', ')} now report to ${above}` : ''}`);
    for (const sub of moved) this.hub.note(sub, `${name} has left the team; you now report to ${above}. Call my_role.`);
    return moved;
  }

  /** A manager cannot give anyone more files than it may write itself. */
  private scopeAllowed(team: Team, scope: readonly string[]): void {
    const beyond = safety.scopeWithin(scope, this.scope(team, this.name));
    if (beyond.length) throw new PermissionDenied(`you can only give files you may write yourself; ${beyond.join(', ')} reach beyond your own scope`);
  }

  /** Team changes are recorded and told to the owner. */
  private announce(what: string): void {
    this.hub.event('team', this.name, what);
    const owner = this.team.owner;
    if (this.name !== owner) this.hub.notice(owner, `Team change by ${this.name}: ${what}`);
  }

  /** A task and its whole thread, for anyone who may see it (assigner, assignee, above them). */
  taskDetails(taskId: number): [Task, Message[]] {
    const team = this.team;
    const task = this.store.getTask(taskId);
    if (task === null) throw new HubError(`there is no task #${taskId}`);
    const involved = [task.assigner, task.assignee];
    if (!(involved.includes(this.name) || this.isOwner || involved.some((p) => team.isMember(p) && team.isAbove(this.name, p)))) {
      throw new PermissionDenied(`task #${taskId} is between ${task.assigner} and ${task.assignee}; you can see its status with team_status`);
    }
    return [task, this.store.thread(taskId)];
  }

  /** Tasks you are working on or should start (not the ones still waiting for others). */
  myTasks(): Task[] {
    return this.store.tasks({ assignee: this.name, states: ['open', 'working', 'blocked'] });
  }

  /** Tasks given to you that wait for other tasks before they start. */
  queuedTasks(): Task[] {
    return this.store.tasks({ assignee: this.name, states: ['waiting'] });
  }

  /** Tasks you assigned that are not finished (including those waiting for your review). */
  givenTasks(): Task[] {
    return this.store.tasks({ assigner: this.name, openOnly: true });
  }

  toReview(): Task[] {
    return this.store.tasks({ assigner: this.name, states: ['done'] });
  }

  // memory

  /** Your notes for your next session: what you know and are doing. Replaces the old notes. */
  saveNotes(text: string): void {
    void this.team;
    if (text.length > MAX_TEXT) throw new HubError(`notes are limited to ${MAX_TEXT} characters`);
    this.store.setNotes(this.name, text.trim());
  }

  // looking

  /** Mail woke it: its status says working - on its current task, if it has one. */
  backToWork(): void {
    const task = this.currentTask();
    this.store.setStatus(this.name, 'working', task ? `#${task.id} ${task.title}` : '');
  }

  setStatus(state: string, task = ''): Status {
    void this.team; // refuses a dismissed consultant
    if (!(STATES as readonly string[]).includes(state)) throw new HubError(`state must be one of ${pyList(STATES)}`);
    return this.store.setStatus(this.name, state, task.trim());
  }

  /** Anyone's status and locks; their messages only for yourself and roles below you. */
  view(name: string, recent = 20): RoleView {
    const team = this.team;
    if (!team.isMember(name)) throw new HubError(`'${name}' is not in this team`);
    const full = name === this.name || team.isAbove(this.name, name);
    return {
      name, role: team.roles[name] ?? null, superior: team.superiorOf(name), subordinates: team.subordinatesOf(name),
      status: this.store.getStatus(name), unread: this.store.unreadCount(name),
      recent: full ? this.store.messagesInvolving(name, recent) : [], locks: this.store.locks(name),
      online: this.store.online()[name] ?? 0, limited: !full,
    };
  }

  /** The whole tree with everyone's status, in tree order. Everyone may see this. */
  overview(): Snapshot[] {
    const team = this.team;
    const statuses = this.store.statuses();
    const online = this.store.online();
    const locks = dict<number>();
    for (const lock of this.store.locks()) locks[lock.owner] = (locks[lock.owner] ?? 0) + 1;
    const tasks = dict<Task[]>();
    for (const task of this.store.tasks({ openOnly: true })) (tasks[task.assignee] ??= []).push(task);
    const stuck = dict(Object.entries(this.hub.stuck()).map(([n, info]) => [n, describeStuck(info)] as const));
    const rows: Snapshot[] = [];
    const walk = (name: string, depth: number): void => {
      for (const child of team.subordinatesOf(name)) {
        rows.push({ name: child, depth, role: team.roles[child], status: statuses[child] ?? null, online: online[child] ?? 0,
          locks: locks[child] ?? 0, tasks: tasks[child] ?? [], stuck: stuck[child] ?? '' });
        walk(child, depth + 1);
      }
    };
    walk(team.owner, 0);
    return rows;
  }

  // file leases

  /** The task this role is most likely working on: its most urgent started task. A consultant works on the
   * current task of the agent it helps. */
  currentTask(): Task | null {
    const me = this.team.roles[this.name];
    if (me !== undefined && me.is_consultant) return this.hub.session(me.superior).currentTask();
    const mine = this.myTasks().filter((t) => t.state === 'working');
    if (!mine.length) return null;
    return mine.reduce((a, b) => (b.priority < a.priority || (b.priority === a.priority && b.id < a.id) ? b : a));
  }

  /** Remember that the current task changed `rel`, for its review and its commit. */
  noteEdit(rel: string): void {
    const task = this.currentTask();
    if (task !== null) this.store.addTaskFile(task.id, rel);
  }

  /** Take the lease on a file, or on every file matching a pattern such as src/api/*. */
  claim(p: string, reason = ''): Lock {
    const team = this.team;
    const [key, rel] = this.hub.lockKey(p);
    const me = team.roles[this.name];
    if (me !== undefined && me.is_consultant) {
      throw new PermissionDenied(`consultants can only edit files handed to them. Ask ${me.superior} to hand_over_file ${rel} to you.`);
    }
    if (!this.inScope(team, this.name, rel)) {
      throw new PermissionDenied(`${rel} is outside your write scope (${this.scope(team, this.name).join(', ') || 'nothing'})`);
    }
    if (!reason) {
      const task = this.currentTask();
      if (task !== null) reason = `task #${task.id}`;
    }
    const lock = this.store.claim(key, rel, this.name, isPattern(String(p)), reason.trim().slice(0, 200));
    if (lock.owner !== this.name) throw new LockConflict(`${lock.path} is being written by ${this.heldBy(lock)}`);
    if (!lock.pattern) this.noteEdit(rel);
    this.hub.event('file', this.name, `took ${rel}${lock.reason ? ` (${lock.reason})` : ''}`);
    return lock;
  }

  /** 'worker-b (task #12)', or 'the owner (...)' - whom an agent would take 'you' for. */
  heldBy(lock: Lock): string {
    const who = lock.owner === this.hub.baseTeam.owner ? 'the owner' : lock.owner;
    return who + (lock.reason ? ` (${lock.reason})` : '');
  }

  /** Release a lease. A consultant's release hands the file back to the agent it helps. */
  release(p: string): Lock {
    const team = this.team;
    const [key, rel] = this.hub.lockKey(p);
    const lock = this.store.lockFor(key);
    if (lock === null) {
      const cover = this.store.covering(key);
      if (cover !== null) throw new HubError(`${rel} is covered by ${cover.owner}'s lease on ${cover.path}; release that`);
      throw new HubError(`${rel} is not locked`);
    }
    if (lock.owner !== this.name && !team.isAbove(this.name, lock.owner)) {
      throw new PermissionDenied(`${lock.path} is held by ${lock.owner}; only they or their superiors can release it`);
    }
    const holder = team.roles[lock.owner];
    if (holder !== undefined && holder.is_consultant) return this.store.transfer(key, lock.owner, holder.superior) ?? lock;
    this.store.release(key);
    this.hub.event('file', this.name, `released ${lock.path}`);
    return lock;
  }

  /** Give a lease you hold to your direct superior or one of your direct subordinates. */
  handOver(p: string, to: string): Lock {
    const team = this.team;
    const [key, rel] = this.hub.lockKey(p);
    const lock = this.store.lockFor(key);
    if (lock === null || lock.owner !== this.name) throw new HubError(`you do not hold ${rel}; claim_file it first`);
    if (!team.isMember(to)) throw new PermissionDenied(`'${to}' is not in this team`);
    if (to !== team.superiorOf(this.name) && team.superiorOf(to) !== this.name) {
      throw new PermissionDenied('you can hand files only to your direct superior or a direct subordinate');
    }
    const receiver = team.roles[to];
    // consultants take any file from the agent they help; everyone else keeps to their scope
    if (!(receiver && receiver.is_consultant) && !this.inScope(team, to, rel)) throw new PermissionDenied(`${rel} is outside ${to}'s write scope`);
    const moved = this.store.transfer(key, this.name, to);
    if (moved === null) throw new LockConflict(`${rel} changed hands while handing it over; check list_locks`);
    this.store.addMessage(this.name, to, to === team.superiorOf(this.name) ? 'report' : 'instruction',
      `I handed ${rel} over to you. You may edit it now.`);
    this.hub.event('file', this.name, `handed ${rel} to ${to}`);
    return moved;
  }

  /** True only if this role holds a live lease covering `p`. Used by pre-edit hooks. */
  canWrite(p: string): boolean {
    let key: string;
    try {
      [key] = this.hub.lockKey(p);
    } catch (e) {
      if (e instanceof PermissionDenied) return false;
      throw e;
    }
    const lock = this.store.covering(key);
    return lock !== null && lock.owner === this.name;
  }

  scope(team: Team, name: string): readonly string[] {
    if (name === team.owner) return ['**'];
    const role = team.roles[name];
    if (role.is_consultant && this.hub.branches) return this.scope(team, this.hub.branchRole(name)); // works in the helped copy
    return role.write_scope;
  }

  inScope(team: Team, name: string, rel: string): boolean {
    // '*' matches across folders here, so 'src/*' and 'src/**' both cover all of src.
    return this.scope(team, name).some((p) => fnmatchcase(fold(rel), fold(p.startsWith('./') ? p.slice(2) : p)));
  }

  // consultants

  /** Attach a temporary consultant under the subordinate who sent help request `helpId`. */
  summonConsultant(helpId: number, tier: string, brief = ''): Role {
    const team = this.team;
    const request = this.store.getMessage(helpId);
    if (request === null || request.kind !== 'help' || request.recipient !== this.name) {
      throw new PermissionDenied(`#${helpId} is not a help request sent to you`);
    }
    const helped = request.sender;
    if (!team.isMember(helped)) throw new HubError(`${helped} is no longer in the team`);
    if (team.roles[helped].is_consultant) throw new PermissionDenied('consultants cannot get consultants of their own; help them yourself');
    const spec = team.tiers[tier];
    if (spec === undefined) throw new HubError(`there is no consultant tier '${tier}'. Tiers: ${Object.keys(team.tiers).join(', ') || 'none are configured'}`);
    if (this.store.activeConsultants().some((c) => c.help_id === helpId)) throw new HubError(`a consultant is already working on #${helpId}`);
    const consultant = this.store.addConsultant(tier, spec.harness, spec.model, spec.effort, helped, this.name, helpId, brief.trim(), spec.max_active);
    if (consultant === null) throw new HubError(`all ${spec.max_active} '${tier}' consultants are busy; choose another tier or wait`);
    const role = consultantRole(consultant);
    if (this.hub.opener !== null) {
      try {
        this.hub.opener(role);
      } catch (e) {
        this.store.deleteConsultant(role.name);
        throw new HubError(`could not start ${role.name}: ${(e as Error).message}`);
      }
    }
    let task = `Help ${helped} with its request #${helpId}:\n${request.text}`;
    if (brief.trim()) task += `\n\nBrief from ${this.name}: ${brief.trim()}`;
    this.store.addMessage(this.name, role.name, 'instruction', task, helpId);
    this.store.addMessage(this.name, helped, 'instruction', `${role.name} (${spec.describe()}) will help you with #${helpId}. It is `
      + 'your temporary subordinate: message it with send_message, hand it files to edit with hand_over_file, '
      + 'and dismiss_consultant it when the problem is solved.', helpId);
    this.hub.event('consultant', this.name, `summoned ${role.name} (${tier}) for ${helped}`);
    return role;
  }

  /** Dismiss a consultant. Returns it and the files that went back to the agent it helped. */
  dismissConsultant(name: string): [Role, string[]] {
    const team = this.team;
    const role = team.roles[name];
    if (role === undefined || !role.is_consultant) throw new HubError(`'${name}' is not an active consultant`);
    if (!team.isAbove(this.name, name)) throw new PermissionDenied(`only ${role.superior}, or someone above it, can dismiss ${name}`);
    const returned = this.store.dismissConsultant(name, this.name);
    if (this.name !== role.superior) {
      const back = returned.length ? ` Its files are yours again: ${returned.join(', ')}.` : '';
      this.store.addMessage(this.name, role.superior, 'instruction', `I dismissed ${name}.${back}`);
    }
    this.hub.event('consultant', this.name, `dismissed ${name}`);
    return [role, returned];
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function clock(t: number, withDate: boolean): string {
  const d = new Date(t * 1000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return withDate ? `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')} ${hm}` : hm;
}

/** 'out of its usage limit until 19:20' or 'stopped by an API error'. */
export function describeStuck(info: StuckInfo): string {
  if (info.kind === 'limit') {
    const until = info.until;
    if (!until) return 'out of its usage limit';
    if (until <= now()) return 'its usage limit has reset; it needs a restart';
    return `out of its usage limit until ${clock(until, until - now() >= 20 * 3600)}`;
  }
  return `stopped by an API error: ${String(info.text ?? '').slice(0, 120)}`;
}

/** Claude Code runs Haiku without auto mode (it does not support it): such an agent stops and asks the owner
 * before every edit and command (seen: a Haiku worker sat at "Do you want to create ...?"). */
export function asksOwnerForEverything(harness: string, model: string | null | undefined): boolean {
  return harness === 'claude' && (model ?? '').toLowerCase().includes('haiku');
}

export const NO_HAIKU = 'Claude Haiku has no auto mode, so that agent would stop and ask the owner before every edit and '
  + 'command. Use sonnet, or a cheap model of another program.';

/** `text` ending as a sentence, so what follows it does not run on. */
export function sentence(text: string): string {
  text = text.trim();
  return !text || '.!?'.includes(text[text.length - 1]) ? text : `${text}.`;
}

export function checkText(text: string): string {
  text = String(text ?? '').trim();
  if (!text) throw new HubError('message is empty');
  if (text.length > MAX_TEXT) {
    throw new HubError(`message is ${text.length} characters; the limit is ${MAX_TEXT}. Put long material in a file and send its path instead.`);
  }
  return text;
}

/** How Python printed a value in a message: lists as ['a', 'b']. */
function pyValue(v: unknown): string {
  return Array.isArray(v) ? pyList(v) : String(v);
}

/** Sleep `ms`, or less if `signal` aborts first. */
export function sleep(ms: number, signal: AbortSignal | null = null): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
