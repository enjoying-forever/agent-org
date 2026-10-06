// The tool server: MCP over stdio, the tools each role gets, and what their answers say.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HOOK_TOOL } from '../src/cards.ts';
import type { Hub } from '../src/hub.ts';
import { Hub as HubClass } from '../src/hub.ts';
import * as mcp from '../src/mcp_server.ts';
import { Store } from '../src/store.ts';
import { dumpYaml } from '../src/team.ts';
import { cleanup, makeHub, team, TEAM, tmpDir } from './helpers.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'org_server.ts');

type Reply = Record<string, any>;

/** Drives a Server through in-memory streams, the way a harness drives it through pipes. */
class Client {
  private readonly input = new PassThrough();
  private readonly output = new PassThrough();
  private readonly replies: Reply[] = [];
  private readonly waiting: ((r: Reply) => void)[] = [];
  private nextId = 0;
  private buffer = '';
  readonly done: Promise<void>;

  constructor(hub: Hub, role: string) {
    this.output.setEncoding('utf8');
    this.output.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const reply = JSON.parse(this.buffer.slice(0, nl));
        this.buffer = this.buffer.slice(nl + 1);
        const next = this.waiting.shift();
        if (next) next(reply);
        else this.replies.push(reply);
      }
    });
    this.done = new mcp.Server(hub.session(role), this.input, this.output).serve();
  }

  notify(method: string, params: object = {}): void {
    this.input.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  request(method: string, params: object = {}): number {
    this.nextId += 1;
    this.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: this.nextId, method, params })}\n`);
    return this.nextId;
  }

  /** The next reply, or null if none comes within `timeout` ms. */
  response(timeout = 5000): Promise<Reply | null> {
    const ready = this.replies.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const take = (r: Reply): void => {
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(take), 1);
        resolve(null);
      }, timeout);
      this.waiting.push(take);
    });
  }

  async call(method: string, params: object = {}): Promise<Reply> {
    const id = this.request(method, params);
    const reply = await this.response();
    assert.ok(reply, `no reply to ${method}`);
    assert.equal(reply.id, id);
    return reply;
  }

  async tool(name: string, args: object = {}): Promise<[string, boolean]> {
    const { result } = await this.call('tools/call', { name, arguments: args });
    return [result.content[0].text, result.isError];
  }

  async close(): Promise<void> {
    this.input.end();
    await this.done;
  }
}

function setup(t: TestContext): { hub: Hub; client: (role: string) => Client; opened: string[] } {
  const { hub, opener } = makeHub(t);
  const clients: Client[] = [];
  cleanup(t, async () => {
    for (const c of clients) await c.close();
  });
  return { hub, opened: opener.opened, client: (role) => {
    const c = new Client(hub, role);
    clients.push(c);
    return c;
  } };
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('initialize echoes the protocol and gives the role card', async (t) => {
  const { result } = await setup(t).client('worker-b').call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.ok(result.instructions.includes("You are 'worker-b'")); // Antigravity: no system prompt of its own
  assert.ok(result.instructions.includes('Your superior: tech-lead'));
});

test('a program with the card as system prompt is not given it twice', async (t) => {
  // Codex (and Claude, Grok) get the card from launch; Claude Code would add the server's text too
  const { result } = await setup(t).client('worker-a').call('initialize', { protocolVersion: '2025-06-18' });
  assert.ok(!result.instructions.includes("You are 'worker-a'") && result.instructions.includes('my_role'));
});

test('a misnamed argument is not lost', async (t) => {
  const { hub, client } = setup(t);
  const lead = client('tech-lead');
  // seen in a real run: the leader wrote description=..., and the worker got the task without it
  let [text, err] = await lead.tool('assign_task', { to: 'worker-a', title: 'Parser', description: 'Handle quoted fields.', done_when: 'tests pass' });
  assert.ok(!err, text);
  const [task] = hub.store.tasks({ assignee: 'worker-a' });
  assert.equal(task.details, 'Handle quoted fields.');
  [text, err] = await lead.tool('send_message', { to: 'worker-a', message: 'Start with the CSV reader.' });
  assert.ok(!err && hub.session('worker-a').readInbox().at(-1)?.text === 'Start with the CSV reader.');
  [text, err] = await lead.tool('send_message', { to: 'worker-a', text: 'hi', colour: 'blue' }); // no use for it: say so
  assert.ok(err && text.includes('Unknown argument colour') && text.includes('to, text'));
});

const BASIC_TOOLS = ['my_role', 'team_status', 'send_message', 'ask_help', 'read_inbox', 'wait_for_messages', 'set_status', 'view',
  'claim_file', 'release_file', 'list_locks', 'hand_over_file', 'list_tasks', 'finish_task', 'save_notes', 'task_details', 'search_messages'];

async function toolNames(c: Client): Promise<string[]> {
  return (await c.call('tools/list')).result.tools.map((x: Reply) => x.name).sort();
}

const sorted = (...names: string[]): string[] => [...names].sort();

test('tools are listed with schemas', async (t) => {
  const tools = (await setup(t).client('worker-a').call('tools/list')).result.tools;
  assert.deepEqual(tools.find((x: Reply) => x.name === 'send_message').inputSchema.required, ['to', 'text']);
});

test('each role gets the tools it can use', async (t) => {
  const { hub, client } = setup(t);
  // a worker can have a consultant (and dismiss it) but has nobody to summon one for
  assert.deepEqual(await toolNames(client('worker-a')), sorted(...BASIC_TOOLS, 'dismiss_consultant'));
  // a manager can summon; the tier list is in the tool's schema
  const lead = client('tech-lead');
  assert.deepEqual(await toolNames(lead), sorted(...BASIC_TOOLS, 'dismiss_consultant', 'summon_consultant', 'assign_task', 'cancel_task',
    'review_task', 'reassign_task', 'hire_agent', 'change_agent', 'let_go_agent'));
  const summon = (await lead.call('tools/list')).result.tools.find((x: Reply) => x.name === 'summon_consultant');
  assert.deepEqual(summon.inputSchema.properties.tier.enum, ['medium', 'high']);
  // a consultant only helps
  const request = hub.session('worker-a').askHelp('stuck');
  hub.session('tech-lead').summonConsultant(request.id, 'medium');
  assert.deepEqual(await toolNames(client('consultant-1')), sorted(...BASIC_TOOLS));
});

test('summon and dismiss through tools', async (t) => {
  const { hub, client, opened } = setup(t);
  const request = hub.session('worker-a').askHelp('the parser hangs on empty input');
  const [text, isError] = await client('tech-lead').tool('summon_consultant', { help_id: request.id, tier: 'high', brief: 'probably the loop in tokenize()' });
  assert.ok(!isError && text.startsWith('Summoned consultant-1 (high, codex) under worker-a'), text);
  assert.deepEqual(opened, ['consultant-1']);
  hub.session('worker-a').readInbox(); // tech-lead's notice about the consultant
  assert.deepEqual(await client('worker-a').tool('dismiss_consultant', { name: 'consultant-1' }), ['Dismissed consultant-1.', false]);
});

test('the role card shows the whole team to everyone', async (t) => {
  const { client } = setup(t);
  const [leader] = await client('leader').tool('my_role');
  assert.ok(leader.includes('Your superior: you, the owner: a person who reads your messages in the agent-org UI'));
  assert.ok(leader.includes('Your direct subordinates: tech-lead, researcher'));
  const [worker] = await client('worker-b').tool('my_role');
  assert.ok(worker.includes('Your peers (same superior): worker-a'));
  assert.ok(worker.includes('    - worker-b (antigravity): -  <- you'));
  assert.ok(worker.includes('  - researcher (grok): -')); // other branches are listed too
  assert.ok(worker.includes('Text you write in your own session reaches nobody'));
  assert.ok(worker.includes('THE MESSAGE LAW') && worker.includes('6. Results are checked.'));
});

test('the team_status tool', async (t) => {
  const { hub, client } = setup(t);
  hub.session('worker-a').setStatus('working', 'login form');
  hub.store.checkIn(7, 'worker-a');
  const lines = (await client('researcher').tool('team_status'))[0].split('\n');
  assert.equal(lines[0], 'you (owner)');
  assert.ok(lines.includes('  leader [claude, not running]: not started'));
  assert.ok(lines.includes('      worker-a [codex]: working - login form'));
  assert.ok(lines.includes('    researcher [grok, not running]: not started  <- you'));
});

test('tool results mention new mail once', async (t) => {
  const { hub, client } = setup(t);
  const worker = client('worker-a');
  hub.session('tech-lead').send('worker-a', 'please add tests');
  assert.ok((await worker.tool('list_locks'))[0].endsWith('1 new message(s) for you from tech-lead (#1). Read them with read_inbox.'));
  assert.equal((await worker.tool('list_locks'))[0], 'No files are locked.'); // told once
  assert.ok((await worker.tool('read_inbox'))[0].includes('please add tests'));
});

test('sending to a role that is not running says so', async (t) => {
  const { hub, client } = setup(t);
  let [text] = await client('tech-lead').tool('send_message', { to: 'worker-a', text: 'hi' });
  assert.equal(text, 'Sent #1 (instruction) to worker-a. worker-a is not running right now; it will get this when it starts.');
  hub.store.checkIn(9, 'worker-b');
  [text] = await client('tech-lead').tool('send_message', { to: 'worker-b', text: 'hi' });
  assert.ok(!text.includes('not running'));
});

test('tool calls follow the hub rules', async (t) => {
  const { hub, client } = setup(t);
  const worker = client('worker-a');
  let [text, isError] = await worker.tool('send_message', { to: 'tech-lead', text: 'done' });
  assert.ok(!isError && text.startsWith('Sent #1 (report) to tech-lead.'));
  [text, isError] = await worker.tool('send_message', { to: 'leader', text: 'done' });
  assert.ok(isError && text.startsWith("Refused: you cannot message 'leader'"), text);
  [text, isError] = await worker.tool('claim_file', { path: 'src/app.py' });
  assert.ok(!isError && text.startsWith('You now hold src/app.py.'));
  assert.deepEqual(hub.session('tech-lead').readInbox().map((m) => m.text), ['done']);
});

test('missing arguments and unknown tools are errors', async (t) => {
  const worker = setup(t).client('worker-a');
  assert.deepEqual(await worker.tool('send_message', { to: 'tech-lead' }), ['Missing argument: text', true]);
  assert.deepEqual(await worker.tool('fly'), ['Unknown tool: fly', true]);
  assert.deepEqual(await worker.tool('task_details', { task_id: 'seven' }), ['Bad argument: invalid literal for int() with base 10: "seven"', true]);
});

test('wait_for_messages delivers while other calls still work', async (t) => {
  const { hub, client } = setup(t);
  const worker = client('worker-a');
  const waitId = worker.request('tools/call', { name: 'wait_for_messages', arguments: { timeout_seconds: 10 } });
  await pause(200);
  // the wait is still open, but the server keeps answering
  assert.deepEqual((await worker.call('ping')).result, {});
  assert.equal(hub.session('leader').view('worker-a').status?.state, 'waiting');
  hub.session('tech-lead').send('worker-a', 'please add tests');
  const reply = await worker.response();
  assert.equal(reply?.id, waitId);
  assert.ok(reply.result.content[0].text.includes('please add tests'));
});

test('a cancelled wait leaves messages unread', async (t) => {
  const { hub, client } = setup(t);
  const worker = client('worker-a');
  const waitId = worker.request('tools/call', { name: 'wait_for_messages', arguments: { timeout_seconds: 10 } });
  await pause(200);
  worker.notify('notifications/cancelled', { requestId: waitId });
  await pause(800); // longer than one poll, so the cancelled wait has stopped
  hub.session('tech-lead').send('worker-a', 'still there?');
  await pause(800);
  assert.equal(await worker.response(200), null); // no reply to a cancelled request
  assert.deepEqual(hub.session('worker-a').readInbox().map((m) => m.text), ['still there?']);
});

test('closing stdin stops waits but finishes other calls', async (t) => {
  const { hub, client } = setup(t);
  const worker = client('worker-a');
  const waitId = worker.request('tools/call', { name: 'wait_for_messages', arguments: { timeout_seconds: 10 } });
  const statusId = worker.request('tools/call', { name: 'set_status', arguments: { state: 'done' } });
  await worker.close();
  const replies: unknown[] = [];
  for (let r = await worker.response(200); r !== null; r = await worker.response(200)) replies.push(r.id);
  assert.ok(replies.includes(statusId) && !replies.includes(waitId));
  hub.session('tech-lead').send('worker-a', 'after shutdown');
  assert.deepEqual(hub.session('worker-a').readInbox().map((m) => m.text), ['after shutdown']);
});

test('unknown methods get an error', async (t) => {
  assert.equal((await setup(t).client('worker-a').call('resources/list')).error.code, -32601);
});

test('antigravity gets every tool\'s arguments without opening files', async (t) => {
  const { client } = setup(t);
  // Antigravity writes tool descriptions to files its model opens one by one; my_role lists them all
  const [text] = await client('worker-b').tool('my_role');
  assert.ok(text.includes('YOUR TEAM TOOLS') && text.includes('- finish_task(task_id, result, outcome?)'));
  assert.ok(!(await client('worker-a').tool('my_role'))[0].includes('YOUR TEAM TOOLS')); // the others see the descriptions
});

test('an argument of the obvious other type is taken', async (t) => {
  const { hub, client } = setup(t);
  const worker = client('worker-a');
  let [text, err] = await worker.tool('set_status', { state: 'working', task: 4 }); // seen: a number where text was asked
  assert.ok(!err && hub.store.getStatus('worker-a')?.task === '4', text);
  const lead = client('tech-lead');
  await lead.tool('assign_task', { to: 'worker-a', title: 'Parser', done_when: 'tests pass' });
  const [task] = hub.store.tasks({ assignee: 'worker-a' });
  [text, err] = await worker.tool('task_details', { task_id: `#${task.id}` }); // and "#3" where a number was asked
  assert.ok(!err && text.includes('Parser'));
  await worker.tool('finish_task', { task_id: task.id, result: 'parsed' });
  [text, err] = await lead.tool('review_task', { task_id: task.id, accept: 'false', feedback: 'quotes are lost' }); // "false" is not true
  assert.ok(!err && text.includes('sent back'), text);
});

