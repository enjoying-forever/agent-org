// Stopping agents, and checking the setup.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import * as doctor from '../src/doctor.ts';
import * as launch from '../src/launch.ts';
import { lookup, which } from '../src/runtime.ts';
import * as templates from '../src/templates.ts';
import { cleanup, makeHub, tmpDir } from './helpers.ts';

const windows = process.platform === 'win32' ? false : 'uses tasklist and taskkill';

function exited(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

test('stop ends the harness program', { skip: windows }, async (t) => {
  const { hub } = makeHub(t);
  const standIn = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); // node.exe, as Codex runs
  cleanup(t, () => standIn.kill());
  hub.store.checkIn(999_001, 'worker-a', standIn.pid);
  assert.equal(launch.programName(standIn.pid ?? 0), 'node.exe');
  assert.equal(launch.stopRole(hub, 'worker-a'), 1);
  assert.ok(await exited(standIn, 15_000));
  assert.equal(hub.store.online()['worker-a'] ?? 0, 0);
});

test('stop never touches other programs', { skip: windows || (which('pwsh') === null && 'needs PowerShell 7') }, async (t) => {
  const { hub } = makeHub(t);
  const bystander = spawn(which('pwsh') ?? 'pwsh', ['-NoProfile', '-Command', 'Start-Sleep 60'], { stdio: 'ignore' });
  cleanup(t, () => bystander.kill());
  hub.store.checkIn(999_002, 'worker-b', bystander.pid);
  assert.equal(launch.stopRole(hub, 'worker-b'), 0); // pwsh.exe is not a harness
  assert.ok(!(await exited(bystander, 500)));
  assert.equal(hub.store.online()['worker-b'] ?? 0, 0); // but the stale check-in is gone
});

test('the program name of a missing process', { skip: windows }, () => {
  assert.equal(launch.programName(4_000_000), '');
});

// setup checks

function standIn(t: TestContext, find: (name: string) => string | null, run?: typeof doctor.proc.run): void {
  const [which0, run0, signin0] = [lookup.which, doctor.proc.run, doctor.signin.agy];
  lookup.which = (name) => find(name);
  if (run) doctor.proc.run = run;
  doctor.signin.agy = [0, null];
  cleanup(t, () => {
    [lookup.which, doctor.proc.run, doctor.signin.agy] = [which0, run0, signin0];
  });
}

test('a missing program says how to install it', async (t) => {
  standIn(t, () => null);
  const check = await doctor.checkCodex(new Set(['codex']));
  assert.deepEqual([check.ok, check.detail, check.needed], [false, 'not installed', true]);
  assert.ok(check.fix.includes('npm install -g @openai/codex'));
});

test('a broken Claude install gets the repair command', async (t) => {
  const dir = tmpDir(t);
  const shim = path.join(dir, 'claude.cmd');
  writeFileSync(shim, '');
  const script = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'install.cjs');
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(script, '');
  standIn(t, () => shim, async () => [1, 'not a valid application']);
  const check = await doctor.checkClaude(new Set(['claude']));
  assert.ok(!check.ok && check.detail.startsWith('installed but does not start'));
  assert.equal(check.fix, `An update did not finish. Repair it with: node "${script}"`);
});

test('unused programs are not required', async (t) => {
  standIn(t, () => null);
  assert.equal((await doctor.checkGrok(new Set(['claude'])))[0].needed, false);
});

test("Grok's sign-in and hooks are checked", async (t) => {
  standIn(t, () => 'grok', async (_command, args) => (args.includes('models') ? [0, 'You are not authenticated.'] : [0, 'grok 1.0.13']));
  const names = Object.fromEntries((await doctor.checkGrok(new Set(['grok']))).map((c) => [c.name, c]));
  assert.ok(names.Grok.ok && !names['Grok sign-in'].ok);
  assert.equal(names['Grok sign-in'].fix, 'Run: grok login');
  assert.ok(!names['Grok message delivery'].ok); // the tests' home has none
});

