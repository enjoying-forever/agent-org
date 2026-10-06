// Starting agents: the start script, files and command line each harness gets.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { parse as parseToml } from 'smol-toml';
import { Hub, HubError } from '../src/hub.ts';
import * as launch from '../src/launch.ts';
import { entry, which } from '../src/runtime.ts';
import * as runview from '../src/runview.ts';
import * as sessions from '../src/sessions.ts';
import { dumpYaml, parseYaml } from '../src/team.ts';
import * as wake from '../src/wake.ts';
import { cleanup, raises, team, tmpDir } from './helpers.ts';

function teamFile(t: TestContext, change: (c: ReturnType<typeof team>) => void = () => {}): string {
  const dir = tmpDir(t);
  mkdirSync(path.join(dir, 'project'));
  const data = team();
  Object.assign(data.roles.leader, { model: 'opus', effort: 'high', duties: "Plan it; don't code." });
  Object.assign(data.roles['worker-a'], { model: 'gpt-6-luna', effort: 'low' });
  change(data);
  const file = path.join(dir, 'team.yaml');
  writeFileSync(file, dumpYaml(data), 'utf8');
  return file;
}

function openHub(t: TestContext, file: string): Hub {
  const hub = Hub.open(file);
  cleanup(t, () => hub.close());
  return hub;
}

async function runDry(file: string, ...roles: string[]): Promise<string> {
  const err = captureStderr();
  try {
    assert.equal(await launch.main(['--team', file, '--dry-run', ...roles]), 0);
  } finally {
    err.restore();
  }
  lastStderr = err.text;
  return path.join(path.dirname(file), '.agent-org', 'launch');
}

let lastStderr = '';

function captureStderr(): { text: string; restore: () => void } {
  const write = process.stderr.write.bind(process.stderr);
  const captured = { text: '', restore: () => { process.stderr.write = write; } };
  process.stderr.write = ((chunk: string) => {
    captured.text += chunk;
    return true;
  }) as typeof process.stderr.write;
  return captured;
}

const read = (file: string): string => readFileSync(file, 'utf8');
const tomlValue = (text: string): unknown => parseToml(`v = ${text}`).v;

for (const value of ['plain', 'quotes " and \'single\'', 'back\\slash C:\\x\\y', 'line one\nline two\ttab', '中文 ✓',
  ['-m', 'org_server.ts', 'C:\\a b\\team.yaml'], { ELECTRON_RUN_AS_NODE: '1' }, 3600]) {
  test(`TOML values round-trip: ${JSON.stringify(value)}`, () => {
    assert.deepEqual(JSON.parse(JSON.stringify(tomlValue(launch.toml(value)))), value);
  });
}

test('a PowerShell literal doubles single quotes', () => {
  assert.equal(launch.ps("it's"), "'it''s'");
});

