/**
 * The command harnesses run for agent-org's hooks: `org_hook <event> [agy]`, the event as JSON on stdin.
 *
 * Outside an agent-org tab (no AGENT_ORG_TEAM / AGENT_ORG_ROLE) it answers at once without loading anything:
 * Grok's hooks are global, so every Grok session in the world runs it.
 */

import module from 'node:module';

const [event = '', ...rest] = process.argv.slice(2);
if (!(process.env.AGENT_ORG_TEAM && process.env.AGENT_ORG_ROLE)) {
  if (rest.includes('agy')) process.stdout.write(event === 'pre-edit' ? '{"decision": "ask"}' : '{}'); // it expects an answer
} else {
  // Compiled code is kept on disk between runs: a hook is a new process on every tool call of some programs.
  module.enableCompileCache?.();
  const { main } = await import('./hooks.ts');
  const { Hub } = await import('./hub.ts');
  process.exitCode = await main(process.argv.slice(2), (file) => Hub.open(file));
}
