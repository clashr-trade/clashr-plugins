import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, parseAbi, zeroAddress, type Address, type Hash, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from 'viem';
import { bsc } from 'viem/chains';
import { PANCAKE_V2, PANCAKE_V3 } from '@rushr/core/chain/pancake';
import { BSC_ERC20_ABI, BSC_SPOT, BSC_V2_ROUTER_ABI, BSC_V3_ROUTER_ABI } from '../src/bsc/abi';
import { assertBscQuote, bscSwapTransaction, buildBscSpot, quoteBscSpot, BSC_USDT_BRIDGE, type BscSpotQuote, type BscSpotRequest, type BscTransaction } from '../src/bsc/spot';
import { simulateBscSpot } from '../src/bsc/simulation';
import { reconcileBscSpot, verifyBscReceipt } from '../src/bsc/accounting';
import { executeBscSpot } from '../src/bsc/execute';
import { NATIVE_TRANSFER_EMITTER } from '../src/simulate';

const TOKEN = '0x1111111111111111111111111111111111111111';
const TRADER = '0x2222222222222222222222222222222222222222';
const POOL2 = '0x3333333333333333333333333333333333333333';
const POOL3 = '0x4444444444444444444444444444444444444444';
const NOW = 1_795_000_000;
const h = (n: number) => `0x${n.toString(16).padStart(64,'0')}` as Hash;
const uint = (value: bigint) => encodeAbiParameters([{type:'uint256'}],[value]);
const TRANSFER = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const WRAPPED = parseAbi(['event Deposit(address indexed dst,uint256 wad)', 'event Withdrawal(address indexed src,uint256 wad)']);
const request = (side:'buy'|'sell'='buy'):BscSpotRequest => ({chainId:56,side,token:TOKEN,trader:TRADER,amountIn:side==='buy'?10n**18n:3_000_000n,slippageBps:100});
function transfer(token: Address, from: Address, to: Address, amount: bigint) {
  return {address:token,topics:encodeEventTopics({abi:TRANSFER,eventName:'Transfer',args:{from,to}}),data:uint(amount)};
}
function executionLogs(quote:BscSpotQuote) {
  const buy=quote.request.side==='buy';
  const pool=quote.pool;
  const native=buy?quote.request.amountIn:quote.amountOut;
  const tokens=buy?quote.amountOut:quote.request.amountIn;
  const wrapped=buy
    ? {address:BSC_SPOT.wrappedNative,topics:encodeEventTopics({abi:WRAPPED,eventName:'Deposit',args:{dst:quote.router}}),data:uint(native)}
    : {address:BSC_SPOT.wrappedNative,topics:encodeEventTopics({abi:WRAPPED,eventName:'Withdrawal',args:{src:quote.router}}),data:uint(native)};
  const swap=quote.venue==='pancake-v2'
    ? {address:pool,topics:encodeEventTopics({abi:PANCAKE_V2,eventName:'Swap',args:{sender:quote.router,to:buy?TRADER:quote.router}}),data:encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],buy?[0n,native,tokens,0n]:[tokens,0n,0n,native])}
    : {address:pool,topics:encodeEventTopics({abi:PANCAKE_V3,eventName:'Swap',args:{sender:quote.router,recipient:buy?TRADER:quote.router}}),data:encodeAbiParameters([{type:'int256'},{type:'int256'},{type:'uint160'},{type:'uint128'},{type:'int24'},{type:'uint128'},{type:'uint128'}],[buy?-tokens:tokens,buy?native:-native,2n**96n,100n,0,0n,0n])};
  return [transfer(TOKEN,buy?pool:TRADER,buy?TRADER:pool,tokens),wrapped,swap];
}
function fixture() {
  const state={chain:56,v3:true,allowance:0n,balance:10n**20n,gasPrice:1_000_000_000n,side:'buy' as 'buy'|'sell',tax:0n,missingTrace:false,approveFalse:false,failSwap:false,
    badBinding:false,wrongPool:false,finalized:true,canonical:true,quote:null as BscSpotQuote|null,expireAfterApproval:false,walletAccount:TRADER as Address};
  const transactions=new Map<Hash,Record<string,unknown>>(),receipts=new Map<Hash,TransactionReceipt>();
  const client={chain:bsc,
    getChainId:vi.fn(async()=>state.chain),
    getBlock:vi.fn(async(options?:{blockNumber?:bigint;blockTag?:string})=>{
      if(options?.blockTag==='finalized'&&!state.finalized)throw new Error('unsupported finalized tag');
      return {number:100n,hash:state.canonical?h(100):h(999),timestamp:BigInt(NOW)};
    }),
    getBytecode:vi.fn(async(o:{address:Address})=>o.address===TRADER?undefined:'0x1234'),
    getBalance:vi.fn(async()=>state.balance),getGasPrice:vi.fn(async()=>state.gasPrice),
    readContract:vi.fn(async(o:{address:Address;functionName:string;args?:readonly unknown[]}):Promise<unknown>=>{
      const a=o.address.toLowerCase(),fn=o.functionName;
      if(fn==='decimals')return 6;
      if(fn==='allowance')return state.allowance;
      if(fn==='factory')return state.badBinding?zeroAddress:(a===BSC_SPOT.v2Router||a===POOL2)?BSC_SPOT.v2Factory:BSC_SPOT.v3Factory;
      if(fn==='WETH'||fn==='WETH9')return BSC_SPOT.wrappedNative;
      if(fn==='deployer')return BSC_SPOT.v3Deployer;
      if(fn==='getPair')return POOL2;
      if(fn==='getPool')return state.v3&&o.args?.[2]===500?POOL3:zeroAddress;
      if(fn==='token0')return state.wrongPool?zeroAddress:TOKEN;
      if(fn==='token1')return BSC_SPOT.wrappedNative;
      if(fn==='fee')return 500;
      if(fn==='getReserves')return [200_000_000n,100n*10n**18n,0];
      if(fn==='slot0')return [(1n<<96n)*600_000n,0,0,1,1,0,true];
      if(fn==='getAmountsOut')return [o.args![0],state.side==='buy'?2_000_000n:149n*10n**16n];
      throw new Error(`Unexpected read ${fn}`);
    }),
    simulateContract:vi.fn(async()=>({result:[state.side==='buy'?3_000_000n:2n*10n**18n,2n**96n,1,100_000n]})),
    request:vi.fn(async(o:{method:string;params:unknown[]})=>{
      expect(o.method).toBe('eth_simulateV1');
      const body=o.params[0] as {blockStateCalls:{stateOverrides:object;calls:{to:Address;data:Hex;value:Hex}[]}[];traceTransfers:boolean};
      expect(body.traceTransfers).toBe(true);expect(body.blockStateCalls[0]!.stateOverrides).toEqual({});
      const calls=body.blockStateCalls[0]!.calls;
      return [{calls:calls.map((call,index)=>{
        if(index===0||index===calls.length-1)return {status:'0x1',gasUsed:'0x500',returnData:uint(index===0?(state.side==='buy'?0n:3_000_000n):(state.side==='buy'?3_000_000n-state.tax:0n)),logs:[]};
        if(call.to===TOKEN)return {status:'0x1',gasUsed:'0xc350',returnData:uint(state.approveFalse?0n:1n),logs:[]};
        return {status:state.failSwap?'0x0':'0x1',gasUsed:'0x249f0',returnData:state.v3?encodeFunctionResult({abi:BSC_V3_ROUTER_ABI,functionName:'multicall',result:[uint(state.side==='buy'?3_000_000n:2n*10n**18n),'0x']}):'0x',logs:state.missingTrace?[]:[transfer(NATIVE_TRANSFER_EMITTER, state.side==='buy'?TRADER:call.to,state.side==='buy'?call.to:TRADER,state.side==='buy'?10n**18n:state.v3?2n*10n**18n:10n**18n)]};
      })}];
    }),
    getTransaction:vi.fn(async({hash}:{hash:Hash})=>transactions.get(hash)),
    getTransactionReceipt:vi.fn(async({hash}:{hash:Hash})=>receipts.get(hash)),
    waitForTransactionReceipt:vi.fn(async({hash}:{hash:Hash})=>{
      if(state.expireAfterApproval&&receipts.get(hash)?.to===TOKEN)vi.spyOn(Date,'now').mockReturnValue((NOW+61)*1000);
      return receipts.get(hash);
    }),
  };
  function addReceipt(tx:BscTransaction,hash:Hash,nonce:number,logs:unknown[]=[]) {
    transactions.set(hash,{chainId:56,hash,from:tx.account,to:tx.to,input:tx.data,value:tx.value,blockHash:h(100),blockNumber:100n,nonce});
    receipts.set(hash,{transactionHash:hash,from:tx.account,to:tx.to,blockNumber:100n,blockHash:h(100),gasUsed:100_000n,effectiveGasPrice:2_000_000_000n,status:'success',logs} as unknown as TransactionReceipt);
  }
  const wallet={
    getChainId:vi.fn(async()=>56),getAddresses:vi.fn(async()=>[state.walletAccount]),
    sendTransaction:vi.fn(async(o:{account:Address;to:Address;data:Hex;value:bigint})=>{
      const hash=h(transactions.size+1),tx={chainId:56 as const,...o};
      if(o.to===TOKEN){const decoded=decodeFunctionData({abi:BSC_ERC20_ABI,data:o.data});if(decoded.functionName==='approve')state.allowance=decoded.args[1];}
      addReceipt(tx,hash,transactions.size,o.to===TOKEN?[]:executionLogs(state.quote!));return hash;
    }),
  };
  return {state,client:client as unknown as PublicClient,wallet:wallet as unknown as WalletClient,raw:client,rawWallet:wallet,transactions,receipts,addReceipt};
}
beforeEach(()=>{vi.spyOn(Date,'now').mockReturnValue(NOW*1000);});
afterEach(()=>vi.restoreAllMocks());

