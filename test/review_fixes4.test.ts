// Problems found in a fourth review (2026-10-13), each reproduced here as it was reported: a member removed with
// a consultant attached, a restart across a team switch, a member removed while it starts, and tool calls that end
// out of order.
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';
import { Hub } from '../src/hub.ts';
import * as runview from '../src/runview.ts';
import { cleanup, FakeOpener, team, writeTeamFile } from './helpers.ts';
import { startServer } from './web.ts';

/** worker-a with a consultant helping it (summoned by tech-lead for its question). */
function withConsultant(hub: Hub): string {
  const question = hub.session('worker-a').askHelp('The parser fails on quoted fields.');
  return hub.session('tech-lead').summonConsultant(question.id, 'medium', 'Look at the CSV reader').name;
}

test('a member removed from the page takes its consultants with it, and the team stays readable', async (t) => {
  // reported: the consultant pointed at a member that was gone, and the team could no longer be read at all
  const server = await startServer(t);
  const consultant = withConsultant(server.hub);
  assert.ok(consultant in server.hub.team.roles);
  const removed = await server.ok('/api/teammate-remove', { name: 'worker-a' });
  assert.deepEqual(removed.dismissed, [consultant]);
  const state = await server.ok('/api/state');
  assert.ok(!state.roles.some((r: { name: string }) => r.name === 'worker-a' || r.name === consultant));
  assert.ok(server.hub.store.getConsultant(consultant)?.dismissed_at);
});

test('an agent letting a member go takes its consultants with it', (t) => {
  // the same through let_go_agent - where the consultant was taken for a subordinate in team.yaml, and it failed
  const file = writeTeamFile(t, { ...team(), team_changes: true });
  const hub = Hub.open(file, new FakeOpener().call);
  cleanup(t, () => hub.close());
  const consultant = withConsultant(hub);
  hub.session('tech-lead').letGo('worker-a', 'done with the parser');
  assert.ok(!('worker-a' in hub.team.roles) && !(consultant in hub.team.roles));
  assert.ok(hub.store.getConsultant(consultant)?.dismissed_at);
});

test('a restart stays in its team when another one is opened while it stops', async (t) => {
  // reported: A's agent was stopped and B's agent of the same name was started
  const other = writeTeamFile(t); // made first: removed after the server closes it
  const server = await startServer(t);
  server.app.launcher.stopRole = async () => {
    await server.ok('/api/open', { path: other }); // the owner opens another team meanwhile
    return 1;
  };
  const [status, data] = await server.request('/api/restart', { role: 'worker-a' });
  assert.ok(status === 409 && /another team was opened meanwhile/.test(data.error), JSON.stringify(data));
  assert.deepEqual(server.openedTabs, [], 'nothing started in the other team');
});

test('a member still starting in its pane is not removed', async (t) => {
  // reported: not checked in yet, it was removed while its program ran on
  const server = await startServer(t);
  server.app.inWindow = true;
  const host = server.app.terminals;
  const get = host.get.bind(host);
  host.get = (name: string) => (name === 'worker-b' ? ({ running: true, alive: true } as never) : get(name));
  const [status, data] = await server.request('/api/teammate-remove', { name: 'worker-b' });
  assert.ok(status === 400 && /program is running in its pane/.test(data.error), JSON.stringify(data));
  assert.ok('worker-b' in server.hub.team.roles);
});

test('a tool call that ends first is the one marked ended', async (t) => {
  // reported: A started, then B; B ended first, and the page said A had ended and B still ran
  const file = writeTeamFile(t);
  const events = [
    { type: 'tool_call', id: 'a', tool: 'read', input: { file_path: 'src/a.py' } },
    { type: 'tool_call', id: 'b', tool: 'read', input: { file_path: 'src/b.py' } },
    { type: 'tool_result', id: 'b', status: 'completed', result: 'ok' },
  ];
  const input = Readable.from(events.map((e) => `${JSON.stringify(e)}\n`));
  const hub = Hub.open(file);
  cleanup(t, () => hub.close());
  const seen: Record<string, boolean> = {};
  const read = () => { for (const a of hub.store.recentActions(5)['worker-a'] ?? []) seen[a.what] = a.ended_at === null; };
  // the run's end marks everything ended: look before it, from inside the run
  const out = new PassThrough();
  const done = runview.main(['--team', file, '--role', 'worker-a'], Readable.from((async function* () {
    for await (const chunk of input) yield chunk;
    await new Promise((r) => setTimeout(r, 300));
    read();
  })()), out);
  out.resume();
  await done;
  const running = Object.entries(seen).filter(([, r]) => r).map(([w]) => w);
  assert.equal(running.length, 1, JSON.stringify(seen));
  assert.match(running[0], /a\.py/);
});
