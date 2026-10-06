import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import * as sessions from '../src/sessions.ts';
import * as usage from '../src/usage.ts';
import { cleanup, tmpDir } from './helpers.ts';

const SID = '3f2c1a8e-1111-4a2b-9c3d-123456789abc';

/** A home folder of its own for the harnesses' files. */
function home(t: TestContext): string {
  const dir = tmpDir(t);
  const before = sessions.where.home;
  sessions.where.home = () => dir;
  usage.clearCaches();
  cleanup(t, () => { sessions.where.home = before; usage.clearCaches(); });
  return dir;
}

const lines = (...records: unknown[]): string => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

test('Claude usage counts each reply once', (t) => {
  const folder = path.join(home(t), '.claude', 'projects', 'E--proj');
  mkdirSync(folder, { recursive: true });
  const reply = { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 1000, output_tokens: 50 } };
  const other = { id: 'msg_2', model: 'claude-opus-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 1100, output_tokens: 20 } };
  writeFileSync(path.join(folder, `${SID}.jsonl`), lines({ type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', message: reply }, { type: 'assistant', message: reply }, { type: 'assistant', message: other })); // same reply twice
  const u = usage.usage('claude', SID)!;
  assert.deepEqual([u.tokens_in, u.tokens_cached, u.tokens_out, u.messages, u.model], [105, 2100, 70, 2, 'claude-opus-5-5']);
});

test('Codex usage and subscription limits', (t) => {
  const day = path.join(home(t), '.codex', 'sessions', '2026', '09', '28');
  mkdirSync(day, { recursive: true });
  const count = { type: 'event_msg', payload: { type: 'token_count',
    info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 40, reasoning_output_tokens: 10 } },
    rate_limits: { primary: { used_percent: 23.4, window_minutes: 300 }, secondary: { used_percent: 61, window_minutes: 10080 } } } };
  writeFileSync(path.join(day, `rollout-2026-09-28T17-17-06-${SID}.jsonl`), lines({ type: 'session_meta', payload: { id: SID } },
    { type: 'turn_context', payload: { model: 'gpt-6-luna' } }, count));
  const u = usage.usage('codex', SID)!;
  assert.deepEqual([u.tokens_in, u.tokens_cached, u.tokens_out, u.model], [400, 600, 50, 'gpt-6-luna']);
  assert.deepEqual(u.limits, ['5h limit: 23% used', '7d limit: 61% used']);
});

function grokFolder(t: TestContext): string {
  const folder = path.join(home(t), '.grok', 'sessions', 'E%3A%5Cproj', SID);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'summary.json'), JSON.stringify({ num_chat_messages: 42, current_model_id: 'grok-4.7' }));
  return folder;
}

test('Grok reports messages and model', (t) => {
  grokFolder(t);
  const u = usage.usage('grok', SID)!; // no finished turn yet: its messages
  assert.deepEqual([u.messages, u.model, u.tokens_out], [42, 'grok-4.7', 0]);
});

test('Grok usage adds up its finished turns', (t) => {
  const folder = grokFolder(t);
  const turn = (tokensIn: number, cached: number, out: number, calls: number) => ({ method: '_x.ai/session/update', params: { sessionId: SID,
    update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn', usage: { inputTokens: tokensIn, outputTokens: out,
      totalTokens: tokensIn + out, cachedReadTokens: cached, reasoningTokens: Math.floor(out / 2), modelCalls: calls } } } });
  const chunk = { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk' }, _meta: { totalTokens: 1661 } } };
  writeFileSync(path.join(folder, 'updates.jsonl'), lines(chunk, turn(2664859, 2181248, 50712, 22)));
  let u = usage.usage('grok', SID)!;
  // seen: the researcher's pane said "80 msg" though Grok had recorded 2,715,571 tokens
  assert.deepEqual([u.tokens_in, u.tokens_cached, u.tokens_out, u.messages], [483611, 2181248, 50712, 22]);
  appendFileSync(path.join(folder, 'updates.jsonl'), lines(turn(79189, 75648, 858, 3))); // the next turn ends: counted at once
  u = usage.usage('grok', SID)!;
  assert.deepEqual([u.tokens_in, u.tokens_cached, u.tokens_out, u.messages], [483611 + 3541, 2181248 + 75648, 51570, 25]);
});

test('unknown or missing conversations', (t) => {
  home(t);
  assert.equal(usage.usage('claude', SID), null);
  assert.equal(usage.usage('claude', null), null);
  assert.equal(usage.usage('antigravity', SID), null);
});

function varint(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n = Math.floor(n / 128);
    out.push(b | (n ? 0x80 : 0));
    if (!n) return out;
  }
}

