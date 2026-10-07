/**
 * agent-org's window: one Electron window showing the page agent-org serves on 127.0.0.1.
 *
 * The window stays as light as Electron allows: one window, one page, no Node in the page (it only talks to its
 * own local server, signed in with a one-time code). Closing it while agents run asks first - keep them running
 * in the background, or stop them; starting agent-org again brings a hidden window back.
 */

import { app, BrowserWindow, dialog, Menu, nativeTheme, screen, session, shell } from 'electron';
import path from 'node:path';
import { TeamError } from '../team.ts';
import * as ui from '../ui.ts';

const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const BAR_HEIGHT = 52; // the page's title bar, which the window's own buttons sit in

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
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
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

if (!app.requestSingleInstanceLock()) {
  app.quit(); // the first agent-org shows its window instead
} else {
  Menu.setApplicationMenu(null);
  app.setAppUserModelId('agent-org');
  // The page is plain text and boxes: the GPU's own process costs far more memory than it saves work.
  if (!process.env.AGENT_ORG_GPU) app.disableHardwareAcceleration();
  void app.whenReady().then(start);
}
