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

/**
 * A dropdown of known choices (models, effort levels), with "Other…" to type any name.
 * `onchange(value)` gets the chosen text ('' = the program's default); `.read()` returns it too.
 */
function choiceField(value, options, { blank = 'default', onchange = () => {} } = {}) {
  const OTHER = '\u0000other';
  value = value || '';
  const listed = !value || options.includes(value);
  const input = h('input', { value: listed ? '' : value, placeholder: 'type a name', hidden: listed,
    oninput: (e) => onchange(e.target.value.trim()) });
  const select = h('select', {
    onchange: (e) => {
      const other = e.target.value === OTHER;
      input.hidden = !other;
      if (other) input.focus();
      onchange(other ? input.value.trim() : e.target.value);
    },
  },
  h('option', { value: '', selected: !value }, blank),
  options.map((m) => h('option', { value: m, selected: m === value }, m)),
  h('option', { value: OTHER, selected: !listed }, 'Other…'));
  const box = h('span', { class: 'choice' }, select, input);
  box.read = () => (select.value === OTHER ? input.value.trim() : select.value);
  return box;
}

// Signing in happens before this page loads: the one-time link sets an HttpOnly cookie that
// no script (this one included) can read. Every request adds the page's own header.
const PAGE_HEADERS = { 'X-Agent-Org': '1' };

class NoTeam extends Error {}

async function api(path, body) {
  const post = body !== undefined;
  const res = await fetch(path, {
    method: post ? 'POST' : 'GET',
    headers: post ? { ...PAGE_HEADERS, 'Content-Type': 'application/json' } : PAGE_HEADERS,
    credentials: 'same-origin',
    body: post ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 403) { S.signedOut = true; showBlocker(); }
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
const modelLine = (x) => [x.model || 'default model', x.effort && `${x.effort} effort`].filter(Boolean).join(', ');

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
    h('h2', {}, 'This browser is not signed in to agent-org'),
    h('p', { class: 'muted' }, 'Click in the black agent-org window and press Enter: it prints a new sign-in '
      + 'link. Open it here. Each link works once, for two minutes.')));
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
  focus: null, // the agent pane in front (highlighted in the rail)
  drafts: {}, // what you are typing to each agent, kept across re-renders
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
  if (S.signedOut) return; // not signed in: stop asking; the sign-in link reloads the page
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
  const folder = state.project_root.split(/[\\/]/).filter(Boolean).pop() || state.project_root;
  $('#project').textContent = folder;
  $('#project').title = `project: ${state.project_root}\nteam file: ${state.team_file}`;
  if (!S.focus || !findRole(S.focus)) S.focus = state.leader;
  renderChart();
  renderPanes();
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
  $('#view-roles').hidden = true;
  $('#market-btn').hidden = true;
  for (const id of ['#views', '#conn', '#switch-btn', '#stop-all', '#launch-all']) $(id).hidden = false;
  showView('team');
}

