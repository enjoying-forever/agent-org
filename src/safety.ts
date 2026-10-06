/**
 * Guards that keep a team inside its limits, whatever an agent types.
 *
 * - Protected files: the team's own configuration (team.yaml, the hub's folder, agent-org's plugin and
 *   project configs) is never edited by an agent - that would let it rewrite its own permissions or the law.
 * - Commands: shell commands that publish (git push), wipe other agents' unsaved work in a shared folder,
 *   or delete things outside the project are refused before they run.
 * - Secrets: work that adds a private key or an API token is not put into git history.
 * - Scope: in branch mode an agent's work only reaches main if every file it changed is in its write
 *   scope (this also catches files written through the shell).
 */

import path from 'node:path';
import { fnmatchcase } from './fnmatch.ts';

// relative to the project folder; directories end with "/"
export const PROTECTED = ['team.yaml', 'team.yaml.bak', '.agent-org/', '.agents/plugins/agent-org/', '.grok/config.toml', '.git/'];

const stripDot = (s: string): string => (s.startsWith('./') ? s.slice(2) : s);

/** True for a file an agent must never edit. */
export function isProtected(rel: string, teamFileName = 'team.yaml'): boolean {
  const low = stripDot(rel.replace(/\\/g, '/')).toLowerCase();
  const names = new Set([...PROTECTED.map((p) => p.toLowerCase()), teamFileName.toLowerCase(), `${teamFileName.toLowerCase()}.bak`]);
  for (const p of names) {
    if (p.endsWith('/')) {
      if (low === p.slice(0, -1) || low.startsWith(p)) return true;
    } else if (low === p) {
      return true;
    }
  }
  return false;
}

// commands

export const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell', 'exec_command', 'local_shell', 'run_command',
  'run_terminal_cmd', 'terminal', 'run_shell_command', 'execute_command']);
const COMMAND_KEYS = ['command', 'cmd', 'CommandLine', 'commandLine', 'script'];

const ALWAYS: [RegExp, string][] = [
  [/\bgit\s+(?:(?:-C|-c)\s+\S+\s+|--?[\w-]+(?:=\S+)?\s+)*push\b/i,
    "Publishing (git push) is the owner's decision. Tell your superior the work is ready instead."],
  [/\b(format|diskpart|mkfs(\.\w+)?|shutdown|reboot|halt)\b(\s+[a-z]:|\s+\/|\s+-|\s*$)/i,
    'That command can take down the machine or wipe a disk.'],
  [/\bdd\b[^\n]*\bof=\/dev\//i, 'That command writes straight to a disk.'],
  [/\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(-[a-z]*\s+)*(\/|~|\$HOME|\/\*|[a-z]:[\\/]?)(\s|$)/i,
    'That deletes a whole drive or home folder.'],
  [/\b(rd|rmdir)\s+(\/s\s+\/q|\/q\s+\/s)\s+"?[a-z]:[\\/]?"?(\s|$)/i, 'That deletes a whole drive.'],
  [/\bremove-item\b[^\n]*-recurse[^\n]*\s"?([a-z]:[\\/]?|~|\$home|\$env:userprofile)"?(\s|$)/i,
    'That deletes a whole drive or home folder.'],
];
const SHARED_FOLDER: [RegExp, string][] = [
  [/\bgit\s+(reset\s+[^\n]*--hard|clean\s+-[a-z]*[fdx]|checkout\s+(--\s+)?\.(\s|$)|restore\s+[^\n]*\.(\s|$)|stash(\s+(push|save|-[a-z]+)\b[^\n]*)?\s*($|[;&|]))/i,
    "In the shared project folder that would throw away other agents' unsaved work. Undo only your own "
    + 'changes, file by file.'],
];
const RECURSIVE_DELETE = /\b(rm\s+(-[a-z]*\s+)*-[a-z]*r|remove-item\b[^\n]*-recurse|rd\s+\/s|rmdir\s+\/s|del\s+\/s|shutil\.rmtree)/i;
const ABSOLUTE = /(?<![\w/\\])([a-zA-Z]:[\\/][^\s"'|;&<>]*|\/[a-z]\/[^\s"'|;&<>]*)/g;

export function commandOf(toolInput: unknown): string {
  if (typeof toolInput === 'string') return toolInput;
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) return '';
  const input = toolInput as Record<string, unknown>;
  for (const key of COMMAND_KEYS) {
    const value = input[key];
    if (Array.isArray(value)) return value.map(String).join(' ');
    if (typeof value === 'string') return value;
  }
  return '';
}

function asPath(text: string): string | null {
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(text); // Git Bash: /e/code -> E:/code
  if (m) text = `${m[1]}:/${m[2]}`;
  try {
    return path.win32.resolve(text);
  } catch {
    return null;
  }
}

/** Whether `child` is `root` or inside it (Windows paths: case does not matter). */
export function within(child: string, root: string): boolean {
  const rel = path.win32.relative(root.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel));
}

/** Why `command` must not run, or null. */
export function checkCommand(command: string, allowedRoots: string[], sharedFolder: boolean): string | null {
  for (const [rule, why] of [...ALWAYS, ...(sharedFolder ? SHARED_FOLDER : [])]) {
    if (rule.test(command)) return why;
  }
  if (RECURSIVE_DELETE.test(command)) {
    const roots = allowedRoots.map((r) => path.win32.resolve(r));
    for (const m of command.matchAll(ABSOLUTE)) {
      const raw = m[1];
      const p = asPath(raw);
      if (p !== null && !roots.some((r) => within(p, r))) return `That deletes ${raw}, which is outside the project.`;
    }
  }
  return null;
}

// secrets

const SECRET_PATTERNS: [string, RegExp][] = [
  ['private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['API key (sk-...)', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['password or token in the code',
    /\b(?:api[_-]?key|secret|passw(?:or)?d|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];

/** Secrets that lines added in `diff` would put into history: 'file:line (kind)', never the value. */
export function findSecrets(diff: string): string[] {
  const found: string[] = [];
  let file = '?';
  let line = 0;
  for (const text of diff.split(/\r?\n/)) {
    if (text.startsWith('+++ ')) {
      file = text.startsWith('+++ b/') ? text.slice(6) : text.slice(4);
      continue;
    }
    if (text.startsWith('@@')) {
      const m = /\+(\d+)/.exec(text);
      line = m ? Number(m[1]) - 1 : 0;
      continue;
    }
    if (text.startsWith('+')) {
      line += 1;
      for (const [kind, rule] of SECRET_PATTERNS) {
        if (rule.test(text)) {
          found.push(`${file}:${line} (${kind})`);
          break;
        }
      }
    } else if (!text.startsWith('-')) {
      line += 1;
    }
  }
  return found;
}

// scope

/** Files not covered by `scope` ('*' matches across folders). */
export function outsideScope(files: string[], scope: readonly string[]): string[] {
  return files.filter((f) => !scope.some((p) => fnmatchcase(f.toLowerCase(), stripDot(p.toLowerCase()))));
}

/** Patterns in `granted` that reach beyond `own` (a manager cannot give more than it has). */
export function scopeWithin(granted: readonly string[], own: readonly string[]): string[] {
  return granted.filter((p) => !own.some((o) => fnmatchcase(stripDot(p.toLowerCase()), stripDot(o.toLowerCase()))));
}
