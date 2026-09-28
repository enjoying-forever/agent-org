"""The watchdog: finds stuck, silent or stopped work, nudges, escalates, and lists problems.

Modelled on Gas Town's Witness. `patrol` runs every half minute while the UI is open
(or on its own: python -m agent_org.watchdog --team team.yaml). It acts once per
problem - the hub remembers what it already did - and returns what still needs a
person's attention, for the UI's Problems list.

- Leases that ran out are released.
- A task with no progress for STALL minutes gets a nudge; after another STALL
  minutes, whoever assigned it is told.
- A question left unanswered for HELP_WAIT minutes is passed up one level.
- An agent that is not running but has work, two sessions of one role, and two
  agents trading messages in a loop are listed as problems.
- Questions, reviews and blocked tasks waiting for the owner are listed too.
"""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import asdict, dataclass

from .hub import HUB, Hub

STALL = 20 * 60        # seconds without progress before a working task is nudged
HELP_WAIT = 15 * 60    # seconds a question may wait before it is passed up
LOOP_WINDOW = 10 * 60  # seconds over which message traffic between two roles is counted
LOOP_LIMIT = 16        # messages between two roles in LOOP_WINDOW that look like a loop
QUIET = 6 * 3600       # after escalating a stalled task, stay quiet about it this long


@dataclass
class Problem:
    kind: str          # stopped, stalled, question, review, blocked, loop, duplicate
    role: str          # who it is about
    text: str          # what a person should know
    action: str = ""   # what the UI offers: start, stop, answer, review, open-task
    task_id: int | None = None
    message_id: int | None = None

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _once(hub: Hub, key: str) -> bool:
    """True the first time `key` is seen (and remembers it)."""
    if hub.store.get_setting(f"watch:{key}"):
        return False
    hub.store.set_setting(f"watch:{key}", str(int(time.time())))
    return True


