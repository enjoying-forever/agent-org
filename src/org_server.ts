/**
 * The command harnesses run for an agent's org tools: `org_server [--team team.yaml --role name]`, MCP over stdio.
 */

import module from 'node:module';

module.enableCompileCache?.();
const { main } = await import('./mcp_server.ts');
// Exit even if a check the server started is still running: the harness that wanted its answer is gone.
process.exit(await main(process.argv.slice(2)));
