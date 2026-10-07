// Quiet starts in the agent-org window, and the waker that types a line when work arrives.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import * as hooks from '../src/hooks.ts';
import { Hub } from '../src/hub.ts';
import * as launch from '../src/launch.ts';
import * as sessions from '../src/sessions.ts';
import { dumpYaml } from '../src/team.ts';
import { Terminal } from '../src/terminals.ts';
import * as wake from '../src/wake.ts';
import * as waker from '../src/waker.ts';
import { cleanup, team, tmpDir } from './helpers.ts';

function setup(t: TestContext, change: (c: ReturnType<typeof team>) => void = () => {}): { hub: Hub; file: string } {
  const dir = tmpDir(t);
  mkdirSync(path.join(dir, 'project'));
  const file = path.join(dir, 'team.yaml');
  const config = team();
  change(config);
  writeFileSync(file, dumpYaml(config), 'utf8');
  const hub = Hub.open(file);
  cleanup(t, () => hub.close());
  Object.keys(hub.team.roles).forEach((role, i) => hub.store.checkIn(900000 + i, role)); // every agent's program runs (its tool server checked in)
  return { hub, file };
}

let ids = 1;

/** What the waker reads of a terminal: when it started, wrote and was typed in; its output. */
class FakeTerm {
  readonly id = ids++;
  alive = true;
  started: number;
  lastOutput: number;
  lastInput: number;
  unsent = false;
  output: string;
  got: string[] = [];

  constructor(now: number, opts: { output?: string; started?: number; quiet?: number; typed?: number } = {}) {
    this.started = now - (opts.started ?? 60);
    this.lastOutput = now - (opts.quiet ?? 10);
    this.lastInput = opts.typed === undefined ? 0 : now - opts.typed;
    this.output = opts.output ?? '> ';
  }

  get end(): number {
    return this.output.length;
  }

  chunk(offset: number): { data: string } {
    return { data: this.output.slice(offset) };
  }

  write(data: string): void {
    this.got.push(data);
  }
}

/** A waker that types at once (no pause between the line and Enter). */
function makeWaker(): waker.Waker {
  const w = new waker.Waker();
  w.typeLine = (term, line) => {
    term.write(line);
    term.write('\r');
  };
  return w;
}

const host = (terms: Record<string, FakeTerm>) => ({ items: () => Object.entries(terms) as unknown as [string, Terminal][] });
const later = (): number => Date.now() / 1000 + 10; // mail sent now has waited ten seconds by then
const startScript = (file: string, role: string): string => readFileSync(path.join(path.dirname(file), '.agent-org', 'launch', role, 'start.ps1'), 'utf8');

// quiet starts

test('a quiet start sends no first message', (t) => {
  const { hub, file } = setup(t);
  for (const role of ['leader', 'worker-a', 'worker-b', 'researcher']) {
    const tab = launch.roleTab(hub, file, role, false, true);
    const script = startScript(file, role);
    assert.ok(!script.includes("You are the ''") && !script.includes('the team was restarted'), role);
    assert.ok(script.includes("$env:AGENT_ORG_STOP_IDLE = '1'")); // its Stop hook lets it rest
    assert.ok(script.includes(`$env:AGENT_ORG_STOP_WAIT = '${launch.QUIET_STOP_WAIT}'`)); // soon: you can type to it
    assert.ok(tab.at(-1)?.endsWith('start.ps1'));
  }
  const leader = startScript(file, 'leader');
  assert.ok(leader.trimEnd().endsWith("'--name' 'leader'")); // Claude still gets its role card as system prompt
  assert.ok(leader.includes("'--append-system-prompt-file'"));
  assert.ok(!startScript(file, 'worker-b').includes("'-i'"));
});

test('outside the window an agent still gets its kickoff', (t) => {
  const { hub, file } = setup(t);
  launch.roleTab(hub, file, 'leader');
  const script = startScript(file, 'leader');
  assert.ok(script.includes("You are the ''leader'' agent") && !script.includes('AGENT_ORG_STOP_IDLE'));
});

