/** Checks that the programs agent-org drives are installed and working, with plain fixes. */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { deepseek, grokHooksState } from './launch.ts';
import { IN_ELECTRON, which } from './runtime.ts';
import * as terminals from './terminals.ts';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix: string;
  needed: boolean; // false: only matters if your team uses it
}

const check = (name: string, ok: boolean, detail: string, fix = '', needed = true): Check => ({ name, ok, detail, fix, needed });

/** Run a program to its end: [exit code, its output]. A .cmd shim (an npm-installed program) runs through cmd. */
export function run(command: string, args: string[], timeout = 40, env: NodeJS.ProcessEnv = process.env): Promise<[number, string]> {
  return new Promise((resolve) => {
    const shell = /\.(cmd|bat)$/i.test(command);
    const quote = (a: string): string => (/[\s&|<>^()]/.test(a) ? `"${a}"` : a);
    let out = '';
    let child;
    try {
      const opts = { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
      child = shell ? spawn([command, ...args].map(quote).join(' '), { ...opts, shell: true }) : spawn(command, args, opts);
    } catch (e) {
      resolve([-1, String(e)]);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      out += `\n(no answer within ${timeout} seconds)`;
    }, timeout * 1000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve([-1, String(e)]);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve([code ?? -1, out.trim()]);
    });
  });
}

export const firstLine = (text: string): string => (text ? text.split(/\r?\n/)[0].slice(0, 120) : '');

export async function checkProgram(name: string, command: string, install: string): Promise<Check> {
  const found = which(command);
  if (found === null) return check(name, false, 'not installed', install);
  const [code, out] = await run(found, ['--version']);
  if (code !== 0) return check(name, false, `installed but does not start: ${firstLine(out)}`, '');
  return check(name, true, firstLine(out));
}

export async function checkClaude(harnesses: Set<string>): Promise<Check> {
  const c = await checkProgram('Claude Code', 'claude', 'Install it: npm install -g @anthropic-ai/claude-code');
  c.needed = harnesses.has('claude');
  if (!c.ok && c.detail.startsWith('installed')) {
    const found = which('claude');
    const script = found ? path.join(path.dirname(found), 'node_modules', '@anthropic-ai', 'claude-code', 'install.cjs') : null;
    c.fix = script && existsSync(script) ? `An update did not finish. Repair it with: node "${script}"`
      : 'Reinstall it: npm install -g @anthropic-ai/claude-code';
  }
  return c;
}

export async function checkCodex(harnesses: Set<string>): Promise<Check> {
  const c = await checkProgram('Codex', 'codex', 'Install it: npm install -g @openai/codex');
  c.needed = harnesses.has('codex');
  if (!c.ok && c.detail.startsWith('installed')) c.fix = 'Reinstall it: npm install -g @openai/codex';
  return c;
}

export async function checkGrok(harnesses: Set<string>): Promise<Check[]> {
  const c = await checkProgram('Grok', 'grok', 'Install Grok Build and sign in with: grok login');
  c.needed = harnesses.has('grok');
  const checks = [c];
  if (c.ok) {
    const [, out] = await run(which('grok') ?? 'grok', ['models']);
    if (out.toLowerCase().includes('not authenticated')) checks.push(check('Grok sign-in', false, 'Grok is not signed in', 'Run: grok login', c.needed));
    const state = grokHooksState();
    const detail = { current: 'installed', outdated: 'installed by an older agent-org: they fail in Grok until updated',
      missing: 'not installed: Grok agents only see messages when they check' }[state];
    checks.push(check('Grok message delivery', state === 'current', detail,
      state === 'current' ? '' : "Click 'Install Grok hooks' (they do nothing outside agent-org tabs).", c.needed));
  }
  return checks;
}

let agySignin: [number, Check | null] = [0, null];

/** Antigravity's CLI: installed, and - if the team uses it - signed in and verified. The sign-in test lists the
 * account's models (no model runs, nothing is used up); it runs at most every ten minutes. */
