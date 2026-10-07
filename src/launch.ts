/**
 * Start agents: one visible terminal per role, each running its real harness.
 *
 *     org_launch --team path/to/team.yaml            # every role + an owner tab
 *     org_launch --team path/to/team.yaml leader     # just some roles
 *     org_launch --team path/to/team.yaml --dry-run  # write scripts, open nothing
 *
 * For each role it writes .agent-org/launch/<role>/start.ps1 (plus the files that script needs) and opens it in
 * a Windows Terminal tab, or the agent-org window runs it in a terminal of its own. A start.ps1 also runs in any
 * PowerShell 7 window.
 */

import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { HOOK_TOOL, roleCard, SERVER_NAME } from './cards.ts';
import { STOP_WAIT } from './hooks.ts';
import { asksOwnerForEverything, Hub, HubError, type Opener } from './hub.ts';
import { entry, hookCommand, inTest, nodeCommand, nodeEnv, postSync, registryValues, which } from './runtime.ts';
import * as sessions from './sessions.ts';
import type { Role, Team } from './team.ts';
import * as templates from './templates.ts';
import { networkEnv } from './terminals.ts';
import { DSH_USAGE } from './usage.ts';
import { dict } from './dict.ts';

export { HOOK_TOOL };
export const WINDOW = 'agent-org';
export const WAIT_LIMIT = 3600; // seconds a single wait_for_messages call may take; harness tool timeouts are set to this
export const TAB_COLORS: Record<string, string> = dict({ claude: '#D97757', codex: '#10A37F', grok: '#8B8B8B', antigravity: '#4285F4',
  deepseek: '#4D6BFE', owner: '#F2C94C' });

export interface Launch {
  role: string;
  harness: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  setup: string[][]; // commands run first, in the project folder
  cwd: string | null; // where it works (branch mode: its own worktree); default the project folder
  script: string | null; // PowerShell that runs it, when one command line is not enough (DeepSeek)
}

function launch(role: string, harness: string, command: string, args: string[], env: Record<string, string> = {},
  more: Partial<Launch> = {}): Launch {
  return { role, harness, command, args, env, setup: [], cwd: null, script: null, ...more };
}

// A started agent gets one first prompt, the kickoff, so it reads its role and carries on - except in the
// agent-org window ("quiet"): there it starts with no prompt (its role is in its system prompt) and agent-org
// types a line into its terminal only when work arrives (waker).

export function kickoff(role: string): string {
  return `You are the '${role}' agent in a team. Call the ${SERVER_NAME} tool my_role to read your role, the message law `
    + 'and where you left off. Then carry on with your open tasks, or end your turn: new messages will be delivered to '
    + `you. If you have no tool called my_role (the ${SERVER_NAME} tools did not load), say so and stop: do not search `
    + 'the computer for it.';
}

export function resumeKickoff(role: string): string {
  return `agent-org: the team was restarted and you are back as '${role}'. Your role or the team may have changed, so `
    + `call the ${SERVER_NAME} tool my_role first. Then read_inbox, check list_tasks, and carry on where you left off. `
    + 'If you have no tool called my_role, say so and stop: do not search the computer for it.';
}

/** [conversation to resume, id for a new one] for a role about to start. A role resumes its last conversation
 * if its harness still has it, unless `fresh`. Codex picks the id of a new conversation itself; the hooks
 * record it later. */
export function planSession(hub: Hub, role: string, fresh = false): [string | null, string | null] {
  const spec = hub.team.roles[role];
  if (!fresh) {
    const found = resumableSession(hub, role);
    if (found) return [found, null];
  }
  return [null, sessions.CAN_CHOOSE_ID.includes(spec.harness) ? randomUUID() : null];
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The conversation `role` would resume, if its harness still has one. Prefers the id on record; otherwise
 * searches the harness's saved conversations for this role's kickoff (a team from before ids were kept, or Codex
 * before its hooks were trusted) and records what it finds. */
export function resumableSession(hub: Hub, role: string, search = true): string | null {
  const spec = hub.team.roles[role];
  if (spec.harness === 'deepseek') { // its runs keep their conversation's id in the launch folder
    const kept = path.join(path.dirname(hub.team.database), 'launch', role, DSH_SESSION);
    const sid = isFile(kept) ? readFileSync(kept, 'utf8').trim() : '';
    return sid || null;
  }
  if (!sessions.RESUMABLE.includes(spec.harness)) return null;
  const record = hub.store.getSession(role);
  if (record !== null && record.harness === spec.harness && record.session_id && sessions.exists(spec.harness, record.session_id)) {
    const own = sessions.mainSession(spec.harness, record.session_id);
    if (own === record.session_id) return own;
    if (own && sessions.exists(spec.harness, own)) { // the record named a helper conversation: fix it
      hub.store.recordSessionId(role, spec.harness, own);
      return own;
    }
  }
  if (!search) return null; // the saved conversations are searched when the role starts (it takes a while)
  const database = hub.team.database;
  const since = isFile(database) ? sessions.born(database) - 60 : 0; // not another team's (see find)
  const found = sessions.find(spec.harness, hub.rootOf(role), role, since);
  if (found && sessions.exists(spec.harness, found)) {
    hub.store.recordSessionId(role, spec.harness, found);
    return found;
  }
  return null;
}

/** [command, args, env] every harness runs to start this role's hub connection. Without a team file and role,
 * the server takes them from AGENT_ORG_TEAM and AGENT_ORG_ROLE, which every start script sets. */
export function mcpServer(teamFile: string | null = null, role: string | null = null): [string, string[], Record<string, string>] {
  return nodeCommand('org_server', teamFile !== null && role !== null ? ['--team', teamFile, '--role', role] : []);
}

type Hook = Record<string, unknown>;
type HookTable = Record<string, { matcher?: string; hooks: Hook[] }[]>;

/** Hooks in the Claude Code layout, which Codex and Grok share. Stop hands new messages to an agent that ends its
 * turn, PostToolUse mentions mail that arrived meanwhile, and PreToolUse makes sure an edited file's lock is held. */
export function hookTable(editMatcher: string | null): HookTable {
  const pre: { matcher?: string; hooks: Hook[] } = { hooks: [{ type: 'command', command: hookCommand('pre-edit'), timeout: 30 }] };
  if (editMatcher) pre.matcher = editMatcher;
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('session'), timeout: 30 }] }],
    Stop: [{ hooks: [{ type: 'command', command: hookCommand('stop'), timeout: STOP_WAIT + 300 }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: hookCommand('post-tool'), timeout: 30 }] }],
    PreToolUse: [pre],
  };
}

