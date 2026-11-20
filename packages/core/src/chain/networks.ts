import { isAddress } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import {BSC_PUBLIC_RPC} from './bsc-rpc';
import { ROBINHOOD_CHAIN } from './robinhood';

export type SupportedChainId = 4663 | 56 | 97;
/** Old entry points always retain their original chain, regardless of new UI defaults. */
export const LEGACY_CHAIN_ID = 4663;

export interface NetworkConfig {
  readonly id: SupportedChainId;
  readonly name: string;
  readonly nativeCurrency: Readonly<{ name: string; symbol: string; decimals: number }>;
  readonly publicRpc: string;
  readonly explorer: string;
  readonly testnet: boolean;
}

const network = (value: NetworkConfig): Readonly<NetworkConfig> =>
  Object.freeze({ ...value, nativeCurrency: Object.freeze({ ...value.nativeCurrency }) });

const NETWORKS: Readonly<Record<SupportedChainId, Readonly<NetworkConfig>>> = Object.freeze({
  4663: network({ ...ROBINHOOD_CHAIN, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, testnet: false }),
  56: network({ id: bsc.id, name: bsc.name, nativeCurrency: bsc.nativeCurrency, publicRpc: BSC_PUBLIC_RPC, explorer: bsc.blockExplorers.default.url, testnet: false }),
  97: network({ id: bscTestnet.id, name: bscTestnet.name, nativeCurrency: bscTestnet.nativeCurrency, publicRpc: bscTestnet.rpcUrls.default.http[0], explorer: bscTestnet.blockExplorers.default.url, testnet: true }),
});

/** Explicit lookup; unknown chains must never silently fall back to Robinhood or BSC. */
export function getNetwork(chainId: number): Readonly<NetworkConfig> {
  if (!Number.isSafeInteger(chainId) || !Object.hasOwn(NETWORKS, chainId)) throw new Error(`Unsupported chain: ${chainId}`);
  return NETWORKS[chainId as SupportedChainId];
}

/** Shared identity for chain-bound caches and the future versioned data model. */
export function assetKey(chainId: number, address: string): string {
  getNetwork(chainId);
  if (!isAddress(address, { strict: false })) throw new Error('Invalid asset address');
  return `${chainId}:${address.toLowerCase()}`;
}
