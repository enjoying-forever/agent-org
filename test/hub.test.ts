import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { HubError, LockConflict, PermissionDenied } from '../src/hub.ts';
import { Store } from '../src/store.ts';
import { makeHub, raises } from './helpers.ts';

// messaging: who may talk to whom

const ALLOWED: [string, string, string][] = [
  ['worker-a', 'tech-lead', 'report'], // to direct superior
  ['tech-lead', 'leader', 'report'],
  ['leader', 'you', 'report'], // the leader reports to the owner
  ['tech-lead', 'worker-a', 'instruction'], // to a direct subordinate
  ['leader', 'worker-b', 'instruction'], // to a subordinate's subordinate
  ['you', 'worker-a', 'instruction'], // the owner reaches everyone
  ['worker-a', 'worker-b', 'peer'], // same superior
  ['tech-lead', 'researcher', 'peer'],
];

for (const [sender, to, kind] of ALLOWED) {
  test(`${sender} may write to ${to} (${kind})`, (t) => {
    const { hub } = makeHub(t);
    const m = hub.session(sender).send(to, 'hello');
    assert.deepEqual([m.sender, m.recipient, m.kind], [sender, to, kind]);
  });
}

const FORBIDDEN: [string, string][] = [
  ['worker-a', 'leader'], // skipping a level upward
  ['worker-a', 'you'],
  ['worker-a', 'researcher'], // cousin: same depth, different superior
  ['researcher', 'worker-a'], // not in researcher's subtree, not a peer
];

for (const [sender, to] of FORBIDDEN) {
  test(`${sender} may not write to ${to}`, (t) => {
    const { hub } = makeHub(t);
    raises(() => hub.session(sender).send(to, 'hello'), PermissionDenied, 'you cannot message');
  });
}

test('a refusal tells the agent who it can reach', (t) => {
  const { hub } = makeHub(t);
  raises(() => hub.session('worker-a').send('researcher', 'hi'), PermissionDenied, /You can message: tech-lead, worker-b\./);
  raises(() => hub.session('researcher').send('worker-a', 'hi'), PermissionDenied, /You can message: leader, tech-lead\./);
});

test('no messages to yourself or strangers', (t) => {
  const { hub } = makeHub(t);
  raises(() => hub.session('leader').send('leader', 'hi'), PermissionDenied, 'yourself');
  raises(() => hub.session('leader').send('ghost', 'hi'), PermissionDenied, 'not in this team');
  raises(() => hub.session('ghost'), PermissionDenied, 'not in this team');
});

test('empty messages are refused', (t) => {
  const { hub } = makeHub(t);
  raises(() => hub.session('worker-a').send('tech-lead', '   '), HubError, 'empty');
});

test('help goes to the direct superior', (t) => {
  const { hub } = makeHub(t);
  const m = hub.session('worker-b').askHelp('how do I run the tests?');
  assert.deepEqual([m.recipient, m.kind], ['tech-lead', 'help']);
  raises(() => hub.session('you').askHelp('anyone?'), PermissionDenied, 'no superior');
});

test('a superior can pass help up as a reply chain', (t) => {
  const { hub } = makeHub(t);
  const question = hub.session('worker-a').askHelp('which database?');
  const up = hub.session('tech-lead').askHelp('worker-a asks: which database?', question.id);
  assert.deepEqual([up.recipient, up.reply_to], ['leader', question.id]);
});

test('reply_to must be your own message', (t) => {
  const { hub } = makeHub(t);
  const other = hub.session('worker-b').send('tech-lead', 'private');
  raises(() => hub.session('worker-a').send('tech-lead', 're', other.id), PermissionDenied, 'not one of yours');
});

test('the inbox is read once', (t) => {
  const { hub } = makeHub(t);
  hub.session('tech-lead').send('worker-a', 'task 1');
  hub.session('leader').send('worker-a', 'task 2');
  const worker = hub.session('worker-a');
  assert.deepEqual(worker.readInbox().map((m) => m.text), ['task 1', 'task 2']);
  assert.deepEqual(worker.readInbox(), []);
});

