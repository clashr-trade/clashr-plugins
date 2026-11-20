import {afterEach,describe,it,expect,vi} from 'vitest';
import {bsc} from 'viem/chains';
import {encodeAbiParameters,encodeEventTopics,decodeFunctionData,parseAbi,zeroAddress,type PublicClient,type WalletClient} from 'viem';
import {quoteFlap,buildFlap,simulateFlap,executeFlap,assertFlapQuote,FLAP_ABI,FLAP_PORTAL} from '../src/bsc/flap';
import {NATIVE_TRANSFER_EMITTER} from '../src/simulate';
const TOKEN='0x1111111111111111111111111111111111111111',TRADER='0x2222222222222222222222222222222222222222',HASH=`0x${'11'.repeat(32)}` as const;
const NOW=1795110000,TRANSFER=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const uint=(v:bigint)=>encodeAbiParameters([{type:'uint256'}],[v]);
const transfer=(address:string,from:`0x${string}`,to:`0x${string}`,value:bigint)=>({address,topics:encodeEventTopics({abi:TRANSFER,eventName:'Transfer',args:{from,to}}),data:uint(value)});
const request={chainId:56,side:'buy',token:TOKEN,trader:TRADER,amountIn:10n**16n,slippageBps:100} as const;
function fixture(){
 vi.spyOn(Date,'now').mockReturnValue(NOW*1000);
 const state={chain:56,status:1,quote:zeroAddress as string,quoteDecimals:6,hop:false,gate:zeroAddress as string,nft:0n,cap:0,remaining:10n**30n,allowance:0n,out:10n**18n,received:10n**18n,native:10n**20n,canonical:true,extension:`0x${'00'.repeat(32)}`,account:TRADER as string,side:'buy',inputToken:zeroAddress as string,outputToken:TOKEN as string,inputTokens:request.amountIn,approveFalse:false,receiptActor:TRADER as string,quoteReceived:null as bigint|null};
 let sent:any;
 const client={chain:bsc,getChainId:vi.fn(async()=>state.chain),getBlock:vi.fn(async()=>({number:1000n,hash:state.canonical?HASH:`0x${'22'.repeat(32)}`,timestamp:BigInt(NOW)})),
 getBytecode:vi.fn(async({address}:{address:string})=>address===TRADER?undefined:'0x1234'),getBalance:vi.fn(async()=>state.native),getGasPrice:vi.fn(async()=>1n),
 readContract:vi.fn(async({functionName,address}:{functionName:string;address:string})=>{
  switch(functionName){case 'version':return 'v5.27.2';case 'getTokenV8Safe':return {status:state.status,quoteTokenAddress:state.quote,nativeToQuoteSwapEnabled:state.hop,circulatingSupply:10n**30n,extensionID:state.extension};
  case 'decimals':return address.toLowerCase()===state.quote.toLowerCase()?state.quoteDecimals:18;case 'symbol':return 'USDQ';case 'nftGate':return state.gate;case 'balanceOf':return state.nft;case 'maxBuyPerOrigin':return [state.cap,0n];case 'buyQuotaOf':return [0n,state.remaining];case 'allowance':return state.allowance;}throw Error(functionName);
 }),simulateContract:vi.fn(async({args}:any)=>{state.side=args[0].outputToken===TOKEN?'buy':'sell';state.inputToken=args[0].inputToken;state.outputToken=args[0].outputToken;state.inputTokens=args[0].inputAmount;return {result:state.out};}),
 request:vi.fn(async({params}:any)=>{const calls=params[0].blockStateCalls[0].calls,swapIndex=calls.findIndex((c:any)=>c.to===FLAP_PORTAL);return [{calls:calls.map((c:any,i:number)=>{
  if(c.data.startsWith('0x70a08231')){const before=i<swapIndex,quote=c.to.toLowerCase()===state.quote.toLowerCase();const amount=quote?(state.side==='buy'?(before?state.inputTokens:0n):(before?0n:state.quoteReceived??state.out)):(state.side==='buy'?(before?0n:state.received):(before?state.inputTokens:0n));return {status:'0x1',gasUsed:'0x100',returnData:uint(amount),logs:[]};}
  if(c.data.startsWith('0x095ea7b3'))return {status:'0x1',gasUsed:'0x10000',returnData:uint(state.approveFalse?0n:1n),logs:[]};
  const logs=state.inputToken===zeroAddress?[transfer(NATIVE_TRANSFER_EMITTER,TRADER,FLAP_PORTAL,state.inputTokens)]:state.outputToken===zeroAddress?[transfer(NATIVE_TRANSFER_EMITTER,FLAP_PORTAL,TRADER,state.out)]:[];
  return {status:'0x1',gasUsed:'0x186a0',returnData:uint(state.out),logs};
 })}];}),
 waitForTransactionReceipt:vi.fn(async()=>({transactionHash:HASH})),
 getTransaction:vi.fn(async()=>({chainId:56,hash:HASH,nonce:1,from:TRADER,to:sent.to,input:sent.data,value:sent.value,blockHash:HASH,blockNumber:1000n})),
 getTransactionReceipt:vi.fn(async()=>({transactionHash:HASH,from:TRADER,to:FLAP_PORTAL,blockHash:HASH,blockNumber:1000n,status:'success',gasUsed:100000n,effectiveGasPrice:1n,
 logs:[transfer(TOKEN,FLAP_PORTAL,TRADER,state.received),{address:FLAP_PORTAL,topics:encodeEventTopics({abi:FLAP_ABI,eventName:'TokenBought'}),
 data:encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'address'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],[BigInt(NOW),TOKEN,state.receiptActor as `0x${string}`,state.received,request.amountIn-100n,100n,1n])}]})),
 };
 const wallet={getChainId:async()=>56,getAddresses:async()=>[state.account],sendTransaction:vi.fn(async(tx:any)=>{sent=tx;return HASH;})};
 return {state,mock:client,client:client as unknown as PublicClient,wallet:wallet as unknown as WalletClient,sends:wallet.sendTransaction};
}
afterEach(()=>vi.restoreAllMocks());
describe('Flap curve execution',()=>{
 it('pins an eth_call quote to the trader and encodes a positive floor',async()=>{
  const {client,mock}=fixture(),q=await quoteFlap(client,request),build=await buildFlap(client,q);
  expect(q.minAmountOut).toBe(990000000000000000n);expect(build.tx.to).toBe(FLAP_PORTAL);expect(build.tx.value).toBe(request.amountIn);
  expect(mock.simulateContract).toHaveBeenCalledWith(expect.objectContaining({account:TRADER,blockNumber:1000n,functionName:'quoteExactInput'}));
 });
 it.each([0,2,3,4,5,9])('rejects non-tradable status %s',async status=>{const {client,state,mock}=fixture();state.status=status;await expect(quoteFlap(client,request)).rejects.toThrow('supported live Flap curve');expect(mock.simulateContract).not.toHaveBeenCalled();});
 it('rejects wrong chains, disabled native conversion and unknown extensions',async()=>{
  const {client,state}=fixture();state.chain=4663;await expect(quoteFlap(client,request)).rejects.toThrow('BSC mainnet');state.chain=56;state.quote=TOKEN;
  await expect(quoteFlap(client,request)).rejects.toThrow('BNB conversion is disabled');state.quote=zeroAddress;state.extension=HASH;await expect(quoteFlap(client,request)).rejects.toThrow('extension');
 });
 it('enforces NFT ownership and the wallet buy quota',async()=>{
  const {client,state}=fixture();state.gate=TOKEN;await expect(quoteFlap(client,request)).rejects.toThrow('NFT');state.nft=1n;state.cap=200;state.remaining=1n;await expect(quoteFlap(client,request)).rejects.toThrow('allocation');
 });
 it('rejects mutated quotes, zero outputs and expiry',async()=>{
  const {client,state}=fixture();const q=await quoteFlap(client,request);expect(()=>assertFlapQuote({...q,minAmountOut:1n})).toThrow();expect(()=>assertFlapQuote(q,NOW+60)).toThrow();state.out=0n;await expect(quoteFlap(client,request)).rejects.toThrow();
 });
 it('builds zero-reset and exact approvals for sells',async()=>{
  const {client,state}=fixture();state.allowance=1n;const q=await quoteFlap(client,{...request,side:'sell'}),build=await buildFlap(client,q);
  expect(build.approvals.map(a=>a.amount)).toEqual([0n,request.amountIn]);expect(build.tx.value).toBe(0n);
 });
 it('simulates real wallet deltas and rejects output shortfalls and insufficient funds',async()=>{
  const {client,state,mock}=fixture(),q=await quoteFlap(client,request);expect((await simulateFlap(client,q)).nativeDelta).toBe(-request.amountIn);
  expect(JSON.stringify(mock.request.mock.calls)).toContain('"stateOverrides":{}');state.received=1n;await expect(simulateFlap(client,q)).rejects.toThrow('wallet changes');state.received=state.out;state.native=1n;await expect(simulateFlap(client,q)).rejects.toThrow('BNB balance');
 });
 it('checks signing opt-in and account identity before sending',async()=>{
  const {client,wallet,state,sends}=fixture(),q=await quoteFlap(client,request);
  await expect(executeFlap(client,wallet,q,{enabled:false,reviewedMaxGasCostWei:1000000n})).rejects.toThrow('disabled');state.account=TOKEN;
  await expect(executeFlap(client,wallet,q,{enabled:true,reviewedMaxGasCostWei:1000000n})).rejects.toThrow('Wallet changed');expect(sends).not.toHaveBeenCalled();
 });
 it('simulates sell approvals and net BNB receipts, rejecting false approvals',async()=>{
  const {client,state}=fixture();state.allowance=1n;const q=await quoteFlap(client,{...request,side:'sell'});
  const proof=await simulateFlap(client,q);expect(proof.tokenDelta).toBe(-request.amountIn);expect(proof.nativeDelta).toBe(q.amountOut);expect(proof.build.approvals.map(a=>a.amount)).toEqual([0n,request.amountIn]);
  state.approveFalse=true;await expect(simulateFlap(client,q)).rejects.toThrow('approval returned false');
 });
 it('does not retry a submitted transaction when the Portal receipt actor does not match',async()=>{
  const {client,wallet,state,sends}=fixture(),q=await quoteFlap(client,request);state.receiptActor=TOKEN;
  await expect(executeFlap(client,wallet,q,{enabled:true,reviewedMaxGasCostWei:1000000n})).rejects.toThrow('one Flap fill');expect(sends).toHaveBeenCalledTimes(1);
 });
 it('verifies the canonical transaction and Portal fill after a mocked wallet confirmation',async()=>{
  const {client,wallet,sends}=fixture(),q=await quoteFlap(client,request);const result=await executeFlap(client,wallet,q,{enabled:true,reviewedMaxGasCostWei:1000000n});
  expect(sends).toHaveBeenCalledTimes(1);expect(result.accounting).toMatchObject({actualNativeAmount:request.amountIn,actualTokenAmount:q.amountOut,meetsMinimum:true,provenance:'canonical-receipt-events'});
 });
 it('buys ERC20-quoted curves with the built-in native hop, with no quote-token approval',async()=>{
  const {client,state}=fixture();state.quote='0x3333333333333333333333333333333333333333';state.hop=true;
  const q=await quoteFlap(client,request),build=await buildFlap(client,q);
  expect(q).toMatchObject({inputToken:zeroAddress,outputToken:TOKEN,quoteDecimals:6,quoteSymbol:'USDQ'});expect(build.approvals).toEqual([]);expect(build.tx.value).toBe(request.amountIn);
  expect((await simulateFlap(client,q)).tokenDelta).toBe(q.amountOut);
 });
 it('builds exact quote-token approvals for direct ERC20 buys and zero native value',async()=>{
  const {client,state}=fixture();state.quote='0x3333333333333333333333333333333333333333';state.allowance=1n;
  const q=await quoteFlap(client,{...request,payment:'quote',amountIn:2000000n}),build=await buildFlap(client,q);
  expect(build.approvals.map(a=>[a.to,a.amount])).toEqual([[state.quote,0n],[state.quote,2000000n]]);expect(build.tx.value).toBe(0n);
  expect((decodeFunctionData({abi:FLAP_ABI,data:build.tx.data}).args![0] as {inputToken:string}).inputToken).toBe(state.quote);
  expect((await simulateFlap(client,q)).quoteDelta).toBe(-2000000n);
 });
 it('sells to the actual quote token using its decimals and checks the net received amount',async()=>{
  const {client,state}=fixture();state.quote='0x3333333333333333333333333333333333333333';state.out=2000000n;
  const q=await quoteFlap(client,{...request,side:'sell'});expect(q.outputToken).toBe(state.quote);expect(q.quoteDecimals).toBe(6);
  const proof=await simulateFlap(client,q);expect(proof.quoteDelta).toBe(2000000n);expect(proof.nativeDelta).toBe(0n);
  state.quoteReceived=1n;await expect(simulateFlap(client,q)).rejects.toThrow('wallet changes');
 });
 it('invalidates a reviewed quote when settlement metadata changes',async()=>{
  const {client,state}=fixture();state.quote='0x3333333333333333333333333333333333333333';state.hop=true;
  const q=await quoteFlap(client,request);state.quoteDecimals=18;await expect(buildFlap(client,q)).rejects.toThrow('settlement changed');
 });
 it('never reports intermediate ERC20 curve event units as actual BNB spend',async()=>{
  const {client,state,wallet}=fixture();state.quote='0x3333333333333333333333333333333333333333';state.hop=true;
  const q=await quoteFlap(client,request),result=await executeFlap(client,wallet,q,{enabled:true,reviewedMaxGasCostWei:1000000n});
  expect(result.accounting).toMatchObject({actualNativeAmount:null,actualSettlementAmount:null,settlementSymbol:'BNB',maximumInputAmount:request.amountIn,meetsMinimum:true});
 });
 it('reconciles ERC20 sell proceeds from actual wallet Transfer logs',async()=>{
  const {client,state,mock,wallet}=fixture();state.quote='0x3333333333333333333333333333333333333333';state.out=2000000n;state.allowance=request.amountIn;
  const q=await quoteFlap(client,{...request,side:'sell'}),receipt=await mock.getTransactionReceipt();
  receipt.logs=[transfer(TOKEN,TRADER,FLAP_PORTAL,request.amountIn),transfer(state.quote,FLAP_PORTAL,TRADER,state.out),{address:FLAP_PORTAL,topics:encodeEventTopics({abi:FLAP_ABI,eventName:'TokenSold'}),data:encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'address'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],[BigInt(NOW),TOKEN,TRADER,request.amountIn,state.out,0n,1n])}];
  mock.getTransactionReceipt.mockResolvedValue(receipt);
  const result=await executeFlap(client,wallet,q,{enabled:true,reviewedMaxGasCostWei:1000000n});
  expect(result.accounting).toMatchObject({actualNativeAmount:0n,actualSettlementAmount:2000000n,settlementAsset:state.quote,settlementDecimals:6,settlementSymbol:'USDQ',meetsMinimum:true});
 });
});
