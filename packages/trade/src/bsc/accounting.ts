import { decodeEventLog, decodeFunctionData, parseAbi, type Address, type Hash, type PublicClient, type TransactionReceipt } from 'viem';
import { PANCAKE_V2, PANCAKE_V3 } from '@rushr/core/chain/pancake';
import { TradeError } from '../errors';
import { BSC_ERC20_ABI, BSC_SPOT } from './abi';
import { assertBscClient, assertBscQuote, bscSwapTransaction, type BscApproval, type BscSpotQuote, type BscTransaction } from './spot';

const TRANSFER = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const WRAPPED = parseAbi(['event Deposit(address indexed dst,uint256 wad)', 'event Withdrawal(address indexed src,uint256 wad)']);
const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();
export interface BscGasRecord { hash: Hash; nonce: number; block: bigint; blockHash: Hash; status: 'success' | 'reverted'; gasUsed: bigint; effectiveGasPrice: bigint; feeWei: bigint; asset: 'BNB'; finality: 'mined' | 'finalized' }
export interface BscSpotAccounting {
  chainId: 56; trader: Address; token: Address; side: 'buy' | 'sell'; quoteId: string;
  provenance: 'canonical-receipt-events'; hash: Hash; finality: 'mined' | 'finalized';
  actualTokenAmount: bigint; actualNativeAmount: bigint; meetsMinimum: boolean;
  platformFeeWei: 0n; networkFeeWei: bigint; networkFeeAsset: 'BNB'; usd: null; pnl: null;
  transactions: BscGasRecord[];
}

/** Receipt hash/from/to/calldata/value AND canonical block must match the reviewed transaction. */
export async function verifyBscReceipt(client: PublicClient, expected: BscTransaction, hash: Hash): Promise<{ receipt: TransactionReceipt; gas: BscGasRecord }> {
  await assertBscClient(client);
  const [transaction, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  if (!Number.isInteger(transaction.nonce) || transaction.nonce < 0 || typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber < 0n) throw new TradeError('RPC_ERROR', 'A mined transaction nonce and block number are required');
  if (expected.chainId !== 56 || transaction.chainId !== 56 || transaction.hash !== hash || receipt.transactionHash !== hash || !same(transaction.from, expected.account)
    || !same(receipt.from, expected.account) || !same(transaction.to, expected.to) || !same(receipt.to, expected.to)
    || transaction.input !== expected.data || transaction.value !== expected.value || transaction.blockHash !== receipt.blockHash
    || transaction.blockNumber !== receipt.blockNumber) throw new TradeError('QUOTE_MISMATCH', 'Submitted transaction does not match the reviewed BSC transaction');
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash) throw new TradeError('QUOTE_MISMATCH', 'Transaction receipt is no longer canonical');
  let finality: 'mined' | 'finalized' = 'mined';
  try { if ((await client.getBlock({ blockTag: 'finalized' })).number >= receipt.blockNumber) finality = 'finalized'; } catch { /* Never infer finality from confirmation depth. */ }
  if (receipt.gasUsed <= 0n || receipt.effectiveGasPrice <= 0n || !['success','reverted'].includes(receipt.status)) throw new TradeError('RPC_ERROR', 'Receipt status or gas accounting is unavailable');
  return { receipt, gas: { hash, nonce: transaction.nonce, block: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status,
    gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, feeWei: receipt.gasUsed * receipt.effectiveGasPrice, asset: 'BNB', finality } };
}

