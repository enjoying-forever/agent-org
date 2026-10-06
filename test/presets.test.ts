// Role presets: keep a role's settings once, reuse them in any team.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { roleCard } from '../src/cards.ts';
import { Hub, HubError } from '../src/hub.ts';
import * as presets from '../src/presets.ts';
import { parseYaml } from '../src/team.ts';
import { cleanup, FakeOpener, freshHome, raises, writeTeamFile } from './helpers.ts';

Hub.RELOAD_EVERY = 0;

test('ready-made presets are listed', (t) => {
  freshHome(t);
  const ids = new Set(presets.catalogue().map((p) => p.id));
  for (const id of ['planner', 'coder', 'reviewer', 'tester', 'researcher', 'gemini-coder']) assert.ok(ids.has(id));
  const reviewer = presets.get('reviewer');
  assert.ok(reviewer.harness === 'claude' && JSON.stringify(reviewer.write_scope) === '["reviews/*"]' && reviewer.instructions);
});

test('save, use and delete your own', (t) => {
  freshHome(t);
  const preset = presets.save('My Tester!', { harness: 'codex', model: 'gpt-6-luna', duties: 'Test it.', instructions: 'Be thorough.',
    write_scope: ['tests/*'], superior: 'ignored' });
  assert.equal(preset, 'my:my-tester');
  assert.deepEqual(presets.get(preset), { harness: 'codex', model: 'gpt-6-luna', duties: 'Test it.', instructions: 'Be thorough.', write_scope: ['tests/*'] });
  assert.ok(presets.catalogue()[0].mine); // yours come first
  presets.remove(preset);
  raises(() => presets.get(preset), presets.KeyError);
  raises(() => presets.save('x', { duties: 'no program' }), presets.RoleError);
});

test('ready-made roles can be edited, reset, deleted and restored', (t) => {
  freshHome(t);
  assert.equal(presets.save('Reviewer', { title: 'Reviewer', harness: 'codex', model: 'gpt-6-luna' }, 'reviewer'), 'reviewer'); // the id stays
  const card = presets.catalogue().find((p) => p.id === 'reviewer')!;
  assert.deepEqual([card.harness, card.model, card.edited, card.mine], ['codex', 'gpt-6-luna', true, false]);
  assert.equal(presets.get('reviewer').model, 'gpt-6-luna');
  presets.reset('reviewer');
  assert.equal(presets.get('reviewer').model, 'claude-sonnet-5-5');
  assert.ok(!presets.catalogue().find((p) => p.id === 'reviewer')!.edited);

  presets.remove('reviewer');
  assert.ok(!presets.names().includes('reviewer'));
  assert.deepEqual(presets.hidden(), ['reviewer']);
  raises(() => presets.get('reviewer'), presets.KeyError);
  raises(() => presets.remove('reviewer'), presets.KeyError);
  raises(() => presets.save('Reviewer', { title: 'Reviewer', harness: 'claude' }, 'reviewer'), presets.RoleError);
  assert.deepEqual(presets.restore(), ['reviewer']);
  assert.ok(presets.names().includes('reviewer'));
  assert.deepEqual(presets.restore(), []);
  raises(() => presets.reset('my:nothing'), presets.KeyError);
});

test('hiring from a preset', (t) => {
  freshHome(t);
  const file = writeTeamFile(t);
  const hub = Hub.open(file, new FakeOpener().call);
  cleanup(t, () => hub.close());
  const role = hub.session('leader').hire('rev', { preset: 'reviewer', write_scope: ['docs/*'] });
  assert.deepEqual([role.harness, role.model], ['claude', 'claude-sonnet-5-5']);
  assert.deepEqual([...role.write_scope], ['docs/*']); // what you give overrides the preset
  const roles = (parseYaml(readFileSync(file, 'utf8')) as { roles: Record<string, { instructions: string }> }).roles;
  assert.ok(roles.rev.instructions.includes('reviews/task-<number>.md'));
  raises(() => hub.session('leader').hire('x', { preset: 'nope' }), HubError, "no role preset 'nope'");
});

test('instructions reach the agent', (t) => {
  freshHome(t);
  const hub = Hub.open(writeTeamFile(t), new FakeOpener().call);
  cleanup(t, () => hub.close());
  hub.session('leader').hire('helper', { harness: 'claude', duties: 'Help out.', instructions: 'Answer in English. Keep it short.' });
  const card = roleCard(hub.session('helper'));
  assert.ok(card.includes('Your instructions (from the owner):') && card.includes('Keep it short.'));
});
