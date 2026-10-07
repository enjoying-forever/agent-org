import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as hooks from '../src/hooks.ts';
import { Hub } from '../src/hub.ts';
import { Store } from '../src/store.ts';
import { makeHub, tmpDir, writeTeamFile } from './helpers.ts';

const HOOK = path.resolve(import.meta.dirname, '..', 'src', 'org_hook.ts');
type Out = Record<string, any> | null;
const reasonOf = (out: hooks.HookOut): string => String(out?.reason ?? '');

// stop: remind once, then deliver mail

test('mail already waiting comes before reminders', async (t) => {
  const { hub } = makeHub(t);
  hub.session('tech-lead').send('worker-a', 'build the login form');
  hub.session('worker-a').claim('src/app.py');
  const reason = reasonOf(await hooks.onStop(hub.session('worker-a'), { stop_hook_active: false }, 0.1, 0.05));
  assert.ok(reason.includes('#1 [instruction] from tech-lead:\nbuild the login form'));
  assert.ok(!reason.includes('Before you finish'));
});

test('stop reminds to report before going quiet', async (t) => {
  const { hub } = makeHub(t);
  hub.session('tech-lead').send('worker-a', 'build the login form');
  const worker = hub.session('worker-a');
  worker.readInbox();
  const out = await hooks.onStop(worker, { stop_hook_active: false }, 0.1, 0.05);
  assert.equal(out?.decision, 'block');
  assert.ok(reasonOf(out).includes("tech-lead's message #1 has no answer from you"));
  worker.send('tech-lead', 'login form done');
  assert.ok(!reasonOf(await hooks.onStop(worker, { stop_hook_active: false }, 0.1, 0.05)).includes('no answer')); // straight to waiting
});

test('an agent resting with no task lets go of its files', async (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-a');
  worker.claim('src/app.py');
  const out = await hooks.onStop(worker, { stop_hook_active: false }, 0.1, 0.05);
  assert.ok(!reasonOf(out).includes('lock')); // no reminder (it cost a model call): the hub releases them
  assert.deepEqual(hub.store.locks('worker-a'), []);
  hub.session('tech-lead').assignTask('worker-a', 'Build it');
  worker.readInbox();
  worker.claim('src/app.py');
  await hooks.onStop(worker, { stop_hook_active: true }, 0.1, 0.05);
  assert.deepEqual(hub.store.locks('worker-a').map((l) => l.path), ['src/app.py']); // mid-task: kept
});

test('a cancelled task needs no answer', async (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-a');
  const task = hub.session('tech-lead').assignTask('worker-a', 'Build it');
  worker.readInbox();
  hub.session('tech-lead').cancelTask(task.id, 'not needed');
  worker.readInbox();
  assert.ok(!reasonOf(await hooks.onStop(worker, { stop_hook_active: false }, 0.1, 0.05)).includes('no answer'));
});

test("delivered mail keeps the agent's task in its status", async (t) => {
  const { hub } = makeHub(t);
  const task = hub.session('tech-lead').assignTask('worker-a', 'Build the parser');
  await hooks.onStop(hub.session('worker-a'), { stop_hook_active: false }, 0.1, 0.05);
  assert.equal(hub.store.getStatus('worker-a')?.task, `#${task.id} Build the parser`);
});

test('reminders come once per turn', async (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-a');
  worker.claim('src/app.py');
  const out = await hooks.onStop(worker, { stopHookActive: true }, 0.1, 0.05); // Grok spelling
  assert.ok(reasonOf(out).startsWith('agent-org: no new messages yet'));
});

test('stop waits and hands over new messages', async (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-a');
  worker.setStatus('done', 'login form');
  setTimeout(() => {
    const store = new Store(hub.baseTeam.database); // another agent's process
    store.addMessage('tech-lead', 'worker-a', 'instruction', 'now add tests');
    store.close();
  }, 300);
  const out = await hooks.onStop(worker, { stop_hook_active: true }, 5, 0.05);
  assert.equal(out?.decision, 'block');
  assert.ok(reasonOf(out).includes('#1 [instruction] from tech-lead:\nnow add tests'));
  assert.deepEqual(worker.readInbox(), []); // handed over, so read
  assert.equal(hub.store.getStatus('worker-a')?.state, 'working');
});

test('waiting shows in the status and keeps the task', async (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-a');
  worker.setStatus('done', 'login form');
  let seen: [string | undefined, string | undefined] = [undefined, undefined];
  setTimeout(() => {
    const store = new Store(hub.baseTeam.database);
    const s = store.getStatus('worker-a');
    seen = [s?.state, s?.task];
    store.close();
  }, 200);
  await hooks.onStop(worker, { stop_hook_active: true }, 0.5, 0.05);
  assert.deepEqual(seen, ['waiting', 'login form']);
});

