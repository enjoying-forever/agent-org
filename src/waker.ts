/**
 * Wake an agent that rests at its prompt in the agent-org window when work arrives for it.
 *
 * In the window an agent starts with no first message: its role is in its system prompt, so it need not re-read
 * its status, and no model runs until there is work. Mail normally reaches an agent through its Stop hook, which
 * waits for messages at the end of each turn. When no hook is waiting - right after a start, after you
 * interrupted a turn, after a long wait ran out - this types one line into the agent's terminal instead: only
 * when the terminal has gone quiet (the agent is at its prompt), it is not asking you something there, and you
 * have not typed in it for a while. At the start it also wakes an agent that has unfinished tasks.
 *
 * DeepSeek is left out: between runs its own waiter (wake) starts it.
 */

import { SERVER_NAME } from './cards.ts';
import type { Hub, RoleSession } from './hub.ts';
import type { Terminal, TerminalHost } from './terminals.ts';

export const EVERY = 1.0; // seconds between looks (each costs about a millisecond)
export const QUIET = 3.0; // seconds without output: the agent is at its prompt (an idle Claude redraws every ~13 s)
export const READY = 6.0; // seconds after a start before its first line: the program is still drawing its screen
export const UNREAD_FOR = 2.5; // a waiting Stop hook takes mail within a second: older mail has nobody taking it
export const AGAIN = 90.0; // seconds before the same terminal gets another line (doubling while the same mail waits)
export const MOST = 1800.0; // the longest it waits before trying once more
export const TYPED = 30.0; // seconds after you typed in a terminal before it gets a line (you may be mid-sentence)
export const UNSENT = 600.0; // seconds it waits while you have typed text there and not sent it (a line would send yours too)
export const TAIL = 1500; // characters of recent output searched for a question: about the last screen update