function enterHome() {
  if (S.mode === 'home') return;
  S.mode = 'home';
  Object.assign(S, { state: null, stateKey: '', messages: [], lastId: 0, selected: null, notified: 0, focus: null, drafts: {} });
  if (typeof E !== 'undefined') E.draft = null;
  clearPanes();
  $('#drawer').hidden = true;
  resetActivity();
  for (const id of ['#view-team', '#view-board', '#view-editor', '#view-roles', '#views', '#conn', '#switch-btn',
    '#stop-all', '#launch-all', '#rail-toggle', '#side-toggle', '#layout-menu', '#attention-btn']) {
    $(id).hidden = true;
  }
  $('#market-btn').hidden = false;
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
  const buildChoice = h('label', { class: 'tier' },
    h('input', { type: 'radio', name: 'template', value: BUILD, checked: chosen === BUILD,
      onchange: () => renderBuilder() }),
    h('span', {}, h('b', {}, 'Build my own from the Role Market')),
    h('small', {}, 'Pick roles and place each under its superior. The first one leads.'));
  $('#templates').replaceChildren(buildChoice, ...home.templates.map((t) => h('label', { class: 'tier' },
    h('input', { type: 'radio', name: 'template', value: t.id, checked: t.id === chosen, onchange: () => renderBuilder() }),
    h('span', {}, h('b', {}, t.title), t.default ? h('span', { class: 'tag' }, 'default') : null,
      h('span', { class: 'muted' }, `  ${t.roles}`)),
    h('small', {}, t.summary,
      !t.default && h('button', { class: 'link', onclick: (e) => { e.preventDefault(); templateAction('default', t); } },
        ' Make default'),
      t.mine && h('button', { class: 'link', onclick: (e) => { e.preventDefault(); templateAction('delete', t); } },
        ' Delete')))));
  renderChecks($('#home-checks'));
  renderBuilder();
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
  const body = template === BUILD ? { folder, roles: builderRoles() } : { folder, template };
  if (template === BUILD && !body.roles.length) { toast('Pick at least one role from the market first.', true); return; }
  await act(api('/api/create', body), () => 'Team created. Check it in "Edit team", then Launch team.');
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
  const running = st.roles.some((r) => r.online || r.resumes); // launched now, or before (a conversation to resume)
  const talked = st.tasks.some((t) => t.assigner === st.owner) || S.messages.some((m) => m.sender === st.owner);
  const steps = [
    { done: true, text: 'Check the team in "Edit team": who reports to whom, and which model each role uses.' },
    { done: running, text: `Click "Launch team". ${st.in_window ? 'Each agent starts in its own terminal on this page' : 'Each agent opens in its own terminal tab'}. The first time, `
      + 'say yes when Claude or Codex asks to trust the folder, and choose "Trust all and continue" when '
      + 'Codex asks to review hooks.' },
    { done: talked, text: `Give ${st.leader} a task: open the Board and click "New task". Say what "done" means, `
      + 'so the result can be checked.' },
  ];
  const g = $('#guide');
  const key = `agent-org-guide-hidden:${st.team_file}`;
  let dismissed = false;
  try { dismissed = localStorage.getItem(key) === '1'; } catch { /* storage off: show it */ }
  g.hidden = dismissed || steps.every((s) => s.done);
  g.replaceChildren(
    h('div', { class: 'guide-head' }, h('b', {}, 'Getting started'),
      h('button', { class: 'small', title: 'Hide these steps for this team', onclick: () => {
        try { localStorage.setItem(key, '1'); } catch { /* shown again next load */ }
        g.hidden = true;
        updateAttention();
      } }, 'Hide')),
    h('ol', {}, steps.map((s) => h('li', { class: s.done ? 'done' : '' }, s.text))));
  updateAttention();
}

// ---------- icons (inline SVG, drawn with the text color) ----------

const ICON_PATHS = {
  play: 'M7 4.5v15l12-7.5z',
  stop: 'M6.5 6.5h11v11h-11z',
  restart: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  task: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  max: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  restore: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  close: 'M18 6 6 18M6 6l12 12',
  main: 'M3 3h11v18H3zM18 3h3M18 9h3M18 15h3M18 21h3',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
};

function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  const solid = name === 'play' || name === 'stop';
  path.setAttribute('fill', solid ? 'currentColor' : 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', name === 'more' ? '3.2' : '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

const iconBtn = (name, title, onclick, cls = '') =>
  h('button', { class: `icon-btn ${cls}`, title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); onclick(); } }, icon(name));

// ---------- the team rail ----------

const PROGRAM = { claude: 'Claude Code', codex: 'OpenAI Codex', grok: 'Grok', antigravity: 'Antigravity', deepseek: 'DeepSeek Harness' };
const GLYPH = { claude: 'C', codex: 'X', grok: 'G', antigravity: 'A', deepseek: 'D' };
const glyph = (harness) => h('span', { class: `hglyph h-${harness}`, title: PROGRAM[harness] || harness }, GLYPH[harness] || '?');

/** Roles in tree order: the leader first, then down the team. */
function teamOrder() {
  const out = [];
  const walk = (name) => { for (const r of rolesUnder(name)) { out.push(r); walk(r.name); } };
  walk(S.state.owner);
  for (const r of S.state.roles) if (!out.includes(r)) out.push(r); // anyone whose superior is missing
  return out;
}

