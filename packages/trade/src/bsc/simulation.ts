import { decodeFunctionResult, encodeFunctionData, type PublicClient } from 'viem';
import { simulateCalls, NATIVE_TRANSFER_EMITTER, type SimCall } from '../simulate';
import { TradeError } from '../errors';
import { BSC_ERC20_ABI, BSC_V3_ROUTER_ABI } from './abi';
import { assertBscClient, assertBscQuote, buildBscSpot, type BscSpotBuild, type BscSpotQuote } from './spot';

export interface BscSpotSimulation {
  quoteId: string;
  chainId: 56;
  simulatedAt: number;
  tokenDelta: bigint;
  nativeDelta: bigint;
  gasPrice: bigint;
  swapGasLimit: bigint;
  approvalGasLimits: bigint[];
  maxGasCostWei: bigint;
  platformFeeWei: 0n;
  build: BscSpotBuild;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const gasLimit = (gas: bigint) => {
  if (gas <= 0n || gas > 5_000_000n) throw new TradeError('SIMULATION_REVERTED', 'Simulated gas exceeds the transaction budget');
  return (gas * 130n + 99n) / 100n;
};

/** Stateful approvals + swap + wallet balance probes. No fake funding, approvals or balance overrides. */
export async function simulateBscSpot(client: PublicClient, quote: BscSpotQuote, now = Math.floor(Date.now() / 1000)): Promise<BscSpotSimulation> {
  assertBscQuote(quote, now);
  await assertBscClient(client);
  const accountCode = await client.getBytecode({ address: quote.request.trader });
  if (accountCode && accountCode !== '0x') throw new TradeError('CONFIG_INVALID', 'This direct signing flow supports EOA wallets only; contract/delegated wallets require a separate adapter');
  const build = await buildBscSpot(client, quote, now);
  const { trader, token, side, amountIn } = quote.request;
  const balanceCall: SimCall = { from: trader, to: token,
    data: encodeFunctionData({ abi: BSC_ERC20_ABI, functionName: 'balanceOf', args: [trader] }), label: 'wallet token balance' };
  const approvals: SimCall[] = build.approvals.map(a => ({ from: trader, to: a.to, data: a.data, value: 0n, label: `approve ${a.amount}` }));
  const calls: SimCall[] = [balanceCall, ...approvals, { from: trader, to: build.tx.to, data: build.tx.data, value: build.tx.value, label: 'BSC swap' }, balanceCall];
  const [result, gasPrice, nativeBalance] = await Promise.all([simulateCalls(client, calls), client.getGasPrice(), client.getBalance({ address: trader })]);
  if (result.calls.length !== calls.length || !result.ok) throw new TradeError('SIMULATION_REVERTED', 'The complete BSC approval/swap sequence did not simulate successfully');
  for (let i = 0; i < approvals.length; i++) {
    const data = result.calls[i + 1]!.returnData;
    // Optional-return ERC20s are allowed, explicit approve(false) is not.
    if (data !== '0x' && !decodeFunctionResult({ abi: BSC_ERC20_ABI, functionName: 'approve', data })) throw new TradeError('SIMULATION_REVERTED', 'Token approval returned false');
  }
  const before = decodeFunctionResult({ abi: BSC_ERC20_ABI, functionName: 'balanceOf', data: result.calls[0]!.returnData });
  const after = decodeFunctionResult({ abi: BSC_ERC20_ABI, functionName: 'balanceOf', data: result.calls.at(-1)!.returnData });
  const tokenDelta = after - before;
  const swapIndex = 1 + approvals.length;
  const nativeTransfers = result.transfers.filter(t => t.callIndex === swapIndex && same(t.token, NATIVE_TRANSFER_EMITTER));
  const nativeDelta = nativeTransfers.reduce((sum, t) => sum + (same(t.to, trader) ? t.value : 0n) - (same(t.from, trader) ? t.value : 0n), 0n);
  if (side === 'buy') {
    if (tokenDelta < quote.minAmountOut || nativeDelta >= 0n || -nativeDelta > amountIn) throw new TradeError('SLIPPAGE_EXCEEDED', 'Simulated wallet output or native spending violates the quote');
    if (quote.venue === 'pancake-v3') {
      const returns = decodeFunctionResult({ abi: BSC_V3_ROUTER_ABI, functionName: 'multicall', data: result.calls[swapIndex]!.returnData });
      const nominal = decodeFunctionResult({ abi: BSC_V3_ROUTER_ABI, functionName: 'exactInputSingle', data: returns[0]! });
      if (nominal !== tokenDelta) throw new TradeError('TAX_TOO_HIGH', 'Transfer-tax/rebasing outputs are not supported by the v3 adapter');
    }
  } else if (tokenDelta !== -amountIn || nativeDelta < quote.minAmountOut) {
    throw new TradeError('SLIPPAGE_EXCEEDED', 'Simulated token debit or BNB credit violates the quote');
  }
  if (gasPrice <= 0n) throw new TradeError('RPC_ERROR', 'BSC gas price is unavailable');
  const approvalGasLimits = approvals.map((_, i) => gasLimit(result.calls[i + 1]!.gasUsed));
  const swapGasLimit = gasLimit(result.calls[swapIndex]!.gasUsed);
  const maxGasCostWei = (swapGasLimit + approvalGasLimits.reduce((sum, g) => sum + g, 0n)) * gasPrice;
  if (nativeBalance < maxGasCostWei + build.tx.value) throw new TradeError('INSUFFICIENT_FUNDS', 'BNB balance must cover the input and all approval/swap gas budgets');
  return { quoteId: quote.id, chainId: 56, simulatedAt: now, tokenDelta, nativeDelta, gasPrice, swapGasLimit,
    approvalGasLimits, maxGasCostWei, platformFeeWei: 0n, build };
}
