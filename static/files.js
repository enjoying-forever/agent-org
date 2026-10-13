'use strict';

// The Files tab: the project folder as a tree, and a file in it read and changed. The files being written and by
// whom stay on top of it (see renderLocks in app.js), and are marked in the tree. What is saved goes through the
// window's checks (ui.ts fileSave): not over an agent writing the file, nor over a change made since it was read,
// unless you say so. Uses the helpers in app.js (h, api, ask, toast, S) and layout.js (L, applyChrome, saveLayout),
// and fileUrl, PAGE_FILE and openInBrowser from browser.js.

const FS = { team: '', open: new Set(['']), lists: new Map(), file: null, treeKey: '', ticking: false, mark: null };
const FS_KEPT = new Map(); // team file -> what the tab had when the page left that team: folders open, a file
const FS_EVERY_MS = 4000; // how often the tab looks again while it shows

const fsShowing = () => S.mode === 'team' && L.side && S.sideTab === 'files' && document.visibilityState === 'visible';
const fsDirty = () => Boolean(FS.file?.text !== undefined && $('#fs-text').value !== FS.file.saved);
const fsJoin = (dir, name) => (dir ? `${dir}/${name}` : name);

/** The Files tab came into view: this team's tree (and the file it had open), then a fresh look. */
function filesShown() {
  if (!S.state) return;
  if (FS.team !== S.state.team_file) {
    FS.team = S.state.team_file;
    const kept = FS_KEPT.get(FS.team);
    FS.open = new Set(kept?.open ?? ['']);
    FS.lists = new Map();
    FS.treeKey = '';
    FS.file = null;
    if (kept?.file) fsShowFile(kept.file, kept.text);
    else fsShowTree();
  }
  $('#fs-root').textContent = S.state.project_root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || S.state.project_root;
  $('#fs-root').title = S.state.project_root;
  fsLook();
}

/** Another team: this one's tab is kept to come back to, an unsaved change with it. */
function filesLeave() {
  if (FS.team) {
    FS_KEPT.set(FS.team, { open: [...FS.open], file: FS.file, text: FS.file?.text !== undefined ? $('#fs-text').value : undefined });
  }
  Object.assign(FS, { team: '', open: new Set(['']), lists: new Map(), file: null, treeKey: '' });
  FS_KNOWN.clear(); // another project: other files
  $('#fs-find').value = '';
  $('#fs-findbar').hidden = true;
  $('#fs-tree').replaceChildren();
  fsFindFiles();
  fsShowTree();
}

/** Look again: the open folders, and whether the open file changed. */
async function fsLook() {
  if (!S.state || FS.ticking) return;
  FS.ticking = true;
  const team = S.state.team_file;
  try {
    const { dirs } = await api(`/api/files?dirs=${encodeURIComponent(JSON.stringify([...FS.open]))}`);
    if (team !== S.state?.team_file) return; // the answer is for the last team
    for (const [d, listing] of Object.entries(dirs)) {
      if (listing.error) { FS.open.delete(d); FS.lists.delete(d); } else FS.lists.set(d, listing);
    }
    fsRenderTree();
    if (FS.file) await fsCheckFile();
  } catch (e) {
    if (!(e instanceof NoTeam)) $('#fs-tree').replaceChildren(h('div', { class: 'empty' }, e.message));
  } finally {
    FS.ticking = false;
  }
}

setInterval(() => { if (fsShowing()) fsLook(); }, FS_EVERY_MS);
document.addEventListener('visibilitychange', () => { if (fsShowing()) fsLook(); });

// ---------- the tree ----------

