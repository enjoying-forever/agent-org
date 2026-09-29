'use strict';

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);

/** Build an element. Children are appended as text or nodes, so agent text is never parsed as HTML. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = Boolean(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false || kid === '') continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

/** Replace an element's children, flattening lists and skipping empty values, like h() does. */
function fill(el, ...kids) {
  el.replaceChildren(h('div', {}, ...kids));
  el.replaceChildren(...el.firstChild.childNodes);
  return el;
}

const TOKEN = (() => {
  const fromUrl = new URLSearchParams(location.search).get('token');
  try {
    if (fromUrl) sessionStorage.setItem('agent-org-token', fromUrl);
    else return sessionStorage.getItem('agent-org-token') || '';
  } catch { /* storage can be unavailable; the URL token still works for this load */ }
  return fromUrl || '';
})();
if (new URLSearchParams(location.search).has('token')) history.replaceState(null, '', '/');

class NoTeam extends Error {}

async function api(path, body) {
  const post = body !== undefined;
  const res = await fetch(path, {
    method: post ? 'POST' : 'GET',
    headers: post ? { 'X-Org-Token': TOKEN, 'Content-Type': 'application/json' } : { 'X-Org-Token': TOKEN },
    body: post ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 403) showBlocker();
  if (res.status === 412 && data.error === 'no_team') throw new NoTeam();
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(t) {
  const d = new Date(t * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function ago(t) {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const modelLine = (x) => [x.model || 'default model', x.effort && `${x.effort} effort`].filter(Boolean).join(' · ');

let toastTimer;
function toast(text, error = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'toast' + (error ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, error ? 8000 : 4500);
}

function showBlocker() {
  const b = $('#blocker');
  b.replaceChildren(h('div', {},
    h('h2', {}, 'This page needs its access link'),
    h('p', { class: 'muted' }, 'Open the link printed in the agent-org window (it ends with ?token=...).')));
  b.hidden = false;
}

function showInfo(title, ...body) {
  $('#info-title').textContent = title;
  $('#info-body').replaceChildren(...body);
  $('#info').showModal();
}

async function act(promise, done) {
  try {
    const result = await promise;
    if (done) toast(done(result));
    refresh();
    return result;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

// ---------- state & polling ----------

const S = {
  state: null, stateKey: '', messages: [], lastId: 0, mode: null,
  filter: 'all', roleFilter: '', replyTo: null, selected: null, summonFor: null,
  compose: 'message', notified: 0,
};

async function refresh() {
  try {
    const [state, fresh] = await Promise.all([api('/api/state'), api(`/api/messages?after=${S.lastId}`)]);
    setConn(true);
    enterTeam();
    applyState(state);
    if (fresh.messages.length) addMessages(fresh.messages);
  } catch (e) {
    if (e instanceof NoTeam) enterHome();
    else setConn(false, e.message);
  }
}

async function poll() {
  if (S.mode === 'home') {
    try {
      if ((await api('/api/home')).open) await refresh();  // a team was opened elsewhere
    } catch { /* retried next time */ }
  } else {
    await refresh();
  }
  setTimeout(poll, S.mode === 'home' ? 5000 : 1500);
}

function setConn(ok, why) {
  const c = $('#conn');
  c.textContent = ok ? 'live' : 'offline, retrying';
  c.title = ok ? '' : why || '';
  c.classList.toggle('down', !ok);
}

function applyState(state) {
  const key = JSON.stringify(state);
  if (key === S.stateKey) return;
  const first = S.state === null;
  S.state = state;
  S.stateKey = key;
  $('#project').textContent = state.project_root;
  $('#project').title = `team file: ${state.team_file}`;
  renderChart();
  renderGuide();
  renderProblems();
  renderBoard();
  refreshActivity();
  renderLocks();
  renderRecipients();
  renderRoleFilter();
  renderInboxBadge();
  if (S.selected) renderDrawer();
  if (first) renderFeed('bottom');
}

const rolesUnder = (name) => S.state.roles.filter((r) => r.superior === name);
/** Everyone below `name`, at any depth. */
const subtreeOf = (name) => rolesUnder(name).flatMap((r) => [r, ...subtreeOf(r.name)]);
const findRole = (name) => S.state.roles.find((r) => r.name === name);

// ---------- modes: welcome page or a team ----------

function enterTeam() {
  if (S.mode === 'team') return;
  S.mode = 'team';
  $('#view-home').hidden = true;
  for (const id of ['#views', '#conn', '#switch-btn', '#stop-all', '#launch-all']) $(id).hidden = false;
  showView('team');
}

function enterHome() {
  if (S.mode === 'home') return;
  S.mode = 'home';
  Object.assign(S, { state: null, stateKey: '', messages: [], lastId: 0, selected: null, notified: 0 });
  if (typeof E !== 'undefined') E.draft = null;
  $('#drawer').hidden = true;
  resetActivity();
  for (const id of ['#view-team', '#view-board', '#view-editor', '#views', '#conn', '#switch-btn', '#stop-all', '#launch-all']) {
    $(id).hidden = true;
  }
  $('#project').textContent = '';
  $('#view-home').hidden = false;
  document.title = 'agent-org';
  renderHome();
}

async function renderHome() {
  let home;
  try { home = await api('/api/home'); } catch (e) { toast(e.message, true); return; }
  const recent = home.recent.filter((r) => r.exists);
  $('#recent-card').hidden = !recent.length;
  $('#recent').replaceChildren(...recent.map((r) => h('button', {
    class: 'list-item', title: r.path, onclick: () => openTeam(r.path),
  }, h('b', {}, r.name), h('span', { class: 'muted mono' }, r.path))));
  const chosen = document.querySelector('#templates input:checked')?.value || home.default;
  $('#templates').replaceChildren(...home.templates.map((t) => h('label', { class: 'tier' },
    h('input', { type: 'radio', name: 'template', value: t.id, checked: t.id === chosen }),
    h('span', {}, h('b', {}, t.title), t.default ? h('span', { class: 'tag' }, 'default') : null,
      h('span', { class: 'muted' }, `  ${t.roles}`)),
    h('small', {}, t.summary,
      !t.default && h('button', { class: 'link', onclick: (e) => { e.preventDefault(); templateAction('default', t); } },
        ' Make default'),
      t.mine && h('button', { class: 'link', onclick: (e) => { e.preventDefault(); templateAction('delete', t); } },
        ' Delete')))));
  renderChecks($('#home-checks'));
}

async function templateAction(kind, t) {
  if (kind === 'delete' && !confirm(`Delete your saved team "${t.title}"? Projects made from it keep their team.`)) return;
  await act(api(`/api/${kind}-template`, { id: t.id }),
    () => (kind === 'delete' ? `Deleted "${t.title}".` : `"${t.title}" is now the default for new projects.`));
  renderHome();
}

async function openTeam(path) {
  if (!path.trim()) { toast('Type or browse to the folder first.', true); return; }
  await act(api('/api/open', { path }));
}

async function browse(input, title) {
  const r = await act(api('/api/pick-folder', { title }));
  if (r && r.path) input.value = r.path;
}

$('#open-browse').addEventListener('click', () => browse($('#open-path'), 'Choose the folder that has team.yaml'));
$('#create-browse').addEventListener('click', () => browse($('#create-path'), 'Choose the project folder'));
$('#open-go').addEventListener('click', () => openTeam($('#open-path').value));
$('#create-go').addEventListener('click', async () => {
  const folder = $('#create-path').value.trim();
  const template = document.querySelector('#templates input:checked')?.value;
  if (!folder) { toast('Choose the project folder first.', true); return; }
  await act(api('/api/create', { folder, template }), () => 'Team created. Check it in "Edit team", then Launch team.');
});
$('#shortcut-btn').addEventListener('click', () =>
  act(api('/api/desktop-shortcut', {}), () => 'Shortcut added: double-click "agent-org" on your desktop next time.'));
$('#switch-btn').addEventListener('click', async () => {
  if (typeof E !== 'undefined' && E.dirty && !confirm('Leave without saving your team changes?')) return;
  await act(api('/api/close', {}));
});

// ---------- setup checks ----------

async function renderChecks(box, fresh = false) {
  box.replaceChildren(h('span', { class: 'muted' }, 'Checking...'));
  let checks;
  try { ({ checks } = await api(`/api/checks${fresh ? '?fresh=1' : ''}`)); } catch (e) {
    box.replaceChildren(h('span', { class: 'muted' }, e.message)); return;
  }
  box.replaceChildren(
    ...checks.map((c) => h('div', { class: `check ${c.ok ? 'ok' : c.needed ? 'bad' : 'warn'}` },
      h('span', { class: 'mark' }, c.ok ? '✓' : c.needed ? '✗' : '!'),
      h('div', {},
        h('b', {}, c.name), ' ', h('span', { class: 'muted' }, c.detail),
        !c.ok && c.fix && h('div', { class: 'fix' }, c.fix),
        !c.ok && c.name === 'Grok message delivery'
          && h('button', { class: 'small', onclick: installGrokHooks }, 'Install Grok hooks')))),
    h('button', { class: 'small', onclick: () => renderChecks(box, true) }, 'Check again'));
}

async function installGrokHooks() {
  if (!confirm('Install agent-org hooks for Grok in your Grok settings folder (~/.grok/hooks)? '
    + 'They only act inside agent-org tabs.')) return;
  await act(api('/api/install-grok-hooks', {}), () => 'Grok hooks installed.');
  renderChecks($('#home-checks'), true);
}

$('#checks-btn').addEventListener('click', () => {
  const box = h('div', { class: 'checks' });
  showInfo('Setup check', h('p', { class: 'muted' }, 'agent-org drives these programs. Anything marked ✗ needs fixing before the agents that use it can start.'), box);
  renderChecks(box);
});

// ---------- the law ----------

$('#law-btn').addEventListener('click', async () => {
  const { law } = await api('/api/law');
  showInfo('The message law',
    h('p', { class: 'muted' }, 'Every agent works under these rules. The hub enforces them, and reminds agents of what they still owe.'),
    h('ol', { class: 'law' }, law.map((l) => h('li', {}, h('b', {}, l.title), ' ', l.rule))));
});

// ---------- first-run guide ----------

function renderGuide() {
  const st = S.state;
  const running = st.roles.some((r) => r.online);
  const talked = st.tasks.some((t) => t.assigner === st.owner) || S.messages.some((m) => m.sender === st.owner);
  const steps = [
    { done: true, text: 'Check the team in "Edit team": who reports to whom, and which model each role uses.' },
    { done: running, text: 'Click "Launch team". Each agent opens in its own terminal tab. The first time, '
      + 'say yes when Claude or Codex asks to trust the folder, and choose "Trust all and continue" when '
      + 'Codex asks to review hooks.' },
    { done: talked, text: `Give ${st.leader} a task: open the Board and click "New task". Say what "done" means, `
      + 'so the result can be checked.' },
  ];
  const g = $('#guide');
  g.hidden = steps.every((s) => s.done);
  g.replaceChildren(h('b', {}, 'Getting started'),
    h('ol', {}, steps.map((s) => h('li', { class: s.done ? 'done' : '' }, s.text))));
}

// ---------- org chart ----------

function renderChart() {
  const st = S.state;
  const sub = (name) => {
    const kids = rolesUnder(name);
    return kids.length ? h('ul', {}, kids.map((r) => h('li', {}, roleCard(r), sub(r.name)))) : null;
  };
  const owner = h('div', {
    class: 'node owner', title: 'Messages to you',
    onclick: () => { showTab('messages'); setFilter('me'); },
  },
  h('div', { class: 'name', style: { justifyContent: 'center' } },
    h('span', { class: 'nm' }, st.owner), st.owner_unread ? h('span', { class: 'badge' }, st.owner_unread) : null),
  h('div', { class: 'model' }, 'owner (you)'));
  $('#chart').replaceChildren(h('li', {}, owner, sub(st.owner)));
}

function roleCard(r) {
  const s = r.status;
  const cls = ['node', `h-${r.harness}`, r.tier && 'consultant', S.selected === r.name && 'selected'];
  return h('div', { class: cls.filter(Boolean).join(' '), title: r.duties || '', onclick: () => openDrawer(r.name) },
    h('div', { class: 'name' }, h('span', { class: 'nm' }, r.name), h('span', { class: 'harness' }, r.harness)),
    h('div', { class: 'model' }, modelLine(r)),
    r.tier && h('div', {}, h('span', { class: 'tag' }, `consultant · ${r.tier} · #${r.help_id}`)),
    h('div', {},
      h('span', { class: `state ${s ? s.state : ''}` }, s ? s.state : 'not started'),
      s && h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '6px' } }, ago(s.updated_at))),
    s && s.task && h('div', { class: 'task' }, s.task),
    r.stuck && h('div', { class: `stuck-badge ${r.stuck.kind}`, title: r.stuck.text }, r.stuck.describe),
    h('div', { class: 'meta' },
      runningEl(r),
      r.open_tasks ? h('span', { class: 'hot' }, plural(r.open_tasks, 'task')) : null,
      h('span', { class: r.unread ? 'hot' : '' }, `${r.unread} unread`),
      r.locks.length ? h('span', {}, plural(r.locks.length, 'file')) : null,
      r.usage && h('span', { title: usageText(r.usage) }, shortUsage(r.usage))));
}

function fmtNum(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

function usageText(u) {
  if (!u.tokens_in && !u.tokens_out) return `${u.messages} messages${u.model ? ` · ${u.model}` : ''}`;
  return `${fmtNum(u.tokens_in)} in · ${fmtNum(u.tokens_cached)} cached · ${fmtNum(u.tokens_out)} out`
    + ` · ${plural(u.messages, 'reply')}${u.model ? ` · ${u.model}` : ''}`;
}

const shortUsage = (u) => (u.tokens_in || u.tokens_out ? `${fmtNum(u.tokens_in + u.tokens_out)} tok` : `${u.messages} msg`);

function runningEl(r) {
  if (!r.online) return h('span', { class: 'run off', title: 'No session of this role is running' }, 'not running');
  if (r.online > 1) {
    return h('span', { class: 'run dup', title: 'Several sessions share this role and split its messages. Stop it and start it again.' },
      `${r.online} sessions!`);
  }
  return h('span', { class: 'run on', title: 'Its session is running' }, 'running');
}

// ---------- role drawer ----------

function openDrawer(name) {
  S.selected = name;
  renderDrawer();
  renderChart();
}

function closeDrawer() {
  S.selected = null;
  $('#drawer').hidden = true;
  if (S.state) renderChart();
}

function renderDrawer() {
  const r = findRole(S.selected);
  if (!r) { closeDrawer(); return; } // a consultant that was dismissed
  const s = r.status;
  const recent = S.messages.filter((m) => m.sender === r.name || m.recipient === r.name).slice(-30);
  const tasks = S.state.tasks.filter((t) => t.assignee === r.name).slice(-10).reverse();
  const u = r.usage;
  const subs = rolesUnder(r.name).map((x) => x.name);
  const launchable = S.state.launchable.includes(r.harness);
  $('#drawer').replaceChildren(
    h('header', {},
      h('span', { class: `harness h-${r.harness}` }, r.harness),
      h('h2', {}, r.name),
      h('button', { class: 'small', title: 'Close', onclick: closeDrawer }, '✕')),
    h('div', { class: 'body' },
      h('div', { class: 'actions' },
        !r.tier && h('button', { class: 'primary', onclick: () => { closeDrawer(); openNewTask(r.name); } }, 'Give a task'),
        h('button', { onclick: () => composeTo(r.name, 'message') }, 'Message'),
        launchable && !r.online && h('button', { onclick: () => startRole(r) },
          r.resumes ? 'Start (resume)' : 'Start'),
        launchable && r.online > 0 && r.stuck && h('button', { class: 'primary', onclick: () => restartRole(r.name) }, 'Restart'),
        r.stuck && r.open_tasks > 0 && h('button', { onclick: () => openMoveTasks(r.name) }, 'Move its tasks'),
        launchable && r.online > 0 && h('button', { class: 'danger', onclick: () => stopRoles(r.name) }, 'Stop'),
        launchable && h('button', { onclick: () => startFresh(r) }, 'Start fresh'),
        r.tier && h('button', { class: 'danger', onclick: () => dismiss(r.name) }, 'Dismiss consultant')),
      h('dl', {},
        h('dt', {}, 'Session'), h('dd', {}, runningEl(r), ' ',
          h('span', { class: 'muted' }, r.resumes ? '· next start resumes its conversation' : '· next start begins a new conversation')),
        r.stuck && [h('dt', {}, 'Stuck'), h('dd', {}, h('span', { class: `stuck-badge ${r.stuck.kind}` }, r.stuck.describe),
          r.stuck.kind === 'limit' && h('div', { class: 'muted small' }, r.stuck.text))],
        h('dt', {}, 'Status'),
        h('dd', {}, s
          ? [h('span', { class: `state ${s.state}` }, s.state), s.task ? ` - ${s.task}` : '',
            h('div', { class: 'muted', style: { fontSize: '12px' } }, `updated ${ago(s.updated_at)}`)]
          : 'not started'),
        h('dt', {}, 'Superior'), h('dd', {}, r.superior),
        h('dt', {}, 'Subordinates'), h('dd', {}, subs.join(', ') || '-'),
        h('dt', {}, 'Model'), h('dd', {}, modelLine(r)),
        u && [h('dt', {}, 'Used'), h('dd', {}, usageText(u), u.limits.length ? h('div', { class: 'muted small' }, u.limits.join(' · ')) : null)],
        r.tier
          ? [h('dt', {}, 'Consultant'), h('dd', {}, `${r.tier} tier, helping with #${r.help_id}`)]
          : [h('dt', {}, 'Write scope'), h('dd', { class: 'mono' }, r.write_scope.join(', ') || 'nothing')],
        r.duties && [h('dt', {}, 'Duties'), h('dd', {}, r.duties)]),
      h('h3', {}, `Tasks (${r.open_tasks} open)`),
      tasks.length ? tasks.map((t) => taskEl(t)) : h('div', { class: 'muted' }, 'No tasks yet.'),
      h('h3', {}, `Files (${r.locks.length})`),
      r.locks.length
        ? r.locks.map((p) => h('div', { class: 'lock-row' },
          h('span', { class: 'mono' }, p), h('button', { class: 'small', onclick: () => release(p) }, 'Release')))
        : h('div', { class: 'muted' }, 'Not writing any file.'),
      r.notes && [h('h3', {}, 'Its notes'), h('div', { class: 'notes' }, r.notes)],
      h('h3', {}, 'Recent messages'),
      recent.length ? recent.map((m) => messageEl(m, true)) : h('div', { class: 'muted' }, 'No messages yet.')));
  $('#drawer').hidden = false;
}

function startFresh(r) {
  if (!confirm(`Start ${r.name} with a new, empty conversation?\n\nIt keeps its notes, tasks and messages in the hub, `
    + 'but forgets the conversation it had. Usually "Start" (resume) is what you want.')) return;
  launchRoles([r.name], r.online > 0, true);
}

// ---------- messages ----------

function addMessages(list) {
  const feed = $('#feed');
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  for (const m of list) {
    S.messages.push(m);
    S.lastId = Math.max(S.lastId, m.id);
  }
  notifyOwner(list);
  if (S.state) {
    renderFeed(atBottom ? 'bottom' : null);
    renderGuide();
  }
  if (S.selected) renderDrawer();
}

function notifyOwner(list) {
  const mine = list.filter((m) => m.recipient === S.state?.owner && !m.read && m.id > S.notified);
  if (!mine.length) return;
  const first = S.notified === 0;
  S.notified = Math.max(...mine.map((m) => m.id));
  if (first || !document.hidden) return; // don't ring for what was there at load, or while you are looking
  try {
    if (Notification.permission === 'granted') {
      const m = mine[mine.length - 1];
      new Notification(`agent-org: ${m.kind === 'help' ? 'question' : 'message'} from ${m.sender}`,
        { body: m.text.slice(0, 180) });
    }
  } catch { /* notifications unavailable */ }
}

function visible(m) {
  if (S.filter === 'me' && m.recipient !== S.state.owner) return false;
  if (S.filter === 'work' && !['task', 'result', 'help'].includes(m.kind)) return false;
  if (S.roleFilter && m.sender !== S.roleFilter && m.recipient !== S.roleFilter) return false;
  return true;
}

function renderFeed(scroll) {
  if ($('#search').value.trim()) return; // showing search results
  const feed = $('#feed');
  const shown = S.messages.filter(visible);
  const empty = S.messages.length
    ? 'No messages match this filter.'
    : 'No messages yet. Launch the team, then give your leader a task below.';
  feed.replaceChildren(...(shown.length ? shown.map((m) => messageEl(m)) : [h('div', { class: 'empty' }, empty)]));
  if (scroll === 'bottom') feed.scrollTop = feed.scrollHeight;
}

const KIND_LABEL = {
  instruction: 'instruction', report: 'report', help: 'help request', peer: 'peer',
  task: 'task', result: 'result', reply: 'reply', notice: 'hub notice',
};

function messageEl(m, compact = false) {
  const toMe = m.recipient === S.state.owner;
  const long = m.text.length > 600 || m.text.split('\n').length > 8;
  const text = h('div', { class: 'text' + (long ? ' clamped' : '') }, m.text);
  const cls = ['msg', m.kind, toMe && 'to-me', toMe && !m.read && 'unread', m.urgent && 'urgent'];
  return h('div', { class: cls.filter(Boolean).join(' '), id: compact ? null : `m${m.id}` },
    h('div', { class: 'head' },
      h('span', { class: 'kind' }, KIND_LABEL[m.kind] || m.kind),
      m.urgent && h('span', { class: 'urgent-tag' }, 'urgent'),
      h('b', {}, m.sender), '→', h('b', {}, m.recipient),
      m.reply_to && h('button', { class: 'link', onclick: () => jumpTo(m.reply_to) }, `re #${m.reply_to}`),
      h('span', { class: 'right' }, `#${m.id} · ${fmtTime(m.sent_at)}`)),
    text,
    long && h('button', {
      class: 'link', style: { fontSize: '12px' },
      onclick: (e) => {
        text.classList.toggle('clamped');
        e.target.textContent = text.classList.contains('clamped') ? 'Show more' : 'Show less';
      },
    }, 'Show more'),
    !compact && toMe && h('div', { class: 'acts' },
      h('button', { class: 'small', onclick: () => replyTo(m) }, 'Reply'),
      m.kind === 'help' && S.state.tiers.length
        && h('button', { class: 'small', onclick: () => openSummon(m) }, 'Summon consultant')));
}

function jumpTo(id) {
  showTab('messages');
  setFilter('all');
  S.roleFilter = '';
  $('#filter-role').value = '';
  renderFeed();
  const el = document.getElementById(`m${id}`);
  if (el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.animate([{ outline: '2px solid var(--accent)' }, { outline: '2px solid transparent' }], 1600);
  }
}

function setFilter(f) {
  S.filter = f;
  for (const b of document.querySelectorAll('#filter-seg button')) b.classList.toggle('active', b.dataset.filter === f);
  renderFeed('bottom');
}

function renderRoleFilter() {
  const sel = $('#filter-role');
  const keep = S.roleFilter;
  sel.replaceChildren(h('option', { value: '' }, 'All roles'),
    ...S.state.roles.map((r) => h('option', { value: r.name }, r.name)));
  sel.value = findRole(keep) ? keep : '';
  S.roleFilter = sel.value;
}

function renderRecipients() {
  const sel = $('#to');
  const keep = sel.value || S.state.leader;
  const task = S.compose === 'task';
  sel.replaceChildren(
    ...S.state.roles.filter((r) => !(task && r.tier)).map((r) =>
      h('option', { value: r.name }, `To ${r.name}${r.tier ? ' (consultant)' : r.name === S.state.leader ? ' (leader)' : ''}`)),
    !task && h('option', { value: '@all' }, 'To everyone'));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : S.state.leader;
}

function renderInboxBadge() {
  const n = S.state.owner_unread;
  $('#inbox-badge').textContent = n;
  $('#inbox-badge').hidden = !n;
  $('#mark-read').hidden = !n;
  document.title = n ? `(${n}) agent-org` : 'agent-org';
}

function setCompose(mode) {
  S.compose = mode;
  for (const b of document.querySelectorAll('#mode-seg button')) b.classList.toggle('active', b.dataset.mode === mode);
  const task = mode === 'task';
  $('#task-title').hidden = !task;
  $('#task-done').hidden = !task;
  $('#urgent-wrap').hidden = task;
  $('#text').placeholder = task
    ? 'Details: everything they need to do it (optional)'
    : 'Write to your team... (Ctrl+Enter to send)';
  $('#composer-hint').textContent = task
    ? 'They must close it with a result: done or blocked.'
    : 'Every message wakes its receiver: say it once, say it all.';
  $('#send-btn').textContent = task ? 'Give task' : 'Send';
  if (task) clearReply();
  if (S.state) renderRecipients();
}

function composeTo(name, mode) {
  closeDrawer();
  showView('team');
  showTab('messages');
  clearReply();
  setCompose(mode);
  $('#to').value = name;
  (mode === 'task' ? $('#task-title') : $('#text')).focus();
}

function replyTo(m) {
  setCompose('message');
  S.replyTo = m.id;
  $('#to').value = m.sender;
  const chip = $('#reply-chip');
  chip.firstElementChild.textContent = `Replying to #${m.id}`;
  chip.hidden = false;
  $('#text').focus();
}

function clearReply() {
  S.replyTo = null;
  $('#reply-chip').hidden = true;
}

// ---------- tasks ----------

function taskEl(t) {
  const label = t.state === 'done' ? 'review' : t.state;
  return h('button', { class: `taskc ${t.state}`, onclick: () => openTask(t.id) },
    h('div', { class: 'head' },
      h('span', { class: `tstate ${t.state}` }, label),
      h('b', {}, `#${t.id} ${t.title}`)),
    h('div', { class: 'muted small' }, `from ${t.assigner} · ${ago(t.created_at)}`),
    t.result && h('div', { class: `result ${t.state}` }, t.result));
}

// ---------- files ----------

function renderLocks() {
  const locks = S.state.locks;
  $('#files-count').textContent = locks.length ? `(${locks.length})` : '';
  $('#locks').replaceChildren(...(locks.length
    ? locks.map((l) => h('tr', {},
      h('td', { class: 'mono' }, l.path), h('td', {}, l.owner), h('td', { class: 'muted' }, fmtTime(l.claimed_at)),
      h('td', {}, h('button', { class: 'small', onclick: () => release(l.path) }, 'Release'))))
    : [h('tr', {}, h('td', { colspan: 4, class: 'empty' }, 'Nobody is writing any file.'))]));
}

// ---------- actions ----------

function launchRoles(roles, force = false, fresh = false) {
  askNotifications();
  return act(api('/api/launch', { roles, force, fresh }), (r) =>
    (r.opening.length ? `Opening: ${r.opening.join(', ')}` : 'Nothing to open.')
    + (r.skipped.length ? `\nSkipped: ${r.skipped.join('; ')}` : ''));
}

function startRole(r) {
  if (r.stuck?.kind === 'limit' && r.stuck.until > Date.now() / 1000
    && !confirm(`${r.name} is ${r.stuck.describe}; it will fail again until then. Start it anyway?`)) return;
  launchRoles([r.name]);
}

function restartRole(name) {
  if (!confirm(`Restart ${name}? Its program is stopped and started again on the same conversation, `
    + 'and it carries on with its work.')) return;
  act(api('/api/restart', { role: name }), (r) => (r.opening.length ? `Restarting ${name}.` : `Could not start ${name}: ${r.skipped.join('; ')}`));
}

function stopRoles(role) {
  const what = role === '@all' ? 'every running agent' : role;
  if (!confirm(`Stop ${what}? Its conversation is kept: "Start" resumes it later.`)) return;
  act(api('/api/stop', { role }), (r) => {
    const n = Object.values(r.stopped).reduce((a, b) => a + b, 0);
    return n ? `Stopped ${plural(n, 'agent')}.` : 'Nothing was running.';
  });
}

function release(path) {
  if (!confirm(`Release ${path}? Whoever holds it can no longer write it.`)) return;
  act(api('/api/release', { path }), (l) => `Released ${l.path}.`);
}

function dismiss(name) {
  if (!confirm(`Dismiss ${name}? Its files go back to the agent it helps.`)) return;
  act(api('/api/dismiss', { name }), (r) =>
    `Dismissed ${r.name}.` + (r.returned.length ? ` Files returned: ${r.returned.join(', ')}` : ''));
}

function askNotifications() {
  try {
    if (Notification.permission === 'default') Notification.requestPermission();
  } catch { /* not supported */ }
}

function openSummon(m) {
  S.summonFor = m;
  $('#summon-quote').textContent = `#${m.id} from ${m.sender}:\n${m.text}`;
  const tiers = S.state.tiers;
  const firstFree = tiers.find((t) => t.active < t.max_active);
  $('#summon-tiers').replaceChildren(...tiers.map((t) => {
    const full = t.active >= t.max_active;
    return h('label', { class: 'tier' + (full ? ' full' : '') },
      h('input', { type: 'radio', name: 'tier', value: t.name, checked: t === firstFree, disabled: full }),
      h('span', {}, h('b', {}, t.name), ' ', h('span', { class: `harness h-${t.harness}` }, t.harness)),
      h('small', {}, `${modelLine(t)} · ${t.active}/${t.max_active} busy${t.use_for ? ` · ${t.use_for}` : ''}`));
  }));
  $('#summon-brief').value = '';
  $('#summon').returnValue = '';
  $('#summon').showModal();
}

$('#summon form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'ok') return;
  const tier = document.querySelector('#summon-tiers input:checked')?.value;
  if (!tier) { toast('Pick a tier first.', true); return; }
  act(api('/api/summon', { help_id: S.summonFor.id, tier, brief: $('#summon-brief').value }),
    (r) => `Summoned ${r.name} under ${r.superior}. Its tab is opening.`);
});

// ---------- views & tabs ----------

function showView(v) {
  for (const b of document.querySelectorAll('.views button')) b.classList.toggle('active', b.dataset.view === v);
  $('#view-team').hidden = v !== 'team';
  $('#view-board').hidden = v !== 'board';
  $('#view-editor').hidden = v !== 'editor';
  $('#launch-all').hidden = v === 'editor';
  $('#stop-all').hidden = v === 'editor';
  if (v === 'editor') { closeDrawer(); if (!E.draft) loadEditor(); }
}

function showTab(t) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === t);
  $('#tab-messages').hidden = t !== 'messages';
  $('#tab-activity').hidden = t !== 'activity';
  $('#tab-files').hidden = t !== 'files';
}

for (const b of document.querySelectorAll('.views button')) b.addEventListener('click', () => showView(b.dataset.view));
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
for (const b of document.querySelectorAll('#filter-seg button')) b.addEventListener('click', () => setFilter(b.dataset.filter));
for (const b of document.querySelectorAll('#mode-seg button')) b.addEventListener('click', () => setCompose(b.dataset.mode));
$('#filter-role').addEventListener('change', (e) => { S.roleFilter = e.target.value; renderFeed('bottom'); });
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(async () => {
    if (!q) { renderFeed('bottom'); return; }
    try {
      const { messages } = await api(`/api/search?q=${encodeURIComponent(q)}`);
      $('#feed').replaceChildren(h('div', { class: 'muted small' }, `${plural(messages.length, 'message')} with "${q}"`),
        ...messages.map((m) => messageEl(m)));
    } catch (err) { toast(err.message, true); }
  }, 250);
});
$('#reply-chip button').addEventListener('click', clearReply);
$('#mark-read').addEventListener('click', () => act(api('/api/inbox/read', {}), () => {
  for (const m of S.messages) if (m.recipient === S.state.owner) m.read = true;
  renderFeed();
  return 'Marked as read.';
}));
$('#launch-all').addEventListener('click', () => {
  if (confirm('Start every agent that is not running yet? Each resumes its last conversation.')) launchRoles([]);
});
$('#stop-all').addEventListener('click', () => stopRoles('@all'));
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const to = $('#to').value;
  const text = $('#text').value.trim();
  if (S.compose === 'task') {
    const title = $('#task-title').value.trim();
    if (!title) { toast('Give the task a one-line title.', true); return; }
    act(api('/api/task', { to, title, details: text, done_when: $('#task-done').value }).then((t) => {
      $('#task-title').value = '';
      $('#task-done').value = '';
      $('#text').value = '';
      return t;
    }), (t) => `Task #${t.id} given to ${t.assignee}.`);
    return;
  }
  if (!text) return;
  act(api('/api/send', { to, text, reply_to: S.replyTo, urgent: $('#urgent').checked }).then((r) => {
    $('#text').value = '';
    $('#urgent').checked = false;
    clearReply();
    return r;
  }));
});
$('#text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#composer').requestSubmit();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });

// ---------- start ----------

if (!TOKEN) showBlocker();
else poll();
