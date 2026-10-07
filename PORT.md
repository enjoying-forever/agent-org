# Port to Electron + TypeScript (branch `electron`)

The owner asked for agent-org without Python: the engine in TypeScript and the window in Electron
(not Edge; as light as Electron allows). The Python version on `main` stays the working one until
this branch passes the same tests and a live team run. The database format and the page
(`agent_org/ui_static`) are unchanged, so existing teams open in either.

Conventions: Node 24 / Electron 44 (Node 24 inside, `node:sqlite` built in). Sources in `src/`,
run directly by Node (type stripping: erasable syntax only, imports with `.ts`) and compiled by
`tsc` to `dist/` for Electron. Data fields keep their snake_case names (database columns and the
page's JSON); functions and methods are camelCase. Tests use `node:test` in `test/`.

| Python module | TypeScript | Tests ported |
|---|---|---|
| store.py | src/store.ts | hub, law (upgrade of old databases) |
| team.py | src/team.ts | team.test.ts |
| (fnmatch) | src/fnmatch.ts | via safety, leases |
| filelock.py | src/filelock.ts | via team changes |
| safety.py | src/safety.ts | safety.test.ts |
| verify.py | src/verify.ts | history.test.ts |
| gitops.py | src/gitops.ts | history, branches |
| hub.py | src/hub.ts | hub, law, law_v2, consultants, team_changes, failover |
| cards.py | src/cards.ts | law, consultants, presets |
| sessions.py | src/sessions.ts | sessions.test.ts |
| usage.py | src/usage.ts | usage.test.ts |
| hooks.py + org_hook.py | src/hooks.ts, src/org_hook.ts | hooks.test.ts |
| mcp_server.py | src/mcp_server.ts, src/org_server.ts | mcp_server.test.ts (launcher hooks in via `main(argv, launcher)`) |
| presets.py | src/presets.ts | presets.test.ts |
| templates.py | src/templates.ts | (ui tests) |
| launch.py | src/launch.ts (+ src/runtime.ts: own entry points, which, registry) | launch.test.ts |
| watchdog.py | src/watchdog.ts | law_v2, failover |
| waker.py | src/waker.ts | waker.test.ts |
| wake.py, runview.py (DeepSeek) | src/wake.ts, src/runview.ts | launch, waker |
| terminals.py | src/terminals.ts (node-pty) | terminals.test.ts, window.test.ts |
| doctor.py | src/doctor.ts (Python checks become Runtime and Terminals) | control.test.ts |
| cli.py | src/cli.ts | cli.test.ts (new) |
| ui.py (server) | src/ui.ts (node:http; the page in agent_org/ui_static unchanged) | ui, web_security, window, control |
| Electron shell | src/electron/main.ts | live run (below) |
| install / launcher / README | | |

Found while porting:
- The `yaml` package's YAML 1.1 mode reads a lone `.` as NaN: team files are parsed as YAML 1.2.
- Time zones come from Intl (every JavaScript engine has them): no tzdata package.
- Agent-org's own programs (tool server, DeepSeek's waiter) run on the Node that runs agent-org: inside
  the app that is Electron with ELECTRON_RUN_AS_NODE=1. Hook commands are plain command lines run by
  several shells: inside the app they name the computer's own node.exe (installing needs one), else
  ~/.agent-org/bin/org_hook.cmd, which sets ELECTRON_RUN_AS_NODE (and costs a cmd.exe: 55 ms a hook).
- In the window an agent whose start is one program runs it directly (start.json beside start.ps1; an
  npm .cmd shim resolved to its .exe or node + script), not in PowerShell (35 MB an agent); when it
  ends, a PowerShell prompt follows in the same terminal, as the start script's used to stay.
- npm installs a .ps1 shim beside each .cmd, and PowerShell prefers it: so a start script's multi-line
  argument (Grok's --rules) arrives whole. Through a .cmd alone, cmd.exe would cut it at the first line.
- Windows Terminal's wt.exe is an app execution alias: stat fails on it, lstat sees a link. `which`
  takes such a link as found (the Python setup check had the same need).
- node-pty ends a terminal asynchronously: TerminalHost.closeAll returns a promise for the programs' end.
- A new program's environment: agent-org's own minus what its starter set (Claude Code's, Electron's),
  with the registry's current variables and PATH (no CreateEnvironmentBlock without native code).

Live run (2026-10-08, Electron app, Claude leader + Claude worker, trusted test folder): the owner's
task went leader -> worker -> file written -> reviewed -> reported back in about 45 seconds. Seen working:
agents in the window's node-pty terminals, the tool server as Electron-as-Node, the waker's wake lines,
the in-server pre-edit hook (lease taken and released), the Stop hook through org_hook.cmd, Stop and Quit
from the page. Memory with GPU acceleration off: about 126 MB private over 4 processes (223 MB with it on).
Closing the window with an agent running (2026-10-08): the page asks; "keep running" hides the window
with the agent still at work, a second start brings it back, and "stop them and quit" ends the agent and
the app.
DeepSeek, without a model run (2026-10-08): its start shows the banner and the waiter's input line (both
agent-org programs on Electron as Node), it counts as running, and Stop ends the waiter.
Not run live yet: Codex (its new hook command needs the owner's one-time "Trust all"), Grok (installing
its hooks rewrites ~/.grok/hooks), Antigravity (replaces the user-level plugin), a DeepSeek model run.

Hook speed (a hook process runs on every tool step of Codex, Grok and Antigravity; Claude's run inside its
tool server): about 145 ms each, on Node or on Electron as Node, against 70 ms for an empty start. The
YAML library took 65 ms to load: it now loads only when a team.yaml must be read afresh (each one read is
kept as JSON in ~/.agent-org/cache/teams, under the file's size and time of change). Bundling into one
file (esbuild, tried earlier) would save little more. A Codex hook also globbed every day of
~/.codex/sessions to tell the agent's conversation from its auto-reviewer's (33 ms of 86 with 130 days):
it now reads only the days since the conversation's id (a UUID v7) began, 151 -> 118 ms a hook.

Starting a role (measured 2026-10-07, on the app's main thread): finding programs on PATH took most of it,
as which() tried 13 extensions in each of 90 folders, one a broken link costing 15 ms a look (0.8 s for a
program not there). Folder listings are now kept until the folder changes: Claude and Codex 100 -> 10 ms,
Antigravity 1.3 s -> 26 ms, DeepSeek 0.9-2.3 s -> 21 ms. A role with no conversation on record searched
the harness's saved ones (Codex: 280 ms with 500 conversations); a new team now reads none, a ten-day-old
one 44 ms. In the app (live, 2026-10-07), the first agent's start answers in about 0.8 s, of which 0.45 s
is Windows starting its first pseudo-console (later ones 45-70 ms) and 0.25 s the one-time check of
dsh's version; the next agent answers in 0.34 s.

Before this branch becomes main:
- Live runs on Codex (the new hook command needs the owner's one-time "Trust all"), Grok (agent-org
  rewrites ~/.grok/hooks/agent-org.json for the new command), Antigravity (it replaces the user-level
  plugin) and a DeepSeek task. Each changes something of the owner's, so the owner starts those.

Start-up (measured 2026-10-08): the server is up 185 ms after launch and the window is made at 240 ms; the
page shows at about 1.4 s. Of that, about 1 s is Chromium starting a fresh page process on Windows: with a
warm one the page is interactive in 190 ms. Letting the page's files be cached (for compiled scripts),
GPU on or off: no difference, so neither was kept.
