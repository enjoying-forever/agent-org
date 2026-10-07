/**
 * Hooks that bring the hub into an agent's own harness.
 *
 * Harnesses run these at fixed moments, passing the event as JSON on stdin. The role comes from
 * AGENT_ORG_TEAM / AGENT_ORG_ROLE, which every start script sets; outside an agent-org tab each hook does
 * nothing. Any failure lets the harness carry on.
 *
 * - stop       The agent is ending its turn. Once per turn, remind it of unfinished duties (its tasks, reviews,
 *              answers it owes). With no task left, its files are released for it. Then wait for new messages
 *              and hand them over, so an idle agent wakes up when mail arrives. In the agent-org window
 *              (AGENT_ORG_STOP_IDLE) a wait that runs out lets the agent rest; the window wakes it later (waker).
 * - post-tool  After each tool call: mention messages that arrived meanwhile, once each.
 * - pre-edit   Before a file edit: the agent must hold the file's lock. A free file in its write scope is
 *              claimed for it; anything else is refused with the reason.
 *
 * Claude agents run post-tool and pre-edit inside their org tool server (mcp_server's hook tool); the other
 * harnesses, and every stop and session hook, run `org-hook <event>` (src/org_hook.ts).
 */

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type Hub, HubError, type RoleSession } from './hub.ts';
import * as safety from './safety.ts';
import * as sessions from './sessions.ts';
import { type Message, now } from './store.ts';
import * as usage from './usage.ts';
import { dict } from './dict.ts';

export const STOP_WAIT = 1800; // seconds a Stop hook waits for messages before letting the agent go round again
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'search_replace',
  'write_file', 'edit_file', 'create_file', 'str_replace_editor',
  // Antigravity
  'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'code_action', 'file_change', 'propose_code', 'edit_notebook']);
const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'target_file', 'filePath', 'targetFile', 'notebookPath',
  'TargetFile', 'AbsolutePath', 'FilePath', 'Path'];
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
const HUB_DIR = '.agent-org';

export type Payload = Record<string, unknown>;
export type HookOut = Record<string, unknown> | null;

