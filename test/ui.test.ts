// The owner's page: its API, the welcome page, the team editor and the Role Market.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as doctor from '../src/doctor.ts';
import { lookup } from '../src/runtime.ts';
import { parseYaml, Team } from '../src/team.ts';
import * as templates from '../src/templates.ts';
import * as ui from '../src/ui.ts';
import * as sessions from '../src/sessions.ts';
import * as usage from '../src/usage.ts';
import * as watchdog from '../src/watchdog.ts';
import { cleanup, freshHome, raises, rejects, TEAM, tmpDir } from './helpers.ts';
import { startServer } from './web.ts';

test('the API needs the token', async (t) => {
  const server = await startServer(t);
  assert.equal((await server.request('/api/state', undefined, { token: null }))[0], 403);
  assert.equal((await server.request('/api/state', undefined, { token: 'wrong' }))[0], 403);
  assert.equal((await server.request('/api/send', { to: 'leader', text: 'hi' }, { token: null }))[0], 403);
  assert.equal((await server.request('/api/state'))[0], 200);
});

test('other host names are refused', async (t) => {
  const server = await startServer(t);
  assert.equal((await server.request('/api/state', undefined, { host: 'evil.example:80' }))[0], 403);
  assert.equal((await server.request('/', undefined, { host: 'evil.example:80' }))[0], 403);
});

test('the page and its static files', async (t) => {
  const server = await startServer(t);
  let [status, page] = await server.request('/', undefined, { token: null });
  assert.ok(status === 200 && page.includes('<title>agent-org</title>'));
  [status, page] = await server.request('/static/app.js', undefined, { token: null });
  assert.ok(status === 200 && page.includes('function h('));
  assert.equal((await server.request('/static/../ui.py', undefined, { token: null }))[0], 404);
  assert.equal((await server.request('/static/%2e%2e%5cui.py', undefined, { token: null }))[0], 404);
  assert.equal((await server.request('/static/missing.css', undefined, { token: null }))[0], 404);
});

test('the state lists the tree', async (t) => {
  const state = await (await startServer(t)).ok('/api/state');
  assert.ok(state.owner === 'you' && state.leader === 'leader');
  assert.deepEqual(state.roles.map((r: any) => r.name), ['leader', 'tech-lead', 'researcher', 'worker-a', 'worker-b']);
  assert.deepEqual(state.tiers.map((x: any) => x.name), ['medium', 'high']);
  assert.deepEqual(state.launchable, ['claude', 'codex', 'grok', 'antigravity', 'deepseek']);
});

test("the owner's messages and inbox", async (t) => {
  const server = await startServer(t);
  const [sent] = (await server.ok('/api/send', { to: 'worker-b', text: '你好, please write tests' })).sent;
  assert.deepEqual([sent.sender, sent.kind], ['you', 'instruction']);
  server.hub.session('leader').send('you', 'plan is ready');
  const messages = (await server.ok('/api/messages?after=0')).messages;
  assert.deepEqual(messages.map((m: any) => m.text), ['你好, please write tests', 'plan is ready']);
  assert.equal((await server.ok(`/api/messages?after=${messages[0].id}`)).messages[0].text, 'plan is ready');
  assert.equal((await server.ok('/api/state')).owner_unread, 1);
  assert.deepEqual((await server.ok('/api/inbox/read', {})).messages.map((m: any) => m.text), ['plan is ready']);
  assert.equal((await server.ok('/api/state')).owner_unread, 0);
});

test('refusals come back as errors', async (t) => {
  const server = await startServer(t);
  let [status, data] = await server.request('/api/send', { to: 'ghost', text: 'hi' });
  assert.ok(status === 409 && data.error.includes('not in this team'), data.error);
  [status, data] = await server.request('/api/send', { to: 'leader' });
  assert.ok(status === 400 && data.error.includes("'text' is required"));
  assert.equal((await server.request('/api/nothing'))[0], 404);
  assert.equal((await server.request('/api/task?id=seven'))[0], 400);
});

test('summon and dismiss a consultant for the leader', async (t) => {
  const server = await startServer(t);
  const request = server.hub.session('leader').askHelp('which database should we use?');
  assert.deepEqual(await server.ok('/api/summon', { help_id: request.id, tier: 'high', brief: 'we need SQL' }),
    { name: 'consultant-1', tier: 'high', superior: 'leader' });
  assert.deepEqual(server.opener.opened, ['consultant-1']);
  const role = (await server.ok('/api/state')).roles.find((r: any) => r.name === 'consultant-1');
  assert.deepEqual([role.tier, role.help_id, role.superior], ['high', request.id, 'leader']);
  assert.deepEqual(await server.ok('/api/dismiss', { name: 'consultant-1' }), { name: 'consultant-1', returned: [] });
});

