// The Role Market: browse, design, import/export and place packaged roles; build a team from them.

const BUILD = '__build';
const ICONS = ['🧭', '⌨️', '🔍', '🧪', '📚', '✨', '🛠️', '🎨', '📝', '🧠', '🛡️', '📊', '🚀', '🤖', '🧩', '🗂️'];
const R = { list: [], meta: null, editing: null, placing: null, icon: '', model: null, effort: null };
const B = { picked: [] }; // the team being built on the welcome page: [{ id, name, superior }]

async function loadRoles() {
  try {
    R.meta = await api('/api/roles');
  } catch (e) { toast(e.message, true); return; }
  R.list = R.meta.roles;
  const filter = $('#roles-filter');
  const keep = filter.value;
  filter.replaceChildren(h('option', { value: '' }, 'All programs'),
    ...R.meta.harnesses.map((x) => h('option', { value: x }, x)));
  filter.value = keep;
  $('#roles-back').hidden = S.mode === 'team';
  renderRoles();
}

function renderRestore() {
  const n = R.meta?.deleted_built_ins || 0;
  $('#roles-restore-row').hidden = !n;
  $('#roles-restore').textContent = `Bring back the ${n === 1 ? 'ready-made role' : `${n} ready-made roles`} you deleted`;
}

function matches(p, words) {
  const hay = [p.title, p.description, p.harness, p.model, p.duties, p.instructions, ...(p.tags || [])]
    .join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

function renderRoles() {
  const words = $('#roles-search').value.toLowerCase().split(/\s+/).filter(Boolean);
  const program = $('#roles-filter').value;
  const shown = R.list.filter((p) => (!program || p.harness === program) && matches(p, words));
  fill($('#roles-grid'), shown.length ? shown.map(roleTile)
    : h('div', { class: 'empty' }, R.list.length ? 'No role matches. Try other words.' : 'No roles yet.'));
  renderRestore();
}

function roleIcon(p) {
  return h('div', { class: `role-icon h-${p.harness}` }, p.icon || (p.title || '?').slice(0, 1).toUpperCase());
}

function roleTile(p) {
  return h('div', { class: `role-tile h-${p.harness}` },
    h('span', { class: 'mine' }, p.mine ? 'Yours' : p.edited ? 'Edited' : ''),
    h('div', { class: 'top' }, roleIcon(p),
      h('div', {}, h('h3', {}, p.title),
        h('div', { class: 'specs' },
          h('span', { class: 'harness' }, p.harness),
          (p.model || p.effort) && h('span', { class: 'spec' },
            [p.model, p.effort && `${p.effort} effort`].filter(Boolean).join(', '))))),
    p.description && h('p', { class: 'desc' }, p.description),
    (p.tags || []).length ? h('div', { class: 'tags' }, p.tags.map((t) => h('span', { class: 'tag' }, t))) : null,
    h('details', { class: 'role-details' },
      h('summary', {}, 'Tasks and prompt'),
      p.duties && h('pre', {}, p.duties),
      p.instructions && h('pre', {}, p.instructions),
      h('div', { class: 'muted small', style: { marginTop: '6px' } },
        `Files: ${(p.write_scope || []).join(', ') || 'none (it does not edit files)'}`)),
    h('div', { class: 'foot' },
      h('button', { class: 'primary small', onclick: () => placeRole(p) }, 'Add to team'),
      h('span', { class: 'grow' }),
      h('button', { class: 'ghost small', onclick: () => openRoleDesigner(p) }, 'Edit'),
      h('button', { class: 'ghost small', title: 'Make a copy to change separately', onclick: () => duplicateRole(p) }, 'Duplicate'),
      h('button', { class: 'ghost small', title: 'Download as a file to share or keep', onclick: () => exportRole(p) }, 'Export'),
      p.edited && h('button', { class: 'ghost small', title: 'Undo your edits to this ready-made role', onclick: () => resetRole(p) }, 'Reset'),
      h('button', { class: 'ghost small danger', onclick: () => deleteRole(p) }, 'Delete')));
}

// ---------- designing a role ----------

async function openRoleDesigner(p) {
  try { R.meta = await api('/api/roles'); } catch { /* keep the lists we have */ }
  R.editing = p ? p.id : null;
  const v = p || { harness: 'claude', title: '', icon: '', description: '', model: '', effort: '', tags: [],
    duties: '', instructions: '', write_scope: [] };
  $('#role-dialog-title').textContent = R.editing ? `Edit "${v.title}"` : 'New role';
  $('#rd-title').value = v.title || '';
  $('#rd-description').value = v.description || '';
  $('#rd-harness').replaceChildren(...R.meta.harnesses.map((x) => h('option', { value: x, selected: x === v.harness }, x)));
  $('#rd-tags').value = (v.tags || []).join(', ');
  $('#rd-duties').value = v.duties || '';
  $('#rd-instructions').value = v.instructions || '';
  $('#rd-scope').value = (v.write_scope || []).join(', ');
  R.icon = v.icon || '';
  renderIconPicks();
  renderModelFields(v.model, v.effort);
  $('#role-dialog').showModal();
}

function renderIconPicks() {
  fill($('#rd-icons'), ICONS.map((i) => h('button', {
    type: 'button', class: i === R.icon ? 'on' : '', onclick: () => { R.icon = R.icon === i ? '' : i; renderIconPicks(); },
  }, i)));
}

function renderModelFields(model, effort) {
  const harness = $('#rd-harness').value;
  const models = R.meta.models[harness] || [];
  const efforts = R.meta.efforts[harness] || [];
  R.model = choiceField(model, models, { blank: "program's default" });
  R.effort = choiceField(effort, efforts, { blank: 'default' });
  $('#rd-model').replaceChildren(...R.model.childNodes);
  $('#rd-effort').replaceChildren(...R.effort.childNodes);
}

// another program has other models: keep only what it offers
$('#rd-harness').addEventListener('change', () => {
  const harness = $('#rd-harness').value;
  const model = R.model.read();
  const effort = R.effort.read();
  renderModelFields((R.meta.models[harness] || []).includes(model) ? model : '',
    (R.meta.efforts[harness] || []).includes(effort) ? effort : '');
});

$('#role-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const role = {
    title: $('#rd-title').value.trim(), icon: R.icon, description: $('#rd-description').value.trim(),
    harness: $('#rd-harness').value, model: R.model.read(), effort: R.effort.read(),
    tags: $('#rd-tags').value.split(',').map((x) => x.trim()).filter(Boolean),
    duties: $('#rd-duties').value.trim(), instructions: $('#rd-instructions').value.trim(),
    write_scope: $('#rd-scope').value.split(',').map((x) => x.trim()).filter(Boolean),
  };
  const res = await act(api('/api/role-save', { id: R.editing, role }),
    () => (R.editing ? `Saved "${role.title}".` : `"${role.title}" is in your market now.`));
  if (res) { $('#role-dialog').close(); R.list = res.roles; renderRoles(); }
});