/** A hook the agent's own org tool server runs (Claude Code's mcp_tool hooks), so no process starts for it: the
 * tool hooks run on every call. */
export function mcpHook(event: string): Hook {
  return { type: 'mcp_tool', server: SERVER_NAME, tool: HOOK_TOOL, timeout: 30,
    input: { event, session_id: '${session_id}', tool_name: '${tool_name}', tool_input: '${tool_input}', cwd: '${cwd}' } };
}

/** Claude Code's hooks: the per-call ones in its org server. SessionStart stays a command (it runs before MCP
 * servers start), and so does Stop (once a turn, and it may wait for mail a while). */
export function claudeHooks(): HookTable {
  const table = hookTable('Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell');
  table.PreToolUse[0].hooks = [mcpHook('pre-edit')];
  table.PostToolUse[0].hooks = [mcpHook('post-tool')];
  return table;
}

export const paths = {
  /** Grok reads hooks only globally or at a git root, so ours go in ~/.grok/hooks. */
  grokHooksFile: (): string => path.join(os.homedir(), '.grok', 'hooks', 'agent-org.json'),
};

/** Install agent-org's Grok hooks. Outside an agent-org tab (no AGENT_ORG_ROLE) every one of them does nothing. */
export function installGrokHooks(): string {
  const file = paths.grokHooksFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, grokHooksText(), 'utf8');
  return file;
}

function grokHooksText(): string {
  return `${JSON.stringify({ hooks: hookTable('Edit|Write|MultiEdit|Bash|Shell|run_terminal_cmd|run_command') }, null, 2)}\n`;
}

/** 'missing', 'outdated' (written by an older agent-org) or 'current'. */
export function grokHooksState(): 'missing' | 'outdated' | 'current' {
  const file = paths.grokHooksFile();
  if (!existsSync(file)) return 'missing';
  try {
    return readFileSync(file, 'utf8') === grokHooksText() ? 'current' : 'outdated';
  } catch {
    return 'outdated';
  }
}

// An agent's terminal shows its work, not your personal extras: no mods of yours (their status lines, such as a
// token counter, show under every agent) and no spinner tips. These go in the agent's own settings because
// Claude Code applies your settings' "env" over whatever environment it starts with.
export const AGENT_CLAUDE_SETTINGS = { env: { CLAUDE_CODE_PLUGIN_DIRS: '' }, spinnerTipsEnabled: false };
// A teammate works with the shell, files and the web, and with the team through the org tools. Your own MCP
// servers and connectors, Claude in Chrome, and Claude Code's other built-in tools (artifacts, workflows,
// schedules, its own subagents...) are left out: they are sent with every request (a request measured 41.7k
// tokens with them, 13.2k without) and would let an agent reach past the team.
export const AGENT_CLAUDE_TOOLS = ['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch'];

/** Claude model ids write versions with dashes: 'claude-sonnet-5.5' (as people write it) is claude-sonnet-5-5. */
export function claudeModel(model: string): string {
  return model.toLowerCase().startsWith('claude-') ? model.replace(/(?<=\d)\.(?=\d)/g, '-') : model;
}

type Builder = (hub: Hub, teamFile: string, role: string, out: string, resume: string | null, newId: string | null, quiet: boolean) => Launch;

const writeJson = (file: string, value: unknown): void => writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');

export const claudeLaunch: Builder = (hub, teamFile, role, out, resume = null, newId = null, quiet = false) => {
  const spec = hub.team.roles[role];
  if (asksOwnerForEverything('claude', spec.model)) {
    hub.event('agent', role, 'runs Claude Haiku, which has no auto mode: it will ask you in its terminal before every edit and '
      + 'command (Sonnet works on its own)');
  }
  const card = path.join(out, 'role.md');
  writeFileSync(card, `${roleCard(hub.session(role), Boolean(resume))}\n`, 'utf8');
  const [command, args, env] = mcpServer(teamFile, role);
  const config = path.join(out, 'mcp.json');
  writeJson(config, { mcpServers: { [SERVER_NAME]: { type: 'stdio', command, args, env } } });
  const settings = path.join(out, 'settings.json');
  writeJson(settings, { ...AGENT_CLAUDE_SETTINGS, hooks: claudeHooks() });
  const cli = ['--mcp-config', config, '--strict-mcp-config', '--allowedTools', `mcp__${SERVER_NAME}`,
    '--tools', AGENT_CLAUDE_TOOLS.join(','), '--no-chrome', '--append-system-prompt-file', card, '--settings', settings];
  if (spec.model) cli.push('--model', claudeModel(spec.model));
  if (spec.effort) cli.push('--effort', spec.effort);
  if (resume) cli.push('--resume', resume);
  else if (newId) cli.push('--session-id', newId);
  // --mcp-config and --allowedTools take several values, so a plain option must come between them and the
  // prompt or they would swallow it.
  cli.push('--name', role);
  if (!quiet) cli.push(resume ? resumeKickoff(role) : kickoff(role));
  // Several agents share one Claude Code install; an update started by one tab can't replace the program while
  // the others run it, and leaves a broken install behind.
  // ENABLE_TOOL_SEARCH=false: the org tools are there from the start; deferred, each first use cost a ToolSearch
  // step (seen: three in one short task).
  // A wait_for_messages call is a quiet wait by design. Claude Code moves a tool call still running after 2
  // minutes to the background (seen: the leader called it again every 2 minutes - a model call each - with four
  // waits piling up, each able to take the result), and aborts one silent for 30 minutes (the default wait is
  // 30 minutes): neither for an agent's own org tools.
  return launch(role, 'claude', 'claude', cli, {
    MCP_TOOL_TIMEOUT: String(WAIT_LIMIT * 1000), CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0',
    CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(WAIT_LIMIT * 1000), DISABLE_AUTOUPDATER: '1', ENABLE_TOOL_SEARCH: 'false',
  });
};