test('release a lock', async (t) => {
  const server = await startServer(t);
  server.hub.session('worker-a').claim('src/app.py');
  assert.equal((await server.ok('/api/state')).locks[0].owner, 'worker-a');
  assert.equal((await server.ok('/api/release', { path: 'src/app.py' })).path, 'src/app.py');
  assert.deepEqual((await server.ok('/api/state')).locks, []);
});

test('the state shows who is running', async (t) => {
  const server = await startServer(t);
  server.hub.store.checkIn(process.pid, 'tech-lead'); // two live processes
  server.hub.store.checkIn(process.ppid, 'tech-lead');
  server.hub.store.checkIn(99999999, 'researcher'); // gone without checking out (killed with its terminal)
  const online = Object.fromEntries((await server.ok('/api/state')).roles.map((r: any) => [r.name, r.online]));
  assert.deepEqual(online, { leader: 0, 'tech-lead': 2, researcher: 0, 'worker-a': 0, 'worker-b': 0 });
});

const titles = (tabs: string[][]): string[] => tabs.map((tab) => tab[tab.indexOf('--title') + 1]);

test('launch skips running roles unless forced', async (t) => {
  const server = await startServer(t);
  server.hub.store.checkIn(21, 'leader');
  const result = await server.ok('/api/launch', { roles: ['leader', 'worker-a'] });
  assert.deepEqual([result.opening, result.skipped], [['worker-a'], ['leader: already running']]);
  assert.deepEqual((await server.ok('/api/launch', { roles: ['leader'], force: true })).opening, ['leader']);
});

test('launch opens tabs for supported roles', async (t) => {
  const server = await startServer(t);
  const result = await server.ok('/api/launch', {});
  assert.deepEqual(result.opening, ['leader', 'tech-lead', 'worker-a', 'worker-b', 'researcher']);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual((await server.ok('/api/launch', { roles: ['worker-a'] })).opening, ['worker-a']);
  assert.equal((await server.request('/api/launch', { roles: ['ghost'] }))[0], 400);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(titles(server.openedTabs).includes('leader')); // opened in the background
});

test('the team editor round trip', async (t) => {
  const server = await startServer(t);
  const data = await server.ok('/api/team');
  assert.equal(data.config.owner, 'you');
  assert.deepEqual(data.harnesses, ['claude', 'codex', 'grok', 'antigravity', 'deepseek']);
  const config = data.config;
  config.roles['worker-c'] = { superior: 'tech-lead', harness: 'codex', write_scope: ['docs/*'] };
  const saved = await server.ok('/api/team', { config });
  assert.ok(saved.backup.endsWith('team.yaml.bak'));
  assert.ok('worker-c' in server.config().roles);
  assert.ok((await server.ok('/api/state')).roles.some((r: any) => r.name === 'worker-c'));
  assert.equal(server.hub.session('tech-lead').send('worker-c', 'hello').kind, 'instruction'); // the hub applies the new tree straight away
});

test('an invalid team is not saved', async (t) => {
  const server = await startServer(t);
  const config = (await server.ok('/api/team')).config;
  const before = readFileSync(server.teamFile, 'utf8');
  config.roles.researcher.superior = 'you'; // a second leader
  const [status, data] = await server.request('/api/team', { config });
  assert.ok(status === 400 && data.error.includes('exactly one role must report to the owner'), data.error);
  assert.equal(readFileSync(server.teamFile, 'utf8'), before);
});

test('model output parsers', () => {
  assert.deepEqual(ui.parseGrok('Default model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n'), ['grok-4.7', 'grok-4.6']);
  assert.deepEqual(ui.parseAgy('Fetching...\ngemini-3.8-flash-high\tGemini\nclaude-opus-4-6\tClaude\n'), ['gemini-3.8-flash-high', 'claude-opus-4-6']);
  assert.deepEqual(ui.parseCodex('{"models": [{"slug": "gpt-6-luna"}, {"id": "gpt-6-sol"}]}'), ['gpt-6-luna', 'gpt-6-sol']);
});

// the message law from the page

