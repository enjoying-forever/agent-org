"""Role cards: the text that tells an agent who it is and which rules it works under."""

from __future__ import annotations

from .hub import RoleSession

SERVER_NAME = "org"


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
    lines += [
        "",
        "Rules:",
        f"- Talk to the team only through the '{SERVER_NAME}' tools. People only receive what you "
        "send with send_message; text you write in your own session reaches nobody.",
        f"- You may message your direct superior ({superior}), your peers, and anyone below you. "
        "You cannot skip levels upward or message other teams' members.",
        f"- Ask for help (ask_help) only from {superior}. Give subordinates clear, self-contained tasks.",
        "- Anyone may see the team's status (team_status, view). Keep yours current with set_status.",
        "- One writer per file: before editing a file you must hold its lock. Editing a free file in "
        "your scope claims it for you (or call claim_file). If someone else holds it, do not edit it; "
        f"ask {superior} or that peer. release_file each file when you are done with it, or "
        "hand_over_file it to your superior or a subordinate.",
        f"- When you finish a task, report the result to {superior} with send_message.",
        "- When you have nothing left to do, end your turn: new messages are delivered to you "
        "automatically. (You can also wait for them with wait_for_messages.)",
        "- If your superior assigns you a consultant, it is your temporary subordinate: work "
        "with it through send_message, hand_over_file it the files it should edit, and "
        "dismiss_consultant it when the problem is solved.",
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
    return "\n".join(lines)


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
        f"- Talk to the team only through the '{SERVER_NAME}' tools. You can message only {helped}.",
        "- Read any project file you need.",
        f"- You can edit only files {helped} hands to you with hand_over_file; list_locks shows "
        f"what you hold. When you are done with a file, hand_over_file it back to {helped} "
        "(release_file also returns it).",
        f"- Work with {helped} until the problem is solved, then tell it so with send_message. "
        f"{helped} dismisses you; after that your tools stop working and you should stop.",
        "- When you have nothing left to do, end your turn: new messages are delivered to you "
        "automatically. (You can also wait for them with wait_for_messages.)",
    ])
