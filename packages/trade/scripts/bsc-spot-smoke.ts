// Read-only mainnet probe. No wallet, private key, signature, approval or broadcast.
import {createPublicClient,http} from 'viem';
import {bsc} from 'viem/chains';
import {quoteBscSpot} from '../src/bsc/spot';
import {sanitizeRpcMessage} from '../src/errors';
if(!process.env.BSC_RPC_URL)throw new Error('Set an explicit BSC_RPC_URL for the read-only probe');
const client=createPublicClient({chain:bsc,transport:http(process.env.BSC_RPC_URL,{batch:{batchSize:20,wait:10},retryCount:0,timeout:10000})});
try{
  const quotes=await quoteBscSpot(client,{chainId:56,side:'buy',token:'0x55d398326f99059ff775485246999027b3197955',
    trader:'0x1111111111111111111111111111111111111111',amountIn:10n**15n,slippageBps:100});
  console.log(JSON.stringify(quotes.map(q=>({venue:q.venue,pool:q.pool,router:q.router,feeTier:q.feeTier,priceImpactBps:q.priceImpactBps,
    block:q.blockNumber.toString(),amountOut:q.amountOut.toString(),minimum:q.minAmountOut.toString(),platformFeeBps:q.platformFeeBps})),null,2));
}catch(error){console.error(sanitizeRpcMessage(error));process.exitCode=1;}
