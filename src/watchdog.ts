/**
 * The watchdog: finds stuck, silent or stopped work, nudges, escalates, and lists problems.
 *
 * Modelled on Gas Town's Witness. `patrol` runs every half minute while the window is open. It acts once per
 * problem - the hub remembers what it already did - and returns what still needs a person's attention.
 *
 * - Leases that ran out are released (and noted in the activity, not sent: that would wake the agent).
 * - A task with no progress for STALL minutes gets a nudge; after another STALL minutes, whoever assigned it is told.
 * - A question left unanswered for HELP_WAIT minutes is passed up one level.
 * - An agent that is not running but has work, two sessions of one role, and two agents trading messages in a loop
 *   are listed as problems.
 * - Questions, reviews and blocked tasks waiting for the owner are listed too.
 * - An agent out of its subscription's usage limit is not started (it would only fail); whoever gave it tasks is
 *   told once, with who else is free to take them. When the limit resets - or RETRY_AFTER after any other API error
 *   - an agent still sitting at its prompt is listed to be restarted, which the window does with autostart on.
 */

import { describeStuck, HUB, type Hub } from './hub.ts';
import { now as clockNow, type Task } from './store.ts';
import * as usage from './usage.ts';

export const STALL = 20 * 60; // seconds without progress before a working task is nudged
export const HELP_WAIT = 15 * 60; // seconds a question may wait before it is passed up
export const LOOP_WINDOW = 10 * 60; // seconds over which message traffic between two roles is counted
export const LOOP_LIMIT = 16; // messages between two roles in LOOP_WINDOW that look like a loop
const QUIET = 6 * 3600; // after escalating a stalled task, stay quiet about it this long
export const RETRY_AFTER = 3 * 60; // seconds an agent may sit on an API error before it is restarted

export interface Problem {
  kind: string; // stopped, limit, stuck, stalled, question, review, blocked, loop, duplicate
  role: string; // who it is about
  text: string; // what a person should know
  action: string; // what the window offers: start, stop, restart, reassign, answer, review, open-task
  task_id: number | null;
  message_id: number | null;
}

const problem = (kind: string, role: string, text: string, action = '', taskId: number | null = null,
  messageId: number | null = null): Problem => ({ kind, role, text, action, task_id: taskId, message_id: messageId });

/** True the first time `key` is seen (and remembers it). */
function once(hub: Hub, key: string): boolean {
  if (hub.store.getSetting(`watch:${key}`)) return false;
  hub.store.setSetting(`watch:${key}`, String(Math.trunc(clockNow())));
  return true;
}

export function minutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return m < 120 ? `${m} minute${m !== 1 ? 's' : ''}` : `${Math.floor(m / 60)} hours`;
}

/** Agents whose conversation ended on an API error (a usage limit, most often). */
export function stuckAgents(hub: Hub): Record<string, usage.Stuck> {
  const found: Record<string, usage.Stuck> = {};
  const activity = hub.store.activity();
  for (const [name, role] of Object.entries(hub.team.roles)) {
    const record = hub.store.getSession(name);
    if (record === null || record.harness !== role.harness) continue;
    const s = usage.stuck(role.harness, record.session_id);
    if (s !== null && (activity[name] ?? 0) <= s.at) found[name] = s; // it has not worked since
  }
  return found;
}

/** Who below `below` could take over from `insteadOf`: not stuck, other programs and idle ones first. */
export function freeAgents(hub: Hub, below: string, insteadOf: string, stuck: Record<string, usage.Stuck>, openTasks: Task[]): string[] {
  const team = hub.team;
  const harness = team.roles[insteadOf].harness;
  const load = (n: string): number => openTasks.filter((t) => t.assignee === n).length;
  const names = Object.keys(team.roles).filter((n) => n !== insteadOf && !(n in stuck) && !team.roles[n].is_consultant && team.isAbove(below, n));
  const key = (n: string): [number, number, string] => [team.roles[n].harness === harness ? 1 : 0, load(n), n];
  return names.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
  });
}