test('a team without consultant tiers offers no consultant tools', (t) => {
  const data: Record<string, unknown> = team();
  delete data.consultants;
  const { hub } = makeHub(t, data);
  const names = new mcp.Tools(hub.session('tech-lead')).specs.map((s) => s.name);
  assert.ok(!names.includes('dismiss_consultant') && !names.includes('summon_consultant') && names.includes('assign_task'));
});

test("Claude's hooks run in the tool server, unseen by the model", async (t) => {
  const { hub, client } = setup(t);
  const worker = client('worker-a');
  assert.ok(!(await toolNames(worker)).includes(HOOK_TOOL)); // the model never sees it: only Claude Code's hooks call it
  const root = hub.baseTeam.project_root;
  const hook = async (event: string, toolName: string, toolInput: object): Promise<Reply | null> => { // as Claude Code fills it in
    const [text, err] = await worker.tool(HOOK_TOOL, { event, session_id: '', tool_name: toolName, tool_input: JSON.stringify(toolInput), cwd: root });
    assert.ok(!err);
    return text ? JSON.parse(text) : null;
  };
  let out = await hook('pre-edit', 'Edit', { file_path: path.join(root, 'src', 'app.py') });
  assert.ok(out?.hookSpecificOutput.additionalContext.includes('you now hold the write lock on src/app.py'));
  hub.session('worker-b').claim('tests/test_app.py');
  out = await hook('pre-edit', 'Write', { file_path: path.join(root, 'tests', 'test_app.py') });
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'deny'); // someone else writes it
  assert.equal(await hook('post-tool', 'Read', { file_path: 'x' }), null); // nothing new: no answer at all
  hub.session('tech-lead').send('worker-a', 'use the new parser');
  out = await hook('post-tool', 'Read', { file_path: 'x' });
  assert.ok(out?.hookSpecificOutput.additionalContext.includes('1 new message(s) for you from tech-lead'));
  assert.equal(await hook('no-such-event', 'Read', {}), null);
});