/** -c overrides that leave your own Codex plugins, MCP servers and memories out of an agent. They are sent with
 * every request (a request measured 21.4k tokens with them, 16.4k without), some reach past the team (a browser,
 * computer use), and an agent's work would fill your own memories. Your config.toml is not changed: each agent
 * starts with them off. */
export function codexExtrasOff(config: string | null = null): string[] {
  const file = config ?? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  let data: Record<string, any>;
  try {
    data = parseToml(readFileSync(file, 'utf8')) as Record<string, any>;
  } catch {
    return [];
  }
  const off: string[] = [];
  // Codex splits a -c key at its dots and takes quotes literally: a name goes in as it is, and one it would
  // split (or another odd one) is left alone.
  const plain = /^[A-Za-z0-9_@-]+$/;
  for (const name of Object.keys(data.plugins ?? {})) {
    if (plain.test(name)) off.push('-c', `plugins.${name}.enabled=false`);
  }
  for (const name of Object.keys(data.mcp_servers ?? {})) {
    if (name !== SERVER_NAME && plain.test(name)) off.push('-c', `mcp_servers.${name}.enabled=false`);
  }
  if (data.memories || data.features?.memories) off.push('-c', 'memories.use_memories=false', '-c', 'memories.generate_memories=false');
  return off;
}

export const codexLaunch: Builder = (hub, teamFile, role, _out, resume = null, _newId = null, quiet = false) => {
  const spec = hub.team.roles[role];
  const [command, args, env] = mcpServer(teamFile, role);
  const key = `mcp_servers.${SERVER_NAME}`;
  const cli = [
    '-c', `${key}.command=${toml(command)}`,
    '-c', `${key}.args=${toml(args)}`,
    '-c', `${key}.env=${toml(env)}`,
    '-c', `${key}.tool_timeout_sec=${WAIT_LIMIT}`,
    '-c', `${key}.default_tools_approval_mode="approve"`,
    '-c', `developer_instructions=${toml(roleCard(hub.session(role), Boolean(resume)))}`,
    // several agents share one install: an update offered at start would wait for a key (and replacing the
    // program while others run it breaks them)
    '-c', 'check_for_update_on_startup=false',
    ...codexExtrasOff(),
  ];
  // Codex asks you once to review and trust new hooks; the commands are the same for every role, so one
  // "Trust all" covers them all.
  for (const [event, groups] of Object.entries(hookTable(null))) cli.push('-c', `hooks.${event}=${toml(groups)}`); // pre-edit picks out edits itself
  if (spec.model) cli.push('-m', spec.model);
  if (spec.effort) cli.push('-c', `model_reasoning_effort=${toml(spec.effort)}`);
  if (resume) return launch(role, 'codex', 'codex', ['resume', ...cli, resume, ...(quiet ? [] : [resumeKickoff(role)])]); // codex resume [OPTIONS] SESSION_ID [PROMPT]
  if (!quiet) cli.push(kickoff(role));
  return launch(role, 'codex', 'codex', cli);
};

export const grokLaunch: Builder = (hub, _teamFile, role, _out, resume = null, newId = null, quiet = false) => {
  const spec = hub.team.roles[role];
  if (grokHooksState() === 'outdated') installGrokHooks(); // the owner installed them once; keep them working
  // Grok loads MCP servers only from config files, so register one 'org' server in the project's
  // .grok/config.toml ("add" also updates it). The entry names no role: every Grok tab passes its own
  // AGENT_ORG_* variables on to the server it starts. Grok asks you to trust the folder the first time it sees
  // this project server.
  const [command, args, env] = mcpServer();
  const register = ['grok', 'mcp', 'add', '--scope', 'project', SERVER_NAME, command,
    ...Object.entries(env).map(([k, v]) => `--env=${k}=${v}`), '--', ...args];
  const cli = ['--rules', roleCard(hub.session(role), Boolean(resume)), '--allow', `MCPTool(${SERVER_NAME}__*)`];
  if (spec.model) cli.push('-m', spec.model);
  if (spec.effort) cli.push('--reasoning-effort', spec.effort);
  if (resume) cli.push('--resume', resume);
  else if (newId) cli.push('--session-id', newId);
  if (!quiet) cli.push(resume ? resumeKickoff(role) : kickoff(role));
  return launch(role, 'grok', 'grok', cli, { GROK_DISABLE_AUTOUPDATER: '1' }, { setup: [register] });
};

export const AGY_EDIT_MATCHER = 'write_to_file|replace_file_content|multi_replace_file_content|code_action|file_change|'
  + 'propose_code|edit_notebook|run_command'; // run_command: the command guard

/** Write agent-org's Antigravity plugin into `folder`: its MCP server and hooks. The plugin names no role: each
 * agent's server and hooks take it from AGENT_ORG_ROLE, and outside agent-org terminals both do nothing (the
 * server offers no tools, the hooks exit at once). */
