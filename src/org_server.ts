/**
 * The command harnesses run for an agent's org tools: `org_server [--team team.yaml --role name]`, MCP over stdio.
 */

import module from 'node:module';

module.enableCompileCache?.();
(await import('./runtime.ts')).keepRunningOnFaults('tool server'); // a stray fault must not take the agent's tools away
const { main } = await import('./mcp_server.ts');
const { launcher } = await import('./launch.ts'); // opens hired agents and consultants, ends let-go ones
// Exit even if a check the server started is still running: the harness that wanted its answer is gone.
process.exit(await main(process.argv.slice(2), launcher));
