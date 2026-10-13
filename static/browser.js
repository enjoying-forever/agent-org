'use strict';

// The browser beside the team: to look at what it builds - a local server an agent started, a page in the
// project, any address. In agent-org's window it is a <webview>: a page of its own, in a session of its own (see
// electron/main.ts). In a web browser it is an <iframe>, which shows what lets itself be framed.
// Uses the helpers in app.js (h, api, act, toast, S, pref, setPref) and layout.js (L, applyChrome, saveLayout).

const BR = { view: null, team: '', url: '', found: [] };
const IN_WINDOW = /\bElectron\//.test(navigator.userAgent);
const LOCAL_LINK = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:[/?#]|$)/i;
const PAGE_FILE = /\.(?:html?|svg|xml|pdf|png|jpe?g|gif|webp|txt|json|md)$/i;
const brKey = () => `agent-org-browser:${S.state?.team_file || ''}`;

/** A file's address: a path on this computer, as the browser opens it. */
function fileUrl(p) {
  const path = p.replace(/\\/g, '/');
  const encoded = encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return path.startsWith('//') ? `file:${encoded}` : `file:///${encoded.replace(/^\/+/, '')}`;
}

/** What was typed, as an address: a port, a local server, a file (in the project, or a full path), a website. */
function toAddress(text) {
  const t = text.trim();
  if (!t) return '';
  if (/^\d{2,5}$/.test(t)) return `http://localhost:${t}/`;
  if (/^(?:https?|file):/i.test(t)) return t;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(t)) return `http://${t}`;
  if (/^[a-z]:[\\/]|^\\\\/i.test(t)) return fileUrl(t);
  if (/^[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:\/\S*)?$/.test(t) && !PAGE_FILE.test(t.split(/[?#]/)[0])) return `https://${t}`;
  return fileUrl(`${S.state.project_root.replace(/[\\/]+$/, '')}/${t.replace(/^\.?[\\/]/, '')}`); // a file in the project
}

/** Open `url` in the browser beside the team (a local link in a terminal or a message comes here). */
function openInBrowser(url) {
  if (S.mode !== 'team' || !S.state) return;
  showView('team');
  if (!L.side) { L.side = true; applyChrome(); saveLayout(); }
  showTab('browser');
  go(url);
}

/** Ctrl+Alt+W: the browser, or closed. */
function toggleBrowser() {
  showView('team');
  togglePanel('browser');
  if (L.side && !BR.url) $('#br-url').focus();
}

/** The Browser tab came into view: the team's last page, or where to start. */
function browserShown() {
  if (!S.state) return;
  if (BR.team !== S.state.team_file) {
    BR.team = S.state.team_file;
    BR.url = '';
    const last = pref(brKey());
    if (last) go(last);
  }
  findPages();
  if (!BR.url) startNote();
}

/** Another team: its own pages (called when the page leaves a team). */
function browserLeave() {
  BR.view?.remove();
  Object.assign(BR, { view: null, team: '', url: '', found: [] });
  $('#br-url').value = '';
  note(null);
}

function go(url) {
  if (!url) return;
  BR.url = url;
  $('#br-url').value = url;
  setPref(brKey(), url);
  note(null);
  if (!IN_WINDOW && url.startsWith('file:')) {
    note(h('p', {}, "A file in the project opens here only in agent-org's own window. Here, open it with a local server instead."));
    return;
  }
  const view = ensureView();
  if (view.getAttribute('src') === url && IN_WINDOW && view.dataset.ready) view.reload();
  else view.setAttribute('src', url);
  navButtons();
}

function ensureView() {
  if (BR.view) return BR.view;
  const v = document.createElement(IN_WINDOW ? 'webview' : 'iframe');
  if (IN_WINDOW) {
    v.setAttribute('partition', 'persist:agent-org-browser'); // the window enforces it too
    v.setAttribute('allowpopups', ''); // a link to a new window: opened in this one (by the window)
    v.addEventListener('dom-ready', () => { v.dataset.ready = '1'; navButtons(); });
    v.addEventListener('did-start-loading', () => $('#br-reload').classList.add('loading'));
    v.addEventListener('did-stop-loading', () => { $('#br-reload').classList.remove('loading'); navButtons(); });
    const moved = (url) => {
      BR.url = url;
      if (document.activeElement !== $('#br-url')) $('#br-url').value = url;
      setPref(brKey(), url);
      navButtons();
    };
    v.addEventListener('did-navigate', (e) => { note(null); moved(e.url); });
    v.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) moved(e.url); });
    v.addEventListener('page-title-updated', (e) => { $('#br-url').title = e.title; });
    v.addEventListener('did-fail-load', (e) => {
      if (!e.isMainFrame || e.errorCode === -3) return; // -3: stopped (a new address before this one loaded)
      failed(e.validatedURL || BR.url, e.errorDescription, e.errorCode);
    });
  } else {
    v.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals');
    v.setAttribute('referrerpolicy', 'no-referrer');
    v.setAttribute('title', 'Browser');
  }
  $('#br-view').append(v);
  BR.view = v;
  return v;
}

function navButtons() {
  const v = BR.view;
  const can = (f) => { try { return Boolean(IN_WINDOW && v?.dataset.ready && f()); } catch { return false; } };
  $('#br-back').disabled = !can(() => v.canGoBack());
  $('#br-forward').disabled = !can(() => v.canGoForward());
  $('#br-inspect').hidden = !IN_WINDOW;
  $('#br-external').disabled = !/^https?:/i.test(BR.url);
}

// Chromium's errors for an address where nothing listens (refused, reset, unreachable, timed out, an empty answer)
const NO_SERVER = [-7, -101, -102, -104, -105, -109, -118, -324];

/** A page that did not load: why, and - for a local server that is not up - what to do about it. */
function failed(url, why, code) {
  const local = LOCAL_LINK.test(url) && NO_SERVER.includes(code);
  note(h('p', {}, h('b', {}, local ? 'Nothing answers there yet.' : 'The page did not load.'), ` ${url} (${why || 'no answer'}).`),
    local && h('p', { class: 'muted' }, 'If an agent starts this server, it may not be running yet: reload once its terminal says where it listens.'),
    h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => go(url) }, 'Try again')),
    foundList(url));
}