test('the owner gives tasks and sees them', async (t) => {
  const server = await startServer(t);
  const task = await server.ok('/api/task', { to: 'leader', title: 'Build a todo app', details: 'CLI, JSON file' });
  assert.deepEqual([task.assignee, task.state], ['leader', 'open']);
  const state = await server.ok('/api/state');
  assert.deepEqual(state.tasks.map((x: any) => x.title), ['Build a todo app']);
  assert.equal(state.roles.find((r: any) => r.name === 'leader').open_tasks, 1);
  await server.hub.session('leader').finishTask(task.id, 'todo.py is ready');
  const result = (await server.ok('/api/messages?after=0')).messages.at(-1);
  assert.deepEqual([result.kind, result.recipient], ['result', 'you']);
  const cancel = await server.ok('/api/task', { to: 'worker-a', title: 'Old idea' });
  assert.equal((await server.ok('/api/cancel-task', { task_id: cancel.id })).state, 'cancelled');
});

test('the owner writes to everyone, and urgently', async (t) => {
  const server = await startServer(t);
  const sent = (await server.ok('/api/send', { to: '@all', text: 'Stop for today' })).sent;
  assert.deepEqual(sent.map((m: any) => m.recipient).sort(), ['leader', 'researcher', 'tech-lead', 'worker-a', 'worker-b']);
  const [urgent] = (await server.ok('/api/send', { to: 'worker-a', text: 'STOP', urgent: true })).sent;
  assert.equal(urgent.urgent, true);
});

test('the law is served', async (t) => {
  const law = (await (await startServer(t)).ok('/api/law')).law;
  assert.ok(law[0].title === 'Chain of command' && law.length === 12);
});

test('roles show notes and whether they resume', async (t) => {
  const server = await startServer(t);
  server.hub.session('worker-a').saveNotes('Using Flask');
  const role = (await server.ok('/api/state')).roles.find((r: any) => r.name === 'worker-a');
  assert.ok(role.notes === 'Using Flask' && role.resumes === false);
});

test('stop needs a role', async (t) => {
  const server = await startServer(t);
  assert.deepEqual(await server.ok('/api/stop', { role: '@all' }), { stopped: {} }); // nobody is running
  assert.equal((await server.request('/api/stop', { role: 'ghost' }))[0], 400);
});

// welcome page: opening and creating teams

test('welcome mode without a team', async (t) => {
  freshHome(t);
  const folder = path.join(tmpDir(t), 'my app'); // removed after the server has closed its team
  const served = await ui.serve(null, 0, { token: 't', loadModels: false, watch: false });
  cleanup(t, () => served.close());
  const app = served.app;
  const home = app.home() as any;
  assert.equal(home.open, false);
  assert.deepEqual(home.templates.map((x: any) => x.id), ['solo', 'pair', 'team']);
  raises(() => app.state(), ui.ApiError, ui.NO_TEAM);
  const created = app.createTeam({ folder, template: 'pair' }) as any;
  assert.equal(created.team_file, path.join(folder, 'team.yaml'));
  assert.deepEqual((app.state() as any).roles.map((r: any) => r.name), ['leader', 'worker']);
  assert.equal((app.home() as any).recent[0].name, 'my app');
  app.forgetRecent({ path: (app.home() as any).recent[0].path }); // off the list; its files stay
  assert.ok((app.home() as any).recent.length === 0 && existsSync(path.join(folder, 'team.yaml')));
  raises(() => app.createTeam({ folder, template: 'solo' }), ui.ApiError, 'already exists');
  app.closeTeam();
  app.openTeam({ path: folder }); // a folder with a team.yaml works too
  assert.equal(app.teamFile, path.join(folder, 'team.yaml'));
  raises(() => app.openTeam({ path: path.join(folder, 'nowhere') }), ui.ApiError, 'no team.yaml');
  raises(() => app.createTeam({ folder: 'relative', template: 'solo' }), ui.ApiError, 'full folder path');
});

test('every template is a valid team', (t) => {
  for (const key of Object.keys(templates.TEMPLATES)) assert.equal(Team.fromDict(templates.teamConfig(key), tmpDir(t)).leader, 'leader');
});

test('the setup checks report each program', async (t) => {
  const server = await startServer(t);
  server.app.runChecks = async () => [{ name: 'Claude Code', ok: true, detail: '2.1.283', fix: '', needed: true },
    { name: 'Grok', ok: false, detail: 'not installed', fix: 'Install it', needed: true }];
  const checks = (await server.ok('/api/checks?fresh=1')).checks;
  assert.deepEqual(checks.map((c: any) => [c.name, c.ok]), [['Claude Code', true], ['Grok', false]]);
});

// the upgraded law from the page