export function antigravityPlugin(folder: string): string {
  mkdirSync(folder, { recursive: true });
  const [command, args, env] = mcpServer();
  const run = (event: string, timeout: number): Hook => {
    let line = `${hookCommand(event)} agy`;
    if (line.includes('"')) line = `"${line}"`; // Antigravity runs it through cmd /c, which strips one outer pair of quotes
    return { type: 'command', command: line, timeout };
  };
  const files: Record<string, unknown> = {
    'plugin.json': { name: 'agent-org' },
    'mcp_config.json': { mcpServers: { [SERVER_NAME]: { command, args, env } } },
    'hooks.json': { 'agent-org': {
      // only edits: a PreToolUse answer must carry a decision, so hooking every tool would replace
      // Antigravity's own permission handling for all of them
      PreToolUse: [{ matcher: AGY_EDIT_MATCHER, hooks: [run('pre-edit', 30)] }],
      PreInvocation: [run('invocation', 30)],
      Stop: [run('stop', STOP_WAIT + 300)],
    } },
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(folder, name), `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  return folder;
}

export function antigravityPluginDir(): string {
  return path.join(templates.homeDir(), 'antigravity-plugin');
}

/** Run a program to its end; a .cmd shim (an npm-installed program) runs through cmd, its words quoted. */
const run = (command: string, args: string[], timeout = 60): { ok: boolean; out: string } => {
  const shell = /\.(cmd|bat)$/i.test(command);
  const quote = (a: string): string => (/[\s&|<>^()]/.test(a) ? `"${a}"` : a);
  const opts = { encoding: 'utf8' as const, timeout: timeout * 1000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  const done = shell ? spawnSync([command, ...args].map(quote).join(' '), { ...opts, shell: true }) : spawnSync(command, args, opts);
  return { ok: done.status === 0, out: `${done.stdout ?? ''}${done.stderr ?? ''}` };
};

/** Make agent-org's plugin a user-level Antigravity plugin, if it is not already the current one. Interactive
 * Antigravity loads user-level plugins only (not a project's .agents/plugins), and an agent-org agent runs
 * interactively - its own full terminal. Outside agent-org the plugin does nothing, so the owner's own `agy`
 * sessions are not affected. */
export function installAntigravityPlugin(): void {
  const folder = antigravityPlugin(antigravityPluginDir());
  const wanted = ['plugin.json', 'mcp_config.json', 'hooks.json'].map((n) => readFileSync(path.join(folder, n), 'utf8')).join('');
  const marker = path.join(folder, '.installed');
  const agy = which('agy');
  if (agy === null || inTest()) return; // a test never changes the real Antigravity
  if (pluginChecked === wanted) return; // already checked by this agent-org (asking agy takes a quarter second)
  const listed = run(agy, ['plugin', 'list']).out;
  const installed = listed.includes('"agent-org"');
  if (installed && isFile(marker) && readFileSync(marker, 'utf8') === wanted) {
    pluginChecked = wanted;
    return;
  }
  if (installed) run(agy, ['plugin', 'uninstall', 'agent-org']); // an older copy: replace it
  const done = run(agy, ['plugin', 'install', folder]);
  if (!done.ok) throw new HubError(`could not install agent-org's Antigravity plugin: ${done.out.trim().slice(0, 200)}`);
  writeFileSync(marker, wanted, 'utf8');
  pluginChecked = wanted;
}

let pluginChecked = ''; // the plugin this process found (or made) installed

export function antigravityKickoff(role: string, resume: boolean): string {
  const where = ` In Antigravity call them with call_mcp_tool, ServerName agent-org_${SERVER_NAME} (my_role: Arguments {}); `
    + 'my_role also lists every team tool\'s arguments, so there is no need to open their files.';
  return (resume ? resumeKickoff(role) : kickoff(role)) + where;
}

export const antigravityLaunch: Builder = (hub, _teamFile, role, _out, resume = null, _newId = null, quiet = false) => {
  const spec = hub.team.roles[role];
  installAntigravityPlugin();
  const cli: string[] = [];
  if (spec.model) cli.push('--model', spec.model);
  if (spec.effort) cli.push('--effort', spec.effort);
  if (resume) cli.push('--conversation', resume);
  // Antigravity has no flag for extra instructions: the kickoff (or, quiet, the first line agent-org types)
  // sends it to my_role. Interactive: its own full terminal, typeable like any agent's. Its tools and hooks
  // come from the user-level plugin; the Stop hook delivers new messages.
  if (!quiet) cli.push('-i', antigravityKickoff(role, Boolean(resume)));
  return launch(role, 'antigravity', 'agy', cli);
};

// ---- DeepSeek Harness ----
// Its terminal mode ("headless") answers one task and exits, with no hooks; agent-org's tools come in through
// its MCP client plugin, added for each role by a patch file. Its start script waits - with wake, no model -
// until the role has a new message (or, at the start, unfinished tasks), then runs it, and waits again (until
// the role is stopped). Each run continues the same conversation (--session-id) and writes its steps as JSON
// events, which runview shows as they happen: plain headless mode prints only the final answer. The `dsh`
// command (0.2 or later) runs it; without one, the desktop app's own copy.

export const DSH_EFFORTS = ['off', 'low', 'high', 'max'];
export const DSH_SESSION = 'dsh.session'; // in a role's launch folder: the conversation its runs continue
export const STOP_MARKER = 'stopped'; // in a role's launch folder: its start script does not run it again
export const QUIET_STOP_WAIT = 45; // seconds a Stop hook waits for mail in the agent-org window (the window wakes it later)

export function deepseekKickoff(role: string): string {
  return `You are the '${role}' agent in a team. Call the ${SERVER_NAME} tool my_role to read your role, the message law `
    + 'and where you left off, then read_inbox and list_tasks, and carry on with your open tasks. When nothing is left to '
    + 'do, end your answer: agent-org starts you again when a new message arrives. If you have no tool called my_role '
    + `(the ${SERVER_NAME} tools did not load), say so and stop: do not search the computer for it.`;
}

export function deepseekWake(role: string): string {
  return `agent-org: '${role}', you have new messages. Call read_inbox and handle them (and list_tasks; my_role if you `
    + 'need your role again). When nothing is left to do, end your answer: agent-org starts you again when a new message arrives.';
}

const DSH_MIN_VERSION = [0, 2];
const dshVersions = new Map<string, number[] | null>();

/** The dsh version, for the banner ('' if it cannot tell). */
export function deepseekVersion(command: string, base: string[]): string {
  for (const [key, version] of dshVersions) {
    if (version && key.startsWith(base[0] ?? command)) return version.join('.');
  }
  return '';
}

/** The `dsh` command line (node and its bin.js), if one new enough is installed. */
export function dshCli(): [string, string[]] | null {
  const shim = which('dsh');
  if (shim === null) return null;
  const folder = path.dirname(shim);
  const binJs = path.join(folder, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const node = isFile(path.join(folder, 'node.exe')) ? path.join(folder, 'node.exe') : which('node');
  if (!isFile(binJs) || node === null) return null;
  const key = `${binJs}|${statSync(binJs).mtimeMs}`;
  if (!dshVersions.has(key)) {
    const found = /^\s*(\d+)\.(\d+)/.exec(run(node, [binJs, '--version']).out);
    dshVersions.set(key, found ? [Number(found[1]), Number(found[2])] : null);
  }
  const version = dshVersions.get(key);
  const newEnough = version != null && (version[0] > DSH_MIN_VERSION[0] || (version[0] === DSH_MIN_VERSION[0] && version[1] >= DSH_MIN_VERSION[1]));
  return newEnough ? [node, [binJs]] : null;
}

/** DeepSeek Harness.exe of the installed desktop app (its uninstall entry says where), if any. */
export function deepseekApp(): string | null {
  const override = process.env.AGENT_ORG_DEEPSEEK_APP;
  if (override) return isFile(override) ? override : null;
  if (process.platform !== 'win32') return null;
  for (const hive of ['HKCU', 'HKLM']) {
    const base = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`;
    const found = spawnSync('reg.exe', ['query', base, '/s', '/f', 'DeepSeek Harness', '/d'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    for (const key of (found.stdout ?? '').split(/\r?\n/).filter((l) => l.startsWith('HKEY_'))) {
      const values = registryValues(key);
      if (!(values.DisplayName?.value ?? '').startsWith('DeepSeek Harness')) continue;
      const icon = (values.DisplayIcon?.value ?? '').split(',')[0].replace(/^"|"$/g, '');
      if (icon.toLowerCase().endsWith('.exe') && isFile(icon)) return icon;
    }
  }
  return null;
}

/** How to run `dsh`: the `dsh` command (0.2 or later), else the desktop app's own copy (its exe as Node). */
export const deepseek = {
  command(): [string, string[], Record<string, string>] | null {
    const cli = dshCli();
    if (cli !== null) return [cli[0], cli[1], {}];
    const app = deepseekApp();
    if (app !== null) {
      const asar = path.join(path.dirname(app), 'resources', 'app.asar');
      if (isFile(asar)) {
        const js = path.join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
        return [app, ['--expose-internals', js], { ELECTRON_RUN_AS_NODE: '1' }];
      }
    }
    return null;
  },
};

/** A YAML single-quoted string. */
export function yamlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The patch file that gives a DeepSeek role agent-org's tools (and its model). */
export function deepseekPatch(hub: Hub, teamFile: string, role: string): string {
  const spec = hub.team.roles[role];
  const [command, args, base] = mcpServer(teamFile, role);
  const env = { ...base, AGENT_ORG_TEAM: teamFile, AGENT_ORG_ROLE: role };
  const lines = [
    '# agent-org: the org tools (and model) for this role. Written by agent-org\'s launcher.',
    '- insert:',
    '    - id: agent-org-tools',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${SERVER_NAME}`,
    '        transport: stdio',
    `        command: ${yamlText(command)}`,
    `        args: [${args.map(yamlText).join(', ')}]`,
    '        env:',
    ...Object.entries(env).map(([k, v]) => `          ${k}: ${yamlText(v)}`),
    `        toolCallTimeoutMs: ${(WAIT_LIMIT + 120) * 1000}`,
    '        failOnStartupError: true',
  ];
  if (spec.model || spec.effort) {
    lines.push('- id: agent-default-model', '  config:', '    provider: deepseek-official', `    model: ${yamlText(spec.model || 'deepseek-flash')}`);
    if (spec.effort) lines.push(`    reasoningEffort: ${yamlText(spec.effort)}`);
  }
  return `${lines.join('\n')}\n`;
}

export const deepseekLaunch: Builder = (hub, teamFile, role, out, resume = null) => {
  const found = deepseek.command();
  if (found === null) throw new HubError('DeepSeek Harness is not installed (install the desktop app, or the dsh command)');
  const [command, base, appEnv] = found;
  const patchFile = path.join(out, 'dsh.patch.yml');
  writeFileSync(patchFile, deepseekPatch(hub, teamFile, role), 'utf8');
  const sessionFile = path.join(out, DSH_SESSION);
  if (!resume) rmSync(sessionFile, { force: true }); // Start fresh (or its first start): a new conversation
  const env: Record<string, string> = { ...appEnv, ...nodeEnv() };
  if ((process.env.ALL_PROXY ?? process.env.all_proxy ?? '').toLowerCase().startsWith('socks')) {
    env.ALL_PROXY = ''; // dsh cannot use a SOCKS proxy and says so on every run; it uses HTTPS_PROXY
  }
  const line = (args: string[]): string => args.map(ps).join(' ');
  const dsh = line([command, ...base, '--profile', 'headless', '--patch', patchFile, '--json']);
  const viewer = line([process.execPath, entry('runview'), '--session-file', sessionFile, '--usage-file', path.join(out, DSH_USAGE)]);
  const waiter = line([process.execPath, entry('wake'), '--team', teamFile, '--role', role, '--stop', path.join(out, STOP_MARKER), '--input']);
  const spec = hub.team.roles[role];
  const shownModel = [spec.model || 'deepseek-flash', spec.effort && `${spec.effort} effort`].filter((x) => x).join(', ');
  const folder = hub.rootOf(role);
  const shownFolder = folder.length <= 48 ? folder : `…\\${path.basename(path.dirname(folder))}\\${path.basename(folder)}`;
  const banner = line([process.execPath, entry('runview'), '--banner', 'DeepSeek Harness', deepseekVersion(command, base), shownModel, shownFolder]);
  const sid = ps(sessionFile);
  const marker = ps(path.join(out, STOP_MARKER));
  // Nothing runs at the start: the waiter returns when there is work (at once for unfinished tasks). A run
  // continues its conversation if it has one; the first run of a new one is told its role.
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `& ${banner}`,
    "$first = @('--first')",
    `while (-not (Test-Path -LiteralPath ${marker})) {`,
    `    & ${waiter} @first`,
    '    if ($LASTEXITCODE -ne 0) { break }',
    '    $first = @()',
    `    $sid = if (Test-Path -LiteralPath ${sid}) { (Get-Content -LiteralPath ${sid} -Raw).Trim() } else { '' }`,
    "    $resume = if ($sid) { @('--session-id', $sid) } else { @() }",
    `    $prompt = if ($sid) { ${ps(deepseekWake(role))} } else { ${ps(deepseekKickoff(role))} }`,
    `    & ${dsh} @resume $prompt | & ${viewer}`,
    '}',
  ].join('\n');
  return launch(role, 'deepseek', command, [], env, { script });
};

export const BUILDERS: Record<string, Builder> = dict({ claude: claudeLaunch, codex: codexLaunch, grok: grokLaunch,
  antigravity: antigravityLaunch, deepseek: deepseekLaunch });

/** A TOML value for `codex -c key=value`. JSON strings are valid TOML basic strings. */
export function toml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value).map(([k, v]) => `${k} = ${toml(v)}`).join(', ')}}`;
  throw new TypeError(`cannot write ${typeof value} as TOML`);
}

/** A PowerShell single-quoted literal: nothing inside is expanded. */
export function ps(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

export const DIRECT_START = 'start.json'; // beside start.ps1: how the window runs the role without PowerShell

/** How to run `command` without a shell: [program, and the script it runs]. npm installs a program as .cmd (and
 * .ps1) scripts that start the package's own .exe, or node with the package's script; the program itself is
 * found in the .cmd's last "%dp0%\..." path. null when it cannot be told (then PowerShell runs it). */
export function directProgram(command: string): string[] | null {
  const found = which(command);
  if (found === null) return null;
  if (/\.exe$/i.test(found)) return [found];
  if (!/\.cmd$/i.test(found)) return null;
  let text: string;
  try {
    text = readFileSync(found, 'utf8');
  } catch {
    return null;
  }
  const target = [...text.matchAll(/"%dp0%\\([^"%]+)"/g)].at(-1)?.[1];
  if (target === undefined) return null;
  const full = path.join(path.dirname(found), target);
  if (!isFile(full)) return null;
  if (/\.exe$/i.test(full)) return [full];
  const node = isFile(path.join(path.dirname(found), 'node.exe')) ? path.join(path.dirname(found), 'node.exe') : which('node');
  return node === null ? null : [node, full];
}

/** In the agent-org window a role whose start is one program runs it directly, without the PowerShell that
 * start.ps1 needs (about 35 MB per agent, and a slower start): what to run, where, with which environment. A
 * role that needs more (DeepSeek's loop, Grok's setup) has no such file. */
function writeDirectStart(l: Launch, teamFile: string, file: string): void {
  const program = l.script === null && !l.setup.length ? directProgram(l.command) : null;
  if (program === null) {
    rmSync(file, { force: true });
    return;
  }
  const env = { AGENT_ORG_TEAM: teamFile, AGENT_ORG_ROLE: l.role, ...networkEnv({}), ...l.env };
  writeFileSync(file, JSON.stringify({ argv: [...program, ...l.args], cwd: l.cwd, env }, null, 2), 'utf8');
}

export interface DirectStart { argv: string[]; cwd: string; env: Record<string, string> }

/** The direct start written beside a tab command's start script, if there is one. */
export function directStart(tab: string[]): DirectStart | null {
  try {
    const start = JSON.parse(readFileSync(path.join(path.dirname(tab.at(-1) ?? ''), DIRECT_START), 'utf8'));
    if (Array.isArray(start.argv) && start.argv.length && typeof start.cwd === 'string') return start as DirectStart;
  } catch {
    // none: PowerShell runs the start script
  }
  return null;
}

export function roleScript(l: Launch, team: Team, teamFile: string): string {
  // its way to the internet (agent-org's proxy, or Windows' own), as no profile sets one (tabCommand)
  const env = { AGENT_ORG_TEAM: teamFile, AGENT_ORG_ROLE: l.role, ...networkEnv({}), ...l.env };
  const runIt = l.script ?? `& ${ps(l.command)} ${l.args.map(ps).join(' ')}`;
  return [
    `# agent-org: role '${l.role}' on ${l.harness}. Written by agent-org's launcher; rerunning it overwrites this.`,
    `$Host.UI.RawUI.WindowTitle = ${ps(l.role)}`,
    ...Object.entries(env).map(([name, value]) => `$env:${name} = ${ps(value)}`),
    `Set-Location -LiteralPath ${ps(l.cwd ?? team.project_root)}`,
    ...l.setup.map((cmd) => ['&', ...cmd.map(ps), '| Out-Null'].join(' ')),
    runIt,
    '',
  ].join('\n');
}

