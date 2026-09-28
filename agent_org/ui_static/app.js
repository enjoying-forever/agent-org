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

const TOKEN = (() => {
  const fromUrl = new URLSearchParams(location.search).get('token');
  try {
    if (fromUrl) sessionStorage.setItem('agent-org-token', fromUrl);
    else return sessionStorage.getItem('agent-org-token') || '';
  } catch { /* storage can be unavailable; the URL token still works for this load */ }
  return fromUrl || '';
})();
if (new URLSearchParams(location.search).has('token')) history.replaceState(null, '', '/');

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
  toastTimer = setTimeout(() => { t.hidden = true; }, error ? 7000 : 4000);
}

function showBlocker() {
  const b = $('#blocker');
  b.replaceChildren(h('div', {},
    h('h2', {}, 'This page needs its access link'),
    h('p', { class: 'muted' }, 'Open the link printed in the agent-org UI window (it ends with ?token=...).')));
  b.hidden = false;
}

// ---------- state & polling ----------

const S = {
  state: null, stateKey: '', messages: [], lastId: 0,
  filter: 'all', roleFilter: '', replyTo: null, selected: null, summonFor: null,
};

async function refresh() {
  try {
    const [state, fresh] = await Promise.all([api('/api/state'), api(`/api/messages?after=${S.lastId}`)]);
    setConn(true);
    applyState(state);
    if (fresh.messages.length) addMessages(fresh.messages);
  } catch (e) {
    setConn(false, e.message);
  }
}

async function poll() {
  await refresh();
  setTimeout(poll, 1500);
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
  renderLocks();
  renderRecipients();
  renderRoleFilter();
  renderInboxBadge();
  if (S.selected) renderDrawer();
  if (first) renderFeed('bottom');
}

const rolesUnder = (name) => S.state.roles.filter((r) => r.superior === name);
const findRole = (name) => S.state.roles.find((r) => r.name === name);

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
    h('div', { class: 'meta' },
      h('span', { class: r.unread ? 'hot' : '' }, `${r.unread} unread`),
      h('span', {}, plural(r.locks.length, 'file'))));
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
  const subs = rolesUnder(r.name).map((x) => x.name);
  $('#drawer').replaceChildren(
    h('header', {},
      h('span', { class: `harness h-${r.harness}` }, r.harness),
      h('h2', {}, r.name),
      h('button', { class: 'small', title: 'Close', onclick: closeDrawer }, '✕')),
    h('div', { class: 'body' },
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: () => messageTo(r.name) }, 'Message'),
        S.state.launchable.includes(r.harness)
          && h('button', { onclick: () => launchRoles([r.name]) }, 'Open terminal tab'),
        r.tier && h('button', { class: 'danger', onclick: () => dismiss(r.name) }, 'Dismiss consultant')),
      h('dl', {},
        h('dt', {}, 'Status'),
        h('dd', {}, s
          ? [h('span', { class: `state ${s.state}` }, s.state), s.task ? ` - ${s.task}` : '',
            h('div', { class: 'muted', style: { fontSize: '12px' } }, `updated ${ago(s.updated_at)}`)]
          : 'not started'),
        h('dt', {}, 'Superior'), h('dd', {}, r.superior),
        h('dt', {}, 'Subordinates'), h('dd', {}, subs.join(', ') || '-'),
        h('dt', {}, 'Model'), h('dd', {}, modelLine(r)),
        r.tier
          ? [h('dt', {}, 'Consultant'), h('dd', {}, `${r.tier} tier, helping with #${r.help_id}`)]
          : [h('dt', {}, 'Write scope'), h('dd', { class: 'mono' }, r.write_scope.join(', ') || 'nothing')],
        r.duties && [h('dt', {}, 'Duties'), h('dd', {}, r.duties)]),
      h('h3', {}, `Files (${r.locks.length})`),
      r.locks.length
        ? r.locks.map((p) => h('div', { class: 'lock-row' },
          h('span', { class: 'mono' }, p), h('button', { class: 'small', onclick: () => release(p) }, 'Release')))
        : h('div', { class: 'muted' }, 'Not writing any file.'),
      h('h3', {}, 'Recent messages'),
      recent.length ? recent.map((m) => messageEl(m, true)) : h('div', { class: 'muted' }, 'No messages yet.')));
  $('#drawer').hidden = false;
}

// ---------- messages ----------

function addMessages(list) {
  const feed = $('#feed');
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  for (const m of list) {
    S.messages.push(m);
    S.lastId = Math.max(S.lastId, m.id);
  }
  if (S.state) renderFeed(atBottom ? 'bottom' : null);
  if (S.selected) renderDrawer();
}

