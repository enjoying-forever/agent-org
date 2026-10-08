// The team workspace's window controls: the agent panes tile the space exactly (the page never
// scrolls), in one of four arrangements, with draggable borders; a pane can fill the space or be
// closed (its agent keeps running; click it in the team list to bring it back). The team list and
// the messages panel can be hidden and resized. All of it is remembered per team, by agent-org (see pref in app.js).

const LAYOUTS = [
  { id: 'grid', label: 'Grid', hint: 'Equal tiles, as square as possible' },
  { id: 'focus', label: 'Focus', hint: 'One big pane, the others stacked beside it' },
  { id: 'columns', label: 'Columns', hint: 'Side by side' },
  { id: 'rows', label: 'Rows', hint: 'One above the other' },
];
const GAP = 8;
const MIN_TRACK = 140; // px: the smallest a pane may be dragged to
const L = { team: null }; // the open team's layout (see loadLayout)

function loadLayout(team) {
  let saved = {};
  try { saved = JSON.parse(pref(`agent-org-layout:${team}`) || '{}'); } catch { /* defaults */ }
  const narrow = innerWidth < 1100;
  Object.assign(L, {
    team, mode: 'grid', tree: false, hidden: [], max: null, main: null, order: [], cols: {}, rows: {},
    rail: !narrow, side: !narrow, railW: 260, sideW: 400, ...saved,
  });
  L.max = null; // full screen never survives a reload
  applyChrome();
  applyTeamMode();
}

function saveLayout() {
  if (!L.team) return;
  const { team, max, ...keep } = L;
  setPref(`agent-org-layout:${team}`, JSON.stringify(keep));
}

/** Show or hide the sidebar and the messages panel, at their widths. */
function applyChrome() {
  const view = $('#view-team');
  $('#app').classList.toggle('no-rail', !L.rail); // the sidebar is the whole app's
  $('#app').style.setProperty('--rail-w', `${L.railW}px`);
  view.classList.toggle('no-side', !L.side);
  view.style.setProperty('--side-w', `${L.sideW}px`);
  $('#rail-toggle').classList.toggle('on', L.rail);
  $('#side-toggle').classList.toggle('on', L.side);
}

/** Where each visible pane goes: a grid of `cols` x `rows`, each pane at (c, r) spanning (cs, rs). */
function planLayout(mode, panes) {
  const n = panes.length;
  if (n <= 1) return { cols: 1, rows: 1, place: panes.map((p) => ({ p, c: 0, r: 0, cs: 1, rs: 1 })) };
  if (mode === 'columns') return { cols: n, rows: 1, place: panes.map((p, i) => ({ p, c: i, r: 0, cs: 1, rs: 1 })) };
  if (mode === 'rows') return { cols: 1, rows: n, place: panes.map((p, i) => ({ p, c: 0, r: i, cs: 1, rs: 1 })) };
  if (mode === 'focus') {
    const main = panes.find((p) => p.name === mainPane()) || panes[0];
    const others = panes.filter((p) => p !== main);
    const sideCols = others.length > 4 ? 2 : 1;
    const rows = Math.ceil(others.length / sideCols);
    const place = [{ p: main, c: 0, r: 0, cs: 1, rs: rows }];
    others.forEach((p, i) => {
      const r = Math.floor(i / sideCols);
      const c = 1 + (i % sideCols);
      const last = i === others.length - 1;
      place.push({ p, c, r, cs: last ? sideCols + 1 - c : 1, rs: 1 });
    });
    return { cols: 1 + sideCols, rows, place };
  }
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return {
    cols, rows,
    place: panes.map((p, i) => {
      const c = i % cols;
      return { p, c, r: Math.floor(i / cols), cs: i === n - 1 ? cols - c : 1, rs: 1 }; // the last one fills its row
    }),
  };
}

function mainPane() {
  return L.main && PANES.has(L.main) ? L.main : S.state?.leader;
}

function fractions(store, key, n, first = 1) {
  const have = store[key];
  if (Array.isArray(have) && have.length === n) return have;
  return Array.from({ length: n }, (_, i) => (i === 0 ? first : 1));
}

