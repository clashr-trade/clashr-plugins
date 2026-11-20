import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEther } from 'viem';

export class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface Config {
  apiUrl: string;
  rpcUrl: string;
  productOrigin: string;
  walletFile: string;
  maxBuyWei: bigint;
  slippageBps: number;
}
export function checkedUrl(raw: string, name: string, originOnly = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Refusal('config_invalid', `Configure ${name} with an owned endpoint`);
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (!['https:'].includes(url.protocol) &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    /(^|\.)rushr\.trade$/i.test(url.hostname) ||
    (originOnly && (url.pathname !== '/' || url.search))
  )
    throw new Refusal(
      'config_invalid',
      `${name} must use HTTPS (HTTP is allowed only on loopback), without user credentials or a legacy Rushr origin`,
    );
  return originOnly ? url.origin : url.href;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.CLASHR_DRY_RUN !== undefined && env.CLASHR_DRY_RUN !== '1')
    throw new Refusal('live_execution_disabled', 'This milestone supports CLASHR_DRY_RUN=1 only');
  const apiUrl = checkedUrl(env.CLASHR_API_URL ?? 'http://127.0.0.1:8790', 'CLASHR_API_URL', true);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(apiUrl).hostname);
  const productOrigin = checkedUrl(
    env.CLASHR_PRODUCT_ORIGIN ?? (local ? 'http://localhost:3000' : ''),
    'CLASHR_PRODUCT_ORIGIN',
    true,
  );
  const rpcUrl = checkedUrl(
    env.CLASHR_RPC_URL ?? env.BSC_RPC_URL ?? 'https://bsc-dataseed.bnbchain.org',
    'CLASHR_RPC_URL',
  );
  let maxBuyWei: bigint;
  try {
    maxBuyWei = parseEther(env.CLASHR_MAX_BUY_BNB ?? '0.02');
  } catch {
    throw new Refusal('config_invalid', 'CLASHR_MAX_BUY_BNB must be a positive BNB amount');
  }
  if (maxBuyWei <= 0n) throw new Refusal('config_invalid', 'CLASHR_MAX_BUY_BNB must be positive');
  const slippageBps = Number(env.CLASHR_SLIPPAGE_BPS ?? 100);
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 500)
    throw new Refusal('config_invalid', 'CLASHR_SLIPPAGE_BPS must be 1..500');
  return {
    apiUrl,
    rpcUrl,
    productOrigin,
    walletFile:
      env.CLASHR_WALLET_FILE ??
      join(env.CLASHR_STATE_DIR ?? join(homedir(), '.clashr'), 'agent-wallet.json'),
    maxBuyWei,
    slippageBps,
  };
}