// over real pipes, as a harness starts it

function teamFile(t: TestContext, config: object = TEAM): string {
  const dir = tmpDir(t);
  mkdirSync(path.join(dir, 'project'));
  const file = path.join(dir, 'team.yaml');
  writeFileSync(file, dumpYaml(config), 'utf8');
  return file;
}

const server = (args: string[], input: string, env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, [SERVER, ...args], { cwd: ROOT, env, input, encoding: 'utf8', timeout: 20_000 });

test('runs over real stdio', (t) => {
  const file = teamFile(t);
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_message', arguments: { to: 'tech-lead', text: '你好, 测试完成 ✓' } } },
  ];
  const proc = server(['--team', file, '--role', 'worker-a'], requests.map((r) => `${JSON.stringify(r)}\n`).join(''));
  assert.equal(proc.status, 0, proc.stderr);
  const replies = proc.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(replies[0].result.serverInfo.name, 'agent-org');
  assert.ok(replies[1].result.content[0].text.startsWith('Sent #1 (report) to tech-lead.'));
  const store = new Store(path.join(path.dirname(file), '.agent-org', 'hub.db'));
  try {
    assert.equal(store.getMessage(1)?.text, '你好, 测试完成 ✓'); // UTF-8 survives the pipes
  } finally {
    store.close();
  }
});