/** Claude and Codex send snake_case fields; Grok sends camelCase. */
export function field(payload: Payload, key: string): unknown {
  if (key in payload) return payload[key];
  const [head, ...rest] = key.split('_');
  return payload[head + rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')];
}

export function fmtMessages(messages: Message[]): string {
  return messages.map((m) => `#${m.id} [${m.kind}] from ${m.sender}${m.reply_to ? ` (reply to #${m.reply_to})` : ''}:\n${m.text}`).join('\n\n');
}

export function block(reason: string): Record<string, unknown> {
  return { decision: 'block', reason };
}

// stop

/** What the message law still asks of an agent that is about to go quiet. */
export function dutiesLeft(me: RoleSession): string[] {
  const left: string[] = [];
  // Waiting for the work it gave out is a fine place to stop: their results wake it. (Reminding it cost a whole
  // model call, seen in a real run, only for it to start waiting.)
  const waitingOnOthers = me.givenTasks().some((t) => ['waiting', 'open', 'working'].includes(t.state));
  for (const task of me.myTasks()) {
    if (['open', 'working'].includes(task.state) && !waitingOnOthers) {
      const check = task.done_when ? ` Done when: ${task.done_when}.` : '';
      left.push(`Task #${task.id} from ${task.assigner} (${task.title}) is still open.${check} If it is finished, call `
        + `finish_task(${task.id}, result). If you cannot go on, use outcome "blocked" and say what you need (or `
        + '"failed" / "rejected" with the reason). If you are still working on it or waiting for your own subtasks, carry on.');
    }
  }
  for (const task of me.toReview()) {
    const check = task.done_when ? ` against its 'done when' (${task.done_when})` : '';
    left.push(`Task #${task.id} you gave to ${task.assignee} (${task.title}) is done and waits for your review. `
      + `Check it${check}, then review_task(${task.id}, accept=true), or review_task(${task.id}, accept=false, `
      + 'feedback=...) to send it back.');
  }
  for (const task of me.givenTasks()) {
    if (task.state === 'blocked') {
      left.push(`Task #${task.id} you gave to ${task.assignee} (${task.title}) is blocked: ${task.result.slice(0, 300)}. `
        + `Help them, reassign it, or cancel_task(${task.id}).`);
    }
  }
  for (const request of me.unansweredHelp()) {
    left.push(`${request.sender} asked you for help (#${request.id}) and has no answer yet. Answer with `
      + `send_message(to="${request.sender}", reply_to=${request.id}), pass it up with ask_help(..., `
      + `reply_to=${request.id}), or summon a consultant.`);
  }
  const superior = me.superior;
  const lastWord = me.store.lastMessage({ sender: superior, recipient: me.name, kinds: ['instruction', 'reply'] });
  if (superior && lastWord && !newsOnly(me, lastWord)) {
    const answered = me.store.lastMessage({ sender: me.name, recipient: superior });
    if (answered === null || answered.id < lastWord.id) {
      left.push(`${superior}'s message #${lastWord.id} has no answer from you. If it needs one, send it with `
        + `send_message(to="${superior}", reply_to=${lastWord.id}): ${superior} only receives what you send, not `
        + 'what you write here.');
    }
  }
  return left;
}

/** A task of yours cancelled or moved away: nothing to answer (seen: a reminder cost a model call). */
function newsOnly(me: RoleSession, m: Message): boolean {
  const task = m.task_id !== null ? me.store.getTask(m.task_id) : null;
  return task !== null && (task.state === 'cancelled' || ![task.assignee, task.assigner].includes(me.name));
}

/** An agent resting with no task holds no files: they are released for it, which costs it nothing (its next edit
 * takes a file again). A consultant keeps what it was handed until it is dismissed. */
export function letGoOfFiles(me: RoleSession): void {
  const role = me.team.roles[me.name];
  if (role !== undefined && !role.is_consultant && !me.myTasks().length) me.releaseAll('it rests with no task');
}

function deliver(me: RoleSession, messages: Message[]): Record<string, unknown> {
  me.backToWork();
  // (Not "the sender waits for your reply": that invites an 'ok' to a result, which wakes its sender for nothing -
  // against the law's "no 'thanks' or 'ok' messages".)
  return block(`agent-org: new messages for you. Act on them, then end your turn; later messages are delivered the same way.\n\n${fmtMessages(messages)}`);
}

/** True if this conversation just ran into its subscription's usage limit. */
function outOfUsage(me: RoleSession, payload: Payload): boolean {
  const role = me.hub.team.roles[me.name];
  const sessionId = field(payload, 'session_id') || payload.conversationId;
  if (role === undefined || typeof sessionId !== 'string') return false;
  const s = usage.stuck(role.harness, sessionId);
  return s !== null && s.kind === 'limit' && (s.until ?? 0) > now();
}

export async function onStop(me: RoleSession, payload: Payload, wait: number | null = null, poll = 1.0): Promise<HookOut> {
  if (outOfUsage(me, payload)) return null; // a new turn would fail at once and use up its mail; it is restarted after the reset
  // Mail first: an agent can't finish work it hasn't read yet. (Notes alone wait for real mail.)
  const waiting = me.store.unreadCount(me.name, true) ? me.readInbox() : [];
  if (waiting.length) return deliver(me, waiting);
  if (!field(payload, 'stop_hook_active')) {
    const left = dutiesLeft(me);
    if (left.length) {
      return block(`Before you finish:\n${left.map((x) => `- ${x}`).join('\n')}\nWhen these are done (or don't apply), end your turn again.`);
    }
  }
  letGoOfFiles(me);
  const before = me.store.getStatus(me.name);
  me.setStatus('waiting', before ? before.task : '');
  const messages = await me.waitForMessages(wait ?? stopWait(), poll);
  if (!messages.length && process.env.AGENT_ORG_STOP_IDLE) return null; // in the window: rest; the window wakes it
  if (!messages.length) {
    return block('agent-org: no new messages yet. End your turn again to keep waiting; you will be woken as soon as a message arrives.');
  }
  return deliver(me, messages);
}

export function stopWait(): number {
  const v = Number(process.env.AGENT_ORG_STOP_WAIT ?? STOP_WAIT);
  return Number.isFinite(v) ? v : STOP_WAIT;
}

// post-tool

export function onPostTool(me: RoleSession, _payload: Payload): HookOut {
  me.store.touch(me.name); // progress, for the watchdog
  me.store.renew(me.name); // an agent at work keeps its file leases
  const synced = me.hub.syncRole(me.name); // branch mode: keep its copy close to main
  const fresh = me.store.unnoticed(me.name);
  if (!fresh.length && !synced) return null;
  const urgent = fresh.filter((m) => m.urgent);
  const rest = fresh.filter((m) => !m.urgent);
  const parts = synced ? [synced] : [];
  if (urgent.length) { // urgent messages interrupt the current work, in full
    me.store.markRead(urgent.map((m) => m.id));
    parts.push(`agent-org: URGENT message(s) for you. Deal with them before you continue:\n\n${fmtMessages(urgent)}`);
  }
  if (rest.length) {
    const senders = [...new Set(rest.map((m) => m.sender))].join(', ');
    parts.push(`agent-org: ${rest.length} new message(s) for you from ${senders} (${rest.map((m) => `#${m.id}`).join(', ')}). `
      + 'Read them with the org tool read_inbox at a good stopping point.');
  }
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: parts.join('\n\n') } };
}

// pre-edit

export function toolCall(payload: Payload): [string, unknown] {
  const call = payload.toolCall; // Antigravity: {"toolCall": {"name": ..., "args": {...}}}
  if (typeof call === 'object' && call !== null && !Array.isArray(call)) {
    const c = call as Payload;
    return [String(c.name || ''), c.args || {}];
  }
  return [String(field(payload, 'tool_name') || ''), field(payload, 'tool_input') || {}];
}

export function editedPaths(payload: Payload): string[] {
  const [tool, raw] = toolCall(payload);
  if (!EDIT_TOOLS.has(tool.split('__').pop()!.toLowerCase())) return [];
  const input = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : { input: raw }) as Payload;
  const found = PATH_KEYS.filter((k) => typeof input[k] === 'string').map((k) => input[k] as string);
  for (const value of Object.values(input)) { // apply_patch carries its files inside the patch text
    if (typeof value === 'string' && value.includes('*** ')) {
      for (const m of value.matchAll(PATCH_FILE)) found.push(m[1] || m[2]);
    }
  }
  return [...new Set(found)].map((p) => p.trim()).filter((p) => p);
}