test('the owner reviews tasks and reads their threads', async (t) => {
  const server = await startServer(t);
  const task = await server.ok('/api/task', { to: 'leader', title: 'Build it', done_when: 'tests pass', priority: 1 });
  assert.deepEqual([task.done_when, task.priority], ['tests pass', 1]);
  const later = await server.ok('/api/task', { to: 'leader', title: 'Then deploy', after: [task.id] });
  assert.ok(later.state === 'waiting' && later.after[0] === task.id);
  server.hub.session('leader').readInbox();
  await server.hub.session('leader').finishTask(task.id, 'all green');
  const detail = await server.ok(`/api/task?id=${task.id}`);
  assert.deepEqual(detail.thread.map((m: any) => m.kind), ['task', 'result']);
  assert.deepEqual(detail.dependents.map((x: any) => x.id), [later.id]);
  const problems = (await server.ok('/api/state')).problems;
  assert.ok(problems.some((p: any) => p.kind === 'review' && p.task_id === task.id));
  const back = await server.ok('/api/review', { task_id: task.id, accept: false, feedback: 'add a test' });
  assert.deepEqual([back.state, back.revisions], ['working', 1]);
  await server.hub.session('leader').finishTask(task.id, 'test added');
  assert.equal((await server.ok('/api/review', { task_id: task.id, accept: true })).state, 'accepted');
});

test('search and the activity feed', async (t) => {
  const server = await startServer(t);
  await server.ok('/api/send', { to: 'worker-a', text: 'Use the blue theme' });
  await server.ok('/api/task', { to: 'leader', title: 'Plan it' });
  assert.deepEqual((await server.ok('/api/search?q=blue')).messages.map((m: any) => m.text), ['Use the blue theme']);
  const events = (await server.ok('/api/events?after=0')).events;
  assert.equal(events.at(-1).text, 'gave #1 to leader: Plan it');
  assert.equal((await server.ok('/api/state')).last_event, events.at(-1).id);
});

// history, changes, auto-start and the running cap

test('task changes, and turning history on', async (t) => {
  const server = await startServer(t);
  const root = server.hub.baseTeam.project_root;
  const task = await server.ok('/api/task', { to: 'leader', title: 'Write the plan' });
  const leader = server.hub.session('leader');
  leader.readInbox();
  leader.claim('PLAN.md');
  writeFileSync(path.join(root, 'PLAN.md'), 'step 1\n');
  assert.deepEqual(await server.ok(`/api/task-changes?id=${task.id}`), { files: ['PLAN.md'], history: false, diff: '' });
  assert.equal((await server.ok('/api/history', {})).history, 'on');
  let changes = await server.ok(`/api/task-changes?id=${task.id}`);
  assert.ok(changes.history === true && changes.diff === ''); // the starting point includes it
  writeFileSync(path.join(root, 'PLAN.md'), 'step 1\nstep 2\n');
  changes = await server.ok(`/api/task-changes?id=${task.id}`);
  assert.ok(changes.diff.includes('+step 2'));
  assert.equal((await server.ok('/api/state')).history, true);
});

test('launch keeps to the running limit', async (t) => {
  const server = await startServer(t);
  server.settings({ max_running: 2 });
  server.hub.store.checkIn(31, 'leader');
  const result = await server.ok('/api/launch', { roles: ['tech-lead', 'worker-a'] });
  assert.deepEqual(result.opening, ['tech-lead']);
  assert.deepEqual(result.skipped, ["worker-a: 2 agents are running already (the team's limit)"]);
});

const events = (server: { hub: { store: { eventsAfter(n: number): { text: string }[] } } }): string[] => server.hub.store.eventsAfter(0).map((e) => e.text);

test('autostart starts agents that have work', async (t) => {
  const server = await startServer(t);
  server.settings({ autostart: true });
  await server.ok('/api/task', { to: 'leader', title: 'Build it' });
  await server.app.autostart(server.hub, watchdog.patrol(server.hub));
  assert.deepEqual(titles(server.openedTabs), ['leader']);
  assert.ok(events(server).includes('started automatically: it has work waiting'));
  await server.app.autostart(server.hub, watchdog.patrol(server.hub)); // not again straight away
  assert.equal(server.openedTabs.length, 1);
});

test('move a task, and restart an agent', async (t) => {
  const server = await startServer(t);
  const task = await server.ok('/api/task', { to: 'leader', title: 'Build it' });
  const moved = await server.ok('/api/reassign', { task_id: task.id, to: 'researcher', reason: 'leader is out of usage' });
  assert.equal(moved.assignee, 'researcher');
  const stopped: string[] = [];
  server.app.launcher.stopRole = (_hub, role) => { stopped.push(role); return 1; };
  const out = await server.ok('/api/restart', { role: 'researcher' });
  assert.ok(stopped[0] === 'researcher' && out.opening[0] === 'researcher');
  assert.ok(events(server).includes('restarted by the owner'));
});

