// The message law: replies, tasks, help, broadcasts, urgency and economy.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { test } from 'node:test';
import { roleCard } from '../src/cards.ts';
import * as hooks from '../src/hooks.ts';
import { HubError, lawText, MAX_TEXT, PermissionDenied } from '../src/hub.ts';
import { isOpen, Store } from '../src/store.ts';
import { makeHub, raises, rejects, tmpDir } from './helpers.ts';

test('the law reads as numbered rules', () => {
  const text = lawText();
  assert.ok(text.startsWith('1. Chain of command.'));
  assert.ok(text.includes('5. Every task ends with a result.') && text.includes('6. Results are checked.'));
  assert.ok(text.includes('12. Urgent is rare.'));
});

// law 2: answering is always allowed

test('you may answer whoever wrote to you', (t) => {
  const { hub } = makeHub(t);
  const order = hub.session('leader').send('worker-a', 'use SQLite'); // skips tech-lead: allowed downward
  const worker = hub.session('worker-a');
  raises(() => worker.send('leader', 'why SQLite?'), PermissionDenied, 'You may also reply to any message sent to you');
  const reply = worker.send('leader', 'done, SQLite it is', order.id);
  assert.deepEqual([reply.kind, reply.recipient, reply.reply_to], ['reply', 'leader', order.id]);
});

test('replying needs the other side to have written', (t) => {
  const { hub } = makeHub(t);
  const note = hub.session('tech-lead').send('worker-a', 'hello');
  raises(() => hub.session('worker-a').send('leader', 'hi', note.id), PermissionDenied); // tech-lead wrote it
});

// laws 3 and 4: tasks go down and always get closed

test('tasks go down and their result goes back to the assigner', async (t) => {
  const { hub } = makeHub(t);
  const task = hub.session('leader').assignTask('worker-a', 'Build the login form', 'Email + password');
  assert.deepEqual([task.assigner, task.assignee, task.state], ['leader', 'worker-a', 'open']);
  const [message] = hub.session('worker-a').readInbox();
  assert.ok(message.kind === 'task' && message.text.startsWith(`Task #${task.id}: Build the login form`));
  assert.ok(message.text.includes(`finish_task(${task.id}, result)`));
  const done = await hub.session('worker-a').finishTask(task.id, 'Form is in src/login.py');
  assert.equal(done.state, 'done');
  const [result] = hub.session('leader').readInbox(); // past tech-lead: it answers leader's task
  assert.deepEqual([result.kind, result.reply_to], ['result', message.id]);
  assert.ok(result.text.startsWith(`Task #${task.id} is DONE - please review it: Build the login form`));
  assert.equal(result.task_id, task.id); // the result is in the task's thread
});

test('tasks cannot go up or sideways', (t) => {
  const { hub } = makeHub(t);
  raises(() => hub.session('worker-a').assignTask('worker-b', 'write tests'), PermissionDenied, "Peers coordinate but don't assign work");
  raises(() => hub.session('worker-a').assignTask('tech-lead', 'review'), PermissionDenied, 'only assign tasks to people below you');
  raises(() => hub.session('leader').assignTask('you', 'approve'), PermissionDenied, 'not a role');
});

test('the owner gives the leader tasks', async (t) => {
  const { hub } = makeHub(t);
  const task = hub.session('you').assignTask('leader', 'Build a todo app');
  await hub.session('leader').finishTask(task.id, 'Ready in todo.py');
  const [result] = hub.session('you').readInbox();
  assert.ok(result.recipient === 'you' && result.text.includes('Ready in todo.py'));
});

test('only the assignee closes a task, and only once', async (t) => {
  const { hub } = makeHub(t);
  const task = hub.session('tech-lead').assignTask('worker-a', 'x');
  await rejects(() => hub.session('worker-b').finishTask(task.id, 'done'), PermissionDenied, 'not assigned to you');
  await rejects(() => hub.session('worker-a').finishTask(task.id, 'hmm', 'maybe'), HubError, 'outcome must be');
  await hub.session('worker-a').finishTask(task.id, 'done');
  await rejects(() => hub.session('worker-a').finishTask(task.id, 'again'), HubError, 'already done');
});