function fsRenderTree() {
  const locks = S.state?.locks ?? [];
  const key = JSON.stringify([[...FS.lists], [...FS.open], FS.file?.path, locks.map((l) => [l.path, l.owner])]);
  if (key === FS.treeKey) return; // nothing changed: the tree (and where it is scrolled) stays
  FS.treeKey = key;
  const held = new Map(locks.filter((l) => !l.pattern).map((l) => [l.path, l.owner]));
  const rows = [];
  const walk = (dir, depth) => {
    const listing = FS.lists.get(dir);
    if (!listing) return;
    for (const e of listing.entries) {
      const p = fsJoin(dir, e.name);
      const open = e.dir && FS.open.has(p);
      const writer = e.dir ? '' : held.get(p);
      const inside = e.dir && !open && locks.some((l) => l.path.startsWith(`${p}/`));
      rows.push(h('button', {
        class: `fs-row${e.dir ? ' dir' : ''}${open ? ' open' : ''}${FS.file?.path === p ? ' on' : ''}`, type: 'button',
        style: { paddingLeft: `${8 + depth * 14}px` }, title: e.dir ? p : `${p}  ·  ${fsSize(e.size)}`, 'data-path': p,
        onclick: () => (e.dir ? fsToggle(p) : fsOpen(p)),
      },
      h('span', { class: 'fs-chev', 'aria-hidden': 'true' }, e.dir ? (open ? '▾' : '▸') : ''),
      h('span', { class: 'fs-name' }, e.name),
      writer && h('span', { class: 'fs-writer', title: `${writer} is writing it` }, writer),
      inside && h('span', { class: 'fs-dot', title: 'A file in here is being written' })));
      if (open) walk(p, depth + 1);
    }
    if (listing.more) rows.push(h('div', { class: 'fs-more muted small', style: { paddingLeft: `${22 + depth * 14}px` } }, `${listing.more} more not shown`));
    if (!listing.entries.length && dir === '') rows.push(h('div', { class: 'empty' }, 'The project folder is empty.'));
  };
  walk('', 0);
  $('#fs-tree').replaceChildren(...rows);
}

function fsSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fsToggle(p) {
  if (FS.open.has(p)) {
    for (const d of [...FS.open]) if (d === p || d.startsWith(`${p}/`)) { FS.open.delete(d); FS.lists.delete(d); }
    fsRenderTree();
  } else {
    FS.open.add(p);
    fsLook();
  }
}

// ---------- a file ----------

async function fsOpen(p, line = 0) {
  if (FS.file?.path === p && !$('#fs-editor').hidden) { if (line) fsGoLine(line); return; }
  if (FS.file && FS.file.path !== p && fsDirty() && !(await fsDiscard())) return;
  const team = S.state?.team_file;
  try {
    const f = await api(`/api/file?path=${encodeURIComponent(p)}`);
    if (team !== S.state?.team_file) return;
    fsShowFile(f);
    if (line) fsGoLine(line);
  } catch (e) { toast(e.message, true); }
}

/** Open a project file in the Files tab, at a line: from a path in a terminal, a message or a task. */
function fsOpenAt(p, line = 0) {
  if (S.mode !== 'team' || !S.state) return;
  for (const id of ['#task-dialog']) if ($(id).open) $(id).close();
  showView('team');
  showTab('files');
  fsOpen(p, line);
}

/** Select line `n` of the open file and bring it into view, a third of the way down. */
function fsGoLine(n) {
  const ta = $('#fs-text');
  const lines = ta.value.split('\n');
  const at = Math.min(Math.max(n, 1), lines.length);
  const start = lines.slice(0, at - 1).reduce((sum, l) => sum + l.length + 1, 0);
  fsSelect(start, start + lines[at - 1].length);
}

/** Select [from, to] in the text and scroll it into view (a textarea does not, while it lacks the focus). */
function fsSelect(from, to, focus = true) {
  const ta = $('#fs-text');
  if (focus) ta.focus();
  ta.setSelectionRange(from, to);
  const line = ta.value.slice(0, from).split('\n').length;
  const height = parseFloat(getComputedStyle(ta).lineHeight) || 19;
  const y = (line - 1) * height;
  if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - 2 * height) ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
  $('#fs-lines').scrollTop = ta.scrollTop;
  FS.mark = focus ? null : [from, to]; // the text keeps no visible selection while the find bar has the focus
  fsDrawMark();
}