test("a Claude role's files", async (t) => {
  const file = teamFile(t);
  const out = path.join(await runDry(file, 'leader'), 'leader');
  const config = JSON.parse(read(path.join(out, 'mcp.json'))).mcpServers.org;
  assert.deepEqual(config.args.slice(-2), ['--role', 'leader']);
  assert.equal(config.command, process.execPath);
  assert.equal(config.args[0], entry('org_server')); // runs on agent-org's own Node
  assert.ok(read(path.join(out, 'role.md')).includes("You are 'leader'"));
  const script = read(path.join(out, 'start.ps1'));
  assert.ok(script.includes("$env:AGENT_ORG_ROLE = 'leader'"));
  assert.ok(script.includes("$env:MCP_TOOL_TIMEOUT = '3600000'"));
  // a wait for mail stays one quiet call: not moved to the background, not cut off as idle
  assert.ok(script.includes("$env:CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '0'"));
  assert.ok(script.includes("$env:CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = '3600000'"));
  assert.ok(script.includes("$env:DISABLE_AUTOUPDATER = '1'")); // agents must not update the shared install
  assert.match(script, /'--model' 'opus' '--effort' 'high' '--session-id' '[0-9a-f-]{36}' '--name' 'leader' 'You are the ''leader'' agent/);
});

test('an agent starts without your PowerShell profile but with the proxy', async (t) => {
  const before = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
  cleanup(t, () => {
    if (before === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = before;
  });
  const file = teamFile(t);
  const script = read(path.join(await runDry(file, 'leader'), 'leader', 'start.ps1'));
  assert.ok(script.includes("$env:HTTPS_PROXY = 'http://127.0.0.1:7890'")); // what a profile used to give it
  const tab = launch.roleTab(openHub(t, file), file, 'leader');
  assert.ok(tab.includes('-NoProfile')); // faster, and no profile output or settings in the agent's terminal
});

test('a Claude model written with a dot still starts', () => {
  assert.equal(launch.claudeModel('claude-sonnet-5.5'), 'claude-sonnet-5-5');
  assert.equal(launch.claudeModel('claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(launch.claudeModel('sonnet'), 'sonnet');
});

function overrides(args: string[]): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  args.forEach((a, i) => {
    if (a !== '-c') return;
    const o = args[i + 1];
    const at = o.indexOf('=');
    parsed[o.slice(0, at)] = tomlValue(o.slice(at + 1));
  });
  return parsed;
}

test("Codex's script passes valid TOML", async (t) => {
  const file = teamFile(t);
  assert.ok(read(path.join(await runDry(file, 'worker-a'), 'worker-a', 'start.ps1')).includes("& 'codex' "));
  const built = launch.codexLaunch(openHub(t, file), file, 'worker-a', tmpDir(t), null, null, false);
  const parsed = overrides(built.args);
  assert.deepEqual((parsed['mcp_servers.org.args'] as string[]).slice(-2), ['--role', 'worker-a']);
  assert.equal(parsed['mcp_servers.org.tool_timeout_sec'], launch.WAIT_LIMIT);
  assert.equal(parsed.model_reasoning_effort, 'low');
  assert.ok((parsed.developer_instructions as string).includes("You are 'worker-a'"));
  assert.equal(built.args.at(-1), launch.kickoff('worker-a'));
  assert.ok(built.args.includes('check_for_update_on_startup=false')); // no update menu waiting for a key at start
});

test('a Codex agent leaves your plugins, servers and memories out', (t) => {
  const dir = tmpDir(t);
  const config = path.join(dir, 'config.toml');
  writeFileSync(config, '[plugins."browser@openai-bundled"]\nenabled = true\n[mcp_servers.node_repl]\ncommand = "node_repl.exe"\n'
    + '[mcp_servers.org]\ncommand = "x"\n[memories]\nuse_memories = true\n', 'utf8');
  const off = launch.codexExtrasOff(config);
  const pairs = off.filter((_, i) => i % 2 === 1);
  // Codex splits keys at dots and takes quotes literally ("node_repl" would be a new, broken server)
  assert.ok(pairs.includes('plugins.browser@openai-bundled.enabled=false'));
  assert.ok(pairs.includes('mcp_servers.node_repl.enabled=false'));
  assert.ok(!pairs.some((p) => p.includes('org'))); // the team's own server stays
  assert.ok(pairs.includes('memories.use_memories=false') && pairs.includes('memories.generate_memories=false'));
  for (const p of pairs) assert.equal(tomlValue(p.slice(p.indexOf('=') + 1)), false); // each is valid TOML, as Codex reads it
  assert.deepEqual(launch.codexExtrasOff(path.join(dir, 'missing.toml')), []); // no config: nothing to turn off
});

test('Grok registers the project server, then starts', async (t) => {
  const file = teamFile(t);
  const script = read(path.join(await runDry(file, 'researcher'), 'researcher', 'start.ps1'));
  const at = script.indexOf("& 'grok' 'mcp' 'add'");
  const head = script.slice(0, at);
  const [register, start] = [script.slice(at, script.indexOf('| Out-Null\n')), script.slice(script.indexOf('| Out-Null\n') + 11).trim()];
  assert.ok(head.includes('Set-Location')); // registered in the project folder
  // the server entry carries no role; '--' stays quoted so PowerShell passes it on
  assert.ok(register.includes("'--scope' 'project' 'org' "));
  assert.ok(register.includes(`'--' ${launch.ps(entry('org_server'))}`) && !register.includes('--role'));
  assert.ok(start.startsWith("& 'grok' '--rules' 'You are ''researcher''"));
  assert.ok(start.includes("'--allow' 'MCPTool(org__*)'"));
  assert.ok(start.endsWith(launch.ps(launch.kickoff('researcher'))));
});

test('every harness is launched', async (t) => {
  const base = await runDry(teamFile(t));
  assert.ok(!lastStderr.includes('skipping'), lastStderr);
  assert.deepEqual(readdirSync(base).sort(), ['leader', 'researcher', 'tech-lead', 'worker-a', 'worker-b', 'you']);
});

test("the owner's console", async (t) => {
  const script = read(path.join(await runDry(teamFile(t)), 'you', 'start.ps1'));
  assert.ok(script.includes('function org {') && script.includes('org tree'));
  assert.ok(script.includes('org send leader'));
});

test("a consultant's tab uses its tier", (t) => {
  const file = teamFile(t);
  const hub = openHub(t, file);
  const request = hub.session('worker-a').askHelp('stuck');
  hub.session('tech-lead').summonConsultant(request.id, 'medium'); // no opener: nothing opens
  const tab = launch.roleTab(hub, file, 'consultant-1');
  assert.equal(tab[tab.indexOf('--title') + 1], 'consultant-1 (medium)');
  const out = path.join(path.dirname(file), '.agent-org', 'launch', 'consultant-1');
  assert.match(read(path.join(out, 'start.ps1')), /'--model' 'claude-opus-5-5' '--effort' 'medium' '--session-id' '[0-9a-f-]{36}' '--name' 'consultant-1'/);
  assert.ok(read(path.join(out, 'role.md')).includes('temporary medium consultant'));
});

test('Claude gets the hooks through settings', async (t) => {
  const out = path.join(await runDry(teamFile(t), 'leader'), 'leader');
  const hooks = JSON.parse(read(path.join(out, 'settings.json'))).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
  assert.equal(hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell');
  // the hooks of every tool call run in its org tool server: no process to start for each
  for (const [event, name] of [['PreToolUse', 'pre-edit'], ['PostToolUse', 'post-tool']]) {
    const [hook] = hooks[event][0].hooks;
    assert.deepEqual([hook.type, hook.server, hook.tool, hook.input.event], ['mcp_tool', 'org', launch.HOOK_TOOL, name]);
    assert.equal(hook.input.tool_input, '${tool_input}');
  }
  const stop = hooks.Stop[0].hooks[0];
  assert.ok(stop.command.endsWith('org_hook.ts stop') && stop.timeout > 1800, stop.command);
  assert.ok(read(path.join(out, 'start.ps1')).includes(`'--settings' '${path.join(out, 'settings.json')}'`));
});

test('a Claude agent gets only the tools a teammate needs', async (t) => {
  const script = read(path.join(await runDry(teamFile(t), 'leader'), 'leader', 'start.ps1'));
  assert.ok(script.includes("'--strict-mcp-config'") && script.includes("'--no-chrome'")); // none of your MCP servers or Chrome
  const tools = /'--tools' '([^']*)'/.exec(script)?.[1].split(',') ?? [];
  for (const tool of ['Bash', 'Read', 'Edit', 'Write']) assert.ok(tools.includes(tool));
  assert.ok(script.includes("$env:ENABLE_TOOL_SEARCH = 'false'")); // the org tools are there at once: no lookup step
  assert.ok(!['Task', 'Workflow', 'Artifact', 'CronCreate'].some((x) => tools.includes(x))); // no subagents or side channels
  assert.ok(script.includes("'--allowedTools' 'mcp__org'")); // the team's own tools stay
});

test('a Claude agent runs without your mods and tips', async (t) => {
  const settings = JSON.parse(read(path.join(await runDry(teamFile(t), 'leader'), 'leader', 'settings.json')));
  assert.equal(settings.env.CLAUDE_CODE_PLUGIN_DIRS, ''); // no personal status lines under every agent
  assert.equal(settings.spinnerTipsEnabled, false);
});

test('Codex gets the hooks through config overrides', (t) => {
  const file = teamFile(t);
  const built = launch.codexLaunch(openHub(t, file), file, 'worker-a', tmpDir(t), null, null, false);
  const hooks = Object.fromEntries(Object.entries(overrides(built.args)).filter(([k]) => k.startsWith('hooks.'))
    .map(([k, v]) => [k.slice(6), v as Record<string, any>[]]));
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
  assert.ok(!('matcher' in hooks.PreToolUse[0])); // pre-edit picks out edits itself
  assert.ok(hooks.PostToolUse[0].hooks[0].command.endsWith('org_hook.ts post-tool'));
});

test('running roles are not started twice', (t) => {
  const file = teamFile(t);
  const hub = openHub(t, file);
  hub.store.checkIn(123, 'worker-a');
  let [tabs, skipped] = launch.prepare(hub, file, ['leader', 'worker-a'], false);
  assert.deepEqual(tabs.map((x) => x[x.indexOf('--title') + 1]), ['leader']);
  assert.deepEqual(skipped, ['worker-a: already running']);
  [tabs, skipped] = launch.prepare(hub, file, ['worker-a'], false, { force: true });
  assert.ok(tabs.length === 1 && skipped.length === 0);
});

test("Grok's hooks install into the home folder", () => {
  const file = launch.installGrokHooks();
  assert.equal(file, launch.paths.grokHooksFile());
  assert.ok(file.startsWith(process.env.AGENT_ORG_HOME ?? '?')); // the tests' stand-in, not the real ~/.grok
  const hooks = JSON.parse(read(file)).hooks;
  assert.equal(hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|Bash|Shell|run_terminal_cmd|run_command');
});

test('unknown roles are refused', async (t) => {
  const err = captureStderr();
  try {
    assert.equal(await launch.main(['--team', teamFile(t), '--dry-run', 'ghost']), 2);
  } finally {
    err.restore();
  }
});

test('the scripts it writes parse in PowerShell', { skip: which('pwsh') === null && 'needs PowerShell 7' }, async (t) => {
  const base = await runDry(teamFile(t));
  const scripts = readdirSync(base).map((r) => path.join(base, r, 'start.ps1'));
  const check = scripts.map((s) => `$e = $null; [System.Management.Automation.Language.Parser]::ParseFile('${s}', [ref]$null, [ref]$e) | Out-Null; `
    + `if ($e) { '${s}'; $e | ForEach-Object { $_.Message }; $bad = 1 }`).join('\n');
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', `$bad = 0\n${check}\nexit $bad`], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('Antigravity runs interactively with a user-level plugin', async (t) => {
  const file = teamFile(t);
  const base = await runDry(file, 'worker-b'); // worker-b runs on antigravity
  const plugin = launch.antigravityPluginDir(); // interactive agy loads only user-level plugins
  assert.deepEqual(JSON.parse(read(path.join(plugin, 'plugin.json'))), { name: 'agent-org' });
  const server = JSON.parse(read(path.join(plugin, 'mcp_config.json'))).mcpServers.org;
  assert.deepEqual(server.args, [entry('org_server')]); // the role comes from each agent's terminal
  const hooks = JSON.parse(read(path.join(plugin, 'hooks.json')))['agent-org'];
  assert.deepEqual(Object.keys(hooks).sort(), ['PreInvocation', 'PreToolUse', 'Stop']);
  const stop = hooks.Stop[0].command;
  assert.ok(!stop.includes('"') && stop.endsWith('org_hook.ts stop agy'), stop); // runs as it is in cmd /c
  assert.ok(!existsSync(path.join(path.dirname(file), 'project', '.agents'))); // nothing written into the project
  const script = read(path.join(base, 'worker-b', 'start.ps1'));
  assert.ok(script.includes("& 'agy' '-i' 'You are the ''worker-b'' agent") && script.includes('agent-org_org'));
  assert.ok(!script.includes('runview')); // its own full terminal
});

test('Antigravity resumes by conversation', (t) => {
  const dir = tmpDir(t);
  const before = sessions.where.home;
  sessions.where.home = () => path.join(dir, 'home');
  cleanup(t, () => { sessions.where.home = before; });
  const sid = '0eee4d8d-dfcd-442e-a1f7-97d6c580cb62';
  const folder = path.join(dir, 'home', '.gemini', 'antigravity-cli', 'conversations');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, `${sid}.db`), '...');
  const file = teamFile(t);
  const hub = openHub(t, file);
  hub.store.recordSessionId('worker-b', 'antigravity', sid);
  assert.ok(launch.roleTab(hub, file, 'worker-b'));
  const script = read(path.join(path.dirname(file), '.agent-org', 'launch', 'worker-b', 'start.ps1'));
  assert.ok(script.includes(`'--conversation' '${sid}' '-i' 'agent-org: the team was restarted`));
});

test('hook commands run in PowerShell, cmd and bash', () => {
  // Grok and Codex run hooks through PowerShell, where a quoted program path is a ParserError.
  const command = launch.hookTable(null).Stop[0].hooks[0].command as string;
  assert.ok(!command.includes('"') && !command.includes('\\'), command);
  assert.ok(command.endsWith('org_hook.ts stop'));
});

test('a hook command really runs, through PowerShell', { skip: which('pwsh') === null && 'needs PowerShell 7' }, () => {
  // Outside an agent-org tab it answers Antigravity at once: proof the command line starts our hook.
  const command = launch.hookTable(null).PreToolUse[0].hooks[0].command as string;
  const env = { ...process.env };
  delete env.AGENT_ORG_TEAM;
  delete env.AGENT_ORG_ROLE;
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', `${command} agy`], { encoding: 'utf8', env });
  assert.equal(result.stdout.trim(), '{"decision": "ask"}', result.stderr);
});

test('outdated Grok hooks are reported and refreshed', () => {
  const file = launch.paths.grokHooksFile();
  writeFileSync(file, '{"hooks": {"Stop": [{"hooks": [{"command": "\\"python\\" \\"org_hook.py\\" stop"}]}]}}', 'utf8'); // the quoted form PowerShell cannot parse
  assert.equal(launch.grokHooksState(), 'outdated');
  launch.installGrokHooks();
  assert.equal(launch.grokHooksState(), 'current');
});

test('Antigravity hooks only edit tools', (t) => {
  // Antigravity treats a pre-tool answer without a decision as "deny": hooking every tool blocked them all.
  const folder = launch.antigravityPlugin(tmpDir(t));
  const pre = JSON.parse(read(path.join(folder, 'hooks.json')))['agent-org'].PreToolUse[0];
  assert.ok(pre.matcher.includes('write_to_file') && !pre.matcher.includes('call_mcp_tool') && pre.matcher !== '*');
});

test('tests can never open real agent tabs', () => {
  raises(() => launch.openTab(['wt', 'new-tab', 'pwsh']), HubError, 'inside a test');
});

function deepseekTeam(t: TestContext, model: string, effort: string): string {
  const before = launch.deepseek.command;
  launch.deepseek.command = () => ['node.exe', ['bin.js'], {}];
  cleanup(t, () => { launch.deepseek.command = before; });
  return teamFile(t, (c) => Object.assign(c.roles['worker-a'], { harness: 'deepseek', model, effort }));
}

test('DeepSeek runs headless with the org tools, shown live, and again until stopped', (t) => {
  const file = deepseekTeam(t, 'deepseek-v4-pro', 'high');
  const hub = openHub(t, file);
  launch.roleTab(hub, file, 'worker-a');
  const out = path.join(path.dirname(file), '.agent-org', 'launch', 'worker-a');
  const patch = parseYaml(read(path.join(out, 'dsh.patch.yml'))) as any[];
  const tools = patch[0].insert[0];
  assert.ok(tools.name === '@deepseek-ai/dsh-mcp-client' && tools.config.serverName === 'org');
  assert.deepEqual(tools.config.args.slice(-2), ['--role', 'worker-a']);
  assert.equal(tools.config.env.AGENT_ORG_ROLE, 'worker-a');
  assert.ok(tools.config.toolCallTimeoutMs > launch.WAIT_LIMIT * 1000); // a long wait_for_messages fits
  assert.deepEqual(patch[1], { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' } });
  const script = read(path.join(out, 'start.ps1'));
  // each run: JSON events shown live by runview, continuing the conversation kept in dsh.session
  assert.ok(script.includes("'--profile' 'headless' '--patch'") && script.includes("'--json' @resume"));
  assert.ok(script.includes(`${launch.ps(entry('runview'))} '--session-file'`) && script.includes(path.join(out, 'dsh.session')));
  assert.ok(script.includes("'--session-id', $sid"));
  // nothing runs at the start: it waits (no model) for work - at first unfinished tasks count too - then runs:
  // a new conversation is told its role, a continued one only that messages wait
  assert.ok(script.indexOf(launch.ps(entry('wake'))) < script.indexOf("'--profile' 'headless'"));
  assert.ok(script.includes('@first') && script.includes("$first = @('--first')"));
  assert.ok(script.includes('you have new messages') && script.includes("You are the ''worker-a'' agent"));
  assert.ok(script.includes(path.join(out, 'stopped')) && script.includes('$LASTEXITCODE -ne 0'));
  launch.stopRole(hub, 'worker-a');
  assert.ok(existsSync(path.join(out, 'stopped')));
  writeFileSync(path.join(out, 'dsh.session'), 'session-1234', 'utf8'); // a run kept its conversation
  assert.equal(launch.resumableSession(hub, 'worker-a'), 'session-1234');
  launch.roleTab(hub, file, 'worker-a'); // Start: lifts the stop, resumes it
  assert.ok(!existsSync(path.join(out, 'stopped')) && existsSync(path.join(out, 'dsh.session')));
  launch.roleTab(hub, file, 'worker-a', true); // Start fresh: a new conversation
  assert.ok(!existsSync(path.join(out, 'dsh.session')));
});

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, ''); // without its colors

async function view(events: unknown[], argv: string[] = []): Promise<string> {
  const out = new PassThrough();
  let shown = '';
  out.on('data', (c: Buffer) => { shown += c.toString('utf8'); });
  assert.equal(await runview.main(argv, Readable.from(`${events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n')}\n`), out), 0);
  return plain(shown);
}

test('runview shows a DeepSeek run and keeps its session', async (t) => {
  const sid = path.join(tmpDir(t), 'sid');
  const text = await view([
    { type: 'session', sessionId: 'session-abc' },
    { type: 'status', phase: 'turn_start' },
    { type: 'tool_call', tool: 'mcp__org__send_message', input: { to: 'you', text: 'done' } },
    { type: 'tool_result', status: 'completed', result: 'Sent #7.' },
    { type: 'tool_call', tool: 'read', input: { file_path: 'x.py' } },
    { type: 'tool_result', status: 'failed', result: 'no such file' },
    { type: 'text', text: 'All done.' },
    { type: 'final', text: 'All done.' },
  ], ['--session-file', sid]);
  assert.ok(text.includes('org.send_message(to=you, text=done)') && text.includes('Sent #7.'), text);
  assert.ok(text.includes('failed: no such file'));
  assert.equal(text.split('All done.').length - 1, 1); // the final answer is not shown twice
  assert.equal(read(sid), 'session-abc');
});

test('runview shows an Antigravity run as it streams', async () => {
  const step = (kw: object): object => ({ event: 'step_update', step_update: kw });
  const text = await view([
    { event: 'init', conversation_id: 'c-1', init: { tools: [] } },
    step({ step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'mcp_org_read_inbox', tool_info: { name: 'mcp_org_read_inbox', parameters: {} } }),
    step({ step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'mcp_org_read_inbox', tool_info: { name: 'mcp_org_read_inbox', output: '1 new message' } }),
    step({ step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool',
      parameters: { ServerName: 'agent-org_org', ToolName: 'send_message', Arguments: '{"to": "you", "text": "pong"}' } } }),
    step({ step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Working on ' }),
    step({ step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'task #3.\n' }),
    { event: 'result', result: { status: 'SUCCESS', response: 'Working on task #3.' } },
  ]);
  assert.ok(text.includes('conversation c-1') && text.includes('org.read_inbox()') && text.includes('1 new message'), text);
  assert.ok(text.includes('Working on task #3.')); // the streamed pieces join into one line
  assert.ok(text.includes('org.send_message(to=you, text=pong)')); // its MCP wrapper reads like the other programs'
});

test('runview keeps the token counts of each run', async (t) => {
  const usage = path.join(tmpDir(t), 'usage.json');
  const stepEnd = { type: 'status', phase: 'step_end', usage: { inputTokens: 100, cacheWriteTokens: 5, cacheReadTokens: 50, outputTokens: 7 } };
  await view([{ type: 'session', sessionId: 's-1' }, stepEnd, stepEnd], ['--usage-file', usage]);
  assert.deepEqual(JSON.parse(read(usage))['s-1'], { in: 210, cached: 100, out: 14, steps: 2 });
});

test("the DeepSeek waiter wakes on a message and ends on stop", async (t) => {
  const hub = openHub(t, teamFile(t));
  const marker = path.join(tmpDir(t), 'stopped');
  hub.store.checkIn(999999, 'worker-a'); // a run that ended without checking out
  hub.session('leader').send('worker-a', 'please start');
  assert.equal(await wake.waitForWork(hub, 'worker-a', marker, 0.01), 0); // something new: run again
  assert.equal(hub.store.online()['worker-a'] ?? 0, 0); // it checked out again, and the leftover is gone
  hub.session('worker-a').readInbox();
  writeFileSync(marker, 'stopped');
  assert.equal(await wake.waitForWork(hub, 'worker-a', marker, 0.01), wake.STOPPED);
});

test('a waiting DeepSeek agent takes a typed message', async (t) => {
  const hub = openHub(t, teamFile(t));
  await wake.readOwner(hub, 'worker-a', Readable.from('\n  please fix the login  \n')); // what the owner types into its terminal while it waits
  assert.deepEqual(hub.session('worker-a').readInbox().map((m) => [m.sender, m.text]), [[hub.team.owner, 'please fix the login']]);
  assert.ok(wake.promptLine('worker-a').includes('Type a message'));
});

test('the DeepSeek start shows a banner', (t) => {
  const file = deepseekTeam(t, 'deepseek-flash', 'low');
  launch.roleTab(openHub(t, file), file, 'worker-a');
  const script = read(path.join(path.dirname(file), '.agent-org', 'launch', 'worker-a', 'start.ps1'));
  assert.ok(script.includes("'--banner' 'DeepSeek Harness'") && script.includes("'deepseek-flash, low effort'"));
  assert.ok(script.includes("'--input'")); // its wait has an input line
});

test('the waiter and the run view run as programs', (t) => {
  const file = teamFile(t);
  const marker = path.join(tmpDir(t), 'stopped');
  writeFileSync(marker, 'stopped');
  const waited = spawnSync(process.execPath, [entry('wake'), '--team', file, '--role', 'worker-a', '--stop', marker], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(waited.status, wake.STOPPED, waited.stderr);
  const shown = spawnSync(process.execPath, [entry('runview'), '--banner', 'DeepSeek Harness', '0.2', 'deepseek-flash', 'C:\\x'], { encoding: 'utf8', timeout: 20_000 });
  assert.ok(plain(shown.stdout).includes('DeepSeek Harness 0.2'), shown.stderr);
});
