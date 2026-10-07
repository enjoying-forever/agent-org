/** The role tree: who reports to whom, and what each role is for. */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { dict } from './dict.ts';

export const HARNESSES = ['claude', 'codex', 'grok', 'antigravity', 'deepseek'] as const;
const ROLE_KEYS = new Set(['superior', 'harness', 'model', 'effort', 'duties', 'instructions', 'write_scope']);
const TIER_KEYS = new Set(['harness', 'model', 'effort', 'use_for', 'max_active']);
const CHECK_KEYS = new Set(['name', 'run', 'when', 'timeout']);
const TEAM_KEYS = new Set(['owner', 'project_root', 'database', 'roles', 'consultants', 'checks',
  'autostart', 'max_running', 'commit_on_accept', 'isolation', 'team_changes',
  'guard_commands', 'scan_secrets', 'max_agents']);
export const ISOLATION = ['leases', 'branches'] as const; // one writer per file, or every agent on its own git branch
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const CONSULTANT_PREFIX = 'consultant-'; // names of temporary consultant roles: consultant-1, ...

/** team.yaml is malformed or describes an invalid tree. */
export class TeamError extends Error {
  override name = 'TeamError';
}

/** As Python prints a list of strings: ['a', 'b']. Messages keep the wording people already know. */
export function pyList(items: Iterable<unknown>): string {
  return `[${[...items].map((x) => (typeof x === 'string' ? `'${x}'` : String(x))).join(', ')}]`;
}

export function pyRepr(x: unknown): string {
  return typeof x === 'string' ? `'${x}'` : x === null || x === undefined ? 'None' : String(x);
}

export class Role {
  readonly name: string;
  readonly superior: string;
  readonly harness: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly duties: string;
  readonly write_scope: readonly string[];
  readonly tier: string | null; // set for temporary consultants
  readonly instructions: string; // the role's own prompt: how to work, what to check (beyond its duties)

  constructor(r: {
    name: string; superior: string; harness: string; model?: string | null; effort?: string | null;
    duties?: string; write_scope?: readonly string[]; tier?: string | null; instructions?: string;
  }) {
    this.name = r.name;
    this.superior = r.superior;
    this.harness = r.harness;
    this.model = r.model ?? null;
    this.effort = r.effort ?? null;
    this.duties = r.duties ?? '';
    this.write_scope = Object.freeze([...(r.write_scope ?? [])]);
    this.tier = r.tier ?? null;
    this.instructions = r.instructions ?? '';
  }

  get is_consultant(): boolean {
    return this.tier !== null;
  }
}

/** A kind of consultant a superior can summon for a subordinate's help request. */
export class Tier {
  readonly name: string;
  readonly harness: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly use_for: string;
  readonly max_active: number;

  constructor(t: { name: string; harness: string; model: string | null; effort: string | null; use_for: string; max_active: number }) {
    this.name = t.name;
    this.harness = t.harness;
    this.model = t.model;
    this.effort = t.effort;
    this.use_for = t.use_for;
    this.max_active = t.max_active;
  }

  describe(): string {
    const model = [this.harness, this.model].filter((x) => x).join(' / ');
    const effort = this.effort ? `, ${this.effort} effort` : '';
    return `${this.name} (${model}${effort}, up to ${this.max_active} at once)`;
  }
}

/** A command that must pass before a task may be closed as done (a verification gate). */
export interface CheckSpec {
  readonly name: string;
  readonly run: string;
  readonly when: readonly string[]; // only if the task changed a file matching one of these
  readonly timeout: number;
}

export class Settings {
  readonly autostart: boolean = false; // start an agent by itself when it has work and is not running
  readonly max_running: number = 0; // most agents running at once (0: no limit)
  readonly commit_on_accept: boolean = true; // commit a task's files when its result is accepted
  readonly isolation: string = 'leases'; // "branches": each agent works in its own git worktree
  readonly team_changes: boolean = true; // managers may hire, change and let go of the agents below them
  readonly guard_commands: boolean = true; // refuse commands that publish, wipe shared work or delete outside
  readonly scan_secrets: boolean = true; // keep private keys and API tokens out of git history
  readonly max_agents: number = 12; // most roles the team may grow to by hiring

  constructor(s: Partial<Pick<Settings, 'autostart' | 'max_running' | 'commit_on_accept' | 'isolation' | 'team_changes'
    | 'guard_commands' | 'scan_secrets' | 'max_agents'>> = {}) {
    Object.assign(this, s);
  }

  get branches(): boolean {
    return this.isolation === 'branches';
  }
}