export async function checkAntigravity(harnesses: Set<string>): Promise<Check[]> {
  const c = await checkProgram('Antigravity', 'agy', 'Install the Antigravity CLI (agy) from antigravity.google');
  c.needed = harnesses.has('antigravity');
  const checks = [c];
  if (c.ok && c.needed) {
    if (Date.now() / 1000 - agySignin[0] > 600) {
      const [code, out] = await run(which('agy') ?? 'agy', ['models'], 60);
      const low = out.toLowerCase();
      const listed = code === 0 && out.split(/\r?\n/).some((l) => l.includes('\t'));
      let signin: Check | null;
      if (!listed && (low.includes('verify your account') || low.includes('sign in') || low.includes('login'))) {
        signin = check('Antigravity sign-in', false, 'Antigravity needs you to sign in or verify your Google account',
          'Open a terminal, run agy, and finish the sign-in in your browser.');
      } else {
        signin = listed ? check('Antigravity sign-in', true, 'signed in') : null;
      }
      agySignin = [Date.now() / 1000, signin];
    }
    if (agySignin[1] !== null) checks.push(agySignin[1]);
  }
  return checks;
}

/** DeepSeek Harness: the desktop app's own CLI (or a dsh on PATH) starts. */
export async function checkDeepseek(harnesses: Set<string>): Promise<Check> {
  const found = deepseek.command();
  const needed = harnesses.has('deepseek');
  if (found === null) {
    return check('DeepSeek Harness', false, 'not installed', 'Install DeepSeek Harness and sign in once (in its desktop app); '
      + 'for the command line: npm install -g @deepseek-ai/dsh', needed);
  }
  const [command, base, env] = found;
  const [code, out] = await run(command, [...base, '--version'], 40, { ...process.env, ...env });
  if (code !== 0) return check('DeepSeek Harness', false, `installed but does not start: ${firstLine(out)}`, '', needed);
  return check('DeepSeek Harness', true, `dsh ${firstLine(out)}`, '', needed);
}

export function inWindow(): boolean {
  return terminals.available() && !process.env.AGENT_ORG_TABS;
}

/** What agent-org itself runs on, and whether it can host the agents' terminals. */
export function checkRuntime(): Check[] {
  const runtime = IN_ELECTRON ? `agent-org app (Electron ${process.versions.electron}, Node ${process.versions.node})`
    : `Node ${process.versions.node} (${process.execPath})`;
  const [major, minor] = process.versions.node.split('.').map(Number);
  const recent = major > 22 || (major === 22 && minor >= 13); // node:sqlite without a flag
  return [
    check('Runtime', recent, runtime, recent ? '' : 'agent-org needs Node 22.13 or newer'),
    check('Terminals', terminals.available(), terminals.available() ? 'agents run inside the agent-org window'
      : 'node-pty is missing: agents open in Windows Terminal tabs instead', terminals.available() ? '' : 'Reinstall agent-org.'),
  ];
}

export const AGENT_PROGRAMS = ['Claude Code', 'Codex', 'Grok', 'Antigravity', 'DeepSeek Harness'];

/** All checks, in parallel. `harnesses`: the ones the open team uses (all if null). */
export async function runChecks(harnesses: Iterable<string> | null = null): Promise<Check[]> {
  const used = new Set(harnesses ?? []); // with no team open nothing is required yet: any one agent program will do
  const pwsh = which('pwsh') !== null;
  const basics = [...checkRuntime(), check('PowerShell 7', pwsh, pwsh ? 'found' : 'not found: no agent can start without it',
    'Install it: winget install Microsoft.PowerShell')];
  if (!inWindow()) { // agents run in Windows Terminal tabs only when the window cannot host them
    const wt = which('wt') !== null;
    basics.push(check('Windows Terminal', wt, wt ? 'found' : 'not found', "Install 'Windows Terminal' from the Microsoft Store."));
  }
  const [claude, codex, grok, agy, dsh] = await Promise.all([checkClaude(used), checkCodex(used), checkGrok(used),
    checkAntigravity(used), checkDeepseek(used)]);
  const programs = [claude, codex, ...grok, ...agy, dsh];
  if (!programs.some((c) => c.ok && AGENT_PROGRAMS.includes(c.name))) {
    programs.push(check('Agent programs', false, 'none is installed: agent-org needs at least one',
      'Install Claude Code, Codex, Grok, Antigravity or DeepSeek Harness (see above), then sign in to it once in a terminal.'));
  }
  return [...basics, ...programs];
}

/** Print the setup check (the installer ends with it). */
export async function main(): Promise<number> {
  const checks = await runChecks();
  for (const c of checks) {
    const mark = c.ok ? 'OK ' : c.needed ? '!! ' : '-- ';
    process.stdout.write(`  ${mark}${c.name}: ${c.detail}\n`);
    if (!c.ok && c.fix) process.stdout.write(`       ${c.fix}\n`);
  }
  return checks.every((c) => c.ok || !c.needed) ? 0 : 1;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) process.exitCode = await main();
