// Real stdio transport, real local BNB API/RPC. Read-only: never creates a wallet,
// signs a proof, registers, sends approvals or broadcasts transactions.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k, v]) =>
      v !== undefined &&
      (/^(CLASHR_|BSC_RPC_URL$)/.test(k) ||
        ['PATH', 'Path', 'SystemRoot', 'USERPROFILE', 'HOME', 'TEMP', 'TMP'].includes(k)),
  ),
);
env.CLASHR_DRY_RUN = '1';
const state = mkdtempSync(join(tmpdir(), 'clashr-read-only-smoke-'));
env.CLASHR_STATE_DIR = state;
delete env.CLASHR_WALLET_FILE;
// A packaged launcher must not read the operator's default config during smoke.
env.CLASHR_CONFIG_FILE = join(state, 'smoke.env');
writeFileSync(env.CLASHR_CONFIG_FILE, '');
const client = new Client({ name: 'clashr-read-only-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    fileURLToPath(
      new URL(
        process.argv.includes('--plugin')
          ? '../../../dist/clashr-plugin-marketplace/plugins/clashr/scripts/start.mjs'
          : '../dist/index.js',
        import.meta.url,
      ),
    ),
  ],
  env,
  stderr: 'inherit',
});
const results = [];
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }),
    data = JSON.parse(r.content[0].text);
  results.push({ tool: name, ok: !r.isError, ...(r.isError ? { code: data.error?.code } : {}) });
  if (r.isError) throw Error(`${name} failed: ${data.error?.code}`);
  return data;
}
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((t) => t.name);
  if (names.includes('buy') || names.includes('sell')) throw Error('Unexpected execution tool');
  await call('my_status');
  const scan = await call('scan', { column: 'new', limit: 3 });
  await call('feed', { limit: 1 });
  await call('leaderboard', { limit: 1 });
  const token =
    process.argv.slice(2).find((a) => a.startsWith('0x')) ?? scan.items[0]?.coin.address;
  if (!token) throw Error('No indexed token available for quote smoke');
  await call('token', { address: token });
  const q = await call('quote', {
    token,
    side: 'buy',
    venue: 'flap',
    amountIn: '100000000000000',
    trader: '0x2222222222222222222222222222222222222222',
  });
  if (process.argv.includes('--simulate')) await call('dry_run', { quoteId: q.quote.id });
  if (process.argv.includes('--pancake'))
    await call('quote', {
      token: '0x55d398326f99059ff775485246999027b3197955',
      side: 'buy',
      venue: 'pancake',
      amountIn: '100000000000000',
      trader: '0x2222222222222222222222222222222222222222',
    });
  console.log(
    JSON.stringify({
      tools: names,
      results,
      quotedVenue: q.quote.venue,
      chainId: q.chainId,
      executionEnabled: false,
    }),
  );
} finally {
  await client.close();
  rmSync(state, { recursive: true, force: true });
}