// what the agent is doing, for the owner

const READ_TOOLS = new Set(['read', 'read_file', 'view_file', 'view', 'notebookread', 'read_many_files', 'view_code_item']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'search', 'search_files', 'find_files', 'codebase_search', 'grep_search', 'find_by_name',
  'list_dir', 'ls', 'list_directory', 'file_search']);
const FETCH_TOOLS = new Set(['webfetch', 'web_fetch', 'read_url_content', 'read_url', 'fetch']);
const WEB_SEARCH_TOOLS = new Set(['websearch', 'web_search', 'search_web']);
const HELPER_TOOLS = new Set(['task', 'agent', 'spawn_agent']);
const PLAN_TOOLS = new Set(['todowrite', 'update_plan', 'write_todos']);
const ACTION_CHARS = 140;

/** One line saying what a tool call does, in the owner's words: "$ npm test", "Editing src/app.ts", "Reading
 * README.md". Null when the payload names no tool (Antigravity's model-call hook). Secrets in a command are hidden. */
export function describeAction(payload: Payload, root: string): string | null {
  const [tool, raw] = toolCall(payload);
  if (!tool) return null;
  const parts = tool.split('__');
  const name = parts.at(-1)!.toLowerCase();
  const input = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Payload;
  const text = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const first = (...keys: string[]): string => keys.map((k) => text(input[k])).find((v) => v) ?? '';
  const cwd = String(field(payload, 'cwd') || root);
  const shown = (p: string): string => {
    const full = path.resolve(cwd, p);
    return relativeTo(full, root) ?? full.replace(/\\/g, '/');
  };
  // an org tool, as each program names them (cards.SERVER_NAME; not imported: a hook loads little): its name says it
  const org = /^(?:mcp__org__|mcp_org_|org__|org\.)(\w+)$/.exec(tool);
  let line: string;
  if (org) {
    const to = first('to', 'assignee', 'role', 'name');
    line = `${org[1].toLowerCase().replace(/_/g, ' ')}${to ? ` → ${to}` : ''}`;
  } else if (isShell(tool)) {
    line = `$ ${text(safety.commandOf(raw)) || name}`;
  } else if (EDIT_TOOLS.has(name)) {
    const files = editedPaths(payload).map(shown);
    line = files.length ? `Editing ${files.join(', ')}` : `Editing (${tool})`;
  } else if (READ_TOOLS.has(name)) {
    const file = first(...PATH_KEYS);
    line = file ? `Reading ${shown(file)}` : 'Reading';
  } else if (SEARCH_TOOLS.has(name)) {
    line = `Searching ${first('pattern', 'query', 'Query', 'Pattern', 'regex', 'SearchPath', 'path', 'DirectoryPath') || 'the files'}`;
  } else if (FETCH_TOOLS.has(name)) {
    line = `Reading ${first('url', 'Url', 'URL') || 'a web page'}`;
  } else if (WEB_SEARCH_TOOLS.has(name)) {
    line = `Searching the web: ${first('query', 'Query', 'q')}`;
  } else if (HELPER_TOOLS.has(name)) {
    line = `Running a helper: ${first('description', 'prompt', 'task') || name}`;
  } else if (PLAN_TOOLS.has(name)) {
    line = 'Updating its plan';
  } else {
    line = parts.length > 2 ? `${parts[1]}: ${parts.slice(2).join('__')}` : tool;
  }
  line = safety.maskSecrets(line);
  return line.length > ACTION_CHARS ? `${line.slice(0, ACTION_CHARS - 1)}…` : line;
}