function renderChart() {
  const st = S.state;
  const item = (r, depth) => {
    const kids = rolesUnder(r.name);
    const count = r.unread || r.open_tasks;
    const row = h('button', {
        class: `rail-item${S.focus === r.name ? ' focus' : ''}${L.hidden?.includes(r.name) ? ' closed' : ''}`
          + `${PANES.get(r.name)?.asking ? ' asking' : ''}`,
        style: { paddingLeft: `${8 + depth * 14}px` },
        title: `${r.name}: ${PROGRAM[r.harness] || r.harness}, ${modelLine(r)}${r.duties ? `\n${r.duties}` : ''}\nDouble-click for details`,
        onclick: () => focusPane(r.name), ondblclick: () => openDrawer(r.name),
      },
      runningDot(r), h('span', { class: 'nm' }, r.name), badge(r),
      count ? h('span', { class: `pill${r.unread ? ' hot' : ''}`, title: r.unread ? `${r.unread} unread` : plural(r.open_tasks, 'open task') }, count) : null);
    if (!r.tier) dragTeammate(row, r.name);
    dropTarget(row, r.name);
    return h('li', {}, row, kids.length ? h('ul', {}, kids.map((k) => item(k, depth + 1))) : null);
  };
  const ownerRow = h('button', {
    class: 'rail-item owner', title: 'Messages to you', onclick: () => { showTab('messages'); setFilter('me'); },
  }, h('span', { class: 'nm' }, st.owner, st.owner !== 'you' && h('span', { class: 'sub' }, ' (you)')),
  st.owner_unread ? h('span', { class: 'pill hot' }, st.owner_unread) : null);
  dropTarget(ownerRow, st.owner);
  const owner = h('li', {}, ownerRow);
  $('#chart').replaceChildren(owner, ...rolesUnder(st.owner).map((r) => item(r, 0)));
  const running = st.roles.filter((r) => r.online).length;
  $('#rail-summary').textContent = `${running} of ${st.roles.length} running`;
}

function focusPane(name) {
  showPane(name); // a closed pane comes back
  if (L.max && L.max !== name) L.max = name; // full screen: switch to that agent
  S.focus = name;
  renderChart();
  renderPanes();
  document.querySelector(`.pane[data-role="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- agent panes ----------
// Each agent has one pane, kept across refreshes (a live terminal must not be rebuilt):
// the header and status line are redrawn; the body is the agent's terminal when it runs in this
// window, and a summary of its work otherwise.

const LOG_LINES = 8;
const PANES = new Map(); // role -> { name, el, head, body, foot, term, fit, termId, next, mode }

function renderPanes() {
  const st = S.state;
  if (!st) return;
  if (L.team !== st.team_file) loadLayout(st.team_file);
  const order = arrangeOrder(teamOrder());
  const box = $('#panes');
  const names = new Set(order.map((r) => r.name));
  for (const [name, p] of PANES) if (!names.has(name)) { dropPane(p); PANES.delete(name); }
  box.querySelector(':scope > .empty')?.remove();
  if (!order.length) {
    box.append(h('div', { class: 'empty' }, 'No roles yet. Add one with + in the team list, or in Edit team.'));
    return;
  }
  order.forEach((r, i) => {
    let p = PANES.get(r.name);
    if (!p) { p = makePane(r.name); PANES.set(r.name, p); }
    updatePane(p, r);
    if (box.children[i] !== p.el) box.insertBefore(p.el, box.children[i] || null);
  });
  applyLayout();
}

function makePane(name) {
  const p = { name, head: h('header', { class: 'pane-head' }), body: h('div', { class: 'pane-body' }),
    term: null, termId: 0, next: 0, mode: '' };
  p.el = h('section', { class: 'pane', 'data-role': name, onclick: () => { if (S.focus !== name) focusPane(name); } },
    p.head, p.body);
  p.head.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleMax(name); });
  dragPanes(p);
  dropTarget(p.el, name);
  return p;
}

function dropPane(p) {
  closeTerm(p);
  p.el.remove();
}

function clearPanes() {
  for (const p of PANES.values()) dropPane(p);
  PANES.clear();
}

function updatePane(p, r) {
  const st = S.state;
  const s = r.status;
  const launchable = st.launchable.includes(r.harness);
  const live = st.in_window && r.terminal;
  p.el.className = ['pane', `h-${r.harness}`, r.name === st.leader && 'wide', r.tier && 'consultant',
    S.focus === r.name && 'focus', live && 'live', p.outputting && 'outputting', live && p.asking && 'asking',
  ].filter(Boolean).join(' ');
  // the header is all a pane keeps besides its terminal: details live in its tooltip
  p.head.title = [
    `${r.name}: ${PROGRAM[r.harness] || r.harness}, ${modelLine(r)}`,
    !r.online ? 'stopped' : r.online > 1 ? `${r.online} sessions share this role` : 'running',
    s && `${s.state}${s.task ? `: ${s.task}` : ''}`,
    r.tier ? `${r.tier} consultant for #${r.help_id}` : `reports to ${r.superior}`,
    r.usage && usageText(r.usage),
    r.open_tasks && plural(r.open_tasks, 'open task'),
    r.locks.length && `writing ${r.locks.join(', ')}`,
    'Drag the title onto another pane to swap them; double-click for full screen',
  ].filter(Boolean).join('\n');
  fill(p.head,
    runningDot(r), badge(r), h('span', { class: 'nm' }, r.name),
    h('span', { class: 'sub' }),
    r.unread ? h('span', { class: 'pill hot', title: `${r.unread} unread` }, r.unread) : null,
    r.online > 1 && h('span', { class: 'flag bad' }, `${r.online} sessions`),
    r.stuck && h('span', { class: 'flag bad', title: r.stuck.text }, r.stuck.describe),
    launchable && !r.online && iconBtn('play', r.resumes ? `Start ${r.name} (resumes its conversation)` : `Start ${r.name}`, () => startRole(r)),
    launchable && r.online > 0 && r.stuck && iconBtn('restart', `Restart ${r.name}`, () => restartRole(r.name)),
    launchable && r.online > 0 && iconBtn('stop', `Stop ${r.name}`, () => stopRoles(r.name), 'danger'),
    iconBtn('more', 'Details, tasks and files', () => openDrawer(r.name)),
    windowButtons(r.name));
  if (live) openTerm(p);
  else { closeTerm(p); renderSummary(p, r); }
}