describe('BSC spot quote/build isolation',()=>{
  it.each(['buy','sell'] as const)('verifies a USDT bridge, binds its full path and reconciles both pools for %s',async side=>{
    const f=fixture();f.state.side=side;
    const bridge='0x9999999999999999999999999999999999999999',pair='0x8888888888888888888888888888888888888888';
    const original=f.raw.readContract.getMockImplementation()!;
    f.raw.readContract.mockImplementation(async o=>{
      if(o.functionName==='getPair'&&o.args?.includes(BSC_USDT_BRIDGE))return o.args.includes(TOKEN)?pair:bridge;
      if(o.address===bridge||o.address===pair){
        if(o.functionName==='factory')return BSC_SPOT.v2Factory;
        if(o.functionName==='token0')return o.address===bridge?BSC_USDT_BRIDGE:TOKEN;
        if(o.functionName==='token1')return o.address===bridge?BSC_SPOT.wrappedNative:BSC_USDT_BRIDGE;
        if(o.functionName==='getReserves')return o.address===bridge?[100n*10n**18n,100n*10n**18n,0]:[200_000_000n,100n*10n**18n,0];
      }
      if(o.functionName==='getAmountsOut'&&(o.args?.[1] as Address[])?.length===3)return side==='buy'?[10n**18n,10n**18n,1_990_000n]:[3_000_000n,15n*10n**17n,149n*10n**16n];
      return original(o);
    });
    const quote=(await quoteBscSpot(f.client,request(side))).find(q=>q.route)!;
    expect(quote).toBeDefined();expect(quote.pool).toBe(pair);
    expect(quote.route?.path).toEqual(side==='buy'?[BSC_SPOT.wrappedNative,BSC_USDT_BRIDGE,TOKEN]:[TOKEN,BSC_USDT_BRIDGE,BSC_SPOT.wrappedNative]);
    const tx=bscSwapTransaction(quote),decoded=decodeFunctionData({abi:BSC_V2_ROUTER_ABI,data:tx.data});
    expect((decoded.args[side==='buy'?1:2] as Address[]).map(address=>address.toLowerCase())).toEqual(quote.route?.path);
    expect(()=>assertBscQuote({...quote,route:{...quote.route!,path:[TOKEN,BSC_USDT_BRIDGE,TRADER]}})).toThrow();
    const logs=executionLogs(quote);f.addReceipt(tx,h(66),1,logs);
    await expect(reconcileBscSpot(f.client,quote,h(66))).rejects.toMatchObject({code:'QUOTE_MISMATCH'});
    f.addReceipt(tx,h(66),1,[...logs,{...logs[2],address:bridge}]);
    expect((await reconcileBscSpot(f.client,quote,h(66))).actualTokenAmount).toBeGreaterThan(0n);
  });
  it('verifies deployments/factory membership, pins all quotes, and selects on-chain output',async()=>{
    const f=fixture();const quotes=await quoteBscSpot(f.client,request());
    expect(quotes.map(q=>q.venue)).toEqual(['pancake-v3','pancake-v2']);
    expect(quotes[0]).toMatchObject({chainId:56,amountOut:3_000_000n,minAmountOut:2_970_000n,tokenDecimals:6,platformFeeBps:0,expiresAt:NOW+60});
    expect(f.raw.readContract.mock.calls.every(([o])=>'blockNumber' in o)).toBe(true);
  });
  it('rejects wrong chains, invalid requests and wrong immutable bindings',async()=>{
    const f=fixture();f.state.chain=4663;await expect(quoteBscSpot(f.client,request())).rejects.toMatchObject({code:'UNSUPPORTED_CHAIN'});
    f.state.chain=56;f.state.badBinding=true;await expect(quoteBscSpot(f.client,request())).rejects.toMatchObject({code:'CONFIG_INVALID'});
    await expect(quoteBscSpot(f.client,{...request(),amountIn:0n})).rejects.toMatchObject({code:'INVALID_AMOUNT'});
    await expect(quoteBscSpot(f.client,{...request(),slippageBps:501})).rejects.toMatchObject({code:'INVALID_SLIPPAGE'});
  });
  it('rejects spoofed pool membership, quote mutation, expiry and account changes',async()=>{
    const f=fixture();f.state.wrongPool=true;await expect(quoteBscSpot(f.client,request())).rejects.toMatchObject({code:'NO_ROUTE'});
    f.state.wrongPool=false;const [q]=await quoteBscSpot(f.client,request());
    expect(()=>assertBscQuote({...q!,request:{...q!.request,trader:POOL2}})).toThrow('identity');
    expect(()=>assertBscQuote(q!,NOW+60)).toThrow('expired');
  });
  it('encodes native v3 refunds and sell unwrap, with explicit recipient/deadline/minimum',async()=>{
    const f=fixture();let [q]=await quoteBscSpot(f.client,request());
    const tx=bscSwapTransaction(q!);const outer=decodeFunctionData({abi:BSC_V3_ROUTER_ABI,data:tx.data});
    expect(tx.value).toBe(10n**18n);expect(outer.functionName).toBe('multicall');
    if(outer.functionName!=='multicall')throw new Error();
    const swap=decodeFunctionData({abi:BSC_V3_ROUTER_ABI,data:outer.args[0][0]!});
    expect(swap.functionName).toBe('exactInputSingle');
    if(swap.functionName==='exactInputSingle')expect(swap.args[0]).toMatchObject({deadline:BigInt(NOW+60),amountOutMinimum:2_970_000n});
    expect(decodeFunctionData({abi:BSC_V3_ROUTER_ABI,data:outer.args[0][1]!}).functionName).toBe('refundETH');
    f.state.side='sell';[q]=await quoteBscSpot(f.client,request('sell'));
    const sell=decodeFunctionData({abi:BSC_V3_ROUTER_ABI,data:bscSwapTransaction(q!).data});
    if(sell.functionName!=='multicall')throw new Error();
    expect(decodeFunctionData({abi:BSC_V3_ROUTER_ABI,data:sell.args[0][1]!}).functionName).toBe('unwrapWETH9');
  });
  it('uses v2 balance-checking paths and only exact/reset approvals',async()=>{
    const f=fixture();f.state.v3=false;
    let [q]=await quoteBscSpot(f.client,request());
    expect(decodeFunctionData({abi:BSC_V2_ROUTER_ABI,data:bscSwapTransaction(q!).data}).functionName).toBe('swapExactETHForTokensSupportingFeeOnTransferTokens');
    f.state.side='sell';[q]=await quoteBscSpot(f.client,request('sell'));f.state.allowance=1n;
    const built=await buildBscSpot(f.client,q!);
    expect(built.approvals.map(a=>a.amount)).toEqual([0n,3_000_000n]);
    f.state.allowance=3_000_000n;expect((await buildBscSpot(f.client,q!)).approvals).toEqual([]);
  });
  it('rejects routes whose executable output deviates more than 5% from the pinned pool rate',async()=>{
    const f=fixture();
    f.raw.simulateContract.mockResolvedValue({result:[1n,2n**96n,1,100_000n]});
    const original=f.raw.readContract.getMockImplementation()!;
    f.raw.readContract.mockImplementation(async args=>args.functionName==='getAmountsOut'?[args.args![0],1n]:original(args));
    await expect(quoteBscSpot(f.client,request())).rejects.toThrow('5% pool-impact');
  });
  it('enforces the impact limit before rounding the displayed basis points',async()=>{
    const f=fixture();f.state.v3=false;
    const original=f.raw.readContract.getMockImplementation()!;
    f.raw.readContract.mockImplementation(async args=>args.functionName==='getAmountsOut'?[args.args![0],1_899_999n]:original(args));
    await expect(quoteBscSpot(f.client,request())).rejects.toThrow('5%');
    f.raw.readContract.mockImplementation(async args=>args.functionName==='getAmountsOut'?[args.args![0],1_900_000n]:original(args));
    expect((await quoteBscSpot(f.client,request()))[0]?.priceImpactBps).toBe(500);
  });
});
describe('BSC stateful simulation',()=>{
  it('uses real balances with no funding override and budgets all gas in BNB',async()=>{
    const f=fixture();const [q]=await quoteBscSpot(f.client,request());const proof=await simulateBscSpot(f.client,q!);
    expect(proof).toMatchObject({chainId:56,tokenDelta:3_000_000n,nativeDelta:-(10n**18n),swapGasLimit:195_000n,maxGasCostWei:195_000n*10n**9n,platformFeeWei:0n});
  });
  it('rejects nominal v3 output when actual wallet receipt is taxed',async()=>{
    const f=fixture();const [q]=await quoteBscSpot(f.client,request());f.state.tax=1n;
    await expect(simulateBscSpot(f.client,q!)).rejects.toMatchObject({code:'TAX_TOO_HIGH'});
  });
  it('fails closed on missing native trace, insufficient funds and unsupported stateful RPC',async()=>{
    const f=fixture();const [q]=await quoteBscSpot(f.client,request());f.state.missingTrace=true;
    await expect(simulateBscSpot(f.client,q!)).rejects.toThrow();
    f.state.missingTrace=false;f.state.balance=10n**18n;
    await expect(simulateBscSpot(f.client,q!)).rejects.toMatchObject({code:'INSUFFICIENT_FUNDS'});
    f.raw.request.mockRejectedValue(new Error('method not supported'));
    await expect(simulateBscSpot(f.client,q!)).rejects.toMatchObject({code:'SIMULATION_UNSUPPORTED'});
  });
  it('refuses explicit approval(false)',async()=>{
    const f=fixture();f.state.side='sell';const [q]=await quoteBscSpot(f.client,request('sell'));f.state.approveFalse=true;
    await expect(simulateBscSpot(f.client,q!)).rejects.toThrow('approval returned false');
  });
});
describe('BSC user-confirmed execution and receipt accounting',()=>{
  it('does not touch wallets when signing is disabled or the account changes',async()=>{
    const f=fixture();const [q]=await quoteBscSpot(f.client,request());
    await expect(executeBscSpot(f.client,f.wallet,q!,{enabled:false,reviewedMaxGasCostWei:10n**18n})).rejects.toMatchObject({code:'BSC_TRADING_DISABLED'});
    f.state.walletAccount=POOL2;
    await expect(executeBscSpot(f.client,f.wallet,q!,{enabled:true,reviewedMaxGasCostWei:10n**18n})).rejects.toMatchObject({code:'WALLET_CHANGED'});
    expect(f.rawWallet.sendTransaction).not.toHaveBeenCalled();
  });
  it('submits an exact approval then re-simulates before the sell and reconciles actual receipt gas',async()=>{
    const f=fixture();f.state.side='sell';const [q]=await quoteBscSpot(f.client,request('sell'));f.state.quote=q!;
    const result=await executeBscSpot(f.client,f.wallet,q!,{enabled:true,reviewedMaxGasCostWei:10n**18n});
    expect(f.rawWallet.sendTransaction).toHaveBeenCalledTimes(2);
    expect(result.accounting).toMatchObject({chainId:56,actualTokenAmount:3_000_000n,actualNativeAmount:2n*10n**18n,networkFeeWei:400_000_000_000_000n,networkFeeAsset:'BNB',platformFeeWei:0n,usd:null,pnl:null,finality:'finalized'});
  });
  it('stops after approval if the quote expires instead of requoting or sending a stale swap',async()=>{
    const f=fixture();f.state.side='sell';const [q]=await quoteBscSpot(f.client,request('sell'));f.state.quote=q!;f.state.expireAfterApproval=true;
    await expect(executeBscSpot(f.client,f.wallet,q!,{enabled:true,reviewedMaxGasCostWei:10n**18n})).rejects.toMatchObject({code:'QUOTE_EXPIRED'});
    expect(f.rawWallet.sendTransaction).toHaveBeenCalledOnce();
  });
  it('rejects cancellation before any wallet transaction',async()=>{
    const f=fixture();const [q]=await quoteBscSpot(f.client,request());const cancel=new AbortController();cancel.abort();
    await expect(executeBscSpot(f.client,f.wallet,q!,{enabled:true,reviewedMaxGasCostWei:10n**18n,signal:cancel.signal})).rejects.toMatchObject({code:'EXECUTION_CANCELLED'});
    expect(f.rawWallet.sendTransaction).not.toHaveBeenCalled();
  });
  it('refuses a changed gas budget or reorganized quote before signing',async()=>{
    const f=fixture();const [q]=await quoteBscSpot(f.client,request());
    await expect(executeBscSpot(f.client,f.wallet,q!,{enabled:true,reviewedMaxGasCostWei:1n})).rejects.toThrow('gas budget');
    f.state.canonical=false;
    await expect(executeBscSpot(f.client,f.wallet,q!,{enabled:true,reviewedMaxGasCostWei:10n**18n})).rejects.toThrow('canonical');
    expect(f.rawWallet.sendTransaction).not.toHaveBeenCalled();
  });
  it('serializes duplicate executions while a wallet confirmation is pending',async()=>{
    const f=fixture();const [q]=await quoteBscSpot(f.client,request());f.state.quote=q!;
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
    const send=f.rawWallet.sendTransaction.getMockImplementation()!;
    f.rawWallet.sendTransaction.mockImplementation(async tx=>{entered();await gate;return send(tx);});
    const first=executeBscSpot(f.client,f.wallet,q!,{enabled:true,reviewedMaxGasCostWei:10n**18n});
    try{await started;await expect(executeBscSpot(f.client,f.wallet,q!,{enabled:true,reviewedMaxGasCostWei:10n**18n})).rejects.toThrow('already in progress');}
    finally{release();}
    await first;expect(f.rawWallet.sendTransaction).toHaveBeenCalledOnce();
  });
  it('honors cancellation after an approval without requesting the swap',async()=>{
    const f=fixture();f.state.side='sell';const [q]=await quoteBscSpot(f.client,request('sell'));f.state.quote=q!;
    const cancel=new AbortController();
    await expect(executeBscSpot(f.client,f.wallet,q!,{enabled:true,reviewedMaxGasCostWei:10n**18n,signal:cancel.signal,
      onSubmitted:()=>cancel.abort()})).rejects.toMatchObject({code:'EXECUTION_CANCELLED'});
    expect(f.rawWallet.sendTransaction).toHaveBeenCalledOnce();expect(f.state.allowance).toBe(3_000_000n);
  });
  it('keeps failed-transaction gas as BNB cost without inventing a fill',async()=>{
    const f=fixture();const [q]=await quoteBscSpot(f.client,request());const tx=bscSwapTransaction(q!);f.addReceipt(tx,h(1),1);
    f.receipts.get(h(1))!.status='reverted';
    const record=await reconcileBscSpot(f.client,q!,h(1));
    expect(record).toMatchObject({actualTokenAmount:0n,actualNativeAmount:0n,meetsMinimum:false,networkFeeWei:200_000_000_000_000n,usd:null,pnl:null});
  });
  it('does not accept missing venue/native evidence or an unrelated approval fee',async()=>{
    const f=fixture();f.state.side='sell';const [q]=await quoteBscSpot(f.client,request('sell'));const tx=bscSwapTransaction(q!);
    f.addReceipt(tx,h(1),2,[]);
    await expect(reconcileBscSpot(f.client,q!,h(1))).rejects.toThrow('does not prove');
    f.addReceipt(tx,h(1),2,executionLogs(q!));
    const [approval]=(await buildBscSpot(f.client,q!)).approvals;
    const wrong={...approval!,amount:(2n**256n)-1n,data:encodeFunctionData({abi:BSC_ERC20_ABI,functionName:'approve',args:[q!.router,(2n**256n)-1n]})};
    await expect(reconcileBscSpot(f.client,q!,h(1),[{tx:wrong,hash:h(2)}])).rejects.toThrow('approval accounting');
  });
  it('verifies calldata and canonical hashes and never substitutes confirmation depth for finality',async()=>{
    const f=fixture();const [q]=await quoteBscSpot(f.client,request());const tx=bscSwapTransaction(q!);f.addReceipt(tx,h(1),1,executionLogs(q!));
    f.state.finalized=false;expect((await reconcileBscSpot(f.client,q!,h(1))).finality).toBe('mined');
    f.state.canonical=false;await expect(verifyBscReceipt(f.client,tx,h(1))).rejects.toThrow('canonical');
    f.state.canonical=true;f.transactions.get(h(1))!.input='0x';await expect(reconcileBscSpot(f.client,q!,h(1))).rejects.toThrow('reviewed');
  });
});
