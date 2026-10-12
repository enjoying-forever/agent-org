'use strict';

// The task board, task dialogs, the problems list and the activity feed.
// Uses the helpers in app.js (h, api, act, toast, S, ago, plural, fmtTime, messageEl).

const COLUMNS = [
  { key: 'waiting', title: 'Waiting', hint: 'Starts by itself when the tasks it waits for are done', states: ['waiting'] },
  { key: 'todo', title: 'To do', hint: 'Given, not yet read', states: ['open'] },
  { key: 'working', title: 'In progress', hint: 'The assignee has it', states: ['working'] },
  { key: 'blocked', title: 'Blocked', hint: 'Needs something from whoever gave it', states: ['blocked'] },
  { key: 'review', title: 'Review', hint: 'Done: waits for whoever gave it to accept it or send it back', states: ['done'] },
  { key: 'closed', title: 'Finished', hint: 'Accepted, failed, rejected or cancelled', states: ['accepted', 'failed', 'rejected', 'cancelled'] },
];
const PRIORITY = { 1: 'urgent', 2: 'normal', 3: 'low' };
const harnessOf = (name) => (S.state.roles.find((r) => r.name === name) || {}).harness || 'owner';

// ---------- board ----------

function renderBoard() {
  const tasks = S.state.tasks;
  const open = tasks.filter((t) => !['accepted', 'failed', 'rejected', 'cancelled'].includes(t.state));
  $('#board-count').textContent = open.length ? `(${open.length})` : '';
  S.boardStale = $('#view-board').hidden; // drawn when it shows
  if (S.boardStale) return;
  const who = fillSelect($('#board-role'), [['', 'Everyone'], ...S.state.roles.filter((r) => !r.tier).map((r) => [r.name, r.name])], $('#board-role').value);
  const key = JSON.stringify([tasks, who]);
  if (key === S.boardKey) return; // the same tasks: the board (and the card under your pointer) stays
  S.boardKey = key;
  const mine = (t) => !who || t.assignee === who || t.assigner === who;
  $('#board').replaceChildren(...COLUMNS.map((col) => {
    let items = tasks.filter((t) => col.states.includes(t.state) && mine(t));
    items.sort((a, b) => (a.priority - b.priority) || (a.id - b.id));
    if (col.key === 'closed') items = items.sort((a, b) => b.updated_at - a.updated_at).slice(0, 25);
    return h('section', { class: `col col-${col.key}` },
      h('header', { title: col.hint }, h('b', {}, col.title), h('span', { class: 'muted' }, String(items.length))),
      h('div', { class: 'cards' }, items.length ? items.map(cardEl) : h('div', { class: 'empty small' }, '—')));
  }));
}

function cardEl(t) {
  return h('button', { class: `tcard p${t.priority} s-${t.state}`, onclick: () => openTask(t.id) },
    h('div', { class: 'tc-head' },
      h('span', { class: 'muted' }, `#${t.id}`),
      t.priority === 1 && h('span', { class: 'urgent-tag' }, 'urgent'),
      t.priority === 3 && h('span', { class: 'tag' }, 'low'),
      t.revisions ? h('span', { class: 'tag', title: 'Times it was sent back' }, `round ${t.revisions + 1}`) : null,
      ['failed', 'rejected', 'cancelled', 'accepted'].includes(t.state) && h('span', { class: `tstate ${t.state}` }, t.state)),
    h('div', { class: 'tc-title' }, t.title),
    h('div', { class: 'tc-meta' },
      h('span', { class: `harness h-${harnessOf(t.assignee)}` }, t.assignee),
      h('span', { class: 'muted' }, `from ${t.assigner}, ${ago(t.created_at)}`)),
    t.after.length ? h('div', { class: 'tc-after muted' }, `after #${t.after.join(', #')}`) : null,
    stuckOn(t) && h('div', { class: `stuck-badge ${stuckOn(t).kind}`, title: 'Its assignee cannot work right now' },
      `${t.assignee} is ${stuckOn(t).describe}`));
}