// when the agent has no terminal here: what it is, what it does, its recent messages

function renderSummary(p, r) {
  const st = S.state;
  const s = r.status;
  const launchable = st.launchable.includes(r.harness);
  const active = document.activeElement;
  const typing = active?.dataset?.pane === r.name ? active.selectionStart : null;
  const oldLog = p.body.querySelector('.pane-log');
  const atBottom = !oldLog || oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 24;
  const keepTop = oldLog ? oldLog.scrollTop : 0;
  const task = st.tasks.find((t) => t.assignee === r.name && t.state === 'working')
    || st.tasks.find((t) => t.assignee === r.name && ['open', 'blocked'].includes(t.state));
  const log = S.messages.filter((m) => m.sender === r.name || m.recipient === r.name).slice(-LOG_LINES);
  const folder = st.project_root.split(/[\\/]/).filter(Boolean).pop() || st.project_root;
  const where = r.online
    ? (st.in_window ? '  running in a separate terminal window' : '')
    : launchable ? `  ▶ starts it${r.resumes ? ' where it left off' : ''}` : `  ${r.harness} cannot be started from here`;
  p.mode = 'summary';
  fill(p.body,
    h('div', { class: 'pane-banner' },
      h('div', { class: 'pane-art', 'aria-hidden': 'true' }),
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'line' }, h('b', {}, PROGRAM[r.harness] || r.harness)),
        h('div', { class: 'line' }, modelLine(r)),
        h('div', { class: 'line', title: st.project_root }, `~/${folder}`,
          r.write_scope.length ? `  writes ${r.write_scope.join(', ')}` : '  read-only'))),
    h('div', { class: 'pane-now' },
      r.online ? h('span', { class: `state ${s ? s.state : ''}` }, s ? s.state : 'starting')
        : h('span', { class: 'state idle' }, 'not running'),
      r.online && s && s.task ? `  ${s.task}` : where),
    task && h('div', { class: 'pane-task' }, `${task.state === 'working' ? 'on' : 'next'} `, h('b', {}, `#${task.id} ${task.title}`)),
    h('div', { class: 'pane-log' }, log.length ? log.map((m) => logLine(m, r.name))
      : h('div', { class: 'pane-empty' }, '› no messages yet')),
    h('form', {
      class: 'pane-prompt',
      onsubmit: (e) => {
        e.preventDefault();
        const input = e.target.querySelector('input');
        const text = input.value.trim();
        if (!text) return;
        act(api('/api/send', { to: r.name, text }).then((res) => { S.drafts[r.name] = ''; input.value = ''; return res; }),
          () => `Sent to ${r.name}.`);
      },
    },
    h('span', { 'aria-hidden': 'true' }, '›'),
    h('input', {
      'data-pane': r.name, value: S.drafts[r.name] || '', 'aria-label': `Message ${r.name}`,
      placeholder: `Message ${r.name}… (Enter sends)`, oninput: (e) => { S.drafts[r.name] = e.target.value; },
    })));
  const newLog = p.body.querySelector('.pane-log');
  newLog.scrollTop = atBottom ? newLog.scrollHeight : keepTop;
  if (typing !== null) {
    const input = p.body.querySelector('.pane-prompt input');
    input.focus();
    input.setSelectionRange(typing, typing);
  }
}

