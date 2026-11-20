import { encodeFunctionData, isAddress, keccak256, stringToHex, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { PANCAKE_V2, PANCAKE_V3 } from '@rushr/core/chain/pancake';
import { TradeError } from '../errors';
import { BSC_ERC20_ABI, BSC_POOL_ABI, BSC_QUOTER_ABI, BSC_SPOT, BSC_V2_ROUTER_ABI, BSC_V3_ROUTER_ABI, V3_FEES } from './abi';

export interface BscSpotRequest {
  chainId: 56;
  side: 'buy' | 'sell';
  token: Address;
  trader: Address;
  amountIn: bigint;
  slippageBps: number;
}
export interface BscSpotQuote {
  id: Hex;
  version: typeof BSC_SPOT.version;
  chainId: 56;
  request: BscSpotRequest;
  venue: 'pancake-v2' | 'pancake-v3';
  pool: Address;
  router: Address;
  feeTier: number | null;
  /** Difference from the marginal pool rate, including venue fees. Capped at 5% in this adapter. */
  priceImpactBps: number;
  tokenDecimals: number;
  amountOut: bigint;
  minAmountOut: bigint;
  blockNumber: bigint;
  blockHash: Hex;
  quotedAt: number;
  expiresAt: number;
  /** Direct venue execution collects no Rushr/referral fee. Never inherit ETH fee policy. */
  platformFeeBps: 0;
  /** Optional v2 route through the allowlisted BSC USDT bridge. Absent on existing direct quotes. */
  route?: {path:Address[];pools:Address[]};
}
export interface BscTransaction { chainId: 56; account: Address; to: Address; data: Hex; value: bigint }
export interface BscApproval extends BscTransaction { amount: bigint; spender: Address }
export interface BscSpotBuild { quote: BscSpotQuote; tx: BscTransaction; approvals: BscApproval[] }
const lc = (a: string) => a.toLowerCase() as Address;
const same = (a: string, b: string) => lc(a) === lc(b);
const uintMax = (1n << 256n) - 1n;
export const BSC_USDT_BRIDGE='0x55d398326f99059ff775485246999027b3197955' as const;

export async function assertBscClient(client: PublicClient) {
  if (client.chain?.id !== 56 || await client.getChainId() !== 56) throw new TradeError('UNSUPPORTED_CHAIN', 'An explicitly configured BSC mainnet client and provider are required');
}
export function validateBscRequest(request: BscSpotRequest): BscSpotRequest {
  if (request.chainId !== 56) throw new TradeError('UNSUPPORTED_CHAIN', 'Only BSC mainnet is supported');
  if (!['buy', 'sell'].includes(request.side) || typeof request.amountIn !== 'bigint' || request.amountIn <= 0n || request.amountIn > uintMax) throw new TradeError('INVALID_AMOUNT', 'A positive raw input amount and buy/sell side are required');
  if (!isAddress(request.token, { strict: false }) || !isAddress(request.trader, { strict: false }) || same(request.token, zeroAddress) || same(request.trader, zeroAddress)) throw new TradeError('CONFIG_INVALID', 'Invalid token or signing account');
  if (same(request.token, BSC_SPOT.wrappedNative)) throw new TradeError('SAME_TOKEN', 'Wrapping BNB is not a spot swap');
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 1 || request.slippageBps > 500) throw new TradeError('INVALID_SLIPPAGE', 'BSC slippage must be 1..500 bps');
  return { ...request, token: lc(request.token), trader: lc(request.trader) };
}