test('the state shows why an agent is stuck', async (t) => {
  const server = await startServer(t);
  const now = Date.now() / 1000;
  server.hub.setStuck({ 'worker-a': { kind: 'limit', text: 'hit your limit', at: now, until: now + 3600 } });
  const role = (await server.ok('/api/state')).roles.find((r: any) => r.name === 'worker-a');
  assert.ok(role.stuck.kind === 'limit' && role.stuck.describe.startsWith('out of its usage limit until'), role.stuck.describe);
});

function stuckOnAnError(t: Parameters<typeof startServer>[0]): void {
  const before = usage.check.stuck;
  usage.check.stuck = () => ({ kind: 'error', text: 'API Error: 529', at: Date.now() / 1000 - 600, until: null });
  cleanup(t, () => { usage.check.stuck = before; });
}

test('autostart restarts an agent stuck on an error', async (t) => {
  const server = await startServer(t);
  server.settings({ autostart: true });
  await server.ok('/api/task', { to: 'leader', title: 'Build it' });
  server.hub.store.recordSessionId('leader', 'claude', 'sid-leader');
  server.hub.store.checkIn(4242, 'leader');
  stuckOnAnError(t);
  const stopped: string[] = [];
  server.app.launcher.stopRole = (hub, role) => { stopped.push(role); hub.store.checkOut(4242); return 1; };
  await server.app.autostart(server.hub, watchdog.patrol(server.hub));
  assert.deepEqual(stopped, ['leader']);
  assert.deepEqual(titles(server.openedTabs), ['leader']);
  assert.ok(events(server).includes('restarted automatically: it was stuck with work waiting'));
});

test('autostart does not keep restarting an agent that will not stop', async (t) => {
  const server = await startServer(t);
  server.settings({ autostart: true });
  await server.ok('/api/task', { to: 'leader', title: 'Build it' });
  server.hub.store.recordSessionId('leader', 'claude', 'sid-leader');
  server.hub.store.checkIn(4242, 'leader');
  stuckOnAnError(t);
  const stopped: string[] = [];
  server.app.launcher.stopRole = (_hub, role) => { stopped.push(role); return 0; }; // nothing stops
  await server.app.autostart(server.hub, watchdog.patrol(server.hub));
  await server.app.autostart(server.hub, watchdog.patrol(server.hub));
  assert.ok(stopped.length === 1 && server.openedTabs.length === 0);
  assert.ok(events(server).includes('could not be restarted automatically: its program did not stop'));
});

test('save a team once and start new projects from it', async (t) => {
  freshHome(t);
  const folder = path.join(tmpDir(t), 'new-project'); // made before the server, so removed after it closes the team
  const server = await startServer(t);
  assert.deepEqual(await server.ok('/api/save-template', { name: 'My crew', default: true }), { template: 'my:My crew', default: 'my:My crew' });
  let home = await server.ok('/api/home');
  assert.equal(home.default, 'my:My crew');
  const mine = home.templates.find((x: any) => x.id === 'my:My crew');
  assert.ok(mine.mine && mine.default && mine.roles.includes('tech-lead'));
  await server.ok('/api/create', { folder, template: 'my:My crew' });
  const created = parseYaml(readFileSync(path.join(folder, 'team.yaml'), 'utf8')) as any;
  assert.equal(created.project_root, '.');
  assert.deepEqual(Object.keys(created.roles).sort(), Object.keys(TEAM.roles).sort());
  assert.deepEqual(created.consultants, TEAM.consultants);
  await server.ok('/api/default-template', { id: 'solo' });
  assert.equal((await server.ok('/api/home')).default, 'solo');
  await server.ok('/api/delete-template', { id: 'my:My crew' });
  home = await server.ok('/api/home');
  assert.ok(!home.templates.some((x: any) => x.mine));
  assert.equal((await server.request('/api/delete-template', { id: 'solo' }))[0], 400); // built-in teams stay
});

