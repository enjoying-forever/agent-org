/**
 * The tool server that gives one agent the tools of its role.
 *
 * Each harness starts its own copy over stdio, bound to one role. It speaks the small part of MCP that tools
 * need (initialize, tools/list, tools/call, ping, cancellation) with nothing but Node. Tool calls run
 * concurrently, so a long wait_for_messages never blocks pings or other calls.
 */

import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { HOOK_TOOL, roleCard, SERVER_NAME } from './cards.ts';
import * as hooks from './hooks.ts';
import { BROADCAST, Hub, HubError, OUTCOMES, type RoleSession } from './hub.ts';
import * as presets from './presets.ts';
import type { Lock, Message } from './store.ts';
import { HARNESSES, TeamError, type Role } from './team.ts';
import { dict } from './dict.ts';

export const FALLBACK_PROTOCOL = '2025-06-18';
export const DEFAULT_WAIT = 1800; // seconds; launchers raise each harness's tool timeout above this
export const HEARTBEAT = 10; // seconds between presence check-ins; the hub counts a role as running for 30

type Args = Record<string, unknown>;
type Handler = (args: Args, signal: AbortSignal | null) => string | Promise<string>;
interface Spec { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[] } }

/** A required argument that is missing (Python's KeyError). */
class MissingArgument extends Error {}
/** An argument of the wrong kind (Python's ValueError / TypeError). */
class BadArgument extends Error {}

function need(args: Args, key: string): unknown {
  if (args[key] === undefined || args[key] === null) throw new MissingArgument(key);
  return args[key];
}

function str(args: Args, key: string): string {
  return String(need(args, key));
}

function int(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*-?\d+\s*$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n)) throw new BadArgument(`invalid literal for int() with base 10: ${JSON.stringify(value)}`);
  return n;
}

const opt = (args: Args, key: string): string => (args[key] === undefined || args[key] === null ? '' : String(args[key]));