function visible(m) {
  if (S.filter === 'me' && m.recipient !== S.state.owner) return false;
  if (S.filter === 'help' && m.kind !== 'help') return false;
  if (S.roleFilter && m.sender !== S.roleFilter && m.recipient !== S.roleFilter) return false;
  return true;
}

function renderFeed(scroll) {
  const feed = $('#feed');
  const shown = S.messages.filter(visible);
  const empty = S.messages.length
    ? 'No messages match this filter.'
    : 'No messages yet. Launch the team, then give your leader a task below.';
  feed.replaceChildren(...(shown.length ? shown.map((m) => messageEl(m)) : [h('div', { class: 'empty' }, empty)]));
  if (scroll === 'bottom') feed.scrollTop = feed.scrollHeight;
}

const KIND_LABEL = { instruction: 'instruction', report: 'report', help: 'help request' };

function messageEl(m, compact = false) {
  const toMe = m.recipient === S.state.owner;
  const long = m.text.length > 600 || m.text.split('\n').length > 8;
  const text = h('div', { class: 'text' + (long ? ' clamped' : '') }, m.text);
  const cls = ['msg', m.kind, toMe && 'to-me', toMe && !m.read && 'unread'];
  return h('div', { class: cls.filter(Boolean).join(' '), id: compact ? null : `m${m.id}` },
    h('div', { class: 'head' },
      h('span', { class: 'kind' }, KIND_LABEL[m.kind] || m.kind),
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
  sel.replaceChildren(...S.state.roles.map((r) =>
    h('option', { value: r.name }, `To ${r.name}${r.tier ? ' (consultant)' : r.name === S.state.leader ? ' (leader)' : ''}`)));
  sel.value = findRole(keep) ? keep : S.state.leader;
}

function renderInboxBadge() {
  const n = S.state.owner_unread;
  $('#inbox-badge').textContent = n;
  $('#inbox-badge').hidden = !n;
  $('#mark-read').hidden = !n;
}

function replyTo(m) {
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

function messageTo(name) {
  closeDrawer();
  showView('team');
  showTab('messages');
  clearReply();
  $('#to').value = name;
  $('#text').focus();
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

function launchRoles(roles) {
  return act(api('/api/launch', { roles }), (r) =>
    (r.opening.length ? `Opening: ${r.opening.join(', ')}` : 'Nothing to open.')
    + (r.skipped.length ? `\nSkipped: ${r.skipped.join('; ')}` : ''));
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

$('#summon').addEventListener('close', () => {
  if ($('#summon').returnValue !== 'ok') return;
  const tier = document.querySelector('#summon-tiers input:checked')?.value;
  if (!tier) { toast('Pick a tier first.', true); return; }
  act(api('/api/summon', { help_id: S.summonFor.id, tier, brief: $('#summon-brief').value }),
    (r) => `Summoned ${r.name} under ${r.superior}. Its tab is opening.`);
});

// ---------- views & tabs ----------

function showView(v) {
  for (const b of document.querySelectorAll('.views button')) b.classList.toggle('active', b.dataset.view === v);
  $('#view-team').hidden = v !== 'team';
  $('#view-editor').hidden = v !== 'editor';
  $('#launch-all').hidden = v !== 'team';
  if (v === 'editor') { closeDrawer(); if (!E.draft) loadEditor(); }
}

function showTab(t) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === t);
  $('#tab-messages').hidden = t !== 'messages';
  $('#tab-files').hidden = t !== 'files';
}

for (const b of document.querySelectorAll('.views button')) b.addEventListener('click', () => showView(b.dataset.view));
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
for (const b of document.querySelectorAll('#filter-seg button')) b.addEventListener('click', () => setFilter(b.dataset.filter));
$('#filter-role').addEventListener('change', (e) => { S.roleFilter = e.target.value; renderFeed('bottom'); });
$('#reply-chip button').addEventListener('click', clearReply);
$('#mark-read').addEventListener('click', () => act(api('/api/inbox/read', {}), () => {
  for (const m of S.messages) if (m.recipient === S.state.owner) m.read = true;
  renderFeed();
  return 'Marked as read.';
}));
$('#launch-all').addEventListener('click', () => {
  if (confirm('Open a terminal tab for every role in team.yaml?')) launchRoles([]);
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#text').value.trim();
  if (!text) return;
  act(api('/api/send', { to: $('#to').value, text, reply_to: S.replyTo }).then((r) => {
    $('#text').value = '';
    clearReply();
    return r;
  }));
});
$('#text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#composer').requestSubmit();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });

// ---------- team editor ----------

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const E = { draft: null, meta: null, dirty: false };

function toDraft(config) {
  const { owner = 'you', project_root = '.', roles = {}, consultants = {}, ...extra } = config || {};
  return {
    owner: String(owner),
    project_root: String(project_root),
    extra,
    roles: Object.entries(roles || {}).map(([name, r]) => ({
      name, superior: r.superior ?? '', harness: r.harness ?? 'claude', model: r.model ?? '',
      effort: r.effort ?? '', duties: r.duties ?? '', write_scope: (r.write_scope || []).join(', '),
    })),
    tiers: Object.entries(consultants || {}).map(([name, t]) => ({
      name, harness: t.harness ?? 'claude', model: t.model ?? '', effort: t.effort ?? '',
      max_active: t.max_active ?? 1, use_for: t.use_for ?? '',
    })),
  };
}

function fromDraft(d) {
  const roles = {};
  for (const r of d.roles) {
    const spec = { superior: r.superior, harness: r.harness };
    if (String(r.model).trim()) spec.model = String(r.model).trim();
    if (String(r.effort).trim()) spec.effort = String(r.effort).trim();
    if (r.duties.trim()) spec.duties = r.duties.trim();
    spec.write_scope = r.write_scope.split(',').map((s) => s.trim()).filter(Boolean);
    roles[r.name.trim()] = spec;
  }
  const config = { owner: d.owner.trim(), project_root: d.project_root.trim() || '.', ...d.extra, roles };
  if (d.tiers.length) {
    config.consultants = {};
    for (const t of d.tiers) {
      const spec = { harness: t.harness };
      if (String(t.model).trim()) spec.model = String(t.model).trim();
      if (String(t.effort).trim()) spec.effort = String(t.effort).trim();
      spec.max_active = Number(t.max_active) || 1;
      if (t.use_for.trim()) spec.use_for = t.use_for.trim();
      config.consultants[t.name.trim()] = spec;
    }
  }
  return config;
}

function validate(d) {
  const errs = [];
  if (!NAME_RE.test(d.owner)) errs.push('Your owner name must be a simple name, like "you".');
  const names = d.roles.map((r) => r.name.trim());
  names.forEach((n, i) => {
    if (!NAME_RE.test(n)) errs.push(`Role name "${n}" can only use letters, digits, - and _.`);
    else if (n.startsWith('consultant-')) errs.push(`"${n}": names starting with consultant- are kept for consultants.`);
    else if (n === d.owner) errs.push(`"${n}" is your owner name; pick another role name.`);
    else if (names.indexOf(n) !== i) errs.push(`Two roles are called "${n}".`);
  });
  for (const r of d.roles) {
    if (r.superior !== d.owner && !names.includes(r.superior)) errs.push(`${r.name}: choose a superior.`);
  }
  const leaders = d.roles.filter((r) => r.superior === d.owner);
  if (!d.roles.length) errs.push('Add at least one role.');
  else if (leaders.length === 0) errs.push('Choose a leader: exactly one role must report to you.');
  else if (leaders.length > 1) errs.push(`Only one role can report to you (the leader); now ${leaders.map((r) => r.name).join(', ')} do.`);
  for (const r of d.roles) {
    const seen = new Set([r.name]);
    let cur = r.superior;
    while (cur && cur !== d.owner) {
      if (seen.has(cur)) { errs.push(`${r.name}: its chain of superiors goes round in a circle.`); break; }
      seen.add(cur);
      cur = d.roles.find((x) => x.name === cur)?.superior;
    }
  }
  const tierNames = d.tiers.map((t) => t.name.trim());
  tierNames.forEach((n, i) => {
    if (!NAME_RE.test(n)) errs.push(`Consultant tier "${n}" can only use letters, digits, - and _.`);
    else if (tierNames.indexOf(n) !== i) errs.push(`Two consultant tiers are called "${n}".`);
  });
  for (const t of d.tiers) {
    if (!(Number(t.max_active) >= 1)) errs.push(`Tier ${t.name}: "at once" must be at least 1.`);
  }
  return [...new Set(errs)];
}

async function loadEditor() {
  try {
    const data = await api('/api/team');
    E.meta = data;
    E.draft = toDraft(data.config);
    E.dirty = false;
    renderEditor();
  } catch (e) {
    toast(e.message, true);
  }
}

function touch() {
  E.dirty = true;
  renderEditorSide();
}

/** A text input bound to obj[key]; editing it only refreshes the preview, so focus is kept. */
function bound(obj, key, props = {}) {
  return h('input', { value: obj[key], ...props, oninput: (e) => { obj[key] = e.target.value; touch(); } });
}

function harnessSelect(obj) {
  return h('select', { onchange: (e) => { obj.harness = e.target.value; touch(); renderEditor(); } },
    E.meta.harnesses.map((x) => h('option', { value: x, selected: x === obj.harness }, x)));
}

function datalists() {
  const lists = [];
  for (const hname of E.meta.harnesses) {
    lists.push(h('datalist', { id: `models-${hname}` }, (E.meta.models[hname] || []).map((m) => h('option', { value: m }))));
    lists.push(h('datalist', { id: `efforts-${hname}` }, (E.meta.efforts[hname] || []).map((m) => h('option', { value: m }))));
  }
  return lists;
}

function renderEditor() {
  const d = E.draft;
  const leader = d.roles.find((r) => r.superior === d.owner);
  const roleCards = d.roles.map((r) => {
    let before = r.name;
    return h('div', { class: `card role-card h-${r.harness}` },
      h('div', { class: 'title' },
        h('span', { class: 'harness' }, r.harness),
        h('b', {}, r.name || '(unnamed)'),
        r === leader ? h('span', { class: 'tag' }, 'leader') : h('button', { class: 'small', onclick: () => makeLeader(r) }, 'Make leader'),
        h('button', { class: 'small danger', onclick: () => removeRole(r) }, 'Remove')),
      h('div', { class: 'grid' },
        h('label', {}, 'Name', h('input', {
          value: r.name,
          oninput: (e) => { r.name = e.target.value; touch(); },
          onchange: () => { renameRefs(before, r.name.trim()); before = r.name.trim(); renderEditor(); },
        })),
        h('label', {}, 'Reports to', h('select', { onchange: (e) => { r.superior = e.target.value; touch(); renderEditor(); } },
          h('option', { value: d.owner, selected: r.superior === d.owner }, `${d.owner} (you)`),
          d.roles.filter((x) => x !== r).map((x) => h('option', { value: x.name, selected: r.superior === x.name }, x.name)),
          !d.roles.some((x) => x.name === r.superior) && r.superior !== d.owner
            ? h('option', { value: '', selected: true }, 'choose...') : null)),
        h('label', {}, 'Harness', harnessSelect(r)),
        h('label', {}, 'Model', bound(r, 'model', { list: `models-${r.harness}`, placeholder: 'harness default' })),
        h('label', {}, 'Effort', bound(r, 'effort', { list: `efforts-${r.harness}`, placeholder: 'default' })),
        h('label', { class: 'wide' }, 'Files it may write (comma separated, * matches anything)',
          bound(r, 'write_scope', { class: 'mono', placeholder: 'e.g. src/*, tests/*   (empty: edits nothing)' })),
        h('label', { class: 'wide' }, 'Duties', h('textarea', {
          rows: 2, value: r.duties, oninput: (e) => { r.duties = e.target.value; touch(); },
        }))));
  });
  const tierCards = d.tiers.map((t) => h('div', { class: `card role-card h-${t.harness}` },
    h('div', { class: 'title' },
      h('span', { class: 'harness' }, t.harness), h('b', {}, t.name || '(unnamed)'),
      h('button', { class: 'small danger', onclick: () => { d.tiers.splice(d.tiers.indexOf(t), 1); touch(); renderEditor(); } }, 'Remove')),
    h('div', { class: 'grid' },
      h('label', {}, 'Tier name', h('input', { value: t.name, oninput: (e) => { t.name = e.target.value; touch(); }, onchange: renderEditor })),
      h('label', {}, 'Harness', harnessSelect(t)),
      h('label', {}, 'Model', bound(t, 'model', { list: `models-${t.harness}`, placeholder: 'harness default' })),
      h('label', {}, 'Effort', bound(t, 'effort', { list: `efforts-${t.harness}`, placeholder: 'default' })),
      h('label', {}, 'At once (max)', bound(t, 'max_active', { type: 'number', min: 1 })),
      h('label', { class: 'wide' }, 'Use it for (the superior reads this to choose a tier)', bound(t, 'use_for')))));

  $('#editor').replaceChildren(
    ...datalists(),
    h('div', { class: 'card' },
      h('h2', {}, 'Team'),
      h('p', {}, `Saved to ${S.state?.team_file || 'team.yaml'}. Paths are relative to that file.`),
      h('div', { class: 'grid' },
        h('label', {}, 'Your name (the owner)', h('input', {
          value: d.owner,
          oninput: (e) => { const old = d.owner; d.owner = e.target.value; renameRefs(old, d.owner); touch(); },
          onchange: renderEditor,
        })),
        h('label', { class: 'wide' }, 'Project folder the agents work in', bound(d, 'project_root', { class: 'mono' })))),
    h('div', { class: 'section-head' },
      h('h2', {}, `Roles (${d.roles.length})`),
      h('button', { onclick: addRole }, '+ Add role')),
    h('p', { class: 'muted', style: { margin: '-8px 0 0' } },
      'Exactly one role reports to you: that is your leader. Use "Make leader" to switch. '
      + 'Put strong models high in the tree and cheaper ones at the leaves.'),
    ...roleCards,
    h('div', { class: 'section-head' },
      h('h2', {}, `Consultant tiers (${d.tiers.length})`),
      h('button', { onclick: addTier }, '+ Add tier')),
    h('p', { class: 'muted', style: { margin: '-8px 0 0' } },
      'When a subordinate asks for help, its superior can summon one of these as a temporary helper.'),
    ...tierCards);
  renderEditorSide();
}

function renderEditorSide() {
  const d = E.draft;
  const errs = validate(d);
  $('#errors').replaceChildren(...errs.map((e) => h('li', {}, e)));
  $('#save').disabled = errs.length > 0 || !E.dirty;
  $('#save').textContent = E.dirty ? 'Save team.yaml' : 'Saved';
  const sub = (name, depth) => {
    if (depth > 30) return null; // a cycle; the error list already says so
    const kids = d.roles.filter((r) => r.superior === name);
    return kids.length ? h('ul', {}, kids.map((r) => h('li', {},
      h('div', { class: `node h-${r.harness}` },
        h('div', { class: 'name' }, h('span', { class: 'nm' }, r.name || '?'), h('span', { class: 'harness' }, r.harness)),
        h('div', { class: 'model' }, modelLine(r))),
      sub(r.name, depth + 1)))) : null;
  };
  $('#preview').replaceChildren(h('li', {},
    h('div', { class: 'node owner' }, h('div', { class: 'name', style: { justifyContent: 'center' } }, h('span', { class: 'nm' }, d.owner)),
      h('div', { class: 'model' }, 'owner (you)')),
    sub(d.owner, 0)));
}

function renameRefs(from, to) {
  if (!from || from === to) return;
  for (const r of E.draft.roles) if (r.superior === from) r.superior = to;
}

function makeLeader(r) {
  const d = E.draft;
  for (const other of d.roles) if (other !== r && other.superior === d.owner) other.superior = r.name;
  r.superior = d.owner;
  touch();
  renderEditor();
}

function removeRole(r) {
  const d = E.draft;
  for (const other of d.roles) if (other.superior === r.name) other.superior = r.superior;
  d.roles.splice(d.roles.indexOf(r), 1);
  touch();
  renderEditor();
}

function addRole() {
  const d = E.draft;
  let n = d.roles.length + 1;
  while (d.roles.some((r) => r.name === `role-${n}`)) n += 1;
  const leader = d.roles.find((r) => r.superior === d.owner);
  d.roles.push({ name: `role-${n}`, superior: leader ? leader.name : d.owner, harness: 'codex',
    model: '', effort: '', duties: '', write_scope: '' });
  touch();
  renderEditor();
  $('#editor').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function addTier() {
  const d = E.draft;
  let n = d.tiers.length + 1;
  while (d.tiers.some((t) => t.name === `tier-${n}`)) n += 1;
  d.tiers.push({ name: `tier-${n}`, harness: 'claude', model: '', effort: '', max_active: 1, use_for: '' });
  touch();
  renderEditor();
}

$('#save').addEventListener('click', async () => {
  try {
    const r = await api('/api/team', { config: fromDraft(E.draft) });
    E.dirty = false;
    renderEditorSide();
    toast(`Saved. The old version is in ${r.backup.split(/[\\/]/).pop()}.`);
    refresh();
  } catch (e) {
    toast(e.message, true);
  }
});
$('#revert').addEventListener('click', () => {
  if (!E.dirty || confirm('Throw away your unsaved changes?')) loadEditor();
});
window.addEventListener('beforeunload', (e) => { if (E.dirty) e.preventDefault(); });

// ---------- start ----------

if (!TOKEN) showBlocker();
else poll();