test('role presets from the editor', async (t) => {
  freshHome(t);
  const server = await startServer(t);
  assert.ok((await server.ok('/api/team')).presets.some((p: any) => p.id === 'reviewer'));
  const saved = await server.ok('/api/save-preset', { name: 'Careful coder', role: { harness: 'codex', model: 'gpt-6-luna', duties: 'Code.',
    instructions: 'Run the tests.', write_scope: ['src/*'] } });
  assert.equal(saved.preset, 'my:careful-coder');
  const mine = (await server.ok('/api/team')).presets.find((p: any) => p.id === 'my:careful-coder');
  assert.ok(mine.mine && mine.instructions === 'Run the tests.');
  await server.ok('/api/delete-preset', { id: 'my:careful-coder' });
  assert.equal((await server.request('/api/delete-preset', { id: 'nope' }))[0], 400);
});

test('the Role Market', async (t) => {
  freshHome(t);
  const server = await startServer(t);
  let market = await server.ok('/api/roles');
  assert.ok(market.team_open && ['planner', 'reviewer'].every((id) => market.roles.some((p: any) => p.id === id)));
  const reviewer = market.roles.find((p: any) => p.id === 'reviewer');
  assert.ok(reviewer.icon && reviewer.description && reviewer.tags);
  // design one, edit it, duplicate a ready-made one
  const made = await server.ok('/api/role-save', { role: { title: 'Doc writer', icon: '📝', harness: 'claude', model: 'sonnet',
    duties: 'Write the docs.', tags: 'docs', instructions: 'Short sentences.', write_scope: 'docs/*' } });
  assert.equal(made.id, 'my:doc-writer');
  await server.ok('/api/role-save', { id: 'my:doc-writer', role: { title: 'Doc writer', harness: 'claude', duties: 'Write and fix the docs.' } });
  const mine = (await server.ok('/api/roles')).roles.find((p: any) => p.id === 'my:doc-writer');
  assert.ok(mine.duties === 'Write and fix the docs.' && mine.mine);
  // a ready-made one can be edited, reset, deleted and brought back
  await server.ok('/api/role-save', { id: 'reviewer', role: { title: 'Strict reviewer', harness: 'claude', model: 'opus' } });
  const edited = (await server.ok('/api/roles')).roles.find((p: any) => p.id === 'reviewer');
  assert.deepEqual([edited.title, edited.model, edited.edited], ['Strict reviewer', 'opus', true]);
  assert.ok(await server.ok('/api/role-reset', { id: 'reviewer' }));
  assert.equal((await server.ok('/api/roles')).roles.find((p: any) => p.id === 'reviewer').model, 'claude-sonnet-5-5');
  assert.equal((await server.request('/api/role-reset', { id: 'my:doc-writer' }))[0], 400);
  await server.ok('/api/role-delete', { id: 'tester' });
  market = await server.ok('/api/roles');
  assert.ok(!market.roles.some((p: any) => p.id === 'tester') && market.deleted_built_ins === 1);
  assert.deepEqual((await server.ok('/api/role-restore', {})).restored, ['tester']);
  assert.equal((await server.ok('/api/roles')).deleted_built_ins, 0);
  assert.ok((await server.ok('/api/role-duplicate', { id: 'reviewer' })).id.startsWith('my:reviewer'));
  // export, delete, import: the same role comes back
  const exported = await server.ok('/api/role-export?id=my:doc-writer');
  assert.ok(exported.filename === 'doc-writer.role.yaml' && exported.text.includes('agent-org-role: 1'));
  await server.ok('/api/role-delete', { id: 'my:doc-writer' });
  assert.equal((await server.ok('/api/role-import', { text: exported.text })).id, 'my:doc-writer');
  assert.equal((await server.request('/api/role-import', { text: 'not: [a role' }))[0], 400);
  // place it in the open team
  assert.equal((await server.ok('/api/role-place', { id: 'my:doc-writer', superior: 'leader' })).name, 'doc-writer');
  assert.deepEqual(server.config().roles['doc-writer'], { superior: 'leader', harness: 'claude', duties: 'Write and fix the docs.' });
  assert.equal((await server.request('/api/role-place', { id: 'coder', superior: 'ghost' }))[0], 400);
});

test('a new team built from market roles', async (t) => {
  const dir = tmpDir(t); // made before the server, so removed after it closes the team
  const server = await startServer(t);
  const folder = path.join(dir, 'built');
  await server.ok('/api/create', { folder, roles: [{ id: 'planner', name: 'lead', superior: 'you' }, { id: 'coder', name: 'dev', superior: 'lead' },
    { id: 'reviewer', superior: 'lead' }] });
  const team = parseYaml(readFileSync(path.join(folder, 'team.yaml'), 'utf8')) as any;
  assert.deepEqual(Object.fromEntries(Object.entries(team.roles).map(([n, r]: [string, any]) => [n, r.superior])), { lead: 'you', dev: 'lead', reviewer: 'lead' });
  assert.ok(team.roles.dev.model === 'gpt-6-luna' && team.consultants);
  const [status, data] = await server.request('/api/create', { folder: path.join(dir, 'bad'), roles: [{ id: 'planner', superior: 'you' }, { id: 'coder', superior: 'you' }] });
  assert.ok(status === 400 && data.error.includes('not complete')); // two leaders
});