// post-tool: mention new mail once

test('post-tool mentions each new message once', (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-a');
  assert.equal(hooks.onPostTool(worker, {}), null);
  hub.session('tech-lead').send('worker-a', 'one');
  hub.session('worker-b').send('worker-a', 'two');
  const out = hooks.onPostTool(worker, {}) as Out;
  assert.ok(out!.hookSpecificOutput.additionalContext.includes('2 new message(s) for you from tech-lead, worker-b (#1, #2)'));
  assert.equal(hooks.onPostTool(worker, {}), null);
});

// pre-edit: one writer per file

const edit = (file: string, tool = 'Edit', cwd: string | null = null): hooks.Payload =>
  ({ tool_name: tool, tool_input: { file_path: file }, ...(cwd ? { cwd } : {}) });
const denied = (out: hooks.HookOut): string | false => {
  const spec = ((out ?? {}) as Out)?.hookSpecificOutput ?? {};
  return spec.permissionDecision === 'deny' && spec.permissionDecisionReason;
};

test('editing a free file claims it', (t) => {
  const { hub } = makeHub(t);
  const root = hub.baseTeam.project_root;
  const worker = hub.session('worker-a');
  const out = hooks.onPreEdit(worker, edit(path.join(root, 'src', 'app.py'))) as Out;
  assert.ok(!denied(out));
  assert.ok(out!.hookSpecificOutput.additionalContext.includes('you now hold the write lock on src/app.py'));
  assert.ok(worker.canWrite('src/app.py'));
  assert.equal(hooks.onPreEdit(worker, edit('src/app.py', 'Edit', root)), null); // already held
});

test("editing someone else's file is refused", (t) => {
  const { hub } = makeHub(t);
  hub.session('worker-a').claim('tests/test_app.py');
  const reason = String(denied(hooks.onPreEdit(hub.session('worker-b'), edit('tests/test_app.py', 'Write', hub.baseTeam.project_root))));
  assert.ok(reason.includes('tests/test_app.py is being written by worker-a'));
  assert.ok(reason.includes('ask tech-lead (or worker-a directly: you are peers)'));
});

test('editing outside the write scope is refused', (t) => {
  const { hub } = makeHub(t);
  const root = hub.baseTeam.project_root;
  let reason = String(denied(hooks.onPreEdit(hub.session('worker-b'), edit(path.join(root, 'src', 'app.py')))));
  assert.ok(reason.includes('You may not edit src/app.py') && reason.includes('outside your write scope'));
  reason = String(denied(hooks.onPreEdit(hub.session('researcher'), edit(path.join(root, 'notes.md')))));
  assert.ok(reason.includes('write scope (nothing)'));
});

test('consultants edit only what they are handed', (t) => {
  const { hub } = makeHub(t);
  const root = hub.baseTeam.project_root;
  const request = hub.session('worker-a').askHelp('stuck');
  hub.session('tech-lead').summonConsultant(request.id, 'medium');
  const consultant = hub.session('consultant-1');
  assert.ok(String(denied(hooks.onPreEdit(consultant, edit(path.join(root, 'src', 'a.py'))))).includes('handed to them'));
  hub.session('worker-a').claim('src/a.py');
  hub.session('worker-a').handOver('src/a.py', 'consultant-1');
  assert.equal(hooks.onPreEdit(consultant, edit(path.join(root, 'src', 'a.py'))), null);
});

test("files outside the project are not the hub's business", (t) => {
  const { hub } = makeHub(t);
  assert.equal(hooks.onPreEdit(hub.session('worker-b'), edit(path.join(tmpDir(t), 'scratch.txt'))), null);
});

test('the hub folder is off limits', (t) => {
  const { hub } = makeHub(t);
  const reason = String(denied(hooks.onPreEdit(hub.session('you'), edit(path.join(hub.baseTeam.project_root, '.agent-org', 'hub.db')))));
  assert.ok(reason.includes('belongs to the agent-org hub'));
});