test("a resting agent's Stop hook lets it rest", async (t) => {
  const me = setup(t).hub.session('worker-a');
  process.env.AGENT_ORG_STOP_IDLE = '1';
  cleanup(t, () => { delete process.env.AGENT_ORG_STOP_IDLE; });
  assert.equal(await hooks.onStop(me, { stop_hook_active: true }, 0.05, 0.01), null);
  delete process.env.AGENT_ORG_STOP_IDLE;
  assert.equal((await hooks.onStop(me, { stop_hook_active: true }, 0.05, 0.01))?.decision, 'block');
});

test('a conversation woken by agent-org is found again', () => {
  assert.ok(waker.wakeLine('claude', 'leader').includes("agent-org: 'leader', "));
  assert.ok(sessions.markers('leader').some((m) => waker.wakeLine('claude', 'leader').includes(m)));
});

// the waker

test('mail nobody takes wakes an idle agent', (t) => {
  const { hub } = setup(t);
  hub.session('leader').send('researcher', 'look into X');
  const now = later();
  const term = new FakeTerm(now);
  assert.deepEqual(makeWaker().tick(hub, host({ researcher: term }), now), ['researcher']);
  const [line, enter] = term.got;
  assert.ok(line.startsWith("agent-org: 'researcher', you have new messages") && line.includes('read_inbox'));
  assert.equal(enter, '\r'); // pressed apart from the text
  assert.ok(hub.session('researcher').readInbox().length); // the mail itself is left for the agent to read
});

test('the line and Enter are typed apart', async () => {
  const term = new FakeTerm(0);
  const typing = waker.typeLine(term, 'hello');
  assert.deepEqual(term.got, ['hello']);
  await typing;
  assert.deepEqual(term.got, ['hello', '\r']);
});

const busyOrAsking: [string, ConstructorParameters<typeof FakeTerm>[1]][] = [
  ['still writing', { quiet: 1 }], // it is at work (or a Stop hook is waiting, with its timer)
  ['you typed a moment ago', { typed: 5 }],
  ['just started', { started: 2 }], // still drawing its screen
  ['asking you', { output: 'Do you want to make this edit to app.py?\n❯ 1. Yes\n  2. No (esc)\n' }],
  // Codex's own menus, as its screen arrives (cursor moves eat letters): Enter would pick for you
  ["Codex's trust menu", { output: 'rust this folder? Codex can read, edit,andrunfileshere.› 1. Trust and continue 2.Quitenter continue · esc quit' }],
  ["Codex's update menu", { output: 'Updat available · 0.158.0 → 0.160.0› 1. Update now (runs `npm install -g @openai/codex`) 2.Skip' }],
  // Antigravity's: no numbers, no "to" (seen: the line's Enter trusted the folder)
  ["Antigravity's trust question", { output: 'Accessing workspace:\r\nE:/projects/my-app\r\n\r\nDo you trust the contents of this project?\r\n'
    + 'Antigravity CLI requires permission to read, edit, and execute files.\r\n\r\n> Yes, I trust this folder\r\n  No, exit\r\n\r\n↑/↓ Navigate · enter Confirm\r\n' }],
  ['a trust question in colours', { output: '\x1b[1mDo you trust the files in this folder?\x1b[0m\r\n\x1b[2C\x1b[36m> Yes\x1b[0m\r\n  No' }],
  ['an update menu', { output: 'Update ready\r\n> Yes, restart now\r\n  No\r\n↑/↓ Navigate · enter Confirm' }],
];
for (const [why, opts] of busyOrAsking) {
  test(`an agent that is busy or asking is left alone: ${why}`, (t) => {
    const { hub } = setup(t);
    hub.session('leader').send('researcher', 'look into X');
    const now = later();
    const term = new FakeTerm(now, opts);
    assert.deepEqual(makeWaker().tick(hub, host({ researcher: term }), now), []);
    assert.deepEqual(term.got, []);
  });
}

test('a menu the screen has cleared away does not block waking', (t) => {
  const { hub } = setup(t);
  hub.session('leader').send('researcher', 'look into X');
  const now = later();
  const answered = 'Do you trust the contents of this project?\r\n> Yes, I trust this folder\r\n  No, exit\x1b[2J\x1b[H';
  const term = new FakeTerm(now, { output: `${answered}Antigravity CLI 1.2.17\r\n? for shortcuts\r\n> ` });
  assert.deepEqual(makeWaker().tick(hub, host({ researcher: term }), now), ['researcher']);
});

