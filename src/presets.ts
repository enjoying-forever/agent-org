/**
 * The Role Market: packaged, reusable roles - a role's program, model, reasoning effort, duties (its tasks),
 * instructions (its prompt) and files, with a name, icon, description and tags to find it by. Place one in any
 * team from the Roles page, build a new team from them, or let a manager hire one (hire_agent preset=...).
 *
 * A few come ready-made; the owner's own live in ~/.agent-org/roles/<id>.yaml, and can be exported to a file
 * and imported again. The ready-made ones can be edited too (the edited copy lives in roles/built-in/<id>.yaml,
 * and "reset" goes back to the original) and deleted (hidden; "restore" brings every deleted one back).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dumpYaml, HARNESSES, isMapping, NAME_RE, parseYaml } from './team.ts';
import { homeDir, KeyError } from './templates.ts';

export { KeyError };

type Spec = Record<string, unknown>;

const MINE = 'my:';
const FIELDS = new Set(['harness', 'model', 'effort', 'duties', 'instructions', 'write_scope']); // what a team role gets
const MAX_TEXT = 8000;

export const BUILT_IN: Record<string, Spec> = {
  planner: {
    title: 'Planner / leader', icon: '🧭', tags: ['lead', 'planning'],
    description: 'Turns your goal into a plan, hands out tasks and checks every result.',
    harness: 'claude', model: 'opus', effort: 'high',
    duties: 'Understand what the owner wants, plan it in PLAN.md, split the work into tasks for your team, '
      + 'review what comes back, and report the result to the owner.',
    instructions: "Keep PLAN.md short: the goal, the tasks with their 'done when', and what is decided.\n"
      + 'Give each task to the cheapest agent that can do it well. Review every result against '
      + "its 'done when' before you build on it; send it back with specific feedback if needed.",
    write_scope: ['PLAN.md', 'docs/*'],
  },
  coder: {
    title: 'Coder', icon: '⌨️', tags: ['code'],
    description: 'Implements tasks in small, tested steps.',
    harness: 'codex', model: 'gpt-6-luna', effort: 'medium',
    duties: 'Implement the tasks you are given, check that they work, and report back.',
    instructions: 'Read the code around a change before you make it and follow its style.\n'
      + 'Keep each change as small as the task allows. Run the code or its tests before you '
      + 'finish, and say in your result what you ran and what it showed.',
    write_scope: ['*'],
  },
  reviewer: {
    title: 'Reviewer', icon: '🔍', tags: ['quality', 'review'],
    description: 'Checks finished work for bugs, gaps and security issues, without touching the code.',
    harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium',
    duties: 'Review finished work when asked: read the changes, run them or their tests, and report a clear verdict.',
    instructions: "Check, in this order: does it meet the task's 'done when'; bugs and missing cases; "
      + 'security (secrets, unsafe input handling); readability. Do not fix the code yourself. '
      + 'Write the review to reviews/task-<number>.md and give a verdict: ready, or exactly what must change.',
    write_scope: ['reviews/*'],
  },
  tester: {
    title: 'Tester', icon: '🧪', tags: ['quality', 'tests'],
    description: 'Writes and runs tests, and reports exactly what passes and what fails.',
    harness: 'claude', model: 'sonnet', effort: 'medium',
    duties: 'Write and run tests for the features you are given, and report what passes and what fails.',
    instructions: 'Test the behaviour a user relies on, including edge cases and errors, not the '
      + 'implementation details. Keep tests fast and independent. Report failures with the exact command and output.',
    write_scope: ['tests/*'],
  },
  researcher: {
    title: 'Researcher', icon: '📚', tags: ['research', 'web'],
    description: 'Finds current facts, libraries and examples, with sources.',
    harness: 'grok', model: 'grok-4.7',
    duties: 'Research what you are asked: current facts, libraries, APIs and examples.',
    instructions: 'Prefer primary sources (official docs, release notes, the code itself) and give every '
      + 'claim its source. Write findings to research/<topic>.md and report the path with a short summary.',
    write_scope: ['research/*'],
  },
  'deepseek-coder': {
    title: 'Coder (DeepSeek)', icon: '🐋', tags: ['code'],
    description: 'A coder on DeepSeek Harness, for parallel work on your DeepSeek account.',
    harness: 'deepseek', model: 'deepseek-flash',
    duties: 'Implement the tasks you are given, check that they work, and report back.',
    instructions: 'Keep each change as small as the task allows, and run what you changed before you finish.',
    write_scope: ['*'],
  },
  'gemini-coder': {
    title: 'Coder (Gemini)', icon: '✨', tags: ['code'],
    description: 'A second coder on your Google plan, for parallel work.',
    harness: 'antigravity', model: 'gemini-3.8-flash-medium',
    duties: 'Implement the tasks you are given, check that they work, and report back.',
    instructions: 'Keep each change as small as the task allows, and run what you changed before you finish.',
    write_scope: ['*'],
  },
};

export class RoleError extends Error {
  override name = 'RoleError';
}

export const rolesDir = (): string => path.join(homeDir(), 'roles');
const editedDir = (): string => path.join(rolesDir(), 'built-in');
const hiddenFile = (): string => path.join(rolesDir(), 'hidden-built-ins.json');

/** The ready-made roles the owner deleted. */
export function hidden(): string[] {
  try {
    const data = JSON.parse(readFileSync(hiddenFile(), 'utf8'));
    return Array.isArray(data) ? data.filter((x) => typeof x === 'string' && x in BUILT_IN) : [];
  } catch {
    return [];
  }
}