test('one teammate changed, moved and removed', async (t) => {
  const server = await startServer(t);
  const roles = (): any => server.config().roles;
  await server.ok('/api/teammate', { name: 'worker-a', changes: { harness: 'claude', model: 'sonnet', effort: 'high', instructions: 'Run the tests.',
    write_scope: 'src/*, tests/*' } });
  const a = roles()['worker-a'];
  assert.deepEqual([a.harness, a.model, a.effort, a.instructions, a.write_scope], ['claude', 'sonnet', 'high', 'Run the tests.', ['src/*', 'tests/*']]);
  await server.ok('/api/teammate', { name: 'worker-a', changes: { model: '' } }); // back to the program's default
  assert.ok(!('model' in roles()['worker-a']));
  await server.ok('/api/teammate', { name: 'worker-a', changes: { superior: 'leader' } }); // dragged onto leader
  assert.equal(roles()['worker-a'].superior, 'leader');
  // what would break the team is refused, and team.yaml stays as it was
  assert.equal((await server.request('/api/teammate', { name: 'leader', changes: { superior: 'worker-a' } }))[0], 400); // a loop
  assert.equal((await server.request('/api/teammate', { name: 'worker-a', changes: { harness: 'zcode' } }))[0], 400);
  assert.equal((await server.request('/api/teammate', { name: 'worker-a', changes: { tier: 'x' } }))[0], 400);
  assert.equal((await server.request('/api/teammate', { name: 'ghost', changes: { model: 'x' } }))[0], 400);
  assert.equal(roles().leader.superior, 'you');
  // removing one: not while it has unfinished work (nobody would ever do it)
  const task = server.app.me.assignTask('tech-lead', 'Plan it');
  const [code, body] = await server.request('/api/teammate-remove', { name: 'tech-lead' });
  assert.ok(code === 400 && body.error.includes(`#${task.id}`));
  server.app.me.cancelTask(task.id);
  // then whoever reported to it reports to its superior
  assert.deepEqual(await server.ok('/api/teammate-remove', { name: 'tech-lead' }), { removed: 'tech-lead', moved_to: 'leader' });
  assert.ok(!('tech-lead' in roles()) && roles()['worker-b'].superior === 'leader');
});

test("the state shows each agent's usage over all its conversations", async (t) => {
  const server = await startServer(t);
  const store = server.hub.store;
  store.startSession('leader', 'claude', '11111111-1111-4111-8111-111111111111');
  store.startSession('leader', 'claude', '22222222-2222-4222-8222-222222222222'); // a fresh start
  assert.equal(store.conversations('leader').length, 2); // the first one is not forgotten
  const counts: Record<string, number> = { '11111111-1111-4111-8111-111111111111': 100, '22222222-2222-4222-8222-222222222222': 50 };
  const home = path.join(tmpDir(t), 'home');
  const before = sessions.where.home;
  sessions.where.home = () => home;
  cleanup(t, () => { sessions.where.home = before; usage.clearCaches(); });
  for (const [sid, n] of Object.entries(counts)) { // each conversation: one answer that read n tokens
    const file = path.join(home, '.claude', 'projects', 'E--proj', `${sid}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ type: 'assistant', message: { id: `m-${sid}`, model: 'claude-x', usage: { input_tokens: n, output_tokens: 1 } } })}\n`);
  }
  const role = (await server.ok('/api/state')).roles.find((r: any) => r.name === 'leader');
  assert.deepEqual([role.usage?.tokens_in, role.usage?.conversations], [150, 2]);
});

test('launch says plainly when no agent can start', async (t) => {
  const server = await startServer(t);
  const before = lookup.which;
  lookup.which = (name, p) => (name === 'pwsh' ? null : before(name, p));
  cleanup(t, () => { lookup.which = before; });
  const [code, body] = await server.request('/api/launch', {});
  assert.ok(code === 400 && body.error.includes('PowerShell 7') && body.error.includes('winget install Microsoft.PowerShell'), body.error);
});

