// The agent-org window: agents in its terminals, agents started by agents, and hiding and showing it.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as launch from '../src/launch.ts';
import { which } from '../src/runtime.ts';
import * as terminals from '../src/terminals.ts';
import * as ui from '../src/ui.ts';
import { cleanup, freshHome, tmpDir } from './helpers.ts';
import { request, startServer } from './web.ts';

const needsPty = !terminals.available() || which('pwsh') === null ? 'needs Windows, node-pty and PowerShell 7' : false;

test('the window runs agents in its terminals', { skip: needsPty }, async (t) => {
  const dir = tmpDir(t);
  const server = await startServer(t);
  const app = server.app;
  app.inWindow = true; // tests run with tabs; this one opens a harmless stand-in for the agent
  const script = path.join(dir, 'launch', 'leader', 'start.ps1');
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(script, 'Write-Host stand-in-agent\n', 'utf8');
  cleanup(t, () => app.terminals.closeAll());
  app.openTab(launch.tabCommand('leader', '#D97757', dir, script));
  let state = await server.ok('/api/state');
  const leader = state.roles.find((r: any) => r.name === 'leader');
  assert.ok(leader.terminal.alive && state.in_window);
  let out = '';
  let at = 0;
  const end = Date.now() + 15_000;
  while (!out.includes('stand-in-agent') && Date.now() < end) {
    const got = (await server.ok(`/api/terms?w=${encodeURIComponent(JSON.stringify({ leader: [leader.terminal.id, at] }))}`)).terms.leader;
    if (!got) continue;
    if (got.data.includes('\x1b[c')) await server.ok('/api/term-input', { role: 'leader', data: '\x1b[?1;2c' });
    out += got.data;
    at = got.next;
  }
  assert.ok(out.includes('stand-in-agent'));
  await server.ok('/api/term-resize', { role: 'leader', cols: 100, rows: 30 });
  assert.deepEqual([app.terminals.get('leader')?.cols, app.terminals.get('leader')?.rows], [100, 30]);
  assert.equal((await server.request('/api/term-input', { role: 'worker-a', data: 'x' }))[0], 400); // it has none
  assert.equal((await server.request('/api/terms?w=nonsense'))[0], 400);
  state = await server.ok('/api/state');
  assert.deepEqual(app.liveAgents(), ['leader']);
});

test('an agent hired by an agent starts in the window', async (t) => {
  const server = await startServer(t);
  const app = server.app;
  const post = async (secret: string): Promise<number> => (await request(server.port, 'POST', '/api/launcher/start', {
    body: { team: server.teamFile, role: 'worker-a' }, headers: { 'Content-Type': 'application/json', [ui.LAUNCHER_HEADER]: secret } })).status;
  assert.equal(await post('guess'), 403); // only with this agent-org's launcher secret
  assert.equal(await post(app.window.launcher), 409); // its agents run in tabs here: the tool server opens one
  const opened: unknown[][] = [];
  const before = terminals.TerminalHost.prototype.open;
  terminals.TerminalHost.prototype.open = function (...args: unknown[]) {
    opened.push(args);
    return {} as terminals.Terminal;
  };
  cleanup(t, () => { terminals.TerminalHost.prototype.open = before; });
  app.inWindow = true;
  assert.equal(await post(app.window.launcher), 200);
  const [[role, argv, , , , env]] = opened as [string, string[], string, string, string, Record<string, string> | undefined][];
  assert.equal(role, 'worker-a');
  if (argv.at(-1)?.endsWith('start.ps1')) { // run by its start script ...
    assert.ok(readFileSync(argv.at(-1) ?? '', 'utf8').includes('AGENT_ORG_STOP_IDLE')); // quiet: the window wakes it
  } else { // ... or, its program found, directly
    assert.equal(env?.AGENT_ORG_STOP_IDLE, '1');
  }
  assert.equal(launch.windowStart(server.teamFile, 'worker-a'), false); // and a test never reaches a real window
});

test('the window hides with agents running, and a second start brings it back', async (t) => {
  freshHome(t);
  const server = await startServer(t);
  const app = server.app;
  assert.equal((await server.request('/api/window', { action: 'hide' }))[0], 400); // no window in this test server
  const calls: string[] = [];
  app.window.shell = { show: () => calls.push('show'), hide: () => calls.push('hide'), quit: () => calls.push('quit') };
  await server.ok('/api/window', { action: 'hide' });
  assert.deepEqual(calls, ['hide']);
  // a second agent-org start finds this one and asks for its window, with the launcher secret only
  ui.writeInstance(server.port, app.window.launcher);
  assert.equal(await ui.showRunning(), true);
  assert.equal(calls.at(-1), 'show');
  writeFileSync(ui.instanceFile(), JSON.stringify({ pid: 1, port: server.port, launcher: 'guess' }), 'utf8');
  assert.equal(await ui.showRunning(), false); // a wrong secret gets nothing
  const [status] = await server.request('/api/launcher/show', {}, { token: null });
  assert.equal(status, 403);
  await server.ok('/api/window', { action: 'quit' });
  assert.ok(app.window.quitting && calls.at(-1) === 'quit');
  assert.equal((await server.request('/api/window', { action: 'explode' }))[0], 400);
});

test('without a window, showing it opens a signed-in page in the browser', async (t) => {
  const server = await startServer(t);
  const opened: string[] = [];
  server.app.window.openUrl = (url) => opened.push(url);
  assert.equal(server.app.window.show(), 'browser');
  assert.match(opened[0], new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/\\?code=[\\w-]+$`));
});

test("the state says which agent's terminal is asking the owner something", async (t) => {
  const server = await startServer(t);
  server.app.inWindow = true;
  const now = Date.now() / 1000;
  const fake = (output: string, quietFor: number) => ({ id: 1, alive: true, title: 't', color: '', lastOutput: now - quietFor,
    end: output.length, chunk: (from: number) => ({ data: output.slice(from) }), close() {} });
  const terms = (server.app.terminals as unknown as { terms: Map<string, unknown> }).terms;
  terms.set('leader', fake('Do you want to make this edit?\n❯ 1. Yes\n  2. No (esc)\n', 10));
  terms.set('tech-lead', fake('Do you want to make this edit?\n❯ 1. Yes\n', 0.5)); // still drawing: not yet
  terms.set('worker-a', fake('All done. Would you like anything else?\n> ', 10)); // a question in its answer only
  terms.set('worker-b', fake('Do you trust the files in this folder?\n> Yes\n', 10));
  const roles = Object.fromEntries((await server.ok('/api/state')).roles.map((r: any) => [r.name, r.terminal?.asking]));
  assert.deepEqual(roles, { leader: true, 'tech-lead': false, researcher: undefined, 'worker-a': false, 'worker-b': true });
  terms.clear();
});
