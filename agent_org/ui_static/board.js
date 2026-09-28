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
  const sel = $('#board-role');
  const keep = sel.value;
  sel.replaceChildren(h('option', { value: '' }, 'Everyone'),
    ...S.state.roles.filter((r) => !r.tier).map((r) => h('option', { value: r.name }, r.name)));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
  const who = sel.value;
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
      h('span', { class: 'muted' }, `from ${t.assigner} · ${ago(t.created_at)}`)),
    t.after.length ? h('div', { class: 'tc-after muted' }, `after #${t.after.join(', #')}`) : null);
}

// ---------- one task ----------

async function openTask(id) {
  let d;
  try { d = await api(`/api/task?id=${id}`); } catch (e) { toast(e.message, true); return; }
  const t = d.task;
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
          S.state.history && S.state.settings.commit_on_accept ? 'Accept & commit' : 'Accept'),
        h('button', { onclick: () => review(t, false, feedback.value) }, 'Send back'))),
    h('div', { class: 'actions' },
      h('button', { onclick: () => { $('#task-dialog').close(); composeTo(t.assignee, 'message'); } }, `Message ${t.assignee}`),
      !closed && h('button', { class: 'danger', onclick: () => cancelTask(t) }, 'Cancel task')),
    h('h3', {}, `Conversation (${d.thread.length})`),
    d.thread.length ? d.thread.map((m) => messageEl(m, true)) : h('div', { class: 'muted' }, 'No messages yet.'));
  if (!$('#task-dialog').open) $('#task-dialog').showModal();
  loadChanges(t.id);
}

async function loadChanges(id) {
  let c;
  try { c = await api(`/api/task-changes?id=${id}`); } catch { return; }
  const box = document.getElementById('task-changes');
  if (!box) return;
  if (!c.files.length) {
    fill(box, h('span', { class: 'muted small' }, 'No file changes recorded for this task.'));
    return;
  }
  fill(box,
    h('b', {}, `Changes (${plural(c.files.length, 'file')})`),
    h('div', { class: 'mono small' }, c.files.join(', ')),
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
  if (!confirm('Turn on history? This creates a git repository in the project folder and saves everything '
    + 'as a starting point. From then on each accepted task becomes a commit.')) return;
  if (await act(api('/api/history', {}), () => 'History is on.')) loadChanges(id);
}

async function review(t, accept, feedback = '') {
  if (!accept && !feedback.trim()) { toast('Say what has to change, then send it back.', true); return; }
  const r = await act(api('/api/review', { task_id: t.id, accept, feedback }),
    () => (accept ? `Task #${t.id} accepted.` : `Task #${t.id} sent back to ${t.assignee}.`));
  if (r) openTask(t.id);
}

function cancelTask(t) {
  const reason = prompt(`Cancel task #${t.id} (${t.title})? ${t.assignee} will be told to stop.\n\nReason (optional):`, '');
  if (reason === null) return;
  act(api('/api/cancel-task', { task_id: t.id, reason }), () => `Task #${t.id} cancelled.`)
    .then((r) => { if (r && $('#task-dialog').open) openTask(t.id); });
}

// ---------- new task ----------

function openNewTask(to) {
  $('#nt-to').replaceChildren(...S.state.roles.filter((r) => !r.tier).map((r) =>
    h('option', { value: r.name, selected: r.name === (to || S.state.leader) }, `${r.name}${r.name === S.state.leader ? ' (leader)' : ''}`)));
  const candidates = S.state.tasks.filter((t) => !['failed', 'rejected', 'cancelled'].includes(t.state)
    && t.state !== 'accepted').slice(-30).reverse();
  $('#nt-after').replaceChildren(...(candidates.length ? candidates.map((t) => h('label', { class: 'inline' },
    h('input', { type: 'checkbox', value: t.id }), `#${t.id} ${t.title} (${t.assignee}, ${t.state})`))
    : [h('span', { class: 'muted small' }, 'No other open tasks.')]));
  for (const id of ['#nt-title', '#nt-details', '#nt-done']) $(id).value = '';
  $('#nt-priority').value = '2';
  $('#new-task').returnValue = '';
  $('#new-task').showModal();
  $('#nt-title').focus();
}

$('#new-task-btn').addEventListener('click', () => openNewTask());
$('#new-task-form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'ok') return;
  const body = {
    to: $('#nt-to').value, title: $('#nt-title').value.trim(), details: $('#nt-details').value,
    done_when: $('#nt-done').value, priority: Number($('#nt-priority').value),
    after: [...document.querySelectorAll('#nt-after input:checked')].map((x) => Number(x.value)),
  };
  if (!body.title) { toast('A task needs a one-line title.', true); return; }
  act(api('/api/task', body), (t) => (t.state === 'waiting'
    ? `Task #${t.id} will start when #${t.after.join(', #')} ${t.after.length > 1 ? 'are' : 'is'} done.`
    : `Task #${t.id} given to ${t.assignee}.`));
});
$('#board-role').addEventListener('change', renderBoard);

// ---------- problems ----------

const PROBLEM_ICON = { stopped: '⏸', stalled: '⏳', question: '?', review: '✓', blocked: '⛔', loop: '↻', duplicate: '⧉' };

function renderProblems() {
  const list = S.state.problems;
  const box = $('#problems');
  box.hidden = !list.length;
  if (!list.length) return;
  box.replaceChildren(h('b', {}, `Needs attention (${list.length})`),
    ...list.map((p) => h('div', { class: `problem ${p.kind}` },
      h('span', { class: 'picon' }, PROBLEM_ICON[p.kind] || '!'),
      h('span', { class: 'ptext' }, p.text),
      problemAction(p))));
}

function problemAction(p) {
  const btn = (label, fn) => h('button', { class: 'small', onclick: fn }, label);
  if (p.action === 'start') return btn('Start', () => launchRoles([p.role]));
  if (p.action === 'stop') return btn('Stop', () => stopRoles(p.role));
  if (p.action === 'answer') {
    return btn('Answer', () => {
      const m = S.messages.find((x) => x.id === p.message_id);
      showView('team'); showTab('messages');
      if (m) { jumpTo(m.id); replyTo(m); }
    });
  }
  if (p.action === 'review') return btn('Review', () => openTask(p.task_id));
  if (p.action === 'open-task') return btn('Open', () => openTask(p.task_id));
  return null;
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
