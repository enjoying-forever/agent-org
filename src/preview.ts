/**
 * The page's browser: which local web addresses the team's work shows - a dev server an agent started (its
 * terminal says where), a page an agent names in a message - so the owner can look at them beside the team.
 */

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