/** Note the call for the owner's page; never in the way of the hook itself. */
function noteAction(me: RoleSession, payload: Payload, running: boolean): void {
  try {
    const what = describeAction(payload, me.hub.rootOf(me.name));
    // Antigravity says only when an edit starts: it is noted as done
    if (what !== null) me.store.noteAction(me.name, what, running && !payload.toolCall);
  } catch {
    // only the page misses it
  }
}

export function isShell(tool: string): boolean {
  return safety.SHELL_TOOLS.has(tool.split('__').pop()!.toLowerCase());
}

export function deny(reason: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

/** Refuse a shell command that publishes, wipes shared work, or deletes outside the project. */
function guardCommand(me: RoleSession, payload: Payload): HookOut {
  const [tool, input] = toolCall(payload);
  if (!isShell(tool) || !me.team.settings.guard_commands) return null;
  const command = safety.commandOf(input);
  const why = safety.checkCommand(command, [me.hub.baseTeam.project_root, me.hub.rootOf(me.name)], !me.hub.branches);
  if (why === null) return null;
  me.hub.event('safety', me.name, `refused a command: ${command.slice(0, 200)}`);
  return deny(`agent-org refused this command. ${why} If it really is needed, ask ${me.superior}.`);
}

function guardProtected(me: RoleSession, rel: string): HookOut {
  if (safety.isProtected(rel, me.hub.team_file ? path.basename(me.hub.team_file) : 'team.yaml')) {
    me.hub.event('safety', me.name, `refused an edit of ${rel}`);
    return deny(`${rel} is the team's own configuration; agents never edit it. If the team needs changing, ask `
      + `${me.superior} (managers have hire_agent / change_agent).`);
  }
  return null;
}

/** `full` relative to `root`, with forward slashes, or null when it lies outside (case does not matter on Windows). */
function relativeTo(full: string, root: string): string | null {
  const rel = path.relative(root, full);
  if (rel === '' ) return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export function onPreEdit(me: RoleSession, payload: Payload): HookOut {
  const refused = guardCommand(me, payload);
  if (refused !== null) return refused;
  if (me.hub.branches) return onPreEditBranch(me, payload);
  const root = me.hub.baseTeam.project_root;
  const cwd = String(field(payload, 'cwd') || root);
  const claimed: string[] = [];
  for (const raw of editedPaths(payload)) {
    const full = path.resolve(cwd, raw);
    const rel = relativeTo(full, root);
    if (rel === null) continue; // outside the project: not the team's business
    if (rel === HUB_DIR || rel.startsWith(`${HUB_DIR}/`)) return deny(`${rel} belongs to the agent-org hub; use the org tools instead of editing it.`);
    const guarded = guardProtected(me, rel);
    if (guarded !== null) return guarded;
    const [key] = me.hub.lockKey(full);
    const lock = me.store.covering(key);
    if (lock !== null && lock.owner === me.name) {
      me.noteEdit(rel);
      continue;
    }
    if (lock !== null) {
      const covered = lock.pattern ? `, whose lease on ${lock.path} covers it` : '';
      const peer = me.peers(me.team).includes(lock.owner) ? ` (or ${lock.owner} directly: you are peers)` : '';
      return deny(`${rel} is being written by ${me.heldBy(lock)}${covered}; only one agent may write a file. Do not `
        + `edit it: ask ${me.superior}${peer}.`);
    }
    try {
      me.claim(full);
    } catch (e) {
      if (e instanceof HubError) return deny(`You may not edit ${rel}: ${e.message}`);
      throw e;
    }
    claimed.push(rel);
  }
  if (claimed.length) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse',
      additionalContext: `agent-org: you now hold the write lock on ${claimed.join(', ')}. It is released for you when your task closes.` } };
  }
  return null;
}