/** Why an unfinished task's assignee cannot work right now, if it can't. */
function stuckOn(t) {
  if (!['open', 'working', 'blocked'].includes(t.state)) return null;
  return findRole(t.assignee)?.stuck || null;
}

// ---------- one task ----------

/** What the page knows of a task that its dialog shows: when it changes (its state, a result, a message about
 * it), the open dialog is drawn again. null for a task the board does not have. */
function taskShownKey(id) {
  const t = S.state?.tasks.find((x) => x.id === id);
  return t ? JSON.stringify([t.state, t.updated_at, t.assignee, S.messages.filter((m) => m.task_id === id).length]) : null;
}

/** Keep the open task's dialog up to date (seen: the Board said Review while the dialog still said working). */
function refreshOpenTask() {
  const shown = S.taskShown;
  if (!shown || !$('#task-dialog').open) return;
  const key = taskShownKey(shown.id);
  if (key === null || key === shown.key) return;
  shown.key = key; // once, however many updates come while it loads
  openTask(shown.id);
}

async function openTask(id) {
  let d;
  try { d = await api(`/api/task?id=${id}`); } catch (e) { toast(e.message, true); return; }
  const t = d.task;
  // drawn again: the review you are writing stays as it is, and where you are in the dialog
  const old = S.taskShown?.id === id && $('#task-dialog').open ? $('#task-body .review textarea') : null;
  const kept = old && { text: old.value, focused: document.activeElement === old, from: old.selectionStart, to: old.selectionEnd };
  const scrolled = S.taskShown?.id === id ? [$('#task-dialog').scrollTop, $('#task-body').scrollTop] : [0, 0];
  const closed = ['accepted', 'failed', 'rejected', 'cancelled'].includes(t.state);
  const byId = (x) => S.state.tasks.find((y) => y.id === x);
  const feedback = h('textarea', { rows: 3, placeholder: 'What has to change (needed to send it back)' });
  fill($('#task-body'),
    h('header', { class: 'task-head' },
      h('span', { class: `tstate ${t.state}` }, t.state === 'done' ? 'waits for review' : t.state),
      h('h2', {}, `#${t.id} ${t.title}`),
      h('button', { class: 'small', onclick: () => $('#task-dialog').close() }, '✕')),
    h('dl', { class: 'task-meta' },
      h('dt', {}, 'Given'), h('dd', {}, `${t.assigner} → ${t.assignee}, ${ago(t.created_at)}`),
      h('dt', {}, 'Priority'), h('dd', {}, PRIORITY[t.priority] || t.priority),
      t.revisions ? [h('dt', {}, 'Sent back'), h('dd', {}, plural(t.revisions, 'time'))] : null,
      t.parent_id ? [h('dt', {}, 'Part of'), h('dd', {}, h('button', { class: 'link', onclick: () => openTask(t.parent_id) }, `#${t.parent_id}`))] : null,
      t.after.length ? [h('dt', {}, 'Starts after'), h('dd', {}, t.after.map((x) => h('button', {
        class: 'link dep', onclick: () => openTask(x),
      }, `#${x}${byId(x) ? ` (${byId(x).state})` : ''}`)))] : null,
      d.dependents.length ? [h('dt', {}, 'Then starts'), h('dd', {}, d.dependents.map((x) => h('button', {
        class: 'link dep', onclick: () => openTask(x.id),
      }, `#${x.id} ${x.title}`)))] : null),
    t.done_when && h('div', { class: 'done-when' }, h('b', {}, 'Done when: '), t.done_when),
    t.details && h('div', { class: 'text-block' }, t.details),
    t.result && h('div', { class: `result ${t.state}` }, h('b', {}, 'Result: '), t.result),
    (t.checks || t.commit_id) && h('div', { class: 'muted small' },
      t.checks && `Checks: ${t.checks}. `, t.commit_id && `Committed as ${t.commit_id}.`),
    h('div', { id: 'task-changes', class: 'changes' }, h('span', { class: 'muted small' }, 'Loading changes...')),
    t.state === 'done' && h('div', { class: 'review' },
      h('b', {}, 'Your review'),
      t.done_when && h('div', { class: 'muted small' }, 'Check the result against "done when" above.'),
      feedback,
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: () => review(t, true) },
          S.state.history && S.state.settings.commit_on_accept && S.state.settings.isolation !== 'branches' ? 'Accept & commit' : 'Accept'),
        h('button', { onclick: () => review(t, false, feedback.value) }, 'Send back'))),
    h('div', { class: 'actions' },
      h('button', { onclick: () => { $('#task-dialog').close(); composeTo(t.assignee, 'message'); } }, `Message ${t.assignee}`),
      !closed && t.state !== 'done' && moveControl(t),
      !closed && h('button', { class: 'danger', onclick: () => cancelTask(t) }, 'Cancel task')),
    h('h3', {}, `Conversation (${d.thread.length})`),
    d.thread.length ? d.thread.map((m) => messageEl(m, true)) : h('div', { class: 'muted' }, 'No messages yet.'));
  if (kept) {
    feedback.value = kept.text;
    if (kept.focused) { feedback.focus(); feedback.setSelectionRange(kept.from, kept.to); }
  }
  if (!$('#task-dialog').open) $('#task-dialog').showModal();
  [$('#task-dialog').scrollTop, $('#task-body').scrollTop] = scrolled;
  S.taskShown = { id, key: taskShownKey(id) };
  loadChanges(t.id);
}

