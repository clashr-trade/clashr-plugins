#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { createServer } from './server.ts';
async function main() {
  const { server } = createServer(loadConfig());
  await server.connect(new StdioServerTransport());
  console.error('clashr-mcp 0.1.0: BNB mainnet; transaction submission unavailable');
}
main().catch(() => {
  console.error(
    'Clashr MCP startup failed. Check CLASHR configuration and wallet permissions. No secrets are logged.',
  );
  process.exitCode = 1;
});
