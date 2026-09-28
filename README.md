# agent-org

A chain of command for AI agents that each run in their own harness: Claude Code,
Codex CLI, Grok Build and Antigravity. Every agent runs in a normal, visible
terminal session. agent-org only connects them: it routes messages along the
role tree you define, lets superiors look at their teams, and makes sure each
file has one writer at a time.

## The rules

| | |
|---|---|
| **Tree** | Every role names its `superior`. Exactly one role reports to you (the owner): the leader. |
| **Up** | A role can report to, or ask help from, its **direct** superior only. |
| **Down** | A role can instruct anyone below it: its subordinates and theirs. |
| **Peers** | Roles with the same superior can message each other. Other teams' members (cousins) can't. |
| **Looking** | Everyone can see the whole tree and every role's status, files and whether it is running (`team_status`, `view`). A role's messages can be read only by itself and the roles above it. |
| **Files** | A role can only lock files inside its `write_scope`. One writer per file. A lock is released by its holder or by anyone above the holder, and a holder can hand it to its direct superior or a direct subordinate. |
| **Consultants** | See below. |

## How messages reach a busy or idle agent

Harnesses work in turns: when an agent ends its turn it sits at its prompt, and
nothing wakes it. agent-org therefore adds hooks to each agent's harness:

- **When the agent ends its turn**, the hook first hands over any unread messages.
  With none waiting, it reminds the agent once of what it tends to forget (reporting
  to its superior, releasing files it holds), then **waits for new messages** and
  hands them over the moment they arrive. The agent's status shows `waiting`
  meanwhile. To type into an agent's tab yourself while it waits, press Esc first.
- **After every tool call**, it mentions messages that arrived while the agent was
  busy (once each).
- **Before every file edit**, the agent must hold the file's lock. Editing a free file
  inside its write scope claims it automatically; a file someone else holds, or one
  outside its scope, is refused with the reason.

Claude Code gets these hooks through a per-role `--settings` file. Codex gets them
through `-c` overrides; the first time, Codex shows **Hooks need review**: choose
**Trust all and continue** (the commands are the same for every role, so once is
enough). Grok only reads hooks from its global settings or a git root, so for Grok
install them once with
`python -m agent_org.launch --install-grok-hooks` (they do nothing outside agent-org
tabs).

Every agent's hub connection also checks in every 10 seconds, so the UI and the
agents can tell who is **running**. Launching skips roles that are already running,
because two sessions of one role would split its messages.

## Consultants

When a subordinate asks for help, the superior who received the request judges how
hard it is and can call `summon_consultant(help_id, tier, brief)`. The hub then:

1. adds a temporary role (`consultant-1`, `consultant-2`, ...) **under the agent that
   asked**, running the tier's harness and model, in its own new tab;
2. sends it the help request and the superior's brief, and tells the helped agent.

The helped agent and its consultant work together like any superior and subordinate.
A consultant can't claim files: it edits only the files the helped agent passes to it
with `hand_over_file`, and hands them back (or `release_file`s them) when done. When
the problem is solved, the helped agent or anyone above it calls
`dismiss_consultant`. Every file the consultant still holds goes back to the helped
agent, and the consultant's tools stop working. Consultants can't get consultants
of their own.

Tiers are set in `team.yaml` under `consultants:`, each with a harness, model,
effort, a `use_for` line that the superior reads to pick a tier, and `max_active`,
the most that can run at once.

## Setup

Run everything in the `formal` conda env from this folder.

1. Copy `team.example.yaml` to `team.yaml` in the project the agents will work on,
   and edit the tree, models and write scopes.
2. Check it:

   ```
   python -m agent_org.cli --team path/to/team.yaml tree
   ```

## The UI

Drag your `team.yaml` onto **`agent-org-ui.cmd`** (or run
`agent-org-ui.cmd path\to\team.yaml`). A local web page opens in your browser:

- **Team:** the org chart with each agent's model, live status, unread messages
  and files. Consultants appear as dashed cards under the agent they help. Click a
  card for details, to message it, reopen its terminal tab, release its files or
  dismiss it. **Launch team** opens a terminal tab for every role.
- **Messages:** the whole team's conversation, live, with filters. Write to any
  role, reply, and answer help requests addressed to you, including **Summon
  consultant**, which lets you pick a tier and write a brief.
- **Files:** every file being written, and by whom.
- **Edit team:** roles, leader ("Make leader"), superiors, harness, model, effort,
  write scopes, duties and consultant tiers, with a live tree preview and checks.
  Saving writes `team.yaml` (the old one is kept as `team.yaml.bak`).

The UI listens on 127.0.0.1 only, and the page's link carries an access token.
Keep the UI's window open while you use it; closing it stops the page, not the
agents.

## Launch the team from the command line

```
conda run -n formal --cwd E:\code\claude_own\agent-org python -m agent_org.launch --team path\to\team.yaml
```

This opens a Windows Terminal window named `agent-org`, with one tab for you and
one per role (add role names to start only some; `--dry-run` writes the scripts
without opening anything). Each role tab runs its real harness, connected to the
hub through the `org` MCP server:

- **Claude Code** gets the role card as an appended system prompt and the `org`
  tools pre-approved.
- **Codex** gets the role card as developer instructions and the `org` server
  through `-c` overrides.
- **Grok** gets the role card through `--rules` and the `org` tools pre-approved
  with `--allow`. Grok only reads MCP servers from config files, so its start
  script registers one `org` server in the project's `.grok/config.toml`; each
  Grok tab's server takes its role from the tab's `AGENT_ORG_ROLE`. The first time
  in a folder you haven't trusted, Grok asks you to trust it.
- **Antigravity** is not supported yet.

Every agent starts by calling `my_role`, then waits for messages. In your tab,
give the leader its first task with `org send leader "..."`, and watch the other
tabs. Messages addressed to you arrive in `org inbox`.

The start scripts are in `.agent-org/launch/<role>/start.ps1`; you can rerun
one yourself to restart a single agent.

## Command line

`--as ROLE` acts as that role; without it you act as the owner.
`$AGENT_ORG_TEAM` and `$AGENT_ORG_ROLE` can stand in for `--team` and `--as`.

| Command | What it does |
|---|---|
| `tree` | Show the role tree |
| `send TO TEXT [--reply-to N]` | Message your superior or anyone below you |
| `help TEXT [--reply-to N]` | Ask your direct superior for help |
| `inbox` / `wait [--timeout S]` | Read new messages, or wait for them |
| `status STATE [TASK]` | Set your status: idle, working, waiting, blocked, done |
| `view ROLE` | Look at yourself or a role below you |
| `claim PATH` / `release PATH` / `locks` | File write locks |
| `hand-over PATH TO` | Give a lock you hold to your superior or a direct subordinate |
| `summon HELP_ID TIER [--brief TEXT]` | Attach a consultant to whoever sent you help request HELP_ID |
| `dismiss NAME` | Dismiss a consultant working for you or below you |
| `can-write PATH` | Exit 0 if you hold the lock on PATH (for pre-edit hooks) |

## Status

- [x] Step 1: hub core (role tree, rules, messages, status, file locks) with tests
- [x] Step 2: MCP server and a launcher that opens one terminal tab per role (Claude Code, Codex)
- [x] Consultants: temporary helpers summoned for help requests, with file hand-over
- [x] Web UI (moved up from step 5): org chart, messages, files, consultants, team editor
- [x] Step 3: Grok, plus hooks that deliver messages to busy and idle agents
- [x] Step 4: pre-edit hooks that enforce locks
- [ ] Antigravity

Run the tests with `python -m pytest`.