// ---------- moving tasks (when an agent is out of its usage limit) ----------

/** Who could take `t` over: below whoever gave it; not stuck, other programs and idle agents first. */
function moveCandidates(t) {
  const from = findRole(t.assignee);
  const below = t.assigner === S.state.owner ? S.state.roles : subtreeOf(t.assigner);
  const rank = (r) => [r.stuck ? 1 : 0, r.harness === from?.harness ? 1 : 0, r.open_tasks];
  return below.filter((r) => r.name !== t.assignee && !r.tier).sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.name.localeCompare(b.name);
  });
}

function moveControl(t, after) {
  const options = moveCandidates(t);
  if (!options.length) return null;
  const pick = h('select', { title: 'Who takes it over' }, options.map((r) => h('option', { value: r.name },
    `${r.name} (${r.harness}${r.stuck ? ', stuck' : ''}, ${plural(r.open_tasks, 'task')})`)));
  return h('span', { class: 'move' },
    h('button', { onclick: () => moveTask(t, pick.value, after) }, 'Move to'), pick);
}

async function moveTask(t, to, after) {
  const stuck = findRole(t.assignee)?.stuck;
  const reason = await ask(`Move #${t.id} (${t.title}) from ${t.assignee} to ${to}? Say why: ${to} reads it.`,
    { title: 'Move the task', input: stuck ? `${t.assignee} is ${stuck.describe}.` : '', ok: `Move to ${to}` });
  if (reason === null) return;
  if (await act(api('/api/reassign', { task_id: t.id, to, reason }), () => `#${t.id} is now ${to}'s.`)) {
    if (after) after(); else openTask(t.id);
  }
}

/** Every unfinished task of one agent, each with its own Move control. */
async function openMoveTasks(name) {
  await refresh();
  S.taskShown = null;
  const r = findRole(name);
  const tasks = S.state.tasks.filter((t) => t.assignee === name && ['waiting', 'open', 'working', 'blocked'].includes(t.state));
  fill($('#task-body'),
    h('header', { class: 'task-head' },
      h('h2', {}, `Move ${name}'s tasks`),
      h('button', { class: 'small', onclick: () => $('#task-dialog').close() }, '✕')),
    r?.stuck && h('p', {}, `${name} is ${r.stuck.describe}. Move what should not wait to someone free - preferably `
      + 'on another program, which runs on a different subscription. The new agent gets the task, its history and '
      + `the files ${name} was writing for it.`),
    tasks.length
      ? tasks.map((t) => h('div', { class: 'move-row' },
        h('button', { class: 'link', onclick: () => openTask(t.id) }, `#${t.id} ${t.title}`),
        h('span', { class: `tstate ${t.state}` }, t.state),
        moveControl(t, () => openMoveTasks(name)) || h('span', { class: 'muted small' }, 'nobody else can take it')))
      : h('div', { class: 'muted' }, 'Nothing left to move.'));
  if (!$('#task-dialog').open) $('#task-dialog').showModal();
}