export function ownerScript(team: Team, teamFile: string): string {
  const [command, args, env] = nodeCommand('cli');
  const set = Object.entries(env).map(([k, v]) => `$env:${k} = ${ps(v)}; `).join('');
  const unset = Object.keys(env).map((k) => `; Remove-Item Env:${k}`).join(''); // only while org runs: other programs here are yours
  return [
    "# agent-org: the owner's console. Written by agent-org's launcher.",
    `$Host.UI.RawUI.WindowTitle = ${ps(team.owner)}`,
    `$env:AGENT_ORG_TEAM = ${ps(teamFile)}`,
    `function org { ${set}& ${[command, ...args].map(ps).join(' ')} @args${unset} }`,
    `Set-Location -LiteralPath ${ps(team.project_root)}`,
    'org tree',
    "Write-Host ''",
    `Write-Host 'You are ${team.owner}. Talk to the team with the org command:'`,
    `Write-Host '  org send ${team.leader} "what you want built"   org inbox   org wait'`,
    "Write-Host '  org view <role>   org locks   org --help'",
    '',
  ].join('\n');
}

export function tabCommand(title: string, color: string, cwd: string, script: string): string[] {
  // -NoProfile: the start script sets all an agent needs (its proxy comes from agent-org); your PowerShell
  // profile would slow each start and could change its network settings.
  return ['wt', '-w', WINDOW, 'new-tab', '--title', title, '--suppressApplicationTitle', '--tabColor', color, '-d', cwd,
    'pwsh', '-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', script];
}

