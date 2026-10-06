// The upgraded law: task lifecycle, dependencies, review, leases, threads, search, watchdog.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { roleCard } from '../src/cards.ts';
import * as hooks from '../src/hooks.ts';
import { type Hub, HubError, LockConflict, MAX_REVISIONS, PermissionDenied } from '../src/hub.ts';
import { isOpen, now } from '../src/store.ts';
import * as watchdog from '../src/watchdog.ts';
import { makeHub, raises, rejects } from './helpers.ts';

type Opts = { details?: string; partOf?: number; doneWhen?: string; after?: number[]; priority?: number };
const give = (hub: Hub, frm: string, to: string, title: string, o: Opts = {}) =>
  hub.session(frm).assignTask(to, title, o.details ?? '', o.partOf ?? null, o.doneWhen ?? '', o.after ?? [], o.priority ?? 2);
const sql = (hub: Hub, statement: string, ...args: (number | string)[]): void => {
  (hub.store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db.prepare(statement).run(...args);
};
const reasonOf = (out: hooks.HookOut): string => String(out?.reason ?? '');
const hub = (t: TestContext): Hub => makeHub(t).hub;

// the lifecycle (after A2A)

test('reading a task starts it', (t) => {
  const h = hub(t);
  let task = give(h, 'tech-lead', 'worker-a', 'Build the form', { doneWhen: 'the form posts to /login' });
  assert.equal(task.state, 'open');
  const [message] = h.session('worker-a').readInbox();
  assert.ok(message.text.includes('Done when: the form posts to /login'));
  assert.ok(message.text.includes("outcome 'rejected'")); // law 4: take it or turn it down
  task = h.store.getTask(task.id)!;
  assert.ok(task.state === 'working' && task.started_at);
});

for (const outcome of ['failed', 'rejected']) {
  test(`${outcome} is final`, async (t) => {
    const h = hub(t);
    const task = give(h, 'tech-lead', 'worker-a', 'x');
    const closed = await h.session('worker-a').finishTask(task.id, 'not possible here', outcome);
    assert.ok(closed.state === outcome && !isOpen(closed));
    const [result] = h.session('tech-lead').readInbox();
    assert.ok(result.kind === 'result' && (result.text.includes('FAILED') || result.text.includes('REJECTED')));
    await rejects(() => h.session('worker-a').finishTask(task.id, 'again'), HubError, `already ${outcome}`);
  });
}

// law 6: results are checked

test('done waits for review, then is accepted', async (t) => {
  const h = hub(t);
  const task = give(h, 'tech-lead', 'worker-a', 'Build it');
  await h.session('worker-a').finishTask(task.id, 'built');
  const lead = h.session('tech-lead');
  assert.deepEqual(lead.toReview().map((x) => x.id), [task.id]);
  assert.ok(reasonOf(await hooks.onStop(lead, { stop_hook_active: true }, 0.1, 0.05)).includes('new messages')); // the result first
  const reason = reasonOf(await hooks.onStop(lead, { stop_hook_active: false }, 0.1, 0.05));
  assert.ok(reason.includes(`Task #${task.id} you gave to worker-a (Build it) is done and waits for your review`));
  assert.equal(lead.reviewTask(task.id, true).state, 'accepted');
  assert.deepEqual([lead.toReview(), lead.givenTasks()], [[], []]);
});

test('sending back needs feedback and has a limit', async (t) => {
  const h = hub(t);
  const task = give(h, 'tech-lead', 'worker-a', 'Build it');
  const worker = h.session('worker-a');
  const lead = h.session('tech-lead');
  worker.readInbox();
  await worker.finishTask(task.id, 'built');
  raises(() => lead.reviewTask(task.id, false), HubError, 'needs feedback');
  for (let round = 1; round <= MAX_REVISIONS; round += 1) {
    const back = lead.reviewTask(task.id, false, `fix ${round}`);
    assert.deepEqual([back.state, back.revisions], ['working', round]);
    const note = worker.readInbox().at(-1)!;
    assert.ok(note.text.includes(`sent back to you (round ${round} of ${MAX_REVISIONS})`) && note.task_id === task.id);
    await worker.finishTask(task.id, `fixed ${round}`);
  }
  raises(() => lead.reviewTask(task.id, false, 'again'), HubError, 'Decide differently');
});

test('only the assigner or above reviews', async (t) => {
  const h = hub(t);
  const task = give(h, 'tech-lead', 'worker-a', 'Build it');
  await h.session('worker-a').finishTask(task.id, 'built');
  raises(() => h.session('worker-b').reviewTask(task.id, true), PermissionDenied, 'reviews task');
  assert.equal(h.session('leader').reviewTask(task.id, true).state, 'accepted');
});

test('only done tasks are reviewed', (t) => {
  const h = hub(t);
  const task = give(h, 'tech-lead', 'worker-a', 'x');
  raises(() => h.session('tech-lead').reviewTask(task.id, true), HubError, 'only a done task is reviewed');
});

// dependencies (after Beads)

test('a task waits for the tasks it depends on', async (t) => {
  const h = hub(t);
  const lead = h.session('tech-lead');
  const api = lead.assignTask('worker-a', 'Build the API');
  const tests = lead.assignTask('worker-b', 'Test the API', '', null, '', [api.id]);
  assert.ok(tests.state === 'waiting' && tests.message_id === null);
  assert.deepEqual(h.session('worker-b').readInbox(), []); // nothing delivered yet
  assert.deepEqual(h.session('worker-b').queuedTasks().map((x) => x.id), [tests.id]);
  await rejects(() => h.session('worker-b').finishTask(tests.id, 'done?'), HubError, 'has not started');
  await h.session('worker-a').finishTask(api.id, 'API ready');
  assert.equal(h.store.getTask(tests.id)?.state, 'open');
  const [delivered] = h.session('worker-b').readInbox();
  assert.ok(delivered.text.startsWith(`Task #${tests.id}: Test the API`));
});

test('a task waits for all of them', async (t) => {
  const h = hub(t);
  const lead = h.session('tech-lead');
  const one = lead.assignTask('worker-a', 'one');
  const two = lead.assignTask('worker-b', 'two');
  const both = lead.assignTask('worker-a', 'after both', '', null, '', [one.id, two.id]);
  await h.session('worker-a').finishTask(one.id, 'ok');
  assert.equal(h.store.getTask(both.id)?.state, 'waiting');
  await h.session('worker-b').finishTask(two.id, 'ok');
  assert.equal(h.store.getTask(both.id)?.state, 'open');
});

test('a failed dependency is reported', async (t) => {
  const h = hub(t);
  const lead = h.session('tech-lead');
  const first = lead.assignTask('worker-a', 'first');
  const then = lead.assignTask('worker-b', 'then', '', null, '', [first.id]);
  lead.readInbox();
  await h.session('worker-a').finishTask(first.id, 'impossible', 'failed');
  const notes = lead.readInbox().filter((m) => m.sender === 'hub');
  assert.ok(notes[0].text.includes(`Task #${then.id} (then) waits for #${first.id}, which ended as failed`));
  raises(() => lead.assignTask('worker-b', 'later', '', null, '', [first.id]), HubError, 'will never be done');
});

test('priority one is urgent', (t) => {
  const h = hub(t);
  const task = give(h, 'tech-lead', 'worker-a', 'Hotfix', { priority: 1 });
  const [message] = h.session('worker-a').readInbox();
  assert.ok(message.urgent && message.text.includes('[urgent priority]'));
  raises(() => give(h, 'tech-lead', 'worker-a', 'x', { priority: 7 }), HubError, 'priority must be');
  assert.equal(task.priority, 1);
});

test('cancelling a waiting task is quiet', (t) => {
  const h = hub(t);
  const lead = h.session('tech-lead');
  const first = lead.assignTask('worker-a', 'first');
  const later = lead.assignTask('worker-b', 'later', '', null, '', [first.id]);
  lead.cancelTask(later.id);
  assert.deepEqual(h.session('worker-b').readInbox(), []); // it never reached worker-b
});

// threads and search (after MCP Agent Mail)

test('a task keeps its conversation together', async (t) => {
  const h = hub(t);
  const task = give(h, 'tech-lead', 'worker-a', 'Build it');
  const worker = h.session('worker-a');
  const [assignment] = worker.readInbox();
  worker.send('tech-lead', 'Which port?', assignment.id);
  await worker.finishTask(task.id, 'built');
  const [, thread] = h.session('leader').taskDetails(task.id);
  assert.deepEqual(thread.map((m) => m.kind), ['task', 'report', 'result']);
  raises(() => h.session('researcher').taskDetails(task.id), PermissionDenied, 'you can see its status with team_status');
});

test('search finds only what you may read', (t) => {
  const h = hub(t);
  h.session('tech-lead').send('worker-a', 'The database password is in vault');
  h.session('leader').send('researcher', 'Research the database options');
  assert.deepEqual(h.session('worker-a').search('database').map((m) => m.recipient), ['worker-a']);
  assert.equal(h.session('leader').search('database').length, 2);
  assert.equal(h.session('you').search('DATABASE').length, 2); // case does not matter
  assert.deepEqual(h.session('worker-b').search('database'), []);
});

// leases (after MCP Agent Mail)

test('a folder lease covers every file in it', (t) => {
  const h = hub(t);
  const worker = h.session('worker-a');
  const lease = worker.claim('src/api/*', 'task #7');
  assert.ok(lease.pattern && lease.reason === 'task #7');
  assert.ok(worker.canWrite('src/api/users.py'));
  assert.ok(!h.session('tech-lead').canWrite('src/api/users.py'));
  raises(() => h.session('tech-lead').claim('src/api/users.py'), LockConflict, /being written by worker-a \(task #\d+\)/);
  raises(() => h.session('tech-lead').claim('src/*'), LockConflict); // overlaps the folder
  h.session('tech-lead').claim('src/web/app.py'); // elsewhere is fine
  const denied = hooks.onPreEdit(h.session('tech-lead'), { tool_name: 'Edit', cwd: h.baseTeam.project_root,
    tool_input: { file_path: 'src/api/users.py' } }) as { hookSpecificOutput: { permissionDecisionReason: string } };
  assert.ok(denied.hookSpecificOutput.permissionDecisionReason.includes('whose lease on src/api/* covers it'));
  raises(() => worker.release('src/api/users.py'), HubError, /covered by worker-a's lease on src\/api\/\*/);
  worker.release('src/api/*');
  assert.ok(!worker.canWrite('src/api/users.py'));
});

test('patterns must stay in the project', (t) => {
  raises(() => hub(t).session('worker-a').claim('../src/*'), PermissionDenied, 'relative to the project folder');
});

test('a lease names the task it is for', (t) => {
  const h = hub(t);
  const task = give(h, 'tech-lead', 'worker-a', 'Build it');
  h.session('worker-a').readInbox();
  assert.equal(h.session('worker-a').claim('src/app.py').reason, `task #${task.id}`);
});

test('expired leases free the file', (t) => {
  const h = hub(t);
  h.session('worker-a').claim('src/app.py');
  sql(h, 'UPDATE locks SET expires_at = ?', now() - 1);
  assert.deepEqual(h.store.locks(), []);
  assert.equal(h.session('tech-lead').claim('src/app.py').owner, 'tech-lead');
});

test('activity renews leases', (t) => {
  const h = hub(t);
  const worker = h.session('worker-a');
  worker.claim('src/app.py');
  sql(h, 'UPDATE locks SET expires_at = ?', now() + 5);
  hooks.onPostTool(worker, {});
  assert.ok((h.store.locks()[0].expires_at ?? 0) > now() + 3000);
  assert.ok('worker-a' in h.store.activity());
});

// the watchdog (after Gas Town's Witness)

test('the watchdog releases expired leases without waking the holder', (t) => {
  const h = hub(t);
  h.session('worker-a').claim('src/app.py');
  sql(h, 'UPDATE locks SET expires_at = ?', now() - 1);
  watchdog.patrol(h);
  assert.deepEqual(h.store.locks(), []);
  assert.deepEqual(h.session('worker-a').readInbox(), []); // no message: it would wake an idle agent for nothing
  assert.ok(h.store.eventsAfter(0).some((e) => e.text.includes('lease on src/app.py ran out')));
});

test('the watchdog lists agents that stopped with work', (t) => {
  const h = hub(t);
  give(h, 'tech-lead', 'worker-a', 'Build it');
  const stopped = watchdog.patrol(h).filter((p) => p.kind === 'stopped');
  assert.ok(stopped.length && stopped[0].role === 'worker-a' && stopped[0].action === 'start');
  h.store.checkIn(1, 'worker-a');
  assert.ok(!watchdog.patrol(h).some((p) => p.kind === 'stopped'));
});

test('the watchdog nudges a stalled task, then tells the assigner', (t) => {
  const h = hub(t);
  const task = give(h, 'tech-lead', 'worker-a', 'Build it');
  h.session('worker-a').readInbox();
  h.session('tech-lead').readInbox();
  h.store.checkIn(1, 'worker-a');
  const later = now() + watchdog.STALL + 5;
  watchdog.patrol(h, true, later);
  const [nudge] = h.session('worker-a').readInbox();
  assert.ok(nudge.sender === 'hub' && nudge.text.includes(`Task #${task.id} (Build it) has shown no progress`));
  watchdog.patrol(h, true, later + 60); // still inside the grace period: nothing more
  assert.deepEqual(h.session('tech-lead').readInbox(), []);
  h.store.checkIn(1, 'worker-a');
  const problems = watchdog.patrol(h, true, later + watchdog.STALL + 5);
  const [told] = h.session('tech-lead').readInbox();
  assert.ok(told.text.includes('has stalled'));
  assert.ok(problems.some((p) => p.kind === 'stalled' && p.task_id === task.id));
  watchdog.patrol(h, true, later + watchdog.STALL + 90);
  assert.deepEqual(h.session('tech-lead').readInbox(), []); // told once
});

test('progress resets the nudge', (t) => {
  const h = hub(t);
  const task = give(h, 'tech-lead', 'worker-a', 'Build it');
  h.session('worker-a').readInbox();
  h.store.checkIn(1, 'worker-a');
  const later = now() + watchdog.STALL + 5;
  watchdog.patrol(h, true, later);
  sql(h, "INSERT INTO activity (role, at) VALUES ('worker-a', ?) ON CONFLICT(role) DO UPDATE SET at = excluded.at", later + 10);
  watchdog.patrol(h, true, later + 20);
  assert.equal(h.store.getTask(task.id)?.nudged_at, null);
});

test('waiting for subtasks is not stalling', (t) => {
  const h = hub(t);
  const task = give(h, 'leader', 'tech-lead', 'Build the app');
  h.session('tech-lead').readInbox();
  h.session('tech-lead').assignTask('worker-a', 'Build a part', '', task.id);
  h.store.checkIn(1, 'tech-lead');
  watchdog.patrol(h, true, now() + 10 * watchdog.STALL);
  assert.ok(h.session('tech-lead').readInbox().every((m) => m.sender !== 'hub'));
});

test('unanswered questions are passed up', (t) => {
  const h = hub(t);
  const question = h.session('worker-a').askHelp('Which database?');
  watchdog.patrol(h, true, now() + watchdog.HELP_WAIT + 5);
  const [note] = h.session('leader').readInbox();
  assert.ok(note.sender === 'hub' && note.text.includes(`worker-a asked tech-lead for help (#${question.id})`));
  watchdog.patrol(h, true, now() + watchdog.HELP_WAIT + 60);
  assert.deepEqual(h.session('leader').readInbox(), []); // once
});

test('what waits for the owner is listed', async (t) => {
  const h = hub(t);
  const question = h.session('leader').askHelp('English or Chinese?');
  const task = give(h, 'you', 'leader', 'Build it');
  await h.session('leader').finishTask(task.id, 'built');
  const kinds = Object.fromEntries(watchdog.patrol(h, false).map((p) => [p.kind, p]));
  assert.ok(kinds.question.message_id === question.id && kinds.question.action === 'answer');
  assert.equal(kinds.review.task_id, task.id);
});

test('message loops are flagged', (t) => {
  const h = hub(t);
  const a = h.session('worker-a');
  const b = h.session('worker-b');
  for (let i = 0; i < watchdog.LOOP_LIMIT / 2 + 1; i += 1) {
    a.send('worker-b', `ping ${i}`);
    b.send('worker-a', `pong ${i}`);
  }
  assert.ok(watchdog.patrol(h).some((p) => p.kind === 'loop'));
  const notes = h.session('tech-lead').readInbox().filter((m) => m.sender === 'hub');
  assert.ok(notes[0].text.includes('going round in circles'));
});

test('duplicate sessions are flagged', (t) => {
  const h = hub(t);
  h.store.checkIn(1, 'worker-a');
  h.store.checkIn(2, 'worker-a');
  assert.ok(watchdog.patrol(h).some((p) => p.kind === 'duplicate' && p.action === 'stop'));
});

// events: the activity feed

test('events record what happened', async (t) => {
  const h = hub(t);
  const task = give(h, 'tech-lead', 'worker-a', 'Build it');
  h.session('worker-a').readInbox();
  h.session('worker-a').claim('src/app.py');
  await h.session('worker-a').finishTask(task.id, 'built');
  assert.deepEqual(h.store.eventsAfter(0).map((e) => e.text), [`gave #${task.id} to worker-a: Build it`, `started #${task.id}: Build it`,
    `took src/app.py (task #${task.id})`, `#${task.id} done: Build it`, 'released src/app.py: its tasks are finished']);
});

test("closing the last task releases the agent's files", async (t) => {
  const h = hub(t);
  const worker = h.session('worker-a');
  const lead = h.session('tech-lead');
  const first = lead.assignTask('worker-a', 'Parser');
  const second = lead.assignTask('worker-a', 'Writer');
  worker.readInbox();
  worker.claim('src/parser.py');
  await worker.finishTask(first.id, 'parsed');
  assert.deepEqual(h.store.locks('worker-a').map((l) => l.path), ['src/parser.py']); // still busy: keeps them
  await worker.finishTask(second.id, 'written');
  assert.deepEqual([h.store.locks('worker-a'), worker.released], [[], ['src/parser.py']]); // nothing left to hold for
});

test('where you left off carries only what is still useful', async (t) => {
  const h = hub(t);
  const lead = h.session('tech-lead');
  const worker = h.session('worker-a');
  const old = lead.assignTask('worker-a', 'Old work');
  worker.readInbox();
  await worker.finishTask(old.id, 'done long ago');
  lead.reviewTask(old.id, true);
  for (let i = 0; i < 6; i += 1) lead.send('worker-a', `note ${i}`);
  // nothing open: no old messages (seen: an old 'please review' was taken as still pending)
  assert.ok(!roleCard(worker).includes('Your last') && !roleCard(lead).includes('Your last'));
  const task = lead.assignTask('worker-a', 'Build the parser');
  const card = roleCard(worker);
  assert.ok(card.includes(`Task #${task.id}`) && !card.includes('note 5')); // with open work: the messages about it
  assert.ok(card.includes(`(task #${task.id} is now open)`)); // and what became of each task
  assert.ok(!roleCard(worker, true).includes('Your last')); // a continued conversation has them already
});

test("the hub keeps an agent's status without calls", async (t) => {
  const h = hub(t);
  const worker = h.session('worker-a');
  const task = h.session('tech-lead').assignTask('worker-a', 'Build the parser');
  worker.readInbox();
  assert.deepEqual([h.store.getStatus('worker-a')?.state, h.store.getStatus('worker-a')?.task], ['working', `#${task.id} Build the parser`]);
  await worker.finishTask(task.id, 'built');
  assert.equal(h.store.getStatus('worker-a')?.state, 'idle');
});

test('a cancelled or moved task leaves its agent idle and free', (t) => {
  const h = hub(t);
  const worker = h.session('worker-a');
  const lead = h.session('tech-lead');
  const task = lead.assignTask('worker-a', 'Build the parser');
  worker.readInbox();
  worker.claim('src/parser.py');
  lead.cancelTask(task.id, 'not needed');
  // seen: the page still showed it working on the cancelled task, holding its file
  assert.ok(h.store.getStatus('worker-a')?.state === 'idle' && h.store.locks('worker-a').length === 0);
  assert.ok(worker.readInbox().at(-1)!.text.includes('Your files are released (src/parser.py)'));
  const moved = lead.assignTask('worker-a', 'Build the writer');
  worker.readInbox();
  lead.reassignTask(moved.id, 'worker-b', 'worker-a is needed elsewhere');
  assert.equal(h.store.getStatus('worker-a')?.state, 'idle');
});

test('a task sent back shows its agent working again', async (t) => {
  const h = hub(t);
  const worker = h.session('worker-a');
  const lead = h.session('tech-lead');
  const task = lead.assignTask('worker-a', 'Build the parser');
  worker.readInbox();
  await worker.finishTask(task.id, 'built');
  assert.equal(h.store.getStatus('worker-a')?.state, 'idle');
  lead.reviewTask(task.id, false, 'handle empty input');
  worker.readInbox();
  assert.deepEqual([h.store.getStatus('worker-a')?.state, h.store.getStatus('worker-a')?.task], ['working', `#${task.id} Build the parser`]);
});

test('whoever gave a task hears when someone above cancels or moves it', (t) => {
  const h = hub(t);
  const lead = h.session('tech-lead');
  const worker = h.session('worker-a');
  const task = lead.assignTask('worker-a', 'Build the parser');
  worker.readInbox();
  h.session('leader').cancelTask(task.id, 'the plan changed');
  const [told] = lead.readInbox(); // else it would go on planning with a task that is gone
  assert.ok(told.kind === 'notice' && told.text.includes(`cancelled task #${task.id}`) && told.text.includes('the plan changed'));
  const moved = lead.assignTask('worker-a', 'Build the writer');
  h.session('leader').reassignTask(moved.id, 'worker-b');
  assert.equal(h.store.unreadCount('tech-lead', true), 0); // news, not a reason to wake it
  assert.ok(lead.readInbox()[0].text.includes(`moved task #${moved.id}`));
  lead.cancelTask(moved.id);
  assert.deepEqual(lead.readInbox(), []); // its own cancel: nothing to tell it
});

test("an owner's cancel reads right to whoever gave the task", (t) => {
  const h = hub(t);
  const task = h.session('tech-lead').assignTask('worker-a', 'Build the parser');
  h.session('you').cancelTask(task.id, 'not needed');
  const [told] = h.session('tech-lead').readInbox();
  // seen as "you cancelled task #4 ... Reason: not needed Plan without it."
  assert.ok(told.text.startsWith(`The owner cancelled task #${task.id}`) && told.text.includes('Reason: not needed. Plan'));
});

test('a task taken away before it was read wakes nobody for nothing', (t) => {
  const h = hub(t);
  const lead = h.session('tech-lead');
  const first = lead.assignTask('worker-a', 'Build the parser');
  lead.reassignTask(first.id, 'worker-b'); // worker-a never read it
  // seen live: the old assignee was woken to read a task and "stop working on it"
  assert.equal(h.store.unreadCount('worker-a'), 0);
  const second = lead.assignTask('worker-a', 'Build the writer');
  lead.cancelTask(second.id);
  assert.ok(h.store.unreadCount('worker-a') === 0 && h.session('worker-a').readInbox().length === 0);
  assert.deepEqual(h.session('worker-b').readInbox().map((m) => m.task_id), [first.id]); // the new one has it
});