/** The match the find bar is on, outlined over the text (where the selection would show, with the focus there). */
function fsDrawMark() {
  const m = $('#fs-mark');
  const ta = $('#fs-text');
  if (!FS.mark || $('#fs-findbar').hidden || document.activeElement === ta) { m.hidden = true; return; }
  const [from, to] = FS.mark;
  const start = ta.value.lastIndexOf('\n', from - 1) + 1;
  const line = ta.value.slice(0, from).split('\n').length;
  const style = getComputedStyle(ta);
  const ctx = (fsDrawMark.ctx ||= document.createElement('canvas').getContext('2d'));
  ctx.font = `${style.fontSize} ${style.fontFamily}`;
  const tabs = (s) => s.replace(/\t/g, ' '.repeat(Number(style.tabSize) || 4));
  const left = ctx.measureText(tabs(ta.value.slice(start, from))).width;
  const width = Math.max(ctx.measureText(tabs(ta.value.slice(from, to))).width, 2);
  const height = parseFloat(style.lineHeight) || 19;
  Object.assign(m.style, {
    left: `${ta.offsetLeft + parseFloat(style.paddingLeft) + left - ta.scrollLeft}px`,
    top: `${ta.offsetTop + parseFloat(style.paddingTop) + (line - 1) * height - ta.scrollTop}px`,
    width: `${width}px`, height: `${height}px`,
  });
  m.hidden = false;
}

// ---------- finding: a file by its name, a word in the open file ----------

let fsFindSeq = 0;
async function fsFindFiles() {
  const q = $('#fs-find').value.trim();
  const seq = ++fsFindSeq;
  $('#fs-tree').hidden = Boolean(q);
  $('#fs-found').hidden = !q;
  if (!q) return;
  let files;
  try { ({ files } = await api(`/api/find-files?q=${encodeURIComponent(q)}`)); } catch (e) { toast(e.message, true); return; }
  if (seq !== fsFindSeq) return; // an answer to an earlier query
  $('#fs-found').replaceChildren(...(files.length ? files.map((f, i) => {
    const cut = f.lastIndexOf('/');
    return h('button', { class: `fs-row fs-hit${i === 0 ? ' active' : ''}`, type: 'button', 'data-path': f, title: f, onclick: () => fsOpen(f) },
      h('span', { class: 'fs-name' }, f.slice(cut + 1)), cut > 0 && h('span', { class: 'fs-dir muted' }, f.slice(0, cut)));
  }) : [h('div', { class: 'empty' }, `No file matches "${q}".`)]));
}