/** Tile the panes into the space they have; called after every render and on every change. */
function applyLayout() {
  const box = $('#panes');
  if (!S.state || !L.team) return;
  // in the order you arranged them (the page's order), not the order the panes were first made
  const all = [...box.children].filter((el) => el.classList.contains('pane')).map((el) => PANES.get(el.dataset.role)).filter(Boolean);
  if (L.max && !PANES.has(L.max)) L.max = null;
  for (const p of all) {
    p.el.hidden = L.hidden.includes(p.name) && L.max !== p.name;
    p.el.classList.toggle('max', L.max === p.name);
  }
  box.classList.toggle('has-max', Boolean(L.max));
  const visible = all.filter((p) => !p.el.hidden);
  const plan = planLayout(L.mode, visible);
  const key = `${L.mode}:${visible.length}`;
  const first = L.mode === 'focus' ? 1.6 : 1;
  const cols = fractions(L.cols, key, plan.cols, first);
  const rows = fractions(L.rows, key, plan.rows);
  box.style.gridTemplateColumns = cols.map((f) => `minmax(0, ${f}fr)`).join(' ');
  box.style.gridTemplateRows = rows.map((f) => `minmax(0, ${f}fr)`).join(' ');
  for (const { p, c, r, cs, rs } of plan.place) {
    const max = L.max === p.name; // full screen: no cell, so it covers the whole area
    p.el.style.gridColumn = max ? 'auto' : `${c + 1} / span ${cs}`;
    p.el.style.gridRow = max ? 'auto' : `${r + 1} / span ${rs}`;
  }
  drawGutters(box, cols, rows, key, plan.place);
  fitAllTerms(); // at once: the browser's own resize notice can come late
  const empty = box.querySelector(':scope > .empty');
  if (!visible.length && all.length && !empty) {
    box.append(h('div', { class: 'empty' }, 'Every pane is closed. Click an agent in the sidebar, or ',
      h('button', { class: 'link', onclick: showAllPanes }, 'show them all'), '.'));
  } else if (visible.length && empty) {
    empty.remove();
  }
}

/** Where track `k` of `list` starts, in pixels, in a box `size` long with GAP between tracks. */
function trackStart(list, k, size) {
  const avail = size - GAP * (list.length - 1);
  const total = list.reduce((a, b) => a + b, 0);
  return (avail * list.slice(0, k).reduce((a, b) => a + b, 0)) / total + GAP * k;
}

/** The runs of tracks along which border `i` separates two panes: none where a pane spans across it
 * (seen: the column border of the top row ran down through the wide pane below it). */
function borderRuns(i, along, place, axis) {
  const crosses = (q, t) => (axis === 'x'
    ? q.c <= i && q.c + q.cs - 1 >= i + 1 && q.r <= t && t < q.r + q.rs
    : q.r <= i && q.r + q.rs - 1 >= i + 1 && q.c <= t && t < q.c + q.cs);
  const runs = [];
  for (let t = 0; t < along; t += 1) {
    if (place.some((q) => crosses(q, t))) continue;
    const last = runs[runs.length - 1];
    if (last && last[1] === t) last[1] = t + 1; else runs.push([t, t + 1]);
  }
  return runs;
}

/** The draggable borders between columns and between rows - only where two panes meet. */
function drawGutters(box, cols, rows, key, place) {
  box.querySelectorAll(':scope > .pane-gutter').forEach((g) => g.remove());
  if (L.max) return;
  const W = box.clientWidth;
  const H = box.clientHeight;
  const add = (axis, i, list, from, to) => {
    const size = axis === 'x' ? W : H;
    const avail = size - GAP * (list.length - 1);
    const total = list.reduce((a, b) => a + b, 0);
    const at = trackStart(list, i + 1, size) - GAP / 2;
    const g = h('div', { class: `pane-gutter ${axis}`, title: 'Drag to resize; double-click to make them equal' });
    g.style[axis === 'x' ? 'left' : 'top'] = `${at}px`;
    const other = axis === 'x' ? rows : cols; // the tracks it runs along
    const otherSize = axis === 'x' ? H : W;
    const start = trackStart(other, from, otherSize);
    const end = to >= other.length ? otherSize : trackStart(other, to, otherSize) - GAP;
    g.style[axis === 'x' ? 'top' : 'left'] = `${start}px`;
    g.style[axis === 'x' ? 'height' : 'width'] = `${end - start}px`;
    g.addEventListener('pointerdown', (e) => dragTrack(e, axis, i, list, avail, total, key));
    g.addEventListener('dblclick', () => {
      delete (axis === 'x' ? L.cols : L.rows)[key];
      saveLayout();
      applyLayout();
    });
    box.append(g);
  };
  for (let i = 0; i < cols.length - 1; i += 1) {
    for (const [from, to] of borderRuns(i, rows.length, place, 'x')) add('x', i, cols, from, to);
  }
  for (let i = 0; i < rows.length - 1; i += 1) {
    for (const [from, to] of borderRuns(i, cols.length, place, 'y')) add('y', i, rows, from, to);
  }
}