function logLine(m, me) {
  const out = m.sender === me;
  return h('button', {
    type: 'button', class: `logline ${m.kind}`, title: `${m.sender} → ${m.recipient}, ${KIND_LABEL[m.kind] || m.kind}\n\n${m.text.slice(0, 600)}`,
    onclick: (e) => { e.stopPropagation(); jumpTo(m.id); },
  },
  h('span', { class: 't' }, fmtTime(m.sent_at).slice(0, 5)),
  h('span', { class: 'who' }, `${out ? '→' : '←'} ${out ? m.recipient : m.sender}`),
  h('span', { class: 'txt' }, m.text.replace(/\s+/g, ' ')));
}

// ---------- live terminals (xterm.js) ----------

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return { background: v('--term'), foreground: v('--ink'), cursor: v('--accent'), cursorAccent: v('--term'),
    selectionBackground: 'rgba(59, 130, 246, 0.35)' };
}

function openTerm(p) {
  if (p.mode === 'term' && p.term) return;
  if (typeof Terminal === 'undefined') { p.mode = ''; return; } // the terminal script did not load
  p.mode = 'term';
  const host = h('div', { class: 'xterm-host' });
  p.body.replaceChildren(host);
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace', fontSize: 12.5, lineHeight: 1.15,
    cursorBlink: true, scrollback: 5000, theme: termTheme(), allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  if (typeof Unicode11Addon !== 'undefined') { // wide characters (CJK, emoji) as wide as Windows' console makes them
    term.loadAddon(new Unicode11Addon.Unicode11Addon());
    term.unicode.activeVersion = '11';
  }
  if (typeof WebLinksAddon !== 'undefined') { // links in the output open in your browser (a sign-in link, say)
    term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => { e.preventDefault(); openLink(uri); }));
  }
  term.attachCustomKeyEventHandler((e) => termKey(p, e));
  host.addEventListener('contextmenu', (e) => { e.preventDefault(); rightClick(p); });
  term.open(host);
  Object.assign(p, { term, fit, termId: 0, next: 0, pending: '', sending: false, size: '' });
  // While old output is replayed into a new screen, xterm answers the questions programs once asked
  // the terminal ("what are you?"): those answers must not reach the agent as typing.
  term.onData((data) => { if (!p.replaying) sendKeys(p, data); });
  term.textarea?.addEventListener('focus', () => { if (S.focus !== p.name) focusPane(p.name); });
  p.resizer = new ResizeObserver(() => fitTerm(p));
  p.resizer.observe(host);
  fitTerm(p);
  wakeTerms();
}

// ---------- in a terminal: copy, paste, links, activity ----------

/** Keys a terminal does not get: window shortcuts, and Ctrl+C / Ctrl+V when they mean copy and paste. */
function termKey(p, e) {
  if (e.type !== 'keydown') return true;
  if (isShortcut(e)) return false;
  const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrl && key === 'c' && (e.shiftKey || p.term.hasSelection())) { // with a selection it copies; else it interrupts
    if (p.term.hasSelection()) { copyText(p.term.getSelection()); p.term.clearSelection(); }
    return false;
  }
  if (ctrl && key === 'v') return false; // the browser pastes, and the terminal takes the paste
  return true;
}

