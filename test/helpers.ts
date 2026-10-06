/** What the tests share: the example team, a fresh hub per test, a fake terminal opener. */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { Hub } from '../src/hub.ts';
import { Store } from '../src/store.ts';
import { type Role, Team } from '../src/team.ts';

// Never touch the real ~/.agent-org from tests (saved teams, roles, recent list).
process.env.AGENT_ORG_HOME = mkdtempSync(path.join(os.tmpdir(), 'agent-org-home-'));

// you
// └── leader
//     ├── tech-lead
//     │   ├── worker-a
//     │   └── worker-b
//     └── researcher
export const TEAM = {
  owner: 'you',
  project_root: 'project',
  roles: {
    leader: { superior: 'you', harness: 'claude', write_scope: ['PLAN.md', 'docs/*'] },
    'tech-lead': { superior: 'leader', harness: 'codex', write_scope: ['src/*'] },
    'worker-a': { superior: 'tech-lead', harness: 'codex', write_scope: ['src/*', 'tests/*'] },
    'worker-b': { superior: 'tech-lead', harness: 'antigravity', write_scope: ['tests/*', 'docs/*'] },
    researcher: { superior: 'leader', harness: 'grok', write_scope: [] as string[] },
  },
  consultants: {
    medium: { harness: 'claude', model: 'claude-opus-5-5', effort: 'medium', max_active: 2,
      use_for: 'questions a strong model answers quickly' },
    high: { harness: 'codex', model: 'gpt-6-luna', effort: 'high', use_for: 'tricky bugs and failing tests' },
  },
};

export const team = (): typeof TEAM => structuredClone(TEAM);

const stacks = new WeakMap<TestContext, (() => unknown)[]>();

/** Run `fn` when the test ends - last registered first (a database closes before its folder goes). */
export function cleanup(t: TestContext, fn: () => unknown): void {
  let stack = stacks.get(t);
  if (stack === undefined) {
    const fresh: (() => unknown)[] = [];
    stacks.set(t, fresh);
    t.after(async () => {
      for (const step of fresh.reverse()) await step();
    });
    stack = fresh;
  }
  stack.push(fn);
}

/** A temporary folder, removed when the test ends. */
export function tmpDir(t: TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-org-test-'));
  cleanup(t, () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** Records the roles the hub asks to open, instead of opening terminals. */
export class FakeOpener {
  opened: string[] = [];
  fail = false;
  readonly call = (role: Role): void => {
    if (this.fail) throw new Error('no terminal');
    this.opened.push(role.name);
  };
}

/** The example team in a fresh temporary folder, with its project folder made. */
export function makeTeam(t: TestContext, config: object = team()): { team: Team; dir: string } {
  const dir = tmpDir(t);
  mkdirSync(path.join(dir, 'project'), { recursive: true });
  return { team: Team.fromDict(config, dir), dir };
}

/** A hub over the example team (closed when the test ends). */
export function makeHub(t: TestContext, config: object = team()): { hub: Hub; opener: FakeOpener; dir: string } {
  const { team: tm, dir } = makeTeam(t, config);
  const opener = new FakeOpener();
  const hub = new Hub(tm, new Store(tm.database), opener.call);
  cleanup(t, () => hub.close());
  return { hub, opener, dir };
}

/** Assert that `fn` throws a `kind` whose message matches `pattern` (pytest.raises(kind, match=...)). */
export function raises(fn: () => unknown, kind: new (...args: never[]) => Error, pattern?: RegExp | string): Error {
  let caught: unknown = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  if (caught === null) throw new Error(`expected ${kind.name} to be thrown`);
  if (!(caught instanceof kind)) throw caught;
  if (pattern !== undefined) {
    const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    if (!re.test(caught.message)) throw new Error(`${kind.name} message ${JSON.stringify(caught.message)} does not match ${re}`);
  }
  return caught;
}

/** The async form of raises. */
export async function rejects(fn: () => Promise<unknown>, kind: new (...args: never[]) => Error, pattern?: RegExp | string): Promise<Error> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  if (caught === null) throw new Error(`expected ${kind.name} to be thrown`);
  if (!(caught instanceof kind)) throw caught;
  if (pattern !== undefined) {
    const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    if (!re.test(caught.message)) throw new Error(`${kind.name} message ${JSON.stringify(caught.message)} does not match ${re}`);
  }
  return caught;
}
