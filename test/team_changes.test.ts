// Managers change the team while it runs: hire, change and let go of agents below them.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { Hub, HubError, PermissionDenied } from '../src/hub.ts';
import { dumpYaml, parseYaml } from '../src/team.ts';
import { cleanup, FakeOpener, raises, writeTeamFile } from './helpers.ts';

Hub.RELOAD_EVERY = 0; // every change to team.yaml is seen at once

function setup(t: TestContext) {
  const file = writeTeamFile(t);
  const opener = new FakeOpener();
  const stopped: string[] = [];
  const hub = Hub.open(file, opener.call, (role) => stopped.push(role));
  cleanup(t, () => hub.close());
  return { hub, file, opener, stopped };
}

const config = (file: string): Record<string, any> => parseYaml(readFileSync(file, 'utf8')) as Record<string, any>;
const rolesIn = (file: string): Record<string, any> => config(file).roles;
function edit(file: string, change: (c: Record<string, any>) => void): void {
  const c = config(file);
  change(c);
  writeFileSync(file, dumpYaml(c), 'utf8');
}

test('a manager hires an agent that starts at once', (t) => {
  const { hub, file, opener } = setup(t);
  const role = hub.session('tech-lead').hire('tester', { harness: 'claude', duties: 'Write and run the tests.', model: 'sonnet', write_scope: ['src/tests/*'] });
  assert.deepEqual([role.superior, role.harness, role.model, [...role.write_scope]], ['tech-lead', 'claude', 'sonnet', ['src/tests/*']]);
  assert.equal(rolesIn(file).tester.superior, 'tech-lead'); // saved in team.yaml
  assert.deepEqual(opener.opened, ['tester']);
  const [told] = hub.session('you').readInbox();
  assert.ok(told.text.includes('Team change by tech-lead: hired tester'));
  hub.session('tech-lead').assignTask('tester', 'Test the parser'); // usable straight away
});

test('every other process sees the change', (t) => {
  const { hub, file } = setup(t);
  const other = Hub.open(file);
  try {
    assert.ok(!('tester' in other.team.roles));
    hub.session('leader').hire('tester', { harness: 'codex', duties: 'Tests.' });
    assert.equal(other.team.roles.tester.harness, 'codex'); // reloaded from team.yaml
  } finally {
    other.close();
  }
});

test('hiring only below yourself', (t) => {
  const { hub } = setup(t);
  raises(() => hub.session('worker-a').hire('helper', { harness: 'claude', duties: 'Help.', superior: 'leader' }), PermissionDenied, 'under yourself or someone below you');
  raises(() => hub.session('leader').hire('worker-b', { harness: 'claude', duties: 'Again.' }), HubError, "already a 'worker-b'");
  raises(() => hub.session('leader').hire('helper', { harness: 'zcode', duties: 'Help.' }), HubError, 'harness must be one of');
  raises(() => hub.session('leader').hire('consultant-x', { harness: 'claude', duties: 'Help.' }), HubError, 'simple name');
  hub.session('leader').hire('helper', { harness: 'grok', duties: 'Research.', superior: 'tech-lead' }); // below the leader: fine
});

test('the owner can turn team changes off', (t) => {
  const { hub, file } = setup(t);
  edit(file, (c) => { c.team_changes = false; });
  raises(() => hub.session('leader').hire('helper', { harness: 'claude', duties: 'Help.' }), PermissionDenied, 'turned team changes off');
});