async function loadChanges(id) {
  let c;
  try { c = await api(`/api/task-changes?id=${id}`); } catch { return; }
  const box = document.getElementById('task-changes');
  if (!box) return;
  if (!c.files.length && !c.diff) {
    fill(box, h('span', { class: 'muted small' }, 'No file changes recorded for this task.'));
    return;
  }
  fill(box,
    h('b', {}, c.files.length ? `Changes (${plural(c.files.length, 'file')})` : 'Changes'),
    c.files.length ? h('div', { class: 'task-files' }, c.files.map((f) => [h('button', {
      class: 'link mono small', title: `Show ${f} in File Explorer`,
      onclick: () => api('/api/reveal', { path: f }).catch((e) => toast(e.message, true)),
    }, f), /\.html?$/i.test(f) && h('button', { class: 'link small', title: `Look at ${f} in the browser beside the team`,
      onclick: () => { $('#task-dialog').close(); openInBrowser(toAddress(f)); } }, 'preview')])) : null,
    c.history
      ? (c.diff ? diffEl(c.diff) : h('div', { class: 'muted small' }, 'No differences from the last commit.'))
      : h('div', { class: 'history-off' },
        h('span', { class: 'muted small' }, 'Turn on history (git) to see exactly what changed, and to keep each '
          + 'accepted task as a commit you can undo.'),
        h('button', { class: 'small', onclick: () => turnOnHistory(id) }, 'Turn on history')));
}

function diffEl(text) {
  return h('pre', { class: 'diff' }, text.split('\n').map((line) => {
    const cls = line.startsWith('diff --git') ? 'd-file' : line.startsWith('@@') ? 'd-hunk'
      : line.startsWith('+') && !line.startsWith('+++') ? 'd-add'
        : line.startsWith('-') && !line.startsWith('---') ? 'd-del' : '';
    return h('span', { class: cls }, line + '\n');
  }));
}

async function turnOnHistory(id) {
  if (!(await ask('Turn on history? This creates a git repository in the project folder and saves everything '
    + 'as a starting point. From then on each accepted task becomes a commit.'))) return;
  if (await act(api('/api/history', {}), () => 'History is on.')) loadChanges(id);
}

async function review(t, accept, feedback = '') {
  if (!accept && !feedback.trim()) { toast('Say what has to change, then send it back.', true); return; }
  const r = await act(api('/api/review', { task_id: t.id, accept, feedback }),
    () => (accept ? `Task #${t.id} accepted.` : `Task #${t.id} sent back to ${t.assignee}.`));
  if (r) openTask(t.id);
}

async function cancelTask(t) {
  const reason = await ask(`Cancel #${t.id} (${t.title})? ${t.assignee} is told to stop. A reason, if you like:`,
    { title: 'Cancel the task', input: '', ok: 'Cancel the task', no: 'Keep it', danger: true });
  if (reason === null) return;
  act(api('/api/cancel-task', { task_id: t.id, reason }), () => `Task #${t.id} cancelled.`)
    .then((r) => { if (r && $('#task-dialog').open) openTask(t.id); });
}

// ---------- new task ----------

function openNewTask(to) {
  $('#nt-to').replaceChildren(...S.state.roles.filter((r) => !r.tier).map((r) =>
    h('option', { value: r.name, selected: r.name === (to || S.state.leader) },
      `${r.name}${r.name === S.state.leader && r.name !== 'leader' ? ' (leader)' : ''}`)));
  // what a new task can wait for: work still to be done (a done one has nothing left to wait for)
  const candidates = S.state.tasks.filter((t) => ['waiting', 'open', 'working', 'blocked'].includes(t.state)).slice(-30).reverse();
  $('#nt-after-box').hidden = !candidates.length;
  $('#nt-after-box').open = false;
  $('#nt-after').replaceChildren(...candidates.map((t) => h('label', { class: 'inline' },
    h('input', { type: 'checkbox', value: t.id }), `#${t.id} ${t.title} (${t.assignee}, ${t.state})`)));
  // what was typed and not given yet stays (a failed try, a closed dialog): it is emptied once the task is given
  $('#new-task').returnValue = '';
  $('#new-task').showModal();
  $('#nt-title').focus();
}

