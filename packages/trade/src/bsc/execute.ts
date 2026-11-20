import { bsc } from 'viem/chains';
import type { Hash, PublicClient, WalletClient } from 'viem';
import { TradeError } from '../errors';
import { assertBscClient, assertBscQuote, buildBscSpot, type BscApproval, type BscSpotQuote, type BscTransaction } from './spot';
import { simulateBscSpot } from './simulation';
import { reconcileBscSpot, verifyBscReceipt } from './accounting';

export interface BscExecutionOptions {
  enabled: boolean;
  /** Explicit budget from the simulation the user reviewed. Increasing it requires another review. */
  reviewedMaxGasCostWei: bigint;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  onSubmitted?: (item: { kind: 'approval' | 'swap'; hash: Hash; tx: BscTransaction; replaces?: Hash }) => void;
}
export async function assertBscWallet(client: PublicClient, wallet: WalletClient, quote: BscSpotQuote) {
  assertBscQuote(quote);
  await assertBscClient(client);
  if ((await client.getBlock({ blockNumber: quote.blockNumber })).hash !== quote.blockHash) throw new TradeError('QUOTE_MISMATCH', 'The quote block is no longer canonical');
  const [chainId, addresses] = await Promise.all([wallet.getChainId(), wallet.getAddresses()]);
  if (chainId !== 56 || addresses[0]?.toLowerCase() !== quote.request.trader.toLowerCase()) throw new TradeError('WALLET_CHANGED', 'Wallet account or network changed; request and review a fresh quote');
}

/** Only user-confirmed wallet sends. No server keys, delegation, automatic requoting or send retries. */
const running = new WeakMap<WalletClient, Set<string>>();
export async function executeBscSpot(client: PublicClient, wallet: WalletClient, quote: BscSpotQuote, options: BscExecutionOptions) {
  const key = quote.request.trader.toLowerCase();
  const wallets = running.get(wallet) ?? new Set<string>();
  if (wallets.has(key)) throw new TradeError('QUOTE_MISMATCH', 'A BSC execution is already in progress for this account');
  wallets.add(key); running.set(wallet, wallets);
  try { return await execute(client, wallet, quote, options); }
  finally { wallets.delete(key); }
}
async function execute(client: PublicClient, wallet: WalletClient, quote: BscSpotQuote, options: BscExecutionOptions) {
  if (!options.enabled) throw new TradeError('BSC_TRADING_DISABLED', 'BSC signing is not enabled for this deployment');
  const checkWallet = async () => {
    if (options.signal?.aborted) throw new TradeError('EXECUTION_CANCELLED', 'Execution cancelled; no further transaction will be requested');
    await assertBscWallet(client, wallet, quote);
    assertBscQuote(quote); // Network/account checks may have consumed the last seconds of the quote.
    if (options.signal?.aborted) throw new TradeError('EXECUTION_CANCELLED', 'Execution cancelled; no further transaction will be requested');
  };
  await checkWallet();
  options.onStage?.('Rechecking simulation');
  const proof = await simulateBscSpot(client, quote);
  if (proof.maxGasCostWei > options.reviewedMaxGasCostWei) throw new TradeError('QUOTE_MISMATCH', 'The gas budget increased; simulate and review again');
  const submittedApprovals: { tx: BscApproval; hash: Hash }[] = [];
  for (let i = 0; i < proof.build.approvals.length; i++) {
    const tx = proof.build.approvals[i]!;
    await checkWallet();
    options.onStage?.(tx.amount === 0n ? 'Confirm allowance reset in wallet' : 'Confirm exact token approval in wallet');
    const hash = await wallet.sendTransaction({ chain: bsc, account: quote.request.trader, to: tx.to, data: tx.data, value: 0n,
      gas: proof.approvalGasLimits[i]!, gasPrice: proof.gasPrice, type: 'legacy' });
    options.onSubmitted?.({ kind: 'approval', hash, tx });
    options.onStage?.('Waiting for approval receipt');
    const mined = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
    const actualHash = mined.transactionHash;
    if (actualHash !== hash) options.onSubmitted?.({ kind: 'approval', hash: actualHash, tx, replaces: hash });
    const verified = await verifyBscReceipt(client, tx, actualHash);
    if (verified.receipt.status !== 'success') throw new TradeError('SIMULATION_REVERTED', 'Approval reverted; no swap was submitted');
    submittedApprovals.push({ tx, hash: actualHash });
  }
  // Approvals change chain state. Do not rely on the earlier simulation or silently accept expiry.
  await checkWallet();
  const latest = await simulateBscSpot(client, quote);
  const alreadyBudgeted = proof.approvalGasLimits.reduce((sum, gas) => sum + gas * proof.gasPrice, 0n);
  if (latest.build.approvals.length || latest.maxGasCostWei + alreadyBudgeted > options.reviewedMaxGasCostWei) throw new TradeError('QUOTE_MISMATCH', 'Allowance or gas changed; review the remaining swap again');
  const build = await buildBscSpot(client, quote);
  if (build.approvals.length || build.tx.data !== proof.build.tx.data || build.tx.value !== proof.build.tx.value) throw new TradeError('QUOTE_MISMATCH', 'Reviewed transaction changed');
  await checkWallet();
  options.onStage?.('Confirm BNB swap in wallet');
  const hash = await wallet.sendTransaction({ chain: bsc, account: quote.request.trader, to: build.tx.to, data: build.tx.data, value: build.tx.value,
    gas: latest.swapGasLimit, gasPrice: latest.gasPrice, type: 'legacy' });
  options.onSubmitted?.({ kind: 'swap', hash, tx: build.tx });
  options.onStage?.('Waiting for swap receipt');
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 180_000 });
  const actualHash = receipt.transactionHash;
  if (actualHash !== hash) options.onSubmitted?.({ kind: 'swap', hash: actualHash, tx: build.tx, replaces: hash });
  options.onStage?.('Reconciling canonical receipt');
  const accounting = await reconcileBscSpot(client, quote, actualHash, submittedApprovals);
  return { hash: actualHash, approvals: submittedApprovals, accounting };
}