test('the window comes back where it was', () => {
  const screens: [number, number, number, number][] = [[0, 0, 2560, 1440]];
  assert.deepEqual(ui.windowGeometry({}, screens), { width: 1520, height: 950, maximized: false });
  assert.deepEqual(ui.windowGeometry({ x: 100, y: 50, width: 1200, height: 800, maximized: true }, screens),
    { width: 1200, height: 800, maximized: true, x: 100, y: 50 });
  assert.ok(!('x' in ui.windowGeometry({ x: 3000, y: 50 }, screens))); // that monitor is gone
  assert.equal(ui.windowGeometry({ width: 300, height: 200 }, screens).width, 900); // never below the minimum
});

test('the window state is kept, and only sensible values are read back', (t) => {
  freshHome(t);
  assert.deepEqual(ui.loadWindowState(), {});
  ui.saveWindowState({ x: 10, y: 20, width: 1000, height: 700, maximized: false });
  assert.deepEqual(ui.loadWindowState(), { x: 10, y: 20, width: 1000, height: 700, maximized: false });
  mkdirSync(path.dirname(ui.windowStateFile()), { recursive: true });
  writeFileSync(ui.windowStateFile(), JSON.stringify({ x: 'far', width: 1.5, height: 800, colour: 'red' }));
  assert.deepEqual(ui.loadWindowState(), { height: 800 });
});

test('links from a terminal open in the browser', async (t) => {
  const server = await startServer(t);
  const opened: string[] = [];
  server.app.window.openUrl = (url) => opened.push(url);
  await server.ok('/api/open-url', { url: 'https://claude.ai/oauth/authorize?code=1' });
  assert.deepEqual(opened, ['https://claude.ai/oauth/authorize?code=1']);
  for (const bad of ['file:///C:/Windows/system32/calc.exe', 'javascript:alert(1)', 'https://x.test/a b', 'ms-settings:']) {
    assert.equal((await server.request('/api/open-url', { url: bad }))[0], 400);
  }
  assert.equal(opened.length, 1);
});

test('the folder picker answers with what was chosen', async (t) => {
  const server = await startServer(t);
  server.app.pickFolderWith = async (title) => (title === 'Where?' ? 'C:\\work\\app' : '');
  assert.deepEqual(await server.ok('/api/pick-folder', { title: 'Where?' }), { path: 'C:\\work\\app' });
  assert.deepEqual(await server.ok('/api/pick-folder', {}), { path: '' }); // cancelled
});

test('a closed team needs opening again', async (t) => {
  const server = await startServer(t);
  await server.ok('/api/close', {});
  const [status, data] = await server.request('/api/state');
  assert.ok(status === 412 && data.error === ui.NO_TEAM);
  await rejects(async () => server.app.state(), ui.ApiError, ui.NO_TEAM);
});

test("the programs' models are asked for at most once a day, and remembered", async (t) => {
  const home = freshHome(t);
  const ran: string[] = [];
  const before = [doctor.proc.run, lookup.which];
  doctor.proc.run = async (_exe, args) => {
    ran.push(args.join(' '));
    return [0, args[0] === 'debug' ? '{"models": [{"slug": "gpt-6-luna"}]}' : 'Available models:\n  * grok-5\n'];
  };
  lookup.which = (name) => (name === 'agy' ? null : name);
  cleanup(t, () => { [doctor.proc.run, lookup.which] = before as [typeof doctor.proc.run, typeof lookup.which]; });
  const first = new ui.ModelCatalog(); // nothing kept yet: asks later (not during the start), in the background
  assert.deepEqual(ran, []);
  await first.load();
  assert.deepEqual(ran, ['debug models', 'models']);
  assert.deepEqual([first.models.codex, first.models.grok], [['gpt-6-luna'], ['grok-5']]);
  const next = new ui.ModelCatalog(); // the next start knows them at once, without asking
  assert.deepEqual([next.models.codex, next.models.grok, next.models.claude.includes('sonnet')], [['gpt-6-luna'], ['grok-5'], true]);
  assert.ok(existsSync(path.join(home, ui.MODELS_FILE)));
});

test('one message by id, for a link to one older than the page keeps', async (t) => {
  const server = await startServer(t);
  const [sent] = (await server.ok('/api/send', { to: 'leader', text: 'an old question' })).sent;
  assert.equal((await server.ok(`/api/message?id=${sent.id}`)).message.text, 'an old question');
  assert.equal((await server.request('/api/message?id=999'))[0], 404);
  assert.equal((await server.request('/api/message?id=x'))[0], 400);
});