$('#new-task-btn').addEventListener('click', () => openNewTask());
/** The new-task form emptied, for the next one. */
function clearNewTask() {
  for (const id of ['#nt-title', '#nt-details', '#nt-done']) $(id).value = '';
  $('#nt-priority').value = '2';
}

$('#new-task-form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault(); // it closes once the task is given: a refusal leaves it open, as typed, to fix and try again
  const body = {
    to: $('#nt-to').value, title: $('#nt-title').value.trim(), details: $('#nt-details').value,
    done_when: $('#nt-done').value, priority: Number($('#nt-priority').value),
    after: [...document.querySelectorAll('#nt-after input:checked')].map((x) => Number(x.value)),
  };
  if (!body.title) { toast('A task needs a one-line title.', true); return; }
  const team = S.state.team_file;
  sendOnce('new-task', e.target, async () => {
    const t = await act(api('/api/task', body), (x) => (x.state === 'waiting'
      ? `Task #${x.id} will start when #${x.after.join(', #')} ${x.after.length > 1 ? 'are' : 'is'} done.`
      : `Task #${x.id} given to ${x.assignee}.`));
    if (t && S.state?.team_file === team) {
      clearNewTask();
      $('#new-task').close('ok');
    }
  });
});
$('#board-role').addEventListener('change', renderBoard);

// ---------- problems ----------

const NOTIFY_KINDS = ['stuck', 'loop', 'duplicate', 'asking'];  // the rest arrive as messages; a usage limit needs nothing of you

/** A desktop notification when an agent runs out of usage, gets stuck, or loops - once each. */
function notifyProblems(list) {
  const fresh = list.filter((p) => NOTIFY_KINDS.includes(p.kind) && !S.problemsSeen?.has(`${p.kind}:${p.role}`));
  const first = !S.problemsSeen;
  S.problemsSeen = new Set(list.map((p) => `${p.kind}:${p.role}`));
  if (first || !fresh.length || !document.hidden) return;  // not for what was there at load, or while you look
  try {
    if (Notification.permission === 'granted') {
      const n = new Notification('agent-org needs you', { body: fresh[0].text.slice(0, 180) });
      n.onclick = () => { comeBack(); if (fresh[0].role && findRole(fresh[0].role)) focusPane(fresh[0].role); };
    }
  } catch { /* notifications unavailable */ }
}

/** Problems show where they are (a pane's title and outline); this only notifies you while away. */
function renderProblems() {
  notifyProblems([...S.state.problems, ...askingProblems()]);
}

// ---------- activity ----------

const ACT_ICON = { task: '▣', file: '✎', watch: '⚑', consultant: '★', agent: '●' };
const A = { last: 0, events: [] };

async function refreshActivity() {
  if (!S.state || S.state.last_event <= A.last) return;
  try {
    const { events } = await api(`/api/events?after=${A.last}`);
    for (const e of events) { A.events.push(e); A.last = Math.max(A.last, e.id); }
    A.events = A.events.slice(-400);
    renderActivity();
  } catch { /* next time */ }
}

function renderActivity() {
  const box = $('#activity');
  box.replaceChildren(...(A.events.length ? A.events.slice().reverse().map((e) => h('div', { class: `ev ${e.kind}` },
    h('span', { class: 'muted' }, fmtTime(e.at)),
    h('span', { class: 'eicon' }, ACT_ICON[e.kind] || '·'),
    h('b', {}, e.role), ' ',
    e.task_id ? h('button', { class: 'link', onclick: () => openTask(e.task_id) }, e.text) : e.text))
    : [h('div', { class: 'empty' }, 'Nothing has happened yet.')]));
}

function resetActivity() {
  A.last = 0;
  A.events = [];
}