test('changing an agent below you', async (t) => {
  const { hub, file } = setup(t);
  const lead = hub.session('tech-lead');
  const role = lead.changeRole('worker-a', { duties: 'Only the API.', model: 'gpt-6-luna', write_scope: ['src/api/*'] });
  assert.deepEqual([role.duties, role.model, [...role.write_scope]], ['Only the API.', 'gpt-6-luna', ['src/api/*']]);
  assert.deepEqual(rolesIn(file)['worker-a'].write_scope, ['src/api/*']);
  const worker = hub.session('worker-a');
  // it is told, without being woken for it: the news comes with its next real message
  assert.ok(hub.store.unreadCount('worker-a', true) === 0 && hub.store.unreadSince()['worker-a'] === undefined);
  assert.deepEqual(await worker.waitForMessages(0.05, 0.01), []); // a note alone does not end a wait
  lead.send('worker-a', 'Start on the API.');
  const [told, work] = await worker.waitForMessages(1, 0.01);
  assert.ok(told.kind === 'note' && work.text === 'Start on the API.' && told.text.includes('changed your role'));
  raises(() => lead.changeRole('leader', { duties: 'x' }), PermissionDenied); // not below it
  raises(() => lead.changeRole('worker-a', { superior: 'researcher' }), PermissionDenied, 'only move under you');
  raises(() => lead.changeRole('worker-a'), HubError, 'say what to change');
});

test('letting go of an agent', (t) => {
  const { hub, file, stopped } = setup(t);
  const leader = hub.session('leader');
  const task = hub.session('tech-lead').assignTask('worker-a', 'Build it');
  hub.session('worker-a').claim('src/a.py');
  raises(() => hub.session('tech-lead').letGo('worker-a'), HubError, 'unfinished tasks');
  hub.session('tech-lead').cancelTask(task.id);
  assert.deepEqual(hub.session('tech-lead').letGo('worker-a', 'the work is done'), []);
  assert.ok(!('worker-a' in rolesIn(file)));
  assert.deepEqual(stopped, ['worker-a']);
  assert.deepEqual(hub.store.locks('worker-a'), []); // its files are free again
  const moved = leader.letGo('tech-lead'); // a manager: its people move up
  assert.ok(moved.length === 1 && moved[0] === 'worker-b' && rolesIn(file)['worker-b'].superior === 'leader');
  raises(() => leader.letGo('leader'), PermissionDenied);
});

test('a manager cannot give more than it has', (t) => {
  const { hub } = setup(t);
  const lead = hub.session('tech-lead'); // may write src/* only
  raises(() => lead.hire('tester', { harness: 'claude', duties: 'Tests.', write_scope: ['tests/*'] }), PermissionDenied, 'beyond your own scope');
  raises(() => lead.changeRole('worker-a', { write_scope: ['*'] }), PermissionDenied, 'beyond your own scope');
  lead.changeRole('worker-a', { write_scope: ['src/api/*'] }); // narrower: fine
});

test('the team cannot grow past its limit', (t) => {
  const { hub, file } = setup(t);
  edit(file, (c) => { c.max_agents = Object.keys(c.roles).length + 1; });
  hub.session('leader').hire('one-more', { harness: 'claude', duties: 'Help.' });
  raises(() => hub.session('leader').hire('too-many', { harness: 'claude', duties: 'Help.' }), HubError, 'the most the owner allows');
});

test('a hire waits when the running limit is reached', (t) => {
  const { hub, file, opener } = setup(t);
  edit(file, (c) => { c.max_running = 1; });
  hub.store.checkIn(4242, 'leader');
  hub.session('leader').hire('helper', { harness: 'claude', duties: 'Help.' });
  assert.deepEqual(opener.opened, []); // hired, but not started past the limit
});

test('no Claude Haiku agent that would ask the owner at every step', (t) => {
  const { hub, file, opener } = setup(t);
  const lead = hub.session('tech-lead');
  // seen: a Claude Haiku worker (no auto mode) sat at "Do you want to create greet.py?"
  raises(() => lead.hire('tester', { harness: 'claude', duties: 'Write the tests.', model: 'haiku' }), HubError, 'no auto mode');
  lead.hire('tester', { harness: 'claude', duties: 'Write the tests.', model: 'sonnet' });
  raises(() => lead.changeRole('tester', { model: 'claude-haiku-4-5' }), HubError, 'no auto mode');
  lead.hire('cheap', { harness: 'codex', duties: 'Small chores.', model: 'haiku-like-name' }); // other programs: their own rules
  assert.ok('tester' in rolesIn(file));
  assert.deepEqual(opener.opened, ['tester', 'cheap']);
});