function fsFindKey(e) {
  const hits = [...$('#fs-found').querySelectorAll('.fs-hit')];
  const at = hits.findIndex((b) => b.classList.contains('active'));
  if (e.key === 'Escape') { $('#fs-find').value = ''; fsFindFiles(); return; }
  if (e.key === 'Enter') { e.preventDefault(); hits[Math.max(at, 0)]?.click(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' || !hits.length) return;
  e.preventDefault();
  const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
  hits.forEach((b, i) => b.classList.toggle('active', i === next));
  hits[next].scrollIntoView({ block: 'nearest' });
}

/** Ctrl+F in the open file: the bar, with the selected text to look for. */
function fsFindIn() {
  const ta = $('#fs-text');
  const picked = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  $('#fs-findbar').hidden = false;
  if (picked && !picked.includes('\n')) $('#fs-q').value = picked;
  $('#fs-q').focus();
  $('#fs-q').select();
  fsFindNext(0);
}

/** The next (1), previous (-1) or nearest (0) place the bar's text is in the file; it is selected. */
function fsFindNext(step) {
  const ta = $('#fs-text');
  const q = $('#fs-q').value.toLowerCase();
  const text = ta.value.toLowerCase();
  const all = [];
  for (let i = q ? text.indexOf(q) : -1; i !== -1 && all.length < 10000; i = text.indexOf(q, i + Math.max(q.length, 1))) all.push(i);
  if (!all.length) { $('#fs-count').textContent = q ? 'none' : ''; return; }
  const from = step === 0 ? ta.selectionStart : step > 0 ? ta.selectionStart + 1 : ta.selectionStart - 1;
  let k = step < 0 ? all.findLastIndex((i) => i <= from) : all.findIndex((i) => i >= from);
  if (k === -1) k = step < 0 ? all.length - 1 : 0; // round again from the other end
  $('#fs-count').textContent = `${k + 1} of ${all.length}`;
  fsSelect(all[k], all[k] + q.length, false);
}

function fsFindClose() {
  $('#fs-findbar').hidden = true;
  fsDrawMark();
  $('#fs-text').focus();
}

const fsDiscard = () => ask(`Your changes to ${FS.file.path} are not saved. Leave them?`, { ok: 'Leave them', no: 'Keep editing', danger: true });

/** Show `f` (as /api/file answers) in the editor: its text, or why it is not opened. `text`: a change kept. */
function fsShowFile(f, text) {
  FS.file = { ...f, saved: f.text, changed: false, gone: false };
  $('#fs-tree-view').hidden = true;
  $('#fs-editor').hidden = false;
  $('#fs-path').textContent = f.path;
  $('#fs-path').title = `${S.state.project_root.replace(/[\\/]+$/, '')}/${f.path}`;
  const editable = f.text !== undefined;
  $('#fs-code').hidden = !editable;
  $('#fs-save').hidden = !editable;
  $('#fs-preview').hidden = !PAGE_FILE.test(f.path);
  if (editable) {
    const ta = $('#fs-text');
    ta.value = text ?? f.text;
    ta.scrollTop = 0;
    ta.setSelectionRange(0, 0);
  }
  fsNote();
  fsLines(true);
  fsMarkDirty();
  fsStatus();
  FS.treeKey = '';
}

function fsShowTree() {
  $('#fs-editor').hidden = true;
  $('#fs-tree-view').hidden = false;
  FS.treeKey = '';
  fsRenderTree();
}

async function fsClose() {
  if (fsDirty() && !(await fsDiscard())) return;
  FS.file = null;
  fsShowTree();
}

/** Has the open file changed on disk, or someone started writing it? Unchanged here: shown as it is now. */
async function fsCheckFile() {
  const f = FS.file;
  if (!f || f.version === '') return;
  let now;
  try {
    now = await api(`/api/file?path=${encodeURIComponent(f.path)}&version=${f.version}`);
  } catch (e) {
    if (FS.file !== f) return;
    if (!f.gone) { f.gone = true; fsNote(`${f.path} is not there any more. ${fsDirty() ? 'Your text is still here: copy it if you need it.' : ''}`); }
    return;
  }
  if (FS.file !== f) return;
  if (f.gone) { f.gone = false; fsNote(); }
  f.held_by = now.held_by;
  fsStatus();
  if (now.same || now.version === f.version) return;
  if (now.text === undefined) { fsShowFile(now); return; }
  if (!fsDirty()) {
    const ta = $('#fs-text');
    const [at, top] = [ta.selectionStart, ta.scrollTop];
    Object.assign(f, now, { saved: now.text, changed: false });
    ta.value = now.text;
    ta.setSelectionRange(Math.min(at, ta.value.length), Math.min(at, ta.value.length));
    ta.scrollTop = top;
    fsLines(true);
    fsStatus('Changed on disk: shown as it is now.');
    return;
  }
  if (!f.changed) {
    f.changed = true;
    fsNote(`${f.path} changed on disk since you opened it.`, h('button', { class: 'small', onclick: fsReload }, 'Show it as it is now'));
  }
}

async function fsReload() {
  const f = FS.file;
  if (!f) return;
  if (fsDirty() && !(await fsDiscard())) return;
  try { fsShowFile(await api(`/api/file?path=${encodeURIComponent(f.path)}`)); } catch (e) { toast(e.message, true); }
}

async function fsSave(over = {}) {
  const f = FS.file;
  if (!f || f.text === undefined || ($('#fs-save').disabled && !Object.keys(over).length)) return;
  const text = $('#fs-text').value;
  $('#fs-save').disabled = true;
  let r;
  try {
    r = await api('/api/file-save', { path: f.path, text, version: f.version, ...over });
  } catch (e) {
    toast(e.message, true);
    fsMarkDirty();
    return;
  }
  if (FS.file !== f) return;
  if (r.held_by) {
    fsMarkDirty();
    if (await ask(`${r.held_by} is writing ${f.path} now. Save yours anyway? What it writes next can undo your change, or yours its.`,
      { ok: 'Save anyway', danger: true })) return fsSave({ ...over, over_lease: true });
    return;
  }
  if (r.changed) {
    fsMarkDirty();
    if (await ask(`${f.path} changed on disk since you opened it. Save yours over it? The change on disk is lost.`,
      { ok: 'Save over it', danger: true })) return fsSave({ ...over, over_change: true });
    return;
  }
  Object.assign(f, { version: r.version, size: r.size, saved: text, changed: false });
  fsNote();
  fsMarkDirty();
  fsStatus(r.committed ? `Saved, and committed to main (${r.committed}).` : 'Saved.');
  if (r.note) toast(r.note, true);
}

function fsNote(text = '', ...extra) {
  const n = $('#fs-note');
  n.hidden = !text;
  n.replaceChildren(...(text ? [h('span', {}, text), ...extra] : []));
  if (FS.file && FS.file.text === undefined && !text) {
    n.hidden = false;
    n.replaceChildren(h('span', {}, `${FS.file.why} (${fsSize(FS.file.size)})`),
      PAGE_FILE.test(FS.file.path) && h('button', { class: 'small', onclick: fsPreview }, 'Open in the browser'),
      h('button', { class: 'small', onclick: fsReveal }, 'Show in File Explorer'));
  }
}

let fsStatusTimer;
function fsStatus(passing = '') {
  const f = FS.file;
  const el = $('#fs-status');
  if (!f) { el.textContent = ''; return; }
  clearTimeout(fsStatusTimer);
  const parts = [];
  if (f.held_by) parts.push(h('span', { class: 'fs-held' }, `${f.held_by} is writing this file`));
  if (passing) {
    parts.push(h('span', {}, passing));
    fsStatusTimer = setTimeout(() => fsStatus(), 4000);
  } else if (f.text !== undefined) {
    parts.push(h('span', {}, `${fsSize(f.size)}, ${f.eol === 'crlf' ? 'CRLF' : 'LF'}${f.bom ? ', BOM' : ''}`));
  }
  el.replaceChildren(...parts);
}

function fsMarkDirty() {
  const dirty = fsDirty();
  $('#fs-dirty').hidden = !dirty;
  $('#fs-save').disabled = !dirty;
}

/** The line numbers beside the text: drawn again only when the number of lines changes. */
function fsLines(force = false) {
  const ta = $('#fs-text');
  let n = 1;
  for (let i = ta.value.indexOf('\n'); i !== -1; i = ta.value.indexOf('\n', i + 1)) n += 1;
  const g = $('#fs-lines');
  if (!force && Number(g.dataset.n) === n) return;
  g.dataset.n = n;
  g.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
  g.scrollTop = ta.scrollTop;
}

/** What one indent is in this file: a tab, or as many spaces as its lines are mostly indented by. */
function fsIndent(text) {
  if (/^\t/m.test(text)) return '\t';
  return /^ {4}\S/m.test(text) && !/^ {2}\S/m.test(text) ? '    ' : '  ';
}

function fsPreview() {
  if (!FS.file) return;
  openInBrowser(fileUrl(`${S.state.project_root.replace(/[\\/]+$/, '')}/${FS.file.path}`));
}

function fsReveal() {
  if (FS.file) act(api('/api/reveal', { path: FS.file.path }));
}

{
  const ta = $('#fs-text');
  ta.addEventListener('input', () => { fsMarkDirty(); fsLines(); });
  ta.addEventListener('scroll', () => { $('#fs-lines').scrollTop = ta.scrollTop; fsDrawMark(); });
  ta.addEventListener('focus', fsDrawMark); // the selection shows again: no outline needed
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); fsSave(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); fsFindIn(); return; }
    if (e.key === 'F3') { e.preventDefault(); fsFindNext(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape') { ta.blur(); return; } // then Tab moves on, as anywhere else
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertText', false, fsIndent(ta.value)); // as typed: Ctrl+Z takes it back
    } else if (e.key === 'Enter' && !e.shiftKey) {
      const start = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      const lead = /^[\t ]*/.exec(ta.value.slice(start, ta.selectionStart))[0];
      if (!lead) return;
      e.preventDefault();
      document.execCommand('insertText', false, `\n${lead}`); // the next line starts where this one does
    }
  });
  $('#fs-save').addEventListener('click', () => fsSave());
  $('#fs-back').addEventListener('click', fsClose);
  $('#fs-preview').addEventListener('click', fsPreview);
  $('#fs-reveal').addEventListener('click', fsReveal);
  $('#fs-refresh').addEventListener('click', () => { FS.treeKey = ''; fsLook(); });
  $('#fs-collapse').addEventListener('click', () => {
    FS.open = new Set(['']);
    for (const d of [...FS.lists.keys()]) if (d) FS.lists.delete(d);
    fsRenderTree();
  });
  $('#fs-explorer').addEventListener('click', () => act(api('/api/open-folder', {})));
  $('#fs-wide').addEventListener('click', () => {
    L.filesWide = !L.filesWide;
    applyChrome();
    saveLayout();
  });
  let findTimer;
  $('#fs-find').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(fsFindFiles, 120); });
  $('#fs-find').addEventListener('keydown', fsFindKey);
  $('#fs-q').addEventListener('input', () => fsFindNext(0));
  $('#fs-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'F3') { e.preventDefault(); fsFindNext(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.preventDefault(); fsFindClose(); }
  });
  $('#fs-q-next').addEventListener('click', () => fsFindNext(1));
  $('#fs-q-prev').addEventListener('click', () => fsFindNext(-1));
  $('#fs-q-close').addEventListener('click', fsFindClose);
}

