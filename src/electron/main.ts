/**
 * agent-org's window: one Electron window showing the page agent-org serves on 127.0.0.1.
 *
 * The window stays as light as Electron allows: one window, one page, no Node in the page (it only talks to its
 * own local server, signed in with a one-time code). Closing it while agents run asks first - keep them running
 * in the background, or stop them; starting agent-org again brings a hidden window back.
 *
 * The page's browser (to look at what the team builds) is a <webview>: a page of its own, in a session of its own -
 * no Node, none of agent-org's cookies or permissions, web addresses and files only.
 */

import { app, BrowserWindow, dialog, Menu, nativeTheme, screen, session, shell } from 'electron';
import path from 'node:path';
import { keepRunningOnFaults } from '../runtime.ts';
import { TeamError } from '../team.ts';
import * as preview from '../preview.ts';
import * as ui from '../ui.ts';

const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const BAR_HEIGHT = 52; // the page's title bar, which the window's own buttons sit in
const BROWSER = 'persist:agent-org-browser'; // the page's browser's own cookies and storage (kept between starts)
const WEB = /^(?:https?|file):/i;

/** The colors of the window's own parts, matching the page's paper and ink. */
function chrome(dark: boolean): { color: string; symbolColor: string; height: number } {
  return dark ? { color: '#212121', symbolColor: '#ececec', height: BAR_HEIGHT } : { color: '#ffffff', symbolColor: '#0d0d0d', height: BAR_HEIGHT };
}

function argument(name: string): string | undefined {
  const argv = process.argv.slice(app.isPackaged ? 1 : 2);
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** Start the server (on its usual port, or any free one) and show the window. */
async function start(): Promise<void> {
  const team = argument('--team');
  const teamFile = team ? path.resolve(team) : null;
  let served: ui.Served;
  try {
    try {
      served = await ui.serve(teamFile, 8765);
    } catch (e) {
      if (e instanceof TeamError) throw e;
      served = await ui.serve(teamFile, 0); // the usual port is taken: any free one
    }
  } catch (e) {
    dialog.showErrorBox('agent-org cannot start', e instanceof TeamError ? `That team.yaml has a problem: ${e.message}` : String((e as Error).message));
    app.exit(1);
    return;
  }
  const control = served.app.window;
  ui.writeInstance(served.port, control.launcher); // how an agent's tool server reaches this window
  const origin = new URL(served.base).origin;

  // The page may read and write the clipboard (copy and paste in the terminals) and show desktop notifications
  // (a message or a question for the owner while the window is away); nothing else.
  const ALLOWED = ['clipboard-read', 'clipboard-sanitized-write', 'notifications'];
  const ours = (url: string): boolean => {
    try {
      return new URL(url).origin === origin; // a check may be given 'http://127.0.0.1:8765/', a request the page's URL
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(ours(contents.getURL()) && ALLOWED.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => ours(requestingOrigin) && ALLOWED.includes(permission));

  const state = ui.loadWindowState();
  const screens = screen.getAllDisplays().map((d) => [d.bounds.x, d.bounds.y, d.bounds.width, d.bounds.height] as [number, number, number, number]);
  const geometry = ui.windowGeometry(state, screens);
  const win = new BrowserWindow({
    title: 'agent-org', width: geometry.width, height: geometry.height, x: geometry.x, y: geometry.y,
    minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT, backgroundColor: chrome(nativeTheme.shouldUseDarkColors).color, show: false, autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: chrome(nativeTheme.shouldUseDarkColors), // no separate title bar: the page's is it
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, webviewTag: true },
  });
  guardBrowser(win);
  if (geometry.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  // Its own page only: a link elsewhere opens in the owner's browser.
  const external = (url: string): void => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      external(url);
    }
  });

  // Where and how big it was, kept for next time (its own size only: not maximized or minimized).
  const keep = (): void => {
    if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) return;
    const b = win.getBounds();
    Object.assign(state, { x: b.x, y: b.y, width: b.width, height: b.height });
  };
  win.on('resize', keep);
  win.on('move', keep);
  win.on('maximize', () => { state.maximized = true; });
  win.on('unmaximize', () => { state.maximized = false; });

  let quitting = false;
  const quit = (): void => {
    quitting = true;
    control.quitting = true;
    win.close();
  };
  control.shell = {
    view: (url, opts) => viewPage(url, opts),
    show: () => {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
    hide: () => win.hide(),
    quit,
    theme: (dark) => {
      win.setTitleBarOverlay(chrome(dark));
      win.setBackgroundColor(chrome(dark).color);
    },
  };
  control.openUrl = external;
  served.app.pickFolderWith = async (title) => {
    const chosen = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
    return chosen.canceled ? '' : chosen.filePaths[0] ?? '';
  };
  served.app.shortcut = app.isPackaged
    ? { target: process.execPath, args: '', cwd: path.dirname(process.execPath) }
    : { target: process.execPath, args: `"${app.getAppPath()}"`, cwd: app.getAppPath() };

  win.on('close', (event) => {
    ui.saveWindowState(state);
    if (quitting || !served.app.liveAgents().length) {
      quitting = true;
      return;
    }
    event.preventDefault(); // agents are running: the owner chooses (keep them running, or stop them)
    void (async () => {
      let asked: unknown = null;
      try {
        asked = await win.webContents.executeJavaScript("typeof askClose === 'function' ? (askClose(), 'asked') : 'no page'");
      } catch {
        asked = null;
      }
      if (asked === 'asked') return;
      const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Stop them and close', 'Cancel'], defaultId: 1, cancelId: 1,
        title: 'Close agent-org?', message: 'Agents are running in its terminals. Stop them and close agent-org?',
        detail: 'Their conversations are kept: Start resumes them.' });
      if (response === 0) quit();
    })();
  });

  app.on('second-instance', () => control.shell?.show()); // agent-org started again: this one comes back
  app.on('window-all-closed', () => app.quit());
  let closed = false;
  app.on('will-quit', (event) => {
    if (closed) return;
    event.preventDefault(); // end the agents' terminals and the server first
    void served.close().finally(() => {
      ui.removeInstance();
      closed = true;
      app.quit();
    });
  });

  await win.loadURL(control.signIn?.() ?? served.base);
}