/** A protobuf message from [number, int or bytes] fields. */
function pb(...fields: [number, number | Uint8Array][]): Uint8Array {
  const out: number[] = [];
  for (const [number, value] of fields) {
    if (typeof value === 'number') out.push(...varint(number * 8), ...varint(value));
    else out.push(...varint(number * 8 + 2), ...varint(value.length), ...value);
  }
  return Uint8Array.from(out);
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

test('Antigravity usage comes from its conversation database', (t) => {
  const folder = path.join(home(t), '.gemini', 'antigravity-cli', 'conversations');
  mkdirSync(folder, { recursive: true });
  const db = new DatabaseSync(path.join(folder, `${SID}.db`));
  db.exec('CREATE TABLE gen_metadata (idx integer, data blob, size integer, PRIMARY KEY (idx))');
  // one model call as Antigravity writes it: field 1 holds 4 (1 a constant, 2 input, 3 output, 5 cache reads) and 19 (the model)
  [[11755, 1, 0], [12588, 193, 300]].forEach(([tokensIn, tokensOut, cached], i) => {
    const counts = pb([1, 1319], [2, tokensIn], [3, tokensOut], ...(cached ? [[5, cached] as [number, number]] : []), [6, 24]);
    db.prepare('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(i, pb([4, bytes('conv')], [1, pb([3, 1319], [4, counts], [19, bytes('gemini-3.8-flash')])]));
  });
  db.close();
  const u = usage.usage('antigravity', SID)!;
  assert.deepEqual([u.tokens_in, u.tokens_out, u.tokens_cached, u.messages, u.model], [24343, 194, 300, 2, 'gemini-3.8-flash']);
});

test('Antigravity usage counts calls still in the write-ahead log', (t) => {
  const folder = path.join(home(t), '.gemini', 'antigravity-cli', 'conversations');
  mkdirSync(folder, { recursive: true });
  const db = new DatabaseSync(path.join(folder, `${SID}.db`)); // kept open, as by the running agent: nothing is checkpointed
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE gen_metadata (idx integer, data blob, size integer, PRIMARY KEY (idx))');
  const call = (i: number, tokensIn: number): void => {
    db.prepare('INSERT INTO gen_metadata VALUES (?, ?, 0)').run(i, pb([1, pb([4, pb([2, tokensIn], [3, 1])], [19, bytes('gemini-3.8-flash')])]));
  };
  try {
    assert.equal(usage.usage('antigravity', SID)?.messages, 0); // just started
    call(0, 1000);
    assert.equal(usage.usage('antigravity', SID)?.tokens_in, 1000); // (seen: stayed at 0 for a whole task)
    call(1, 500);
    assert.equal(usage.usage('antigravity', SID)?.tokens_in, 1500);
  } finally {
    db.close();
  }
});

test("an agent's usage adds up over all its conversations", (t) => {
  const folder = path.join(home(t), '.claude', 'projects', 'E--proj');
  mkdirSync(folder, { recursive: true });
  const other = '4f2c1a8e-2222-4a2b-9c3d-123456789abc';
  for (const [sid, n] of [[SID, 100], [other, 50]] as [string, number][]) {
    writeFileSync(path.join(folder, `${sid}.jsonl`), lines({ type: 'assistant', message: { id: `m-${sid}`, model: 'claude-sonnet-5-5', usage: { input_tokens: n, output_tokens: 1 } } }));
  }
  const both = usage.total([usage.usage('claude', SID)!, usage.usage('claude', other)!]);
  assert.deepEqual([both.tokens_in, both.tokens_out, both.messages], [150, 2, 2]);
});

test('a usage limit reset time is read in its own time zone', () => {
  const at = Date.parse('2026-10-06T10:00:00Z') / 1000;
  const iso = (s: number | null): string => new Date(s! * 1000).toISOString();
  assert.equal(iso(usage.resetTime('resets 7:20pm (Asia/Singapore)', at)), '2026-10-06T11:20:00.000Z');
  assert.equal(iso(usage.resetTime('resets 5pm (Asia/Singapore)', at)), '2026-10-07T09:00:00.000Z'); // already past today
  assert.equal(iso(usage.resetTime('resets Oct 9, 9am (America/New_York)', at)), '2026-10-09T13:00:00.000Z');
  assert.equal(usage.resetTime('try again in 2 hours 30 minutes', at)! - at, 9000);
  assert.equal(usage.resetTime('nothing about a reset', at), null);
});

test('DeepSeek runs keep their usage by conversation', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { readFileSync: read } = await import('node:fs');
  const { entry } = await import('../src/runtime.ts');
  const kept = path.join(tmpDir(t), usage.DSH_USAGE);
  const step = (n: number): object => ({ type: 'status', phase: 'step_end', usage: { inputTokens: 1000 * n, outputTokens: 10, cacheReadTokens: 400, cacheWriteTokens: 5 } });
  const run = (events: object[]): void => { // each run is its own process, as the start script runs it
    const done = spawnSync(process.execPath, [entry('runview'), '--usage-file', kept], { input: events.map((e) => JSON.stringify(e)).join('\n'), encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
  };
  run([{ type: 'session', sessionId: 'session-a' }, step(1), step(2), { type: 'final', text: 'hi' }]);
  run([{ type: 'session', sessionId: 'session-a' }, step(3)]); // the next run continues it
  run([{ type: 'session', sessionId: 'session-b' }, step(1)]); // Start fresh: a new conversation
  const u = usage.deepseek(kept);
  assert.deepEqual([u.tokens_in, u.tokens_cached, u.tokens_out, u.messages], [7020, 1600, 40, 4]);
  assert.deepEqual(Object.keys(JSON.parse(read(kept, 'utf8'))).sort(), ['session-a', 'session-b']);
});