/** [title, color, folder, program and arguments] of a tab command, to run it elsewhere (in a terminal inside the
 * agent-org window). */
export function tabParts(tab: string[]): [string, string, string, string[]] {
  const at = tab.indexOf('-d');
  return [tab[tab.indexOf('--title') + 1], tab[tab.indexOf('--tabColor') + 1], tab[at + 1], tab.slice(at + 2)];
}

/** The role a tab command starts: its start script lives in launch/<role>/. */
export function tabRole(tab: string[]): string {
  return path.basename(path.dirname(tab.at(-1) ?? ''));
}

/** Write one role's start script and return the tab command that opens it. The role resumes its last
 * conversation when it can (see planSession). `quiet`: it starts with no first prompt, for the agent-org window,
 * which wakes it when work arrives (waker). */
export function roleTab(hub: Hub, teamFile: string, role: string, fresh = false, quiet = false): string[] {
  const team = hub.team;
  const spec = team.roles[role];
  const build = BUILDERS[spec.harness];
  if (build === undefined) throw new HubError(`${spec.harness} is not supported yet`);
  const out = path.join(path.dirname(team.database), 'launch', role);
  mkdirSync(out, { recursive: true });
  const cwd = hub.prepareRoot(role); // branch mode: its own worktree
  const [resume, newId] = planSession(hub, role, fresh);
  const l = build(hub, teamFile, role, out, resume, newId, quiet);
  l.cwd = cwd;
  if (quiet) { // its Stop hook lets it rest when no message comes: the window wakes it, at no cost meanwhile
    l.env.AGENT_ORG_STOP_IDLE = '1';
    // A short wait catches a quick reply; then it rests at its prompt, where you can type to it (a waiting
    // hook holds your typing back, and its timer makes an idle agent look busy).
    l.env.AGENT_ORG_STOP_WAIT = String(QUIET_STOP_WAIT);
  }
  if (!resume) hub.store.startSession(role, spec.harness, newId);
  const script = path.join(out, 'start.ps1');
  rmSync(path.join(out, STOP_MARKER), { force: true }); // starting it again lifts an earlier Stop
  writeFileSync(script, roleScript(l, team, teamFile), 'utf8');
  writeDirectStart(l, teamFile, path.join(out, DIRECT_START));
  const title = spec.is_consultant ? `${role} (${spec.tier})` : role;
  return tabCommand(title, TAB_COLORS[spec.harness], cwd, script);
}

