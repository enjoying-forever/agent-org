/**
 * Git history for a team's project: what each task changed, and one commit per accepted task.
 *
 * agent-org only uses git when the project folder is the top of its own repository, so it never commits
 * into a larger repository the project happens to sit inside.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { withFileLock } from './filelock.ts';
import { fnmatchcase } from './fnmatch.ts';

const MAX_DIFF = 200_000; // characters of diff shown for one task
const IGNORE = ['.agent-org/', '.agents/plugins/agent-org/']; // the hub's own files never go into history
const NAME = {
  GIT_AUTHOR_NAME: 'agent-org', GIT_AUTHOR_EMAIL: 'agent-org@localhost',
  GIT_COMMITTER_NAME: 'agent-org', GIT_COMMITTER_EMAIL: 'agent-org@localhost',
};

/** git failed to run, or a command that had to succeed did not. */
export class GitError extends Error {
  override name = 'GitError';
}

export interface GitResult {
  returncode: number;
  stdout: string;
  stderr: string;
}

export function git(root: string, args: string[], opts: { check?: boolean; env?: Record<string, string>; timeout?: number } = {}): GitResult {
  const r = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: (opts.timeout ?? 60) * 1000, env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    throw new GitError(code === 'ENOENT' ? 'git is not installed' : `git ${args[0]}: ${r.error.message}`);
  }
  const result = { returncode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  if (opts.check && result.returncode !== 0) {
    throw new GitError(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
  }
  return result;
}

const lines = (text: string): string[] => text.split(/\r?\n/).filter((l) => l);
const samePath = (a: string, b: string): boolean =>
  (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/** True if `root` is the top folder of a git repository. */
export function isOwnRepo(root: string): boolean {
  let r: GitResult;
  try {
    r = git(root, ['rev-parse', '--show-toplevel']);
  } catch {
    return false;
  }
  return r.returncode === 0 && samePath(r.stdout.trim(), root);
}

export function hasCommits(root: string): boolean {
  return git(root, ['rev-parse', '--verify', 'HEAD']).returncode === 0;
}

/** Use the person's own git name if they set one; otherwise sign as agent-org. */
function identity(root: string): Record<string, string> {
  return git(root, ['config', 'user.email']).stdout.trim() ? {} : NAME;
}

/** Turn on history: a repository in the project folder with everything so far as its first commit. */
export function init(root: string): string {
  if (isOwnRepo(root)) return 'already on';
  git(root, ['init'], { check: true });
  const ignore = path.join(root, '.gitignore');
  const have = existsSync(ignore) ? readFileSync(ignore, 'utf8').split(/\r?\n/) : [];
  while (have.length && have[have.length - 1] === '') have.pop();
  const missing = IGNORE.filter((p) => !have.includes(p));
  if (missing.length) writeFileSync(ignore, `${[...have, ...missing].join('\n')}\n`, 'utf8');
  git(root, ['add', '-A'], { check: true });
  git(root, ['commit', '-m', 'agent-org: starting point', '--allow-empty'], { check: true, env: identity(root) });
  return 'on';
}

function cut(text: string): string {
  return text.length <= MAX_DIFF ? text : `${text.slice(0, MAX_DIFF)}\n... (diff cut short)\n`;
}

/** What changed in `paths` since the last commit, as a unified diff (new files shown whole). */
export function diff(root: string, paths: string[]): string {
  if (!paths.length || !isOwnRepo(root)) return '';
  const parts: string[] = [];
  const tracked = new Set(lines(git(root, ['ls-files', '--', ...paths]).stdout));
  if (hasCommits(root)) parts.push(git(root, ['diff', 'HEAD', '--', ...paths]).stdout);
  for (const p of paths) {
    if (tracked.has(p)) continue;
    const file = path.join(root, p);
    try {
      if (!statSync(file).isFile()) continue;
      const body = readFileSync(file, 'utf8').split(/\r?\n/);
      if (body.length && body[body.length - 1] === '') body.pop();
      parts.push(`diff --git a/${p} b/${p}\nnew file\n--- /dev/null\n+++ b/${p}\n${body.map((l) => `+${l}`).join('\n')}\n`);
    } catch {
      // gone or unreadable
    }
  }
  return cut(parts.join(''));
}

/** Commit exactly `paths` (added, changed or deleted). Returns the short hash, or null if nothing changed. */
export function commit(root: string, paths: string[], message: string): string | null {
  if (!paths.length || !isOwnRepo(root)) return null;
  const existing = paths.filter((p) => existsSync(path.join(root, p)));
  const gone = paths.filter((p) => !existsSync(path.join(root, p)));
  if (existing.length) git(root, ['add', '--', ...existing], { check: true });
  if (gone.length) git(root, ['rm', '--cached', '--ignore-unmatch', '-q', '--', ...gone]);
  if (!git(root, ['diff', '--cached', '--name-only', '--', ...paths]).stdout.trim()) return null;
  git(root, ['commit', '-m', message, '--', ...paths], { check: true, env: identity(root) });
  return git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim();
}

// branches: every agent works in its own worktree, and finished work merges into main at once

export const BRANCH_PREFIX = 'agent/';
const LAND_LOCK = 'land.lock'; // in .agent-org: one landing into main at a time
const MARKER = /^(<{7}|>{7})( |$)/m;

/** The branch the project folder has checked out: the team's main line. */
export function mainBranch(root: string): string {
  const name = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  if (!name || name === 'HEAD') throw new GitError(`${root} is not on a branch; check one out (for example: git switch main)`);
  return name;
}

export function head(root: string, ref = 'HEAD'): string {
  return git(root, ['rev-parse', '--verify', '--quiet', ref]).stdout.trim();
}

export function worktreePath(root: string, role: string): string {
  return path.join(root, '.agent-org', 'worktrees', role);
}

/** The role's own copy of the project, on branch agent/<role> (made from main the first time). */
export function ensureWorktree(root: string, role: string): string {
  const wt = worktreePath(root, role);
  if (existsSync(path.join(wt, '.git'))) {
    excludeJunk(root);
    return wt;
  }
  const branch = BRANCH_PREFIX + role;
  git(root, ['worktree', 'prune']);
  if (head(root, `refs/heads/${branch}`)) git(root, ['worktree', 'add', wt, branch], { check: true });
  else git(root, ['worktree', 'add', '-b', branch, wt, mainBranch(root)], { check: true });
  git(root, ['config', 'merge.conflictStyle', 'zdiff3']); // conflicts show the common base too
  excludeJunk(root);
  return wt;
}

const JUNK = ['__pycache__/', '*.pyc', '*.pyo', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', 'node_modules/',
  '.venv/', 'venv/', 'dist/', 'build/', '*.egg-info/', '.DS_Store', 'Thumbs.db', '.agent-org/'];

/** Keep build output out of the agents' commits (running code makes __pycache__ in every copy, and two copies
 * of a compiled file always conflict). It goes in .git/info/exclude, never in .gitignore. */
export function excludeJunk(root: string): void {
  const common = git(root, ['rev-parse', '--git-common-dir']).stdout.trim();
  if (!common) return;
  const file = path.join(path.isAbsolute(common) ? common : path.join(root, common), 'info', 'exclude');
  mkdirSync(path.dirname(file), { recursive: true });
  const have = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  while (have.length && have[have.length - 1] === '') have.pop();
  const missing = JUNK.filter((p) => !have.includes(p));
  if (missing.length) {
    writeFileSync(file, `${[...have, "# agent-org: build output never goes into the agents' commits", ...missing].join('\n')}\n`, 'utf8');
  }
}

export function merging(wt: string): boolean {
  return Boolean(head(wt, 'MERGE_HEAD'));
}

export function conflicted(wt: string): string[] {
  return lines(git(wt, ['diff', '--name-only', '--diff-filter=U']).stdout);
}

/** Which of `files` still hold conflict markers. */
export function withMarkers(wt: string, files: string[]): string[] {
  return files.filter((f) => {
    try {
      return MARKER.test(readFileSync(path.join(wt, f), 'utf8'));
    } catch {
      return false;
    }
  });
}

/** Build output (see JUNK), which never belongs in an agent's commit. */
export function isJunk(file: string): boolean {
  const parts = file.replace(/\\/g, '/').split('/');
  for (const pattern of JUNK) {
    if (pattern.endsWith('/')) {
      const dir = pattern.slice(0, -1);
      if (parts.slice(0, -1).includes(dir) || fnmatchcase(parts[0], dir)) return true;
    } else if (fnmatchcase(parts[parts.length - 1], pattern)) {
      return true;
    }
  }
  return false;
}

/** Commit everything in the worktree (also concludes a merge whose conflicts were resolved). */
export function commitAll(wt: string, message: string): string | null {
  git(wt, ['add', '-A'], { check: true });
  const junk = lines(git(wt, ['diff', '--cached', '--name-only']).stdout).filter(isJunk);
  if (junk.length) git(wt, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...junk]); // tracked before the exclude list
  if (!merging(wt) && !git(wt, ['diff', '--cached', '--name-only']).stdout.trim()) return null;
  git(wt, ['commit', '--no-edit', '-m', message], { check: true, env: identity(wt) });
  return head(wt).slice(0, 9);
}

/** Merge the latest main into the worktree: [files it changed, files in conflict]. With abortOnConflict the
 * worktree is left as it was; otherwise the conflicted files keep git's markers for the agent to resolve. */
export function sync(wt: string, main: string, abortOnConflict: boolean): [string[], string[]] {
  const before = head(wt);
  let r = git(wt, ['merge', '--no-edit', main], { env: identity(wt) });
  if (r.returncode !== 0 && conflicted(wt).length && conflicted(wt).every(isJunk)) {
    git(wt, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...conflicted(wt)]); // build output: drop it
    r = git(wt, ['commit', '--no-edit'], { env: identity(wt) });
  }
  if (r.returncode !== 0) {
    const files = conflicted(wt);
    const why = files.length ? files : [(r.stderr || r.stdout).trim().slice(0, 300)];
    if (abortOnConflict) git(wt, ['merge', '--abort']);
    return [[], why];
  }
  const changed = before ? lines(git(wt, ['diff', '--name-only', before, 'HEAD']).stdout) : [];
  return [changed, []];
}

