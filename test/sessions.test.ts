// A restarted team resumes each role's last conversation instead of starting empty.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import * as hooks from '../src/hooks.ts';
import { Hub } from '../src/hub.ts';
import * as launch from '../src/launch.ts';
import * as sessions from '../src/sessions.ts';
import { dumpYaml } from '../src/team.ts';
import { cleanup, makeHub, team, tmpDir } from './helpers.ts';

function fakeHome(t: TestContext): string {
  const home = path.join(tmpDir(t), 'home');
  const before = sessions.where.home;
  sessions.where.home = () => home;
  cleanup(t, () => { sessions.where.home = before; });
  return home;
}

function setup(t: TestContext): { hub: Hub; file: string; home: string } {
  const home = fakeHome(t);
  const dir = tmpDir(t);
  mkdirSync(path.join(dir, 'project'));
  const file = path.join(dir, 'team.yaml');
  writeFileSync(file, dumpYaml(team()), 'utf8');
  const hub = Hub.open(file);
  cleanup(t, () => hub.close());
  return { hub, file, home };
}

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const startScript = (file: string, role: string): string => readFileSync(path.join(path.dirname(file), '.agent-org', 'launch', role, 'start.ps1'), 'utf8');
const claudeSession = (home: string, sid: string): void => write(path.join(home, '.claude', 'projects', 'E--proj', `${sid}.jsonl`), '{}\n');
const codexDay = (home: string): string => path.join(home, '.codex', 'sessions', '2026', '09', '28');

test('session files are found per harness', (t) => {
  const home = fakeHome(t);
  const sid = '3f2c1a8e-1111-4a2b-9c3d-123456789abc';
  assert.ok(!sessions.exists('claude', sid));
  claudeSession(home, sid);
  assert.ok(sessions.exists('claude', sid));
  write(path.join(codexDay(home), `rollout-2026-09-28T17-17-06-${sid}.jsonl`), '{}');
  assert.ok(sessions.exists('codex', sid));
  mkdirSync(path.join(home, '.grok', 'sessions', 'E%3A%5Cproj', sid), { recursive: true });
  assert.ok(sessions.exists('grok', sid));
  assert.ok(!sessions.exists('claude', null));
  assert.ok(!sessions.exists('claude', '../../etc')); // only ids, never paths
});

test('the first launch starts a new conversation with a known id', (t) => {
  const { hub, file } = setup(t);
  assert.ok(launch.roleTab(hub, file, 'leader'));
  const record = hub.store.getSession('leader');
  assert.ok(record && record.harness === 'claude' && record.session_id?.length === 36);
  const script = startScript(file, 'leader');
  assert.ok(script.includes(`'--session-id' '${record.session_id}'`) && !script.includes("'--resume'"));
});

test('a relaunch resumes the last conversation', (t) => {
  const { hub, file, home } = setup(t);
  launch.roleTab(hub, file, 'leader');
  const sid = hub.store.getSession('leader')?.session_id ?? '';
  claudeSession(home, sid); // the conversation really happened
  launch.roleTab(hub, file, 'leader');
  assert.equal(hub.store.getSession('leader')?.session_id, sid);
  const script = startScript(file, 'leader');
  assert.ok(script.includes(`'--resume' '${sid}'`) && !script.includes("'--session-id'"));
  assert.ok(script.includes("the team was restarted and you are back as ''leader''"));
  launch.roleTab(hub, file, 'leader', true); // asking for a fresh start gives a new conversation
  assert.notEqual(hub.store.getSession('leader')?.session_id, sid);
});

test('a lost conversation is replaced by a new one', (t) => {
  const { hub, file } = setup(t);
  launch.roleTab(hub, file, 'leader');
  const first = hub.store.getSession('leader')?.session_id;
  launch.roleTab(hub, file, 'leader'); // never ran, so nothing to resume
  assert.notEqual(hub.store.getSession('leader')?.session_id, first);
});

test('Codex resumes by the id its hooks reported', (t) => {
  const { hub, file, home } = setup(t);
  launch.roleTab(hub, file, 'worker-a');
  assert.equal(hub.store.getSession('worker-a')?.session_id, null); // Codex picks its own id
  const sid = '01a0e74d-bd00-7fe3-9ca4-856641211825';
  hooks.rememberSession(hub.session('worker-a'), { session_id: sid });
  write(path.join(codexDay(home), `rollout-2026-09-28T17-17-06-${sid}.jsonl`), '{}');
  launch.roleTab(hub, file, 'worker-a');
  const script = startScript(file, 'worker-a');
  assert.ok(script.trimEnd().split('\n').at(-1)?.startsWith("& 'codex' 'resume' '-c'"));
  assert.ok(script.includes(`'${sid}' 'agent-org: the team was restarted`));
});

test('Grok gets a session id and resumes it', (t) => {
  const { hub, file, home } = setup(t);
  launch.roleTab(hub, file, 'researcher');
  const sid = hub.store.getSession('researcher')?.session_id ?? '';
  mkdirSync(path.join(home, '.grok', 'sessions', 'E%3A%5Cproj', sid), { recursive: true });
  launch.roleTab(hub, file, 'researcher');
  assert.ok(startScript(file, 'researcher').includes(`'--resume' '${sid}'`));
});

test('changing harness starts over', (t) => {
  const { hub } = setup(t);
  hub.store.recordSessionId('leader', 'codex', '01a0e74d-bd00-7fe3-9ca4-856641211825');
  const [resume, newId] = launch.planSession(hub, 'leader'); // leader runs on claude now
  assert.ok(resume === null && newId);
});