test('a blocked task stays open for the assigner to resolve', async (t) => {
  const { hub } = makeHub(t);
  const task = hub.session('tech-lead').assignTask('worker-a', 'Deploy');
  const blocked = await hub.session('worker-a').finishTask(task.id, 'Need the server password', 'blocked');
  assert.ok(blocked.state === 'blocked' && isOpen(blocked));
  const [result] = hub.session('tech-lead').readInbox();
  assert.ok(result.text.includes(`Task #${task.id} is BLOCKED: Deploy`));
  assert.deepEqual(hub.session('tech-lead').givenTasks().map((x) => x.id), [task.id]);
  await hub.session('worker-a').finishTask(task.id, 'Deployed after all'); // blocked -> done is fine
});

test('cancelling', (t) => {
  const { hub } = makeHub(t);
  const task = hub.session('tech-lead').assignTask('worker-a', 'Old idea');
  hub.session('worker-a').readInbox(); // it started: it is told to stop (an unread task is just taken back)
  raises(() => hub.session('worker-b').cancelTask(task.id), PermissionDenied, 'only tech-lead or someone above worker-a');
  hub.session('leader').cancelTask(task.id, 'not needed'); // above the assignee
  assert.equal(hub.store.getTask(task.id)?.state, 'cancelled');
  const notice = hub.session('worker-a').readInbox().at(-1);
  assert.ok(notice?.text.includes('is cancelled; stop working on it. Reason: not needed'));
});

test('subtasks belong to your own task', (t) => {
  const { hub } = makeHub(t);
  const big = hub.session('leader').assignTask('tech-lead', 'Build the app');
  const part = hub.session('tech-lead').assignTask('worker-a', 'Build the form', '', big.id);
  assert.equal(part.parent_id, big.id);
  raises(() => hub.session('tech-lead').assignTask('worker-a', 'x', '', part.id), PermissionDenied, 'not one of your tasks');
});

// law 5: help goes up and gets an answer

test('unanswered help is tracked', (t) => {
  const { hub } = makeHub(t);
  const question = hub.session('worker-a').askHelp('Which port?');
  const lead = hub.session('tech-lead');
  assert.deepEqual(lead.unansweredHelp().map((m) => m.id), [question.id]);
  lead.send('worker-a', '8080', question.id);
  assert.deepEqual(lead.unansweredHelp(), []);
});

test('a consultant counts as an answer', (t) => {
  const { hub } = makeHub(t);
  const question = hub.session('worker-a').askHelp('Race condition?');
  hub.session('tech-lead').summonConsultant(question.id, 'medium');
  assert.deepEqual(hub.session('tech-lead').unansweredHelp(), []);
});

// broadcasts, urgency and economy

test('a broadcast goes to the team or everyone below', (t) => {
  const { hub } = makeHub(t);
  assert.deepEqual(hub.session('leader').broadcast('@team', 'Freeze at 5pm').map((m) => m.recipient).sort(), ['researcher', 'tech-lead']);
  assert.deepEqual(hub.session('leader').broadcast('@all', 'Freeze at 5pm').map((m) => m.recipient).sort(),
    ['researcher', 'tech-lead', 'worker-a', 'worker-b']);
  raises(() => hub.session('worker-a').broadcast('@team', 'hi'), HubError, 'nobody below you');
  raises(() => hub.session('leader').send('@team', 'hi'), HubError, 'use broadcast');
});

test('urgent only goes down', (t) => {
  const { hub } = makeHub(t);
  assert.ok(hub.session('tech-lead').send('worker-a', 'STOP: wrong branch', null, true).urgent);
  raises(() => hub.session('worker-a').send('tech-lead', 'look!', null, true), PermissionDenied, 'only messages to people below you may be urgent');
});

test('urgent messages interrupt in full', (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-a');
  hub.session('tech-lead').send('worker-a', 'FYI later');
  hub.session('tech-lead').send('worker-a', 'STOP: wrong branch', null, true);
  const out = hooks.onPostTool(worker, {}) as { hookSpecificOutput: { additionalContext: string } };
  const context = out.hookSpecificOutput.additionalContext;
  assert.ok(context.includes('URGENT') && context.includes('STOP: wrong branch'));
  assert.ok(context.includes('1 new message(s) for you from tech-lead (#1)'));
  assert.deepEqual(worker.readInbox().map((m) => m.text), ['FYI later']); // the urgent one was delivered
});

test('messages have a size limit', (t) => {
  const { hub } = makeHub(t);
  raises(() => hub.session('worker-a').send('tech-lead', 'x'.repeat(MAX_TEXT + 1)), HubError, 'Put long material in a file');
});

// reminders when an agent goes quiet

