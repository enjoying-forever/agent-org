# agent-org

Run a team of AI agents - Claude Code, Codex, Grok and Antigravity - that work
together like a small company. You set up who reports to whom; the leader plans, hands out tasks,
and reports back to you. Every agent runs in its own live terminal inside the agent-org window,
with the subscription you already have, and you watch, type to and steer all of them in one place.

## What you need

- **Windows 10 or 11.**
- **Python 3.11 or newer** ([python.org](https://www.python.org/downloads/), or
  `winget install Python.Python.3.12`).
- **PowerShell 7** - every agent starts through it (`winget install Microsoft.PowerShell`;
  the PowerShell that comes with Windows is version 5 and is not enough).
- **At least one agent program, signed in** - each runs on your own subscription:
  - [Claude Code](https://code.claude.com/docs): `npm install -g @anthropic-ai/claude-code`,
    then run `claude` once and log in. Claude agents need Sonnet, Opus or Fable (Haiku has no
    auto mode, so it would ask you before every step).
  - [Codex](https://github.com/openai/codex): `npm install -g @openai/codex`, then `codex` once to log in.
  - Grok Build (`grok login`), the Antigravity CLI (`agy`, from antigravity.google) or
    DeepSeek Harness.

  The npm commands need [Node.js](https://nodejs.org). A team can mix programs: the
  ready-made teams say which ones they use, and the *Setup check* says what is missing.

## Install

1. Put this folder where you want to keep it (download it, or `git clone` it).
2. **Double-click `install.cmd`.** It makes a private Python environment in the folder
   (`.venv`) with the four small packages agent-org needs (PyYAML, pywinpty, pywebview,
   tzdata), offers to install PowerShell 7 if it is missing, and ends with the setup check.
   Run it again after updating agent-org; it is safe to repeat.

To use a Python you already have instead, put the full path of its `python.exe` on one line
in a file `python-path.txt` next to `agent-org-ui.cmd` (or set `AGENT_ORG_PYTHON`), and install
the packages there: `python -m pip install -r requirements.txt`.

## Quick start

1. **Double-click `agent-org-ui.cmd`.** The agent-org window opens. (Keep the small black
   window open too.) Closing the window while agents run asks: keep them running in the
   background (double-click `agent-org-ui.cmd` again to bring the window back), or stop them
   (their conversations are kept, and *Start* resumes them).
2. **Create a team.** Choose the project folder the agents should work in, pick a
   starting team (Solo, Leader and worker, or Full team) and click *Create team*.
   The *Setup* check on the same page tells you if Claude, Codex or Grok needs fixing.
3. **Click *Launch team*.** Each agent starts in its own terminal pane in the window.
   - The first time, Claude and Codex ask whether you trust the folder: say yes.
   - Codex also shows **Hooks need review** once: choose **Trust all and continue**.
   - Antigravity needs you to have run `agy` once yourself and finished its Google
     sign-in (including any account check it asks for). It runs interactively, in its own full
     terminal like the others. Interactive Antigravity loads only user-level plugins, so agent-org
     installs its plugin (its tools and hooks) as one: `agy plugin list` shows `agent-org`. Outside
     agent-org it does nothing - your own `agy` sessions get no tools from it and its hooks exit at
     once. The first time in a folder, Antigravity asks whether to trust it: say yes in its pane.
   - Each program must be signed in on its own command line (run `claude`, `codex`,
     `grok` once in a terminal and log in); the Setup check tells you which is not.
4. **Give the leader a task.** Open the **Board**, click **New task**, write one line
   saying what you want, and fill in **Done when**: how anyone can check it is
   finished (for example "the page shows today's top 10 stories").

Then watch: the leader splits the work into tasks for its team, each task moves
across the Board as it is worked on, the leader checks every result, and when your
task is done it lands in *Review*: open it and click **Accept** or **Send back**.

Next time, open the team from *Open a recent team*, click *Launch team*, and every
agent carries on where it stopped.

## What you see

- **Team:** on the left, the team as a tree (who reports to whom, who is running, unread
  messages and open tasks). In the middle, one pane per agent: its **live terminal** - click
  in it and type, exactly as in its own console - with buttons to give it a task, start,
  restart or stop it, and its details (notes, files, usage). An agent that is not running
  shows a summary instead: its program and model, what it does, and its recent messages.
  On the right, the team's messages. Dark or light with the button at the top.
- **A pane is its terminal:** one thin title line (its name, a badge you click to change it, its
  buttons) and the terminal below; hover the title for its status, model, usage, tasks and files.
  Claude agents start without your personal Claude Code mods (their status lines, such as a
  token counter) and without spinner tips, so a terminal shows only the agent's work.
- **Arranging the workspace:** the page never scrolls; the panes tile the space. The grid
  button at the top picks *Grid*, *Focus* (one big pane, the rest stacked beside it),
  *Columns* or *Rows*; drag the borders between panes (double-click one to even them out)
  and the edges of the team list and the messages, or hide either with the buttons at the
  top. Each pane has *Full screen* (Esc, outside a terminal, comes back) and *Close* (the
  agent keeps running; click it in the team list to bring the pane back). What waits for you
  shows where it is: a stuck agent or a second session in its pane's title, unread messages
  as a count, and an agent whose terminal is asking something (a permission, "trust this
  folder?") as an amber outline on its pane until you answer. While the window is in the
  background, an agent that gets stuck or runs out of usage brings a desktop notification. Drag a
  pane by its title onto another to swap them. The arrangement is remembered for each team, and the
  window comes back where and as big as it was.
- **Changing the team right there:** the **+** in the team list opens your roles: drag one onto
  a teammate (in the list or onto its pane) and it joins the team under them. Drag a teammate
  onto another to change whom it reports to. Click a teammate's badge (C, X, G, A) for its card:
  program, model, reasoning effort, whom it reports to, duties, instructions and files, *Save*
  (a running agent uses them from its next start; *Save and restart* applies them now) or
  *Remove* (whoever reported to it then reports to its superior).
- **In a terminal:** Ctrl+C copies when text is selected (otherwise it interrupts the agent),
  Ctrl+V pastes, right-click copies or pastes, and links open in your browser. A pane's program
  badge lights up while it writes. Ctrl+Alt+1-9, Ctrl+Alt+arrows and Ctrl+Alt+Enter move between
  panes and go full screen; Ctrl+wheel or Ctrl+Alt+= / - / 0 makes the terminals' text bigger,
  smaller or normal (*More* > *Keyboard shortcuts* lists them all).
- **Messages:** the whole team's conversation, live. Write to anyone, reply, mark a
  message urgent, or write to everyone at once. Questions the leader asks you have
  *Reply* and *Summon consultant* buttons.
- **Board:** every task in a column by stage - Waiting (for other tasks), To do, In
  progress, Blocked, Review, Finished. Click one to see its whole conversation, what
  "done" means, what it waits for, which files it changed (with the diff), whether the
  checks passed, and to accept or send back a result.
- **What needs you** shows where it is, not in a list of its own: a stuck agent or a second
  session on its pane's title, an agent asking something as an amber outline, questions for
  you and results to review as messages, a stopped agent with work on its card (with *Start*).
  While the window is in the background, a desktop notification says when an agent gets stuck.
- **Activity:** a timeline of everything that happened (tasks given, started, done,
  accepted; files taken and released; reminders and escalations).
- **Files:** who is writing which file right now, and for which task.
- **Usage:** each agent's tokens so far, over every conversation it has had (a fresh start
  keeps the count), in its pane's title - hover it for new, cached and output tokens and
  the model - and the team's total at the bottom of the team list. Read from each program's
  own records: Claude Code's and Codex's session files, Antigravity's conversation
  database, DeepSeek's run events; Grok keeps no token counts (messages only). For Codex
  the title also shows how much of your subscription limit is used.
- **Edit team:** add and remove roles, choose the leader and each role's superior, the
  program and model each role uses, what files it may write, the consultant tiers,
  the checks, and whether agents start by themselves.
- **The law:** the rules below. **Setup:** checks that the programs are ready.

### The window, or a browser, or terminal tabs

agent-org opens in a window of its own (Windows' WebView2, through `pywebview`), and runs
each agent in a pseudo-terminal it owns (`pywinpty`), shown with xterm.js. The agents get a
fresh copy of your user environment, as a new terminal would, not the environment agent-org
itself was started from. Your PowerShell profile is not run (each agent starts faster, and
nothing in it changes the agent's settings); the agent gets agent-org's proxy, or Windows' own.

- `python -m agent_org.ui --browser` opens the same page in your browser instead; press
  Enter in the black window for another sign-in link.
- Without `pywinpty`, or with the environment variable `AGENT_ORG_TABS=1`, agents open in
  Windows Terminal tabs as before, and keep running when agent-org closes.

### DeepSeek Harness

A role can run on **DeepSeek Harness** (`harness: deepseek`, models `deepseek-flash` or
`deepseek-v4-pro`, reasoning effort `off`, `low`, `high` or `max`). Sign in to DeepSeek Harness
once (in its desktop app) and install its command line, version 0.2 or later:
`npm install -g @deepseek-ai/dsh`. Without it, agent-org uses the desktop app's own copy (found
through its Windows install entry; `AGENT_ORG_DEEPSEEK_APP` points to another `DeepSeek Harness.exe`).

DeepSeek's terminal mode works one task and exits, and has no hooks, so a DeepSeek agent works
in runs: its start script waits - without a model, at no cost - until it has a new message (a
task arrives as one; at the start, unfinished tasks count too), runs it, and waits again. Each run
continues the same conversation (*Start fresh* begins a new one); only the first run of a new one
is told to read its role.
It gets agent-org's tools through DeepSeek's MCP client plugin, added for that role by a patch
file (your own DeepSeek settings are not changed). *Stop* ends the run or the wait, and it stays
stopped until you start it again. Its terminal mode prints only the final answer, so agent-org
runs it with JSON output and shows it like an interactive program: a banner, then each step -
thinking, tool calls and results, answers - as it happens. While it waits, its pane has an input
line: type a message for it and press Enter, and it starts working on it.

Its shell runs in DeepSeek's own sandbox, which sets Windows permissions on the project folder.
If an agent reports that its shell cannot run because of the folder's permissions (no WRITE_DAC),
give your account full control of the project folder, or run it without the sandbox: set
`DSH_PERMISSION_MODE=danger-full-access` as a Windows user environment variable (agents get your
user environment) and restart agent-org. agent-org's command guard does not cover DeepSeek, which
has no hooks, so that leaves its shell unguarded.

## The message law

Every agent works under these rules; the hub enforces them and reminds agents of
what they still owe.

1. **Chain of command.** Write to your direct superior, to your peers (same superior)
   and to anyone below you. Don't skip levels upward or write to other teams.
2. **Answering is always allowed.** You may reply to any message sent to you, whoever
   sent it. Messages from the owner come first.
3. **Work is given as tasks.** Work goes only downward, one clear task at a time, each
   with a **done when** that says how anyone can check it is finished. Bigger work is
   split into several tasks; **after** makes a task wait until others are done. Peers
   coordinate but never assign work to each other.
4. **Take it or turn it down.** A task is yours once you read it. If you cannot or
   should not do it, reject it at once, with the reason.
5. **Every task ends with a result:** done, blocked (with what is needed), failed
   (with why), or rejected. Whoever gave it is told. Nothing is dropped silently.
6. **Results are checked.** Whoever gave a task reviews a done result against its
   "done when": accept, or send back with feedback (three times at most).
7. **Help goes up one level.** A question goes to your direct superior, who must answer
   it, pass it up, or summon a consultant. An unanswered question is passed up for you.
8. **Say it once, say it all.** Every message wakes its receiver: no "thanks" or "ok"
   messages; long material goes in a file.
9. **One writer per file.** An agent must hold a file's lease to edit it; editing a free
   file in its scope takes it, and a whole folder (`src/api/*`) can be reserved for a
   task. Leases run out when their holder stops working; closing, cancelling or moving
   its last task releases an agent's files, and so does resting with no task. (With git
   branches on, each
   agent edits its own copy instead: see below.)
10. **Everyone sees the team.** Anyone can see every role's status, tasks and files.
    Messages stay private to the sender, the receiver and their superiors.
11. **Silence is a problem.** A task with no progress gets a reminder, then its assigner
    is told. Blockers are reported as soon as they are hit. When an agent runs out of
    its usage limit, whoever gave it tasks moves them to someone who can work -
    preferably on another subscription - or lets them wait for the reset.
12. **Urgent is rare.** Only messages going down may be urgent; they interrupt the
    receiver's current work.

How the rules are kept:

- When an agent finishes a turn, a hook hands it any new messages, or reminds it of
  what the law says it still owes - open tasks, results to review, blocked tasks it
  gave, unanswered questions - then waits and wakes it the moment a message arrives.
  You never have to nudge an idle agent. What the hub can do itself costs no model call:
  it keeps each agent's status (working on the task it read, idle or blocked once its
  tasks close) and releases the files of an agent with no task left.
- In the agent-org window an agent **starts with no first message**: its role, the law
  and where it left off are in its system prompt (Claude, Codex, Grok), so starting or
  restarting the team runs no model and re-reads nothing. When work arrives and no hook
  is waiting for it, agent-org types one line into the agent's terminal ("you have new
  messages") - only once the terminal is quiet, never while the agent is asking you
  something there, and not right after you typed in it. An agent restarted with
  unfinished tasks gets one line to carry on. Antigravity has no system prompt of its
  own, so the first line in a new conversation also tells it to read its role; DeepSeek
  waits without a model and runs when work arrives. After a turn an agent waits 45 seconds
  for a quick reply, then rests at its prompt - at no cost, and free for you to type to - until
  the next message.
- After every step it takes, a busy agent is told about new messages; urgent ones
  interrupt it immediately. Its activity also renews its file leases.
- Before every file edit, the hub checks the lease, so two agents never write the same
  file. For Claude agents these per-step checks run inside the agent's own org tool server
  (a few milliseconds each) instead of starting a program for every step (about half a
  second each on Windows).
- Claude agents need Sonnet, Opus or Fable: Claude Haiku has no auto mode, so it would stop
  and ask you before every edit and command. A leader cannot hire one, and the model lists
  leave it out.
- While the page is open, a **watchdog** patrols every half minute: it releases leases
  that ran out, nudges a stalled task and then tells whoever gave it, passes unanswered
  questions up, and marks what needs you on the agents' panes.

Where the ideas come from: the task lifecycle follows the
[A2A protocol](https://a2a-protocol.org/latest/topics/life-of-a-task/); "done when" and
review answer the most common failures found in
[Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) (unclear tasks,
misalignment, missing verification); tasks that wait for others come from
[Beads](https://github.com/gastownhall/beads); the watchdog is modelled on
[Gas Town](https://github.com/gastownhall/gastown)'s Witness; leases, threads and search
come from [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail); the
Board and review flow from [Vibe Kanban](https://www.vibekanban.com/).

## Memory: agents remember across restarts

- **Launch team** (or *Start* on a card) resumes each agent's last conversation, so
  it remembers everything it was doing. In the window it is told nothing unless it has
  unfinished tasks or new messages (then one line); in terminal tabs it is told the team
  was restarted and picks up its open tasks and messages.
- If a conversation can no longer be resumed, the new session still starts from what
  the hub kept: the agent's own notes, its open tasks, the files it holds and its
  recent messages.
- *Start fresh* on a card begins a new conversation on purpose (the hub's memory is
  kept).
- *Stop* ends an agent's program; its conversation is kept for the next start.

## Consultants

When a subordinate asks for help, its superior can summon a **consultant**: a
temporary helper, placed under the agent that asked, running a stronger (or cheaper)
model from a tier you configure. It opens in its own terminal, edits only the files it is
handed, and is dismissed when the problem is solved; its files go back to the agent
it helped. Tiers are set in *Edit team* (for example *opus-medium*, *luna-high*,
*opus-xhigh*), each with what it is good for and how many may run at once.

## Checks, history and starting by themselves

These are set in *Edit team*, under the team's name.

- **Checks** are commands that must pass before a task can be closed as done - your
  tests, a linter, a build. Each can be limited to certain files (`*.py`), so a task that
  changed only documents does not run the tests. Agents see the checks in their role card
  and in every task they get, so they run them before they finish. When a check fails,
  the agent gets its command and output, and the task stays in progress until it passes.
- **History:** open any task on the Board and click *Turn on history* (once per
  project). The project folder becomes its own git repository, each task shows exactly
  what it changed, and **Accept & commit** saves one commit per accepted task, so any
  task can be undone later with git. agent-org never commits into a larger repository
  that merely contains the project folder: turning history on gives the folder its own.
- **Start agents automatically:** while the page is open, an agent that has work
  waiting but is not running is started for you. **At most N agents at once** keeps
  the number of running agents (and your subscription use) down; the others wait for a
  free place.

## Set your team up once

In *Edit team*, **Save as my team…** keeps the team (its roles, programs, models, duties,
consultants, checks and settings) and can make it your **default**. When you create a team
for a new project, your saved teams are listed first and the default is already chosen:
pick the folder and click *Create team*. *Make default* and *Delete* are next to each.

## The Role Market

A **role** is a packaged agent: its program and model, its reasoning effort, the tasks it does
(its duties), its prompt (instructions: how to work, what to check), the files it may write,
and a name, icon, description and tags to find it by.

The **Roles** page is a marketplace of them: ready-made ones (planner, coder, reviewer,
tester, researcher, Gemini coder) and your own.

- **Search** and **filter** by program; open *Tasks and prompt* on a card to see what it does.
- **New role** designs one; **Duplicate** copies any role. **Edit** and **Delete** work on every
  role, the ready-made ones too: an edited ready-made role shows *Edited* and has **Reset** to
  go back to the original, and a deleted one comes back with the link at the bottom of the page.
- Model and reasoning effort are dropdowns of what each program offers; **Other…** takes any name.
- **Export** downloads a role as a `.role.yaml` file; **Import…** adds one - share roles, or
  keep them safe.
- **Add to team** places a role in the open team: choose its name and whom it reports to.
- **Build a new team from roles:** under *Create a new team*, choose *Build my own from the
  Role Market*, add roles, and set whom each reports to - the first one leads.
- In *Edit team*, **Save as preset…** turns any role into a market role, and **+ Add role…**
  offers the market. Managers can hire from it too: `hire_agent(name, preset="reviewer")`.

Your roles are kept in `~/.agent-org/roles/`.

## The team can change while it runs

The leader, and any agent with people below it, can:

- **hire_agent**: add an agent under itself (or under someone below it) - its program,
  model, duties and files. It opens in its own terminal and starts at once.
- **change_agent**: change an agent below it - duties, files, model or whom it reports to.
  A new model applies from the agent's next start.
- **let_go_agent**: remove an agent below it whose work is over (its unfinished tasks must
  be reassigned or cancelled first). Its program stops; its people move up one level.

Every change is saved to `team.yaml` (the old one is kept as `team.yaml.bak`), everyone
sees it at once, and you are told about it in *Messages*. You can turn it off in *Edit team*
(**Agents may change the team**). So you can also start with just a leader (*Solo*) and
let it build the team the work needs.

## Several agents on one file: git branches

By default one agent writes a file at a time (the lease in rule 9), and the others wait.
Turn on **Agents work on their own git branches** in *Edit team* and they no longer wait:

- Each agent works in its own copy of the project (a git worktree in
  `.agent-org/worktrees/<role>`, on branch `agent/<role>`), and edits any file in its scope.
- When it finishes a task as done, the hub commits its work, merges the latest main into
  it, runs the checks there, and puts it into main at once - no waiting for the review.
  Changes to different parts of the same file merge by themselves.
- Only when two agents changed the very same lines does the work come back to the agent,
  with both versions (and the original) marked in the file, to settle.
- Each copy takes in main's new work by itself as the agent goes, so the copies stay close
  and conflicts stay small. `share_work` lets an agent put something others need (a plan,
  an interface) into main before it is done.
- History is turned on by itself; the Board shows what each task changed, and every task
  is one merge in `git log`.

## Safety

Agents run with their programs' normal permissions: Claude Code, Codex, Grok and
Antigravity still ask you in their tab before anything risky (only the `org` tools are
pre-approved). On top of that, agent-org holds every agent to these limits:

- **The team's own configuration is off limits.** No agent edits `team.yaml`, the hub's
  folder (`.agent-org`), agent-org's plugin or project configs, or `.git` - so none can
  rewrite its own permissions or the law. Team changes go through `hire_agent` /
  `change_agent`.
- **Dangerous commands are refused before they run:** `git push` (publishing is your
  call), commands that wipe other agents' unsaved work in a shared folder (`git reset
  --hard`, `git clean`, `git checkout .`, `git stash`), and deleting drives, home folders or
  anything outside the project. Everyday commands - tests, builds, `rm -rf build` inside the
  project - are not touched.
- **Secrets stay out of git history.** New work that adds a private key or an API token
  (`sk-...`, AWS, GitHub, Google, Slack keys, passwords in code) is refused, with the file
  and line but never the value, until it reads them from the environment instead.
- **Nobody gives more than they have.** A manager can only hire or change agents with files
  it may write itself, and the team cannot grow past **At most this many agents in the
  team** (12 by default). A new hire does not start past the running limit.
- **With git branches, scope is checked at the door:** work only reaches main if every file
  it changed is in the agent's write scope - including files written through the shell.
- Every refusal is recorded in *Activity* (kind "safety"). The command guard and the secret
  check can be turned off in *Edit team* if a project really needs it.

### The web page

Only your own browser can use the page - not other web sites, and not other programs on
your PC (the agents' shells included):

- It is reachable from this PC only (127.0.0.1) and refuses other host names.
- The link that opens it works **once, for two minutes**; your browser then gets a session
  cookie that page scripts cannot read and that other sites never send. Nothing that could
  act as you is printed or put on a command line. To open the page in another browser (or
  after a restart of the browser), press **Enter in the black agent-org window**: it prints
  a new link.
- Every change (POST) must come from the page itself as JSON; forms or requests sent from
  other sites, oversized or malformed bodies are refused before anything happens.
- The page is served with strict security headers (only its own scripts, it cannot be
  framed by another site, no referrer, nothing cached), and errors never show internals.

## When a subscription runs out

Each program runs on its own subscription, so when one is used up the others can carry
the work.

- agent-org reads each agent's conversation file and notices when Claude Code or Codex
  stopped on its usage limit (and when the limit resets), or on another API error.
- The agent's card says so ("out of its usage limit until 19:20"). It is not started
  again before the reset, and whoever gave it tasks is told who else is free - agents on
  other programs first. They, or you with **Move its tasks**, move each task with
  everything done so far: its conversation, the files it changed and the leases on them.
- After the reset, or a few minutes after any other API error, an agent still idle at its
  prompt gets a **Restart** button. With *Start agents automatically* on, it is restarted
  by itself on the same conversation and carries on.
- Grok and Antigravity don't record their limits where agent-org can read them yet;
  restart those agents from their card.

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
- **An Antigravity tab asks you to verify your account, or stops at sign-in:** run
  `agy` once in a normal terminal, finish the Google sign-in there, then start the
  agent again.
- **A task will not close as done:** a check failed. Its output is in the agent's tab
  and in the task's *Checks* line on the Board; the agent is expected to fix it.

## For developers

It runs on Python 3.11+ with the packages in `requirements.txt`: PyYAML, plus `pywinpty` (the
agents' terminals) and `pywebview` (the window) - without those two, agent-org falls back to
Windows Terminal tabs and the browser - and `tzdata`. For the tests: `pip install pytest`. xterm.js (MIT, see `ui_static/xterm-LICENSE.txt`) is bundled in
`ui_static`. From this folder:

| Command | What it does |
|---|---|
| `python -m agent_org.ui [--team team.yaml] [--browser]` | the agent-org window (or the page in a browser) |
| `python -m agent_org.launch --team team.yaml [roles] [--fresh] [--force] [--dry-run]` | open agent tabs from the command line |
| `python -m agent_org.launch --install-grok-hooks` | install the hooks for Grok |
| `python -m agent_org.cli --team team.yaml [--as ROLE] tree/send/inbox/view/claim/...` | the hub from the command line |
| `python -m agent_org.doctor` | the setup check, in the terminal |
| `python -m pytest` | the tests |

How it fits together:

- `team.py` - the role tree and consultant tiers, from `team.yaml`.
- `hub.py` - the message law, the task lifecycle, file leases and consultants, over
  `store.py` (one SQLite file per team in `.agent-org/`, shared by every agent's
  process, upgraded in place when the format grows).
- `watchdog.py` - nudges, escalations, expired leases and the problems list
  (`python -m agent_org.watchdog --team team.yaml` runs it without the UI).
- `usage.py` - token use per agent, and whether its last turn ended on a usage limit
  or an API error, from each harness's session files.
- `mcp_server.py` - the `org` tools each agent gets (standard-library MCP over stdio).
- `hooks.py` / `org_hook.py` - the hooks each harness runs: deliver mail, remind of
  duties, guard edits, record the conversation id.
- `launch.py` - writes each role's start script (Claude Code: `--mcp-config`,
  `--settings`, `--append-system-prompt-file`; Codex: `-c` overrides; Grok: project
  MCP config and `--rules`; Antigravity: a project plugin in
  `.agents/plugins/agent-org/` with its MCP config and hooks), resumes conversations
  (`sessions.py`), stops agents, and keeps to the team's running limit.
- `cards.py` - the role card: the law, the team, and where the agent left off.
- `verify.py` - the team's checks; `gitops.py` - task diffs and one commit per
  accepted task (only in a repository whose top folder is the project).
- `ui.py` + `ui_static/` - the window's page (also runs the watchdog and automatic starts);
- `terminals.py` - the agents' pseudo-terminals the window shows;
  `templates.py` - the starting teams; `doctor.py` - the setup check.

## License

MIT - see [LICENSE](LICENSE). The bundled xterm.js is MIT too (`agent_org/ui_static/xterm-LICENSE.txt`).