/** Native fill is proven by the known WBNB router deposit/withdrawal, not ETH pricing or pool-sender guesses. */
export async function reconcileBscSpot(client: PublicClient, quote: BscSpotQuote, hash: Hash, approvals: { tx: BscApproval; hash: Hash }[] = []): Promise<BscSpotAccounting> {
  assertBscQuote(quote, quote.quotedAt); // Receipt recovery remains valid after quote expiry; it never authorizes signing.
  const swap = await verifyBscReceipt(client, bscSwapTransaction(quote, quote.quotedAt), hash);
  const records = [swap.gas];
  if (approvals.length > 2) throw new TradeError('QUOTE_MISMATCH', 'At most a reset and exact approval belong to this swap');
  const hashes = new Set<Hash>([hash]);
  for (const approval of approvals) {
    const decoded = decodeFunctionData({ abi: BSC_ERC20_ABI, data: approval.tx.data });
    if (hashes.has(approval.hash) || !same(approval.tx.to, quote.request.token) || !same(approval.tx.spender, quote.router)
      || !same(approval.tx.account, quote.request.trader) || approval.tx.value !== 0n
      || decoded.functionName !== 'approve' || !same(decoded.args[0], quote.router) || decoded.args[1] !== approval.tx.amount
      || (approval.tx.amount !== 0n && approval.tx.amount !== quote.request.amountIn)) throw new TradeError('QUOTE_MISMATCH', 'Invalid approval accounting identity');
    const record = await verifyBscReceipt(client, approval.tx, approval.hash);
    if (record.gas.nonce >= swap.gas.nonce || record.gas.block > swap.gas.block) throw new TradeError('QUOTE_MISMATCH', 'Approval does not precede the swap');
    records.push(record.gas); hashes.add(approval.hash);
  }
  if (swap.receipt.status !== 'success') return { chainId: 56, trader: quote.request.trader, token: quote.request.token, side: quote.request.side,
    quoteId: quote.id, provenance: 'canonical-receipt-events', hash, finality: swap.gas.finality, actualTokenAmount: 0n, actualNativeAmount: 0n,
    meetsMinimum: false, platformFeeWei: 0n, networkFeeWei: records.reduce((sum, r) => sum + r.feeWei, 0n), networkFeeAsset: 'BNB', usd: null, pnl: null, transactions: records };
  let tokenDelta = 0n, native = 0n, poolSwap = false;
  const routePools=quote.route?.pools??[quote.pool],seenPools=new Set<string>();
  for (const log of swap.receipt.logs) {
    if (same(log.address, quote.request.token)) {
      try {
        const { args } = decodeEventLog({ abi: TRANSFER, eventName: 'Transfer', data: log.data, topics: log.topics as never });
        tokenDelta += (same(args.to, quote.request.trader) ? args.value : 0n) - (same(args.from, quote.request.trader) ? args.value : 0n);
      } catch { /* Not a standard token transfer. */ }
    }
    if (same(log.address, BSC_SPOT.wrappedNative)) {
      try {
        if (quote.request.side === 'buy') {
          const { args } = decodeEventLog({ abi: WRAPPED, eventName: 'Deposit', data: log.data, topics: log.topics as never });
          if (same(args.dst, quote.router)) native += args.wad;
        } else {
          const { args } = decodeEventLog({ abi: WRAPPED, eventName: 'Withdrawal', data: log.data, topics: log.topics as never });
          if (same(args.src, quote.router)) native += args.wad;
        }
      } catch { /* Not the relevant wrapped-native event. */ }
    }
    if (routePools.some(pool=>same(log.address,pool))) {
      try {
        decodeEventLog({ abi: quote.venue === 'pancake-v2' ? PANCAKE_V2 : PANCAKE_V3, eventName: 'Swap', data: log.data, topics: log.topics as never });
        poolSwap = true;
        seenPools.add(log.address.toLowerCase());
      } catch { /* Wrong venue event. */ }
    }
  }
  const actualTokenAmount = quote.request.side === 'buy' ? tokenDelta : -tokenDelta;
  if (!poolSwap || !routePools.every(pool=>seenPools.has(pool.toLowerCase())) || native <= 0n || actualTokenAmount <= 0n || (quote.request.side === 'buy' && native > quote.request.amountIn)) throw new TradeError('QUOTE_MISMATCH', 'Receipt does not prove the expected token/native pool execution');
  return { chainId: 56, trader: quote.request.trader, token: quote.request.token, side: quote.request.side, quoteId: quote.id,
    provenance: 'canonical-receipt-events', hash, finality: swap.gas.finality, actualTokenAmount, actualNativeAmount: native,
    meetsMinimum: quote.request.side === 'buy' ? actualTokenAmount >= quote.minAmountOut : native >= quote.minAmountOut,
    platformFeeWei: 0n, networkFeeWei: records.reduce((sum, r) => sum + r.feeWei, 0n), networkFeeAsset: 'BNB', usd: null, pnl: null, transactions: records };
}