test('reminders follow the law', async (t) => {
  const { hub } = makeHub(t);
  const lead = hub.session('tech-lead');
  const mine = hub.session('leader').assignTask('tech-lead', 'Design the API');
  const given = lead.assignTask('worker-a', 'Build it');
  await hub.session('worker-a').finishTask(given.id, 'No database access', 'blocked');
  const question = hub.session('worker-b').askHelp('Which test runner?');
  lead.readInbox();
  const out = await hooks.onStop(lead, { stop_hook_active: false }, 0.1, 0.05);
  const reason = String(out?.reason);
  assert.ok(reason.includes(`Task #${mine.id} from leader (Design the API) is still open`));
  assert.ok(reason.includes(`Task #${given.id} you gave to worker-a (Build it) is blocked: No database access`));
  assert.ok(reason.includes(`worker-b asked you for help (#${question.id}) and has no answer yet`));
});

test('an agent waiting for the work it gave out is not pushed on', async (t) => {
  const { hub } = makeHub(t);
  const lead = hub.session('tech-lead');
  const mine = hub.session('leader').assignTask('tech-lead', 'Design the API');
  lead.readInbox();
  lead.assignTask('worker-a', 'Build it'); // it handed the work down and now waits for the result
  const out = await hooks.onStop(lead, { stop_hook_active: false }, 0.1, 0.05);
  assert.ok(out === null || !String(out.reason ?? '').includes(`Task #${mine.id}`));
});

// memory: where you left off

test('the role card carries the law and where you left off', (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-a');
  hub.session('tech-lead').assignTask('worker-a', 'Build the form');
  worker.claim('src/form.py');
  worker.saveNotes('Using Flask. The form posts to /login.');
  const card = roleCard(worker);
  assert.ok(card.includes('THE MESSAGE LAW') && card.includes('2. Answering is always allowed.'));
  assert.ok(card.includes('WHERE YOU LEFT OFF'));
  assert.ok(card.includes('Using Flask. The form posts to /login.'));
  assert.ok(card.includes('[open] from tech-lead: Build the form'));
  assert.ok(card.includes('Files you hold: src/form.py'));
  assert.ok(card.includes('[task] tech-lead -> worker-a: Task #1: Build the form'));
});

test("the role card's chart shows each agent under its own superior", (t) => {
  // it listed the team nearest first: worker-a and worker-b, after researcher, read as researcher's
  const { hub } = makeHub(t);
  const card = roleCard(hub.session('worker-a'));
  const chart = card.slice(card.indexOf('The whole team'), card.indexOf('Files you may write')).split('\n').slice(1, -1)
    .map((l) => l.replace(/ \(.*$/, ''));
  assert.deepEqual(chart, ['  - leader', '    - tech-lead', '      - worker-a', '      - worker-b', '    - researcher']);
});

test('a new role has nothing to recall', (t) => {
  const { hub } = makeHub(t);
  assert.ok(!roleCard(hub.session('researcher')).includes('WHERE YOU LEFT OFF'));
});

test('notes are replaced and limited', (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-a');
  worker.saveNotes('one');
  worker.saveNotes('two');
  assert.equal(hub.store.getNotes('worker-a'), 'two');
  raises(() => worker.saveNotes('x'.repeat(MAX_TEXT + 1)), HubError, 'limited');
});

// the team overview shows tasks

test('the overview lists open tasks', (t) => {
  const { hub } = makeHub(t);
  const task = hub.session('tech-lead').assignTask('worker-b', 'Write tests');
  const rows = Object.fromEntries(hub.session('researcher').overview().map((r) => [r.name, r]));
  assert.deepEqual(rows['worker-b'].tasks.map((x) => x.id), [task.id]);
  assert.deepEqual(rows['worker-a'].tasks, []);
});

// older databases keep working

test('an old database is upgraded in place', (t) => {
  const file = path.join(tmpDir(t), 'hub.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sent_at REAL NOT NULL, sender TEXT NOT NULL,'
    + ' recipient TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, reply_to INTEGER, read_at REAL)');
  old.exec("INSERT INTO messages (sent_at, sender, recipient, kind, text) VALUES (1, 'a', 'b', 'report', 'hi')");
  old.close();
  const store = new Store(file);
  try {
    assert.ok(store.getMessage(1)?.text === 'hi' && !store.getMessage(1)?.urgent);
    assert.ok(store.addMessage('a', 'b', 'instruction', 'go', null, true).urgent);
  } finally {
    store.close();
  }
});