function fmtMessage(m: Message): string {
  return `#${m.id} [${m.kind}] from ${m.sender} to ${m.recipient}${m.reply_to ? ` (reply to #${m.reply_to})` : ''}:\n${m.text}`;
}

function fmtMessages(messages: Message[], empty: string): string {
  return messages.length ? messages.map(fmtMessage).join('\n\n') : empty;
}

function fmtLock(lock: Lock): string {
  return `${lock.path} (held by ${lock.owner}${lock.reason ? `, ${lock.reason}` : ''})`;
}

/** Names models reach for instead of a tool's own (seen: assign_task(description=...) lost the details). */
const ARG_ALIASES: Record<string, string[]> = dict({
  description: ['details', 'summary', 'text'], body: ['text', 'details'], content: ['text', 'details'],
  message: ['text'], msg: ['text'], instructions: ['details'], task: ['title', 'task_id'],
  recipient: ['to'], assignee: ['to'], role: ['to', 'name'], id: ['task_id'], task_number: ['task_id'],
  summary: ['result', 'text'], status: ['state', 'outcome'], comment: ['feedback', 'reason'],
  acceptance: ['done_when'], acceptance_criteria: ['done_when'], done_criteria: ['done_when'],
  file: ['path'], file_path: ['path'],
});

/** The tool catalogue, bound to one role. */
export class Tools {
  readonly me: RoleSession;
  readonly specs: Spec[] = [];
  private readonly handlers = new Map<string, Handler>();

  constructor(me: RoleSession) {
    this.me = me;
    const text = { type: 'string' };
    const reply = { type: 'integer', description: 'id of the message you are answering' };

    this.add('my_role', 'Show your role, duties, superior, team and the rules you work under.', {}, [],
      () => roleCard(me) + this.reference());
    this.add('team_status', 'The whole team: who reports to whom, what each does, who is running.', {}, [], () => this.teamStatus());
    this.add('send_message', "Message your superior, a peer (same superior) or anyone below you, or answer anyone who wrote to you "
      + "(reply_to). to='@team': your direct subordinates; '@all': everyone below you. Every message wakes its receiver: "
      + 'send only what they need.',
      { to: text, text, reply_to: reply, urgent: { type: 'boolean', description: 'going down only: interrupts their work' } },
      ['to', 'text'], (a) => this.send(a));
    this.add('list_tasks', 'Your tasks, and the unfinished tasks you gave (those to review too).', {}, [], () => this.listTasks());
    this.add('finish_task', "Close your task. outcome: 'done' (it meets its 'done when': say what you did and where), "
      + "'blocked' (say what you need), 'failed' (why) or 'rejected' (not yours to do: why). Its assigner is told. 'done' "
      + "is refused until the team's checks pass. Closing your last task releases your files.",
      { task_id: { type: 'integer' }, result: text, outcome: { type: 'string', enum: [...OUTCOMES] } },
      ['task_id', 'result'], (a) => this.finish(a));
    this.add('task_details', 'A task and its whole conversation.', { task_id: { type: 'integer' } }, ['task_id'], (a) => this.details(a));
    this.add('search_messages', 'Search the messages you may read.', { words: text }, ['words'],
      (a) => fmtMessages(me.search(str(a, 'words')), 'Nothing found.'));
    this.add('save_notes', 'Replace your notes: what you know, decided and are doing. A new session of yours starts from them.',
      { text }, ['text'], (a) => {
        me.saveNotes(str(a, 'text'));
        return 'Notes saved.';
      });
    this.add('ask_help', 'Ask your direct superior for help.', { question: text, reply_to: reply }, ['question'],
      (a) => `Sent ${fmtMessage(me.askHelp(str(a, 'question'), a.reply_to == null ? null : int(a.reply_to)))}`);
    this.add('read_inbox', 'Your new messages (each returned once).', {}, [], () => fmtMessages(me.readInbox(), 'No new messages.'));
    this.add('wait_for_messages', 'Wait for your next message and return it - while you wait for results (no cost meanwhile).',
      { timeout_seconds: { type: 'integer', description: `default ${DEFAULT_WAIT}` } }, [], (a, signal) => this.wait(a, signal));
    this.add('set_status', 'Say what you are doing, if it is more than your task (the hub sets that by itself when you read a task '
      + 'and when you finish it).', { state: { type: 'string', enum: ['idle', 'working', 'waiting', 'blocked', 'done'] }, task: text },
      ['state'], (a) => {
        const s = me.setStatus(str(a, 'state'), opt(a, 'task'));
        return `Status: ${s.state}${s.task ? ` - ${s.task}` : ''}`;
      });
    this.add('view', "A role's status and files; its messages too if it is you or below you.", { role: text }, ['role'], (a) => this.view(a));
    this.add('claim_file', 'Reserve a file, or a folder pattern like src/api/*, before editing (editing a free file in your scope '
      + 'takes it anyway). A lease ends after an hour idle.',
      { path: { type: 'string', description: 'relative to the project folder' }, reason: { type: 'string', description: 'e.g. task #12' } },
      ['path'], (a) => {
        const lock = me.claim(str(a, 'path'), opt(a, 'reason'));
        return `You now hold ${lock.path}${lock.reason ? ` (${lock.reason})` : ''}.`;
      });
    this.add('release_file', 'Release a lease held by you or someone below you (path as claimed).', { path: text }, ['path'],
      (a) => `Released ${me.release(str(a, 'path')).path}`);
    this.add('list_locks', 'Who is writing which files.', {}, [], () => me.store.locks().map(fmtLock).join('\n') || 'No files are locked.');
    this.add('hand_over_file', 'Give a file you hold to your superior or a direct subordinate (e.g. your consultant).',
      { path: text, to: text }, ['path', 'to'], (a) => `Handed over ${fmtLock(me.handOver(str(a, 'path'), str(a, 'to')))}`);

    const team = me.team;
    const role = team.roles[me.name];
    if (role !== undefined && role.is_consultant) return; // consultants neither assign work, summon nor dismiss
    if (team.subordinatesOf(me.name).some((s) => !team.roles[s].is_consultant)) {
      this.add('assign_task', 'Give someone below you one clear, self-contained task. They finish_task it; you review_task the result.', {
        to: text, title: { type: 'string', description: 'one line' }, details: { type: 'string', description: 'all they need to do it' },
        done_when: { type: 'string', description: "how anyone can check it, e.g. 'pytest passes'" },
        after: { type: 'array', items: { type: 'integer' }, description: 'task ids to wait for' },
        priority: { type: 'integer', enum: [1, 2, 3], description: '1 urgent, 2 normal, 3 low' },
        part_of: { type: 'integer', description: 'your own task this is a piece of' },
      }, ['to', 'title'], (a) => this.assign(a));
      this.add('review_task', 'Accept a done task you gave, or send it back with specific feedback.',
        { task_id: { type: 'integer' }, accept: { type: 'boolean' }, feedback: text }, ['task_id', 'accept'], (a) => {
          const task = me.reviewTask(int(need(a, 'task_id')), Boolean(need(a, 'accept')), opt(a, 'feedback'));
          return task.state === 'accepted' ? `Task #${task.id} accepted.` : `Task #${task.id} sent back to ${task.assignee} (round ${task.revisions}).`;
        });
      this.add('cancel_task', 'Withdraw a task you gave (or one below you).', { task_id: { type: 'integer' }, reason: text }, ['task_id'], (a) => {
        const task = me.cancelTask(int(need(a, 'task_id')), opt(a, 'reason'));
        if (task.started_at === null) return `Task #${task.id} is cancelled before ${task.assignee} started it.`; // nothing was sent
        return `Task #${task.id} is cancelled; ${task.assignee} has been told.`;
      });
      this.add('reassign_task', 'Move an unfinished task below you to another agent below you (say its assignee is out of usage: '
        + 'prefer another program). Its leases and history go with it.',
        { task_id: { type: 'integer' }, to: text, reason: { type: 'string', description: 'the new assignee reads it' } }, ['task_id', 'to'], (a) => {
          const task = me.reassignTask(int(need(a, 'task_id')), str(a, 'to'), opt(a, 'reason'));
          return `Task #${task.id} is now ${task.assignee}'s (${task.state}); both have been told.`;
        });
    }
    if (team.settings.team_changes && (team.subordinatesOf(me.name).length || me.name === team.leader)) {
      const roleProps = {
        duties: text,
        model: { type: 'string', description: "e.g. sonnet, gpt-6-luna, gemini-3.8-flash-medium; empty: the program's default" },
        effort: text,
        write_scope: { type: 'array', items: { type: 'string' }, description: 'files it may write, e.g. ["src/*"]; [] for none' },
      };
      this.add('hire_agent', 'Add an agent under you (or below you); it starts at once. Pick the cheapest program and model that can '
        + "do the work: every agent uses the owner's subscriptions.", {
        name: text, harness: { type: 'string', enum: [...HARNESSES] }, superior: { type: 'string', description: 'default: you' },
        preset: { type: 'string', enum: presets.names(), description: "a role from the owner's library to start from; what else you give overrides it" },
        instructions: { type: 'string', description: 'how it should work' }, ...roleProps,
      }, ['name'], (a) => this.hired(me.hire(str(a, 'name'), {
        harness: opt(a, 'harness'), duties: opt(a, 'duties'), model: opt(a, 'model'), effort: opt(a, 'effort'),
        write_scope: Array.isArray(a.write_scope) ? a.write_scope.map(String) : null, superior: opt(a, 'superior'),
        preset: opt(a, 'preset'), instructions: opt(a, 'instructions'),
      })));
      this.add('change_agent', 'Change an agent below you: duties, files, model or effort (from its next start), or its superior.',
        { name: text, superior: text, ...roleProps }, ['name'], (a) => {
          const changed = me.changeRole(str(a, 'name'), {
            duties: a.duties == null ? null : String(a.duties), model: a.model == null ? null : String(a.model),
            effort: a.effort == null ? null : String(a.effort),
            write_scope: Array.isArray(a.write_scope) ? a.write_scope.map(String) : null, superior: a.superior == null ? null : String(a.superior),
          });
          return `Changed ${changed.name}.`;
        });
      this.add('let_go_agent', 'Remove an agent below you whose work is over (move or cancel its tasks first). Its subordinates move up.',
        { name: text, reason: text }, ['name'], (a) => {
          const moved = me.letGo(str(a, 'name'), opt(a, 'reason'));
          return `Let go of ${a.name}.${moved.length ? ` ${moved.join(', ')} now report to its superior.` : ''}`;
        });
    }
    if (team.canSummon(me.name)) {
      const tiers = Object.values(team.tiers).map((t) => (t.use_for ? `${t.describe()}: ${t.use_for}` : t.describe())).join('; ');
      this.add('summon_consultant', "When a subordinate's help request is too hard for it, attach a temporary consultant under that "
        + `subordinate. Pick the cheapest tier that can solve it. Tiers: ${tiers}`, {
        help_id: { type: 'integer', description: 'id of the help request you received' }, tier: { type: 'string', enum: Object.keys(team.tiers) },
        brief: { type: 'string', description: 'your notes for the consultant' },
      }, ['help_id', 'tier'], (a) => {
        const r = me.summonConsultant(int(need(a, 'help_id')), str(a, 'tier'), opt(a, 'brief'));
        return `Summoned ${r.name} (${r.tier}, ${r.harness}) under ${r.superior}. It has the request and your brief, and ${r.superior} has been told.`;
      });
    }
    if (me.hub.branches) {
      this.add('share_work', 'Put your work so far into main now, without finishing a task - for something others need before you are '
        + 'done (an interface, a plan, shared types). The hub merges the latest main into your copy, runs the checks, and lands your work.',
        { summary: { type: 'string', description: 'what you are sharing, in one line' } }, ['summary'],
        async (a) => `Shared: your work is in main as ${await me.shareWork(str(a, 'summary'))}.`);
    }
    if (Object.keys(team.tiers).length) { // no tiers: there will never be a consultant to dismiss
      this.add('dismiss_consultant', 'Dismiss a consultant working for you (or below you) once its problem is solved; its files go back '
        + 'to the agent it helped.', { name: text }, ['name'], (a) => {
        const [r, returned] = me.dismissConsultant(str(a, 'name'));
        return `Dismissed ${r.name}.${returned.length ? ` Files returned to ${r.superior}: ${returned.join(', ')}.` : ''}`;
      });
    }
  }

  /** For a program that keeps tool descriptions out of the model's sight (Antigravity writes them to files it must
   * open, one by one): every tool with its arguments, so it can call them at once. */
  reference(): string {
    const role = this.me.hub.team.roles[this.me.name];
    if (role === undefined || role.harness !== 'antigravity') return '';
    const lines = ['', `YOUR TEAM TOOLS (call_mcp_tool, ServerName "agent-org_${SERVER_NAME}"; '?' marks an optional argument; no need to open their files):`];
    for (const spec of this.specs) {
      const required = spec.inputSchema.required;
      const args = Object.keys(spec.inputSchema.properties).map((a) => (required.includes(a) ? a : `${a}?`));
      lines.push(`- ${spec.name}(${args.join(', ')})`);
    }
    return lines.join('\n');
  }

  props(name: string): string[] {
    const spec = this.specs.find((s) => s.name === name);
    return spec ? Object.keys(spec.inputSchema.properties) : [];
  }

  /** The arguments under the names the tool knows: a common other name (description for details, message for
   * text...) is taken as the one it stands for. Returns them, and the ones left unknown. */
  fitArgs(name: string, args: Args): [Args, string[]] {
    const props = this.props(name);
    const fitted: Args = {};
    const unknown: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (props.includes(key)) {
        fitted[key] = value;
        continue;
      }
      const meant = (ARG_ALIASES[key] ?? []).find((p) => props.includes(p) && !(p in args));
      if (meant !== undefined) fitted[meant] = value;
      else unknown.push(key);
    }
    const types = this.types(name);
    for (const [key, value] of Object.entries(fitted)) { // 4 for "4" and "4" for 4: no call refused (and redone) for it
      const want = types[key];
      if (want === 'string' && typeof value === 'number') fitted[key] = String(value);
      else if (want === 'integer' && typeof value === 'string' && /^\s*#?\d+\s*$/.test(value)) fitted[key] = Number(value.trim().replace(/^#/, ''));
      else if (want === 'boolean' && typeof value === 'string' && /^(true|false)$/i.test(value.trim())) fitted[key] = value.trim().toLowerCase() === 'true';
    }
    return [fitted, unknown];
  }

  private types(name: string): Record<string, string> {
    const spec = this.specs.find((s) => s.name === name);
    return dict(Object.entries(spec?.inputSchema.properties ?? {}).map(([k, v]) => [k, String(v.type ?? '')] as const));
  }

  private add(name: string, description: string, props: Record<string, Record<string, unknown>>, required: string[], handler: Handler): void {
    this.specs.push({ name, description, inputSchema: { type: 'object', properties: props, required } });
    this.handlers.set(name, handler);
  }

  private async wait(args: Args, signal: AbortSignal | null): Promise<string> {
    const timeout = Math.max(1, args.timeout_seconds == null ? DEFAULT_WAIT : int(args.timeout_seconds) || DEFAULT_WAIT);
    const before = this.me.store.getStatus(this.me.name);
    this.me.setStatus('waiting', before ? before.task : '');
    const messages = await this.me.waitForMessages(timeout, 0.5, signal);
    if (messages.length) this.me.backToWork();
    return fmtMessages(messages, `No messages in ${timeout} seconds. Call wait_for_messages again.`);
  }

  private send(args: Args): string {
    const to = str(args, 'to');
    const urgent = Boolean(args.urgent);
    if (to in BROADCAST) return `Sent to ${this.me.broadcast(to, str(args, 'text'), urgent).map((m) => m.recipient).join(', ')}.`;
    const m = this.me.send(to, str(args, 'text'), args.reply_to == null ? null : int(args.reply_to), urgent);
    let text = `Sent #${m.id} (${m.kind}) to ${m.recipient}.`;
    if (!this.me.store.online()[m.recipient] && m.recipient !== this.me.team.owner) {
      text += ` ${m.recipient} is not running right now; it will get this when it starts.`;
    }
    return text;
  }

  private assign(args: Args): string {
    const after = args.after == null ? [] : (Array.isArray(args.after) ? args.after : [args.after]).map(int);
    const task = this.me.assignTask(str(args, 'to'), str(args, 'title'), opt(args, 'details'), args.part_of == null ? null : int(args.part_of),
      opt(args, 'done_when'), after, args.priority == null ? 2 : int(args.priority) || 2);
    const start = task.state === 'waiting' ? `It starts when #${task.depends_on.join(', #')} are done.` : 'They have it now.';
    const hint = task.done_when ? '' : ' (Tip: give tasks a done_when, so the result can be checked.)';
    return `Assigned task #${task.id} to ${task.assignee}: ${task.title}. ${start}${hint}`;
  }

  private details(args: Args): string {
    const [task, thread] = this.me.taskDetails(int(need(args, 'task_id')));
    const lines = [`Task #${task.id} [${task.state}] ${task.assigner} -> ${task.assignee}: ${task.title}`];
    if (task.depends_on.length) lines.push(`after: #${task.depends_on.join(', #')}`);
    if (task.done_when) lines.push(`done when: ${task.done_when}`);
    if (task.details) lines.push('', task.details);
    if (task.result) lines.push('', `result: ${task.result}`);
    lines.push('', 'Thread:', fmtMessages(thread, '(no messages)'));
    return lines.join('\n');
  }

  private async finish(args: Args): Promise<string> {
    const task = await this.me.finishTask(int(need(args, 'task_id')), str(args, 'result'), opt(args, 'outcome') || 'done');
    const told = task.assigner === this.me.team.owner ? 'the owner' : task.assigner; // the owner may be called "you"
    const freed = this.me.released.length ? ` Your files are released (${this.me.released.join(', ')}).` : '';
    return `Task #${task.id} is ${task.state}; ${told} has been told.${freed}`;
  }

  private hired(role: Role): string {
    return `Hired ${role.name} (${role.harness}${role.model ? `, ${role.model}` : ''}), reporting to ${role.superior}. `
      + 'Its tab is opening; give it work with assign_task.';
  }

  private listTasks(): string {
    const mine = this.me.myTasks();
    const queued = this.me.queuedTasks();
    const given = this.me.givenTasks();
    const lines = [mine.length ? 'Your tasks:' : 'You have no tasks to do.'];
    lines.push(...mine.map((t) => `  #${t.id} [${t.state}] from ${t.assigner}: ${t.title}${t.done_when ? ` (done when: ${t.done_when})` : ''}`));
    if (queued.length) {
      lines.push('Queued for you (they start when what they wait for is done):');
      lines.push(...queued.map((t) => `  #${t.id} after #${t.depends_on.join(', #')}: ${t.title}`));
    }
    if (given.length) {
      lines.push('Tasks you gave that are not finished:');
      lines.push(...given.map((t) => `  #${t.id} [${t.state === 'done' ? 'waits for your review' : t.state}] to ${t.assignee}: ${t.title}`
        + (t.state === 'blocked' ? ` -- ${t.result.slice(0, 200)}` : '')));
    }
    return lines.join('\n');
  }

  private teamStatus(): string {
    const lines = [`${this.me.team.owner} (owner)`];
    for (const row of this.me.overview()) {
      const s = row.status;
      const state = s ? `${s.state}${s.task ? ` - ${s.task}` : ''}` : 'not started';
      const running = row.online ? '' : ', not running';
      const temp = row.role.is_consultant ? `, consultant (${row.role.tier})` : '';
      const files = row.locks ? `, writing ${row.locks} file(s)` : '';
      const stuck = row.stuck ? ` -- ${row.stuck.toUpperCase()}` : '';
      const you = row.name === this.me.name ? '  <- you' : '';
      const indent = '  '.repeat(row.depth + 1);
      lines.push(`${indent}${row.name} [${row.role.harness}${temp}${running}]: ${state}${files}${stuck}${you}`);
      lines.push(...row.tasks.map((t) => `${indent}    task #${t.id} [${t.state}] from ${t.assigner}: ${t.title}`));
    }
    return lines.join('\n');
  }

  private view(args: Args): string {
    const v = this.me.view(str(args, 'role'));
    const lines = [`${v.name}: superior ${v.superior || '-'}, subordinates ${v.subordinates.join(', ') || '-'}`, v.online ? 'running' : 'not running'];
    if (v.status) lines.push(`status: ${v.status.state}${v.status.task ? ` - ${v.status.task}` : ''}`);
    lines.push(`locks: ${v.locks.map((x) => x.path).join(', ') || '-'}`);
    if (v.limited) {
      lines.push('(Its messages are visible only to itself and the roles above it.)');
    } else {
      lines.push(`unread messages: ${v.unread}`);
      if (v.recent.length) lines.push('recent messages:', fmtMessages(v.recent, ''));
    }
    return lines.join('\n');
  }

  /** A line about messages that arrived since the agent was last told, if any. */
  private mailNotice(): string {
    let fresh: Message[];
    try {
      fresh = this.me.store.unnoticed(this.me.name);
    } catch (e) {
      if (e instanceof HubError) return '';
      throw e;
    }
    if (!fresh.length) return '';
    const senders = [...new Set(fresh.map((m) => m.sender))].join(', ');
    return `\n\n[agent-org] ${fresh.length} new message(s) for you from ${senders} (${fresh.map((m) => `#${m.id}`).join(', ')}). Read them with read_inbox.`;
  }

  /** One of Claude Code's hooks (launch's mcpHook), run here rather than in a process of its own. Its answer is
   * what the command hook would print: JSON, or nothing. It never fails the call: a failing hook is logged. */
  async hook(args: Args): Promise<string> {
    const event = String(args.event ?? '');
    const handler = hooks.HANDLERS[event];
    if (handler === undefined) return '';
    let toolInput: unknown;
    try {
      toolInput = JSON.parse(String(args.tool_input || '{}')); // Claude Code hands it over as JSON text
    } catch {
      toolInput = {};
    }
    const payload: hooks.Payload = {
      session_id: String(args.session_id ?? ''), tool_name: String(args.tool_name ?? ''),
      tool_input: typeof toolInput === 'object' && toolInput !== null && !Array.isArray(toolInput) ? toolInput : {}, cwd: String(args.cwd ?? ''),
    };
    let out: hooks.HookOut;
    try {
      hooks.rememberSession(this.me, payload);
      out = await handler(this.me, payload);
    } catch (e) {
      if (!(e instanceof HubError)) hooks.logError(this.me.hub, event, this.me.name, e); // a HubError: e.g. a dismissed consultant
      return '';
    }
    return out && Object.keys(out).length ? JSON.stringify(out) : '';
  }

  async call(name: string, rawArgs: unknown, signal: AbortSignal | null = null): Promise<[string, boolean]> {
    const given = typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs) ? (rawArgs as Args) : {};
    if (name === HOOK_TOOL) return [await this.hook(given), false]; // not a tool of the model's: no argument checks, no mail line
    const handler = this.handlers.get(name);
    if (handler === undefined) return [`Unknown tool: ${name}`, true];
    const [args, unknown] = this.fitArgs(name, given);
    if (unknown.length) { // an argument it has no use for would be dropped without a word: say so instead
      return [`Unknown argument ${unknown.join(', ')} for ${name}. It takes: ${this.props(name).join(', ') || 'no arguments'}.`, true];
    }
    let text: string;
    let isError = false;
    try {
      text = await handler(args, signal);
    } catch (e) {
      isError = true;
      if (e instanceof MissingArgument) text = `Missing argument: ${e.message}`;
      else if (e instanceof BadArgument) text = `Bad argument: ${e.message}`;
      else if (e instanceof HubError) text = `Refused: ${e.message}`;
      else throw e;
    }
    if (name !== 'read_inbox' && name !== 'wait_for_messages') text += this.mailNotice();
    return [text, isError];
  }
}