def minutes(seconds: float) -> str:
    m = int(seconds // 60)
    return f"{m} minute{'s' if m != 1 else ''}" if m < 120 else f"{m // 60} hours"


def patrol(hub: Hub, act: bool = True, now: float | None = None) -> list[Problem]:
    now = time.time() if now is None else now
    store, team = hub.store, hub.team
    owner = team.owner
    online = store.online()
    activity = store.activity()
    problems: list[Problem] = []

    if act:  # leases whose holder went quiet
        for lock in store.expire():
            hub.event("file", lock.owner, f"lease on {lock.path} ran out and was released")
            if team.is_member(lock.owner) and lock.owner != owner:
                hub.notice(lock.owner, f"Your lease on {lock.path} ran out after an hour without activity "
                                       "and was released. claim_file it again before you edit it.")

    open_tasks = store.tasks(open_only=True)
    for name in team.roles:
        mine = [t for t in open_tasks if t.assignee == name and t.state in ("open", "working", "blocked")]
        reviews = [t for t in open_tasks if t.assigner == name and t.state == "done"]
        if not online.get(name) and (mine or reviews):
            what = ", ".join([f"{len(mine)} task(s) to do"] * bool(mine) + [f"{len(reviews)} to review"] * bool(reviews))
            problems.append(Problem("stopped", name, f"{name} is not running but has {what}.", "start"))
        if online.get(name, 0) > 1:
            problems.append(Problem("duplicate", name, f"{name} runs in {online[name]} sessions that split its "
                                    "messages. Stop it and start it again.", "stop"))

    for task in open_tasks:
        if task.state != "working" or not online.get(task.assignee):
            continue
        busy_below = any(t.assigner == task.assignee and t.state in ("waiting", "open", "working", "blocked", "done")
                         for t in open_tasks)
        if busy_below:
            continue  # waiting for its own subtasks is progress of a kind
        last = max(x for x in (task.started_at or 0, task.updated_at, activity.get(task.assignee, 0)))
        if task.nudged_at and last > task.nudged_at:  # it moved after the nudge: start over
            if act:
                store.update_task(task.id, nudged_at=None)
            continue
        idle = now - last
        if idle < STALL:
            continue
        if task.nudged_at is None:
            if act:
                hub.notice(task.assignee,
                           f"Task #{task.id} ({task.title}) has shown no progress for {minutes(idle)}. Carry on, "
                           f"or finish_task({task.id}, ...) as blocked or failed and say why.", task.id)
                store.update_task(task.id, nudged_at=now)
                hub.event("watch", task.assignee, f"nudged about #{task.id}", task.id)
        elif now < task.nudged_at:
            pass  # escalated already; quiet for a while
        elif now - task.nudged_at >= STALL:
            if act:
                if task.assigner != owner:
                    hub.notice(task.assigner,
                               f"Task #{task.id} you gave to {task.assignee} ({task.title}) has stalled: no "
                               f"progress for {minutes(idle)}, even after a reminder. Check on it, help, "
                               f"reassign or cancel it.", task.id)
                store.update_task(task.id, nudged_at=now + QUIET)
                hub.event("watch", task.assigner, f"told that #{task.id} stalled", task.id)
            problems.append(Problem("stalled", task.assignee,
                                    f"Task #{task.id} ({task.title}) has shown no progress for {minutes(idle)}.",
                                    "open-task", task.id))
        else:
            problems.append(Problem("stalled", task.assignee,
                                    f"Task #{task.id} ({task.title}) is quiet; {task.assignee} was reminded.",
                                    "open-task", task.id))

    helped = {c.help_id for c in store.active_consultants()}
    for name in [owner, *team.roles]:
        for question in store.messages_to(name, ("help",)):
            if question.id in helped or store.replies_to(question.id, sender=name):
                continue
            if name == owner:
                problems.append(Problem("question", question.sender,
                                        f"{question.sender} asks you: {question.text[:200]}", "answer",
                                        message_id=question.id))
                continue
            waited = now - question.sent_at
            if waited < HELP_WAIT:
                continue
            above = team.superior_of(name)
            if act and above and _once(hub, f"help-up:{question.id}"):
                hub.notice(above, f"{question.sender} asked {name} for help (#{question.id}) {minutes(waited)} "
                                  f"ago and has no answer yet:\n\n{question.text[:1500]}\n\nAnswer {question.sender} "
                                  f"with send_message(to=\"{question.sender}\", reply_to={question.id}) if you can, "
                                  f"or make sure {name} does.", urgent=False)
                hub.event("watch", name, f"passed question #{question.id} up to {above}")

    for task in open_tasks:
        if task.assigner == owner and task.state == "done":
            problems.append(Problem("review", task.assignee, f"Task #{task.id} ({task.title}) is done and waits "
                                    "for your review.", "review", task.id))
        elif task.assigner == owner and task.state == "blocked":
            problems.append(Problem("blocked", task.assignee, f"Task #{task.id} ({task.title}) is blocked: "
                                    f"{task.result[:200]}", "open-task", task.id))

    for (a, b), count in store.pair_traffic(now - LOOP_WINDOW).items():
        if count < LOOP_LIMIT or HUB in (a, b):
            continue
        problems.append(Problem("loop", a, f"{a} and {b} exchanged {count} messages in the last "
                                f"{minutes(LOOP_WINDOW)}; they may be going round in circles."))
        if act and _once(hub, f"loop:{a}:{b}:{int(now // LOOP_WINDOW)}"):
            above = next((x for x in team.chain_of(a) if x in team.chain_of(b)), owner) if a in team.roles and b in team.roles else owner
            if above != owner and team.is_member(above):
                hub.notice(above, f"{a} and {b} exchanged {count} messages in {minutes(LOOP_WINDOW)}. They may be "
                                  "going round in circles: step in and decide for them.")
            hub.event("watch", a, f"possible loop between {a} and {b}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Watch a team: nudge, escalate, report problems")
    parser.add_argument("--team", default="team.yaml")
    parser.add_argument("--every", type=float, default=30, help="seconds between patrols")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    hub = Hub.open(args.team)
    try:
        while True:
            for p in patrol(hub):
                print(f"{time.strftime('%H:%M:%S')} [{p.kind}] {p.text}")
            if args.once:
                return 0
            time.sleep(args.every)
    except KeyboardInterrupt:
        return 0
    finally:
        hub.close()


if __name__ == "__main__":
    sys.exit(main())
