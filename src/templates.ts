/** Ready-made teams for the window's "Create a team" page. */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dumpYaml, isMapping, parseYaml } from './team.ts';

type Spec = Record<string, unknown>;

export const CONSULTANTS: Spec = {
  'opus-medium': { harness: 'claude', model: 'claude-opus-5-5', effort: 'medium', max_active: 2,
    use_for: 'everyday problems - unclear errors, API questions, small bugs' },
  'luna-high': { harness: 'codex', model: 'gpt-6-luna', effort: 'high', max_active: 2,
    use_for: 'tricky code - failing tests, subtle bugs, algorithms' },
  'opus-xhigh': { harness: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', max_active: 1,
    use_for: 'the hardest problems - design flaws, deep debugging across many files' },
};

const LEADER_DUTIES = 'Understand what the owner wants, plan it in PLAN.md, split the work into tasks for '
  + 'your team, review what comes back, and report the result to the owner.';

export const TEMPLATES: Record<string, { title: string; summary: string; roles: Record<string, Spec>; consultants?: Spec }> = {
  solo: {
    title: 'Solo',
    summary: 'One Claude agent that does everything itself. The simplest way to start.',
    roles: {
      leader: { superior: 'you', harness: 'claude', model: 'opus', effort: 'high',
        duties: 'Do what the owner asks, then report the result to the owner.', write_scope: ['*'] },
    },
  },
  pair: {
    title: 'Leader and worker',
    summary: 'A Claude leader plans and reviews; a Codex worker writes the code. Consultants can be called in for hard problems.',
    roles: {
      leader: { superior: 'you', harness: 'claude', model: 'opus', effort: 'high', duties: LEADER_DUTIES, write_scope: ['PLAN.md'] },
      worker: { superior: 'leader', harness: 'codex', model: 'gpt-6-luna', effort: 'medium',
        duties: 'Carry out the tasks you are given, check that they work, and report back.', write_scope: ['*'] },
    },
    consultants: CONSULTANTS,
  },
  team: {
    title: 'Full team',
    summary: 'A leader, a tech lead with two workers, and a Grok researcher. Uses all your subscriptions.',
    roles: {
      leader: { superior: 'you', harness: 'claude', model: 'opus', effort: 'high', duties: LEADER_DUTIES,
        write_scope: ['PLAN.md', 'docs/*'] },
      'tech-lead': { superior: 'leader', harness: 'codex', model: 'gpt-6-luna', effort: 'high',
        duties: 'Design the code, split it into tasks for your workers, and review their work before reporting up.',
        write_scope: ['*'] },
      'worker-a': { superior: 'tech-lead', harness: 'codex', model: 'gpt-6-luna', effort: 'low',
        duties: 'Write the code you are given as tasks. Keep changes small.', write_scope: ['*'] },
      'worker-b': { superior: 'tech-lead', harness: 'claude', model: 'sonnet', effort: 'medium',
        duties: 'Write and run tests, and keep the docs in step with the code.', write_scope: ['*'] },
      researcher: { superior: 'leader', harness: 'grok', model: 'grok-4.7',
        duties: "Research libraries, APIs and news on the web, and report what you find. You don't edit project files.",
        write_scope: [] },
    },
    consultants: CONSULTANTS,
  },
};

const MINE = 'my:'; // ids of the teams the owner saved
const KEEP_OUT = new Set(['owner', 'project_root', 'database']); // these belong to one project, not a saved team

/** agent-org's own folder in the owner's home (AGENT_ORG_HOME moves it: tests never touch the real one). */
export function homeDir(): string {
  return process.env.AGENT_ORG_HOME || path.join(os.homedir(), '.agent-org');
}

function teamsDir(): string {
  return path.join(homeDir(), 'teams');
}

function prefsFile(): string {
  return path.join(homeDir(), 'prefs.json');
}

function prefs(): Spec {
  try {
    const data = JSON.parse(readFileSync(prefsFile(), 'utf8'));
    return isMapping(data) ? data : {};
  } catch {
    return {};
  }
}