test("Antigravity's sign-in problem is explained", async (t) => {
  standIn(t, () => 'agy', async (_command, args) => (args.includes('--version') ? [0, 'agy 1.2.7']
    : [1, 'Please verify your account in your browser to continue: https://...']));
  const checks = Object.fromEntries((await doctor.checkAntigravity(new Set(['antigravity']))).map((c) => [c.name, c]));
  assert.ok(checks.Antigravity.ok && !checks['Antigravity sign-in'].ok);
  assert.ok(checks['Antigravity sign-in'].fix.includes('finish the sign-in'));
  assert.equal((await doctor.checkAntigravity(new Set()))[0].needed, false); // not used: no sign-in test at all
});

test('the Antigravity sign-in test runs no model', async (t) => {
  const ran: string[][] = [];
  standIn(t, () => 'agy', async (_command, args) => {
    ran.push(args);
    return args.includes('--version') ? [0, 'agy 1.2.7'] : [0, 'Fetching...\ngemini-3.8-flash-high\tGemini 3.8 Flash'];
  });
  const checks = Object.fromEntries((await doctor.checkAntigravity(new Set(['antigravity']))).map((c) => [c.name, c]));
  assert.ok(checks['Antigravity sign-in'].ok);
  assert.ok(ran.some((a) => a.join(' ') === 'models') && !ran.some((a) => a.includes('-p'))); // it lists models; it never prompts one
});

test('with no team open any one program will do', async (t) => {
  const present = new Set(['claude']);
  standIn(t, (name) => (present.has(name) || name === 'pwsh' ? name : null), async () => [0, '1.0']);
  const before = launch.deepseek.command;
  launch.deepseek.command = () => null;
  cleanup(t, () => { launch.deepseek.command = before; });
  let checks = Object.fromEntries((await doctor.runChecks()).map((c) => [c.name, c]));
  assert.ok(checks['Claude Code'].ok && !checks.Codex.ok);
  assert.ok(['Codex', 'Grok', 'Antigravity'].every((n) => !checks[n].needed)); // no red
  assert.ok(!('Agent programs' in checks));
  present.clear(); // nothing at all: that one is a real problem
  checks = Object.fromEntries((await doctor.runChecks()).map((c) => [c.name, c]));
  assert.ok(!checks['Agent programs'].ok && checks['Agent programs'].needed);
});

test('no agent starts without PowerShell 7', (t) => {
  standIn(t, (name) => (name === 'pwsh' ? null : name));
  assert.ok(launch.cannotStart(true).includes('winget install Microsoft.PowerShell'));
  lookup.which = (name) => (name === 'wt' ? null : name);
  assert.equal(launch.cannotStart(true), ''); // the window hosts the agents itself
  assert.ok(launch.cannotStart(false).includes('Windows Terminal'));
});

test('each starting team says which programs it uses', () => {
  const programs = Object.fromEntries(templates.catalogue().filter((x) => !x.mine).map((x) => [x.id, x.programs]));
  assert.deepEqual(programs.solo, ['claude']);
  assert.deepEqual(programs.pair, ['claude', 'codex']);
});

test('the runtime check names what agent-org runs on', () => {
  const [runtime, terms] = doctor.checkRuntime();
  assert.ok(runtime.ok && runtime.detail.includes(process.versions.node));
  assert.equal(terms.name, 'Terminals');
});

test("the window's stop ends harness programs side by side, and nothing else", { skip: windows || (which('pwsh') === null && 'needs PowerShell 7') }, async (t) => {
  const { hub } = makeHub(t);
  const agents = [0, 1].map(() => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })); // node.exe, as Codex runs
  const bystander = spawn(which('pwsh') ?? 'pwsh', ['-NoProfile', '-Command', 'Start-Sleep 60'], { stdio: 'ignore' });
  cleanup(t, () => { for (const c of [...agents, bystander]) c.kill(); });
  hub.store.checkIn(999_011, 'worker-a', agents[0].pid);
  hub.store.checkIn(999_012, 'worker-a', agents[1].pid);
  hub.store.checkIn(999_013, 'worker-b', bystander.pid);
  const [a, b] = await Promise.all([launch.stopRoleAsync(hub, 'worker-a'), launch.stopRoleAsync(hub, 'worker-b')]);
  assert.deepEqual([a, b], [2, 0]);
  assert.ok(await exited(agents[0], 15_000) && await exited(agents[1], 15_000));
  assert.ok(!(await exited(bystander, 500))); // pwsh.exe is not a harness
  assert.deepEqual([hub.store.online()['worker-a'] ?? 0, hub.store.online()['worker-b'] ?? 0], [0, 0]);
});