export function patrol(hub: Hub, act = true, at: number | null = null): Problem[] {
  const now = at ?? clockNow();
  const store = hub.store;
  const team = hub.team;
  const owner = team.owner;
  const online = store.online();
  const activity = store.activity();
  const problems: Problem[] = [];
  const stuck = stuckAgents(hub);
  if (act) hub.setStuck(Object.fromEntries(Object.entries(stuck).map(([n, s]) => [n, { ...s }])));

  if (act) { // leases whose holder went quiet: noted, not sent - a message would wake an idle agent for nothing
    for (const lock of store.expire()) hub.event('file', lock.owner, `lease on ${lock.path} ran out and was released`);
  }

  const openTasks = store.tasks({ openOnly: true });
  for (const name of Object.keys(team.roles)) {
    const mine = openTasks.filter((t) => t.assignee === name && ['open', 'working', 'blocked'].includes(t.state));
    const reviews = openTasks.filter((t) => t.assigner === name && t.state === 'done');
    const s = stuck[name];
    if (s !== undefined && s.kind === 'limit' && (s.until ?? 0) > now) {
      if (mine.length || reviews.length) problems.push(limited(hub, name, s, mine, reviews, stuck, openTasks, act));
      continue; // starting it now would only fail again
    }
    if (s !== undefined && online[name] && (mine.length || reviews.length || store.unreadCount(name))
      && (s.kind === 'limit' || now - s.at >= RETRY_AFTER)) {
      const why = s.kind === 'limit' ? 'its usage limit has reset' : `an API error (${s.text.slice(0, 120)})`;
      problems.push(problem('stuck', name, `${name} stopped on ${why} and sits idle at its prompt with work waiting. Restart it to carry on.`, 'restart'));
      continue;
    }
    if (!online[name] && (mine.length || reviews.length)) {
      const what = [...(mine.length ? [`${mine.length} task(s) to do`] : []), ...(reviews.length ? [`${reviews.length} to review`] : [])].join(', ');
      problems.push(problem('stopped', name, `${name} is not running but has ${what}.`, 'start'));
    }
    if ((online[name] ?? 0) > 1) {
      problems.push(problem('duplicate', name, `${name} runs in ${online[name]} sessions that split its messages. Stop it and start it again.`, 'stop'));
    }
  }

  for (const task of openTasks) {
    if (task.state !== 'working' || !online[task.assignee] || task.assignee in stuck) continue;
    const busyBelow = openTasks.some((t) => t.assigner === task.assignee && ['waiting', 'open', 'working', 'blocked', 'done'].includes(t.state));
    if (busyBelow) continue; // waiting for its own subtasks is progress of a kind
    const last = Math.max(task.started_at ?? 0, task.updated_at, activity[task.assignee] ?? 0);
    if (task.nudged_at !== null && last > task.nudged_at) { // it moved after the nudge: start over
      if (act) store.updateTask(task.id, { nudged_at: null });
      continue;
    }
    const idle = now - last;
    if (idle < STALL) continue;
    if (task.nudged_at === null) {
      if (act) {
        hub.notice(task.assignee, `Task #${task.id} (${task.title}) has shown no progress for ${minutes(idle)}. Carry on, `
          + `or finish_task(${task.id}, ...) as blocked or failed and say why.`, task.id);
        store.updateTask(task.id, { nudged_at: now });
        hub.event('watch', task.assignee, `nudged about #${task.id}`, task.id);
      }
    } else if (now < task.nudged_at) {
      // escalated already; quiet for a while
    } else if (now - task.nudged_at >= STALL) {
      if (act) {
        if (task.assigner !== owner) {
          hub.notice(task.assigner, `Task #${task.id} you gave to ${task.assignee} (${task.title}) has stalled: no progress `
            + `for ${minutes(idle)}, even after a reminder. Check on it, help, reassign or cancel it.`, task.id);
        }
        store.updateTask(task.id, { nudged_at: now + QUIET });
        hub.event('watch', task.assigner, `told that #${task.id} stalled`, task.id);
      }
      problems.push(problem('stalled', task.assignee, `Task #${task.id} (${task.title}) has shown no progress for ${minutes(idle)}.`, 'open-task', task.id));
    } else {
      problems.push(problem('stalled', task.assignee, `Task #${task.id} (${task.title}) is quiet; ${task.assignee} was reminded.`, 'open-task', task.id));
    }
  }

  const helped = new Set(store.activeConsultants().map((c) => c.help_id));
  for (const name of [owner, ...Object.keys(team.roles)]) {
    for (const question of store.messagesTo(name, ['help'])) {
      if (helped.has(question.id) || store.repliesTo(question.id, name).length) continue;
      if (name === owner) {
        problems.push(problem('question', question.sender, `${question.sender} asks you: ${question.text.slice(0, 200)}`, 'answer', null, question.id));
        continue;
      }
      const waited = now - question.sent_at;
      if (waited < HELP_WAIT) continue;
      const above = team.superiorOf(name);
      if (act && above && once(hub, `help-up:${question.id}`)) {
        hub.notice(above, `${question.sender} asked ${name} for help (#${question.id}) ${minutes(waited)} ago and has no answer yet:`
          + `\n\n${question.text.slice(0, 1500)}\n\nAnswer ${question.sender} with send_message(to="${question.sender}", `
          + `reply_to=${question.id}) if you can, or make sure ${name} does.`);
        hub.event('watch', name, `passed question #${question.id} up to ${above}`);
      }
    }
  }

  for (const task of openTasks) {
    if (task.assigner === owner && task.state === 'done') {
      problems.push(problem('review', task.assignee, `Task #${task.id} (${task.title}) is done and waits for your review.`, 'review', task.id));
    } else if (task.assigner === owner && task.state === 'blocked') {
      problems.push(problem('blocked', task.assignee, `Task #${task.id} (${task.title}) is blocked: ${task.result.slice(0, 200)}`, 'open-task', task.id));
    }
  }

  for (const [a, b, count] of store.pairTraffic(now - LOOP_WINDOW).values()) {
    if (count < LOOP_LIMIT || a === HUB || b === HUB) continue;
    problems.push(problem('loop', a, `${a} and ${b} exchanged ${count} messages in the last ${minutes(LOOP_WINDOW)}; they may be going round in circles.`));
    if (act && once(hub, `loop:${a}:${b}:${Math.floor(now / LOOP_WINDOW)}`)) {
      const above = a in team.roles && b in team.roles ? (team.chainOf(a).find((x) => team.chainOf(b).includes(x)) ?? owner) : owner;
      if (above !== owner && team.isMember(above)) {
        hub.notice(above, `${a} and ${b} exchanged ${count} messages in ${minutes(LOOP_WINDOW)}. They may be going round in circles: step in and decide for them.`);
      }
      hub.event('watch', a, `possible loop between ${a} and ${b}`);
    }
  }
  return problems;
}