async function duplicateRole(p) {
  const res = await act(api('/api/role-duplicate', { id: p.id }), () => `Copied "${p.title}": edit your copy.`);
  if (res) { R.list = res.roles; renderRoles(); openRoleDesigner(R.list.find((x) => x.id === res.id)); }
}

async function deleteRole(p) {
  const again = p.mine ? '' : ' You can bring it back from the bottom of this page.';
  if (!confirm(`Delete "${p.title}" from the market? Teams that already use it keep their copy.${again}`)) return;
  const res = await act(api('/api/role-delete', { id: p.id }), () => `Deleted "${p.title}".`);
  if (res) { await loadRoles(); }
}

async function resetRole(p) {
  if (!confirm(`Undo your edits to "${p.title}" and go back to the original?`)) return;
  const res = await act(api('/api/role-reset', { id: p.id }), () => `"${p.title}" is back to the original.`);
  if (res) { R.list = res.roles; renderRoles(); }
}

$('#roles-restore').addEventListener('click', async () => {
  const res = await act(api('/api/role-restore', {}), (r) => `Brought back ${r.restored.join(', ')}.`);
  if (res) { await loadRoles(); }
});

async function exportRole(p) {
  let res;
  try { res = await api(`/api/role-export?id=${encodeURIComponent(p.id)}`); } catch (e) { toast(e.message, true); return; }
  const url = URL.createObjectURL(new Blob([res.text], { type: 'text/yaml' }));
  const a = h('a', { href: url, download: res.filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Saved ${res.filename} to your downloads.`);
}

$('#roles-import').addEventListener('click', () => $('#roles-file').click());
$('#roles-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 200000) { toast('That file is too large to be a role.', true); return; }
  const text = await file.text();
  const res = await act(api('/api/role-import', { text }), () => `Imported "${file.name}".`);
  if (res) { R.list = res.roles; renderRoles(); }
});

$('#roles-new').addEventListener('click', () => openRoleDesigner(null));
$('#roles-search').addEventListener('input', renderRoles);
$('#roles-filter').addEventListener('change', renderRoles);

// ---------- placing a role in the open team ----------

function placeRole(p) {
  if (!R.meta.team_open) {
    toast('Open a team first - or pick roles for a new team under "Create a new team".', true);
    return;
  }
  R.placing = p;
  const taken = new Set(R.meta.team_roles);
  let base = (p.title || 'role').split('/')[0].trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'role';
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  $('#place-title').textContent = `Add "${p.title}" to your team`;
  $('#place-sub').textContent = `Runs on ${p.harness}${p.model ? ` with ${p.model}` : ''}. It starts the next time you launch the team.`;
  $('#place-name').value = name;
  const roles = R.meta.team_roles;
  $('#place-superior').replaceChildren(
    ...(roles.length ? roles : []).map((r) => h('option', { value: r }, r)),
    !roles.length && h('option', { value: R.meta.owner }, `${R.meta.owner} (it becomes the leader)`));
  $('#place-dialog').showModal();
}

$('#place-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const body = { id: R.placing.id, name: $('#place-name').value.trim(), superior: $('#place-superior').value };
  const res = await act(api('/api/role-place', body), (r) => `${r.name} joined the team under ${body.superior}.`);
  if (res) { $('#place-dialog').close(); if (typeof E !== 'undefined') E.draft = null; await loadRoles(); }
});

// ---------- building a new team from roles (welcome page) ----------

async function ensureMarket() {
  if (!R.meta) {
    try { R.meta = await api('/api/roles'); R.list = R.meta.roles; } catch (e) { toast(e.message, true); }
  }
}

function builderName(p) {
  const taken = new Set(B.picked.map((x) => x.name));
  const base = (p.title || 'role').split('/')[0].trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'role';
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return name;
}

async function renderBuilder() {
  const on = document.querySelector('#templates input:checked')?.value === BUILD;
  const box = $('#builder');
  box.hidden = !on;
  if (!on) return;
  await ensureMarket();
  const byId = (id) => R.list.find((p) => p.id === id) || { title: id, harness: 'claude' };
  const rows = B.picked.map((x, i) => {
    const p = byId(x.id);
    const others = B.picked.filter((y) => y !== x).map((y) => y.name);
    return h('div', { class: `builder-row h-${p.harness}` }, roleIcon(p),
      h('div', {}, h('b', {}, p.title), h('div', { class: 'muted small' }, `${p.harness}${p.model ? `, ${p.model}` : ''}`)),
      h('input', { value: x.name, title: 'Its name in the team', oninput: (e) => { x.name = e.target.value.trim(); } ,
        onchange: () => renderBuilder() }),
      h('select', { title: 'Reports to', onchange: (e) => { x.superior = e.target.value; } },
        h('option', { value: 'you', selected: x.superior === 'you' }, i === 0 ? 'you (leader)' : 'you'),
        others.map((o) => h('option', { value: o, selected: x.superior === o }, o))),
      h('button', { type: 'button', class: 'ghost small', title: 'Remove', onclick: () => { B.picked.splice(i, 1); fixSuperiors(); renderBuilder(); } }, '✕'));
  });
  fill(box,
    rows.length ? rows : h('div', { class: 'muted small' }, 'No roles yet. The first one you add leads the team; '
      + 'each other one reports to someone.'),
    h('div', { class: 'row' }, h('button', { type: 'button', onclick: openPicker }, '+ Add roles from the market')));
}

function fixSuperiors() {
  const names = new Set(B.picked.map((x) => x.name));
  B.picked.forEach((x, i) => {
    if (i === 0) x.superior = 'you';
    else if (x.superior === 'you' || !names.has(x.superior)) x.superior = B.picked[0].name;
  });
}

function builderRoles() {
  fixSuperiors();
  return B.picked.map((x) => ({ id: x.id, name: x.name, superior: x.superior }));
}

async function openPicker() {
  await ensureMarket();
  $('#pick-search').value = '';
  renderPicker();
  $('#pick-dialog').showModal();
}

function renderPicker() {
  const words = $('#pick-search').value.toLowerCase().split(/\s+/).filter(Boolean);
  fill($('#pick-list'), R.list.filter((p) => matches(p, words)).map((p) => {
    const count = B.picked.filter((x) => x.id === p.id).length;
    return h('div', { class: 'pick-item' }, roleIcon(p),
      h('div', { class: 'grow' }, h('b', {}, p.title), ' ', h('span', { class: `harness h-${p.harness}` }, p.harness),
        p.description && h('p', {}, p.description)),
      count ? h('span', { class: 'tag' }, `added ×${count}`) : null,
      h('button', { type: 'button', class: 'small', onclick: () => {
        B.picked.push({ id: p.id, name: builderName(p), superior: B.picked.length ? B.picked[0].name : 'you' });
        renderPicker();
        renderBuilder();
      } }, B.picked.length ? 'Add' : 'Add as leader'));
  }));
}

$('#pick-search').addEventListener('input', renderPicker);

// ---------- getting to the market; the "More" menu ----------

function openMarket() {
  if (S.mode === 'team') { showView('roles'); return; }
  $('#view-home').hidden = true;
  $('#view-roles').hidden = false;
  loadRoles();
}

$('#market-btn').addEventListener('click', openMarket);
$('#home-market').addEventListener('click', openMarket);
$('#roles-back').addEventListener('click', () => {
  $('#view-roles').hidden = true;
  $('#view-home').hidden = false;
  renderBuilder();
});

for (const b of document.querySelectorAll('#more-menu .menu-list button')) {
  b.addEventListener('click', () => { $('#more-menu').open = false; });
}
document.addEventListener('click', (e) => {
  if ($('#more-menu').open && !$('#more-menu').contains(e.target)) $('#more-menu').open = false;
});