// ---------- paths in what agents write: a click opens the file here ----------

// a file's name with its extension, maybe folders before it and :line after - and not a piece of a web address
const FILE_TOKEN = /(?<![\w/\\.:@-])(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])?(?:[\w@.-]+[\\/])*[\w@-][\w@.-]*\.[A-Za-z]\w{0,9}(?::\d+(?::\d+)?)?(?![\w/\\-])/g;
const FS_KNOWN = new Map(); // a path as written -> { at, v: [the project's path, line] or null }
const KNOWN_FOR_MS = 30000;

/** Which of these paths are the project's files (asked once in a while each, in one request). */
async function fsKnown(list) {
  const now = Date.now();
  const unknown = [...new Set(list)].filter((p) => !(FS_KNOWN.get(p)?.at > now - KNOWN_FOR_MS)).slice(0, 200);
  if (unknown.length && S.state) {
    const team = S.state.team_file;
    try {
      const { known } = await api(`/api/files-known?paths=${encodeURIComponent(JSON.stringify(unknown))}`);
      if (team === S.state?.team_file) for (const [p, v] of Object.entries(known)) FS_KNOWN.set(p, { at: now, v });
    } catch { /* no link this time */ }
  }
  return new Map(list.map((p) => [p, FS_KNOWN.get(p)?.v ?? null]));
}