const MOVES = /\x1b\[[0-9;]*[CHf]/g; // cursor moves: some programs skip blank cells with them
const ANSI = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// What a program waiting for its user shows (as the page's own check, plus Codex's hook review): never answer
// it by typing.
const ASKING = new RegExp([
  String.raw`do\s+you\s+want\s+to`, String.raw`would\s+you\s+like\s+to`, String.raw`do\s+you\s+trust`,
  String.raw`trust\s+(?:this|the)\s+(?:folder|directory|files)`, String.raw`trust\s+all`, String.raw`review\s+(?:the\s+)?hooks`,
  String.raw`allow\s+(?:this|command|once|always)`, String.raw`\[y/n\]`, String.raw`\(y/n\)`,
  String.raw`press\s+enter\s+to\s+(?:continue|confirm)`, String.raw`waiting\s+for\s+(?:your\s+)?(?:approval|confirmation)`,
].join('|'), 'i');
// ... with its choices: a question the agent only wrote in its answer must not keep it from waking.
const CHOICES = /(?:^|\s)[❯›>]?\s*1[.)]\s+\S|\[y\/n\]|\(y\/n\)|\(esc\)|enter\s+(?:to\s+)?(?:confirm|select|continue)|navigate/im;
// A menu with one choice highlighted (Claude's ❯, Codex's ›, Antigravity's >) waits for a key, whatever it asks
// - an update, a folder to trust: Enter would pick for you.
const MENU = /[❯›]\s*\d[.)]\s+\S|enter\s+(?:to\s+)?(?:continue|confirm|select)\s*·\s*esc|(?:^|\s)[❯›>]\s*(?:yes|no)\b[\s\S]{0,80}(?:navigate|enter\s+(?:to\s+)?(?:confirm|select))/i;
// Whether to trust a folder (or its hooks) is the owner's decision alone: such a question blocks waking whatever
// its choices look like (seen: Antigravity's unnumbered "> Yes, I trust this folder" slipped past the checks
// above, and the line's Enter trusted the folder).
const TRUST = /do\s+you\s+trust|trust\s+(?:this|the)\s+(?:folder|directory|files|workspace|project)|trust\s+all|review\s+(?:the\s+)?hooks/i;
const CLEARED = /\x1b\[[23]J|\x1bc/g; // the screen was cleared: what came before is gone

/** Work an agent was in the middle of: tasks it should do, results it should review. */
export function unfinished(me: RoleSession): string[] {
  const mine = me.store.tasks({ assignee: me.name, states: ['open', 'working'] }).map((t) => `#${t.id} ${t.title}`);
  const review = me.toReview().map((t) => `#${t.id} ${t.title} (to review)`);
  return [...mine, ...review];
}

/** The one line typed into an idle agent's terminal: what waits, and how to get it. */
export function wakeLine(harness: string, role: string, tasks: string[] | null = null): string {
  let line: string;
  if (tasks?.length) {
    const shown = tasks.slice(0, 4).join('; ') + (tasks.length > 4 ? `; and ${tasks.length - 4} more` : '');
    // a start, first or again: no word of a restart, which would send a new agent looking for one
    line = `agent-org: '${role}', you have unfinished work: ${shown}. Carry on with it (list_tasks), `
      + 'then end your turn.';
  } else {
    line = `agent-org: '${role}', you have new messages. Call read_inbox and act on them, then end your turn.`;
  }
  if (harness === 'antigravity') { // no system prompt of its own: a new conversation learns its role here
    line += ` If this conversation has not read your role yet, first call_mcp_tool with ServerName agent-org_${SERVER_NAME}, `
      + "ToolName my_role, Arguments {}: it also lists every team tool's arguments, so there is no need to open their files.";
  }
  return line;
}

export function asking(term: Pick<Terminal, 'chunk' | 'end'>): boolean {
  let data = term.chunk(Math.max(0, term.end - TAIL)).data;
  const cleared = [...data.matchAll(CLEARED)].at(-1);
  if (cleared?.index !== undefined) data = data.slice(cleared.index + cleared[0].length);
  const text = data.replace(MOVES, ' ').replace(ANSI, '');
  return MENU.test(text) || TRUST.test(text) || (ASKING.test(text) && CHOICES.test(text));
}

/** Type `line` and press Enter - apart, so the program takes the text as typed, not pasted. */
export async function typeLine(term: Pick<Terminal, 'write'>, line: string): Promise<void> {
  term.write(line);
  await new Promise((r) => setTimeout(r, 400));
  term.write('\r');
}

/** Decides, every couple of seconds, which resting agents get a line - and types it. */
export class Waker {
  private readonly typedAt = new Map<number, number>(); // terminal id -> when it last got a line
  private readonly tries = new Map<number, [number | null, number]>(); // terminal id -> [oldest mail id it was woken for, times]
  private readonly started = new Set<number>(); // terminals already checked for unfinished work
  typeLine: (term: Terminal, line: string) => unknown = typeLine;

  /** Wake whoever needs it; returns the roles woken. */
  tick(hub: Hub, host: Pick<TerminalHost, 'items'>, at: number | null = null): string[] {
    const now = at ?? Date.now() / 1000;
    const team = hub.team;
    const unreadSince = hub.store.unreadSince();
    const stuck = hub.stuck(); // out of usage, or broken: a line would change nothing (it is restarted later)
    const online = hub.store.online(); // its program runs (its tool server checks in): else the line would go to a shell
    const woken: string[] = [];
    for (const [name, term] of host.items()) {
      const spec = team.roles[name];
      if (spec === undefined || spec.harness === 'deepseek' || !term.alive || name in stuck || !online[name]) continue;
      if (now - term.started < READY || now - term.lastOutput < QUIET || now - term.lastInput < TYPED) continue;
      if (term.unsent && now - term.lastInput < UNSENT) continue;
      const [since, oldest] = unreadSince[name] ?? [null, null];
      let [wokenFor, times] = this.tries.get(term.id) ?? [null, 0];
      if (oldest !== wokenFor) times = 0; // other mail than last time: it did read what it was woken for
      if (now - (this.typedAt.get(term.id) ?? 0) < Math.min(AGAIN * 2 ** times, MOST)) continue;
      const firstLook = !this.started.has(term.id);
      this.started.add(term.id);
      let line: string;
      let tasks: string[];
      if (since !== null && now - since >= UNREAD_FOR) line = wakeLine(spec.harness, name);
      else if (firstLook && (tasks = unfinished(hub.session(name))).length) line = wakeLine(spec.harness, name, tasks);
      else continue;
      if (asking(term)) {
        this.started.delete(term.id); // look again once it is answered
        continue;
      }
      this.typedAt.set(term.id, now);
      this.tries.set(term.id, [oldest, times + 1]);
      void this.typeLine(term, line);
      hub.event('agent', name, `woken: ${line.includes('unfinished work') ? 'unfinished work' : 'new messages'}`);
      woken.push(name);
    }
    return woken;
  }
}