/** Branch mode: an agent edits its own copy freely, within its write scope; no leases. */
function onPreEditBranch(me: RoleSession, payload: Payload): HookOut {
  const root = me.hub.rootOf(me.name);
  const cwd = String(field(payload, 'cwd') || root);
  for (const raw of editedPaths(payload)) {
    const full = path.resolve(cwd, raw);
    const rel = relativeTo(full, root);
    if (rel === null) {
      if (relativeTo(full, me.hub.baseTeam.project_root) !== null) {
        return deny(`Edit your own copy of the project in ${root}, not the shared main folder: your work reaches main `
          + 'when you finish the task (or share_work).');
      }
      continue; // outside the project: not the team's business
    }
    if (rel === '.git' || rel.startsWith('.git/')) return deny("Leave git's own files alone; the hub handles commits and merges.");
    const guarded = guardProtected(me, rel);
    if (guarded !== null) return guarded;
    if (!me.inScope(me.team, me.name, rel)) {
      return deny(`${rel} is outside the files you may write (${me.scope(me.team, me.name).join(', ') || 'none'}). `
        + `Ask ${me.superior} if it needs changing.`);
    }
    me.noteEdit(rel);
  }
  return null;
}

/** Note which conversation the harness is in, so a restarted team can resume it. */
export function rememberSession(me: RoleSession, payload: Payload): void {
  const sessionId = field(payload, 'session_id') || payload.conversationId;
  const role = me.hub.team.roles[me.name];
  if (typeof sessionId === 'string' && sessionId && role !== undefined) {
    // Codex's auto-reviewer runs as its own conversation and fires these hooks too: record the agent's
    // conversation, never the helper's (resuming that gives an agent with no tools).
    const own = sessions.mainSession(role.harness, sessionId);
    if (own) me.store.recordSessionId(me.name, role.harness, own);
  }
}

function onSession(): HookOut {
  return null; // rememberSession already did the work
}

export const HANDLERS: Record<string, (me: RoleSession, payload: Payload) => HookOut | Promise<HookOut>> = dict({
  stop: (me, payload) => {
    me.store.endActions(me.name); // its turn is over
    return onStop(me, payload);
  },
  'post-tool': (me, payload) => {
    noteAction(me, payload, false);
    return onPostTool(me, payload);
  },
  'pre-edit': (me, payload) => {
    const out = onPreEdit(me, payload);
    const refused = (out?.hookSpecificOutput as Payload | undefined)?.permissionDecision === 'deny';
    if (!refused) noteAction(me, payload, true); // a refused call never runs
    return out;
  },
  session: onSession,
  invocation: onPostTool,
});