function dragTrack(e, axis, i, list, avail, total, key) {
  e.preventDefault();
  const start = axis === 'x' ? e.clientX : e.clientY;
  const base = [...list];
  const perPx = total / avail;
  const min = Math.min(MIN_TRACK * perPx, base[i], base[i + 1]); // never jumps: a small pane stays as small
  document.body.classList.add(axis === 'x' ? 'dragging-x' : 'dragging-y');
  const move = (ev) => {
    const d = ((axis === 'x' ? ev.clientX : ev.clientY) - start) * perPx;
    const pair = base[i] + base[i + 1];
    const a = Math.min(Math.max(base[i] + d, min), pair - min);
    const next = [...base];
    next[i] = a;
    next[i + 1] = pair - a;
    (axis === 'x' ? L.cols : L.rows)[key] = next;
    applyLayout();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.body.classList.remove('dragging-x', 'dragging-y');
    saveLayout();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

/** Dragging the edge of the sidebar or the messages panel. */
function dragEdge(e) {
  const edge = e.currentTarget.dataset.edge;
  e.preventDefault();
  const start = e.clientX;
  const base = edge === 'rail' ? L.railW : L.sideW;
  document.body.classList.add('dragging-x');
  const move = (ev) => {
    const d = ev.clientX - start;
    if (edge === 'rail') L.railW = Math.min(Math.max(base + d, 160), 420);
    else L.sideW = Math.min(Math.max(base - d, 280), Math.max(320, innerWidth * 0.5));
    applyChrome();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.body.classList.remove('dragging-x');
    saveLayout();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// ---------- moving panes: drag one by its title onto another to swap them ----------

const PANE_DRAG = 'application/x-agent-org-pane';

/** The team's roles in the order you arranged their panes (new ones at the end). */
function arrangeOrder(roles) {
  if (!L.order?.length) return roles;
  const rank = (r) => {
    const i = L.order.indexOf(r.name);
    return i < 0 ? L.order.length + roles.indexOf(r) : i;
  };
  return [...roles].sort((a, b) => rank(a) - rank(b));
}

function swapPanes(a, b) {
  const names = [...$('#panes').children].filter((el) => el.classList.contains('pane')).map((el) => el.dataset.role);
  const i = names.indexOf(a);
  const k = names.indexOf(b);
  if (i < 0 || k < 0 || i === k) return;
  [names[i], names[k]] = [names[k], names[i]];
  L.order = names;
  if (L.mode === 'focus' && (a === mainPane() || b === mainPane())) L.main = a === mainPane() ? b : a;
  saveLayout();
  renderPanes();
}

function dragPanes(p) {
  p.head.draggable = true;
  p.head.title = 'Drag onto another pane to swap them; double-click for full screen';
  p.head.addEventListener('dragstart', (e) => {
    if (L.max) { e.preventDefault(); return; }
    e.dataTransfer.setData(PANE_DRAG, p.name);
    e.dataTransfer.effectAllowed = 'move';
    document.body.classList.add('moving-pane');
  });
  p.head.addEventListener('dragend', () => {
    document.body.classList.remove('moving-pane');
    document.querySelectorAll('.pane.drop-here').forEach((el) => el.classList.remove('drop-here'));
  });
  p.el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(PANE_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    p.el.classList.add('drop-here');
  });
  p.el.addEventListener('dragleave', (e) => { if (!p.el.contains(e.relatedTarget)) p.el.classList.remove('drop-here'); });
  p.el.addEventListener('drop', (e) => {
    const from = e.dataTransfer.getData(PANE_DRAG);
    p.el.classList.remove('drop-here');
    if (!from) return;
    e.preventDefault();
    if (from !== p.name) swapPanes(from, p.name);
  });
}

// ---------- the pane controls ----------

function toggleMax(name) {
  L.max = L.max === name ? null : name;
  if (L.max) L.hidden = L.hidden.filter((x) => x !== name);
  renderPanes();
  if (L.max) PANES.get(name)?.term?.focus();
}

function hidePane(name) {
  if (!L.hidden.includes(name)) L.hidden.push(name);
  if (L.max === name) L.max = null;
  saveLayout();
  renderChart();
  renderPanes();
  toast(`${name}'s pane is closed; it keeps running. Click it in the sidebar to bring it back.`);
}

function showPane(name) {
  if (!L.hidden.includes(name)) return false;
  L.hidden = L.hidden.filter((x) => x !== name);
  saveLayout();
  return true;
}

function showAllPanes() {
  L.hidden = [];
  saveLayout();
  renderChart();
  renderPanes();
}

function makeMain(name) {
  L.main = name;
  saveLayout();
  renderPanes();
}

function setLayout(mode) {
  L.mode = mode;
  L.max = null;
  saveLayout();
  renderPanes();
  renderLayoutMenu();
}

/** Header buttons a pane gets from its window controls. */
function windowButtons(name) {
  return [
    L.mode === 'focus' && !L.max && mainPane() !== name && iconBtn('main', 'Make this the big pane', () => makeMain(name)),
    iconBtn(L.max === name ? 'restore' : 'max', L.max === name ? 'Back to all panes (Esc)' : 'Full screen', () => toggleMax(name)),
    iconBtn('close', 'Close this pane (the agent keeps running)', () => hidePane(name)),
  ];
}

function renderLayoutMenu() {
  fill($('#layout-list'),
    LAYOUTS.map((l) => h('button', { class: L.mode === l.id ? 'checked' : '', title: l.hint, onclick: () => { setLayout(l.id); $('#layout-menu').open = false; } },
      h('span', { class: 'check' }, L.mode === l.id ? '✓' : ''), l.label)),
    h('hr'),
    h('button', { onclick: () => { L.cols = {}; L.rows = {}; saveLayout(); applyLayout(); $('#layout-menu').open = false; } },
      h('span', { class: 'check' }), 'Equal sizes'),
    // (No "Team order": it only undid moving panes by their titles, which dragging back does too.)
    L.hidden?.length ? h('button', { onclick: () => { showAllPanes(); $('#layout-menu').open = false; } },
      h('span', { class: 'check' }), `Show closed panes (${L.hidden.length})`) : null);
}

// ---------- the first-run steps: one button in the title bar ----------
// What waits for you shows where it is (the pane's title, its amber outline, the messages),
// not in a list of its own.

function updateAttention() {
  const btn = $('#attention-btn');
  btn.hidden = S.mode !== 'team' || $('#guide').hidden;
  btn.textContent = 'Getting started';
  if (btn.hidden) $('#attention').hidden = true;
}

$('#attention-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#attention').hidden = !$('#attention').hidden;
});
document.addEventListener('click', (e) => {
  if (!$('#attention').hidden && !$('#attention').contains(e.target)) $('#attention').hidden = true;
  if ($('#layout-menu').open && !$('#layout-menu').contains(e.target)) $('#layout-menu').open = false;
});

// ---------- wiring ----------

$('#rail-toggle').addEventListener('click', () => { L.rail = !L.rail; applyChrome(); saveLayout(); });
$('#side-toggle').addEventListener('click', () => { L.side = !L.side; applyChrome(); saveLayout(); });
for (const g of document.querySelectorAll('.gutter')) g.addEventListener('pointerdown', dragEdge);
$('#layout-menu').addEventListener('toggle', renderLayoutMenu);
new ResizeObserver(() => { if (L.team) applyLayout(); }).observe($('#panes'));
document.addEventListener('keydown', (e) => {
  // not from inside a terminal: there Esc belongs to the agent (it interrupts Codex and Claude)
  if (e.key === 'Escape' && L.max && !e.target.closest?.('.xterm') && $('#drawer').hidden
      && !document.querySelector('dialog[open]')) {
    L.max = null;
    renderPanes();
  }
});

// ---------- keyboard: Ctrl+Alt plus a key (a terminal never gets these) ----------

const SHORTCUTS = [
  ['Ctrl+Alt+1 … 9', 'Go to pane 1 to 9'],
  ['Ctrl+Alt+← / →', 'Previous / next pane'],
  ['Ctrl+Alt+Enter', 'Full screen for this pane, or back'],
  ['Ctrl+Alt+B', 'Show or hide the sidebar'],
  ['Ctrl+Alt+M', 'Show or hide the messages'],
  ['Ctrl+Alt+= / - / 0', 'Bigger, smaller or normal text in the terminals (or Ctrl+wheel over one)'],
  ['Ctrl+C / Ctrl+V', 'In a terminal: copy the selection (without one, Ctrl+C interrupts) / paste'],
  ['Right-click', 'In a terminal: copy the selection, or paste'],
];

function isShortcut(e) {
  return e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey
    && (/^Digit[0-9]$/.test(e.code) || ['Enter', 'ArrowLeft', 'ArrowRight', 'KeyB', 'KeyM', 'Equal', 'Minus',
      'NumpadAdd', 'NumpadSubtract'].includes(e.code));
}

function panesOnScreen() {
  return [...$('#panes').children].filter((el) => el.classList.contains('pane') && !el.hidden).map((el) => el.dataset.role);
}

function goToPane(name) {
  if (!name) return;
  focusPane(name);
  const p = PANES.get(name);
  if (p?.term) p.term.focus();
  else p?.el.querySelector('.pane-prompt input')?.focus();
}

document.addEventListener('keydown', (e) => {
  if (!isShortcut(e) || S.mode !== 'team' || !S.state) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'KeyB') { L.rail = !L.rail; applyChrome(); saveLayout(); return; }
  if (e.code === 'KeyM') { L.side = !L.side; applyChrome(); saveLayout(); return; }
  if (['Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract', 'Digit0'].includes(e.code)) {
    zoomTerms(e.code === 'Digit0' ? 0 : ['Equal', 'NumpadAdd'].includes(e.code) ? 1 : -1);
    return;
  }
  showView('team');
  const names = L.max ? [...PANES.keys()].filter((n) => !L.hidden.includes(n) || n === L.max) : panesOnScreen();
  const at = names.indexOf(S.focus);
  if (e.code === 'Enter') { if (S.focus) toggleMax(S.focus); return; }
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    const step = e.code === 'ArrowRight' ? 1 : -1;
    goToPane(names[(at + step + names.length) % names.length]);
    return;
  }
  goToPane(names[Number(e.code.slice(5)) - 1]);
}, true);

$('#keys-btn').addEventListener('click', () => showInfo('Keyboard shortcuts',
  h('table', { class: 'keys' }, SHORTCUTS.map(([k, what]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, what))))));

// ---------- closing the window while agents run (agent-org asks the page) ----------

function askClose() {
  const running = (S.state?.roles || []).filter((r) => r.terminal?.alive).map((r) => r.name);
  const one = running.length === 1;
  const who = running.length ? `${running.join(', ')} ${one ? 'is' : 'are'}` : 'Agents are';
  const [they, keep] = one ? ['it', 'keeps'] : ['they', 'keep'];
  $('#close-sub').textContent = `${who} running in this window. In the background ${they} ${keep} working, and starting `
    + `agent-org again brings the window back. Stopped, ${they} ${keep} ${one ? 'its conversation' : 'their conversations'}: `
    + `Start resumes ${one ? 'it' : 'them'}.`;
  $('#close-dialog').returnValue = '';
  $('#close-dialog').showModal();
}

$('#close-dialog').addEventListener('close', () => {
  const choice = $('#close-dialog').returnValue;
  if (choice === 'hide' || choice === 'quit') api('/api/window', { action: choice }).catch((e) => toast(e.message, true));
});
