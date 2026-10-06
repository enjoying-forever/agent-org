import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { Team, TeamError } from '../src/team.ts';
import { makeTeam, raises, team as example, tmpDir } from './helpers.ts';

const EXAMPLE = path.resolve(import.meta.dirname, '..', 'team.example.yaml');

function build(dir: string, changes: Record<string, Record<string, unknown> | null>): Team {
  const data = example() as { roles: Record<string, Record<string, unknown>> };
  for (const [role, spec] of Object.entries(changes)) {
    if (spec === null) delete data.roles[role];
    else data.roles[role] = { ...(data.roles[role] ?? {}), ...spec };
  }
  return Team.fromDict(data, dir);
}

test('the example file is valid', () => {
  const team = Team.load(EXAMPLE);
  assert.equal(team.leader, 'leader');
  assert.equal(team.roles['worker-b'].harness, 'antigravity');
});

test('tree queries', (t) => {
  const { team } = makeTeam(t);
  assert.equal(team.leader, 'leader');
  assert.equal(team.superiorOf('worker-a'), 'tech-lead');
  assert.equal(team.superiorOf('you'), null);
  assert.deepEqual(team.subordinatesOf('leader'), ['tech-lead', 'researcher']);
  assert.deepEqual(team.subtreeOf('leader'), ['tech-lead', 'researcher', 'worker-a', 'worker-b']);
  assert.deepEqual(team.subtreeOf('worker-a'), []);
  assert.deepEqual(team.chainOf('worker-b'), ['tech-lead', 'leader', 'you']);
  assert.ok(team.isAbove('leader', 'worker-a'));
  assert.ok(!team.isAbove('worker-a', 'leader'));
  assert.ok(!team.isAbove('researcher', 'worker-a'));
});

test('tree lines', (t) => {
  const lines = makeTeam(t).team.treeLines();
  assert.equal(lines[0], 'you (owner)');
  assert.equal(lines[1], '└── leader  [claude]');
  assert.ok(lines.some((l) => l.includes('worker-b  [antigravity]')));
});

test('paths are relative to the team file', (t) => {
  const { team, dir } = makeTeam(t);
  assert.equal(team.project_root, path.resolve(dir, 'project'));
  assert.equal(team.database, path.resolve(dir, '.agent-org', 'hub.db'));
});

const INVALID: [Record<string, Record<string, unknown> | null>, string][] = [
  [{ 'worker-a': { superior: 'nobody' } }, 'is not a role or the owner'],
  [{ 'worker-a': { superior: 'worker-a' } }, 'own superior'],
  [{ leader: { superior: 'worker-a' } }, 'loops back'],
  [{ researcher: { superior: 'you' } }, 'exactly one role must report to the owner'],
  [{ 'worker-a': { harness: 'gpt' } }, "'harness' must be one of"],
  [{ 'worker-a': { write_scope: 'src/*' } }, 'must be a list'],
  [{ 'worker-a': { colour: 'red' } }, 'unknown keys'],
  [{ you: { superior: 'leader', harness: 'claude' } }, 'cannot also be a role'],
  [{ 'bad name!': { superior: 'leader', harness: 'claude' } }, 'invalid role name'],
];

for (const [changes, error] of INVALID) {
  test(`an invalid team is rejected: ${error}`, (t) => {
    raises(() => build(tmpDir(t), changes), TeamError, error);
  });
}

test('consultant tiers are parsed', (t) => {
  const { team } = makeTeam(t);
  const medium = team.tiers.medium;
  assert.deepEqual([medium.harness, medium.model, medium.effort, medium.max_active], ['claude', 'claude-opus-5-5', 'medium', 2]);
  assert.equal(team.tiers.high.max_active, 1); // the default
  assert.ok(team.canSummon('tech-lead') && team.canSummon('you'));
  assert.ok(!team.canSummon('worker-a'));
});

const BAD_TIERS: [Record<string, unknown>, string][] = [
  [{ harness: 'gpt' }, "'harness' must be one of"],
  [{ harness: 'claude', max_active: 0 }, 'at least 1'],
  [{ harness: 'claude', max_active: true }, 'at least 1'],
  [{ harness: 'claude', budget: 5 }, 'unknown keys'],
];

for (const [tier, error] of BAD_TIERS) {
  test(`an invalid tier is rejected: ${error}`, (t) => {
    const data = example() as { consultants: Record<string, unknown> };
    data.consultants.bad = tier;
    raises(() => Team.fromDict(data, tmpDir(t)), TeamError, error);
  });
}

test('consultant names are reserved', (t) => {
  raises(() => build(tmpDir(t), { 'consultant-9': { superior: 'leader', harness: 'claude' } }), TeamError, 'kept for consultants');
});

test('a missing project_root is rejected', (t) => {
  const data = example() as Record<string, unknown>;
  delete data.project_root;
  raises(() => Team.fromDict(data, tmpDir(t)), TeamError, 'project_root');
});
