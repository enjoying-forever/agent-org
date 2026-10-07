// Changing the team from the Team page itself: drag a role from the palette (+ in the team list)
// onto a teammate to hire it under them, drag a teammate onto another to change whom it reports
// to, and click a teammate's badge (C, X, G, A) to change it on its card.

const ROLE_DRAG = 'application/x-agent-org-role';
const MATE_DRAG = 'application/x-agent-org-teammate';

// ---------- the palette: roles to drag into the team ----------

async function togglePalette(e) {
  e?.stopPropagation();
  const box = $('#palette');
  if (!box.hidden) { box.hidden = true; return; }
  await ensureMarket();
  if (!L.rail) { L.rail = true; applyChrome(); saveLayout(); } // the team list is where roles are dropped
  renderPalette();
  box.hidden = false;
  const rail = $('.rail').getBoundingClientRect(); // beside the team list, never over it
  Object.assign(box.style, { left: `${Math.min(rail.right + 8, innerWidth - box.offsetWidth - 8)}px`, top: `${rail.top}px` });
  $('#palette-search').focus();
}

function renderPalette() {
  const words = $('#palette-search').value.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (R.list || []).filter((p) => matches(p, words));
  fill($('#palette-list'), shown.length ? shown.map((p) => h('div', {
    class: `palette-item h-${p.harness}`, draggable: 'true',
    title: `${p.description || p.title}\nDrag onto a teammate to add it under them, or click to choose where.`,
    ondragstart: (e) => {
      e.dataTransfer.setData(ROLE_DRAG, p.id);
      e.dataTransfer.effectAllowed = 'copy';
      document.body.classList.add('adding-role');
    },
    ondragend: () => { document.body.classList.remove('adding-role'); clearDrops(); },
    onclick: () => { $('#palette').hidden = true; placeRole(p); },
  }, roleIcon(p), h('div', { class: 'grow' }, h('b', {}, p.title),
    h('div', { class: 'muted small' }, [p.harness, p.model].filter(Boolean).join(', ')))))
    : h('div', { class: 'empty small' }, 'No role matches.'));
}

function hireByDrop(roleId, superior) {
  const p = (R.list || []).find((x) => x.id === roleId);
  act(api('/api/role-place', { id: roleId, superior }), (r) => `${r.name} (${p?.title || roleId}) joined the team under ${superior}.`);
}

function moveByDrop(name, superior) {
  if (name === superior) return;
  if (subtreeOf(name).some((x) => x.name === superior)) {
    toast(`${name} cannot report to ${superior}: ${superior} is below ${name}. Move ${superior} first.`, true);
    return;
  }
  act(api('/api/teammate', { name, changes: { superior } }), () => `${name} now reports to ${superior}.`);
}

function clearDrops() {
  document.querySelectorAll('.drop-here').forEach((el) => el.classList.remove('drop-here'));
}

/** Something a role or a teammate can be dropped on: it becomes their superior. */
function dropTarget(el, superior) {
  el.addEventListener('dragover', (e) => {
    const types = e.dataTransfer.types;
    if (!types.includes(ROLE_DRAG) && !types.includes(MATE_DRAG)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = types.includes(ROLE_DRAG) ? 'copy' : 'move';
    el.classList.add('drop-here');
  });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-here'); });
  el.addEventListener('drop', (e) => {
    const role = e.dataTransfer.getData(ROLE_DRAG);
    const mate = e.dataTransfer.getData(MATE_DRAG);
    if (!role && !mate) return;
    e.preventDefault();
    e.stopPropagation();
    clearDrops();
    if (role) hireByDrop(role, superior);
    else moveByDrop(mate, superior);
  });
}

/** A teammate in the team list can be dragged onto another one. */
function dragTeammate(el, name) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData(MATE_DRAG, name);
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', clearDrops);
}

// ---------- a teammate's card: click its badge ----------

const CARD = { name: null, config: null };

