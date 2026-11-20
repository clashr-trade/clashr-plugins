import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const artifact = join(root, 'dist/clashr-plugin-marketplace');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('packaged Claude/Codex/Cursor plugin', () => {
  let dir: string, plugin: string, url: string;
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-rushr-chain-id', '56');
      res.end(JSON.stringify({ ok: true, chainId: 56, product: 'bnb' }));
      return;
    }
    if (req.url === '/rpc') {
      const b = JSON.parse(Buffer.concat(chunks).toString());
      const reply = (row: any) => ({
        jsonrpc: '2.0',
        id: row.id,
        result: row.method === 'eth_chainId' ? '0x38' : '0xde0b6b3a7640000',
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(b) ? b.map(reply) : reply(b)));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  beforeAll(async () => {
    // Build is an explicit test prerequisite; never run an implicit registry installer.
    const info = json(join(artifact, 'build-info.json'));
    dir = mkdtempSync(join(tmpdir(), 'clashr plugin relocation '));
    execFileSync('tar', [
      '-xzf',
      join(root, `dist/clashr-plugin-marketplace-${info.version}.tgz`),
      '-C',
      dir,
    ]);
    plugin = join(dir, 'plugins/clashr');
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  it('ships matching manifests, client-specific roots, catalogs, assets and exact file hashes', () => {
    const info = json(join(dir, 'build-info.json')),
      portable = json(join(plugin, 'plugin.json')),
      claude = json(join(plugin, '.claude-plugin/plugin.json'));
    expect(portable.name).toBe('clashr');
    expect(portable.version).toBe(claude.version);
    expect(info.version).toBe(portable.version);
    for (const catalog of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json'])
      expect(json(join(dir, catalog)).name).toBe('mcp');
    expect(json(join(dir, '.agents/plugins/marketplace.json')).plugins[0].source.path).toBe(
      './plugins/clashr',
    );
    expect(json(join(dir, '.claude-plugin/marketplace.json')).plugins[0].source).toBe(
      './plugins/clashr',
    );
    expect(json(join(plugin, 'mcp.json')).mcpServers.clashr.args).toEqual([
      '${PLUGIN_ROOT}/scripts/start.mjs',
    ]);
    expect(json(join(plugin, '.mcp.json')).mcpServers.clashr.args).toEqual([
      '${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs',
    ]);
    for (const [path, hash] of Object.entries(info.files)) {
      expect(resolve(plugin, path).startsWith(plugin)).toBe(true);
      expect(
        createHash('sha256')
          .update(readFileSync(join(plugin, path)))
          .digest('hex'),
      ).toBe(hash);
      expect(path).not.toMatch(/(^|\/)(?:node_modules|\.env|agent-wallet|mcp\.env)/);
    }
    expect(info.files['runtime/server.mjs']).toBeTruthy();
    expect(info.files['assets/icon.png']).toBeTruthy();
    expect(info.files['skills/clashr/SKILL.md']).toBeTruthy();
    expect(readdirSync(plugin)).not.toContain('node_modules');
    const cursor = join(dir, 'plugins/clashr-cursor');
    expect(json(join(dir, '.cursor-plugin/marketplace.json')).plugins[0].source).toBe('./plugins/clashr-cursor');
    expect(json(join(cursor, '.cursor-plugin/plugin.json')).mcpServers).toBe('./mcp.json');
    expect(json(join(cursor, 'mcp.json')).mcpServers.clashr.args).toEqual(['${CURSOR_PLUGIN_ROOT}/scripts/start.mjs']);
    expect(info.cursorFiles['runtime/server.mjs']).toBe(info.files['runtime/server.mjs']);
    for (const [path, hash] of Object.entries(info.cursorFiles))
      expect(createHash('sha256').update(readFileSync(join(cursor, path))).digest('hex')).toBe(hash);
  });
  it.each(['mcp.json', '.mcp.json', 'cursor'])(
    'launches %s after archive extraction, with no project dependencies and a path containing spaces',
    async (name) => {
      const state = join(dir, `${name} state`);
      mkdirSync(state, { recursive: true });
      const config = join(state, 'local.env');
      writeFileSync(
        config,
        `CLASHR_API_URL=${url}\nCLASHR_PRODUCT_ORIGIN=http://localhost:3000\nCLASHR_RPC_URL=${url}/rpc\nCLASHR_STATE_DIR="${state.replaceAll('\\', '/')}"\nCLASHR_MAX_BUY_BNB=0.005\nCLASHR_DRY_RUN=0\nNODE_OPTIONS=--this-must-not-be-executed\n`,
      );
      const installedPlugin = name === 'cursor' ? join(dir, 'plugins/clashr-cursor') : plugin;
      const definition = json(join(installedPlugin, name === 'cursor' ? 'mcp.json' : name)).mcpServers.clashr;
      const args = definition.args.map((a: string) =>
        a.replace('${PLUGIN_ROOT}', installedPlugin).replace('${CLAUDE_PLUGIN_ROOT}', installedPlugin).replace('${CURSOR_PLUGIN_ROOT}', installedPlugin),
      );
      const env = {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        USERPROFILE: process.env.USERPROFILE ?? '',
        HOME: process.env.HOME ?? '',
        ...definition.env,
        CLASHR_CONFIG_FILE: config,
      };
      const transport = new StdioClientTransport({
        command: process.execPath,
        args,
        env,
        cwd: dir,
        stderr: 'pipe',
      });
      let stderr = '';
      transport.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const client = new Client({ name: 'plugin-relocation-test', version: '1' });
      try {
        await client.connect(transport);
        expect(client.getServerVersion()?.name).toBe('clashr');
        expect((await client.listTools()).tools.map((t) => t.name)).not.toEqual(
          expect.arrayContaining(['buy', 'sell']),
        );
        const result = await client.callTool({ name: 'create_wallet', arguments: {} });
        expect(result.isError).not.toBe(true);
        const status = await client.callTool({ name: 'my_status', arguments: {} });
        const data = JSON.parse((status.content as { text: string }[])[0]!.text);
        expect(data).toMatchObject({
          chainId: 56,
          dryRun: true,
          transactionsEnabled: false,
          maxBuyBnb: '0.005',
          balanceBnb: '1',
        });
        expect(JSON.stringify(data) + stderr).not.toContain('privateKey');
        const key = json(join(state, 'agent-wallet.json')).privateKey;
        expect(JSON.stringify(data) + stderr).not.toContain(key);
      } finally {
        await client.close();
      }
    },
  );
});
