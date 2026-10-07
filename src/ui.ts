/**
 * The owner's page: team, tasks, messages, files, consultants, the team editor and setup - and the local web
 * server behind it, which the agent-org window (Electron) shows. Without a team it opens on a welcome page,
 * where you open or create one.
 *
 * Only the agent-org window (or your browser, signed in) can act as you through it - not other web sites, and
 * not other programs on this PC (the agents' shells included):
 * - It serves on 127.0.0.1, and refuses other Host names (DNS rebinding).
 * - The window is opened with a sign-in code that works once, for two minutes; it is traded for an HttpOnly,
 *   SameSite=Strict session cookie. The session secret is never printed or put on a command line.
 * - Every API call needs that cookie plus the page's own header; POSTs must be JSON with a known size, and
 *   requests another site's page sends (Origin, Sec-Fetch-Site) are refused.
 * - Strict headers on everything: a Content-Security-Policy (only its own scripts, no framing), nosniff, no
 *   referrer, no caching. Errors never show internals; stalled connections time out.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import * as doctor from './doctor.ts';
import * as gitops from './gitops.ts';
import { BRANCH_RULE, describeStuck, Hub, HubError, LAW } from './hub.ts';
import * as launch from './launch.ts';
import * as presets from './presets.ts';
import { CODE_DIR, inTest, which } from './runtime.ts';
import type { Lock, Message, Task } from './store.ts';
import { dumpYaml, HARNESSES, parseYaml, Team, TeamError } from './team.ts';
import * as templates from './templates.ts';
import * as terminals from './terminals.ts';
import * as usage from './usage.ts';
import * as wake from './wake.ts';
import * as waker from './waker.ts';
import * as watchdog from './watchdog.ts';

export const STATIC = path.join(CODE_DIR, '..', 'static');
const CONTENT_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
export const MAX_BODY = 1_000_000;
export const NO_TEAM = 'no_team'; // error the page answers by showing the welcome screen
export const WATCH_EVERY = 30; // seconds between watchdog patrols
export const AUTOSTART_GAP = 600; // seconds before the same agent is started automatically again

// Effort levels each harness accepts (suggestions in the editor; any text is allowed).
export const EFFORTS: Record<string, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  grok: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  antigravity: ['low', 'medium', 'high'],
  deepseek: [...launch.DSH_EFFORTS],
};
const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro']; // what its API accepts
// No Haiku: it has no auto mode, so a Haiku agent stops to ask you before every edit and command.
const CLAUDE_MODELS = ['opus', 'sonnet', 'fable', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];

type Body = Record<string, any>;
type Json = unknown;

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** A request whose values are of the wrong kind (Python's KeyError / ValueError / TypeError). */
class BadRequest extends Error {}

function str(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(`'${key}' is required`);
  return value;
}

function int(value: unknown, what: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(n)) throw new BadRequest(`${what} must be a whole number`);
  return n;
}

export function parseCodex(out: string): string[] {
  const data = JSON.parse(out);
  const items = Array.isArray(data) ? data : data?.models ?? [];
  return items.filter((m: any) => m && typeof m === 'object' && (m.slug || m.id)).map((m: any) => String(m.slug || m.id));
}

export function parseGrok(out: string): string[] {
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('* ') || l.startsWith('- ')).map((l) => l.slice(2).split(' ')[0]);
}

export function parseAgy(out: string): string[] {
  return out.split(/\r?\n/).filter((l) => l.includes('\t')).map((l) => l.split('\t')[0]);
}

/** Asks each installed harness which models it offers, once, in the background. */
export class ModelCatalog {
  models: Record<string, string[]> = { claude: CLAUDE_MODELS, codex: [], grok: [], antigravity: [], deepseek: DEEPSEEK_MODELS };

  constructor(load = true) {
    if (load) void this.load();
  }

  private async load(): Promise<void> {
    for (const [harness, command, parse] of [['codex', ['codex', 'debug', 'models'], parseCodex], ['grok', ['grok', 'models'], parseGrok],
      ['antigravity', ['agy', 'models'], parseAgy]] as [string, string[], (out: string) => string[]][]) {
      const exe = which(command[0]);
      if (exe === null) continue;
      try {
        const [code, out] = await doctor.proc.run(exe, command.slice(1), 30);
        if (code === 0) this.models[harness] = parse(out);
      } catch {
        // its models stay unknown: any name can still be typed
      }
    }
  }
}

const messageJson = (m: Message): Json => ({ id: m.id, sent_at: m.sent_at, sender: m.sender, recipient: m.recipient, kind: m.kind,
  text: m.text, reply_to: m.reply_to, read: m.read_at !== null, urgent: m.urgent, task_id: m.task_id });
const lockJson = (l: Lock): Json => ({ path: l.path, owner: l.owner, claimed_at: l.claimed_at });
const taskJson = (t: Task): Json => ({ id: t.id, assigner: t.assigner, assignee: t.assignee, title: t.title, details: t.details,
  state: t.state, result: t.result, parent_id: t.parent_id, created_at: t.created_at, updated_at: t.updated_at,
  done_when: t.done_when, priority: t.priority, after: [...t.depends_on], revisions: t.revisions, checks: t.checks, commit_id: t.commit_id });

export const recentFile = (): string => path.join(templates.homeDir(), 'recent.json');

