/** What the branch-mode tests share: a hub in branch mode over the example team, with one shared file. */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { Hub } from '../src/hub.ts';
import { Store } from '../src/store.ts';
import { Team } from '../src/team.ts';
import { cleanup, team as example, tmpDir } from './helpers.ts';

export const SHARED = 'tests/test_shared.py';
export const BASE = "def first():\n    return 1\n\n\ndef middle():\n    return 'untouched'\n\n\ndef last():\n    return 3\n";

export function makeHub(t: TestContext, extra: Record<string, unknown> = {}): Hub {
  const dir = tmpDir(t);
  const root = path.join(dir, 'project');
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  writeFileSync(path.join(root, SHARED), BASE);
  const team = Team.fromDict({ ...example(), isolation: 'branches', ...extra }, dir);
  const hub = new Hub(team, new Store(team.database));
  cleanup(t, () => hub.close());
  return hub;
}

export const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

export function start(hub: Hub, role: string, title = 'Change the shared file') {
  const task = hub.session('tech-lead').assignTask(role, title);
  const wt = hub.prepareRoot(role);
  hub.session(role).readInbox();
  return { task, wt };
}

export function edit(wt: string, old: string, fresh: string): void {
  const file = path.join(wt, SHARED);
  writeFileSync(file, readFileSync(file, 'utf8').replace(old, fresh));
}

export const mainText = (hub: Hub): string => readFileSync(path.join(hub.baseTeam.project_root, SHARED), 'utf8');
// (git may write a copy with Windows line endings: core.autocrlf)
export const readIn = (wt: string): string => readFileSync(path.join(wt, SHARED), 'utf8').replace(/\r\n/g, '\n');
