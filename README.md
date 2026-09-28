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
| **Down** | A role can instruct and look at anyone below it: its subordinates and theirs. |
| **Sideways** | Siblings don't talk directly. They go through their shared superior. |
| **Files** | A role can only lock files inside its `write_scope`. One writer per file. A lock is released by its holder or by anyone above the holder, and a holder can hand it to its direct superior or a direct subordinate. |
| **Consultants** | See below. |

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

## Launch the team

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
- [ ] Step 3: all four harnesses, with message delivery into live sessions
- [ ] Step 4: pre-edit hooks that enforce locks
- [ ] Step 5: dashboard (org chart editor, messages, locks)

Run the tests with `python -m pytest`.