/** Write the start scripts and return [tab commands to open, reasons for roles skipped]. A role that is already
 * running is skipped unless `force`: a second session of the same role would split its messages between the two.
 * With a `limit`, no more than that many agents run at once. */
export function prepare(hub: Hub, teamFile: string, roles: string[], ownerTab: boolean,
  opts: { force?: boolean; fresh?: boolean; limit?: number; quiet?: boolean } = {}): [string[][], string[]] {
  const team = hub.team;
  const online = hub.store.online();
  const running = Object.keys(online).filter((n) => n in team.roles).length;
  const tabs: string[][] = [];
  const skipped: string[] = [];
  if (ownerTab) {
    const script = path.join(path.dirname(team.database), 'launch', team.owner, 'start.ps1');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, ownerScript(team, teamFile), 'utf8');
    tabs.push(tabCommand(team.owner, TAB_COLORS.owner, team.project_root, script));
  }
  for (const role of roles) {
    if (online[role] && !opts.force) {
      skipped.push(`${role}: already running`);
      continue;
    }
    if (opts.limit && running + tabs.length >= opts.limit) {
      skipped.push(`${role}: ${opts.limit} agents are running already (the team's limit)`);
      continue;
    }
    try {
      tabs.push(roleTab(hub, teamFile, role, opts.fresh ?? false, opts.quiet ?? false));
    } catch (e) {
      if (!(e instanceof HubError)) throw e;
      skipped.push(`${role}: ${e.message}`);
    }
  }
  return [tabs, skipped];
}

export const PWSH_MISSING = 'Agents start through PowerShell 7, which is not installed on this computer. Install it (in a '
  + 'terminal: winget install Microsoft.PowerShell), then start agent-org again.';
export const WT_MISSING = "Agents open in Windows Terminal tabs here, and it is not installed. Install 'Windows Terminal' "
  + 'from the Microsoft Store, then start agent-org again.';

/** Why no agent can start on this computer ('' if they can). Each runs its start script in PowerShell 7 (Windows
 * PowerShell 5.1 would mangle the quoted settings Codex is given); outside the window, in a Windows Terminal tab. */
export function cannotStart(inWindow: boolean): string {
  if (which('pwsh') === null) return PWSH_MISSING;
  if (!inWindow && which('wt') === null) return WT_MISSING;
  return '';
}

export function openTab(tab: string[]): void {
  if (inTest()) throw new HubError('refusing to open a real terminal tab inside a test'); // a test must never start real agents
  const why = cannotStart(false);
  if (why) throw new HubError(why);
  const done = spawnSync(which('wt') ?? 'wt', tab.slice(1), { stdio: 'ignore' });
  if (done.status !== 0) throw new HubError(`Windows Terminal did not open the tab (exit ${done.status})`);
}

export const HARNESS_PROGRAMS = new Set(['claude.exe', 'codex.exe', 'grok.exe', 'agy.exe', 'node.exe', 'deepseek harness.exe']);

/** The executable name of a running process ('' if there is none). */
export function programName(pid: number): string {
  const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 15_000, windowsHide: true }).stdout ?? '';
  const first = out.trim().split(/\r?\n/)[0] ?? '';
  return first.startsWith('"') ? first.split('","')[0].replace(/^"|"$/g, '').toLowerCase() : '';
}

/** End every running session of `role` by stopping its harness program. Returns how many. Only processes that
 * are really a harness program are stopped, so a reused process id can never take something else down. The tab
 * stays open at a PowerShell prompt. */