function setHidden(list: string[]): void {
  mkdirSync(rolesDir(), { recursive: true });
  writeFileSync(hiddenFile(), JSON.stringify([...new Set(list)].sort()), 'utf8');
}

function readSpec(file: string): Spec | null {
  try {
    const spec = parseYaml(readFileSync(file, 'utf8'));
    return isMapping(spec) && spec.harness ? spec : null;
  } catch {
    return null;
  }
}

function edited(preset: string): Spec | null {
  return readSpec(path.join(editedDir(), `${preset}.yaml`));
}

/** The ready-made roles still in the market, with the owner's edits. */
function builtIn(): Record<string, Spec> {
  const gone = new Set(hidden());
  return Object.fromEntries(Object.entries(BUILT_IN).filter(([k]) => !gone.has(k)).map(([k, v]) => [k, edited(k) ?? v]));
}

function write(file: string, spec: Spec): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, dumpYaml(spec), 'utf8');
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** A role package with only known fields, checked; throws RoleError. */
export function clean(spec: unknown): Spec {
  if (!isMapping(spec)) throw new RoleError('a role must be a mapping of its settings');
  const out: Spec = {};
  const harness = spec.harness;
  if (!(HARNESSES as readonly unknown[]).includes(harness)) throw new RoleError(`a role needs a program: one of ${HARNESSES.join(', ')}`);
  out.harness = harness;
  for (const key of ['title', 'icon', 'description', 'model', 'effort', 'duties', 'instructions']) {
    const value = spec[key];
    if (value === null || value === undefined || value === '') continue;
    if (!['string', 'number'].includes(typeof value)) throw new RoleError(`'${key}' must be text`);
    out[key] = String(value).trim().slice(0, key === 'duties' || key === 'instructions' ? MAX_TEXT : 200);
  }
  for (const key of ['tags', 'write_scope']) {
    let value = spec[key] || [];
    if (typeof value === 'string') value = value.split(/[,\n]/);
    if (!Array.isArray(value)) throw new RoleError(`'${key}' must be a list`);
    const items = value.map((v) => String(v).trim()).filter((v) => v);
    if (items.length) out[key] = items.slice(0, 30);
  }
  if (!out.title) throw new RoleError('give the role a name');
  return out;
}

function saved(): Record<string, Spec> {
  const found: Record<string, Spec> = {};
  let files: string[] = [];
  try {
    files = readdirSync(rolesDir()).filter((f) => f.endsWith('.yaml')).sort();
  } catch {
    return found;
  }
  for (const f of files) {
    const spec = readSpec(path.join(rolesDir(), f));
    if (spec) found[MINE + f.slice(0, -5)] = { title: f.slice(0, -5), ...spec };
  }
  return found;
}

