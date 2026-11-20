import { createPublicClient, http, type PublicClient } from 'viem';
import { bsc } from 'viem/chains';
import { quoteFlap, simulateFlap, assertFlapQuote, type FlapQuote } from '@rushr/trade/bsc/flap';
import {
  quoteBscSpot,
  assertBscQuote,
  type BscSpotRequest,
  type BscSpotQuote,
} from '@rushr/trade/bsc/spot';
import { simulateBscSpot } from '@rushr/trade/bsc/simulation';
import { Refusal } from './config.ts';
export type Quote = FlapQuote | BscSpotQuote;
export function assertQuote(quote: Quote) {
  if (quote.venue === 'flap') assertFlapQuote(quote);
  else assertBscQuote(quote);
}
export function createChain(rpc: string) {
  const client: PublicClient = createPublicClient({
    chain: bsc,
    transport: http(rpc, { timeout: 20000, retryCount: 0 }),
  });
  return {
    chainId: () => client.getChainId(),
    balance: (address: `0x${string}`) => client.getBalance({ address }),
    async quote(request: BscSpotRequest, venue: 'flap' | 'pancake'): Promise<Quote> {
      if (venue === 'flap') return quoteFlap(client, request);
      const [q] = await quoteBscSpot(client, request);
      if (!q) throw new Refusal('no_route', 'No supported PancakeSwap route');
      return q;
    },
    async simulate(q: Quote) {
      return q.venue === 'flap' ? simulateFlap(client, q) : simulateBscSpot(client, q);
    },
  };
}
export type Chain = ReturnType<typeof createChain>;