/** Known addresses AND deployed immutable bindings, pinned to the quote block. */
export async function verifyBscDeployments(client: PublicClient, blockNumber: bigint) {
  const contracts = [BSC_SPOT.v2Factory, BSC_SPOT.v3Factory, BSC_SPOT.wrappedNative, BSC_SPOT.v2Router, BSC_SPOT.v3Router, BSC_SPOT.v3Quoter];
  const codes = await Promise.all(contracts.map(address => client.getBytecode({ address, blockNumber })));
  if (codes.some(code => !code || code === '0x')) throw new TradeError('CONFIG_INVALID', 'A required BSC venue contract has no deployed code');
  const [v2Factory, v2Native, v3Factory, v3Native, v3Deployer, qFactory, qNative, qDeployer] = await Promise.all([
    client.readContract({ address: BSC_SPOT.v2Router, abi: BSC_V2_ROUTER_ABI, functionName: 'factory', blockNumber }),
    client.readContract({ address: BSC_SPOT.v2Router, abi: BSC_V2_ROUTER_ABI, functionName: 'WETH', blockNumber }),
    client.readContract({ address: BSC_SPOT.v3Router, abi: BSC_V3_ROUTER_ABI, functionName: 'factory', blockNumber }),
    client.readContract({ address: BSC_SPOT.v3Router, abi: BSC_V3_ROUTER_ABI, functionName: 'WETH9', blockNumber }),
    client.readContract({ address: BSC_SPOT.v3Router, abi: BSC_V3_ROUTER_ABI, functionName: 'deployer', blockNumber }),
    client.readContract({ address: BSC_SPOT.v3Quoter, abi: BSC_QUOTER_ABI, functionName: 'factory', blockNumber }),
    client.readContract({ address: BSC_SPOT.v3Quoter, abi: BSC_QUOTER_ABI, functionName: 'WETH9', blockNumber }),
    client.readContract({ address: BSC_SPOT.v3Quoter, abi: BSC_QUOTER_ABI, functionName: 'deployer', blockNumber }),
  ]);
  if (!same(v2Factory, BSC_SPOT.v2Factory) || !same(v3Factory, BSC_SPOT.v3Factory) || !same(qFactory, BSC_SPOT.v3Factory)
    || ![v2Native, v3Native, qNative].every(a => same(a, BSC_SPOT.wrappedNative))
    || ![v3Deployer, qDeployer].every(a => same(a, BSC_SPOT.v3Deployer))) throw new TradeError('CONFIG_INVALID', 'BSC router/quoter immutable bindings do not match verified deployments');
}

async function verifyPool(client: PublicClient, pool: Address, request: BscSpotRequest, v3: boolean, fee: number | null, blockNumber: bigint,quoteToken:Address=BSC_SPOT.wrappedNative) {
  const [code, factory, token0, token1] = await Promise.all([
    client.getBytecode({ address: pool, blockNumber }),
    client.readContract({ address: pool, abi: BSC_POOL_ABI, functionName: 'factory', blockNumber }),
    client.readContract({ address: pool, abi: BSC_POOL_ABI, functionName: 'token0', blockNumber }),
    client.readContract({ address: pool, abi: BSC_POOL_ABI, functionName: 'token1', blockNumber }),
  ]);
  const sorted = [request.token, quoteToken].sort();
  if (!code || code === '0x' || !same(factory, v3 ? BSC_SPOT.v3Factory : BSC_SPOT.v2Factory) || !same(token0, sorted[0]!) || !same(token1, sorted[1]!)) throw new TradeError('QUOTE_FAILED', 'Factory pool identity mismatch');
  if (v3 && await client.readContract({ address: pool, abi: BSC_POOL_ABI, functionName: 'fee', blockNumber }) !== fee) throw new TradeError('QUOTE_FAILED', 'Pool fee tier mismatch');
}