test('hooks record the session they run in', (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-a');
  hooks.rememberSession(worker, { sessionId: 'abc-123' }); // Grok spelling
  assert.equal(hub.store.getSession('worker-a')?.session_id, 'abc-123');
  hooks.rememberSession(worker, { session_id: 'def-456' }); // after /clear, say
  const record = hub.store.getSession('worker-a');
  assert.deepEqual([record?.session_id, record?.harness], ['def-456', 'codex']);
});

test('the session hook is registered', () => {
  const table = launch.hookTable(null);
  assert.ok((table.SessionStart[0].hooks[0].command as string).endsWith('org_hook.ts session'));
  assert.ok(JSON.stringify(launch.hookTable('Edit'))); // serialisable for settings files
});

// finding a conversation the hub never recorded

const claudeFolder = (home: string, projectRoot: string): string => {
  const folder = path.join(home, '.claude', 'projects', projectRoot.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(folder, { recursive: true });
  return folder;
};
const line = (value: object): string => `${JSON.stringify(value)}\n`;

test('an unrecorded Claude conversation is found by its kickoff', (t) => {
  const { hub, file, home } = setup(t);
  const project = path.join(path.dirname(file), 'project');
  const folder = claudeFolder(home, project);
  const [old, fresh, other] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  writeFileSync(path.join(folder, `${old}.jsonl`), line({ text: launch.kickoff('leader') }));
  writeFileSync(path.join(folder, `${fresh}.jsonl`), line({ text: launch.resumeKickoff('leader') }));
  writeFileSync(path.join(folder, `${other}.jsonl`), line({ text: launch.kickoff('tech-lead') }));
  utimesSync(path.join(folder, `${old}.jsonl`), 1, 1);
  assert.equal(sessions.find('claude', project, 'leader'), fresh); // the newest one of this role
  assert.equal(sessions.find('claude', project, 'worker-a'), null);
  assert.deepEqual(launch.planSession(hub, 'leader'), [fresh, null]);
  assert.equal(hub.store.getSession('leader')?.session_id, fresh); // recorded from now on
  const [resume, newId] = launch.planSession(hub, 'leader', true);
  assert.ok(resume === null && newId);
});

test("another team's conversation in the same folder is not resumed", (t) => {
  const { hub, file, home } = setup(t); // a new team, in a folder where another team's 'leader' worked before
  const project = path.join(path.dirname(file), 'project');
  const theirs = path.join(claudeFolder(home, project), '44444444-4444-4444-8444-444444444444.jsonl');
  writeFileSync(theirs, line({ text: launch.kickoff('leader') }));
  const before = sessions.where.born;
  sessions.where.born = (p) => (p === theirs ? before(p) - 86400 : before(p)); // a day older
  cleanup(t, () => { sessions.where.born = before; });
  assert.equal(launch.planSession(hub, 'leader')[0], null); // a new conversation, not theirs
});

test('Codex conversations are matched by folder and kickoff', (t) => {
  const { file, home } = setup(t);
  const project = path.join(path.dirname(file), 'project');
  const mine = '01a0e757-c923-7012-b57c-1bdbf15c3690';
  const elsewhere = '01a0e757-0000-7012-b57c-1bdbf15c3690';
  for (const [sid, cwd] of [[mine, project], [elsewhere, 'C:\\other']]) {
    write(path.join(codexDay(home), `rollout-2026-09-28T17-28-05-${sid}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { id: sid, cwd } })}\n${JSON.stringify({ type: 'message', text: launch.kickoff('worker-a') })}`);
  }
  assert.equal(sessions.find('codex', project, 'worker-a'), mine);
});

test('Grok conversations are found in the folder they ran in', (t) => {
  const { file, home } = setup(t);
  const project = path.join(path.dirname(file), 'project');
  const sid = '01a0e757-d1be-7231-8876-a306b504bc97';
  write(path.join(home, '.grok', 'sessions', encodeURIComponent(project), sid, 'chat_history.jsonl'), JSON.stringify({ content: launch.kickoff('researcher') }));
  assert.equal(sessions.find('grok', project, 'researcher'), sid);
});

const MAIN = '01a0e757-c7e2-73f3-9cfc-795201ec2236';
const REVIEW = '01a0e757-c923-7012-b57c-1bdbf15c3690';

test('Codex auto-review is never taken for the agent', (t) => {
  // Codex runs its auto-reviewer as a separate conversation that fires the same hooks. Resuming that one gave
  // the user a worker without any org tools.
  const { hub, file, home } = setup(t);
  const project = path.join(path.dirname(file), 'project');
  const codex = (sid: string, meta: object): void => write(path.join(codexDay(home), `rollout-2026-09-28T17-28-05-${sid}.jsonl`),
    line({ type: 'session_meta', payload: { id: sid, ...meta } }));
  codex(MAIN, { cwd: project, source: 'cli', thread_source: 'user', note: "You are the 'worker-a' agent in a team" });
  codex(REVIEW, { cwd: project, source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review', parent_thread_id: MAIN,
    note: "history quoted: You are the 'worker-a' agent in a team" });
  hooks.rememberSession(hub.session('worker-a'), { session_id: REVIEW });
  assert.equal(hub.store.getSession('worker-a')?.session_id, MAIN);
  hub.store.recordSessionId('worker-a', 'codex', REVIEW); // a record written before this fix
  assert.equal(launch.resumableSession(hub, 'worker-a'), MAIN);
  assert.equal(hub.store.getSession('worker-a')?.session_id, MAIN); // and repaired
  hub.store.recordSessionId('worker-a', 'codex', '0000-not-on-disk');
  assert.equal(launch.resumableSession(hub, 'worker-a'), MAIN); // searching skips the reviewer too
});
