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
| sessions.py | src/sessions.ts | (sessions tests need launch) |
| usage.py | src/usage.ts | usage.test.ts (DeepSeek one waits for runview) |
| hooks.py + org_hook.py | src/hooks.ts, src/org_hook.ts | hooks.test.ts |
| mcp_server.py | src/mcp_server.ts, src/org_server.ts | mcp_server.test.ts (launcher hooks in via `main(argv, launcher)`) |
| presets.py | src/presets.ts | presets.test.ts |
| templates.py | src/templates.ts | (ui tests) |
| launch.py | | |
| watchdog.py | src/watchdog.ts | law_v2, failover |
| waker.py | | |
| wake.py, runview.py (DeepSeek) | | |
| terminals.py | | |
| doctor.py | | |
| cli.py | | |
| ui.py (server) | | |
| Electron shell | | |
| install / launcher / README | | |

Found while porting:
- The `yaml` package's YAML 1.1 mode reads a lone `.` as NaN: team files are parsed as YAML 1.2.
- Time zones come from Intl (every JavaScript engine has them): no tzdata package.

To do before release:
- A hook process (Codex, Grok, Antigravity per step; Claude only at turn end) takes ~590 ms here
  against ~340 ms for an empty Node: 86 ms is the work, the rest is loading many module files.
  Bundle src/ into one file per entry point when packaging.