/** Everything about a role in the market (settings and description). */
export function packageOf(preset: string): Spec {
  const spec = preset.startsWith(MINE) ? saved()[preset] : builtIn()[preset];
  if (spec === undefined) throw new KeyError(preset);
  return { ...spec };
}

/** The team-role settings of `preset` (no superior: that belongs to the team). */
export function get(preset: string): Spec {
  return Object.fromEntries(Object.entries(packageOf(preset))
    .filter(([k, v]) => FIELDS.has(k) && v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [k, k === 'write_scope' ? [...(v as unknown[])] : v]));
}

export function catalogue(): Spec[] {
  const card = (key: string, mine: boolean): Spec => {
    const spec = packageOf(key);
    return {
      id: key, mine, edited: !mine && edited(key) !== null, title: spec.title ?? key, icon: spec.icon ?? '',
      description: spec.description ?? '', tags: [...((spec.tags as string[] | undefined) ?? [])], ...get(key),
    };
  };
  return [...Object.keys(saved()).map((k) => card(k, true)), ...Object.keys(builtIn()).map((k) => card(k, false))];
}

export function names(): string[] {
  return [...Object.keys(saved()), ...Object.keys(builtIn())];
}

/** Keep a role in your market: a new one (named `name`), or - with `preset` - change an existing one (yours,
 * or a ready-made one: its edited copy is kept beside the original). */
export function save(name: string, role: Spec, preset: string | null = null): string {
  const spec = clean({ ...role, title: role.title || name });
  if (preset && !preset.startsWith(MINE)) {
    if (!(preset in builtIn())) throw new RoleError('there is no such role');
    write(path.join(editedDir(), `${preset}.yaml`), spec);
    return preset;
  }
  let stem: string;
  if (preset) {
    stem = preset.slice(MINE.length);
  } else {
    stem = slug(String(spec.title)) || 'role';
    const base = stem;
    for (let n = 2; existsSync(path.join(rolesDir(), `${stem}.yaml`)); n += 1) stem = `${base}-${n}`;
  }
  write(path.join(rolesDir(), `${stem}.yaml`), spec);
  return MINE + stem;
}

export function duplicate(preset: string): string {
  const spec = packageOf(preset);
  const title = `${spec.title ?? preset} (copy)`;
  return save(title, { ...spec, title });
}

/** Remove a role from the market. Teams that use it keep their own copy of its settings. */
export function remove(preset: string): void {
  if (preset.startsWith(MINE)) {
    const file = path.join(rolesDir(), `${preset.slice(MINE.length)}.yaml`);
    if (existsSync(file)) unlinkSync(file);
    return;
  }
  if (!(preset in builtIn())) throw new KeyError(preset);
  setHidden([...hidden(), preset]);
}

/** Undo the owner's edits to a ready-made role. */
export function reset(preset: string): void {
  if (!(preset in builtIn())) throw new KeyError(preset);
  const file = path.join(editedDir(), `${preset}.yaml`);
  if (existsSync(file)) unlinkSync(file);
}

/** Bring back every deleted ready-made role (with its edits, if it had any); returns their ids. */
export function restore(): string[] {
  const back = hidden();
  if (back.length) setHidden([]);
  return back;
}

/** [file name, file text] to download: an agent-org role package. */
export function exportText(preset: string): [string, string] {
  const spec = packageOf(preset);
  return [`${slug(String(spec.title ?? preset)) || 'role'}.role.yaml`, dumpYaml({ 'agent-org-role': 1, ...spec })];
}

/** Add a role package (from exportText, or written by hand) to your market. */
export function importText(text: string): string {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (e) {
    throw new RoleError(`that file is not a role package: ${(e as Error).message}`);
  }
  if (!isMapping(data)) throw new RoleError('that file is not a role package');
  delete data['agent-org-role'];
  const spec = clean(data);
  return save(String(spec.title), spec);
}

/** A team.yaml role made from a market role, reporting to `superior`. */
export function teamRole(preset: string, superior: string): Spec {
  return { superior, ...get(preset) };
}

/** A free team-role name for a market role. */
export function roleName(preset: string, taken: Set<string>): string {
  let base = slug(String(packageOf(preset).title ?? preset).split('/')[0]) || 'role';
  if (!NAME_RE.test(base)) base = 'role';
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return name;
}
