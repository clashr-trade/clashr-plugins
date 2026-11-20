/** Read-only mainnet rehearsal: no signer, signing keys, approvals or broadcast methods. */
import {createPublicClient,http,type Address} from 'viem';
import {bsc} from 'viem/chains';
import {quoteFlap,simulateFlap} from '../src/bsc/flap';
if(!process.env.BSC_RPC_URL)throw new Error('Explicit BSC RPC required');
const client=createPublicClient({chain:bsc,transport:http(process.env.BSC_RPC_URL,{retryCount:0,timeout:15000})});
const origin=process.env.PRODUCT_API_URL??'http://127.0.0.1:8790';
const data=await (await fetch(origin+'/flap/market')).json() as {items:{coin:{address:Address};listed:boolean;quoteToken:string}[]};
const trader=('0x'+[...crypto.getRandomValues(new Uint8Array(20))].map(n=>n.toString(16).padStart(2,'0')).join('')) as Address;
if(await client.getBalance({address:trader})!==0n)throw new Error('Rehearsal address is not empty');
let quoted=false;
const requested=process.argv.find(a=>a.startsWith('--token='))?.slice(8).toLowerCase();
if(requested&&!/^0x[0-9a-f]{40}$/.test(requested))throw new Error('Invalid token');
const candidates=requested?[{coin:{address:requested as Address},listed:false,quoteToken:''}]:data.items.filter(t=>!t.listed).slice(0,8);
for(const item of candidates){
 try{
  const q=await quoteFlap(client,{chainId:56,side:'buy',token:item.coin.address,trader,amountIn:100000000000000n,slippageBps:100});
  console.log({token:item.coin.address,quoteBlock:q.blockNumber.toString(),inputToken:q.inputToken,quoteSymbol:q.quoteSymbol,quoteDecimals:q.quoteDecimals,amountOut:q.amountOut.toString(),minAmountOut:q.minAmountOut.toString(),venue:q.venue});quoted=true;
  try{await simulateFlap(client,q);console.log('Unexpected simulation success for the rehearsal address');process.exitCode=1;}catch{console.log('Unfunded rehearsal wallet correctly prevented a successful swap simulation');}
  break;
 }catch(error){console.log('Candidate unavailable for rehearsal',typeof error==='object'&&error&&'code' in error?String(error.code):'contract read failed');}
}
if(!quoted){console.log('No supported curve quoted');process.exitCode=1;}