export function loadRecent(): string[] {
  try {
    const data = JSON.parse(readFileSync(recentFile(), 'utf8'));
    return Array.isArray(data) ? data.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecent(paths: string[]): void {
  mkdirSync(path.dirname(recentFile()), { recursive: true });
  writeFileSync(recentFile(), JSON.stringify(paths, null, 2), 'utf8');
}

/** Take a team off the recent list (its files stay as they are). */
export function forgetRecent(file: string): void {
  writeRecent(loadRecent().filter((p) => p !== file));
}

export function rememberRecent(teamFile: string): void {
  writeRecent([teamFile, ...loadRecent().filter((p) => path.resolve(p) !== teamFile)].slice(0, 10));
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const unquote = (p: string): string => p.trim().replace(/^"|"$/g, '');

/** What the window can do that a web page cannot: given by the Electron shell; without it, the browser. */
export interface Shell {
  show(): void;
  hide(): void;
  quit(): void;
}

/** agent-org's window: hidden while its agents run in the background, shown again when the owner starts
 * agent-org a second time (that launcher holds `launcher`, a secret good for nothing but asking to be shown),
 * and closed for good. */
export class WindowControl {
  shell: Shell | null = null; // the Electron window, when there is one
  readonly launcher = randomBytes(32).toString('base64url');
  quitting = false;
  signIn: (() => string) | null = null; // a fresh sign-in link, for the browser
  openUrl: (url: string) => void = openInBrowser;

  show(): string {
    if (this.shell === null) {
      if (this.signIn !== null) this.openUrl(this.signIn());
      return 'browser';
    }
    this.shell.show();
    return 'window';
  }

  hide(): void {
    if (this.shell === null) throw new ApiError('agent-org is not running in a window.');
    this.shell.hide();
  }

  quit(): void {
    if (this.shell === null) throw new ApiError('agent-org is not running in a window.');
    this.quitting = true;
    this.shell.quit();
  }
}

/** Open a web link in the owner's own browser. */
export function openInBrowser(url: string): void {
  spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** Show Windows' own folder picker and return what was chosen ('' for none). */
async function pickFolderWithPowerShell(title: string): Promise<string> {
  const shell = which('pwsh') ?? which('powershell');
  if (shell === null) throw new ApiError('The folder picker is not available here; type the folder path instead.');
  const script = 'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; '
    + `$d.Description = ${launch.ps(title)}; $d.ShowNewFolderButton = $true; $d.UseDescriptionForTitle = $true; `
    + "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }";
  const [, out] = await doctor.proc.run(shell, ['-NoProfile', '-STA', '-Command', script], 3600);
  return out.trim().split(/\r?\n/).at(-1) ?? '';
}

export const TEAMMATE_FIELDS = ['harness', 'model', 'effort', 'duties', 'instructions', 'write_scope', 'superior'];

/** Everything the owner can do from the page, as plain methods returning JSON-able data. */
export class App {
  teamFile: string | null = null;
  private hubOrNull: Hub | null = null;
  readonly catalog: ModelCatalog;
  private checksCache: [number, doctor.Check[]] | null = null;
  private readonly resumable = new Map<string, [string | null, boolean, number]>();
  private problemsCache: [number, watchdog.Problem[]] = [0, []];
  private historyCache: [number, boolean] = [0, false];
  private readonly autostarted = new Map<string, number>();
  // Agents run in terminals inside the agent-org window when it can host them (Windows with node-pty);
  // otherwise, or with AGENT_ORG_TABS=1, each opens in a Windows Terminal tab.
  inWindow = terminals.available() && !process.env.AGENT_ORG_TABS && !inTest();
  private readonly hosts = new Map<string, terminals.TerminalHost>(); // one per team: switching teams keeps them running
  readonly window = new WindowControl();
  readonly waker = new waker.Waker();
  private readonly timers: NodeJS.Timeout[] = [];
  // What the window does with the computer; tests and the Electron shell stand in for them.
  launcher = { openTab: launch.openTab, stopRole: launch.stopRole };
  runChecks = doctor.runChecks;
  pickFolderWith: (title: string) => Promise<string> = pickFolderWithPowerShell;
  shortcut = { target: path.join(CODE_DIR, '..', 'agent-org.cmd'), args: '', cwd: path.join(CODE_DIR, '..') };

  constructor(teamFile: string | null = null, opts: { loadModels?: boolean; watch?: boolean } = {}) {
    this.catalog = new ModelCatalog(opts.loadModels ?? true);
    if (opts.watch ?? true) {
      this.timers.push(setInterval(() => this.watch(), WATCH_EVERY * 1000));
      if (this.inWindow) this.timers.push(setInterval(() => this.wake(), waker.EVERY * 1000));
    }
    if (teamFile !== null) this.open(teamFile);
  }

  // opening and creating teams

  get hub(): Hub {
    if (this.hubOrNull === null) throw new ApiError(NO_TEAM, 412);
    return this.hubOrNull;
  }

  get me() {
    return this.hub.session(this.hub.baseTeam.owner);
  }

  private open(file: string): void {
    const teamFile = path.resolve(file);
    const hub = Hub.open(teamFile, launch.tabOpener(teamFile, (tab) => this.openTab(tab), this.inWindow)); // throws TeamError
    hub.stopper = (role: string) => this.launcher.stopRole(hub, role);
    this.hubOrNull?.close();
    this.hubOrNull = hub;
    this.teamFile = teamFile;
    this.resumable.clear();
    rememberRecent(teamFile);
  }

  /** The terminals of the open team's agents. */
  get terminals(): terminals.TerminalHost {
    void this.hub; // needs an open team
    return this.host(this.teamFile ?? '');
  }

  /** The terminals of one team's agents; their pane sizes are kept next to its hub. */
  private host(teamFile: string): terminals.TerminalHost {
    let host = this.hosts.get(teamFile);
    if (host === undefined) {
      let sizes: string | null = null;
      try {
        sizes = path.join(path.dirname(Team.load(teamFile).database), 'terminal-sizes.json');
      } catch {
        sizes = null;
      }
      host = new terminals.TerminalHost(sizes);
      this.hosts.set(teamFile, host);
    }
    return host;
  }

  /** Start an agent: in a terminal in the window, or in a Windows Terminal tab. */
  openTab(tab: string[]): void {
    if (!this.inWindow) {
      this.launcher.openTab(tab);
      return;
    }
    const [title, color, cwd, argv] = launch.tabParts(tab);
    this.terminals.open(launch.tabRole(tab), argv, cwd, title, color);
  }

  /** Start a role an agent just hired or summoned, in a terminal of this window. The agent's own tool server
   * asks (launch.windowStart): it cannot reach the window's terminals itself. Only for a team whose agents run
   * here; otherwise it opens a tab. */
  startForAgent(body: Body): Json {
    const teamFile = path.resolve(str(body, 'team'));
    const role = str(body, 'role');
    if (!this.inWindow || (!this.hosts.has(teamFile) && teamFile !== this.teamFile)) {
      throw new ApiError("that team's agents do not run in this window", 409);
    }
    const why = launch.cannotStart(true);
    if (why) throw new ApiError(why, 409);
    const own = teamFile === this.teamFile && this.hubOrNull !== null;
    const hub = own ? this.hub : Hub.open(teamFile);
    let tab: string[];
    try {
      if (!(role in hub.team.roles)) throw new ApiError(`'${role}' is not a role`, 404);
      tab = launch.roleTab(hub, teamFile, role, false, true);
    } finally {
      if (!own) hub.close();
    }
    const [title, color, cwd, argv] = launch.tabParts(tab);
    this.host(teamFile).open(role, argv, cwd, title, color);
    return { started: role };
  }

  /** New output of the terminals the page shows. `wants` is JSON: {role: [terminal id, offset]}. */
  async termRead(wants: string, signal: AbortSignal | null = null): Promise<Json> {
    let parsed: Record<string, [number, number]> | null = null;
    try {
      const raw = JSON.parse(wants);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        parsed = Object.fromEntries(Object.entries(raw).map(([k, v]) => {
          const [id, at] = (v as unknown[]).map(Number);
          if (!Number.isInteger(id) || !Number.isInteger(at)) throw new Error('bad');
          return [k, [id, at]];
        }));
      }
    } catch {
      parsed = null;
    }
    if (!parsed || !Object.keys(parsed).length || Object.keys(parsed).length > 64) throw new ApiError('say which terminals: {role: [id, offset]}');
    return { terms: await this.terminals.readMany(parsed, 15, signal) };
  }

  termInput(body: Body): Json {
    const term = this.terminals.get(str(body, 'role'));
    const data = body.data;
    if (term === undefined || typeof data !== 'string' || data.length > 65536) throw new ApiError('That agent has no terminal here.');
    term.typed(data);
    return {};
  }

  /** Open a web link from an agent's terminal in the owner's own browser (a sign-in page, say). */
  openUrl(body: Body): Json {
    const url = str(body, 'url').trim();
    if (!/^https?:\/\//i.test(url) || url.length > 4000 || /[\r\n"<> ]/.test(url)) throw new ApiError('Only web links (http or https) can be opened.');
    this.window.openUrl(url);
    return {};
  }

  termResize(body: Body): Json {
    this.terminals.resize(str(body, 'role'), int(body.cols, 'cols'), int(body.rows, 'rows'));
    return {};
  }

  /** Patrol the open team: nudge, escalate, release expired leases. */
  private watch(): void {
    const hub = this.hubOrNull;
    if (hub === null) return;
    try {
      hub.store.prune(wake.alive);
      const problems = watchdog.patrol(hub);
      if (hub.baseTeam.settings.autostart) this.autostart(hub, problems);
    } catch (e) { // a failed patrol must not end the window
      process.stderr.write(`watchdog: ${(e as Error).message}\n`);
    }
  }

  private readonly wakeHubs = new Map<string, Hub>(); // its own connections: a team you switched away from keeps running

  /** Type a line into agents resting at their prompt when work waits for them (waker). */
  private wake(): void {
    for (const [teamFile, host] of this.hosts) {
      if (!host.items().some(([, t]) => t.alive)) continue;
      try {
        let hub = this.wakeHubs.get(teamFile);
        if (hub === undefined) {
          hub = Hub.open(teamFile);
          this.wakeHubs.set(teamFile, hub);
        }
        this.waker.tick(hub, host);
      } catch (e) { // a failed look must not end the window
        process.stderr.write(`waker: ${(e as Error).message}\n`);
        this.wakeHubs.get(teamFile)?.close(); // opened afresh next time (team.yaml may have changed)
        this.wakeHubs.delete(teamFile);
      }
    }
  }

  /** Start agents that have work but are not running, within the cap, and restart agents left idle at their
   * prompt by a usage limit that has reset or an API error. */
  autostart(hub: Hub, problems: watchdog.Problem[]): void {
    if (launch.cannotStart(this.inWindow)) return; // nothing could start (the Launch button says why)
    const now = Date.now() / 1000;
    for (const p of problems) {
      if ((p.kind !== 'stopped' && p.kind !== 'stuck') || now - (this.autostarted.get(p.role) ?? 0) < AUTOSTART_GAP) continue;
      if (!(hub.team.roles[p.role]?.harness in launch.BUILDERS)) continue;
      if (p.kind === 'stuck') {
        this.launcher.stopRole(hub, p.role);
        if (hub.store.online()[p.role]) { // its program did not stop: leave it for a while
          this.autostarted.set(p.role, now);
          hub.event('agent', p.role, 'could not be restarted automatically: its program did not stop');
          continue;
        }
      }
      const [tabs] = launch.prepare(hub, this.teamFile ?? '', [p.role], false, { limit: hub.baseTeam.settings.max_running, quiet: this.inWindow });
      if (!tabs.length) continue; // at the cap: it waits for a free place
      this.autostarted.set(p.role, now);
      this.openTab(tabs[0]);
      hub.event('agent', p.role, p.kind === 'stuck' ? 'restarted automatically: it was stuck with work waiting'
        : 'started automatically: it has work waiting');
    }
  }

  /** Whether the project keeps git history (cached: it runs git). */
  history(): boolean {
    if (Date.now() / 1000 - this.historyCache[0] > 30) this.historyCache = [Date.now() / 1000, gitops.isOwnRepo(this.hub.baseTeam.project_root)];
    return this.historyCache[1];
  }

  enableHistory(): Json {
    const state = gitops.init(this.hub.baseTeam.project_root);
    this.historyCache = [0, false];
    this.hub.event('git', this.hub.baseTeam.owner, 'turned history on');
    return { history: state };
  }

  taskChanges(taskId: number): Json {
    const [task] = this.me.taskDetails(taskId); // the owner may see every task; this checks it exists
    const files = this.hub.store.taskFiles(taskId);
    if (this.hub.branches) { // landed: the merge into main; still working: its branch against main
      const root = this.hub.baseTeam.project_root;
      let diff = '';
      try {
        const wt = this.hub.rootOf(task.assignee);
        diff = task.commit_id ? gitops.commitDiff(root, task.commit_id)
          : existsSync(path.join(wt, '.git')) ? gitops.branchDiff(wt, gitops.mainBranch(root)) : '';
      } catch {
        diff = '';
      }
      return { files, history: true, diff, branch: true };
    }
    const history = this.history();
    return { files, history, diff: history ? gitops.diff(this.hub.baseTeam.project_root, files) : '' };
  }

  problems(): watchdog.Problem[] {
    if (Date.now() / 1000 - this.problemsCache[0] > 5) this.problemsCache = [Date.now() / 1000, watchdog.patrol(this.hub, false)];
    return this.problemsCache[1];
  }

  close(): void {
    this.hubOrNull?.close();
    this.hubOrNull = null;
    this.teamFile = null;
  }

  /** Agents running in this window's terminals, in any team. */
  liveAgents(): string[] {
    return [...this.hosts.values()].flatMap((h) => Object.entries(h.listing()).filter(([, t]) => t.alive).map(([n]) => n));
  }

  windowAction(body: Body): Json {
    const action = str(body, 'action');
    if (action === 'hide') this.window.hide();
    else if (action === 'quit') this.window.quit();
    else if (action === 'show') this.window.show();
    else throw new ApiError('action must be hide, quit or show');
    return {};
  }

  /** agent-org is ending: its agents' terminals end with it. */
  async shutdown(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.close();
    for (const hub of this.wakeHubs.values()) hub.close();
    this.wakeHubs.clear();
    await Promise.all([...this.hosts.values()].map((h) => h.closeAll()));
  }

  home(): Json {
    const recent = loadRecent().map((p) => ({ path: p, name: path.basename(path.dirname(p)), exists: isFile(p) }));
    return { open: this.hubOrNull !== null, team_file: this.teamFile ?? '', recent, templates: templates.catalogue(),
      default: templates.defaultTemplate() };
  }

  openTeam(body: Body): Json {
    let file = unquote(str(body, 'path'));
    if (isDir(file)) file = path.join(file, 'team.yaml');
    if (!isFile(file)) throw new ApiError(`There is no team.yaml at ${file}. Create a team there instead.`);
    try {
      this.open(file);
    } catch (e) {
      if (e instanceof TeamError) throw new ApiError(`That team.yaml has a problem: ${e.message}`);
      throw e;
    }
    return { team_file: this.teamFile };
  }

  createTeam(body: Body): Json {
    const folder = unquote(str(body, 'folder'));
    const picked = body.roles;
    const template = picked ? '' : str(body, 'template');
    if (!picked && !templates.ids().includes(template)) throw new ApiError(`Unknown team template '${template}'.`);
    if (!path.isAbsolute(folder)) throw new ApiError('Choose a full folder path, for example E:\\projects\\my-app.');
    const teamFile = path.join(folder, 'team.yaml');
    if (existsSync(teamFile) && !body.overwrite) throw new ApiError(`${teamFile} already exists. Open it instead, or choose another folder.`);
    const config = picked ? App.teamFromRoles(picked) : templates.teamConfig(template);
    try {
      Team.fromDict(config, folder);
    } catch (e) {
      if (e instanceof TeamError) throw new ApiError(`That team is not complete yet: ${e.message}`);
      throw e;
    }
    mkdirSync(folder, { recursive: true });
    writeFileSync(teamFile, dumpYaml(config), 'utf8');
    this.open(teamFile);
    return { team_file: this.teamFile };
  }

  /** A team.yaml built from market roles: [{id, name, superior}], superiors by name ('you' = leader). */
  static teamFromRoles(picked: unknown): Body {
    if (!Array.isArray(picked) || !picked.length) throw new ApiError('Pick at least one role for the team.');
    const roles: Body = {};
    for (const item of picked) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiError('Each picked role needs an id, a name and whom it reports to.');
      try {
        const name = String(item.name ?? '').trim() || presets.roleName(String(item.id), new Set(Object.keys(roles)));
        roles[name] = presets.teamRole(String(item.id), String(item.superior || 'you'));
      } catch (e) {
        if (e instanceof presets.KeyError) throw new ApiError(`There is no role '${item.id}' in the market.`);
        throw e;
      }
    }
    return { owner: 'you', project_root: '.', roles, consultants: templates.CONSULTANTS };
  }

  /** Put an 'agent-org' shortcut on the Windows desktop that opens agent-org. */
  desktopShortcut(): Json {
    const { target, args, cwd } = this.shortcut;
    const script = '$s = (New-Object -ComObject WScript.Shell).CreateShortcut('
      + "[IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'agent-org.lnk')); "
      + `$s.TargetPath = ${launch.ps(target)}; $s.Arguments = ${launch.ps(args)}; $s.WorkingDirectory = ${launch.ps(cwd)}; `
      + "$s.Description = 'Run your team of AI agents'; $s.Save(); $s.FullName";
    const shell = which('pwsh') ?? which('powershell');
    if (shell === null) throw new ApiError('PowerShell is needed to create the shortcut.');
    const done = spawnSync(shell, ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (done.status !== 0) throw new ApiError(`Could not create the shortcut: ${(done.stderr ?? '').trim().slice(0, 300)}`);
    return { shortcut: (done.stdout ?? '').trim() };
  }

  forgetRecent(body: Body): Json {
    forgetRecent(str(body, 'path'));
    return {};
  }

  closeTeam(): Json {
    this.close();
    return { open: false };
  }

  async pickFolder(body: Body): Promise<Json> {
    const chosen = await this.pickFolderWith(typeof body.title === 'string' && body.title ? body.title : 'Choose a folder');
    return { path: chosen ? path.resolve(chosen) : '' };
  }

  // setup checks

  async checks(fresh = false): Promise<Json> {
    const used = this.hubOrNull ? new Set(Object.values(this.hubOrNull.team.roles).map((r) => r.harness)) : null;
    if (fresh || this.checksCache === null || Date.now() / 1000 - this.checksCache[0] > 60) {
      this.checksCache = [Date.now() / 1000, await this.runChecks(used)];
    }
    return { checks: this.checksCache[1] };
  }

  installGrokHooks(): Json {
    const file = launch.installGrokHooks();
    this.checksCache = null;
    return { installed: file };
  }

  // reading

  /** Whether the role's next start resumes a conversation (cached: it looks at files). */
  private resumes(role: string, harness: string): boolean {
    const record = this.hub.store.getSession(role);
    const sid = record && record.harness === harness ? record.session_id : null;
    const cached = this.resumable.get(role);
    if (cached && cached[0] === sid && Date.now() / 1000 - cached[2] < (sid ? 30 : 300)) return cached[1];
    const found = launch.resumableSession(this.hub, role) !== null;
    this.resumable.set(role, [sid, found, Date.now() / 1000]);
    return found;
  }

  state(): Json {
    const team = this.hub.team;
    const store = this.hub.store;
    const statuses = store.statuses();
    const unread = store.unreadCounts();
    const locks = store.locks();
    store.prune(wake.alive); // a process killed with its terminal is not a second session
    const online = store.online();
    const openTasks = store.tasks({ openOnly: true });
    const stuck = this.hub.stuck();
    const terms = this.inWindow ? this.termListing() : {};
    const roles = [team.leader, ...team.subtreeOf(team.leader)].map((name) => {
      const r = team.roles[name];
      const s = statuses[name];
      const consultant = r.is_consultant ? store.getConsultant(name) : null;
      return {
        name, superior: r.superior, harness: r.harness, model: r.model, effort: r.effort, duties: r.duties,
        write_scope: [...r.write_scope], tier: r.tier, help_id: consultant ? consultant.help_id : null,
        status: s ? { state: s.state, task: s.task, updated_at: s.updated_at } : null,
        unread: unread[name] ?? 0,
        locks: locks.filter((l) => l.owner === name).map((l) => l.path),
        online: online[name] ?? 0,
        open_tasks: openTasks.filter((t) => t.assignee === name).length,
        notes: store.getNotes(name),
        resumes: this.resumes(name, r.harness),
        usage: this.usage(name, r.harness),
        stuck: name in stuck ? { ...stuck[name], describe: describeStuck(stuck[name]) } : null,
        terminal: terms[name] ?? null,
      };
    });
    const s = team.settings;
    return {
      owner: team.owner, leader: team.leader, project_root: team.project_root, team_file: this.teamFile, roles,
      tiers: Object.values(team.tiers).map((t) => ({ name: t.name, harness: t.harness, model: t.model, effort: t.effort, use_for: t.use_for,
        max_active: t.max_active, active: roles.filter((r) => r.tier === t.name).length })),
      locks: locks.map(lockJson),
      tasks: store.tasks({ limit: 60 }).map(taskJson),
      problems: this.problems(),
      history: this.history(),
      settings: { autostart: s.autostart, max_running: s.max_running, commit_on_accept: s.commit_on_accept, isolation: s.isolation,
        team_changes: s.team_changes, checks: team.checks.map((c) => c.name) },
      last_event: store.lastEventId(),
      owner_unread: unread[team.owner] ?? 0,
      launchable: Object.keys(launch.BUILDERS),
      in_window: this.inWindow,
    };
  }

  /** The open team's terminals, each with whether its program is asking the owner something (a menu, a
   * permission or trust question) once it has gone quiet - so a page that is not showing the terminals (its
   * window hidden) can still tell the owner. */
  private termListing(): Record<string, { id: number; alive: boolean; title: string; color: string; asking: boolean }> {
    const now = Date.now() / 1000;
    return Object.fromEntries(this.terminals.items().map(([name, t]) => [name, { id: t.id, alive: t.alive, title: t.title, color: t.color,
      asking: t.alive && now - t.lastOutput >= waker.QUIET && waker.asking(t) }]));
  }

  /** Everything the role has used: every conversation it has had (a fresh start keeps the count), in whichever
   * program it ran then, and its DeepSeek runs. */
  private usage(role: string, harness: string): Json {
    const parts: usage.Usage[] = [];
    for (const [h, sid] of this.hub.store.conversations(role)) {
      if (h === 'deepseek') continue;
      const found = usage.usage(h, sid);
      if (found !== null) parts.push(found);
    }
    const dsh = path.join(path.dirname(this.hub.team.database), 'launch', role, usage.DSH_USAGE);
    if (isFile(dsh)) parts.push(usage.deepseek(dsh));
    if (!parts.length) return null;
    const record = this.hub.store.getSession(role);
    const current = record && record.harness === harness ? usage.usage(harness, record.session_id) : null;
    return { ...usage.total(parts), conversations: parts.length, limits: current ? current.limits : [] };
  }

  events(after: number): Json {
    return { events: this.hub.store.eventsAfter(after).map((e) => ({ id: e.id, at: e.at, kind: e.kind, role: e.role, text: e.text, task_id: e.task_id })) };
  }

  taskDetails(taskId: number): Json {
    const [task, thread] = this.me.taskDetails(taskId);
    return { task: taskJson(task), thread: thread.map(messageJson), dependents: this.hub.store.dependents(taskId).map(taskJson) };
  }

  search(words: string): Json {
    return { messages: this.me.search(words, 60).map(messageJson) };
  }

  messages(after: number): Json {
    return { messages: this.hub.store.messagesAfter(after).map(messageJson) };
  }

  law(): Json {
    const branches = this.hubOrNull !== null && this.hub.branches;
    const rules = LAW.map(([t, r]) => (branches && t === 'One writer per file' ? BRANCH_RULE : [t, r]));
    return { law: rules.map(([title, rule]) => ({ title, rule })) };
  }

  teamConfig(): Json {
    void this.hub; // needs an open team
    const data = parseYaml(readFileSync(this.teamFile ?? '', 'utf8')) ?? {};
    return { config: data, harnesses: [...HARNESSES], models: this.catalog.models, efforts: EFFORTS, presets: presets.catalogue() };
  }

  // acting as the owner

  send(body: Body): Json {
    const to = str(body, 'to');
    const text = str(body, 'text');
    const urgent = Boolean(body.urgent);
    if (to === '@all') return { sent: this.me.broadcast('@all', text, urgent).map(messageJson) };
    const replyTo = body.reply_to == null ? null : int(body.reply_to, 'reply_to');
    return { sent: [messageJson(this.me.send(to, text, replyTo, urgent))] };
  }

  assign(body: Body): Json {
    const after = Array.isArray(body.after) ? body.after.map((x: unknown) => int(x, 'after')) : [];
    return taskJson(this.me.assignTask(str(body, 'to'), str(body, 'title'), String(body.details || ''), null, String(body.done_when || ''),
      after, body.priority ? int(body.priority, 'priority') : 2));
  }

  review(body: Body): Json {
    return taskJson(this.me.reviewTask(int(body.task_id, 'task_id'), Boolean(body.accept), String(body.feedback || '')));
  }

  cancelTask(body: Body): Json {
    return taskJson(this.me.cancelTask(int(body.task_id, 'task_id'), String(body.reason || '')));
  }

  reassign(body: Body): Json {
    return taskJson(this.me.reassignTask(int(body.task_id, 'task_id'), str(body, 'to'), String(body.reason || '')));
  }

  /** Stop a role's agent and start it again on the same conversation (after a limit or an error). */
  restart(body: Body): Json {
    const role = str(body, 'role');
    if (!(role in this.hub.team.roles)) throw new ApiError(`'${role}' is not a role`);
    const why = launch.cannotStart(this.inWindow);
    if (why) throw new ApiError(why); // before stopping it: it could not come back
    const stopped = this.launcher.stopRole(this.hub, role);
    const result = this.launch({ roles: [role] }) as Body;
    this.hub.event('agent', role, 'restarted by the owner');
    return { stopped, ...result };
  }

  summon(body: Body): Json {
    const role = this.me.summonConsultant(int(body.help_id, 'help_id'), str(body, 'tier'), String(body.brief || ''));
    return { name: role.name, tier: role.tier, superior: role.superior };
  }

  dismiss(body: Body): Json {
    const [role, returned] = this.me.dismissConsultant(str(body, 'name'));
    return { name: role.name, returned };
  }

  release(body: Body): Json {
    return lockJson(this.me.release(str(body, 'path')));
  }

  readInbox(): Json {
    return { messages: this.me.readInbox().map(messageJson) };
  }

  /** Start agents: the given roles, or every role in team.yaml. Each role resumes its last conversation unless
   * `fresh`; roles that are already running are skipped unless `force`. */
  launch(body: Body): Json {
    const team = this.hub.team;
    const names: string[] = Array.isArray(body.roles) && body.roles.length ? body.roles.map(String) : Object.keys(this.hub.baseTeam.roles);
    for (const name of names) if (!(name in team.roles)) throw new ApiError(`'${name}' is not a role`);
    const why = launch.cannotStart(this.inWindow);
    if (why) throw new ApiError(why);
    const [tabs, skipped] = launch.prepare(this.hub, this.teamFile ?? '', names, false, { force: Boolean(body.force),
      fresh: Boolean(body.fresh), limit: this.hub.baseTeam.settings.max_running, quiet: this.inWindow });
    this.resumable.clear();
    const inWindow = this.inWindow;
    const opener = inWindow ? (tab: string[]) => this.openTab(tab) : this.launcher.openTab; // fixed now: the opening outlives this call
    void (async () => {
      for (const tab of tabs) {
        try {
          opener(tab);
        } catch (e) {
          process.stderr.write(`could not open a tab: ${(e as Error).message}\n`);
        }
        if (!inWindow) await new Promise((r) => setTimeout(r, 1000)); // let the named window exist before the next tab joins it
      }
    })();
    return { opening: tabs.map((t) => t[t.indexOf('--title') + 1]), skipped };
  }

  /** Stop one role's agent, or every running agent (role '@all'). */
  stop(body: Body): Json {
    const role = str(body, 'role');
    const team = this.hub.team;
    if (role !== '@all' && !(role in team.roles)) throw new ApiError(`'${role}' is not a role`);
    const names = role === '@all' ? Object.keys(team.roles).filter((n) => this.hub.store.online()[n]) : [role];
    return { stopped: Object.fromEntries(names.map((n) => [n, this.launcher.stopRole(this.hub, n)])) };
  }

  /** Keep the open team (as saved in team.yaml) to start new projects from. */
  saveTemplate(body: Body): Json {
    const config = (parseYaml(readFileSync(this.teamFile ?? '', 'utf8')) ?? {}) as Body;
    let template: string;
    try {
      template = templates.save(str(body, 'name'), config, Boolean(body.default));
    } catch (e) {
      if (e instanceof ApiError || e instanceof templates.KeyError) throw e;
      throw new ApiError((e as Error).message);
    }
    return { template, default: templates.defaultTemplate() };
  }

  // the Role Market

  roles(): Json {
    const open = this.hubOrNull !== null;
    return { roles: presets.catalogue(), harnesses: [...HARNESSES], models: this.catalog.models, efforts: EFFORTS,
      deleted_built_ins: presets.hidden().length, team_open: open, team_roles: open ? Object.keys(this.hub.team.roles) : [],
      owner: open ? this.hub.baseTeam.owner : '' };
  }

  roleSave(body: Body): Json {
    const role = body.role;
    if (!role || typeof role !== 'object' || Array.isArray(role)) throw new ApiError("send the role's settings");
    try {
      return { id: presets.save(String(role.title || ''), role, body.id || null), roles: presets.catalogue() };
    } catch (e) {
      if (e instanceof presets.RoleError) throw new ApiError(e.message);
      throw e;
    }
  }

  roleDuplicate(body: Body): Json {
    return this.knownRole(() => ({ id: presets.duplicate(str(body, 'id')), roles: presets.catalogue() }));
  }

  roleImport(body: Body): Json {
    try {
      return { id: presets.importText(str(body, 'text')), roles: presets.catalogue() };
    } catch (e) {
      if (e instanceof presets.RoleError) throw new ApiError(e.message);
      throw e;
    }
  }

  roleExport(preset: string): Json {
    return this.knownRole(() => {
      const [filename, text] = presets.exportText(preset);
      return { filename, text };
    });
  }

  private knownRole(body: () => Json, message = 'There is no such role.'): Json {
    try {
      return body();
    } catch (e) {
      if (e instanceof presets.KeyError) throw new ApiError(message);
      throw e;
    }
  }

  /** Put a market role into the open team, under `superior` (the owner makes it the leader). */
  rolePlace(body: Body): Json {
    const preset = str(body, 'id');
    const superior = str(body, 'superior');
    const team = this.hub.team;
    if (superior !== team.owner && !(superior in team.roles)) throw new ApiError(`'${superior}' is not in this team`);
    let name = '';
    let spec: Body = {};
    this.knownRole(() => {
      name = String(body.name ?? '').trim() || presets.roleName(preset, new Set(Object.keys(team.roles)));
      spec = presets.teamRole(preset, superior);
      return null;
    });
    if (name in team.roles || name === team.owner) throw new ApiError(`There is already a '${name}' in the team.`);
    this.hub.editTeam((config) => {
      const roles = (config.roles && typeof config.roles === 'object' ? config.roles : (config.roles = {})) as Body;
      roles[name] = spec;
    });
    this.hub.event('team', team.owner, `placed ${name} (${spec.harness}) under ${superior} from the Role Market`);
    return { name };
  }

  /** Keep one role's settings in the library, to reuse in any team. */
  savePreset(body: Body): Json {
    const role = body.role;
    if (!role || typeof role !== 'object' || Array.isArray(role)) throw new ApiError("send the role's settings");
    try {
      return { preset: presets.save(str(body, 'name'), role), presets: presets.catalogue() };
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError((e as Error).message);
    }
  }

  deletePreset(body: Body): Json {
    return this.knownRole(() => {
      presets.remove(str(body, 'id'));
      return { presets: presets.catalogue() };
    });
  }

  roleReset(body: Body): Json {
    return this.knownRole(() => {
      presets.reset(str(body, 'id'));
      return { roles: presets.catalogue() };
    }, 'Only a ready-made role can be reset.');
  }

  roleRestore(): Json {
    return { restored: presets.restore(), roles: presets.catalogue() };
  }

  defaultTemplate(body: Body): Json {
    try {
      templates.setDefault(str(body, 'id'));
    } catch (e) {
      if (e instanceof templates.KeyError) throw new ApiError('There is no such team.');
      throw e;
    }
    return { default: templates.defaultTemplate() };
  }

  deleteTemplate(body: Body): Json {
    try {
      templates.remove(str(body, 'id'));
    } catch (e) {
      if (e instanceof templates.KeyError) throw new ApiError('Only your own saved teams can be deleted.');
      throw e;
    }
    return { default: templates.defaultTemplate() };
  }

  // one teammate at a time (its card on the Team page, and dragging in the team list)

  /** Change one teammate in team.yaml: its program, model, effort, duties, instructions, files or whom it
   * reports to. An empty value removes the setting (its program's default). */
  teammateUpdate(body: Body): Json {
    const name = str(body, 'name');
    const changes = body.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) throw new ApiError('say what to change');
    const unknown = Object.keys(changes).filter((k) => !TEAMMATE_FIELDS.includes(k)).sort();
    if (unknown.length) throw new ApiError(`cannot change ${unknown.join(', ')} here`);
    if (!(name in this.hub.baseTeam.roles)) throw new ApiError(`'${name}' is not in team.yaml (a consultant comes from its tier: change that in Edit team)`);
    for (const [key, raw] of Object.entries(changes)) {
      if (key === 'write_scope') {
        const value = typeof raw === 'string' ? raw.replace(/\n/g, ',').split(',').map((x) => x.trim()).filter((x) => x) : raw;
        if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) throw new ApiError('files must be a list of patterns');
        changes[key] = value;
      } else if (raw !== null && typeof raw !== 'string') {
        throw new ApiError(`'${key}' must be text`);
      }
    }
    if (('superior' in changes && !changes.superior) || ('harness' in changes && !changes.harness)) {
      throw new ApiError('a teammate needs a program and someone to report to');
    }
    try {
      this.hub.editTeam((config) => {
        const role = (config.roles as Body)[name] as Body;
        for (const [key, value] of Object.entries(changes)) {
          const empty = value === '' || value === null || (Array.isArray(value) && !value.length);
          if (empty && key !== 'write_scope') delete role[key];
          else role[key] = typeof value === 'string' ? value.trim() : value;
        }
      });
    } catch (e) {
      if (e instanceof HubError) throw new ApiError(e.message);
      throw e;
    }
    this.hub.event('team', this.hub.baseTeam.owner, `changed ${name}: ${Object.keys(changes).sort().join(', ')}`);
    return { name };
  }

  /** Take a teammate out of team.yaml; the ones who reported to it now report to its superior. */
  teammateRemove(body: Body): Json {
    const name = str(body, 'name');
    const team = this.hub.baseTeam;
    if (!(name in team.roles)) throw new ApiError(`'${name}' is not in team.yaml`);
    if (this.hub.store.online()[name]) throw new ApiError(`${name} is running: stop it first.`);
    // its unfinished tasks would stay open with nobody to do them (and keep their assigners waiting)
    const busy = this.hub.store.tasks({ assignee: name, openOnly: true });
    if (busy.length) {
      throw new ApiError(`${name} still has unfinished tasks (${busy.map((t) => `#${t.id}`).join(', ')}): move them to someone else or `
        + 'cancel them first (Tasks).');
    }
    const superior = team.roles[name].superior;
    try {
      this.hub.editTeam((config) => {
        const roles = (config.roles ?? {}) as Body;
        delete roles[name];
        for (const spec of Object.values(roles)) {
          if (spec && typeof spec === 'object' && spec.superior === name) spec.superior = superior;
        }
      });
    } catch (e) {
      if (e instanceof HubError) throw new ApiError(e.message);
      throw e;
    }
    for (const lock of this.hub.store.locks(name)) this.hub.store.release(this.hub.lockKey(lock.path)[0]);
    this.hub.event('team', team.owner, `removed ${name} from the team`);
    return { removed: name, moved_to: superior };
  }

  saveTeam(body: Body): Json {
    const config = body.config;
    const teamFile = this.teamFile ?? '';
    let team: Team;
    try {
      team = Team.fromDict(config, path.dirname(teamFile));
    } catch (e) {
      if (e instanceof TeamError) throw new ApiError(e.message);
      throw e;
    }
    if (team.database !== this.hub.baseTeam.database) throw new ApiError("changing 'database' from the UI is not supported");
    const backup = `${teamFile}.bak`;
    writeFileSync(backup, readFileSync(teamFile, 'utf8'), 'utf8');
    writeFileSync(teamFile, dumpYaml(config), 'utf8');
    this.hub.baseTeam = team;
    return { saved: teamFile, backup };
  }
}

type Query = URLSearchParams;
type Route = (app: App, arg: any, signal: AbortSignal) => Json | Promise<Json>;
const q = (query: Query, key: string, fallback = ''): string => query.get(key) ?? fallback;

export const GET_ROUTES: Record<string, Route> = {
  '/api/home': (app) => app.home(),
  '/api/state': (app) => app.state(),
  '/api/messages': (app, query: Query) => app.messages(int(q(query, 'after', '0'), 'after')),
  '/api/team': (app) => app.teamConfig(),
  '/api/law': (app) => app.law(),
  '/api/checks': (app, query: Query) => app.checks(q(query, 'fresh', '0') === '1'),
  '/api/events': (app, query: Query) => app.events(int(q(query, 'after', '0'), 'after')),
  '/api/task': (app, query: Query) => app.taskDetails(int(query.get('id'), 'id')),
  '/api/search': (app, query: Query) => app.search(q(query, 'q')),
  '/api/task-changes': (app, query: Query) => app.taskChanges(int(query.get('id'), 'id')),
  '/api/roles': (app) => app.roles(),
  '/api/role-export': (app, query: Query) => app.roleExport(q(query, 'id')),
  '/api/terms': (app, query: Query, signal) => app.termRead(q(query, 'w'), signal),
};

const post = (method: (this: App, body: Body) => Json | Promise<Json>): Route => (app, body: Body) => method.call(app, body);
export const POST_ROUTES: Record<string, Route> = {
  '/api/open': post(App.prototype.openTeam), '/api/create': post(App.prototype.createTeam), '/api/close': post(App.prototype.closeTeam),
  '/api/forget-recent': post(App.prototype.forgetRecent),
  '/api/pick-folder': post(App.prototype.pickFolder), '/api/install-grok-hooks': post(App.prototype.installGrokHooks),
  '/api/desktop-shortcut': post(App.prototype.desktopShortcut),
  '/api/send': post(App.prototype.send), '/api/task': post(App.prototype.assign), '/api/cancel-task': post(App.prototype.cancelTask),
  '/api/summon': post(App.prototype.summon), '/api/dismiss': post(App.prototype.dismiss), '/api/release': post(App.prototype.release),
  '/api/inbox/read': post(App.prototype.readInbox), '/api/launch': post(App.prototype.launch), '/api/stop': post(App.prototype.stop),
  '/api/team': post(App.prototype.saveTeam), '/api/review': post(App.prototype.review), '/api/history': post(App.prototype.enableHistory),
  '/api/reassign': post(App.prototype.reassign), '/api/restart': post(App.prototype.restart), '/api/save-template': post(App.prototype.saveTemplate),
  '/api/default-template': post(App.prototype.defaultTemplate), '/api/delete-template': post(App.prototype.deleteTemplate),
  '/api/save-preset': post(App.prototype.savePreset), '/api/delete-preset': post(App.prototype.deletePreset),
  '/api/role-save': post(App.prototype.roleSave), '/api/role-duplicate': post(App.prototype.roleDuplicate),
  '/api/role-delete': post(App.prototype.deletePreset), '/api/role-import': post(App.prototype.roleImport),
  '/api/role-place': post(App.prototype.rolePlace), '/api/role-reset': post(App.prototype.roleReset),
  '/api/role-restore': post(App.prototype.roleRestore),
  '/api/term-input': post(App.prototype.termInput), '/api/term-resize': post(App.prototype.termResize), '/api/open-url': post(App.prototype.openUrl),
  '/api/window': post(App.prototype.windowAction),
  '/api/teammate': post(App.prototype.teammateUpdate), '/api/teammate-remove': post(App.prototype.teammateRemove),
};

export const COOKIE = 'agent_org_session';
export const CODE_TTL = 120; // seconds a sign-in link works (and it works once)
export const PAGE_HEADER = 'X-Agent-Org'; // the page sends it; a form or a plain link from another site cannot
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    + "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
export const LAUNCHER_HEADER = launch.LAUNCHER_HEADER;

const secret = (bytes: number): string => randomBytes(bytes).toString('base64url');

function same(a: string, b: string): boolean {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Who may use the page: the window (or browser) you signed in with, and nobody else. The session secret never
 * leaves this process except as an HttpOnly cookie. What the window is opened with is a sign-in code that works
 * once and for two minutes. */
export class Access {
  readonly session: string;
  private codes = new Map<string, number>();
  now = (): number => Date.now() / 1000; // a test may move the clock

  constructor(session: string | null = null) {
    this.session = session ?? secret(32);
  }

  newCode(): string {
    const code = secret(24);
    const t = this.now();
    this.codes = new Map([...this.codes].filter(([, expires]) => expires > t));
    this.codes.set(code, t + CODE_TTL);
    return code;
  }

  redeem(code: string): boolean {
    const expires = this.codes.get(code) ?? 0;
    this.codes.delete(code);
    return expires > this.now();
  }

  cookieOk(header: string): boolean {
    return header.split(';').some((part) => {
      const at = part.indexOf('=');
      return at > 0 && part.slice(0, at).trim() === COOKIE && same(part.slice(at + 1).trim(), this.session);
    });
  }
}

/** The server's answer to one request. */
function handler(app: App, access: Access, port: () => number): http.RequestListener {
  const origin = (): string => `http://127.0.0.1:${port()}`;
  const header = (req: http.IncomingMessage, name: string): string | undefined => {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const hostOk = (req: http.IncomingMessage): boolean => // refuse other Host names: no DNS rebinding
    [`127.0.0.1:${port()}`, `localhost:${port()}`].includes(header(req, 'Host') ?? '');
  const sameSite = (req: http.IncomingMessage): boolean => { // from this page (or typed/opened directly), never another site
    const from = header(req, 'Origin');
    if (from !== undefined && from !== origin() && from !== `http://localhost:${port()}`) return false;
    return ['same-origin', 'none'].includes(header(req, 'Sec-Fetch-Site') ?? 'same-origin');
  };
  const signedIn = (req: http.IncomingMessage): boolean => {
    if (same(header(req, 'X-Org-Token') ?? '', access.session)) return true; // a program that started this server itself (tests, scripts)
    return access.cookieOk(header(req, 'Cookie') ?? '') && header(req, PAGE_HEADER) === '1';
  };

  const send = (req: http.IncomingMessage, res: http.ServerResponse, status: number, body: Buffer | string, type: string,
    extra: Record<string, string> = {}): void => {
    if (res.headersSent || res.destroyed) return;
    const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': String(data.length), ...SECURITY_HEADERS, ...extra });
    res.end(req.method === 'HEAD' ? undefined : data);
  };
  const json = (req: http.IncomingMessage, res: http.ServerResponse, status: number, data: Json): void =>
    send(req, res, status, JSON.stringify(data), 'application/json; charset=utf-8');

  /** Answer with what `run` returns, or with its error - never a stack trace. */
  const call = async (req: http.IncomingMessage, res: http.ServerResponse, where: string, run: (signal: AbortSignal) => Json | Promise<Json>): Promise<void> => {
    const gone = new AbortController(); // the page went away (closed, reloaded) while it waited
    res.on('close', () => gone.abort());
    try {
      json(req, res, 200, await run(gone.signal));
    } catch (e) {
      if (e instanceof ApiError) json(req, res, e.status, { error: e.message });
      else if (e instanceof HubError) json(req, res, 409, { error: e.message });
      else if (e instanceof TeamError) json(req, res, 400, { error: `team problem: ${e.message}` });
      else if (e instanceof BadRequest) json(req, res, 400, { error: `bad request: ${e.message}` });
      else {
        process.stderr.write(`error in ${where}: ${e instanceof Error ? e.stack : String(e)}\n`);
        json(req, res, 500, { error: 'something went wrong; see the agent-org window' });
      }
    }
  };

  const api = async (req: http.IncomingMessage, res: http.ServerResponse, routes: Record<string, Route>, where: string, arg: unknown): Promise<void> => {
    if (!sameSite(req)) return json(req, res, 403, { error: 'requests must come from the agent-org page' });
    if (!signedIn(req)) return json(req, res, 403, { error: 'not signed in' });
    const route = Object.hasOwn(routes, where) ? routes[where] : undefined;
    if (route === undefined) return json(req, res, 404, { error: `no such endpoint: ${where}` });
    await call(req, res, where, (signal) => route(app, arg, signal));
  };

  const get = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
    if (url.pathname.startsWith('/api/')) return api(req, res, GET_ROUTES, url.pathname, url.searchParams);
    const code = url.searchParams.get('code') ?? '';
    if (url.pathname === '/' && code) { // a sign-in link: trade the one-time code for the session cookie
      if (access.redeem(code)) {
        return send(req, res, 303, '', 'text/plain', { Location: '/', 'Set-Cookie': `${COOKIE}=${access.session}; HttpOnly; SameSite=Strict; Path=/` });
      }
      return send(req, res, 303, '', 'text/plain', { Location: '/' }); // used or expired
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.startsWith('/static/') ? url.pathname.slice(8) : '';
    const file = path.join(STATIC, name);
    const type = CONTENT_TYPES[path.extname(name)];
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || type === undefined || !isFile(file)) {
      return send(req, res, 404, 'not found', 'text/plain');
    }
    send(req, res, 200, readFileSync(file), type);
  };

  const postRequest = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
    if ((header(req, 'Transfer-Encoding') ?? '').toLowerCase().includes('chunked')) return json(req, res, 411, { error: 'send the body with a Content-Length' });
    const declared = header(req, 'Content-Length');
    if (declared === undefined || !/^\d+$/.test(declared.trim())) return json(req, res, 411, { error: 'Content-Length is required' });
    const length = Number(declared);
    if (length > MAX_BODY) return json(req, res, 413, { error: 'too large' });
    if ((header(req, 'Content-Type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      return json(req, res, 415, { error: 'the body must be JSON' });
    }
    if (!sameSite(req)) return json(req, res, 403, { error: 'requests must come from the agent-org page' }); // before reading anything
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > length) break;
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try {
      const text = Buffer.concat(chunks).subarray(0, length).toString('utf8');
      body = text ? JSON.parse(text) : {};
    } catch {
      return json(req, res, 400, { error: 'body must be JSON' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(req, res, 400, { error: 'body must be a JSON object' });
    const where = url.pathname;
    if (where === '/api/launcher/show' || where === '/api/launcher/start') { // a second start, or an agent's tool server
      if (!same(header(req, LAUNCHER_HEADER) ?? '', app.window.launcher)) return json(req, res, 403, { error: "not this agent-org's launcher" });
      if (where === '/api/launcher/show') return json(req, res, 200, { shown: app.window.show() });
      return call(req, res, where, () => app.startForAgent(body as Body));
    }
    await api(req, res, POST_ROUTES, where, body);
  };

  return (req, res) => {
    void (async () => {
      try {
        if (!hostOk(req)) return send(req, res, 403, 'bad host', 'text/plain');
        const url = new URL(req.url ?? '/', origin());
        if (req.method === 'GET' || req.method === 'HEAD') return await get(req, res, url);
        if (req.method === 'POST') return await postRequest(req, res, url);
        send(req, res, 405, 'not allowed', 'text/plain', { Allow: 'GET, HEAD, POST' }); // no CORS preflight is ever answered
      } catch (e) {
        process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
        if (!res.headersSent) send(req, res, 500, 'error', 'text/plain');
      }
    })();
  };
}

export interface Served { server: http.Server; app: App; access: Access; port: number; base: string; close(): Promise<void> }

/** Build and start the server. Port 0 picks a free port. `token` fixes the session secret (for programs that talk
 * to the API themselves with an X-Org-Token header). */
export async function serve(teamFile: string | null, port: number, opts: { token?: string | null; loadModels?: boolean; watch?: boolean;
  quiet?: boolean } = {}): Promise<Served> {
  const app = new App(teamFile, { loadModels: opts.loadModels, watch: opts.watch });
  const access = new Access(opts.token ?? null);
  let bound = port;
  const server = http.createServer(handler(app, access, () => bound));
  server.requestTimeout = 60_000; // a stalled or very slow request is dropped (a terminal read waits up to 15 s)
  server.headersTimeout = 30_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (e) {
    await app.shutdown();
    throw e;
  }
  bound = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${bound}/`;
  app.window.signIn = () => `${base}?code=${access.newCode()}`;
  return {
    server, app, access, port: bound, base,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await app.shutdown();
    },
  };
}

export const windowStateFile = (): string => path.join(templates.homeDir(), 'window', 'state.json');

export interface WindowState { x?: number; y?: number; width?: number; height?: number; maximized?: boolean }

/** Where and how big the window was last time ({} the first time). */
export function loadWindowState(): WindowState {
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(windowStateFile(), 'utf8'));
  } catch {
    return {};
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {};
  return Object.fromEntries(Object.entries(state).filter(([k, v]) => ['x', 'y', 'width', 'height', 'maximized'].includes(k)
    && (k === 'maximized' ? typeof v === 'boolean' : Number.isInteger(v))));
}

export function saveWindowState(state: WindowState): void {
  try {
    mkdirSync(path.dirname(windowStateFile()), { recursive: true });
    writeFileSync(windowStateFile(), JSON.stringify(state), 'utf8');
  } catch {
    // not remembered: it opens at its usual size next time
  }
}

/** The window's size (at least the minimum) and place from the saved state - its place only if that is still on
 * one of the `screens` [x, y, width, height]: a monitor may be gone. */
export function windowGeometry(state: WindowState, screens: [number, number, number, number][]): WindowState {
  const geo: WindowState = { width: Math.max(900, state.width ?? 1520), height: Math.max(600, state.height ?? 950), maximized: Boolean(state.maximized) };
  const { x, y } = state;
  if (x !== undefined && y !== undefined && screens.some(([sx, sy, sw, sh]) => sx <= x + 40 && x + 40 < sx + sw && sy <= y + 10 && y + 10 < sy + sh)) {
    Object.assign(geo, { x, y });
  }
  return geo;
}

/** Where a running agent-org says how a second start can reach it. */
export const instanceFile = (): string => path.join(templates.homeDir(), 'instance.json');

export function writeInstance(port: number, launcher: string): void {
  try {
    mkdirSync(path.dirname(instanceFile()), { recursive: true });
    writeFileSync(instanceFile(), JSON.stringify({ pid: process.pid, port, launcher }), 'utf8');
  } catch {
    // a second start then opens a second agent-org
  }
}

export function removeInstance(): void {
  try {
    if (JSON.parse(readFileSync(instanceFile(), 'utf8')).pid === process.pid) unlinkSync(instanceFile());
  } catch {
    // another agent-org's, or gone already
  }
}

/** Ask an agent-org that is already running to show its window. True if one did. */
export async function showRunning(timeout = 3): Promise<boolean> {
  let info: Body;
  try {
    info = JSON.parse(readFileSync(instanceFile(), 'utf8'));
  } catch {
    return false;
  }
  const port = Number(info.port);
  if (!Number.isInteger(port) || !info.launcher) return false;
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/launcher/show', method: 'POST', agent: false, timeout: timeout * 1000,
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Content-Length': '2', [LAUNCHER_HEADER]: String(info.launcher) } },
    (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end('{}');
  });
}

/** agent-org in the browser, for a computer without the app's window: `ui [--team team.yaml] [--port 8765] [--no-browser]`. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const at = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const teamFile = at('--team') ? path.resolve(at('--team') ?? '') : null;
  const noBrowser = argv.includes('--no-browser');
  if (!noBrowser && await showRunning()) {
    process.stdout.write('agent-org is already running: its window is back in front.\n');
    return 0;
  }
  let served: Served;
  try {
    try {
      served = await serve(teamFile, Number(at('--port') ?? 8765));
    } catch (e) {
      if (e instanceof TeamError) throw e;
      served = await serve(teamFile, 0); // the usual port is taken (another agent-org?): use any free one
    }
  } catch (e) {
    process.stderr.write(e instanceof TeamError ? `team error: ${e.message}\n` : `cannot start agent-org: ${(e as Error).message}\n`);
    return e instanceof TeamError ? 2 : 1;
  }
  writeInstance(served.port, served.app.window.launcher);
  process.stdout.write(`agent-org is running.${served.app.teamFile ? ` Team: ${served.app.teamFile}` : ''}\n`
    + 'Keep this window open while you use agent-org. Sign-in links work once, for two minutes; press Enter here for a new one.\n');
  const link = (): string => served.app.window.signIn?.() ?? served.base;
  if (noBrowser) process.stdout.write(`  ${link()}\n`);
  else openInBrowser(link());
  process.stdin.on('data', () => process.stdout.write(`  ${link()}   (works once, for two minutes)\n`));
  await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
  await served.close();
  removeInstance();
  return 0;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) process.exit(await main());