const CARD_IN_SYSTEM_PROMPT = ['claude', 'codex', 'grok']; // launch gives these the role card as system prompt
const SHORT_INSTRUCTIONS = 'These are your agent-org team tools. Your role card - who you are, your team and the message law - '
  + 'is in your system prompt; call my_role if you need it again.';

/** What the server tells a program at the start (Claude Code adds it to the system prompt). A program that has the
 * role card as its system prompt gets a pointer, not the card a second time. */
export function serverInstructions(me: RoleSession): string {
  const role = me.hub.team.roles[me.name];
  if (role !== undefined && CARD_IN_SYSTEM_PROMPT.includes(role.harness)) return SHORT_INSTRUCTIONS;
  return roleCard(me) + new Tools(me).reference();
}

type Msg = Record<string, any>;

/** JSON-RPC over stdio: one JSON message per line in, one per line out. */
export class Server {
  readonly me: RoleSession;
  readonly tools: Tools;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly inFlight = new Map<unknown, AbortController>();
  private readonly running = new Set<Promise<void>>();
  private readonly waits = new Set<unknown>();

  constructor(me: RoleSession, input: Readable = process.stdin, output: Writable = process.stdout) {
    this.me = me;
    this.tools = new Tools(me);
    this.input = input;
    this.output = output;
  }

