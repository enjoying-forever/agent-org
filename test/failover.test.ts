// When a subscription runs out: noticing it, moving the work, and waking the agent again.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import * as hooks from '../src/hooks.ts';
import { type Hub, HubError, PermissionDenied } from '../src/hub.ts';
import * as sessions from '../src/sessions.ts';
import { now } from '../src/store.ts';
import * as usage from '../src/usage.ts';
import * as watchdog from '../src/watchdog.ts';
import { cleanup, makeHub, raises, tmpDir } from './helpers.ts';

const SID = '3f2c1a8e-1111-4a2b-9c3d-123456789abc';
const LIMIT_TEXT = "You've hit your session limit · resets 7:20pm (Asia/Singapore)";

function home(t: TestContext): string {
  const dir = path.join(tmpDir(t), 'home');
  const before = sessions.where.home;
  sessions.where.home = () => dir;
  usage.clearCaches();
  cleanup(t, () => { sessions.where.home = before; usage.clearCaches(); });
  return dir;
}

const lines = (...records: unknown[]): string => records.map((r) => `${JSON.stringify(r)}\n`).join('');

function claudeFile(h: string): string {
  const folder = path.join(h, '.claude', 'projects', 'E--proj');
  mkdirSync(folder, { recursive: true });
  return path.join(folder, `${SID}.jsonl`);
}

const apiError = (text: string, error = 'rate_limit') => ({ type: 'assistant', timestamp: '2026-09-28T11:03:21.085Z', isApiErrorMessage: true,
  error, message: { model: '<synthetic>', content: [{ type: 'text', text }] } });

/** Wall-clock time in Singapore, as 'YYYY-MM-DD HH:MM'. */
function inSingapore(t: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// reading the harness's own words

test("a reset time is read from the harness's words", () => {
  const at = Date.UTC(2026, 8, 28, 11, 3) / 1000; // 19:03 in Singapore
  assert.equal(inSingapore(usage.resetTime(LIMIT_TEXT, at)!), '2026-09-28 19:20');
  assert.equal(inSingapore(usage.resetTime('resets 6pm (Asia/Singapore)', at)!), '2026-09-29 18:00'); // tomorrow
  assert.equal(inSingapore(usage.resetTime('weekly limit · resets Oct 3, 7pm (Asia/Singapore)', at)!), '2026-10-03 19:00');
  assert.equal(usage.resetTime("You've hit your usage limit. Try again in 2 hours 30 minutes.", at), at + 9000);
  assert.equal(usage.resetTime('API Error: 529 overloaded', at), null);
});

test('a Claude conversation that ran into its limit', (t) => {
  writeFileSync(claudeFile(home(t)), lines({ type: 'user', message: { role: 'user', content: 'go' } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'working' }] } }, apiError(LIMIT_TEXT)));
  const s = usage.stuck('claude', SID)!;
  assert.ok(s.kind === 'limit' && s.text.includes('session limit'));
  assert.equal(inSingapore(s.until!).slice(-5), '19:20');
});

test('other API errors, and a new turn', (t) => {
  const file = claudeFile(home(t));
  writeFileSync(file, lines(apiError('API Error: 529 Overloaded', 'overloaded')));
  const s = usage.stuck('claude', SID)!;
  assert.deepEqual([s.kind, s.until], ['error', null]);
  appendFileSync(file, lines({ type: 'user', message: { role: 'user', content: 'continue' } })); // someone typed: a new turn
  assert.equal(usage.stuck('claude', SID), null);
});

