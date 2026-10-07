/**
 * Command line access to the hub, for you (the owner) and for testing roles by hand.
 *
 *     org tree
 *     org --as worker-a send tech-lead "tests are green"
 *     org --as tech-lead inbox
 *
 * The team file and role default to $AGENT_ORG_TEAM (else ./team.yaml) and $AGENT_ORG_ROLE (else the owner).
 */

import path from 'node:path';
import { Hub, HubError, type RoleSession, type RoleView } from './hub.ts';
import { tabOpener } from './launch.ts';
import type { Lock, Message } from './store.ts';
import { TeamError } from './team.ts';
import { dict } from './dict.ts';

const COMMANDS: Record<string, [string, string]> = dict({ // name: [arguments, what it does]
  tree: ['', 'show the role tree'],
  send: ['TO TEXT [--reply-to ID]', 'message your superior or anyone below you'],
  help: ['TEXT [--reply-to ID]', 'ask your direct superior for help'],
  inbox: ['', 'read (and mark read) your new messages'],
  wait: ['[--timeout SECONDS]', 'wait for new messages'],
  status: ['STATE [TASK]', 'set your status'],
  view: ['ROLE', 'look at yourself or a role below you'],
  claim: ['PATH', 'take the write lock on a file'],
  release: ['PATH', 'release a write lock'],
  locks: ['', 'list all write locks'],
  'hand-over': ['PATH TO', 'give a lock you hold to your superior or a direct subordinate'],
  summon: ['HELP_ID TIER [--brief TEXT]', 'attach a consultant to the sender of a help request you received'],
  dismiss: ['NAME', 'dismiss a consultant working for you or below you'],
  'can-write': ['PATH', 'exit 0 if you hold the lock on PATH, else 1'],
});

export class UsageError extends Error {}

function usage(): string {
  const lines = ['usage: org [--team FILE] [--as ROLE] COMMAND ...', '', 'Chain-of-command hub for AI agents. Commands:'];
  for (const [name, [args, what]] of Object.entries(COMMANDS)) lines.push(`  ${`${name} ${args}`.padEnd(38)} ${what}`);
  return lines.join('\n');
}

interface Parsed { team: string; role: string | null; command: string; words: string[]; options: Record<string, string> }

export function parse(argv: string[]): Parsed {
  const parsed: Parsed = { team: process.env.AGENT_ORG_TEAM || 'team.yaml', role: process.env.AGENT_ORG_ROLE || null,
    command: '', words: [], options: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      if (name === 'team') parsed.team = value;
      else if (name === 'as') parsed.role = value;
      else parsed.options[name] = value;
    } else if (!parsed.command) {
      parsed.command = a;
    } else {
      parsed.words.push(a);
    }
  }
  if (!(parsed.command in COMMANDS)) throw new UsageError(parsed.command ? `unknown command: ${parsed.command}` : 'no command given');
  return parsed;
}

function words(p: Parsed, need: number, most = need): string[] {
  if (p.words.length < need || p.words.length > most) throw new UsageError(`usage: org ${p.command} ${COMMANDS[p.command][0]}`);
  return p.words;
}