/** The team preselected for a new project: the owner's choice, else 'Leader and worker'. */
export function defaultTemplate(): string {
  const chosen = prefs().default_team;
  return typeof chosen === 'string' && ids().includes(chosen) ? chosen : 'pair';
}

export function setDefault(template: string): void {
  if (!ids().includes(template)) throw new KeyError(template);
  const p = prefs();
  p.default_team = template;
  mkdirSync(path.dirname(prefsFile()), { recursive: true });
  writeFileSync(prefsFile(), JSON.stringify(p, null, 2), 'utf8');
}

function saved(): Record<string, Spec> {
  const found: Record<string, Spec> = {};
  let files: string[] = [];
  try {
    files = readdirSync(teamsDir()).filter((f) => f.endsWith('.yaml')).sort();
  } catch {
    return found;
  }
  for (const f of files) {
    try {
      const config = parseYaml(readFileSync(path.join(teamsDir(), f), 'utf8'));
      if (isMapping(config) && isMapping(config.roles)) found[MINE + f.slice(0, -5)] = config;
    } catch {
      // unreadable: left out
    }
  }
  return found;
}

export function ids(): string[] {
  return [...Object.keys(TEMPLATES), ...Object.keys(saved())];
}

/** A missing key: the Python version's KeyError, which callers turn into a plain refusal. */
export class KeyError extends Error {
  override name = 'KeyError';
}

/** Keep a team (its roles, consultants, checks and settings) to start new projects from. */
export function save(name: string, config: Spec, makeDefault = false): string {
  const stem = name.replace(/[^A-Za-z0-9_ -]/g, '').trim();
  if (!stem) throw new Error('give the team a name (letters, digits, spaces, - and _)');
  const body = Object.fromEntries(Object.entries(config).filter(([k]) => !KEEP_OUT.has(k)));
  mkdirSync(teamsDir(), { recursive: true });
  writeFileSync(path.join(teamsDir(), `${stem}.yaml`), dumpYaml(body), 'utf8');
  const template = MINE + stem;
  if (makeDefault) setDefault(template);
  return template;
}

export function remove(template: string): void {
  if (!template.startsWith(MINE)) throw new KeyError(template);
  const file = path.join(teamsDir(), `${template.slice(MINE.length)}.yaml`);
  if (existsSync(file)) unlinkSync(file);
}

/** A team.yaml body for `template` (built in, or one the owner saved), with the project in the same folder. */
export function teamConfig(template: string): Spec {
  if (template.startsWith(MINE)) {
    const s = saved()[template];
    if (s === undefined) throw new KeyError(template);
    return { owner: 'you', project_root: '.', ...s };
  }
  const spec = TEMPLATES[template];
  if (spec === undefined) throw new KeyError(template);
  const config: Spec = { owner: 'you', project_root: '.', roles: structuredClone(spec.roles) };
  if (spec.consultants) config.consultants = structuredClone(spec.consultants);
  return config;
}

export function catalogue(): Spec[] {
  const chosen = defaultTemplate();
  const mine = Object.entries(saved()).map(([key, config]) => ({
    id: key, title: key.slice(MINE.length), summary: 'Your saved team.', roles: Object.keys(config.roles as Spec).join(', '),
    programs: programs(config), mine: true, default: key === chosen,
  }));
  const builtIn = Object.entries(TEMPLATES).map(([key, t]) => ({
    id: key, title: t.title, summary: t.summary, roles: Object.keys(t.roles).join(', '),
    programs: programs(t as unknown as Spec), mine: false, default: key === chosen,
  }));
  return [...mine, ...builtIn];
}

/** The programs a team's roles run on, in order of first use (its consultants come only when called). */
function programs(config: Spec): string[] {
  const roles = isMapping(config.roles) ? config.roles : {};
  const found = Object.values(roles).filter((r) => isMapping(r) && r.harness).map((r) => String((r as Spec).harness));
  return [...new Set(found)];
}
