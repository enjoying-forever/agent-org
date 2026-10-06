/** Role cards: the text that tells an agent who it is, the law it works under, and where it left off. */

import { lawText, type RoleSession } from './hub.ts';
import { describe } from './verify.ts';

export const SERVER_NAME = 'org';
export const HOOK_TOOL = 'agent_org_hook'; // answered by an agent's org tool server, which lists it to no model
const RECENT = 12; // messages recalled in "where you left off" (about open work)

/** `resumed`: for a conversation that is continued, which has its own messages already. */
export function roleCard(me: RoleSession, resumed = false): string {
  const team = me.team;
  const role = team.roles[me.name];
  if (role !== undefined && role.is_consultant) return consultantCard(me, resumed);

  const superior = me.superior;
  const lines = [`You are '${me.name}' in an agent team run by ${team.owner} (the owner).`];
  if (role?.duties) lines.push(`Your duties: ${role.duties}`);
  if (role?.instructions) lines.push('Your instructions (from the owner):', role.instructions);
  if (superior === team.owner) {
    lines.push(`Your superior: ${superior}, the owner: a person who reads your messages in the agent-org UI. You are the team's leader.`);
  } else {
    lines.push(`Your superior: ${superior}`);
  }
  const subs = team.subordinatesOf(me.name);
  lines.push(`Your direct subordinates: ${subs.join(', ') || 'none'}`);
  const peers = me.peers(team);
  if (peers.length) lines.push(`Your peers (same superior): ${peers.join(', ')}`);
  lines.push('The whole team (who reports to whom):');
  for (const name of [team.leader, ...team.subtreeOf(team.leader)]) {
    const r = team.roles[name];
    const depth = team.chainOf(name).length;
    const you = name === me.name ? '  <- you' : '';
    lines.push(`${'  '.repeat(depth)}- ${name} (${r.harness}): ${r.duties || '-'}${you}`);
  }
  const scope = role ? role.write_scope.join(', ') : 'everything';
  lines.push(`Files you may write: ${scope || 'none - you do not edit files'}`);
  if (me.hub.branches) {
    lines.push(`Your own copy of the project: ${me.hub.rootOf(me.name)} (git branch agent/${me.hub.branchRole(me.name)}). `
      + 'Work only there. finish_task(done) puts your work into main for everyone; share_work does it earlier, for things '
      + "others need now (an interface, a plan). Your copy takes in main's new work by itself as you go.");
  }
  if (team.checks.length) {
    lines.push("The team's checks - finish_task(done) is refused until those that apply pass, so run them before you "
      + 'finish, and write tasks whose results can pass them:');
    lines.push(...team.checks.map((c) => `  - ${describe(c)}`));
  }
  lines.push(
    '',
    `THE MESSAGE LAW (the hub enforces it; you work through the '${SERVER_NAME}' tools):`,
    lawText(team.settings.branches),
    '',
    'How to work:',
    `- People only receive what you send with the ${SERVER_NAME} tools. Text you write in your own session reaches nobody.`,
    ...(superior === team.owner ? [
      '- As the leader: turn each task from the owner into a plan of tasks for your team, each with a done_when, '
      + 'ordered with after= where one needs another. Review every result against its done_when. When the owner\'s '
      + 'task is really done, finish_task it with a short summary of what was built and where.',
    ] : []),
    ...(team.settings.team_changes && (subs.length || superior === team.owner) ? [
      '- Your team is not fixed: if the work needs another agent (a tester, a second worker, a researcher), '
      + 'hire_agent one under you; change_agent adjusts one; let_go_agent removes one whose work is over. Every agent '
      + "costs the owner's subscriptions, so hire only for real need and pick the cheapest model that can do the job.",
    ] : []),
    "- Messages from 'hub' are the system's own reminders: a quiet task, a question passed up to you. Act on them.",
    '- When you have nothing left to do, end your turn: new messages are delivered to you automatically, and you are '
    + 'reminded of open tasks and unanswered questions.',
    '- Save what you know with save_notes from time to time: if your session is ever replaced, the new one starts from your notes.',
    ...(Object.keys(team.tiers).length ? [ // no tiers: there will never be one
      '- If your superior gives you a consultant, it is your temporary subordinate: work with it through '
      + 'send_message, hand_over_file it the files it should edit, and dismiss_consultant it when the problem is solved.',
    ] : []),
    '- If you lose track of your role, call my_role.',
  );
  if (team.canSummon(me.name)) {
    lines.push(
      '',
      "Consultants: when a subordinate's ask_help is too hard for it, you can call summon_consultant(help_id, tier, "
      + 'brief) to attach a temporary consultant under that subordinate. Judge the difficulty and pick the cheapest '
      + 'tier that can solve it; stronger tiers cost more. If a problem is simple, answer it yourself instead.',
      'Tiers:',
    );
    for (const tier of Object.values(team.tiers)) lines.push(`  - ${tier.describe()}${tier.use_for ? `: ${tier.use_for}` : ''}`);
  }
  lines.push(...whereYouLeftOff(me, resumed));
  return lines.join('\n');
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * What the hub remembers about this role, so even a brand-new session can carry on.
 *
 * Its recent messages only for a new conversation (a continued one has them already), and only those about its
 * open work: the history of finished work is sent with every request, and an old "please review" read as still
 * pending (seen: a leader went looking for a task long accepted). Each message about a task says what became of it.
 */
export function whereYouLeftOff(me: RoleSession, resumed = false): string[] {
  const lines: string[] = [];
  const notes = me.store.getNotes(me.name);
  const mine = me.myTasks();
  const given = me.givenTasks();
  const held = me.store.locks(me.name).map((l) => l.path);
  const openIds = new Set([...mine, ...given].map((t) => t.id));
  const recent = (resumed ? [] : me.store.messagesInvolving(me.name, RECENT)).filter((m) => m.task_id !== null && openIds.has(m.task_id));
  if (!(notes || mine.length || given.length || held.length || recent.length)) return lines;
  lines.push('', 'WHERE YOU LEFT OFF (kept by the hub between sessions):');
  if (notes) lines.push('Your notes:', notes);
  if (mine.length) {
    lines.push('Your open tasks:');
    lines.push(...mine.map((t) => `  #${t.id} [${t.state}] from ${t.assigner}: ${t.title}`));
  }
  if (given.length) {
    lines.push('Tasks you gave that are not finished:');
    lines.push(...given.map((t) => `  #${t.id} [${t.state}] to ${t.assignee}: ${t.title}`));
  }
  if (held.length) lines.push(`Files you hold: ${held.join(', ')}`);
  if (recent.length) {
    lines.push(`Your last ${recent.length} messages (oldest first):`);
    for (const m of recent) {
      const d = new Date(m.sent_at * 1000);
      const when = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      let text = m.text.split(/\s+/).filter((w) => w).join(' ');
      if (text.length > 240) text = `${text.slice(0, 240)}...`;
      const task = m.task_id ? me.store.getTask(m.task_id) : null;
      const state = task ? ` (task #${task.id} is now ${task.state})` : '';
      lines.push(`  #${m.id} ${when} [${m.kind}] ${m.sender} -> ${m.recipient}: ${text}${state}`);
    }
  }
  return lines;
}

function consultantCard(me: RoleSession, resumed: boolean): string {
  const c = me.store.getConsultant(me.name);
  if (c === null) throw new Error(`${me.name} is not a consultant`);
  const helped = c.helped;
  return [
    `You are '${me.name}', a temporary ${c.tier} consultant in an agent team run by ${me.team.owner} (the owner).`,
    `${c.summoned_by} summoned you to help ${helped} with its help request #${c.help_id}. The request and any brief are in your inbox.`,
    `Your superior: ${helped} (the agent you help)`,
    '',
    'Rules:',
    `- Talk to the team only through the '${SERVER_NAME}' tools. You can message only ${helped} (and answer anyone who writes to you).`,
    '- Read any project file you need.',
    `- You can edit only files ${helped} hands to you with hand_over_file; list_locks shows what you hold. When you are `
    + `done with a file, hand_over_file it back to ${helped} (release_file also returns it).`,
    `- Work with ${helped} until the problem is solved, then tell it so with send_message. ${helped} dismisses you; after `
    + 'that your tools stop working and you should stop.',
    "- Every message wakes its receiver: send only what they need, no 'thanks' or 'ok'.",
    '- When you have nothing left to do, end your turn: new messages are delivered to you automatically.',
    ...whereYouLeftOff(me, resumed),
  ].join('\n');
}