function quoteId(quote: Omit<BscSpotQuote, 'id'>): Hex {
  // Explicit field order and every user/route/expiry binding; bigint stays exact.
  const fields:unknown[]=[
    quote.version, quote.chainId, quote.request.chainId, quote.request.side, lc(quote.request.token), lc(quote.request.trader), quote.request.amountIn.toString(), quote.request.slippageBps,
    quote.venue, lc(quote.pool), lc(quote.router), quote.feeTier, quote.priceImpactBps, quote.tokenDecimals, quote.amountOut.toString(), quote.minAmountOut.toString(),
    quote.blockNumber.toString(), quote.blockHash, quote.quotedAt, quote.expiresAt, quote.platformFeeBps,
  ];
  if(quote.route)fields.push(quote.route.path.map(lc),quote.route.pools.map(lc));
  return keccak256(stringToHex(JSON.stringify(fields)));
}
export function assertBscQuote(quote: BscSpotQuote, now = Math.floor(Date.now() / 1000)) {
  validateBscRequest(quote.request);
  if(quote.route){
    const {path,pools}=quote.route,buy=quote.request.side==='buy';
    if(quote.venue!=='pancake-v2'||path.length!==3||pools.length!==2||!path.every(a=>isAddress(a))||!pools.every(a=>isAddress(a)&&!same(a,zeroAddress))
      ||new Set(path.map(lc)).size!==3||same(pools[0]!,pools[1]!)||!same(path[1]!,BSC_USDT_BRIDGE)
      ||!same(path[0]!,buy?BSC_SPOT.wrappedNative:quote.request.token)||!same(path[2]!,buy?quote.request.token:BSC_SPOT.wrappedNative)
      ||!same(quote.pool,pools[buy?1:0]!))throw new TradeError('QUOTE_MISMATCH','BNB bridge route changed');
  }
  if (quote.id !== quoteId(quote) || quote.version !== BSC_SPOT.version || quote.chainId !== 56 || quote.platformFeeBps !== 0
    || !isAddress(quote.pool) || !/^0x[0-9a-fA-F]{64}$/.test(quote.blockHash)
    || quote.amountOut <= 0n || quote.minAmountOut <= 0n
    || quote.minAmountOut !== quote.amountOut * (10_000n - BigInt(quote.request.slippageBps)) / 10_000n
    || !Number.isInteger(quote.tokenDecimals) || quote.tokenDecimals < 0 || quote.tokenDecimals > 36
    || !Number.isInteger(quote.priceImpactBps) || quote.priceImpactBps < 0 || quote.priceImpactBps > 500
    || (quote.venue !== 'pancake-v2' && quote.venue !== 'pancake-v3')
    || !same(quote.router, quote.venue === 'pancake-v2' ? BSC_SPOT.v2Router : BSC_SPOT.v3Router)
    || (quote.venue === 'pancake-v2' ? quote.feeTier !== null : !V3_FEES.includes(quote.feeTier!))) throw new TradeError('QUOTE_MISMATCH', 'Quote identity or venue configuration changed');
  if (now < quote.quotedAt - 5 || now >= quote.expiresAt || quote.expiresAt !== quote.quotedAt + 60) throw new TradeError('QUOTE_EXPIRED', 'Quote expired; request and review a new quote');
}