/** Merge `branch` into main in the project folder: [short commit id, ''] or [null, why not]. */
export function land(root: string, branch: string, message: string): [string | null, string] {
  const r = git(root, ['merge', '--no-ff', '--no-edit', '-m', message, branch], { env: identity(root) });
  if (r.returncode !== 0) {
    const why = conflicted(root);
    git(root, ['merge', '--abort']);
    const text = (r.stderr || r.stdout).trim();
    return [null, why.length ? `it conflicts with main in ${why.join(', ')}` : text.slice(0, 400)];
  }
  return [head(root).slice(0, 9), ''];
}

/** Everything the worktree's agent changed since it last took main in (including unsaved work). */
export function branchDiff(wt: string, main: string): string {
  const base = git(wt, ['merge-base', main, 'HEAD']).stdout.trim();
  if (!base) return '';
  git(wt, ['add', '-A', '-N']); // new files show up in the diff too
  return cut(git(wt, ['diff', base]).stdout);
}

/** What a landed task brought into main. */
export function commitDiff(root: string, commitId: string): string {
  return cut(git(root, ['diff', `${commitId}^1`, commitId]).stdout);
}

/** One landing into main at a time, across every agent's process. */
export function withLandLock<T>(root: string, body: () => T, timeout = 120): T {
  return withFileLock(path.join(root, '.agent-org', LAND_LOCK), body, timeout, 'another agent is putting its work into main');
}