export function stopRole(hub: Hub, role: string): number {
  let stopped = 0;
  const folder = path.join(path.dirname(hub.team.database), 'launch', role);
  if (existsSync(folder)) writeFileSync(path.join(folder, STOP_MARKER), 'stopped by agent-org\n', 'utf8'); // a program its start script runs again (DeepSeek) stays stopped
  const running = hub.store.sessionsOf(role);
  for (const [pid, ppid] of running) {
    if (ppid && HARNESS_PROGRAMS.has(programName(ppid))) {
      spawnSync('taskkill', ['/PID', String(ppid), '/T', '/F'], { timeout: 30_000, windowsHide: true, stdio: 'ignore' });
      stopped += 1;
    }
    hub.store.checkOut(pid);
  }
  if (running.length && hub.team.roles[role]?.harness === 'deepseek') stopped = 1; // one agent: a run, or its waiter between runs
  return stopped;
}

/** A program's output, without waiting for it on this thread. */
function output(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', timeout: timeout * 1000, windowsHide: true }, (_error, stdout) => resolve(stdout ?? ''));
  });
}

/** stopRole for the agent-org window, whose terminals must not wait: each check (tasklist takes about 0.35 s)
 * and stop runs without blocking, and the role's sessions are stopped side by side. */
export async function stopRoleAsync(hub: Hub, role: string): Promise<number> {
  const folder = path.join(path.dirname(hub.team.database), 'launch', role);
  if (existsSync(folder)) writeFileSync(path.join(folder, STOP_MARKER), 'stopped by agent-org\n', 'utf8'); // a program its start script runs again (DeepSeek) stays stopped
  const running = hub.store.sessionsOf(role);
  const ended = await Promise.all(running.map(async ([pid, ppid]) => {
    let stopped = false;
    if (ppid) {
      const first = (await output('tasklist', ['/FI', `PID eq ${ppid}`, '/FO', 'CSV', '/NH'], 15)).trim().split(/\r?\n/)[0] ?? '';
      const name = first.startsWith('"') ? first.split('","')[0].replace(/^"|"$/g, '').toLowerCase() : '';
      if (HARNESS_PROGRAMS.has(name)) {
        await output('taskkill', ['/PID', String(ppid), '/T', '/F'], 30);
        stopped = true;
      }
    }
    hub.store.checkOut(pid);
    return stopped;
  }));
  if (running.length && hub.team.roles[role]?.harness === 'deepseek') return 1; // one agent: a run, or its waiter between runs
  return ended.filter((x) => x).length;
}

export const LAUNCHER_HEADER = 'X-Agent-Org-Launcher';

/** Ask the running agent-org window to start `role` in a terminal of its own. True if it did. An agent that hires
 * a teammate or summons a consultant does it through its own tool server, which cannot reach the window's
 * terminals; the window says how to reach it in instance.json. */
export function windowStart(teamFile: string, role: string, timeout = 20): boolean {
  if (inTest()) return false; // a test must never start real agents
  try {
    const info = JSON.parse(readFileSync(path.join(templates.homeDir(), 'instance.json'), 'utf8'));
    const port = Number(info.port);
    if (!Number.isInteger(port) || !info.launcher) return false;
    return postSync(`http://127.0.0.1:${port}/api/launcher/start`, JSON.stringify({ team: teamFile, role }),
      { 'Content-Type': 'application/json', [LAUNCHER_HEADER]: String(info.launcher) }, timeout) === 200;
  } catch {
    return false;
  }
}

/** What the hub calls to show a newly started role (a hire, a consultant): in its own tab, or with `opener` (the
 * agent-org window opens it in a terminal of its own, `quiet`). */
export function tabOpener(teamFile: string, opener: ((tab: string[]) => void) | null = null, quiet = false): Opener {
  return (role: Role): void => {
    if (opener === null && windowStart(teamFile, role.name)) return; // an agent asked: into the window, if it runs
    const hub = Hub.open(teamFile); // a fresh connection sees the role just registered
    let tab: string[];
    try {
      tab = roleTab(hub, teamFile, role.name, false, quiet);
    } finally {
      hub.close();
    }
    (opener ?? openTab)(tab);
  };
}

/** For a tool server: open hired agents and consultants, and end let-go ones. */
export const launcher = {
  attach(hub: Hub, teamFile: string): void {
    hub.opener = tabOpener(teamFile);
    hub.stopper = (role: string) => stopRole(hub, role);
  },
};

const quoteArg = (a: string): string => (/[\s"]/.test(a) || !a ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : a);

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith('--') && a !== '--team'));
  const teamAt = argv.indexOf('--team');
  const teamArg = teamAt >= 0 ? argv[teamAt + 1] : 'team.yaml';
  const roles = argv.filter((a, i) => !a.startsWith('--') && !(teamAt >= 0 && i === teamAt + 1));
  if (flags.has('--help')) {
    process.stdout.write('usage: org_launch [--team team.yaml] [roles...] [--no-owner] [--dry-run] [--force] [--fresh] [--install-grok-hooks]\n');
    return 0;
  }
  if (flags.has('--install-grok-hooks')) {
    process.stdout.write(`installed ${installGrokHooks()}\n`);
    return 0;
  }
  const teamFile = path.resolve(teamArg);
  const hub = Hub.open(teamFile); // also creates the database before any agent connects
  let tabs: string[][];
  let skipped: string[];
  try {
    const unknown = roles.filter((r) => !(r in hub.team.roles));
    if (unknown.length) {
      process.stderr.write(`not roles in this team: ${unknown.join(', ')}\n`);
      return 2;
    }
    [tabs, skipped] = prepare(hub, teamFile, roles.length ? roles : Object.keys(hub.baseTeam.roles), !flags.has('--no-owner'),
      { force: flags.has('--force'), fresh: flags.has('--fresh') });
  } finally {
    hub.close();
  }
  for (const reason of skipped) process.stderr.write(`skipping ${reason}\n`);
  if (flags.has('--dry-run')) {
    for (const tab of tabs) process.stdout.write(`${tab.map(quoteArg).join(' ')}\n`);
    return 0;
  }
  try {
    for (const tab of tabs) {
      openTab(tab);
      await new Promise((r) => setTimeout(r, 1000)); // let the named window exist before the next tab joins it
    }
  } catch (e) {
    if (!(e instanceof HubError)) throw e;
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) process.exitCode = await main();
