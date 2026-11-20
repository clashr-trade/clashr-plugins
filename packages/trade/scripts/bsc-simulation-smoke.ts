// Unsigned eth_simulateV1 only. Uses existing state from a publicly observed funded EOA.
// Never signs, broadcasts, changes chain state or supplies fake balance overrides.
import {createPublicClient,http,type Address} from 'viem';
import {bsc} from 'viem/chains';
import {quoteBscSpot} from '../src/bsc/spot';
import {simulateBscSpot} from '../src/bsc/simulation';
import {sanitizeRpcMessage} from '../src/errors';
if(!process.env.BSC_RPC_URL)throw new Error('An explicit BSC_RPC_URL is required');
const client=createPublicClient({chain:bsc,transport:http(process.env.BSC_RPC_URL,{batch:{batchSize:20,wait:10},retryCount:0,timeout:10000})});
try{
  let account=process.env.BSC_SMOKE_ACCOUNT as Address|undefined;
  if(!account){
    const block=await client.getBlock({includeTransactions:true});
    const candidates=[...new Set(block.transactions.map(tx=>tx.from))].slice(0,12);
    for(const candidate of candidates){
      const [balance,code]=await Promise.all([client.getBalance({address:candidate}),client.getBytecode({address:candidate})]);
      if(balance>=10n**16n&&(!code||code==='0x')){account=candidate;break;}
    }
  }
  if(!account)throw new Error('No suitable read-only account found; supply BSC_SMOKE_ACCOUNT (address only, no key)');
  const quotes=await quoteBscSpot(client,{chainId:56,side:'buy',token:'0x55d398326f99059ff775485246999027b3197955',trader:account,amountIn:10n**15n,slippageBps:100});
  for(const venue of ['pancake-v2','pancake-v3'] as const){
    const quote=quotes.find(q=>q.venue===venue);if(!quote)continue;
    const proof=await simulateBscSpot(client,quote);
    console.log(JSON.stringify({venue,quoteBlock:quote.blockNumber.toString(),tokenDelta:proof.tokenDelta.toString(),nativeDelta:proof.nativeDelta.toString(),gasLimit:proof.swapGasLimit.toString(),gasPrice:proof.gasPrice.toString(),maxGasCostWei:proof.maxGasCostWei.toString(),stateOverrides:false,broadcast:false}));
  }
}catch(error){console.error(sanitizeRpcMessage(error));process.exitCode=1;}
