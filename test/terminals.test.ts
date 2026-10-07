// Agents' terminals inside the agent-org window (pseudo-terminals agent-org owns).
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import * as launch from '../src/launch.ts';
import { which } from '../src/runtime.ts';
import * as terminals from '../src/terminals.ts';
import { cleanup, tmpDir } from './helpers.ts';

const needsPty = !terminals.available() || which('pwsh') === null ? 'needs Windows, node-pty and PowerShell 7' : false;
const SHELL = ['pwsh', '-NoLogo', '-NoProfile', '-NoExit', '-Command'];

/** Read a terminal for a while, answering the terminal queries a real page answers. */
async function collect(host: terminals.TerminalHost, name: string, seconds: number, until: string | null = null): Promise<string> {
  let out = '';
  let at = 0;
  let termId = 0;
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const got = (await host.readMany({ [name]: [termId, at] }, 0.3))[name];
    if (!got || 'none' in got) continue;
    if (got.data.includes('\x1b[c')) host.get(name)?.write('\x1b[?1;2c'); // "I am a VT100": PowerShell waits for it
    out += got.data;
    [at, termId] = [got.next, got.id];
    if (until && out.includes(until)) break;
  }
  return out;
}

function setEnv(t: TestContext, name: string, value: string | undefined): void {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  cleanup(t, () => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

test('a fresh environment leaves out the session that started agent-org', (t) => {
  setEnv(t, 'CLAUDECODE', '1');
  setEnv(t, 'CLAUDE_CODE_CHILD_SESSION', '1');
  setEnv(t, 'ELECTRON_RUN_AS_NODE', '1');
  const env = terminals.freshEnv();
  assert.ok(!Object.keys(env).some((k) => /^(CLAUDECODE|CLAUDE_CODE_|ELECTRON_)/i.test(k)));
  assert.ok(Object.keys(env).some((k) => k.toUpperCase() === 'PATH'));
  assert.equal(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH').length, 1); // one PATH, however it is spelt
});

test('a program installed after a look-up is found, and one removed is not', (t) => {
  const dir = tmpDir(t);
  const [bin, other] = [path.join(dir, 'bin'), path.join(dir, 'other')];
  mkdirSync(bin);
  mkdirSync(other);
  const searchPath = [path.join(dir, 'not-there'), other, bin].join(path.delimiter);
  assert.equal(which('newtool', searchPath), null);
  const tool = path.join(bin, process.platform === 'win32' ? 'newtool.cmd' : 'newtool');
  writeFileSync(tool, '', 'utf8');
  assert.equal(which('newtool', searchPath)?.toLowerCase(), tool.toLowerCase());
  mkdirSync(path.join(other, process.platform === 'win32' ? 'newtool.exe' : 'newtool')); // a folder by that name is no program
  assert.equal(which('newtool', searchPath)?.toLowerCase(), tool.toLowerCase());
  rmSync(tool);
  assert.equal(which('newtool', searchPath), null);
});

test('tab parts turn a tab into a terminal', (t) => {
  const dir = tmpDir(t);
  const script = path.join(dir, 'launch', 'worker-a', 'start.ps1');
  const tab = launch.tabCommand('worker-a', '#10A37F', dir, script);
  const [title, color, cwd, argv] = launch.tabParts(tab);
  assert.deepEqual([title, color, cwd], ['worker-a', '#10A37F', dir]);
  assert.ok(argv[0] === 'pwsh' && argv.at(-1) === script);
  assert.equal(launch.tabRole(tab), 'worker-a');
});

test('a terminal streams output, takes keys and remembers its size', { skip: needsPty }, async (t) => {
  const dir = tmpDir(t);
  const host = new terminals.TerminalHost();
  let term: terminals.Terminal | undefined;
  cleanup(t, () => host.closeAll());
  try {
    host.open('a', [...SHELL, 'Write-Host ready-$((2+3))'], dir);
    assert.ok((await collect(host, 'a', 15, 'ready-5')).includes('ready-5'));
    host.get('a')?.write('Write-Host typed-$((6*7))\r');
    assert.ok((await collect(host, 'a', 15, 'typed-42')).includes('typed-42'));
    host.resize('a', 90, 20);
    assert.deepEqual([host.get('a')?.cols, host.get('a')?.rows], [90, 20]);
    const first = host.get('a')?.id ?? 0;
    host.open('a', [...SHELL, 'Write-Host again'], dir); // a restart replaces it, at the same size
    term = host.get('a');
    assert.ok(term && term.id !== first && term.cols === 90 && term.rows === 20);
    const reset = (await host.readMany({ a: [first, 999] }, 1)).a;
    assert.ok(reset && 'reset' in reset && reset.reset); // the page learns to clear its screen
    assert.deepEqual(await host.readMany({ ghost: [0, 0] }, 0), { ghost: { none: true } });
  } finally {
    await host.closeAll();
  }
  assert.ok(!term?.alive);
});

test('a wait for output ends as soon as there is some', { skip: needsPty }, async (t) => {
  const dir = tmpDir(t);
  const host = new terminals.TerminalHost();
  cleanup(t, () => host.closeAll()); // before its folder goes
  const term = host.open('a', [...SHELL, 'Start-Sleep -Milliseconds 1500; Write-Host late'], dir);
  await collect(host, 'a', 1); // its first screen
  const started = Date.now();
  const got = (await host.readMany({ a: [term.id, term.end] }, 15)).a;
  assert.ok(got && Date.now() - started < 10_000);
});

test('pane sizes outlive a restart of agent-org', { skip: needsPty }, async (t) => {
  const dir = tmpDir(t);
  const sizes = path.join(dir, 'terminal-sizes.json');
  const host = new terminals.TerminalHost(sizes);
  try {
    host.open('a', [...SHELL, 'Write-Host hi'], dir);
    host.resize('a', 88, 21);
  } finally {
    await host.closeAll();
  }
  const again = new terminals.TerminalHost(sizes); // agent-org started again: the agent starts as big as its pane
  try {
    const term = again.open('a', [...SHELL, 'Write-Host hi'], dir);
    assert.deepEqual([term.cols, term.rows], [88, 21]);
  } finally {
    await again.closeAll();
  }
  writeFileSync(sizes, 'not json', 'utf8');
  assert.equal(new terminals.TerminalHost(sizes).listing().a, undefined); // a broken file is only forgotten
});

test("agents keep agent-org's way to the internet", (t) => {
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) setEnv(t, name, undefined);
  setEnv(t, 'HTTPS_PROXY', 'http://127.0.0.1:7897');
  let env = terminals.networkEnv({ PATH: 'x', https_proxy: 'http://stale:1' });
  assert.ok(env.HTTPS_PROXY === 'http://127.0.0.1:7897' && !('https_proxy' in env));
  delete process.env.HTTPS_PROXY; // none of its own: Windows' system proxy, if one is on
  const before = terminals.net.systemProxy;
  cleanup(t, () => { terminals.net.systemProxy = before; });
  terminals.net.systemProxy = () => 'http://127.0.0.1:7890';
  env = terminals.networkEnv({ PATH: 'x' });
  assert.ok(env.HTTP_PROXY === 'http://127.0.0.1:7890' && env.HTTPS_PROXY === 'http://127.0.0.1:7890' && env.NO_PROXY.includes('127.0.0.1'));
  terminals.net.systemProxy = () => null;
  assert.ok(!('HTTPS_PROXY' in terminals.networkEnv({ PATH: 'x' })));
});

test("Windows' proxy setting is read", { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const proxy = terminals.net.systemProxy(); // whatever this computer has: none, or a URL
  assert.ok(proxy === null || /^[a-z]+:\/\/\S+$/.test(proxy), String(proxy));
});

test('a program that ends leaves a prompt in its terminal, and closing ends both', { skip: needsPty }, async (t) => {
  const host = new terminals.TerminalHost();
  cleanup(t, () => host.closeAll());
  const term = host.open('a', ['pwsh', '-NoLogo', '-NoProfile', '-Command', 'Write-Host first-part'], tmpDir(t), '', '', {},
    ['pwsh', '-NoLogo', '-NoProfile']);
  let out = await collect(host, 'a', 15, 'A PowerShell prompt');
  assert.ok(out.includes('first-part') && out.includes('[agent-org] pwsh ended'), out);
  assert.ok(term.alive); // the prompt runs on in the same terminal
  await new Promise((r) => setTimeout(r, 1500));
  term.write('Write-Host second-$((3*3))\r');
  out = await collect(host, 'a', 15, 'second-9');
  assert.ok(out.includes('second-9'));
  await host.closeAll();
  assert.ok(!term.alive); // closing it starts nothing more
});
