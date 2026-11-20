import { describe, expect, it } from 'vitest';
import { assetKey, getNetwork, LEGACY_CHAIN_ID } from '../src/chain/networks';
import { ROBINHOOD_CHAIN } from '../src/chain/robinhood';

describe('network identity', () => {
  it('preserves the legacy network and native currency', () => {
    expect(LEGACY_CHAIN_ID).toBe(ROBINHOOD_CHAIN.id);
    expect(getNetwork(4663).publicRpc).toBe(ROBINHOOD_CHAIN.publicRpc);
    expect(getNetwork(4663).nativeCurrency.symbol).toBe('ETH');
    expect(getNetwork(56).nativeCurrency.symbol).toBe('BNB');
    expect(getNetwork(97).testnet).toBe(true);
  });
  it('rejects unsupported IDs and protects shared configuration', () => {
    for (const id of [0, 1, 56.1, NaN, Infinity, '56' as unknown as number]) expect(() => getNetwork(id)).toThrow('Unsupported chain');
    expect(Object.isFrozen(getNetwork(56))).toBe(true);
    expect(Object.isFrozen(getNetwork(56).nativeCurrency)).toBe(true);
  });
  it('keeps identical addresses on different networks distinct', () => {
    const address = '0xABCDEF0000000000000000000000000000000000';
    expect(assetKey(56, address)).not.toBe(assetKey(4663, address));
    expect(assetKey(56, address)).toBe(assetKey(56, address.toLowerCase()));
    expect(() => assetKey(56, 'BNB')).toThrow('Invalid asset');
    expect(() => assetKey(1, address)).toThrow('Unsupported chain');
  });
});