/** An agent out of its usage limit with work: tell whoever gave it tasks (once), list it for the owner. */
function limited(hub: Hub, name: string, s: usage.Stuck, mine: Task[], reviews: Task[], stuck: Record<string, usage.Stuck>,
  openTasks: Task[], act: boolean): Problem {
  const team = hub.team;
  const when = describeStuck({ ...s });
  const parts = [...(mine.length ? [`${mine.length} unfinished task(s)`] : []), ...(reviews.length ? [`${reviews.length} result(s) to review`] : [])];
  const key = `watch:limit:${name}:${Math.trunc(s.at)}`;
  if (act && hub.store.getSetting(key) === '') {
    hub.store.setSetting(key, String(Math.trunc(clockNow())));
    hub.event('watch', name, when);
    const byAssigner = new Map<string, Task[]>();
    for (const t of mine) byAssigner.set(t.assigner, [...(byAssigner.get(t.assigner) ?? []), t]);
    for (const [assigner, tasks] of byAssigner) {
      if (assigner === team.owner || !team.isMember(assigner)) continue;
      const free = freeAgents(hub, assigner, name, stuck, openTasks).slice(0, 3);
      const who = free.length ? ` Free to take them: ${free.map((n) => `${n} (${team.roles[n].harness})`).join(', ')}.` : '';
      hub.notice(assigner, `${name} (${team.roles[name].harness}) is ${when}. The task(s) you gave it cannot move until then: `
        + `${tasks.map((t) => `#${t.id} ${t.title}`).join(', ')}.${who} Move them with reassign_task(task_id, to, reason), or let them wait for the reset.`, tasks[0].id);
    }
  }
  return problem('limit', name, `${name} is ${when}, with ${parts.join(' and ')}. Move its tasks to someone else, or let them wait.`, 'reassign');
}
