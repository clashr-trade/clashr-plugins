import {parseAbi,encodeFunctionData,decodeFunctionResult,decodeEventLog,keccak256,stringToHex,zeroAddress,isAddress,type Address,type PublicClient,type WalletClient,type Hex,type Hash} from 'viem';
import {bsc} from 'viem/chains';
import {TradeError} from '../errors';
import {simulateCalls,NATIVE_TRANSFER_EMITTER,type SimCall} from '../simulate';
import {BSC_ERC20_ABI} from './abi';
import {assertBscClient,validateBscRequest,type BscSpotRequest,type BscApproval,type BscTransaction} from './spot';
import {verifyBscReceipt,type BscSpotAccounting,type BscGasRecord} from './accounting';
import type {BscExecutionOptions} from './execute';
export const FLAP_PORTAL='0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0' as const;
export const FLAP_ABI=parseAbi([
 'function version() view returns(string)',
 'function getTokenV8Safe(address token) view returns ((uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 buyTaxRate,uint256 sellTaxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId))',
 'function nftGate(address token) view returns(address)',
 'function maxBuyPerOrigin(address token) view returns(uint16 bps,uint256 maxBuyAmount)',
 'function buyQuotaOf(address token,address origin) view returns(uint256 bought,uint256 remaining)',
 'function quoteExactInput((address inputToken,address outputToken,uint256 inputAmount) params) returns(uint256)',
 'function swapExactInput((address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,bytes permitData) params) payable returns(uint256)',
 'event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
 'event TokenSold(uint256 ts,address token,address seller,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
]);
export interface FlapQuote {
 id:Hex;version:'flap-2';chainId:56;venue:'flap';router:typeof FLAP_PORTAL;request:FlapRequest;
 quoteToken:Address;quoteDecimals:number;quoteSymbol:string;inputToken:Address;outputToken:Address;nativeToQuoteSwapEnabled:boolean;
 tokenDecimals:number;amountOut:bigint;minAmountOut:bigint;quotedAt:number;expiresAt:number;blockNumber:bigint;blockHash:Hex;
 feeTier:null;priceImpactBps:null;platformFeeBps:0;
}
export type FlapRequest=BscSpotRequest&{payment?:'native'|'quote'};
export interface FlapAccounting extends Omit<BscSpotAccounting,'actualNativeAmount'> {actualNativeAmount:bigint|null;settlementAsset:Address;settlementDecimals:number;settlementSymbol:string;actualSettlementAmount:bigint|null;maximumInputAmount:bigint}
export interface FlapSimulation {quoteId:Hex;chainId:56;simulatedAt:number;tokenDelta:bigint;nativeDelta:bigint;quoteDelta:bigint|null;gasPrice:bigint;swapGasLimit:bigint;approvalGasLimits:bigint[];maxGasCostWei:bigint;platformFeeWei:0n;build:{quote:FlapQuote;tx:BscTransaction;approvals:BscApproval[]}}
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const fail=(message:string):never=>{throw new TradeError('QUOTE_MISMATCH',message);};
const digest=(q:Omit<FlapQuote,'id'>)=>keccak256(stringToHex(JSON.stringify(q,(_,v)=>typeof v==='bigint'?v.toString():v)));
export async function flapAssetInfo(client:PublicClient,token:Address){
 await assertBscClient(client);const block=await client.getBlock({blockTag:'latest'});
 const s=await client.readContract({address:FLAP_PORTAL,abi:FLAP_ABI,functionName:'getTokenV8Safe',args:[token],blockNumber:block.number});
 const quoteToken=s.quoteTokenAddress.toLowerCase() as Address;
 const [decimals,symbol]=same(quoteToken,zeroAddress)?[18,'BNB'] as const:await Promise.all([
  client.readContract({address:quoteToken,abi:BSC_ERC20_ABI,functionName:'decimals',blockNumber:block.number}),
  client.readContract({address:quoteToken,abi:parseAbi(['function symbol() view returns(string)']),functionName:'symbol',blockNumber:block.number})]);
 if(decimals>36||!symbol||symbol.length>40)fail('Unsupported quote asset metadata');
 return {quoteToken,decimals,symbol,nativeToQuoteSwapEnabled:s.nativeToQuoteSwapEnabled,status:s.status};
}
export function assertFlapQuote(q:FlapQuote,now=Math.floor(Date.now()/1000)){
 validateBscRequest(q.request);const {id,...rest}=q;
 if(id!==digest(rest)||q.version!=='flap-2'||q.chainId!==56||q.venue!=='flap'||q.router!==FLAP_PORTAL||q.platformFeeBps!==0
  ||!isAddress(q.quoteToken)||!isAddress(q.inputToken)||!isAddress(q.outputToken)||same(q.quoteToken,q.request.token)
  ||!Number.isInteger(q.quoteDecimals)||q.quoteDecimals<0||q.quoteDecimals>36||typeof q.quoteSymbol!=='string'||!q.quoteSymbol||q.quoteSymbol.length>40
  ||typeof q.nativeToQuoteSwapEnabled!=='boolean'
  ||q.request.payment!==undefined&&!['native','quote'].includes(q.request.payment)
  ||!same(q.inputToken,q.request.side==='buy'?(q.request.payment==='quote'?q.quoteToken:zeroAddress):q.request.token)
  ||!same(q.outputToken,q.request.side==='buy'?q.request.token:q.quoteToken)
  ||q.request.side==='buy'&&same(q.inputToken,zeroAddress)&&!same(q.quoteToken,zeroAddress)&&!q.nativeToQuoteSwapEnabled
  ||q.minAmountOut<=0n||q.amountOut<=0n||q.minAmountOut!==q.amountOut*BigInt(10000-q.request.slippageBps)/10000n
  ||!Number.isSafeInteger(q.quotedAt)||!Number.isSafeInteger(q.expiresAt)||typeof q.blockNumber!=='bigint'||q.blockNumber<0n||!/^0x[0-9a-f]{64}$/i.test(q.blockHash)||!Number.isInteger(q.tokenDecimals)||q.tokenDecimals<0||q.tokenDecimals>36||q.expiresAt!==q.quotedAt+60||q.quotedAt>now+5||now>=q.expiresAt)fail('Flap quote changed or expired; review a fresh quote');
}
async function inspect(client:PublicClient,r:BscSpotRequest,blockNumber:bigint){
 await assertBscClient(client);
 const code=await client.getBytecode({address:FLAP_PORTAL,blockNumber});if(!code||code==='0x')fail('Flap Portal has no deployed code');
 const read={address:FLAP_PORTAL,abi:FLAP_ABI,blockNumber} as const;
 const [version,s,decimals,gate]=await Promise.all([
  client.readContract({...read,functionName:'version'}),client.readContract({...read,functionName:'getTokenV8Safe',args:[r.token]}),
  client.readContract({address:r.token,abi:BSC_ERC20_ABI,functionName:'decimals',blockNumber}),client.readContract({...read,functionName:'nftGate',args:[r.token]})]);
 if(!/^v?5\./.test(version)||s.status!==1)fail('Token is not on a supported live Flap curve; graduated tokens need a supported DEX pool');
 if(r.side==='buy'&&(r as FlapRequest).payment!=='quote'&&!same(s.quoteTokenAddress,zeroAddress)&&!s.nativeToQuoteSwapEnabled)fail('BNB conversion is disabled for this curve; select its quote asset to buy');
 if(!['0x'+'0'.repeat(64),'0xc87a159bf445e83477134d6374216c321695c2f3e23ee3351c8d3df6ec740253','0x9c312f81d9a1b68ba5472ca93c5447d57f897fbf4a8c468b315a67fe8016d1ab'].includes(s.extensionID.toLowerCase()))fail('Unsupported Flap extension');
 if(decimals>36)fail('Unsupported token decimals');
 if(!same(gate,zeroAddress)&&await client.readContract({address:gate,abi:BSC_ERC20_ABI,functionName:'balanceOf',args:[r.trader],blockNumber})===0n)fail('Signing wallet must hold the NFT required by this Flap token');
 if(r.side==='sell'&&r.amountIn>s.circulatingSupply)fail('Sell amount exceeds circulating supply');
 const quoteToken=s.quoteTokenAddress.toLowerCase() as Address;
 const [quoteDecimals,quoteSymbol]=same(quoteToken,zeroAddress)?[18,'BNB'] as const:await Promise.all([
  client.readContract({address:quoteToken,abi:BSC_ERC20_ABI,functionName:'decimals',blockNumber}),
  client.readContract({address:quoteToken,abi:parseAbi(['function symbol() view returns(string)']),functionName:'symbol',blockNumber}),
 ]);
 if(quoteDecimals>36||!quoteSymbol||quoteSymbol.length>40)fail('Unsupported quote asset metadata');
 return {read,decimals,quoteToken,quoteDecimals,quoteSymbol,nativeToQuoteSwapEnabled:s.nativeToQuoteSwapEnabled};
}
export async function quoteFlap(client:PublicClient,input:FlapRequest):Promise<FlapQuote>{
 const request=validateBscRequest(input);await assertBscClient(client);const block=await client.getBlock({blockTag:'latest'});
 const {read,decimals,quoteToken,quoteDecimals,quoteSymbol,nativeToQuoteSwapEnabled}=await inspect(client,request,block.number);
 const inputToken=request.side==='buy'?(input.payment==='quote'?quoteToken:zeroAddress):request.token,outputToken=request.side==='buy'?request.token:quoteToken;
 const {result:amountOut}=await client.simulateContract({...read,account:request.trader,functionName:'quoteExactInput',args:[{
  inputToken,outputToken,inputAmount:request.amountIn}]});
 if(request.side==='buy'){
  const [bps]=await client.readContract({...read,functionName:'maxBuyPerOrigin',args:[request.token]});
  if(bps){const [,remaining]=await client.readContract({...read,functionName:'buyQuotaOf',args:[request.token,request.trader]});if(amountOut>remaining)fail('Buy exceeds this wallet’s remaining Flap allocation');}
 }
 const quotedAt=Number(block.timestamp),minAmountOut=amountOut*BigInt(10000-request.slippageBps)/10000n;
 const body:Omit<FlapQuote,'id'>={version:'flap-2',chainId:56,venue:'flap',router:FLAP_PORTAL,request,quoteToken,quoteDecimals,quoteSymbol,inputToken,outputToken,nativeToQuoteSwapEnabled,tokenDecimals:decimals,amountOut,minAmountOut,
  quotedAt,expiresAt:quotedAt+60,blockNumber:block.number,blockHash:block.hash,feeTier:null,priceImpactBps:null,platformFeeBps:0};
 const q={...body,id:digest(body)};assertFlapQuote(q);return q;
}
export function flapTransaction(q:FlapQuote):BscTransaction{
 assertFlapQuote(q);const r=q.request;return {chainId:56,account:r.trader,to:FLAP_PORTAL,value:same(q.inputToken,zeroAddress)?r.amountIn:0n,
 data:encodeFunctionData({abi:FLAP_ABI,functionName:'swapExactInput',args:[{inputToken:q.inputToken,outputToken:q.outputToken,inputAmount:r.amountIn,minOutputAmount:q.minAmountOut,permitData:'0x'}]})};
}
export async function buildFlap(client:PublicClient,q:FlapQuote){
 assertFlapQuote(q);await assertBscClient(client);
 if((await client.getBlock({blockNumber:q.blockNumber})).hash!==q.blockHash)fail('Flap quote block changed');
 const head=await client.getBlock({blockTag:'latest'});assertFlapQuote(q,Number(head.timestamp));
 const state=await inspect(client,q.request,head.number);if(state.decimals!==q.tokenDecimals||!same(state.quoteToken,q.quoteToken)||state.quoteDecimals!==q.quoteDecimals||state.quoteSymbol!==q.quoteSymbol||state.nativeToQuoteSwapEnabled!==q.nativeToQuoteSwapEnabled)fail('Flap settlement changed; review a fresh quote');
 const approvals:BscApproval[]=[];
 if(!same(q.inputToken,zeroAddress)){
  const allowance=await client.readContract({address:q.inputToken,abi:BSC_ERC20_ABI,functionName:'allowance',args:[q.request.trader,FLAP_PORTAL]});
  if(allowance<q.request.amountIn)for(const amount of allowance?[0n,q.request.amountIn]:[q.request.amountIn])approvals.push({chainId:56,account:q.request.trader,to:q.inputToken,value:0n,amount,spender:FLAP_PORTAL,data:encodeFunctionData({abi:BSC_ERC20_ABI,functionName:'approve',args:[FLAP_PORTAL,amount]})});
 }
 return {quote:q,tx:flapTransaction(q),approvals};
}
const gas=(n:bigint)=>{if(n<=0n||n>5000000n)fail('Flap gas exceeds transaction budget');return (n*130n+99n)/100n;};
export async function simulateFlap(client:PublicClient,q:FlapQuote):Promise<FlapSimulation>{
 const build=await buildFlap(client,q),r=q.request;
 const code=await client.getBytecode({address:r.trader});if(code&&code!=='0x')fail('Direct Flap execution requires an EOA wallet');
 const probe:SimCall={from:r.trader,to:r.token,data:encodeFunctionData({abi:BSC_ERC20_ABI,functionName:'balanceOf',args:[r.trader]}),label:'token balance'};
 const quoteProbe:SimCall={...probe,to:q.quoteToken,label:'quote balance'};
 const probes=[probe,...(!same(q.quoteToken,zeroAddress)&&(r.side==='sell'||!same(q.inputToken,zeroAddress))?[quoteProbe]:[])];
 const calls:SimCall[]=[...probes,...build.approvals.map(a=>({from:r.trader,to:a.to,data:a.data,value:0n,label:'exact approval'})),{from:r.trader,to:build.tx.to,data:build.tx.data,value:build.tx.value,label:'Flap swap'},...probes];
 const native=await client.getBalance({address:r.trader});
 if(native<=build.tx.value)throw new TradeError('INSUFFICIENT_FUNDS','BNB balance must cover the input and approval/swap gas');
 const [result,gasPrice]=await Promise.all([simulateCalls(client,calls),client.getGasPrice()]);
 if(!result.ok||result.calls.length!==calls.length)fail('Flap approval/swap simulation failed');
 for(let i=0;i<build.approvals.length;i++){const data=result.calls[i+probes.length]!.returnData;if(data!=='0x'&&!decodeFunctionResult({abi:BSC_ERC20_ABI,functionName:'approve',data}))fail('Token approval returned false');}
 const balance=(i:number)=>decodeFunctionResult({abi:BSC_ERC20_ABI,functionName:'balanceOf',data:result.calls[i]!.returnData});
 const index=probes.length+build.approvals.length,tokenDelta=balance(index+1)-balance(0),quoteDelta=probes.length===2?balance(index+2)-balance(1):null;
 const nativeDelta=result.transfers.filter(t=>t.callIndex===index&&same(t.token,NATIVE_TRANSFER_EMITTER)).reduce((a,t)=>a+(same(t.to,r.trader)?t.value:0n)-(same(t.from,r.trader)?t.value:0n),0n);
 const settlementOk=r.side==='buy'
  ?tokenDelta>=q.minAmountOut&&(same(q.inputToken,zeroAddress)?nativeDelta<0n&&-nativeDelta<=r.amountIn:quoteDelta!==null&&quoteDelta<0n&&-quoteDelta<=r.amountIn&&nativeDelta>=0n)
  :tokenDelta===-r.amountIn&&(same(q.outputToken,zeroAddress)?nativeDelta>=q.minAmountOut:quoteDelta!==null&&quoteDelta>=q.minAmountOut&&nativeDelta>=0n);
 if(!settlementOk)fail('Simulated wallet changes violate the reviewed Flap quote');
 const approvalGasLimits=build.approvals.map((_,i)=>gas(result.calls[i+probes.length]!.gasUsed)),swapGasLimit=gas(result.calls[index]!.gasUsed);
 const maxGasCostWei=(swapGasLimit+approvalGasLimits.reduce((a,n)=>a+n,0n))*gasPrice;
 if(gasPrice<=0n||native<maxGasCostWei+build.tx.value)throw new TradeError('INSUFFICIENT_FUNDS','BNB balance must cover the input and approval/swap gas');
 return {quoteId:q.id,chainId:56,simulatedAt:Math.floor(Date.now()/1000),tokenDelta,nativeDelta,quoteDelta,gasPrice,swapGasLimit,approvalGasLimits,maxGasCostWei,platformFeeWei:0n,build};
}
const executing=new WeakSet<WalletClient>();
export async function executeFlap(client:PublicClient,wallet:WalletClient,q:FlapQuote,options:BscExecutionOptions){
 if(!options.enabled)throw new TradeError('BSC_TRADING_DISABLED','BSC signing is disabled');
 if(executing.has(wallet))fail('A wallet execution is already in progress');executing.add(wallet);
 try{
  const check=async()=>{assertFlapQuote(q);await assertBscClient(client);const [chain,accounts]=await Promise.all([wallet.getChainId(),wallet.getAddresses()]);
   if(chain!==56||!accounts[0]||!same(accounts[0],q.request.trader))throw new TradeError('WALLET_CHANGED','Wallet changed; review a fresh quote');
   assertFlapQuote(q);if(options.signal?.aborted)throw new TradeError('EXECUTION_CANCELLED','Flap execution cancelled');};
  await check();const proof=await simulateFlap(client,q);if(proof.maxGasCostWei>options.reviewedMaxGasCostWei)fail('Gas budget increased; review again');
  const approvals:{tx:BscApproval;hash:Hash}[]=[];const records:BscGasRecord[]=[];
  const send=async(tx:BscTransaction,kind:'approval'|'swap',limit:bigint,gasPrice:bigint)=>{
   await check();options.onStage?.(kind==='approval'?'Confirm exact token approval in wallet':'Confirm Flap swap in wallet');
   const hash=await wallet.sendTransaction({chain:bsc,account:q.request.trader,to:tx.to,data:tx.data,value:tx.value,gas:limit,gasPrice,type:'legacy'});
   options.onSubmitted?.({kind,hash,tx});const mined=await client.waitForTransactionReceipt({hash,confirmations:1,timeout:180000});
   if(hash!==mined.transactionHash)options.onSubmitted?.({kind,hash:mined.transactionHash,tx,replaces:hash});
   const verified=await verifyBscReceipt(client,tx,mined.transactionHash);records.push(verified.gas);
   if(verified.receipt.status!=='success')throw new TradeError('SIMULATION_REVERTED','Submitted Flap transaction reverted; inspect its receipt');return verified;
  };
  for(let i=0;i<proof.build.approvals.length;i++){const tx=proof.build.approvals[i]!;const result=await send(tx,'approval',proof.approvalGasLimits[i]!,proof.gasPrice);approvals.push({tx,hash:result.receipt.transactionHash});}
  await check();const latest=await simulateFlap(client,q),spent=proof.approvalGasLimits.reduce((a,n)=>a+n*proof.gasPrice,0n);
  if(latest.build.approvals.length||latest.maxGasCostWei+spent>options.reviewedMaxGasCostWei||latest.build.tx.data!==proof.build.tx.data)fail('Allowance, gas or transaction changed; review again');
  const swap=await send(latest.build.tx,'swap',latest.swapGasLimit,latest.gasPrice),eventName=q.request.side==='buy'?'TokenBought':'TokenSold';
  const fills=swap.receipt.logs.flatMap(log=>{if(!same(log.address,FLAP_PORTAL)||log.topics.length!==1)return [];try{const event=decodeEventLog({abi:FLAP_ABI,eventName,data:log.data,topics:log.topics as never});const actor='buyer' in event.args?event.args.buyer:event.args.seller;return same(event.args.token,q.request.token)&&same(actor,q.request.trader)?[event.args]:[];}catch{return [];}});
  if(fills.length!==1)fail('Receipt does not prove one Flap fill');const fill=fills[0]!;
  const transfer=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);let delta=0n,quoteDelta=0n;
  for(const log of swap.receipt.logs)if(same(log.address,q.request.token)||same(log.address,q.quoteToken)){try{const {args}=decodeEventLog({abi:transfer,eventName:'Transfer',data:log.data,topics:log.topics as never});const net=(same(args.to,q.request.trader)?args.value:0n)-(same(args.from,q.request.trader)?args.value:0n);if(same(log.address,q.request.token))delta+=net;else quoteDelta+=net;}catch{/* Other event. */}}
  const buy=q.request.side==='buy',nativeQuote=same(q.quoteToken,zeroAddress),nativeHop=buy&&same(q.inputToken,zeroAddress)&&!nativeQuote;
  const actualTokenAmount=buy?delta:-delta,actualNativeAmount=nativeQuote?(buy?fill.eth+fill.fee:fill.eth):nativeHop?null:0n;
  const actualSettlementAmount=nativeQuote?actualNativeAmount:nativeHop?null:buy?-quoteDelta:quoteDelta;
  if(actualTokenAmount<=0n||actualSettlementAmount!==null&&actualSettlementAmount<=0n||buy&&actualSettlementAmount!==null&&actualSettlementAmount>q.request.amountIn)fail('Invalid Flap receipt settlement');
  const settlementAsset=buy?q.inputToken:q.outputToken;
  const accounting:FlapAccounting={chainId:56,trader:q.request.trader,token:q.request.token,side:q.request.side,quoteId:q.id,provenance:'canonical-receipt-events',hash:swap.receipt.transactionHash,finality:swap.gas.finality,
   actualTokenAmount,actualNativeAmount,actualSettlementAmount,settlementAsset,settlementDecimals:same(settlementAsset,zeroAddress)?18:q.quoteDecimals,settlementSymbol:same(settlementAsset,zeroAddress)?'BNB':q.quoteSymbol,maximumInputAmount:q.request.amountIn,
   meetsMinimum:buy?actualTokenAmount>=q.minAmountOut:actualSettlementAmount!==null&&actualSettlementAmount>=q.minAmountOut&&actualTokenAmount===q.request.amountIn,
   platformFeeWei:0n,networkFeeWei:records.reduce((a,r)=>a+r.feeWei,0n),networkFeeAsset:'BNB',usd:null,pnl:null,transactions:records};
  return {hash:swap.receipt.transactionHash,approvals,accounting};
 }finally{executing.delete(wallet);}
}