test('a Codex window that is full', (t) => {
  const day = path.join(home(t), '.codex', 'sessions', '2026', '09', '28');
  mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-2026-09-28T17-17-06-${SID}.jsonl`);
  const full = { timestamp: '2026-09-28T11:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 40, window_minutes: 300 }, secondary: { used_percent: 100.0, window_minutes: 10080, resets_at: 1790000000 } } } };
  writeFileSync(file, lines({ type: 'session_meta', payload: { id: SID } }, full));
  const s = usage.stuck('codex', SID)!;
  assert.deepEqual([s.kind, s.until], ['limit', 1790000000]);
  appendFileSync(file, lines({ type: 'response_item', payload: { type: 'message' } }));
  assert.equal(usage.stuck('codex', SID), null);
});

test('harnesses without a readable record are never stuck', (t) => {
  home(t);
  assert.equal(usage.stuck('grok', SID), null);
  assert.equal(usage.stuck('claude', SID), null); // no file
});

// moving work

function workingTask(hub: Hub) {
  const lead = hub.session('tech-lead');
  const a = hub.session('worker-a');
  const task = lead.assignTask('worker-a', 'Write the tests', '', null, 'pytest passes');
  a.readInbox(); // read: it is working on it now
  for (const file of ['tests/test_x.py', 'src/app.py']) {
    a.claim(file);
    a.noteEdit(file);
  }
  return task;
}

test('reassign moves the task and its leases, and tells both', (t) => {
  const { hub } = makeHub(t);
  const task = workingTask(hub);
  const moved = hub.session('tech-lead').reassignTask(task.id, 'worker-b', 'worker-a is out of its usage limit');
  assert.deepEqual([moved.assignee, moved.state], ['worker-b', 'open']);
  // worker-b may write tests/ but not src/: that lease is freed instead of handed over
  assert.deepEqual(Object.fromEntries(hub.store.locks().map((l) => [l.path, l.owner])), { 'tests/test_x.py': 'worker-b' });
  const [given] = hub.session('worker-b').readInbox();
  assert.ok(given.kind === 'task' && given.task_id === task.id);
  for (const words of ["was worker-a's", 'usage limit', 'tests/test_x.py', `task_details(${task.id})`, 'pytest passes']) assert.ok(given.text.includes(words), words);
  const [told] = hub.session('worker-a').readInbox();
  assert.ok(told.text.includes('moved to worker-b') && told.text.includes('stop working on it'));
  assert.ok(hub.store.eventsAfter(0).some((e) => e.text.includes('moved #1 from worker-a to worker-b')));
});

test('who may move a task, and where', (t) => {
  const { hub } = makeHub(t);
  const task = workingTask(hub);
  raises(() => hub.session('worker-b').reassignTask(task.id, 'worker-b'), PermissionDenied); // neither its assigner nor above
  raises(() => hub.session('leader').reassignTask(task.id, 'researcher'), PermissionDenied); // not below tech-lead
  raises(() => hub.session('tech-lead').reassignTask(task.id, 'you'), PermissionDenied);
  raises(() => hub.session('tech-lead').reassignTask(task.id, 'worker-a'), HubError); // already theirs
  assert.equal(hub.session('leader').reassignTask(task.id, 'worker-b').assignee, 'worker-b'); // above both: allowed
});

test('finished tasks stay put', async (t) => {
  const { hub } = makeHub(t);
  const lead = hub.session('tech-lead');
  const task = lead.assignTask('worker-a', 'Tiny fix');
  hub.session('worker-a').readInbox();
  await hub.session('worker-a').finishTask(task.id, 'fixed');
  lead.reviewTask(task.id, true);
  raises(() => lead.reassignTask(task.id, 'worker-b'), HubError, 'only an unfinished task');
});

test('a waiting task moves quietly and starts for its new owner', async (t) => {
  const { hub } = makeHub(t);
  const lead = hub.session('tech-lead');
  const first = lead.assignTask('worker-b', 'Design');
  const later = lead.assignTask('worker-a', 'Build', '', null, '', [first.id]);
  lead.reassignTask(later.id, 'worker-b');
  const b = hub.session('worker-b');
  assert.deepEqual(b.readInbox().map((m) => m.task_id), [first.id]); // nothing for the waiting task yet
  await b.finishTask(first.id, 'designed');
  assert.deepEqual(b.readInbox().map((m) => m.task_id), [later.id]);
});

// the watchdog

/** Make `found` (role -> Stuck) what the session files say. */
function stuckAs(t: TestContext, hub: Hub, found: Record<string, usage.Stuck>): void {
  for (const name of Object.keys(found)) hub.store.recordSessionId(name, hub.team.roles[name].harness, `sid-${name}`);
  const before = usage.check.stuck;
  usage.check.stuck = (_h, sid) => found[String(sid).replace(/^sid-/, '')] ?? null;
  cleanup(t, () => { usage.check.stuck = before; });
}

test('an agent out of its limit is reported once, with who is free', (t) => {
  const { hub } = makeHub(t);
  const task = workingTask(hub);
  const at = now();
  stuckAs(t, hub, { 'worker-a': { kind: 'limit', text: LIMIT_TEXT, at: at - 60, until: at + 3600 } });
  const [p] = watchdog.patrol(hub).filter((x) => x.role === 'worker-a');
  assert.deepEqual([p.kind, p.action], ['limit', 'reassign']); // not "stopped": starting it would only fail
  const [notice] = hub.session('tech-lead').readInbox();
  assert.ok(notice.text.includes('out of its usage limit until') && notice.text.includes(`#${task.id}`));
  assert.ok(notice.text.includes('Free to take them: worker-b (antigravity)') && notice.text.includes('reassign_task'));
  watchdog.patrol(hub);
  assert.deepEqual(hub.session('tech-lead').readInbox(), []); // once per limit
  assert.equal(hub.stuck()['worker-a'].kind, 'limit');
  const row = hub.session('leader').overview().find((r) => r.name === 'worker-a')!;
  assert.ok(row.stuck.startsWith('out of its usage limit until'));
});