/** Text with the paths in it marked; those that are the project's files become links a moment later. */
let fsSpanTimer = 0;
function fsFileBits(text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(FILE_TOKEN)) {
    out.push(text.slice(at, m.index), h('span', { class: 'maybe-file', 'data-file': m[0] }, m[0]));
    at = m.index + m[0].length;
  }
  out.push(text.slice(at));
  if (out.length > 1) { clearTimeout(fsSpanTimer); fsSpanTimer = setTimeout(fsCheckSpans, 30); }
  return out;
}

async function fsCheckSpans() {
  const spans = [...document.querySelectorAll('.maybe-file:not(.checked)')];
  if (!spans.length) return;
  for (const s of spans) s.classList.add('checked');
  const known = await fsKnown(spans.map((s) => s.dataset.file));
  for (const s of spans) {
    const v = known.get(s.dataset.file);
    if (!v) continue;
    const open = (e) => { e.preventDefault(); e.stopPropagation(); fsOpenAt(v[0], v[1]); };
    Object.assign(s, { tabIndex: 0, title: `Open ${v[0]}${v[1] ? ` at line ${v[1]}` : ''} in Files` });
    s.classList.add('file-link');
    s.setAttribute('role', 'link');
    s.addEventListener('click', open);
    s.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
  }
}

/** In an agent's terminal: a path to one of the project's files is a link to it (a web address keeps its own). */
function fsTermLinks(term) {
  if (typeof term.registerLinkProvider !== 'function') return;
  term.registerLinkProvider({
    provideLinks(y, done) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) { done(undefined); return; }
      let text = '';
      const col = []; // the cell each character of `text` is in (a wide character takes two)
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || ' ';
        text += chars;
        for (let k = 0; k < chars.length; k++) col.push(x);
      }
      const found = [...text.matchAll(FILE_TOKEN)];
      if (!found.length) { done(undefined); return; }
      fsKnown(found.map((m) => m[0])).then((known) => {
        const links = found.filter((m) => known.get(m[0])).map((m) => {
          const [p, ln] = known.get(m[0]);
          return {
            range: { start: { x: col[m.index] + 1, y }, end: { x: col[m.index + m[0].length - 1] + 1, y } },
            text: m[0], decorations: { underline: true, pointerCursor: true },
            activate: (e) => { e?.preventDefault?.(); fsOpenAt(p, ln); },
          };
        });
        done(links.length ? links : undefined);
      });
    },
  });
}