async function openCard(name, anchor) {
  const r = findRole(name);
  if (!r) return;
  $('#palette').hidden = true;
  let meta;
  try { meta = await api('/api/team'); } catch (e) { toast(e.message, true); return; }
  const spec = (meta.config.roles || {})[name];
  const card = $('#mate-card');
  CARD.name = name;
  if (!spec) { // a consultant: it comes from its tier
    fill(card, h('div', { class: 'card-head' }, glyph(r.harness), h('b', {}, name),
      h('button', { class: 'icon-btn', title: 'Close', onclick: closeCard }, icon('close'))),
    h('p', { class: 'muted small' }, `${name} is a ${r.tier} consultant: it comes from that tier, which is set in team.yaml.`));
    placeCard(card, anchor);
    return;
  }
  const below = new Set(subtreeOf(name).map((x) => x.name)); // reporting to one of them would be a loop
  const f = {
    harness: h('select', {}, meta.harnesses.map((x) => h('option', { value: x, selected: x === spec.harness }, x))),
    superior: h('select', {},
      h('option', { value: S.state.owner, selected: spec.superior === S.state.owner }, `${S.state.owner} (you)`),
      S.state.roles.filter((x) => x.name !== name && !x.tier && !below.has(x.name)).map((x) => h('option', { value: x.name, selected: spec.superior === x.name }, x.name))),
    duties: h('textarea', { rows: 2, value: spec.duties || '' }),
    instructions: h('textarea', { rows: 4, value: spec.instructions || '', placeholder: 'How to work, what to check (optional)' }),
    write_scope: h('input', { class: 'mono', value: (spec.write_scope || []).join(', '), placeholder: 'e.g. src/*, tests/*   (empty: edits nothing)' }),
  };
  let first = true;
  const choices = () => { // another program has other models: keep only what it offers
    const program = f.harness.value;
    const pick = (key, list) => {
      const v = first ? spec[key] || '' : f[key].read();
      return first || (list || []).includes(v) ? v : '';
    };
    const model = pick('model', meta.models[program]);
    const effort = pick('effort', meta.efforts[program]);
    first = false;
    f.model = choiceField(model, meta.models[program] || [], { blank: "program's default" });
    f.effort = choiceField(effort, meta.efforts[program] || [], { blank: 'default' });
    modelBox.replaceChildren(f.model);
    effortBox.replaceChildren(f.effort);
  };
  const modelBox = h('span', { class: 'choice' });
  const effortBox = h('span', { class: 'choice' });
  f.harness.addEventListener('change', choices);
  choices();
  const running = r.online > 0 && S.state.launchable.includes(r.harness);
  const save = async (restart) => {
    const now = {
      harness: f.harness.value, model: f.model.read(), effort: f.effort.read(), superior: f.superior.value,
      duties: f.duties.value.trim(), instructions: f.instructions.value.trim(),
      write_scope: f.write_scope.value.split(',').map((x) => x.trim()).filter(Boolean),
    };
    const was = { ...spec, write_scope: spec.write_scope || [] };
    const changes = Object.fromEntries(Object.entries(now).filter(([k, v]) =>
      JSON.stringify(v) !== JSON.stringify(k === 'write_scope' ? was[k] : (was[k] || ''))));
    if (!Object.keys(changes).length && !restart) { closeCard(); return; }
    if (Object.keys(changes).length) {
      const ok = await act(api('/api/teammate', { name, changes }), () => (restart || !running
        ? `Saved ${name}.` : `Saved ${name}: it uses the new settings from its next start.`));
      if (!ok) return;
    }
    closeCard();
    if (restart) act(api('/api/restart', { role: name }), () => `Restarting ${name} with its new settings.`);
  };
  fill(card,
    h('div', { class: 'card-head' }, glyph(spec.harness), h('b', {}, name),
      h('span', { class: 'muted small' }, r.online ? 'running' : 'not running'),
      h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: closeCard }, icon('close'))),
    h('div', { class: 'grid2' },
      h('label', {}, 'Program', f.harness), h('label', {}, 'Reports to', f.superior),
      h('label', {}, 'Model', modelBox), h('label', {}, 'Reasoning effort', effortBox)),
    h('label', {}, 'Duties (what it is for)', f.duties),
    h('label', {}, 'Instructions (its prompt)', f.instructions),
    h('label', {}, 'Files it may write', f.write_scope),
    h('div', { class: 'card-actions' },
      h('button', { class: 'danger', title: running ? 'Stop it first' : 'Take it out of the team', disabled: running,
        onclick: () => removeTeammate(name) }, 'Remove'),
      h('span', { class: 'grow' }),
      running && h('button', { title: 'Save, then restart it on the same conversation with the new settings', onclick: () => save(true) }, 'Save and restart'),
      h('button', { class: 'primary', onclick: () => save(false) }, 'Save')));
  placeCard(card, anchor);
}

function placeCard(card, anchor) {
  card.hidden = false;
  const a = anchor.getBoundingClientRect();
  const w = card.offsetWidth;
  const hgt = card.offsetHeight;
  const left = Math.min(Math.max(8, a.left), innerWidth - w - 8);
  const top = a.bottom + 6 + hgt > innerHeight - 8 ? Math.max(8, a.top - hgt - 6) : a.bottom + 6;
  Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
}

function closeCard() {
  $('#mate-card').hidden = true;
  CARD.name = null;
}

async function removeTeammate(name) {
  const subs = rolesUnder(name).map((x) => x.name);
  const sup = findRole(name)?.superior;
  if (!confirm(`Remove ${name} from the team?${subs.length ? ` ${subs.join(', ')} will report to ${sup}.` : ''} `
    + 'Its messages and finished tasks stay in the history.')) return;
  const r = await act(api('/api/teammate-remove', { name }), () => `${name} left the team.`);
  if (r) closeCard();
}

/** A teammate's badge: click it to open its card. */
function badge(r) {
  const g = glyph(r.harness);
  g.classList.add('clickable');
  g.title = `${PROGRAM[r.harness] || r.harness}: click to change ${r.name}`;
  g.addEventListener('click', (e) => { e.stopPropagation(); openCard(r.name, g); });
  g.addEventListener('dblclick', (e) => e.stopPropagation());
  return g;
}

// ---------- wiring ----------

$('#palette-search').addEventListener('input', renderPalette);
$('#palette-market').addEventListener('click', () => { $('#palette').hidden = true; showView('roles'); });
document.addEventListener('click', (e) => {
  if (!$('#palette').hidden && !$('#palette').contains(e.target) && !e.target.closest('#rail-add')) $('#palette').hidden = true;
  if (!$('#mate-card').hidden && !$('#mate-card').contains(e.target) && !e.target.closest('.hglyph')) closeCard();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#mate-card').hidden) closeCard();
  if (e.key === 'Escape' && !$('#palette').hidden) $('#palette').hidden = true;
});
