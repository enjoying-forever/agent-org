# agent-org

Run a team of AI agents - Claude Code, Codex and Grok - that work together like a
small company. You set up who reports to whom; the leader plans, hands out tasks,
and reports back to you. Every agent runs in its own visible terminal tab, with the
subscription you already have, and you watch and steer everything from one web page.

## Quick start

1. **Double-click `agent-org-ui.cmd`.** A page opens in your browser. (Keep the small
   black window open while you use it.)
2. **Create a team.** Choose the project folder the agents should work in, pick a
   starting team (Solo, Leader and worker, or Full team) and click *Create team*.
   The *Setup* check on the same page tells you if Claude, Codex or Grok needs fixing.
3. **Click *Launch team*.** Each agent opens in its own Windows Terminal tab.
   - The first time, Claude and Codex ask whether you trust the folder: say yes.
   - Codex also shows **Hooks need review** once: choose **Trust all and continue**.
4. **Give the leader a task.** In the box at the bottom right, switch to **Task**,
   write one line saying what you want, add details if needed, and click *Give task*.

Then watch: the cards show who is working, waiting or blocked; messages and tasks
appear live; the leader's result comes back to you as a message.

Next time, open the team from *Open a recent team*, click *Launch team*, and every
agent carries on where it stopped.

## What you see

- **Team:** the org chart. Each card shows the agent's model, what it is doing, whether
  it is running, its open tasks, unread messages and the files it is writing. Click a
  card to message it, give it a task, start or stop it, or read its notes.
- **Messages:** the whole team's conversation, live. Write to anyone, reply, mark a
  message urgent, or write to everyone at once. Questions the leader asks you have
  *Reply* and *Summon consultant* buttons.
- **Tasks:** every task, who gave it to whom, and how it ended (done or blocked, with
  the result).
- **Files:** who is writing which file right now.
- **Edit team:** add and remove roles, choose the leader and each role's superior, the
  program and model each role uses, what files it may write, and the consultant tiers.
- **The law:** the rules below. **Setup:** checks that the programs are ready.

## The message law

Every agent works under these rules; the hub enforces them and reminds agents of
what they still owe.

1. **Chain of command.** Write to your direct superior, to your peers (same superior)
   and to anyone below you. Don't skip levels upward or write to other teams.
2. **Answering is always allowed.** You may reply to any message sent to you, whoever
   sent it.
3. **Work is given as tasks.** Work goes only downward, one clear, self-contained task
   at a time. Peers coordinate but never assign work to each other.
4. **Every task gets closed.** When a task is finished, its owner closes it with the
   result - done, or blocked with what is needed. Whoever assigned it is told.
5. **Help goes up one level.** A question goes to your direct superior, who must answer
   it, pass it up, or summon a consultant.
6. **Say it once, say it all.** Every message wakes its receiver: no "thanks" or "ok"
   messages; long material goes in a file.
7. **One writer per file.** An agent must hold a file's lock to edit it; editing a free
   file in its scope takes the lock automatically.
8. **Everyone sees the team.** Anyone can see every role's status, tasks and files.
   Messages stay private to the sender, the receiver and their superiors.
9. **Urgent is rare.** Only messages going down may be urgent; they interrupt the
   receiver's current work.

How the rules are kept:

- When an agent finishes a turn, a hook hands it any new messages, or reminds it of
  open tasks, blocked tasks it gave, unanswered questions and files it still holds -
  then waits and wakes it the moment a message arrives. You never have to nudge an
  idle agent.
- After every step it takes, a busy agent is told about new messages; urgent ones
  interrupt it immediately.
- Before every file edit, the hub checks the lock, so two agents never write the same
  file.

## Memory: agents remember across restarts

- **Launch team** (or *Start* on a card) resumes each agent's last conversation, so
  it remembers everything it was doing. It is told the team was restarted and picks
  up its open tasks and messages.
- If a conversation can no longer be resumed, the new session still starts from what
  the hub kept: the agent's own notes, its open tasks, the files it holds and its
  recent messages.
- *Start fresh* on a card begins a new conversation on purpose (the hub's memory is
  kept).
- *Stop* ends an agent's program; its conversation is kept for the next start.

## Consultants

When a subordinate asks for help, its superior can summon a **consultant**: a
temporary helper, placed under the agent that asked, running a stronger (or cheaper)
model from a tier you configure. It opens in its own tab, edits only the files it is
handed, and is dismissed when the problem is solved; its files go back to the agent
it helped. Tiers are set in *Edit team* (for example *opus-medium*, *luna-high*,
*opus-xhigh*), each with what it is good for and how many may run at once.

## Troubleshooting

- **The Setup check shows a ✗:** it says what to run. The most common: Grok not signed
  in (`grok login`), or a Claude Code update that did not finish (the check gives the
  repair command).
- **You want to type directly into an agent's tab:** while it waits for messages it is
  busy; press **Esc** first. Or just send it a message from the page - that reaches it
  immediately.
- **A card says "2 sessions!":** the same role was started twice and the two split its
  messages. Click *Stop* on the card, then *Start*.
- **Grok agents only see messages when they check:** click *Install Grok hooks* in the
  Setup check (Grok reads hooks only from its own settings; they do nothing outside
  agent-org tabs).

## For developers

Everything runs in the `formal` conda environment with only PyYAML beyond the standard
library. From this folder:

| Command | What it does |
|---|---|
| `python -m agent_org.ui [--team team.yaml]` | the web UI |
| `python -m agent_org.launch --team team.yaml [roles] [--fresh] [--force] [--dry-run]` | open agent tabs from the command line |
| `python -m agent_org.launch --install-grok-hooks` | install the hooks for Grok |
| `python -m agent_org.cli --team team.yaml [--as ROLE] tree/send/inbox/view/claim/...` | the hub from the command line |
| `python -m pytest` | the tests |

How it fits together:

- `team.py` - the role tree and consultant tiers, from `team.yaml`.
- `hub.py` - the message law, tasks, file locks and consultants, over `store.py` (one
  SQLite file per team in `.agent-org/`, shared by every agent's process).
- `mcp_server.py` - the `org` tools each agent gets (standard-library MCP over stdio).
- `hooks.py` / `org_hook.py` - the hooks each harness runs: deliver mail, remind of
  duties, guard edits, record the conversation id.
- `launch.py` - writes each role's start script (Claude Code: `--mcp-config`,
  `--settings`, `--append-system-prompt-file`; Codex: `-c` overrides; Grok: project
  MCP config and `--rules`), resumes conversations (`sessions.py`), stops agents.
- `cards.py` - the role card: the law, the team, and where the agent left off.
- `ui.py` + `ui_static/` - the web page; `templates.py` - the starting teams;
  `doctor.py` - the setup check.

Antigravity is not supported yet.