/** Direct WBNB routes only; indexer/public quote hints never admit pools or set executable prices. */
export async function quoteBscSpot(client: PublicClient, input: BscSpotRequest, now = Math.floor(Date.now() / 1000)): Promise<BscSpotQuote[]> {
  const request = validateBscRequest(input);
  await assertBscClient(client);
  const block = await client.getBlock();
  if (!block.hash || !Number.isSafeInteger(now) || Math.abs(now - Number(block.timestamp)) > 30) throw new TradeError('QUOTE_FAILED', 'BSC provider head is stale or future dated');
  await verifyBscDeployments(client, block.number);
  const decimals = await client.readContract({ address: request.token, abi: BSC_ERC20_ABI, functionName: 'decimals', blockNumber: block.number });
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new TradeError('CONFIG_INVALID', 'Unsupported token decimals');
  const tokenIn = request.side === 'buy' ? BSC_SPOT.wrappedNative : request.token;
  const tokenOut = request.side === 'buy' ? request.token : BSC_SPOT.wrappedNative;
  const candidates = await Promise.allSettled([null, ...V3_FEES].map(async feeTier => {
    const v3 = feeTier !== null;
    const pool = lc(v3
      ? await client.readContract({ address: BSC_SPOT.v3Factory, abi: PANCAKE_V3, functionName: 'getPool', args: [request.token, BSC_SPOT.wrappedNative, feeTier], blockNumber: block.number })
      : await client.readContract({ address: BSC_SPOT.v2Factory, abi: PANCAKE_V2, functionName: 'getPair', args: [request.token, BSC_SPOT.wrappedNative], blockNumber: block.number }));
    if (same(pool, zeroAddress)) return null;
    await verifyPool(client, pool, request, v3, feeTier, block.number);
    let amountOut: bigint;
    let marginalOut: bigint;
    const zeroForOne = tokenIn < tokenOut;
    if (v3) {
      const [result, slot] = await Promise.all([
        client.simulateContract({ address: BSC_SPOT.v3Quoter, abi: BSC_QUOTER_ABI, functionName: 'quoteExactInputSingle',
          args: [{ tokenIn, tokenOut, amountIn: request.amountIn, fee: feeTier!, sqrtPriceLimitX96: 0n }], blockNumber: block.number }),
        client.readContract({address:pool,abi:BSC_POOL_ABI,functionName:'slot0',blockNumber:block.number}),
      ]);
      if (!slot[0] || !slot[6]) return null;
      const squared = slot[0] * slot[0];
      marginalOut = zeroForOne ? request.amountIn * squared / (1n << 192n) : request.amountIn * (1n << 192n) / squared;
      amountOut = result.result[0];
    } else {
      const [amounts, reserves] = await Promise.all([
        client.readContract({ address: BSC_SPOT.v2Router, abi: BSC_V2_ROUTER_ABI, functionName: 'getAmountsOut', args: [request.amountIn, [tokenIn, tokenOut]], blockNumber: block.number }),
        client.readContract({address:pool,abi:BSC_POOL_ABI,functionName:'getReserves',blockNumber:block.number}),
      ]);
      if (amounts.length !== 2 || amounts[0] !== request.amountIn) throw new TradeError('QUOTE_FAILED', 'Invalid router quote');
      if (reserves[0] <= 0n || reserves[1] <= 0n) return null;
      marginalOut = zeroForOne ? request.amountIn * reserves[1] / reserves[0] : request.amountIn * reserves[0] / reserves[1];
      amountOut = amounts[1]!;
    }
    if (marginalOut <= 0n) return null;
    if (amountOut < marginalOut && (marginalOut - amountOut) * 10_000n > marginalOut * 500n) return null;
    const priceImpactBps = amountOut >= marginalOut ? 0 : Number((marginalOut - amountOut) * 10_000n / marginalOut);
    if (priceImpactBps > 500) return null;
    const minAmountOut = amountOut * (10_000n - BigInt(request.slippageBps)) / 10_000n;
    if (amountOut <= 0n || amountOut > uintMax || minAmountOut <= 0n) return null;
    const quote: Omit<BscSpotQuote, 'id'> = { version: BSC_SPOT.version, chainId: 56, request, venue: v3 ? 'pancake-v3' : 'pancake-v2',
      pool, router: v3 ? BSC_SPOT.v3Router : BSC_SPOT.v2Router, feeTier, priceImpactBps, tokenDecimals: decimals, amountOut, minAmountOut,
      blockNumber: block.number, blockHash: block.hash, quotedAt: now, expiresAt: now + 60, platformFeeBps: 0 };
    return { ...quote, id: quoteId(quote) };
  }));
  const quotes:BscSpotQuote[] = candidates.flatMap(c => c.status === 'fulfilled' && c.value ? [c.value] : []);
  if(!same(request.token,BSC_USDT_BRIDGE)){
    try{
      const [bridgePool,tokenPool]=await Promise.all([
        client.readContract({address:BSC_SPOT.v2Factory,abi:PANCAKE_V2,functionName:'getPair',args:[BSC_USDT_BRIDGE,BSC_SPOT.wrappedNative],blockNumber:block.number}),
        client.readContract({address:BSC_SPOT.v2Factory,abi:PANCAKE_V2,functionName:'getPair',args:[request.token,BSC_USDT_BRIDGE],blockNumber:block.number}),
      ]);
      if(!same(bridgePool,zeroAddress)&&!same(tokenPool,zeroAddress)){
        await Promise.all([verifyPool(client,bridgePool,{...request,token:BSC_USDT_BRIDGE},false,null,block.number),verifyPool(client,tokenPool,request,false,null,block.number,BSC_USDT_BRIDGE)]);
        const buy=request.side==='buy',path:Address[]=buy?[BSC_SPOT.wrappedNative,BSC_USDT_BRIDGE,request.token]:[request.token,BSC_USDT_BRIDGE,BSC_SPOT.wrappedNative];
        const pools:Address[]=buy?[lc(bridgePool),lc(tokenPool)]:[lc(tokenPool),lc(bridgePool)];
        const [amounts,reserves]=await Promise.all([
          client.readContract({address:BSC_SPOT.v2Router,abi:BSC_V2_ROUTER_ABI,functionName:'getAmountsOut',args:[request.amountIn,path],blockNumber:block.number}),
          Promise.all(pools.map(address=>client.readContract({address,abi:BSC_POOL_ABI,functionName:'getReserves',blockNumber:block.number}))),
        ]);
        let marginal=request.amountIn;
        for(let i=0;i<2;i++){const reserve=reserves[i]!;if(reserve[0]<=0n||reserve[1]<=0n)throw new Error('Empty bridge pool');marginal=path[i]!<path[i+1]!?marginal*reserve[1]/reserve[0]:marginal*reserve[0]/reserve[1];}
        const amountOut=amounts[2]!,minAmountOut=amountOut*(10_000n-BigInt(request.slippageBps))/10_000n;
        if(amounts.length===3&&amounts[0]===request.amountIn&&amountOut>0n&&amountOut<=uintMax&&minAmountOut>0n&&marginal>0n
          &&(amountOut>=marginal||(marginal-amountOut)*10_000n<=marginal*500n)){
          const quote:Omit<BscSpotQuote,'id'>={version:BSC_SPOT.version,chainId:56,request,venue:'pancake-v2',pool:lc(tokenPool),router:BSC_SPOT.v2Router,feeTier:null,
            priceImpactBps:amountOut>=marginal?0:Number((marginal-amountOut)*10_000n/marginal),tokenDecimals:decimals,amountOut,minAmountOut,
            blockNumber:block.number,blockHash:block.hash,quotedAt:now,expiresAt:now+60,platformFeeBps:0,route:{path,pools}};
          quotes.push({...quote,id:quoteId(quote)});
        }
      }
    }catch{/* A failing bridge cannot discard verified direct alternatives. */}
  }
  quotes.sort((a,b)=>a.amountOut>b.amountOut?-1:a.amountOut<b.amountOut?1:a.venue.localeCompare(b.venue));
  if (!quotes.length) throw new TradeError('NO_ROUTE', 'No verified PancakeSwap route could quote this amount within the 5% pool-impact limit. Ungraduated Four.meme tokens require the separate curve adapter.');
  return quotes;
}

