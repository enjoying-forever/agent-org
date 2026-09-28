'use strict';

// The team editor. Uses the helpers in app.js (h, api, toast, S, modelLine).


const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const E = { draft: null, meta: null, dirty: false };

function toDraft(config) {
  const {
    owner = 'you', project_root = '.', roles = {}, consultants = {}, checks = [],
    autostart = false, max_running = 0, commit_on_accept = true, ...extra
  } = config || {};
  return {
    owner: String(owner),
    project_root: String(project_root),
    extra,
    autostart: Boolean(autostart),
    max_running: Number(max_running) || 0,
    commit_on_accept: commit_on_accept !== false,
    checks: (checks || []).map((c) => ({
      name: c.name ?? '', run: c.run ?? '',
      when: Array.isArray(c.when) ? c.when.join(', ') : (c.when ?? ''), timeout: c.timeout ?? 300,
    })),
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
  const config = { owner: d.owner.trim(), project_root: d.project_root.trim() || '.', ...d.extra };
  if (d.autostart) config.autostart = true;
  if (Number(d.max_running) > 0) config.max_running = Math.round(Number(d.max_running));
  if (!d.commit_on_accept) config.commit_on_accept = false;
  const checks = d.checks.filter((c) => c.run.trim()).map((c) => {
    const spec = { name: c.name.trim() || c.run.trim().split(/\s+/)[0], run: c.run.trim() };
    const when = c.when.split(',').map((x) => x.trim()).filter(Boolean);
    if (when.length) spec.when = when;
    if (Number(c.timeout) && Number(c.timeout) !== 300) spec.timeout = Math.round(Number(c.timeout));
    return spec;
  });
  if (checks.length) config.checks = checks;
  config.roles = roles;
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
  if (!(Number(d.max_running) >= 0)) errs.push('"At most this many agents at once" must be 0 or more.');
  const checkNames = d.checks.map((c) => c.name.trim());
  d.checks.forEach((c, i) => {
    const label = checkNames[i] || `check ${i + 1}`;
    if (!c.run.trim()) errs.push(`Check ${label}: give the command to run, or remove it.`);
    if (checkNames[i] && checkNames.indexOf(checkNames[i]) !== i) errs.push(`Two checks are called "${checkNames[i]}".`);
    if (!(Number(c.timeout) >= 1)) errs.push(`Check ${label}: the time limit must be at least 1 second.`);
  });
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
        h('label', { class: 'wide' }, 'Project folder the agents work in', bound(d, 'project_root', { class: 'mono' })),
        h('label', { class: 'inline wide' }, h('input', {
          type: 'checkbox', checked: d.autostart, onchange: (e) => { d.autostart = e.target.checked; touch(); },
        }), 'Start agents automatically when they get work (while this page is open)'),
        h('label', {}, 'At most this many agents at once (0: no limit)',
          bound(d, 'max_running', { type: 'number', min: 0 })),
        h('label', { class: 'inline wide' }, h('input', {
          type: 'checkbox', checked: d.commit_on_accept,
          onchange: (e) => { d.commit_on_accept = e.target.checked; touch(); },
        }), 'Commit each accepted task to git (when the project keeps history)'))),
    h('div', { class: 'section-head' },
      h('h2', {}, `Checks (${d.checks.length})`),
      h('button', { onclick: () => { d.checks.push({ name: '', run: '', when: '', timeout: 300 }); touch(); renderEditor(); } }, '+ Add check')),
    h('p', { class: 'muted', style: { margin: '-8px 0 0' } },
      'Commands that must pass before a task can be closed as done, for example your tests. '
      + 'They run in the project folder.'),
    ...d.checks.map((c) => h('div', { class: 'card' },
      h('div', { class: 'grid' },
        h('label', {}, 'Name', bound(c, 'name', { placeholder: 'tests' })),
        h('label', { class: 'wide' }, 'Command', bound(c, 'run', { class: 'mono', placeholder: 'python -m pytest -q' })),
        h('label', {}, 'Only when these files changed (optional)', bound(c, 'when', { class: 'mono', placeholder: '*.py' })),
        h('label', {}, 'Time limit (seconds)', bound(c, 'timeout', { type: 'number', min: 1 })),
        h('div', { class: 'wide' }, h('button', {
          class: 'small danger', onclick: () => { d.checks.splice(d.checks.indexOf(c), 1); touch(); renderEditor(); },
        }, 'Remove check'))))),
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
    model: 'gpt-6-luna', effort: 'medium', duties: '', write_scope: '' });
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