test('checks run inside a real server while it reads its pipe', async (t) => {
  // A check started by the server must not inherit the harness's stdin pipe: on Windows the child then hangs
  // before it starts, and finish_task never answers.
  const file = teamFile(t, { ...TEAM, checks: [{ name: 'quick', run: `"${process.execPath}" -e "console.log('OK')"` }] });
  const hub = HubClass.open(file);
  const task = hub.session('tech-lead').assignTask('worker-a', 'Tiny fix');
  hub.session('worker-a').readInbox();
  hub.close();
  const proc = spawn(process.execPath, [SERVER, '--team', file, '--role', 'worker-a'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  cleanup(t, () => {
    if (proc.exitCode === null) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
  });
  const lines: Reply[] = [];
  let buffer = '';
  proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    lines.push(...parts.map((p) => JSON.parse(p)));
  });
  for (const r of [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'finish_task', arguments: { task_id: task.id, result: 'fixed' } } }]) {
    proc.stdin.write(`${JSON.stringify(r)}\n`); // stdin stays open: the server is reading it
  }
  const deadline = Date.now() + 30_000;
  while (lines.length < 2 && Date.now() < deadline) await pause(50);
  const answer = lines.find((l) => l.id === 2);
  assert.ok(answer?.result.content[0].text.startsWith(`Task #${task.id} is done`), JSON.stringify(answer));
  proc.stdin.end();
});

test('the role can come from the environment', (t) => {
  const file = teamFile(t);
  const env = { ...process.env, AGENT_ORG_TEAM: file, AGENT_ORG_ROLE: 'researcher' };
  const request = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`;
  let proc = server([], request, env);
  assert.ok(JSON.parse(proc.stdout.split('\n')[0]).result.instructions.includes('role card')); // Grok: a pointer
  // outside an agent-org tab (no role): a quiet server with no tools, not a failure
  delete env.AGENT_ORG_ROLE;
  proc = server([], `${request}${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`, env);
  const replies = proc.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(proc.status, 0);
  assert.ok(replies[0].result.instructions.includes('not part of an agent-org team'));
  assert.deepEqual(replies[1].result, { tools: [] });
});

test('a bad role exits with a message', (t) => {
  const proc = server(['--team', teamFile(t), '--role', 'ghost'], '');
  assert.equal(proc.status, 2);
  assert.ok(proc.stderr.includes('not in this team'), proc.stderr);
});
