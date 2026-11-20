import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, stringToHex, zeroAddress, type Address } from 'viem';
import { recoverMessageAddress } from 'viem';
import { buildMessage } from '@rushr/agents/siwe';
import { FLAP_PORTAL, flapTransaction, type FlapQuote } from '@rushr/trade/bsc/flap';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';
import type { Chain, Quote } from '../src/chain.ts';
import { createWalletFile, loadWallet } from '../src/wallet.ts';
const token = ('0x' + 'a'.repeat(40)) as Address,
  trader = ('0x' + '2'.repeat(40)) as Address;
const secret = 'rk_fixture_do_not_leak',
  dirs: string[] = [],
  clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(request: FlapQuote['request'], quoteAsset: Address = zeroAddress): FlapQuote {
  const quotedAt = Math.floor(Date.now() / 1000);
  const q: Omit<FlapQuote, 'id'> = {
    version: 'flap-2',
    chainId: 56,
    venue: 'flap',
    router: FLAP_PORTAL,
    request,
    quoteToken: quoteAsset,
    quoteDecimals: 18,
    quoteSymbol: quoteAsset === zeroAddress ? 'BNB' : 'QUOTE',
    inputToken: request.side === 'buy' ? zeroAddress : request.token,
    outputToken: request.side === 'buy' ? request.token : quoteAsset,
    nativeToQuoteSwapEnabled: quoteAsset !== zeroAddress,
    tokenDecimals: 18,
    amountOut: 100000n,
    minAmountOut: (100000n * BigInt(10000 - request.slippageBps)) / 10000n,
    quotedAt,
    expiresAt: quotedAt + 60,
    blockNumber: 1n,
    blockHash: ('0x' + '1'.repeat(64)) as `0x${string}`,
    feeTier: null,
    priceImpactBps: null,
    platformFeeBps: 0,
  };
  return {
    ...q,
    id: keccak256(
      stringToHex(JSON.stringify(q, (_, v) => (typeof v === 'bigint' ? v.toString() : v))),
    ),
  };
}
async function connect(
  options: {
    rpcChain?: number;
    apiChain?: number;
    challengeChain?: number;
    challengeDomain?: string;
    blocked?: boolean;
    wallet?: boolean;
    simulationFails?: boolean;
    stale?: boolean;
    quoteExpired?: boolean;
    quoteAsset?: Address;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'clashr-mcp-test-'));
  dirs.push(dir);
  const config = loadConfig({ CLASHR_STATE_DIR: dir });
  if (options.wallet) createWalletFile(config.walletFile);
  const calls: { path: string; auth: string | null }[] = [];
  const chain: Chain = {
    chainId: vi.fn(async () => options.rpcChain ?? 56),
    balance: vi.fn(async () => 10n ** 18n),
    quote: vi.fn(async (request) => {
      const q = fixture(request, options.quoteAsset);
      if (options.quoteExpired) {
        q.quotedAt -= 120;
        q.expiresAt -= 120;
      }
      return q;
    }),
    simulate: vi.fn(async (q: Quote) => {
      if (options.simulationFails) throw Error('RPC secret https://provider/PRIVATE_TOKEN');
      return {
        chainId: 56 as const,
        quoteId: q.id,
        simulatedAt: Math.floor(Date.now() / 1000),
        tokenDelta: 100000n,
        nativeDelta: -q.request.amountIn,
        quoteDelta: null,
        gasPrice: 1n,
        swapGasLimit: 100000n,
        approvalGasLimits: [],
        maxGasCostWei: 100000n,
        platformFeeWei: 0n as const,
        build: { quote: q as FlapQuote, tx: flapTransaction(q as FlapQuote), approvals: [] },
      };
    }),
  };
  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(String(input)),
      body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path: u.pathname, auth: new Headers(init?.headers).get('authorization') });
    let data: unknown;
    if (u.pathname === '/health')
      data = { ok: true, chainId: options.apiChain ?? 56, product: 'bnb' };
    else if (u.pathname === '/v1/auth/nonce') {
      const message = buildMessage({
        purpose: u.searchParams.get('purpose') as 'register' | 'login',
        address: u.searchParams.get('address')!,
        nonce: 'testNonce1234',
        issuedAt: new Date(),
        identity: {
          chainId: options.challengeChain ?? 56,
          domain: options.challengeDomain ?? 'localhost:3000',
          uri: 'http://localhost:3000',
          termsUrl: 'http://localhost:3000/terms',
        },
      });
      data = { message, nonce: 'testNonce1234' };
    } else if (u.pathname === '/v1/agents/register' || u.pathname === '/v1/agents/login') {
      const address = await recoverMessageAddress({
        message: body.message,
        signature: body.signature,
      });
      data = {
        member: {
          kind: 'agent',
          wallet: address.toLowerCase(),
          handle: body.handle ?? 'fixture',
          id: 'm_fixture',
        },
        apiKey: { key: secret, id: 'k_fixture' },
      };
    } else if (u.pathname === '/v1/agents/me')
      data = { member: { handle: 'fixture', kind: 'agent' } };
    else if (u.pathname.endsWith('/safety'))
      data = { chainId: 56, safety: { blocked: options.blocked ?? false, riskLevel: 'unknown' } };
    else if (u.pathname === '/flap/market')
      data = {
        chainId: 56,
        provenance: 'finalized-onchain',
        stale: options.stale ?? false,
        cursor: '1',
        items: [
          { chainId: 56, coin: { address: token }, listed: false, progress: 1 },
          { chainId: 56, coin: { address: token }, listed: false, progress: 60 },
          { chainId: 56, coin: { address: token }, listed: true, progress: 100 },
        ],
      };
    else data = { items: [] };
    return Response.json(data, { headers: { 'x-rushr-chain-id': String(options.apiChain ?? 56) } });
  };
  const { server } = createServer(config, { chain, fetch: fetcher });
  const client = new Client({ name: 'test', version: '1' });
  clients.push(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).not.toContain(secret);
    expect(text).not.toContain('PRIVATE_TOKEN');
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { code: 'mcp_schema_error', message: text } };
    }
    return { error: !!result.isError, data };
  };
  return { client, call, chain, calls, config };
}
const request = { token, trader, side: 'buy', amountIn: '1000000000000000', venue: 'flap' };
describe('Clashr MCP protocol and chain isolation', () => {
  it('exposes first-milestone tools without buy/sell or transaction signing', async () => {
    const { client, call } = await connect();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(
      [
        'my_status',
        'create_wallet',
        'register',
        'scan',
        'token',
        'feed',
        'leaderboard',
        'quote',
        'dry_run',
      ].sort(),
    );
    expect((await call('my_status')).data).toMatchObject({
      chainId: 56,
      wallet: null,
      dryRun: true,
      transactionsEnabled: false,
    });
  });
  it('filters each trenches column and preserves stale/unknown data', async () => {
    const { call } = await connect({ stale: true });
    for (const column of ['new', 'almost', 'migrated'])
      expect((await call('scan', { column })).data).toMatchObject({
        stale: true,
        items: expect.any(Array),
      });
    expect((await call('scan', { column: 'almost' })).data.items).toHaveLength(1);
    expect((await call('token', { address: token })).data.safety.riskLevel).toBe('unknown');
    expect((await call('feed')).error).toBe(false);
    expect((await call('leaderboard')).error).toBe(false);
  });
  it('rejects a legacy API before fetching market data', async () => {
    const { call, calls } = await connect({ apiChain: 4663 });
    expect((await call('scan')).data.error.code).toBe('wrong_api_chain');
    expect(calls).toHaveLength(1);
  });
  it('rejects a legacy RPC before quoting', async () => {
    const { call, chain } = await connect({ rpcChain: 4663 });
    expect((await call('quote', request)).data.error.code).toBe('wrong_rpc_chain');
    expect(chain.quote).not.toHaveBeenCalled();
  });
  it('quotes and simulates a session-bound immutable quote without signing or broadcasting', async () => {
    const { call, chain } = await connect();
    const quote = await call('quote', request);
    expect(quote.error).toBe(false);
    const result = await call('dry_run', { quoteId: quote.data.quote.id });
    expect(result.data).toMatchObject({ dryRun: true, signed: false, broadcast: false });
    expect(result.data.simulation.build.tx.value).toBe(request.amountIn);
    expect(chain.simulate).toHaveBeenCalledOnce();
  });
  it('preserves ERC20 settlement on Flap sells instead of labelling the output BNB', async () => {
    const asset = ('0x' + 'b'.repeat(40)) as Address,
      { call } = await connect({ quoteAsset: asset });
    const sell = await call('quote', { ...request, side: 'sell' });
    expect(sell.error).toBe(false);
    expect(sell.data.outputAsset).toBe(asset);
    expect(sell.data.quote.quoteSymbol).toBe('QUOTE');
  });
  it('enforces buy caps, positive raw integers, unknown IDs, blocked tokens and expiry', async () => {
    const { call, chain } = await connect();
    expect(
      (await call('quote', { ...request, amountIn: '30000000000000000' })).data.error.code,
    ).toBe('buy_cap');
    expect((await call('quote', { ...request, amountIn: '0' })).error).toBe(true);
    expect((await call('dry_run', { quoteId: '0x' + '9'.repeat(64) })).data.error.code).toBe(
      'quote_not_found',
    );
    expect(chain.simulate).not.toHaveBeenCalled();
    const blocked = await connect({ blocked: true });
    expect((await blocked.call('quote', request)).data.error.code).toBe('blocked_token');
    expect(blocked.chain.quote).not.toHaveBeenCalled();
    const expired = await connect({ quoteExpired: true });
    expect((await expired.call('quote', request)).error).toBe(true);
  });
  it('does not leak provider credentials when a real-balance simulation fails', async () => {
    const { call } = await connect({ simulationFails: true });
    const q = await call('quote', request);
    const r = await call('dry_run', { quoteId: q.data.quote.id });
    expect(r.error).toBe(true);
    expect(r.data.error.code).toBe('request_failed');
  });
  it('creates a separate wallet, verifies a real SIWE signature, and stores only an API-bound registration locally', async () => {
    const { call, config, calls } = await connect();
    const wallet = await call('create_wallet');
    expect(wallet.error).toBe(false);
    const before = readFileSync(config.walletFile, 'utf8');
    expect((await call('create_wallet')).error).toBe(true);
    expect(readFileSync(config.walletFile, 'utf8')).toBe(before);
    expect((await call('register', { handle: 'fixture' })).data.status).toBe('registered');
    const stored = JSON.parse(readFileSync(config.walletFile, 'utf8'));
    expect(stored.apiKey).toBe(secret);
    expect(stored.apiOrigin).toBe(config.apiUrl);
    expect(stored.chainId).toBe(56);
    expect(
      loadWallet(config.walletFile, 'https://another-owned-api.example')?.apiKey(),
    ).toBeUndefined();
    expect((await call('register', { handle: 'fixture' })).data.status).toBe('already_registered');
    expect(calls.find((c) => c.path === '/v1/agents/me')?.auth).toBe(`Bearer ${secret}`);
  });
  it.each([{ challengeChain: 4663 }, { challengeDomain: 'evil.example' }])(
    'rejects foreign SIWE before signing/registering: %j',
    async (options) => {
      const { call, calls } = await connect({ ...options, wallet: true });
      expect((await call('register', { handle: 'fixture' })).data.error.code).toBe(
        'invalid_challenge',
      );
      expect(calls.some((c) => c.path === '/v1/agents/register')).toBe(false);
    },
  );
  it('rejects a supplied trader different from the configured wallet', async () => {
    const { call, chain } = await connect({ wallet: true });
    expect((await call('quote', request)).data.error.code).toBe('wrong_trader');
    expect(chain.quote).not.toHaveBeenCalled();
  });
});
describe('local configuration', () => {
  it('rejects enabling execution, legacy origins, credentials in API URLs and excessive slippage', () => {
    for (const env of [
      { CLASHR_DRY_RUN: '0' },
      { CLASHR_API_URL: 'https://api.rushr.trade' },
      { CLASHR_API_URL: 'https://user:password@example.com' },
      { CLASHR_SLIPPAGE_BPS: '501' },
    ])
      expect(() => loadConfig(env)).toThrow();
    expect(loadConfig({ RUSHR_PRIVATE_KEY: 'do-not-reuse' }).walletFile).not.toContain('.rushr');
  });
});