test('a wait returns when a message arrives', async (t) => {
  const { hub } = makeHub(t);
  setTimeout(() => {
    const other = new Store(hub.baseTeam.database); // a separate connection, like another agent's process
    other.addMessage('tech-lead', 'worker-a', 'instruction', 'go');
    other.close();
  }, 300);
  const started = performance.now();
  const messages = await hub.session('worker-a').waitForMessages(5, 0.05);
  assert.deepEqual(messages.map((m) => m.text), ['go']);
  assert.ok(performance.now() - started < 3000);
});

test('a wait times out empty', async (t) => {
  const { hub } = makeHub(t);
  assert.deepEqual(await hub.session('worker-a').waitForMessages(0.2, 0.05), []);
});

test('an aborted wait returns at once, taking nothing', async (t) => {
  const { hub } = makeHub(t);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100);
  const started = performance.now();
  assert.deepEqual(await hub.session('worker-a').waitForMessages(10, 1, stop.signal), []);
  assert.ok(performance.now() - started < 2000);
});

// looking

test('superiors can view their whole subtree', (t) => {
  const { hub } = makeHub(t);
  hub.session('worker-a').setStatus('working', 'login form');
  hub.session('worker-a').send('tech-lead', 'halfway done');
  const view = hub.session('leader').view('worker-a');
  assert.deepEqual([view.status?.state, view.status?.task], ['working', 'login form']);
  assert.deepEqual(view.recent.map((m) => m.text), ['halfway done']);
  assert.equal(view.superior, 'tech-lead');
});

test('viewing does not mark messages read', (t) => {
  const { hub } = makeHub(t);
  hub.session('worker-a').send('tech-lead', 'done');
  assert.equal(hub.session('leader').view('tech-lead').unread, 1);
  assert.deepEqual(hub.session('tech-lead').readInbox().map((m) => m.text), ['done']);
});

for (const [viewer, target] of [['worker-a', 'tech-lead'], ['worker-a', 'worker-b'], ['tech-lead', 'researcher'], ['researcher', 'leader']]) {
  test(`${viewer} sees ${target}'s status but not its messages`, (t) => {
    const { hub } = makeHub(t);
    hub.session(target).setStatus('working', 'secret plan');
    hub.session('you').send(target, 'private instruction');
    const view = hub.session(viewer).view(target);
    assert.ok(view.limited && view.recent.length === 0);
    assert.deepEqual([view.status?.state, view.status?.task], ['working', 'secret plan']);
  });
}

test('everyone sees the whole team', (t) => {
  const { hub } = makeHub(t);
  hub.session('worker-b').setStatus('blocked', 'waiting for the API');
  hub.session('worker-a').claim('src/app.py');
  hub.store.checkIn(4242, 'worker-a');
  const rows = hub.session('worker-b').overview();
  assert.deepEqual(rows.map((r) => [r.name, r.depth]), [
    ['leader', 0], ['tech-lead', 1], ['worker-a', 2], ['worker-b', 2], ['researcher', 1]]);
  const a = rows.find((r) => r.name === 'worker-a');
  assert.deepEqual([a?.online, a?.locks], [1, 1]);
  const b = rows.find((r) => r.name === 'worker-b');
  assert.deepEqual([b?.status?.state, b?.online], ['blocked', 0]);
});

test('presence counts live sessions', (t) => {
  const { hub } = makeHub(t);
  const store = hub.store;
  store.checkIn(1, 'worker-a');
  store.checkIn(2, 'worker-a');
  store.checkIn(3, 'leader');
  assert.deepEqual(store.online(), { 'worker-a': 2, leader: 1 });
  store.checkOut(2);
  assert.deepEqual(store.online(), { 'worker-a': 1, leader: 1 });
  (store as unknown as { db: { exec: (sql: string) => void } }).db.exec('UPDATE presence SET last_seen = last_seen - 60 WHERE pid = 3'); // a crashed session
  assert.deepEqual(store.online(), { 'worker-a': 1 });
});

