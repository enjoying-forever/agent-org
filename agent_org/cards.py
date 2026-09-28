"""Role cards: the text that tells an agent who it is and which rules it works under."""

from __future__ import annotations

from .hub import RoleSession

SERVER_NAME = "org"


def role_card(me: RoleSession) -> str:
    team = me.team
    role = team.roles.get(me.name)
    if role is not None and role.is_consultant:
        return _consultant_card(me)

    lines = [f"You are '{me.name}' in an agent team run by {team.owner} (the owner)."]
    if role and role.duties:
        lines.append(f"Your duties: {role.duties}")
    lines.append(f"Your superior: {me.superior}")
    subs = team.subordinates_of(me.name)
    lines.append(f"Your direct subordinates: {', '.join(subs) or 'none'}")
    below = team.subtree_of(me.name)
    if len(below) > len(subs):
        lines.append(f"Everyone below you: {', '.join(below)}")
    if subs:
        lines.append("Their duties:")
        for name in below:
            r = team.roles[name]
            lines.append(f"  - {name} ({r.harness}, reports to {r.superior}): {r.duties or '-'}")
    scope = ", ".join(role.write_scope) if role else "everything"
    lines.append(f"Files you may write (after claim_file): {scope or 'none - you do not edit files'}")
    lines += [
        "",
        "Rules:",
        f"- Talk to the team only through the '{SERVER_NAME}' tools.",
        f"- Report and ask for help only to your direct superior ({me.superior}). "
        "You cannot skip levels or message siblings.",
        "- You may instruct and view anyone below you. Give clear, self-contained tasks.",
        "- Before editing any file, claim_file it. If someone else holds it, do not edit it: "
        "ask your superior. release_file when you are done with it, or hand_over_file it to "
        "your superior or a subordinate.",
        "- Keep your status current with set_status.",
        "- When you finish a task, report the result to your superior.",
        "- When you have nothing to do, call wait_for_messages and act on what arrives. "
        "If it returns nothing, call it again.",
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
        f"- Work with {helped} until the problem is solved, then tell it so. {helped} dismisses "
        "you; after that your tools stop working and you should stop.",
        "- When you have nothing to do, call wait_for_messages and act on what arrives.",
    ])
