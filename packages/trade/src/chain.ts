import { defineChain, type PublicClient } from 'viem';
import { TradeError } from './errors';
import { ROBINHOOD_CHAIN } from '@rushr/core/chain/robinhood';
import { getNetwork } from '@rushr/core/chain/networks';
import { bsc, bscTestnet } from 'viem/chains';

/** viem chain definition for Robinhood Chain (multicall3 verified on-chain 2026-11-12). */
export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN.id,
  name: ROBINHOOD_CHAIN.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_CHAIN.publicRpc] } },
  blockExplorers: { default: { name: 'Blockscout', url: ROBINHOOD_CHAIN.explorer } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

/** Chain metadata only: selecting a chain does not enable its execution adapters. */
export function tradeChain(chainId: number) {
  getNetwork(chainId);
  return chainId === 56 ? bsc : chainId === 97 ? bscTestnet : robinhoodChain;
}

/** Legacy encoders contain Robinhood factories and command formats. Never use
 * them with a client explicitly configured for another chain. Unspecified clients
 * retain the old API contract; the RPC boundary verifies configured endpoints. */
export function assertLegacyTradeClient(client: Pick<PublicClient, 'chain'>): void {
  if (client.chain && client.chain.id !== ROBINHOOD_CHAIN.id) {
    throw new TradeError('UNSUPPORTED_CHAIN', 'This execution adapter only supports Robinhood Chain');
  }
}
