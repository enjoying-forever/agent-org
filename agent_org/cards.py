"""Role cards: the text that tells an agent who it is, the law it works under, and where it left off."""

from __future__ import annotations

import time

from .hub import RoleSession, law_text
from .verify import describe

SERVER_NAME = "org"
RECENT = 12  # messages recalled in "where you left off"


def role_card(me: RoleSession) -> str:
    team = me.team
    role = team.roles.get(me.name)
    if role is not None and role.is_consultant:
        return _consultant_card(me)

    superior = me.superior
    lines = [f"You are '{me.name}' in an agent team run by {team.owner} (the owner)."]
    if role and role.duties:
        lines.append(f"Your duties: {role.duties}")
    if superior == team.owner:
        lines.append(f"Your superior: {superior}, the owner: a person who reads your messages in the "
                     "agent-org UI. You are the team's leader.")
    else:
        lines.append(f"Your superior: {superior}")
    subs = team.subordinates_of(me.name)
    lines.append(f"Your direct subordinates: {', '.join(subs) or 'none'}")
    peers = me._peers(team)
    if peers:
        lines.append(f"Your peers (same superior): {', '.join(peers)}")
    lines.append("The whole team (who reports to whom):")
    for name in [team.leader, *team.subtree_of(team.leader)]:
        r = team.roles[name]
        depth = len(team.chain_of(name))
        you = "  <- you" if name == me.name else ""
        lines.append(f"{'  ' * depth}- {name} ({r.harness}): {r.duties or '-'}{you}")
    scope = ", ".join(role.write_scope) if role else "everything"
    lines.append(f"Files you may write: {scope or 'none - you do not edit files'}")
    if me.hub.branches:
        lines.append(f"Your own copy of the project: {me.hub.root_of(me.name)} (git branch "
                     f"agent/{me.hub.branch_role(me.name)}). Work only there. finish_task(done) puts your work "
                     "into main for everyone; share_work does it earlier, for things others need now (an "
                     "interface, a plan). Your copy takes in main's new work by itself as you go.")
    if team.checks:
        lines.append("The team's checks - finish_task(done) is refused until those that apply pass, so run "
                     "them before you finish, and write tasks whose results can pass them:")
        lines += [f"  - {describe(c)}" for c in team.checks]
    lines += [
        "",
        f"THE MESSAGE LAW (the hub enforces it; you work through the '{SERVER_NAME}' tools):",
        law_text(team.settings.branches),
        "",
        "How to work:",
        f"- People only receive what you send with the {SERVER_NAME} tools. Text you write in your own "
        "session reaches nobody.",
        *([
            "- As the leader: turn each task from the owner into a plan of tasks for your team, each with "
            "a done_when, ordered with after= where one needs another. Review every result against its "
            "done_when. When the owner's task is really done, finish_task it with a short summary of what "
            "was built and where.",
        ] if superior == team.owner else []),
        *([
            "- Give work as tasks with a done_when, and split big work into several tasks; after= makes a "
            "task wait for others. Review each result (review_task) before building on it.",
            "- Each program runs on its own subscription. When the hub tells you a subordinate is out of "
            "its usage limit, move its urgent tasks with reassign_task to someone free - preferably on "
            "another program - and let the rest wait for the reset.",
        ] if subs else []),
        *([
            "- Your team is not fixed: if the work needs another agent (a tester, a second worker, a "
            "researcher), hire_agent one under you; change_agent adjusts one; let_go_agent removes one whose "
            "work is over. Every agent costs the owner's subscriptions, so hire only for real need and pick "
            "the cheapest model that can do the job.",
        ] if team.settings.team_changes and (subs or superior == team.owner) else []),
        "- Messages from 'hub' are the system's own reminders: a quiet task, an expired file lease, a "
        "question passed up to you. Act on them.",
        "- Keep your status current with set_status, so everyone can see what you are doing.",
        "- When you have nothing left to do, end your turn: new messages are delivered to you "
        "automatically, and you are reminded of open tasks and unanswered questions.",
        "- Save what you know with save_notes from time to time: if your session is ever replaced, "
        "the new one starts from your notes.",
        "- If your superior gives you a consultant, it is your temporary subordinate: work with it "
        "through send_message, hand_over_file it the files it should edit, and dismiss_consultant "
        "it when the problem is solved.",
        "- If you lose track of your role, call my_role.",
    ]
    if team.can_summon(me.name):
        lines += [
            "",
            "Consultants: when a subordinate's ask_help is too hard for it, you can call "
            "summon_consultant(help_id, tier, brief) to attach a temporary consultant under that "
            "subordinate. Judge the difficulty and pick the cheapest tier that can solve it; "
            "stronger tiers cost more. If a problem is simple, answer it yourself instead.",
            "Tiers:",
        ]
        for tier in team.tiers.values():
            use = f": {tier.use_for}" if tier.use_for else ""
            lines.append(f"  - {tier.describe()}{use}")
    lines += where_you_left_off(me)
    return "\n".join(lines)


def where_you_left_off(me: RoleSession) -> list[str]:
    """What the hub remembers about this role, so even a brand-new session can carry on."""
    lines: list[str] = []
    notes = me.store.get_notes(me.name)
    mine, given = me.my_tasks(), me.given_tasks()
    held = [lock.path for lock in me.store.locks(me.name)]
    recent = me.store.messages_involving(me.name, RECENT)
    if not (notes or mine or given or held or recent):
        return lines
    lines += ["", "WHERE YOU LEFT OFF (kept by the hub between sessions):"]
    if notes:
        lines += ["Your notes:", notes]
    if mine:
        lines.append("Your open tasks:")
        lines += [f"  #{t.id} [{t.state}] from {t.assigner}: {t.title}" for t in mine]
    if given:
        lines.append("Tasks you gave that are not finished:")
        lines += [f"  #{t.id} [{t.state}] to {t.assignee}: {t.title}" for t in given]
    if held:
        lines.append(f"Files you hold: {', '.join(held)}")
    if recent:
        lines.append(f"Your last {len(recent)} messages (oldest first):")
        for m in recent:
            when = time.strftime("%m-%d %H:%M", time.localtime(m.sent_at))
            text = " ".join(m.text.split())
            text = text if len(text) <= 240 else text[:240] + "..."
            lines.append(f"  #{m.id} {when} [{m.kind}] {m.sender} -> {m.recipient}: {text}")
    return lines


def _consultant_card(me: RoleSession) -> str:
    c = me.store.get_consultant(me.name)
    assert c is not None
    helped = c.helped
    return "\n".join([
        f"You are '{me.name}', a temporary {c.tier} consultant in an agent team run by "
        f"{me.team.owner} (the owner).",
        f"{c.summoned_by} summoned you to help {helped} with its help request #{c.help_id}. "
        "The request and any brief are in your inbox.",
        f"Your superior: {helped} (the agent you help)",
        "",
        "Rules:",
        f"- Talk to the team only through the '{SERVER_NAME}' tools. You can message only {helped} "
        "(and answer anyone who writes to you).",
        "- Read any project file you need.",
        f"- You can edit only files {helped} hands to you with hand_over_file; list_locks shows "
        f"what you hold. When you are done with a file, hand_over_file it back to {helped} "
        "(release_file also returns it).",
        f"- Work with {helped} until the problem is solved, then tell it so with send_message. "
        f"{helped} dismisses you; after that your tools stop working and you should stop.",
        "- Every message wakes its receiver: send only what they need, no 'thanks' or 'ok'.",
        "- When you have nothing left to do, end your turn: new messages are delivered to you "
        "automatically.",
    ] + where_you_left_off(me))