  /** Serve until the harness closes stdin; then stop open waits (leaving their messages unread) and let other
   * running calls finish. */
  async serve(): Promise<void> {
    const lines = createInterface({ input: this.input, crlfDelay: Infinity });
    for await (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      for (const item of Array.isArray(msg) ? msg : [msg]) {
        if (typeof item === 'object' && item !== null) this.dispatch(item as Msg);
      }
    }
    for (const id of this.waits) this.inFlight.get(id)?.abort();
    await Promise.race([Promise.allSettled([...this.running]), new Promise((r) => setTimeout(r, 5000).unref())]);
  }

  private dispatch(msg: Msg): void {
    const { method, id } = msg;
    const params: Msg = msg.params ?? {};
    if (method === 'notifications/cancelled') {
      this.inFlight.get(params.requestId)?.abort();
      return;
    }
    if (method === undefined || id === undefined || id === null) return; // another notification, or a response
    if (method === 'initialize') {
      const requested = params.protocolVersion;
      this.reply(id, {
        protocolVersion: typeof requested === 'string' ? requested : FALLBACK_PROTOCOL,
        capabilities: { tools: {} }, serverInfo: { name: 'agent-org', version: '0.3.0' }, instructions: serverInstructions(this.me),
      });
    } else if (method === 'ping') {
      this.reply(id, {});
    } else if (method === 'tools/list') {
      this.reply(id, { tools: this.tools.specs });
    } else if (method === 'tools/call') {
      const control = new AbortController();
      this.inFlight.set(id, control);
      if (params.name === 'wait_for_messages') this.waits.add(id);
      const run = this.call(id, params, control).finally(() => this.running.delete(run));
      this.running.add(run);
    } else {
      this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  }

  private async call(id: unknown, params: Msg, control: AbortController): Promise<void> {
    let text: string;
    let isError: boolean;
    try {
      [text, isError] = await this.tools.call(String(params.name ?? ''), params.arguments ?? {}, control.signal);
    } catch (e) {
      [text, isError] = [`Internal error:\n${e instanceof Error ? e.stack : String(e)}`, true];
    } finally {
      this.inFlight.delete(id);
      this.waits.delete(id);
    }
    if (!control.signal.aborted) this.reply(id, { content: [{ type: 'text', text }], isError }); // MCP: no answer to a cancelled request
  }

  private reply(id: unknown, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  private send(msg: unknown): void {
    this.output.write(`${JSON.stringify(msg)}\n`);
  }
}

/** A tool-less server for sessions that are not part of an agent-org team. */
export async function serveIdle(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const write = (msg: unknown): void => { output.write(`${JSON.stringify(msg)}\n`); };
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    let msg: Msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg !== 'object' || msg === null || msg.id === undefined || msg.id === null) continue;
    if (msg.method === 'initialize') {
      const requested = msg.params?.protocolVersion;
      write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: typeof requested === 'string' ? requested : FALLBACK_PROTOCOL,
        capabilities: { tools: {} }, serverInfo: { name: 'agent-org', version: '0.3.0' },
        instructions: 'This session is not part of an agent-org team, so the org tools are off.' } });
    } else if (msg.method === 'tools/list') {
      write({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
    } else if (msg.method === 'ping') {
      write({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  }
}

/** How a server started for a team reaches the launcher: opening a hired agent's tab, ending a let-go one's
 * program. Given by the launcher's module (which imports this one's constants), so it is passed in. */
export interface Launcher { attach(hub: Hub, teamPath: string): void }

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** Serve one role. Harnesses whose MCP config is shared by every session in a folder (Grok) start the server
 * without arguments; it then takes the role from the start script's environment. */
export async function main(argv: string[] = process.argv.slice(2), launcher: Launcher | null = null): Promise<number> {
  const teamPath = option(argv, '--team') ?? process.env.AGENT_ORG_TEAM;
  const roleName = option(argv, '--role') ?? process.env.AGENT_ORG_ROLE;
  if (!teamPath || !roleName) {
    // Started by a harness outside an agent-org tab (a project-wide config such as Antigravity's plugin):
    // offer no tools rather than fail loudly.
    await serveIdle();
    return 0;
  }
  let hub: Hub;
  let me: RoleSession;
  try {
    hub = Hub.open(teamPath);
    launcher?.attach(hub, path.resolve(teamPath));
    me = hub.session(roleName);
  } catch (e) {
    if (!(e instanceof TeamError || e instanceof HubError)) throw e;
    process.stderr.write(`agent-org: ${e.message}
`);
    return 2;
  }
  // Check in while this session lives, so the team and the UI can see who is running.
  const pid = process.pid;
  hub.store.checkIn(pid, roleName, process.ppid);
  const heartbeat = setInterval(() => {
    try {
      hub.store.checkIn(pid, roleName);
    } catch {
      // a busy database must not kill the session
    }
  }, HEARTBEAT * 1000);
  try {
    await new Server(me).serve();
  } finally {
    clearInterval(heartbeat);
    hub.store.checkOut(pid);
    hub.close();
  }
  return 0;
}
