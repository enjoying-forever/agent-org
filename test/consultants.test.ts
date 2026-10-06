import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { roleCard } from '../src/cards.ts';
import { Hub, HubError, LockConflict, PermissionDenied } from '../src/hub.ts';
import { Store } from '../src/store.ts';
import { makeHub, raises, rejects } from './helpers.ts';

/** worker-a asks tech-lead for help; tech-lead attaches a 'medium' consultant. */
function summoned(t: TestContext) {
  const made = makeHub(t);
  const request = made.hub.session('worker-a').askHelp('tests fail on Windows paths');
  const role = made.hub.session('tech-lead').summonConsultant(request.id, 'medium', 'look at path joining');
  return { ...made, request, role };
}

// summoning

test('a consultant joins the tree under the agent it helps', (t) => {
  const { hub, role, opener } = summoned(t);
  assert.deepEqual([role.name, role.superior, role.tier], ['consultant-1', 'worker-a', 'medium']);
  assert.deepEqual([role.harness, role.model, role.effort], ['claude', 'claude-opus-5-5', 'medium']);
  assert.deepEqual(opener.opened, ['consultant-1']);
  const team = hub.team;
  assert.deepEqual(team.subordinatesOf('worker-a'), ['consultant-1']);
  assert.ok(team.subtreeOf('leader').includes('consultant-1'));
  assert.ok(team.treeLines().some((l) => l.includes('consultant-1  [claude / claude-opus-5-5]  (consultant, medium)')));
});

test('a consultant gets the request and the brief, and the helped agent is told', (t) => {
  const { hub, request } = summoned(t);
  const [task] = hub.session('consultant-1').readInbox();
  assert.ok(task.sender === 'tech-lead' && task.reply_to === request.id);
  assert.ok(task.text.includes('tests fail on Windows paths') && task.text.includes('look at path joining'));
  const [notice] = hub.session('worker-a').readInbox();
  assert.ok(notice.text.includes('consultant-1') && notice.text.includes('hand_over_file'));
});

test('only the superior who got the request can summon', (t) => {
  const { hub } = makeHub(t);
  const request = hub.session('worker-a').askHelp('help');
  for (const other of ['leader', 'worker-b', 'worker-a']) {
    raises(() => hub.session(other).summonConsultant(request.id, 'medium'), PermissionDenied, 'not a help request sent to you');
  }
  const report = hub.session('worker-a').send('tech-lead', 'just a report');
  raises(() => hub.session('tech-lead').summonConsultant(report.id, 'medium'), PermissionDenied, 'not a help request');
});

test('the owner can summon for the leader', (t) => {
  const { hub } = makeHub(t);
  const request = hub.session('leader').askHelp('which architecture?');
  assert.equal(hub.session('you').summonConsultant(request.id, 'high').superior, 'leader');
});

test('an unknown tier is refused', (t) => {
  const { hub } = makeHub(t);
  const request = hub.session('worker-a').askHelp('help');
  raises(() => hub.session('tech-lead').summonConsultant(request.id, 'max'), HubError, "no consultant tier 'max'. Tiers: medium, high");
});

test('max_active per tier', (t) => {
  const { hub } = makeHub(t);
  const lead = hub.session('tech-lead');
  const first = hub.session('worker-a').askHelp('one');
  const second = hub.session('worker-b').askHelp('two');
  lead.summonConsultant(first.id, 'high');
  raises(() => lead.summonConsultant(second.id, 'high'), HubError, "all 1 'high' consultants are busy");
  lead.summonConsultant(second.id, 'medium'); // another tier still has room
  hub.session('worker-a').dismissConsultant('consultant-1');
  const third = hub.session('worker-a').askHelp('three');
  assert.equal(lead.summonConsultant(third.id, 'high').name, 'consultant-3'); // room again
});

test('one consultant per request', (t) => {
  const { hub, request } = summoned(t);
  raises(() => hub.session('tech-lead').summonConsultant(request.id, 'high'), HubError, 'already working on');
});

test('consultants cannot get consultants', (t) => {
  const { hub } = summoned(t);
  const question = hub.session('consultant-1').askHelp('what is the expected output?');
  assert.equal(question.recipient, 'worker-a');
  raises(() => hub.session('worker-a').summonConsultant(question.id, 'medium'), PermissionDenied, 'cannot get consultants of their own');
});

test('a failed tab leaves no consultant behind', (t) => {
  const { hub, opener } = makeHub(t);
  opener.fail = true;
  const request = hub.session('worker-a').askHelp('help');
  raises(() => hub.session('tech-lead').summonConsultant(request.id, 'medium'), HubError, 'could not start consultant-1: no terminal');
  assert.deepEqual(hub.team.subordinatesOf('worker-a'), []);
  assert.deepEqual(hub.session('worker-a').readInbox(), []);
});

// talking

test('a consultant talks only with the agent it helps', (t) => {
  const { hub } = summoned(t);
  const consultant = hub.session('consultant-1');
  assert.equal(consultant.send('worker-a', 'found it').kind, 'report');
  for (const other of ['tech-lead', 'leader', 'worker-b']) raises(() => consultant.send(other, 'hi'), PermissionDenied, 'You can message: worker-a.');
  assert.equal(hub.session('worker-a').send('consultant-1', 'try this').kind, 'instruction');
  // and everyone above can reach and look at it, like any role in their subtree
  assert.equal(hub.session('leader').send('consultant-1', 'keep it short').kind, 'instruction');
  assert.equal(hub.session('tech-lead').view('consultant-1').superior, 'worker-a');
  // worker-b sees it in the team, but not its messages, and cannot message it
  assert.ok(hub.session('worker-b').view('consultant-1').limited);
  raises(() => hub.session('worker-b').send('consultant-1', 'hi'), PermissionDenied, 'You can message: tech-lead, worker-a.');
});