/** Antigravity's hooks speak a different dialect: translate our answer, and always answer. A pre-tool answer
 * must carry a decision: an edit the lease allows is "allow"; a shell command that passed our guard is "ask", so
 * Antigravity's own permission check still runs. */
export function forAntigravity(event: string, out: HookOut, payload: Payload = {}): Record<string, unknown> {
  const shell = isShell(toolCall(payload)[0]);
  if (!out || !Object.keys(out).length) return event === 'pre-edit' ? { decision: shell ? 'ask' : 'allow' } : {};
  const spec = (out.hookSpecificOutput ?? {}) as Payload;
  if (event === 'stop' && out.decision === 'block') return { decision: 'continue', reason: out.reason ?? '' };
  if (event === 'pre-edit' && spec.permissionDecision === 'deny') return { decision: 'deny', reason: spec.permissionDecisionReason ?? '' };
  if (event === 'pre-edit') return { decision: shell ? 'ask' : 'allow' }; // a missing decision would count as "deny"
  if (event === 'invocation' && spec.additionalContext) return { injectSteps: [{ ephemeralMessage: spec.additionalContext }] };
  return {};
}

export const HOOK_LOG = 'hook-errors.log';

/** Keep the failure next to the hub's database, and in the Activity list, instead of failing. */
export function logError(hub: Hub, event: string, role: string, error: unknown): void {
  const text = error instanceof Error ? error.stack ?? String(error) : String(error);
  try {
    const file = path.join(path.dirname(hub.baseTeam.database), HOOK_LOG);
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    appendFileSync(file, `--- ${stamp} ${role} ${event}\n${text}\n\n`, 'utf8');
    const last = (error instanceof Error ? `${error.name}: ${error.message}` : text).split('\n')[0].slice(0, 160);
    hub.event('agent', role, `a ${event} hook failed (${last}); details in ${file}`);
  } catch {
    // nowhere to say it
  }
}

/** JSON with every non-ASCII character escaped, as Python's json.dumps writes it: hooks talk through consoles
 * whose code page is not always UTF-8. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Run one hook as its own process: read the event from stdin, answer on stdout. */
export async function main(argv: string[], openHub: (teamFile: string) => Hub, input: string | null = null): Promise<number> {
  const event = argv[0] ?? '';
  const antigravity = argv.slice(1).includes('agy');
  const teamFile = process.env.AGENT_ORG_TEAM;
  const role = process.env.AGENT_ORG_ROLE;
  if (!(event in HANDLERS) || !teamFile || !role) {
    if (antigravity) process.stdout.write(event === 'pre-edit' ? '{"decision": "ask"}' : '{}'); // outside our tabs, change nothing
    return 0;
  }
  let payload: Payload = {};
  try {
    const parsed = JSON.parse((input ?? readFileSync(0, 'utf8')) || '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) payload = parsed;
  } catch {
    // no event, or not JSON: an empty one
  }
  if (antigravity && !('stop_hook_active' in payload)) payload.stop_hook_active = Number(payload.executionNum || 1) > 1; // its Stop counts loops
  let out: HookOut = null;
  let hub: Hub | null = null;
  try {
    hub = openHub(teamFile);
  } catch {
    hub = null; // a broken hub must never stop the agent's harness
  }
  if (hub !== null) {
    try {
      const me = hub.session(role);
      rememberSession(me, payload);
      out = await HANDLERS[event](me, payload);
    } catch (e) {
      if (!(e instanceof HubError)) logError(hub, event, role, e); // a HubError: e.g. a dismissed consultant
      out = null;
    } finally {
      hub.close();
    }
  }
  if (antigravity) out = forAntigravity(event, out, payload);
  if (out !== null && (Object.keys(out).length || antigravity)) process.stdout.write(asciiJson(out));
  return 0;
}