test('a question only written in an answer does not block waking', (t) => {
  const { hub } = setup(t);
  hub.session('leader').send('researcher', 'look into X');
  const now = later();
  const term = new FakeTerm(now, { output: 'Done. Would you like to deploy it as well?\n> ' });
  assert.deepEqual(makeWaker().tick(hub, host({ researcher: term }), now), ['researcher']);
});

test('fresh mail waits for a Stop hook, and a woken agent is not pushed again', (t) => {
  const { hub } = setup(t);
  hub.session('leader').send('researcher', 'look into X');
  const w = makeWaker();
  const now = Date.now() / 1000 + 1; // a waiting Stop hook would have taken it by now+1
  const term = new FakeTerm(now);
  const tick = (at: number): string[] => w.tick(hub, host({ researcher: term }), at);
  assert.deepEqual(tick(now), []);
  assert.deepEqual(tick(now + 10), ['researcher']);
  assert.deepEqual(tick(now + 20), []); // given time to act on it
  // still unread: it is tried again, each time after twice as long (it may be unable to act on it)
  assert.deepEqual(tick(now + 10 + waker.AGAIN), []);
  const at = now + 10 + 2 * waker.AGAIN;
  assert.deepEqual(tick(at), ['researcher']);
  assert.deepEqual(tick(at + 2 * waker.AGAIN), []);
  assert.deepEqual(tick(at + 4 * waker.AGAIN), ['researcher']);
  hub.session('researcher').readInbox(); // it read that mail; new mail is woken for at the usual pace
  hub.session('leader').send('researcher', 'and Y');
  const laterAt = at + 4 * waker.AGAIN + waker.AGAIN + waker.UNREAD_FOR;
  assert.deepEqual(tick(Math.max(laterAt, Date.now() / 1000 + 10)), ['researcher']);
});

test('a stuck agent is not woken', (t) => {
  const { hub } = setup(t);
  hub.session('leader').send('researcher', 'look into X');
  hub.setStuck({ researcher: { kind: 'limit', text: 'out of usage', at: Date.now() / 1000 } });
  const now = later();
  const term = new FakeTerm(now);
  assert.deepEqual(makeWaker().tick(hub, host({ researcher: term }), now), []);
  assert.deepEqual(term.got, []);
});

test('a note alone does not wake an agent', (t) => {
  const { hub } = setup(t);
  hub.note('researcher', 'leader changed your role (duties). Call my_role to see it now.');
  const now = later();
  const term = new FakeTerm(now);
  assert.deepEqual(makeWaker().tick(hub, host({ researcher: term }), now), []);
  assert.deepEqual(term.got, []);
});

test('a terminal whose program ended gets no line', (t) => {
  const { hub } = setup(t);
  hub.session('leader').send('researcher', 'look into X');
  hub.store.checkOut(900000 + Object.keys(hub.team.roles).indexOf('researcher')); // its program exited: a shell is left
  const now = later();
  const term = new FakeTerm(now, { output: 'PS E:\\project> ' });
  assert.deepEqual(makeWaker().tick(hub, host({ researcher: term }), now), []);
  assert.deepEqual(term.got, []);
});

test('an idle agent without mail is left alone', (t) => {
  const { hub } = setup(t);
  const now = later();
  const term = new FakeTerm(now);
  assert.deepEqual(makeWaker().tick(hub, host({ researcher: term }), now), []);
  assert.deepEqual(term.got, []);
});

test('a restarted agent with unfinished tasks carries on, once', (t) => {
  const { hub } = setup(t);
  const task = hub.session('leader').assignTask('researcher', 'Compare the two libraries');
  hub.session('researcher').readInbox(); // it had read the task before the restart
  const w = makeWaker();
  const now = later();
  const term = new FakeTerm(now);
  assert.deepEqual(w.tick(hub, host({ researcher: term }), now), ['researcher']);
  assert.ok(term.got[0].includes('unfinished work') && term.got[0].includes(`#${task.id} Compare the two libraries`));
  assert.ok(!term.got[0].includes('restart')); // its first start too: no word of a restart (seen live)
  assert.deepEqual(w.tick(hub, host({ researcher: term }), now + 2 * waker.AGAIN), []); // only at its start
});