test('role cards', (t) => {
  const { hub } = summoned(t);
  const card = roleCard(hub.session('consultant-1'));
  assert.ok(card.includes('temporary medium consultant'));
  assert.ok(card.includes('tech-lead summoned you to help worker-a with its help request #1'));
  assert.ok(card.includes('You can message only worker-a'));
  const leadCard = roleCard(hub.session('tech-lead'));
  assert.ok(leadCard.includes('summon_consultant(help_id, tier, brief)'));
  assert.ok(leadCard.includes('high (codex / gpt-6-luna, high effort, up to 1 at once): tricky bugs and failing tests'));
  assert.ok(!roleCard(hub.session('worker-a')).includes('summon_consultant'));
});

// files

test('a consultant edits only files handed to it', (t) => {
  const { hub } = summoned(t);
  const worker = hub.session('worker-a');
  const consultant = hub.session('consultant-1');
  raises(() => consultant.claim('src/paths.py'), PermissionDenied, 'consultants can only edit files handed to them');
  worker.claim('src/paths.py');
  assert.equal(worker.handOver('src/paths.py', 'consultant-1').owner, 'consultant-1');
  assert.ok(consultant.canWrite('src/paths.py') && !worker.canWrite('src/paths.py'));
  assert.ok(consultant.readInbox().some((m) => m.text.includes('I handed src/paths.py over to you')));
  raises(() => worker.claim('src/paths.py'), LockConflict, 'being written by consultant-1');
  assert.equal(consultant.handOver('src/paths.py', 'worker-a').owner, 'worker-a');
});

test("a consultant's release hands the file back", (t) => {
  const { hub } = summoned(t);
  const worker = hub.session('worker-a');
  worker.claim('tests/test_paths.py');
  worker.handOver('tests/test_paths.py', 'consultant-1');
  assert.equal(hub.session('consultant-1').release('tests/test_paths.py').owner, 'worker-a');
  assert.ok(worker.canWrite('tests/test_paths.py'));
});

test('hand-over rules', (t) => {
  const { hub } = makeHub(t);
  const worker = hub.session('worker-a');
  const lead = hub.session('tech-lead');
  raises(() => worker.handOver('src/a.py', 'tech-lead'), HubError, 'you do not hold src/a.py');
  worker.claim('src/a.py');
  raises(() => worker.handOver('src/a.py', 'worker-b'), PermissionDenied, 'direct superior or a direct subordinate'); // sibling
  raises(() => worker.handOver('src/a.py', 'leader'), PermissionDenied, 'direct superior or a direct subordinate'); // two up
  assert.equal(worker.handOver('src/a.py', 'tech-lead').owner, 'tech-lead');
  worker.claim('tests/b.py');
  raises(() => worker.handOver('tests/b.py', 'tech-lead'), PermissionDenied, "outside tech-lead's write scope");
  assert.equal(lead.handOver('src/a.py', 'worker-a').owner, 'worker-a');
});

// dismissing

test('dismissal returns files and ends the consultant', (t) => {
  const { hub } = summoned(t);
  const worker = hub.session('worker-a');
  worker.claim('src/paths.py');
  worker.handOver('src/paths.py', 'consultant-1');
  const consultant = hub.session('consultant-1');
  const [role, returned] = worker.dismissConsultant('consultant-1');
  assert.deepEqual([role.name, returned], ['consultant-1', ['src/paths.py']]);
  assert.ok(worker.canWrite('src/paths.py'));
  assert.deepEqual(hub.team.subordinatesOf('worker-a'), []);
  for (const action of [() => consultant.readInbox(), () => consultant.send('worker-a', 'hi'), () => consultant.setStatus('working')]) {
    raises(action, PermissionDenied, 'you were dismissed by worker-a');
  }
});

test('a waiting consultant learns it was dismissed', async (t) => {
  const { hub } = summoned(t);
  const consultant = hub.session('consultant-1');
  consultant.readInbox();
  setTimeout(() => {
    const other = new Hub(hub.baseTeam, new Store(hub.baseTeam.database)); // another agent's process
    other.session('worker-a').dismissConsultant('consultant-1');
    other.close();
  }, 300);
  await rejects(() => consultant.waitForMessages(5, 0.05), PermissionDenied, 'dismissed');
});

test('who can dismiss', (t) => {
  const { hub } = summoned(t);
  raises(() => hub.session('worker-b').dismissConsultant('consultant-1'), PermissionDenied, 'only worker-a, or someone above it');
  raises(() => hub.session('consultant-1').dismissConsultant('consultant-1'), PermissionDenied);
  raises(() => hub.session('tech-lead').dismissConsultant('worker-a'), HubError, 'not an active consultant');
  hub.session('worker-a').readInbox();
  hub.session('leader').dismissConsultant('consultant-1'); // from above: worker-a is told
  const [notice] = hub.session('worker-a').readInbox();
  assert.equal(notice.text, 'I dismissed consultant-1.');
});