test('after the reset an idle agent is listed for a restart', (t) => {
  const { hub } = makeHub(t);
  workingTask(hub);
  const at = now();
  stuckAs(t, hub, { 'worker-a': { kind: 'limit', text: LIMIT_TEXT, at: at - 7200, until: at - 60 } });
  hub.store.checkIn(4242, 'worker-a');
  const [p] = watchdog.patrol(hub).filter((x) => x.role === 'worker-a');
  assert.ok(p.kind === 'stuck' && p.action === 'restart' && p.text.includes('usage limit has reset'));
});

test('other API errors get a few minutes first', (t) => {
  const { hub } = makeHub(t);
  workingTask(hub);
  const at = now();
  hub.store.checkIn(4242, 'worker-a');
  stuckAs(t, hub, { 'worker-a': { kind: 'error', text: 'API Error: 529', at: at - 30, until: null } });
  assert.deepEqual(watchdog.patrol(hub).filter((p) => p.role === 'worker-a'), []);
  stuckAs(t, hub, { 'worker-a': { kind: 'error', text: 'API Error: 529', at: at - 600, until: null } });
  assert.deepEqual(watchdog.patrol(hub).filter((p) => p.role === 'worker-a').map((p) => p.kind), ['stuck']);
});

test('an agent that worked since is not stuck', (t) => {
  const { hub } = makeHub(t);
  workingTask(hub);
  stuckAs(t, hub, { 'worker-a': { kind: 'error', text: 'API Error: 529', at: now() - 600, until: null } });
  hub.store.touch('worker-a');
  assert.deepEqual({ ...watchdog.stuckAgents(hub) }, {});
});

test('the stop hook keeps mail for later when out of usage', async (t) => {
  const { hub } = makeHub(t);
  const at = now();
  const before = usage.check.stuck;
  usage.check.stuck = () => ({ kind: 'limit', text: LIMIT_TEXT, at, until: at + 600 });
  cleanup(t, () => { usage.check.stuck = before; });
  hub.session('tech-lead').send('worker-a', 'Please also cover the edge cases.');
  assert.equal(await hooks.onStop(hub.session('worker-a'), { session_id: SID, stop_hook_active: false }, 0.1, 0.05), null);
  assert.equal(hub.store.unreadCount('worker-a'), 1); // still there for when it can work again
});