test('Antigravity learns its role from the line', (t) => {
  const { hub } = setup(t);
  hub.session('tech-lead').send('worker-b', 'write the tests');
  const now = later();
  const term = new FakeTerm(now);
  assert.deepEqual(makeWaker().tick(hub, host({ 'worker-b': term }), now), ['worker-b']);
  assert.ok(term.got[0].includes('ToolName my_role') && term.got[0].includes('call_mcp_tool') && term.got[0].includes('no need to open'));
  assert.ok(!waker.wakeLine('claude', 'leader').includes('my_role')); // the others have it as system prompt
});

test('DeepSeek is left to its own waiter', (t) => {
  const { hub } = setup(t, (c) => { (c.roles.researcher as { harness: string }).harness = 'deepseek'; });
  hub.session('leader').send('researcher', 'look into X');
  const now = later();
  const term = new FakeTerm(now);
  assert.deepEqual(makeWaker().tick(hub, host({ researcher: term }), now), []);
  assert.deepEqual(term.got, []);
});

test('only typed text counts as the owner typing', () => {
  const term = Object.create(Terminal.prototype) as Terminal;
  Object.assign(term, { alive: false, lastInput: 0, unsent: false });
  for (const reply of ['\x1b[?1;2c', '\x1b[12;40R', '\x1b[I', '\x1b[A', '\x03', '\r']) term.typed(reply); // replies, keys, Ctrl+C
  assert.equal(term.lastInput, 0);
  term.typed('fix the bug');
  assert.ok(term.lastInput > 0 && term.unsent);
  term.typed('\r');
  assert.ok(!term.unsent); // sent
  term.typed('half a thought');
  term.typed('\x03');
  assert.ok(!term.unsent); // cleared
});

test('text you typed and did not send is not sent along', (t) => {
  const { hub } = setup(t);
  hub.session('leader').send('researcher', 'look into X');
  const now = later();
  const term = new FakeTerm(now, { typed: 60 }); // you typed a minute ago ...
  term.unsent = true; // ... and left it in the input line
  assert.deepEqual(makeWaker().tick(hub, host({ researcher: term }), now), []);
  assert.deepEqual(makeWaker().tick(hub, host({ researcher: term }), now + waker.UNSENT), ['researcher']); // not forever
});

test('DeepSeek starts at once only with unfinished tasks', async (t) => {
  const { hub, file } = setup(t);
  const marker = path.join(tmpDir(t), 'stopped');
  const args = ['--team', file, '--role', 'worker-a', '--stop', marker, '--first'];
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write; // its messages for the terminal
  cleanup(t, () => { process.stdout.write = write; });
  writeFileSync(marker, 'stopped'); // with nothing to do it would wait; stopped, it ends at once
  assert.equal(await wake.main(args), wake.STOPPED);
  rmSync(marker);
  hub.session('tech-lead').assignTask('worker-a', 'Fix the parser');
  hub.session('worker-a').readInbox();
  assert.equal(await wake.main(args), 0); // unfinished work: run now
});

test('new mail sent within one clock tick still counts as new', (t) => {
  // Windows' clock ticks every 15.6 ms: two messages can share a send time (seen: a flaky test)
  const { hub } = setup(t);
  const first = hub.session('leader').send('researcher', 'look into X');
  const w = makeWaker();
  const now = later();
  const term = new FakeTerm(now);
  assert.deepEqual(w.tick(hub, host({ researcher: term }), now), ['researcher']);
  hub.session('researcher').readInbox();
  const second = hub.session('leader').send('researcher', 'and Y');
  (hub.store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
    .prepare('UPDATE messages SET sent_at = ? WHERE id = ?').run(first.sent_at, second.id);
  assert.deepEqual(w.tick(hub, host({ researcher: term }), now + waker.AGAIN), ['researcher']); // new mail: no back-off
});