/** Where to start: what the address bar takes, and the local pages the team's work shows. */
function startNote() {
  note(h('div', { class: 'br-start' },
    h('span', { class: 'br-globe', 'aria-hidden': 'true' }),
    h('b', {}, 'Look at what the team builds'),
    h('p', { class: 'muted' }, 'Type a port (5173), a file in the project (index.html) or any address.'),
    BR.found.length ? foundList('') : h('p', { class: 'muted small' }, 'Preview your app? ',
      h('button', { class: 'link', onclick: detectServers }, 'Find dev servers'))));
}

/** The menu's "Find": the local servers the team's work shows - the only one opens at once. */
async function detectServers() {
  $('#br-menu').open = false;
  await findPages();
  if (BR.found.length === 1) go(BR.found[0]);
  else if (BR.found.length) startNote();
  else toast("No local server in the team's work yet: an agent's terminal or message names one when it starts.");
}

function foundList(except) {
  const urls = BR.found.filter((u) => u !== except);
  if (!urls.length) return null;
  return h('div', { class: 'br-found' }, h('div', { class: 'muted small' }, "Seen in the team's work"),
    urls.map((u) => h('button', { class: 'link mono', onclick: () => go(u) }, u)));
}

/** Local pages the team's work shows (a dev server's address in a terminal, a link in a message). */
async function findPages() {
  try {
    BR.found = (await api('/api/previews')).urls;
  } catch { return; }
  $('#br-found').replaceChildren(...BR.found.map((u) => h('option', { value: u })));
  if (!BR.url && S.sideTab === 'browser') startNote();
}

function note(...content) {
  const box = $('#br-note');
  const shown = content.filter((x) => x !== null && x !== undefined && x !== false);
  box.hidden = !shown.length;
  box.replaceChildren(...shown);
  if (BR.view) BR.view.style.visibility = shown.length ? 'hidden' : '';
}

/** Text with its web addresses as links: a local one opens beside the team, any other in your browser. */
function linkText(text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s"'<>`]*[^\s"'<>`.,;:!?)\]]/g)) {
    out.push(fsFileBits(text.slice(at, m.index)), h('a', { href: m[0], class: 'msg-link',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); openLink(m[0]); } }, m[0]));
    at = m.index + m[0].length;
  }
  out.push(fsFileBits(text.slice(at))); // a path to a project file: opens it in the Files tab
  return out;
}

$('#br-bar').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = toAddress($('#br-url').value);
  if (url) go(url);
  else startNote();
});
$('#br-url').addEventListener('focus', () => { $('#br-url').select(); findPages(); });
$('#br-url').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#br-url').value = BR.url; $('#br-url').blur(); } });
$('#br-back').addEventListener('click', () => { try { BR.view?.goBack(); } catch { /* not ready */ } });
$('#br-forward').addEventListener('click', () => { try { BR.view?.goForward(); } catch { /* not ready */ } });
$('#br-reload').addEventListener('click', () => {
  if (!BR.url) return;
  note(null);
  if (IN_WINDOW && BR.view?.dataset.ready) BR.view.reload();
  else go(BR.url);
});
$('#br-detect').addEventListener('click', detectServers);
$('#br-expand').addEventListener('click', () => {
  L.browserWide = !L.browserWide;
  applyChrome();
  saveLayout();
});
$('#br-close').addEventListener('click', () => { L.side = false; applyChrome(); saveLayout(); });
for (const b of document.querySelectorAll('#br-menu .menu-list button')) b.addEventListener('click', () => { $('#br-menu').open = false; });
document.addEventListener('click', (e) => { if ($('#br-menu').open && !$('#br-menu').contains(e.target)) $('#br-menu').open = false; });
$('#br-inspect').addEventListener('click', () => {
  try {
    if (BR.view?.isDevToolsOpened()) BR.view.closeDevTools(); else BR.view?.openDevTools();
  } catch { toast('Open a page first.'); }
});
$('#br-external').addEventListener('click', () => { if (/^https?:/i.test(BR.url)) openExternal(BR.url); });
