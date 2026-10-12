/**
 * The page's browser: which local web addresses the team's work shows - a dev server an agent started (its
 * terminal says where), a page an agent names in a message - so the owner can look at them beside the team.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LAUNCHER_HEADER } from './launch.ts';
import * as templates from './templates.ts';

// what a program writes around text on a screen: colors, cursor moves (some skip blank cells with them), titles
const MOVES = /\x1b\[[0-9;]*[CHf]/g;
const ANSI = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const LOCAL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{1,5})?(?:\/[^\s"'<>`|\\^{}]*)?/gi;
const MAX = 8;

export interface Seen {
  text: string; // terminal output (with its escape codes) or a message
  at: number; // when it was written (seconds): the newest address comes first
}

/** The local addresses in `seen`, newest first, each once, at most eight. `own`: agent-org's own port, left out. */
export function localUrls(seen: readonly Seen[], own = 0): string[] {
  const found = new Map<string, number>();
  for (const { text, at } of seen) {
    const plain = text.replace(MOVES, ' ').replace(ANSI, '');
    const matches = [...plain.matchAll(LOCAL)];
    matches.forEach((m, i) => {
      const url = tidy(m[0]);
      if (url === null || (own && new URL(url).port === String(own))) return;
      const when = at - (matches.length - i) / 1e6; // later in the same text: newer
      if ((found.get(url) ?? -Infinity) < when) found.set(url, when);
    });
  }
  return [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX).map(([url]) => url);
}

/** One address as a browser opens it: a server listening on every address (0.0.0.0, ::) is reached as localhost;
 * the sentence's punctuation after it is not part of it. null if it is not an address after all. */
function tidy(raw: string): string | null {
  let text = raw.replace(/[.,;:!?)\]]+$/, '');
  text = text.replace(/^(https?:\/\/)(?:0\.0\.0\.0|\[::\])/i, '$1localhost');
  try {
    const url = new URL(text);
    return url.pathname === '/' && !text.endsWith('/') ? `${url.origin}/` : url.href;
  } catch {
    return null;
  }
}

// ---------- an agent looks at a page (its view_page tool), through the agent-org window ----------

export interface ViewOptions {
  width?: number;
  height?: number;
  steps?: string[]; // click <selector>, type <selector> <text>, press <key>, scroll <px|top|bottom>, wait <ms>
}

export interface PageView {
  url: string;
  title: string;
  text: string; // what the page says (its first 8000 characters)
  errors: string[]; // what its console reported as errors
  notes: string[]; // what each step did
  image: string; // a screenshot: JPEG, base64
  width: number;
  height: number;
}

export type Step =
  | { verb: 'click' | 'press' | 'scroll' | 'wait'; target: string }
  | { verb: 'type'; words: string[]; quoted: string | null; text: string }
  | { verb: 'bad'; why: string };

/** One step of view_page. click, press, scroll and wait take all the rest (a selector with spaces needs no quotes:
 * seen, "click .product button" clicked the first .product and nothing happened); type takes a selector and the
 * text - quoted, or the words are tried from the longest selector down on the page itself. */
export function parseStep(step: string): Step {
  const m = /^(click|type|press|scroll|wait)\b\s*([\s\S]*)$/i.exec(step.trim());
  if (m === null) return { verb: 'bad', why: 'not a step (click, type, press, scroll or wait)' };
  const verb = m[1].toLowerCase();
  const rest = m[2].trim();
  if (verb !== 'type') return { verb: verb as 'click', target: rest.replace(/^"([^"]*)"$/, '$1') };
  const quoted = /^"([^"]*)"\s*([\s\S]*)$/.exec(rest);
  if (quoted) return { verb: 'type', words: [], quoted: quoted[1], text: quoted[2] };
  return { verb: 'type', words: rest.split(/\s+/).filter(Boolean), quoted: null, text: '' };
}

/** What an agent asked to view, as an address: a port, a local server, a web address, or a file (in `root`, its copy of
 * the project, or a full path). */
export function pageAddress(text: string, root: string): string {
  const t = text.trim();
  if (/^\d{2,5}$/.test(t)) return `http://localhost:${t}/`;
  if (/^(?:https?|file):/i.test(t)) return t;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(t)) return `http://${t}`;
  return pathToFileURL(path.resolve(root, t)).href;
}

/** Ask the agent-org window (the one in instance.json) to view `url`. Throws with a reason the agent can act on. */
export async function viewInWindow(url: string, opts: ViewOptions, team: string, role: string, timeout = 120): Promise<PageView> {
  let info: { port?: unknown; launcher?: unknown };
  try {
    info = JSON.parse(readFileSync(path.join(templates.homeDir(), 'instance.json'), 'utf8'));
  } catch {
    throw new Error("agent-org's window is not open, so there is no browser to look with. Ask the owner to open it.");
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${Number(info.port)}/api/launcher/view`, {
      method: 'POST', body: JSON.stringify({ team, role, url, ...opts }),
      headers: { 'Content-Type': 'application/json', [LAUNCHER_HEADER]: String(info.launcher) },
      signal: AbortSignal.timeout(timeout * 1000),
    });
  } catch (e) {
    throw new Error(`agent-org's window did not answer (${(e as Error).message}). Is it still open?`);
  }
  const data = await res.json().catch(() => ({})) as PageView & { error?: string };
  if (!res.ok) throw new Error(data.error || `agent-org's window answered ${res.status}`);
  return data;
}