/** A validated tree rooted at the owner (you), with exactly one leader below it. */
export class Team {
  readonly owner: string;
  readonly project_root: string;
  readonly database: string;
  readonly roles: Readonly<Record<string, Role>>;
  readonly tiers: Readonly<Record<string, Tier>>;
  readonly checks: readonly CheckSpec[];
  readonly settings: Settings;
  private readonly children: Map<string, string[]>;

  constructor(owner: string, projectRoot: string, database: string, roles: Record<string, Role>,
    tiers: Record<string, Tier> = {}, checks: readonly CheckSpec[] = [], settings: Settings = new Settings()) {
    this.owner = owner;
    this.project_root = projectRoot;
    this.database = database;
    this.roles = dict(roles);
    this.tiers = dict(tiers);
    this.checks = checks;
    this.settings = settings;
    this.children = new Map([[owner, []], ...Object.keys(roles).map((n) => [n, []] as [string, string[]])]);
    for (const role of Object.values(roles)) {
      const siblings = this.children.get(role.superior);
      if (siblings === undefined) throw new TeamError(`${role.name}: superior '${role.superior}' is not a role or the owner`);
      if (role.superior === role.name) throw new TeamError(`${role.name}: a role cannot be its own superior`);
      siblings.push(role.name);
    }
    this.validate();
  }

  static load(file: string): Team {
    let data: unknown;
    try {
      data = readTeamFile(file);
    } catch (e) {
      throw new TeamError(`cannot read ${file}: ${(e as Error).message}`);
    }
    return Team.fromDict(data, path.dirname(path.resolve(file)));
  }

  static fromDict(data: unknown, baseDir: string): Team {
    if (!isMapping(data)) throw new TeamError('team file must be a mapping');
    const unknown = Object.keys(data).filter((k) => !TEAM_KEYS.has(k)).sort();
    if (unknown.length) throw new TeamError(`unknown team keys: ${pyList(unknown)}`);

    const owner = data.owner;
    if (typeof owner !== 'string' || !NAME_RE.test(owner)) throw new TeamError("'owner' must be a simple name, e.g. 'you'");
    if (!('project_root' in data)) throw new TeamError("'project_root' is required (the folder the agents work in)");
    const projectRoot = path.resolve(baseDir, String(data.project_root));
    const database = path.resolve(baseDir, String(data.database ?? '.agent-org/hub.db'));

    const rawRoles = data.roles;
    if (!isMapping(rawRoles) || !Object.keys(rawRoles).length) throw new TeamError("'roles' must be a non-empty mapping");
    const roles: Record<string, Role> = {};
    for (const [name, spec] of Object.entries(rawRoles)) roles[name] = parseRole(name, spec);
    if (owner in roles) throw new TeamError(`'${owner}' is the owner and cannot also be a role`);

    const rawTiers = data.consultants ?? {};
    if (!isMapping(rawTiers)) throw new TeamError("'consultants' must be a mapping of tier name to settings");
    const tiers: Record<string, Tier> = {};
    for (const [name, spec] of Object.entries(rawTiers)) tiers[name] = parseTier(name, spec);
    const rawChecks = data.checks ?? [];
    if (!Array.isArray(rawChecks)) throw new TeamError("'checks' must be a list of {name, run} entries");
    const checks = rawChecks.map((spec, i) => parseCheck(i + 1, spec));
    const maxRunning = data.max_running ?? 0;
    if (!isWhole(maxRunning) || maxRunning < 0) throw new TeamError("'max_running' must be a whole number (0 means no limit)");
    const isolation = data.isolation ?? 'leases';
    if (!(ISOLATION as readonly unknown[]).includes(isolation)) throw new TeamError(`'isolation' must be one of ${pyList(ISOLATION)}`);
    const settings = new Settings({
      autostart: truthy(data.autostart ?? false), max_running: maxRunning,
      commit_on_accept: truthy(data.commit_on_accept ?? true), isolation: isolation as string,
      team_changes: truthy(data.team_changes ?? true), guard_commands: truthy(data.guard_commands ?? true),
      scan_secrets: truthy(data.scan_secrets ?? true), max_agents: whole(data, 'max_agents', 12),
    });
    return new Team(owner, projectRoot, database, roles, tiers, checks, settings);
  }

  /** This team plus some temporary roles (the active consultants). */
  withRoles(extra: Role[]): Team {
    const roles = { ...this.roles };
    for (const r of extra) roles[r.name] = r;
    return new Team(this.owner, this.project_root, this.database, roles, { ...this.tiers }, this.checks, this.settings);
  }