let viewing: Promise<unknown> = Promise.resolve(); // one page at a time: each is a renderer of its own

/** An agent looks at a page (its view_page tool): opened out of sight in the browser's own session, at the size
 * asked for, the steps done, then a screenshot, its text and the errors its console showed. */
function viewPage(url: string, opts: ui.ViewOptions): Promise<ui.PageView> {
  const run = viewing.then(() => viewOnce(url, opts), () => viewOnce(url, opts));
  viewing = run.catch(() => {});
  return run;
}

async function viewOnce(url: string, opts: ui.ViewOptions): Promise<ui.PageView> {
  if (!WEB.test(url)) throw new Error('only web addresses (http, https) and files can be viewed');
  const [width, height] = [opts.width ?? 1280, opts.height ?? 800];
  const page = new BrowserWindow({ show: false, width, height, useContentSize: true, frame: false,
    webPreferences: { partition: BROWSER, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const contents = page.webContents;
  const errors: string[] = [];
  const notes: string[] = [];
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('console-message', (event: Electron.Event & { level?: string; message?: string }, ...old: unknown[]) => {
    const level = event.level ?? old[0];
    const message = event.message ?? old[1];
    if ((level === 'error' || level === 3) && errors.length < 20) errors.push(String(message).slice(0, 400));
  });
  const settle = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
  const timed = <T>(work: Promise<T>, seconds: number, what: string): Promise<T> => Promise.race([work,
    new Promise<T>((_r, reject) => { setTimeout(() => reject(new Error(`${what} took longer than ${seconds} s`)), seconds * 1000); })]);
  try {
    await timed(contents.loadURL(url), 30, 'loading the page');
    await settle(800); // its scripts draw it
    for (const step of opts.steps ?? []) {
      const before = contents.getURL();
      const did = await doStep(contents, step);
      await calm(contents, settle);
      const now = contents.getURL();
      notes.push(`${step}: ${did}${now !== before ? ` - it went to ${now}` : ''}`);
    }
    // the screenshot, the text and the address of one page: taken once it is loaded, again if it moved meanwhile
    // (seen: a link's slow page - its address and text, with the old page's screenshot)
    for (let round = 0; ; round++) {
      await calm(contents, settle);
      const at = contents.getURL();
      const shot = await contents.capturePage({ x: 0, y: 0, width, height }); // the size asked for, whatever the frame
      const text = String(await contents.executeJavaScript('document.body ? document.body.innerText : ""')).slice(0, 8000);
      if ((contents.getURL() !== at || contents.isLoading()) && round < 3) continue;
      const size = shot.getSize();
      const image = (size.width > 1280 ? shot.resize({ width: 1280 }) : shot).toJPEG(72).toString('base64');
      return { url: at, title: contents.getTitle(), text, errors, notes, image, width: size.width, height: size.height };
    }
  } finally {
    page.destroy();
  }
}

/** After a step: a page it began to load has loaded (up to 20 s), and its scripts have had a moment. */
async function calm(contents: Electron.WebContents, settle: (ms: number) => Promise<void>): Promise<void> {
  await settle(400); // a click's navigation starts a moment after it
  const end = Date.now() + 20_000;
  while (contents.isLoading() && Date.now() < end) await settle(100);
  await settle(300);
}

// in the page: an element as the agent can check it was the one it meant - <button.buy> "Add to cart"
const DESCRIBE = `const describe = (e) => '<' + e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')
  + [...e.classList].slice(0, 2).map((c) => '.' + c).join('') + '>'
  + ((e.innerText || e.value || '').trim() ? ' "' + (e.innerText || e.value).trim().replace(/\\s+/g, ' ').slice(0, 40) + '"' : '');`;

/** One step on a page (see preview.parseStep). What happened, in a few words - which element it was. */
async function doStep(contents: Electron.WebContents, text: string): Promise<string> {
  const step = preview.parseStep(text);
  const js = (code: string): Promise<string> => contents.executeJavaScript(`(() => { ${DESCRIBE} ${code} })()`).then(String);
  if (step.verb === 'bad') return step.why;
  if (step.verb === 'wait') {
    await new Promise((r) => { setTimeout(r, Math.min(Number(step.target) || 500, 10_000)); });
    return 'waited';
  }
  if (step.verb === 'scroll') {
    const t = step.target;
    const to = t === 'bottom' ? 'document.body.scrollHeight' : t === 'top' ? '0' : `scrollY + (${Number(t) || 600})`;
    return js(`scrollTo(0, ${to}); return 'at ' + Math.round(scrollY);`);
  }
  if (step.verb === 'press') {
    const key = step.target || 'Enter';
    contents.sendInputEvent({ type: 'keyDown', keyCode: key });
    if (key.length === 1) contents.sendInputEvent({ type: 'char', keyCode: key });
    contents.sendInputEvent({ type: 'keyUp', keyCode: key });
    return js(`return 'pressed ${key.replace(/[^\w+-]/g, '')} in ' + (document.activeElement && document.activeElement !== document.body ? describe(document.activeElement) : 'the page');`);
  }
  if (step.verb === 'click') {
    if (!step.target) return 'click what? give a CSS selector';
    const where = await locate(js, `document.querySelector(${JSON.stringify(step.target)})`, JSON.stringify(step.target));
    if (typeof where === 'string') return where;
    await press(contents, where);
    return `clicked ${where.what}${where.all > 1 ? ` (the first of ${where.all})` : ''}${where.covered ? `, but ${where.covered} lies over it there` : ''}`;
  }
  if (step.verb !== 'type') return 'not a step';
  // type: the selector quoted, or the longest run of its first words that names a field
  const found = JSON.parse(await js(`const quoted = ${JSON.stringify(step.quoted)}; const words = ${JSON.stringify(step.words)};
    const field = (s) => { try { const c = document.querySelector(s); return c && c.matches('input, textarea, select, [contenteditable]') ? c : null; } catch { return null; } };
    if (quoted !== null) return JSON.stringify(field(quoted) ? [quoted, ${JSON.stringify(step.text)}] : null);
    for (let i = words.length - 1; i >= 1; i--) { const s = words.slice(0, i).join(' '); if (field(s)) return JSON.stringify([s, words.slice(i).join(' ')]); }
    return 'null';`)) as [string, string] | null;
  if (found === null) return 'no field (input, textarea) matches it';
  const [selector, value] = found;
  const where = await locate(js, `document.querySelector(${JSON.stringify(selector)})`, JSON.stringify(selector));
  if (typeof where === 'string') return where;
  await press(contents, where); // a person's click: the field takes the focus (seen: focus() alone left keys going nowhere)
  contents.selectAll(); // what was in it is replaced
  await contents.insertText(value);
  const shows = await js(`const e = document.activeElement; return e ? String(e.value ?? e.textContent ?? '') : '';`);
  const field = where.what.replace(/ "[^"]*"$/, ''); // the field by its name: what it held before is not what it holds
  if (where.covered) return `could not type into ${field}: ${where.covered} lies over it`;
  return shows === value ? `typed "${value}" into ${field}` : `typed "${value}" into ${field}, but it shows "${shows.slice(0, 80)}"`;
}

interface Spot { x: number; y: number; what: string; all: number; covered: string }

/** Where an element is on the page, scrolled into view: its middle, and what - if anything - lies over it there. */
async function locate(js: (code: string) => Promise<string>, find: string, selector: string): Promise<Spot | string> {
  const got = await js(`let e; try { e = ${find}; } catch { return 'not a CSS selector'; }
    if (!e) return 'nothing matches it';
    e.scrollIntoView({ block: 'center', inline: 'center' });
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) return describe(e) + ' is not shown (no size)';
    const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const covered = top && top !== e && !e.contains(top) && !top.contains(e) ? describe(top) : '';
    return JSON.stringify({ x, y, what: describe(e), all: document.querySelectorAll(${selector}).length, covered });`);
  return got.startsWith('{') ? JSON.parse(got) as Spot : got;
}

/** A person's click at a spot: the pointer moves there, goes down and up (pointerdown, focus, click). */
async function press(contents: Electron.WebContents, at: Spot): Promise<void> {
  const [x, y] = [Math.round(at.x), Math.round(at.y)];
  contents.sendInputEvent({ type: 'mouseMove', x, y });
  contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await new Promise((r) => { setTimeout(r, 120); });
}

/** What the page's browser may be and do, whatever the page asks for. */
function guardBrowser(win: BrowserWindow): void {
  win.webContents.on('will-attach-webview', (event, prefs, params) => {
    delete prefs.preload;
    Object.assign(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false });
    params.partition = BROWSER;
    if (params.src && params.src !== 'about:blank' && !WEB.test(params.src)) event.preventDefault();
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => { // a link to a new window opens in the same view
      if (WEB.test(url)) void guest.loadURL(url);
      return { action: 'deny' };
    });
  });
  const browsing = session.fromPartition(BROWSER);
  const allowed = ['clipboard-sanitized-write', 'fullscreen']; // copying from a page, a video full screen; nothing else
  browsing.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.includes(permission)));
  browsing.setPermissionCheckHandler((_contents, permission) => allowed.includes(permission));
}

keepRunningOnFaults('window'); // a stray fault goes to errors.log, not an error box over the work

if (!app.requestSingleInstanceLock()) {
  app.quit(); // the first agent-org shows its window instead
} else {
  Menu.setApplicationMenu(null);
  app.setAppUserModelId('agent-org');
  // The page is plain text and boxes: the GPU's own process costs far more memory than it saves work.
  if (!process.env.AGENT_ORG_GPU) app.disableHardwareAcceleration();
  void app.whenReady().then(start);
}
