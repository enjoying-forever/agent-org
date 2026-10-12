/**
 * The team as an agent sees it: the part of the tree around it, as short or as full as it asks.
 *
 * The root is the agent's superior; below it the agent and its peers (each one line, with how many are under
 * it); below the agent, its own subtree, down to `depth` levels in all (the team's tree_depth, 3 unless set:
 * superior, peers and self, subordinates). Each agent has a one-line "about" it writes itself (set_about), or
 * its superior writes for it; until then, the first sentence of its duties stands in.
 */

import { describeStuck, HubError, PermissionDenied, type RoleSession } from './hub.ts';
import type { Action, Status, Task } from './store.ts';

export const ABOUT_MAX = 160; // characters: one line
export type Detail = 'brief' | 'full';
export const aboutKey = (role: string): string => `about:${role}`;

const cut = (text: string, n: number): string => (text.length <= n ? text : `${text.slice(0, n - 1).trimEnd()}…`);
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** What the role says it is about, or the first sentence of its duties. */
export function aboutOf(me: RoleSession, role: string): string {
  const own = me.store.getSetting(aboutKey(role));
  if (own) return own;
  const duties = oneLine(me.team.roles[role]?.duties ?? '');
  return cut(duties.split(/(?<=[.!?。])\s/)[0] ?? '', 100);
}