  private validate(): void {
    for (const name of Object.keys(this.roles)) {
      const seen = new Set([name]);
      let current = this.roles[name].superior;
      while (current !== this.owner) {
        if (seen.has(current)) throw new TeamError(`${name}: the chain of superiors loops back on itself`);
        seen.add(current);
        current = this.roles[current].superior;
      }
    }
    const top = this.children.get(this.owner) ?? [];
    if (top.length !== 1) {
      throw new TeamError(`exactly one role must report to the owner (the leader); found ${top.length}: ${pyList(top)}`);
    }
  }

  get leader(): string {
    return (this.children.get(this.owner) ?? [])[0];
  }

  isMember(name: string): boolean {
    return name === this.owner || Object.hasOwn(this.roles, name);
  }

  superiorOf(name: string): string | null {
    return name === this.owner ? null : this.roles[name].superior;
  }

  subordinatesOf(name: string): string[] {
    return [...(this.children.get(name) ?? [])];
  }

  /** Everyone below `name`, nearest first. */
  subtreeOf(name: string): string[] {
    const found: string[] = [];
    const queue = [...(this.children.get(name) ?? [])];
    while (queue.length) {
      const current = queue.shift() as string;
      found.push(current);
      queue.push(...(this.children.get(current) ?? []));
    }
    return found;
  }

  /** Everyone above `name`, from its direct superior up to the owner. */
  chainOf(name: string): string[] {
    const chain: string[] = [];
    let current = this.superiorOf(name);
    while (current !== null) {
      chain.push(current);
      current = this.superiorOf(current);
    }
    return chain;
  }

  isAbove(upper: string, lower: string): boolean {
    return this.chainOf(lower).includes(upper);
  }

  /** Consultants can be summoned by the owner and by anyone with a regular subordinate (a consultant
   * is never helped by another consultant, so a role whose only subordinates are its consultants has
   * no one to summon for). */
  canSummon(name: string): boolean {
    if (!Object.keys(this.tiers).length) return false;
    return name === this.owner || (this.children.get(name) ?? []).some((s) => !this.roles[s].is_consultant);
  }

  treeLines(): string[] {
    const lines = [`${this.owner} (owner)`];
    const walk = (name: string, prefix: string): void => {
      const kids = this.children.get(name) ?? [];
      kids.forEach((child, i) => {
        const last = i === kids.length - 1;
        const role = this.roles[child];
        const model = role.model ? ` / ${role.model}` : '';
        const temp = role.is_consultant ? `  (consultant, ${role.tier})` : '';
        lines.push(`${prefix}${last ? '└── ' : '├── '}${child}  [${role.harness}${model}]${temp}`);
        walk(child, prefix + (last ? '    ' : '│   '));
      });
    };
    walk(this.owner, '');
    return lines;
  }
}

// The YAML library takes longer to load than a hook's whole work: it is loaded only when a team.yaml has to be
// read afresh or written (see readTeamFile).
let yamlLibrary: typeof import('yaml') | null = null;
const yaml = (): typeof import('yaml') => (yamlLibrary ??= createRequire(import.meta.url)('yaml') as typeof import('yaml'));

/** A team.yaml (YAML 1.2: in the yaml package's 1.1 mode a lone '.' - the usual project_root - reads as
 * NaN, which PyYAML never did). */
export function parseYaml(text: string): unknown {
  return yaml().parse(text, { uniqueKeys: false, merge: true });
}

/** As PyYAML's safe_dump(sort_keys=False, allow_unicode=True, width=100) wrote team files. */
export function dumpYaml(value: unknown): string {
  return yaml().stringify(value, { lineWidth: 100, minContentWidth: 0, indent: 2 });
}

/** A team.yaml's contents. Every hook and tool server reads it, and it seldom changes: what it said is kept as
 * JSON in agent-org's home, under the file's size and time of change, and read from there while those match. */
export function readTeamFile(file: string): unknown {
  const st = statSync(file);
  const version = `${st.size}|${st.mtimeMs}`;
  const name = createHash('sha1').update(path.resolve(file).toLowerCase()).digest('hex');
  const kept = path.join(process.env.AGENT_ORG_HOME || path.join(os.homedir(), '.agent-org'), 'cache', 'teams', `${name}.json`);
  try {
    const cached = JSON.parse(readFileSync(kept, 'utf8'));
    if (cached.version === version) return cached.data;
  } catch {
    // not kept yet, or unreadable: read the file itself
  }
  const data = parseYaml(readFileSync(file, 'utf8'));
  try {
    mkdirSync(path.dirname(kept), { recursive: true });
    writeFileSync(kept, JSON.stringify({ file: path.resolve(file), version, data }), 'utf8');
  } catch {
    // read afresh next time
  }
  return data;
}