test('unnoticed messages are reported once', (t) => {
  const { hub } = makeHub(t);
  hub.session('tech-lead').send('worker-a', 'one');
  assert.deepEqual(hub.store.unnoticed('worker-a').map((m) => m.text), ['one']);
  assert.deepEqual(hub.store.unnoticed('worker-a'), []);
  hub.session('tech-lead').send('worker-a', 'two');
  assert.deepEqual(hub.store.unnoticed('worker-a').map((m) => m.text), ['two']);
  hub.session('worker-a').readInbox();
  assert.deepEqual(hub.store.unnoticed('worker-a'), []);
});

test('a status must be a known state', (t) => {
  const { hub } = makeHub(t);
  raises(() => hub.session('worker-a').setStatus('napping'), HubError, 'state must be one of');
});

// file locks

test('one writer per file', (t) => {
  const { hub } = makeHub(t);
  const lock = hub.session('worker-a').claim('tests/test_login.py');
  assert.deepEqual([lock.path, lock.owner], ['tests/test_login.py', 'worker-a']);
  raises(() => hub.session('worker-b').claim('tests/test_login.py'), LockConflict, 'being written by worker-a');
  assert.equal(hub.session('worker-a').claim('tests/test_login.py').owner, 'worker-a'); // re-claim is fine
});

test('claims are limited to the write scope', (t) => {
  const { hub } = makeHub(t);
  raises(() => hub.session('worker-b').claim('src/app.py'), PermissionDenied, 'outside your write scope');
  raises(() => hub.session('researcher').claim('notes.md'), PermissionDenied, /write scope \(nothing\)/);
  assert.equal(hub.session('you').claim('anything/at/all.txt').owner, 'you');
});

test('paths outside the project are refused', (t) => {
  const { hub } = makeHub(t);
  raises(() => hub.session('worker-a').claim('../escape.py'), PermissionDenied, 'outside the project folder');
});

test('the same file written differently shares one lock', (t) => {
  const { hub } = makeHub(t);
  hub.session('worker-a').claim('src/app.py');
  raises(() => hub.session('tech-lead').claim('./src/../src/app.py'), LockConflict);
});

test('Windows case variants share one lock', { skip: process.platform !== 'win32' }, (t) => {
  const { hub } = makeHub(t);
  hub.session('worker-a').claim('src/App.py');
  raises(() => hub.session('tech-lead').claim('SRC/app.PY'), LockConflict);
});

test('release by the holder or its superiors only', (t) => {
  const { hub } = makeHub(t);
  hub.session('worker-a').claim('tests/a.py');
  raises(() => hub.session('worker-b').release('tests/a.py'), PermissionDenied, 'only they or their superiors');
  raises(() => hub.session('researcher').release('tests/a.py'), PermissionDenied);
  hub.session('leader').release('tests/a.py'); // two levels up
  assert.equal(hub.session('worker-b').claim('tests/a.py').owner, 'worker-b');
  hub.session('worker-b').release('tests/a.py');
  raises(() => hub.session('worker-b').release('tests/a.py'), HubError, 'not locked');
});

test('can write only while holding the lock', (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-a');
  assert.ok(!worker.canWrite('src/app.py'));
  worker.claim('src/app.py');
  assert.ok(worker.canWrite('src/app.py'));
  assert.ok(!hub.session('tech-lead').canWrite('src/app.py'));
  assert.ok(!worker.canWrite('../outside.py'));
});

test('racing claims from separate processes have exactly one winner', async (t) => {
  const { hub } = makeHub(t);
  const db = hub.baseTeam.database;
  const racer = path.resolve(import.meta.dirname, 'fixtures', 'race.ts');
  const start = Date.now() + 1500; // all start together, once every process has opened the database
  const run = promisify(execFile);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => run(process.execPath, [racer, db, `r${i}`, String(start)])));
  assert.equal(results.filter((r) => r.stdout === 'won').length, 1);
});

test('"owner" reaches the owner whatever their name', (t) => {
  const { hub } = makeHub(t);
  assert.equal(hub.session('leader').send('owner', 'done').recipient, hub.team.owner);
});