test('non-edit tools are ignored', (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-b');
  assert.equal(hooks.onPreEdit(worker, edit(path.join(hub.baseTeam.project_root, 'src', 'app.py'), 'Read')), null);
  assert.equal(hooks.onPreEdit(worker, { tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
});

test('apply_patch files are checked', (t) => {
  const { hub } = makeHub(t);
  const patch = '*** Begin Patch\n*** Update File: src/app.py\n@@\n-a\n+b\n*** Add File: tests/test_new.py\n+x\n*** End Patch';
  const payload = { tool_name: 'apply_patch', tool_input: { input: patch }, cwd: hub.baseTeam.project_root };
  assert.deepEqual(new Set(hooks.editedPaths(payload)), new Set(['src/app.py', 'tests/test_new.py']));
  const out = hooks.onPreEdit(hub.session('worker-a'), payload) as Out;
  assert.ok(out!.hookSpecificOutput.additionalContext.includes('src/app.py, tests/test_new.py'));
  const reason = String(denied(hooks.onPreEdit(hub.session('worker-b'), payload)));
  assert.ok(reason.includes('outside your write scope') || reason.includes('being written by'));
});

test('the Grok payload spelling', () => {
  assert.deepEqual(hooks.editedPaths({ toolName: 'search_replace', toolInput: { path: 'src/x.py' }, cwd: '.' }), ['src/x.py']);
});

// the command harnesses run

function runHook(args: string[], payload: unknown, envExtra: Record<string, string>, cwd: string): Promise<{ code: number; stdout: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENT_ORG_') || k === 'AGENT_ORG_HOME'));
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [HOOK, ...args], { cwd, env: { ...env, ...envExtra }, timeout: 30_000 }, (error, stdout) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ code: error ? Number(error.code) : 0, stdout });
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}

test('hooks do nothing outside an agent-org tab', async (t) => {
  assert.deepEqual(await runHook(['pre-edit'], { tool_name: 'Edit', tool_input: { file_path: 'x' } }, {}, tmpDir(t)), { code: 0, stdout: '' });
});

test('the hook command denies as JSON', async (t) => {
  const file = writeTeamFile(t);
  new Store(path.join(path.dirname(file), '.agent-org', 'hub.db')).close();
  const result = await runHook(['pre-edit'], edit(path.join(path.dirname(file), 'project', 'src', 'app.py')),
    { AGENT_ORG_TEAM: file, AGENT_ORG_ROLE: 'worker-b' }, path.dirname(file));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('a broken team file never blocks the harness', async (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(await runHook(['stop'], {}, { AGENT_ORG_TEAM: path.join(dir, 'missing.yaml'), AGENT_ORG_ROLE: 'worker-a' }, dir), { code: 0, stdout: '' });
});

// Antigravity speaks its own hook dialect

test('Antigravity answers are translated', () => {
  assert.deepEqual(hooks.forAntigravity('stop', { decision: 'block', reason: 'mail' }), { decision: 'continue', reason: 'mail' });
  assert.deepEqual(hooks.forAntigravity('pre-edit', { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'held' } }),
    { decision: 'deny', reason: 'held' });
  assert.deepEqual(hooks.forAntigravity('invocation', { hookSpecificOutput: { additionalContext: '2 new messages' } }),
    { injectSteps: [{ ephemeralMessage: '2 new messages' }] });
  assert.deepEqual(hooks.forAntigravity('pre-edit', null), { decision: 'allow' }); // a pre-tool answer needs a decision
  assert.deepEqual(hooks.forAntigravity('stop', null), {});
});

test('Antigravity tool calls are read', (t) => {
  const { hub } = makeHub(t);
  const file = path.join(hub.baseTeam.project_root, 'src', 'a.py');
  const payload = { toolCall: { name: 'write_to_file', args: { TargetFile: file } }, conversationId: '0eee4d8d-dfcd-442e-a1f7-97d6c580cb62' };
  assert.deepEqual(hooks.editedPaths(payload), [file]);
  const out = hooks.onPreEdit(hub.session('worker-b'), payload); // worker-b may not write src/
  assert.ok(String(hooks.forAntigravity('pre-edit', out).reason).includes('outside your write scope'));
  hooks.rememberSession(hub.session('worker-b'), payload);
  assert.equal(hub.store.getSession('worker-b')?.session_id, '0eee4d8d-dfcd-442e-a1f7-97d6c580cb62');
  assert.deepEqual(hooks.editedPaths({ toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }), []);
});

test('Antigravity hooks always answer, even outside a tab', async (t) => {
  const dir = tmpDir(t);
  assert.equal((await runHook(['stop'], { executionNum: 1 }, {}, dir)).stdout, '');
  assert.equal((await runHook(['invocation', 'agy'], {}, {}, dir)).stdout, '{}');
});

test('a crashing handler is logged, not fatal', async (t) => {
  const file = writeTeamFile(t);
  process.env.AGENT_ORG_TEAM = file;
  process.env.AGENT_ORG_ROLE = 'worker-a';
  const real = hooks.HANDLERS['post-tool'];
  hooks.HANDLERS['post-tool'] = () => { throw new RangeError('something odd'); };
  try {
    assert.equal(await hooks.main(['post-tool'], (f) => Hub.open(f), '{}'), 0);
  } finally {
    hooks.HANDLERS['post-tool'] = real;
    delete process.env.AGENT_ORG_TEAM;
    delete process.env.AGENT_ORG_ROLE;
  }
  const log = readFileSync(path.join(path.dirname(file), '.agent-org', hooks.HOOK_LOG), 'utf8');
  assert.ok(log.includes('RangeError: something odd') && log.includes('worker-a post-tool'));
});

test('a note is not announced mid-work', (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-a');
  hub.note('worker-a', 'tech-lead changed your role (duties). Call my_role to see it now.');
  assert.equal(hooks.onPostTool(worker, {}), null); // it comes with the next read_inbox
  assert.ok(worker.readInbox()[0].text.includes('changed your role'));
});

test('a file the owner holds is refused in plain words', (t) => {
  const { hub } = makeHub(t);
  hub.session('you').claim('src/app.py', 'kept by the owner');
  const out = hooks.onPreEdit(hub.session('worker-a'), { tool_name: 'Edit', tool_input: { file_path: 'src/app.py' }, cwd: hub.baseTeam.project_root }) as Out;
  const reason: string = out!.hookSpecificOutput.permissionDecisionReason;
  // seen: "is being written by you for kept by the owner ... ask tech-lead (or you directly if they are your peer)"
  assert.ok(reason.includes('is being written by the owner (kept by the owner); only one agent'));
  assert.ok(reason.endsWith('ask tech-lead.'));
});

test('non-ASCII hook answers are escaped for any console', () => {
  assert.equal(hooks.asciiJson({ reason: 'café ✓' }), '{"reason":"caf\\u00e9 \\u2713"}');
});

// what the agent is doing, for the owner's page

test('tool calls are told in the owner\'s words', (t) => {
  const { hub } = makeHub(t);
  const root = hub.baseTeam.project_root;
  const say = (payload: hooks.Payload): string | null => hooks.describeAction(payload, root);
  assert.equal(say({ tool_name: 'Bash', tool_input: { command: 'npm   test\n  -- --watch=false' } }), '$ npm test -- --watch=false');
  assert.equal(say({ tool_name: 'exec_command', tool_input: { cmd: ['bash', '-lc', 'pytest -q'] } }), '$ bash -lc pytest -q'); // Codex
  assert.equal(say({ tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src', 'app.py') } }), 'Editing src/app.py');
  assert.equal(say({ toolName: 'read_file', toolInput: { path: 'README.md' }, cwd: root }), 'Reading README.md'); // Grok's camelCase
  assert.equal(say({ toolCall: { name: 'write_to_file', args: { TargetFile: path.join(root, 'b.py') } } }), 'Editing b.py'); // Antigravity
  assert.equal(say({ tool_name: 'Grep', tool_input: { pattern: 'TODO' } }), 'Searching TODO');
  assert.equal(say({ tool_name: 'mcp__org__assign_task', tool_input: { to: 'worker-a', title: 'x' } }), 'assign task → worker-a');
  assert.equal(say({ tool_name: 'mcp__github__create_issue', tool_input: {} }), 'github: create_issue');
  assert.equal(say({ tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123"' } }),
    '$ curl -H "Authorization: Bearer •••"'); // never a secret
  assert.ok(say({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(500) } })!.length <= 140);
  assert.equal(say({}), null); // Antigravity's model-call hook names no tool
});

test('the page sees what each agent is doing: a call runs until it ends, or its turn does', (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-a');
  const call = { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: hub.baseTeam.project_root };
  hooks.HANDLERS['pre-edit'](worker, call);
  let [now] = hub.store.recentActions()['worker-a'];
  assert.deepEqual([now.what, now.ended_at], ['$ npm test', null]); // running
  hooks.HANDLERS['post-tool'](worker, call);
  [now] = hub.store.recentActions()['worker-a'];
  assert.ok(now.ended_at !== null && hub.store.recentActions()['worker-a'].length === 1); // the same call, ended
  hooks.HANDLERS['post-tool'](worker, { tool_name: 'Read', tool_input: { file_path: 'README.md' }, cwd: hub.baseTeam.project_root });
  hooks.HANDLERS['pre-edit'](worker, { tool_name: 'Bash', tool_input: { command: 'npm run build' } });
  assert.deepEqual(hub.store.recentActions()['worker-a'].map((a) => a.what), ['$ npm run build', 'Reading README.md', '$ npm test']);
  hub.store.endActions('worker-a'); // what the stop hook does: an interrupted call never says it ended
  assert.ok(hub.store.recentActions()['worker-a'].every((a) => a.ended_at !== null));
  hooks.HANDLERS['pre-edit'](hub.session('worker-b'), { tool_name: 'Edit', tool_input: { file_path: 'src/app.py' }, cwd: hub.baseTeam.project_root });
  assert.equal(hub.store.recentActions()['worker-b'], undefined); // refused (outside its scope): it never ran
  for (let i = 0; i < 40; i++) hub.store.noteAction('worker-a', `$ step ${i}`, false);
  assert.equal(hub.store.recentActions(100)['worker-a'].length, 30); // only the latest are kept
});
