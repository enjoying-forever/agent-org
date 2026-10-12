// Problems found in a third review (2026-10-13), each reproduced here as it was reported: a part that waits for
// what it is part of, and a split task moved to a peer of its manager.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HubError } from '../src/hub.ts';
import { makeHub, raises } from './helpers.ts';

test('a part may not wait for the task it is part of, nor for anything that waits for it', (t) => {
  // reported: part_of=#1 with after=[#1] - the part waited for #1, and #1 for the part, for ever
  const { hub } = makeHub(t);
  const lead = hub.session('leader');
  const big = lead.assignTask('tech-lead', 'Build the shop');
  const tech = hub.session('tech-lead');
  tech.readInbox();
  raises(() => tech.assignTask('worker-a', 'The cart', '', big.id, '', [big.id]), HubError, 'would wait for ever: #');
  // through another task: the review waits for the big one, and the part for the review
  const review = lead.assignTask('researcher', 'Review the shop', '', null, '', [big.id]);
  raises(() => tech.assignTask('worker-a', 'The cart', '', big.id, '', [review.id]), HubError, `#${review.id} waits for #${big.id}`);
  // the parts may wait for each other
  const cart = tech.assignTask('worker-a', 'The cart', '', big.id);
  const pay = tech.assignTask('worker-b', 'Payment', '', big.id, '', [cart.id]);
  assert.deepEqual(pay.depends_on, [cart.id]);
});

test('a split task moved to a peer of its manager takes its parts along', async (t) => {
  // reported: moved from A to its peer B, the parts stayed A's: B could not review or cancel them, nor finish
  const config = {
    owner: 'you', project_root: 'project', roles: {
      leader: { superior: 'you', harness: 'claude' },
      'lead-a': { superior: 'leader', harness: 'claude' }, 'lead-b': { superior: 'leader', harness: 'claude' },
      'worker-a': { superior: 'lead-a', harness: 'codex', write_scope: ['src/*'] },
    },
  };
  const { hub } = makeHub(t, config);
  const big = hub.session('leader').assignTask('lead-a', 'Build the shop');
  const a = hub.session('lead-a');
  a.readInbox();
  const part = a.assignTask('worker-a', 'The cart', '', big.id);
  hub.session('worker-a').readInbox();
  hub.session('leader').reassignTask(big.id, 'lead-b', 'lead-a is out of its usage');
  assert.equal(hub.store.getTask(part.id)?.assigner, 'lead-b');
  const b = hub.session('lead-b');
  const told = b.readInbox().map((m) => m.text).join('\n');
  assert.ok(told.includes(`#${part.id} [working] worker-a: The cart`), told);
  await hub.session('worker-a').finishTask(part.id, 'Cart done.', 'done');
  assert.ok(b.readInbox().some((m) => m.text.includes(`Task #${part.id} is DONE`)), 'its result goes to the new owner');
  b.reviewTask(part.id, true);
  assert.equal((await b.finishTask(big.id, 'The shop is built.', 'done')).state, 'done');
});