function number(text: string | undefined, what: string): number | null {
  if (text === undefined) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) throw new UsageError(`${what} must be a number`);
  return n;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const fmtTime = (t: number): string => {
  const d = new Date(t * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const fmtMessage = (m: Message): string =>
  `#${m.id} ${fmtTime(m.sent_at)} [${m.kind}] ${m.sender} -> ${m.recipient}${m.reply_to ? ` (re #${m.reply_to})` : ''}: ${m.text}`;
const fmtLock = (lock: Lock): string => `${lock.path}  held by ${lock.owner} since ${fmtTime(lock.claimed_at)}`;
const messages = (list: Message[], empty: string): string => (list.length ? list.map(fmtMessage).join('\n') : empty);

function fmtView(v: RoleView): string {
  const lines = [v.role === null ? v.name : `${v.name}  [${v.role.harness}${v.role.model ? ` / ${v.role.model}` : ''}]`,
    `  superior:     ${v.superior || '-'}`, `  subordinates: ${v.subordinates.join(', ') || '-'}`];
  if (v.role?.duties) lines.push(`  duties:       ${v.role.duties}`);
  if (v.role) lines.push(`  write scope:  ${v.role.write_scope.join(', ') || 'nothing'}`);
  if (v.status) lines.push(`  status:       ${v.status.state}${v.status.task ? ` - ${v.status.task}` : ''} (${fmtTime(v.status.updated_at)})`);
  lines.push(`  session:      ${v.online ? 'running' : 'not running'}`, `  locks:        ${v.locks.map((l) => l.path).join(', ') || '-'}`);
  if (v.limited) {
    lines.push('  (its messages are visible only to itself and the roles above it)');
  } else {
    lines.push(`  unread:       ${v.unread}`);
    if (v.recent.length) lines.push('  recent messages:', ...v.recent.map((m) => `    ${fmtMessage(m)}`));
  }
  return lines.join('\n');
}

/** Carry out one command; returns [what to print, exit code]. */
export async function run(p: Parsed, hub: Hub, me: RoleSession): Promise<[string, number]> {
  const replyTo = number(p.options['reply-to'], '--reply-to');
  switch (p.command) {
    case 'tree': words(p, 0); return [hub.team.treeLines().join('\n'), 0];
    case 'send': { const [to, text] = words(p, 2); return [fmtMessage(me.send(to, text, replyTo)), 0]; }
    case 'help': return [fmtMessage(me.askHelp(words(p, 1)[0], replyTo)), 0];
    case 'inbox': words(p, 0); return [messages(me.readInbox(), 'no new messages'), 0];
    case 'wait': words(p, 0); return [messages(await me.waitForMessages(number(p.options.timeout, '--timeout') ?? 300), 'no messages before timeout'), 0];
    case 'status': {
      const [state, task = ''] = words(p, 1, 2);
      const s = me.setStatus(state, task);
      return [`${s.role}: ${s.state}${s.task ? ` - ${s.task}` : ''}`, 0];
    }
    case 'view': return [fmtView(me.view(words(p, 1)[0])), 0];
    case 'claim': return [fmtLock(me.claim(words(p, 1)[0])), 0];
    case 'release': return [`released ${me.release(words(p, 1)[0]).path}`, 0];
    case 'locks': { words(p, 0); const locks = hub.store.locks(); return [locks.length ? locks.map(fmtLock).join('\n') : 'no locks', 0]; }
    case 'hand-over': { const [file, to] = words(p, 2); return [`handed over: ${fmtLock(me.handOver(file, to))}`, 0]; }
    case 'summon': {
      const [helpId, tier] = words(p, 2);
      const role = me.summonConsultant(number(helpId, 'HELP_ID') ?? 0, tier, p.options.brief ?? '');
      return [`summoned ${role.name} (${role.tier}, ${role.harness}) under ${role.superior}`, 0];
    }
    case 'dismiss': {
      const [role, returned] = me.dismissConsultant(words(p, 1)[0]);
      return [`dismissed ${role.name}${returned.length ? `; files back to ${role.superior}: ${returned.join(', ')}` : ''}`, 0];
    }
    case 'can-write': return ['', me.canWrite(words(p, 1)[0]) ? 0 : 1];
    default: throw new UsageError(`unknown command: ${p.command}`);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return argv.length ? 0 : 2;
  }
  let p: Parsed;
  try {
    p = parse(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`${e.message}\n\n${usage()}\n`);
    return 2;
  }
  const teamFile = path.resolve(p.team);
  let hub: Hub;
  try {
    hub = Hub.open(teamFile, tabOpener(teamFile));
  } catch (e) {
    if (!(e instanceof TeamError)) throw e;
    process.stderr.write(`team error: ${e.message}\n`);
    return 2;
  }
  try {
    const [text, code] = await run(p, hub, hub.session(p.role || hub.team.owner));
    if (text) process.stdout.write(`${text}\n`);
    return code;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    if (!(e instanceof HubError)) throw e;
    process.stderr.write(`refused: ${e.message}\n`);
    return 1;
  } finally {
    hub.close();
  }
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) process.exitCode = await main();