/** Right-click, as in Windows Terminal: copy the selection, or paste. */
async function rightClick(p) {
  if (p.term.hasSelection()) {
    copyText(p.term.getSelection());
    p.term.clearSelection();
    return;
  }
  try {
    const text = await navigator.clipboard.readText();
    if (text) p.term.paste(text);
  } catch { toast('Press Ctrl+V to paste here.'); }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

function openLink(uri) {
  if (!/^https?:\/\//i.test(uri)) return;
  act(api('/api/open-url', { url: uri }), () => 'Opened in your browser.');
}

/** The pane's header lights up while its terminal is writing. */
function markOutput(p) {
  p.outputting = true;
  p.el.classList.add('outputting');
  clearTimeout(p.outputTimer);
  p.outputTimer = setTimeout(() => { p.outputting = false; p.el.classList.remove('outputting'); }, 1500);
  checkAsking(p);
}

// What a program waiting for its user shows: a permission question, the trust question at the
// first start, a yes/no - with its choices, so a question the agent only wrote in its answer does
// not count. Read from the screen as it is now, once the terminal has gone quiet (as agent_org.waker).
const ASKING = new RegExp(['do you want to', 'would you like to', 'do you trust',
  'trust (?:this|the) (?:folder|directory|files)', 'trust all', 'review (?:the )?hooks', 'allow (?:this|command|once|always)',
  '\\[y/n\\]', '\\(y/n\\)', 'press enter to (?:continue|confirm)', 'waiting for (?:your )?(?:approval|confirmation)'].join('|'), 'i');
const CHOICES = /(?:^|\s)[❯›>]?\s*1[.)]\s+\S|\[y\/n\]|\(y\/n\)|\(esc\)|enter to (?:confirm|select|continue)/im;
const QUIET_MS = 2500;

function screenText(term) {
  const b = term.buffer.active;
  const lines = [];
  for (let i = b.viewportY; i < b.viewportY + term.rows; i += 1) {
    const line = b.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n');
}

function checkAsking(p) {
  clearTimeout(p.askTimer);
  p.askTimer = setTimeout(() => {
    const screen = p.term ? screenText(p.term) : '';
    const asking = ASKING.test(screen) && CHOICES.test(screen);
    if (asking === Boolean(p.asking)) return;
    p.asking = asking;
    p.el.classList.toggle('asking', asking);
    if (S.state) { renderChart(); renderProblems(); }
  }, QUIET_MS);
}

/** Agents whose terminal shows a question: they wait for you (a desktop notification while you are away). */
function askingProblems() {
  return [...PANES.values()].filter((p) => p.asking && p.term).map((p) => ({
    kind: 'asking', role: p.name, action: 'show-pane', text: `${p.name} is asking something in its terminal: answer it there.`,
  }));
}

function closeTerm(p) {
  if (!p.term) return;
  p.resizer?.disconnect();
  p.term.dispose();
  Object.assign(p, { term: null, fit: null, mode: '' });
  p.body.replaceChildren();
}

function retheme() {
  for (const p of PANES.values()) if (p.term) p.term.options.theme = termTheme();
}

const MIN_COLS = 10; // the server allows the same: both sides must agree on the size, or text wraps wrongly
const MIN_ROWS = 4;

function fitTerm(p) {
  // Not while the pane is not laid out (another view shows, or the grid is being built): a size
  // measured then is a sliver, and what the agent prints at that width stays wrapped in it.
  if (!p.term || !p.el.isConnected || p.el.hidden || p.body.clientWidth < 100 || p.body.clientHeight < 60) return;
  const want = p.fit.proposeDimensions();
  if (!want || !want.cols || !want.rows) return;
  const cols = Math.max(MIN_COLS, want.cols);
  const rows = Math.max(MIN_ROWS, want.rows);
  if (cols !== p.term.cols || rows !== p.term.rows) p.term.resize(cols, rows);
  const size = `${cols}x${rows}`;
  if (size === p.size) return;
  p.size = size;
  clearTimeout(p.resizeTimer); // while a border is dragged, tell the agent once it settles
  p.resizeTimer = setTimeout(() => {
    api('/api/term-resize', { role: p.name, cols, rows }).catch(() => {});
  }, 120);
}

function fitAllTerms() {
  for (const p of PANES.values()) fitTerm(p);
}

/** Keystrokes go one request at a time, so they arrive in the order they were typed. */
async function sendKeys(p, data) {
  p.pending += data;
  if (p.sending) return;
  p.sending = true;
  while (p.pending) {
    const chunk = p.pending;
    p.pending = '';
    try { await api('/api/term-input', { role: p.name, data: chunk }); } catch (e) { toast(e.message, true); p.pending = ''; }
  }
  p.sending = false;
}

// One long-poll fetches every terminal's new output (a browser allows only a few connections).
let termPoll = null;
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

function wakeTerms() {
  termPoll?.abort(); // a new terminal: ask again, including it
  if (!S.termLoop) { S.termLoop = true; termLoop(); }
}

async function termLoop() {
  while (S.mode === 'team' && !S.signedOut) {
    const wants = {};
    for (const p of PANES.values()) if (p.term) wants[p.name] = [p.termId, p.next];
    if (!Object.keys(wants).length) { await pause(1000); continue; }
    termPoll = new AbortController();
    let res;
    try {
      const r = await fetch(`/api/terms?w=${encodeURIComponent(JSON.stringify(wants))}`,
        { headers: PAGE_HEADERS, credentials: 'same-origin', signal: termPoll.signal });
      if (!r.ok) throw new Error(String(r.status));
      res = await r.json();
    } catch (e) {
      if (e.name !== 'AbortError') await pause(1500);
      continue;
    }
    for (const [name, t] of Object.entries(res.terms || {})) {
      const p = PANES.get(name);
      if (!p || !p.term || t.none) continue;
      let replay = false;
      if (t.reset || t.id !== p.termId) {
        p.term.reset();
        if (t.id !== p.termId) { p.size = ''; fitTerm(p); } // a new terminal: tell it this pane's size
        p.termId = t.id;
        replay = t.age > 5; // a terminal just started still waits for real answers
      }
      if (t.data && replay) {
        p.replaying = true;
        p.term.write(t.data, () => { p.replaying = false; checkAsking(p); });
      } else if (t.data) {
        p.term.write(t.data);
        markOutput(p);
      }
      p.next = t.next;
    }
  }
  S.termLoop = false;
}

// ---------- light or dark ----------

function applyTheme(theme) {
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  $('#theme-btn').replaceChildren(icon(theme === 'light' ? 'moon' : 'sun'));
  $('#theme-btn').title = theme === 'light' ? 'Switch to dark' : 'Switch to light';
  retheme();
}

$('#theme-btn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('agent-org-theme', next); } catch { /* remembered for this visit only */ }
  applyTheme(next);
});
try { applyTheme(localStorage.getItem('agent-org-theme') || 'dark'); } catch { applyTheme('dark'); }

$('#rail-checks').addEventListener('click', () => $('#checks-btn').click());
$('#rail-add').addEventListener('click', (e) => togglePalette(e));

/** The session at a glance: green running, grey stopped, red when two sessions share the role. */
function runningDot(r) {
  const [cls, why] = !r.online ? ['off', 'Not running'] : r.online > 1
    ? ['dup', `${r.online} sessions share this role and split its messages: stop it and start it again`]
    : ['on', 'Running'];
  return h('span', { class: `run-dot ${cls}`, title: why });
}

function fmtNum(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

function usageText(u) {
  if (!u.tokens_in && !u.tokens_out) return `${plural(u.messages, 'message')}${u.model ? ` on ${u.model}` : ''}`;
  return `${fmtNum(u.tokens_in)} in, ${fmtNum(u.tokens_cached)} cached, ${fmtNum(u.tokens_out)} out`
    + ` over ${plural(u.messages, 'reply')}${u.model ? ` on ${u.model}` : ''}`;
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
        u && [h('dt', {}, 'Used'), h('dd', {}, usageText(u), u.limits.length ? h('div', { class: 'muted small' }, u.limits.join('; ')) : null)],
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
    renderPanes();
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
      h('span', { class: 'right', title: `message #${m.id}` }, fmtTime(m.sent_at))),
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
  const name = $('#project').textContent;
  document.title = `${n ? `(${n}) ` : ''}${name ? `${name} – ` : ''}agent-org`;
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
    h('div', { class: 'muted small' }, `from ${t.assigner}, ${ago(t.created_at)}`),
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
      h('small', {}, `${modelLine(t)}; ${t.active} of ${t.max_active} busy.${t.use_for ? ` For ${t.use_for}.` : ''}`));
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
  $('#view-roles').hidden = v !== 'roles';
  $('#launch-all').hidden = S.mode !== 'team' || v === 'editor';
  for (const id of ['#rail-toggle', '#side-toggle', '#layout-menu']) $(id).hidden = S.mode !== 'team' || v !== 'team';
  if (v === 'team' && S.state) setTimeout(applyLayout, 0); // once the view has its size again
  if (v === 'editor') { closeDrawer(); if (!E.draft) loadEditor(); }
  if (v === 'roles') { closeDrawer(); loadRoles(); }
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

poll(); // without a session the first request answers 403 and the sign-in note shows