function ago(seconds: number): string {
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

interface Facts {
  statuses: Record<string, Status>;
  online: Record<string, number>;
  tasks: Record<string, Task[]>;
  files: Record<string, string[]>;
  actions: Record<string, Action[]>;
  unread: Record<string, number>;
  stuck: Record<string, string>;
}

function facts(me: RoleSession, detail: Detail): Facts {
  const store = me.store;
  const tasks: Record<string, Task[]> = {};
  for (const t of store.tasks({ openOnly: true })) (tasks[t.assignee] ??= []).push(t);
  const files: Record<string, string[]> = {};
  for (const l of store.locks()) (files[l.owner] ??= []).push(l.path);
  const stuck = Object.fromEntries(Object.entries(me.hub.stuck()).map(([n, info]) => [n, describeStuck(info)]));
  return {
    statuses: store.statuses(), online: store.online(), tasks, files, stuck,
    actions: detail === 'full' ? store.recentActions(2) : {}, unread: detail === 'full' ? store.unreadCounts() : {},
  };
}

/** One agent: a line, and in full detail the lines under it. */
function node(me: RoleSession, name: string, f: Facts, detail: Detail, below: number, indent: string, live = true): string[] {
  const team = me.team;
  const role = team.roles[name];
  const s = f.statuses[name];
  const open = f.tasks[name] ?? [];
  const running = (f.online[name] ?? 0) > 0;
  const kind = [role.harness, role.is_consultant ? `consultant (${role.tier})` : ''].filter(Boolean).join(', ');
  const about = aboutOf(me, name);
  // a stopped agent's last status is old news: what matters is that it is not running, and what waits for it
  let now = !running ? 'not running' : s ? `${s.state}${s.task ? `: ${cut(oneLine(s.task), detail === 'full' ? 160 : 70)}` : ''}` : 'running';
  if (!running && open.length) now += ` (${open.length} open task${open.length > 1 ? 's' : ''})`;
  const parts = [`${indent}- ${name} [${kind}]`, about ? ` - ${about}` : '', live ? ` | ${now}` : '',
    below ? ` (+${below} below)` : '', live && f.stuck[name] ? ` -- ${f.stuck[name].toUpperCase()}` : '', name === me.name ? '  <- you' : ''];
  const lines = [parts.join('')];
  if (detail !== 'full') return lines;
  const pad = `${indent}    `;
  const model = [role.model || 'default model', role.effort && `${role.effort} effort`].filter(Boolean).join(', ');
  lines.push(`${pad}model: ${model} | writes: ${role.write_scope.join(', ') || 'nothing'}`);
  if (role.duties) lines.push(`${pad}duties: ${cut(oneLine(role.duties), 200)}`);
  if (open.length) lines.push(`${pad}tasks: ${open.slice(0, 4).map((t) => `#${t.id} [${t.state}] ${cut(t.title, 60)} (from ${t.assigner})`).join('; ')}${open.length > 4 ? `; and ${open.length - 4} more` : ''}`);
  if (f.files[name]?.length) lines.push(`${pad}files: ${f.files[name].slice(0, 6).join(', ')}${f.files[name].length > 6 ? ', ...' : ''}`);
  const nowS = Date.now() / 1000;
  const acts = f.actions[name] ?? [];
  if (acts.length) lines.push(`${pad}lately: ${acts.map((a) => `${cut(a.what, 60)} (${a.ended_at === null ? 'running' : ago(nowS - a.ended_at)})`).join('; ')}`);
  const tail = [s ? `status updated ${ago(nowS - s.updated_at)}` : '', f.unread[name] ? `${f.unread[name]} unread` : ''].filter(Boolean);
  if (tail.length) lines.push(`${pad}${tail.join('; ')}`);
  return lines;
}

/** The tree around `around` (the caller unless given), `depth` levels deep in all. */
export function teamTree(me: RoleSession, opts: { depth?: number; detail?: Detail; around?: string; live?: boolean } = {}): string {
  const live = opts.live ?? true; // false: who and what about only (a role card is read long after it is written)
  const team = me.team;
  const depth = Math.max(2, Math.min(12, Math.trunc(opts.depth ?? team.settings.tree_depth)));
  const detail: Detail = opts.detail === 'full' ? 'full' : 'brief';
  const center = opts.around || me.name;
  if (center !== team.owner && !(center in team.roles)) throw new HubError(`there is no '${center}' in the team`);
  const f = facts(me, detail);
  const size = (name: string): number => team.subtreeOf(name).length;
  const lines: string[] = [];
  // down from `name`, its children at `level`
  const expand = (name: string, level: number, indent: string): void => {
    for (const child of team.subordinatesOf(name)) {
      const deeper = level < depth && team.subordinatesOf(child).length > 0;
      lines.push(...node(me, child, f, detail, deeper ? 0 : size(child), indent, live));
      if (deeper) expand(child, level + 1, `${indent}  `);
    }
  };
  const ownerLine = `${team.owner} (the owner, a person)`;
  if (center === team.owner) {
    lines.push(ownerLine);
    expand(team.owner, 2, '  ');
  } else {
    const root = team.roles[center].superior;
    const above = team.chainOf(root).reverse();
    if (root === team.owner) lines.push(ownerLine);
    else lines.push(...node(me, root, f, detail, 0, '', live).map((l, i) => (i === 0 ? l.replace(/^- /, '') : l)));
    for (const peer of team.subordinatesOf(root)) {
      const open = peer === center && depth >= 3 && team.subordinatesOf(peer).length > 0;
      lines.push(...node(me, peer, f, detail, open ? 0 : size(peer), '  ', live));
      if (open) expand(peer, 3, '    ');
    }
    if (above.length) lines.unshift(`(above ${root}: ${above.join(' > ')})`);
  }
  const who = center === me.name ? 'you' : center === team.owner ? `the owner (${center})` : center;
  const head = live ? `Team around ${who} (${depth} levels, ${detail}):` : `Team around ${who} (${depth} levels; who is doing what now: team_tree):`;
  return [head, ...lines].join('\n');
}

/** Write the one-line about of `role` (you, or someone below you). Empty: back to the first line of its duties. */
export function setAbout(me: RoleSession, text: string, role = me.name): string {
  const team = me.team;
  if (!(role in team.roles)) throw new HubError(`there is no '${role}' in the team`);
  if (role !== me.name && !team.isAbove(me.name, role)) throw new PermissionDenied(`only ${role} itself or someone above it writes its about`);
  const line = oneLine(text);
  if (line.length > ABOUT_MAX) throw new HubError(`keep it to one line of at most ${ABOUT_MAX} characters (this is ${line.length})`);
  me.store.setSetting(aboutKey(role), line);
  return line;
}