export function bscSwapTransaction(quote: BscSpotQuote, now?: number): BscTransaction {
  assertBscQuote(quote, now);
  const { request: r } = quote;
  const buy = r.side === 'buy';
  const deadline = BigInt(quote.expiresAt);
  let data: Hex;
  if (quote.venue === 'pancake-v2') {
    data = buy
      ? encodeFunctionData({ abi: BSC_V2_ROUTER_ABI, functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens', args: [quote.minAmountOut, quote.route?.path??[BSC_SPOT.wrappedNative, r.token], r.trader, deadline] })
      : encodeFunctionData({ abi: BSC_V2_ROUTER_ABI, functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens', args: [r.amountIn, quote.minAmountOut, quote.route?.path??[r.token, BSC_SPOT.wrappedNative], r.trader, deadline] });
  } else {
    const swap = encodeFunctionData({ abi: BSC_V3_ROUTER_ABI, functionName: 'exactInputSingle', args: [{ tokenIn: buy ? BSC_SPOT.wrappedNative : r.token,
      tokenOut: buy ? r.token : BSC_SPOT.wrappedNative, fee: quote.feeTier!, recipient: buy ? r.trader : quote.router,
      deadline, amountIn: r.amountIn, amountOutMinimum: quote.minAmountOut, sqrtPriceLimitX96: 0n }] });
    const finish = buy ? encodeFunctionData({ abi: BSC_V3_ROUTER_ABI, functionName: 'refundETH' })
      : encodeFunctionData({ abi: BSC_V3_ROUTER_ABI, functionName: 'unwrapWETH9', args: [quote.minAmountOut, r.trader] });
    data = encodeFunctionData({ abi: BSC_V3_ROUTER_ABI, functionName: 'multicall', args: [[swap, finish]] });
  }
  return { chainId: 56, account: r.trader, to: quote.router, data, value: buy ? r.amountIn : 0n };
}

export async function buildBscSpot(client: PublicClient, quote: BscSpotQuote, now?: number): Promise<BscSpotBuild> {
  const tx = bscSwapTransaction(quote, now);
  await assertBscClient(client);
  if ((await client.getBlock({ blockNumber: quote.blockNumber })).hash !== quote.blockHash) throw new TradeError('QUOTE_MISMATCH', 'The quote block is no longer canonical; review a fresh quote');
  const approvals: BscApproval[] = [];
  if (quote.request.side === 'sell') {
    const allowance = await client.readContract({ address: quote.request.token, abi: BSC_ERC20_ABI, functionName: 'allowance', args: [quote.request.trader, quote.router] });
    if (allowance < quote.request.amountIn) {
      // Reset nonzero allowances first. Approve only this exact input; no Permit2 or unlimited grant.
      for (const amount of allowance > 0n ? [0n, quote.request.amountIn] : [quote.request.amountIn]) approvals.push({ chainId: 56, account: quote.request.trader,
        to: quote.request.token, data: encodeFunctionData({ abi: BSC_ERC20_ABI, functionName: 'approve', args: [quote.router, amount] }), value: 0n, amount, spender: quote.router });
    }
  }
  return { quote, tx, approvals };
}