export function isMapping(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isWhole(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x);
}

/** Python's bool(): empty strings, 0 and None are false. */
function truthy(x: unknown): boolean {
  return Boolean(x) && !(Array.isArray(x) && x.length === 0) && !(isMapping(x) && Object.keys(x).length === 0);
}

function whole(data: Record<string, unknown>, key: string, fallback: number): number {
  const value = data[key] ?? fallback;
  if (!isWhole(value) || value < 1) throw new TeamError(`'${key}' must be a whole number of at least 1`);
  return value;
}

function parseCheck(number: number, spec: unknown): CheckSpec {
  if (!isMapping(spec)) throw new TeamError(`check ${number}: must be a mapping with 'name' and 'run'`);
  const unknown = Object.keys(spec).filter((k) => !CHECK_KEYS.has(k)).sort();
  if (unknown.length) throw new TeamError(`check ${number}: unknown keys ${pyList(unknown)}`);
  const run = spec.run;
  if (typeof run !== 'string' || !run.trim()) throw new TeamError(`check ${number}: 'run' must be the command to run`);
  let when = spec.when ?? [];
  if (typeof when === 'string') when = [when];
  if (!Array.isArray(when) || !when.every((w) => typeof w === 'string')) {
    throw new TeamError(`check ${number}: 'when' must be a pattern or a list of patterns`);
  }
  const timeout = spec.timeout ?? 300;
  if (!isWhole(timeout) || timeout < 1) throw new TeamError(`check ${number}: 'timeout' must be a number of seconds`);
  return Object.freeze({ name: String(spec.name || run.split(/\s+/)[0]), run: run.trim(), when: Object.freeze([...when]), timeout });
}

function parseTier(name: string, spec: unknown): Tier {
  if (!NAME_RE.test(name)) throw new TeamError(`invalid consultant tier name ${pyRepr(name)}: use letters, digits, '-' and '_'`);
  if (!isMapping(spec)) throw new TeamError(`consultant tier ${name}: must be a mapping`);
  const unknown = Object.keys(spec).filter((k) => !TIER_KEYS.has(k)).sort();
  if (unknown.length) throw new TeamError(`consultant tier ${name}: unknown keys ${pyList(unknown)}`);
  const harness = spec.harness;
  if (!(HARNESSES as readonly unknown[]).includes(harness)) {
    throw new TeamError(`consultant tier ${name}: 'harness' must be one of ${pyList(HARNESSES)}`);
  }
  const maxActive = spec.max_active ?? 1;
  if (!isWhole(maxActive) || maxActive < 1) {
    throw new TeamError(`consultant tier ${name}: 'max_active' must be a whole number of at least 1`);
  }
  return new Tier({
    name, harness: harness as string,
    model: spec.model == null ? null : String(spec.model),
    effort: spec.effort == null ? null : String(spec.effort),
    use_for: String(spec.use_for ?? '').trim(),
    max_active: maxActive,
  });
}

function parseRole(name: string, spec: unknown): Role {
  if (!NAME_RE.test(name)) throw new TeamError(`invalid role name ${pyRepr(name)}: use letters, digits, '-' and '_'`);
  if (name.startsWith(CONSULTANT_PREFIX)) throw new TeamError(`${name}: names starting with '${CONSULTANT_PREFIX}' are kept for consultants`);
  if (!isMapping(spec)) throw new TeamError(`${name}: role must be a mapping`);
  const unknown = Object.keys(spec).filter((k) => !ROLE_KEYS.has(k)).sort();
  if (unknown.length) throw new TeamError(`${name}: unknown keys ${pyList(unknown)}`);
  const superior = spec.superior;
  if (typeof superior !== 'string') throw new TeamError(`${name}: 'superior' is required`);
  const harness = spec.harness;
  if (!(HARNESSES as readonly unknown[]).includes(harness)) throw new TeamError(`${name}: 'harness' must be one of ${pyList(HARNESSES)}`);
  const scope = spec.write_scope ?? [];
  if (!Array.isArray(scope) || !scope.every((p) => typeof p === 'string')) {
    throw new TeamError(`${name}: 'write_scope' must be a list of path patterns`);
  }
  return new Role({
    name, superior, harness: harness as string,
    model: spec.model == null ? null : String(spec.model),
    effort: spec.effort == null ? null : String(spec.effort),
    duties: String(spec.duties ?? '').trim(),
    write_scope: scope as string[],
    instructions: String(spec.instructions || '').trim().slice(0, 8000),
  });
}
