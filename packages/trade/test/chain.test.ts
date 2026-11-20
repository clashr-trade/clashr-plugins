import { createPublicClient, http } from 'viem';
import { describe, expect, it } from 'vitest';
import { assertLegacyTradeClient, robinhoodChain, tradeChain } from '../src/chain';

describe('execution chain boundaries', () => {
  it('preserves legacy chain metadata and exposes BSC metadata separately', () => {
    expect(tradeChain(4663)).toBe(robinhoodChain);
    expect(tradeChain(56).nativeCurrency.symbol).toBe('BNB');
    expect(tradeChain(97).testnet).toBe(true);
    expect(() => tradeChain(1)).toThrow();
  });
  it('refuses to use a BSC client with legacy trading encoders without contacting RPC', () => {
    for (const id of [56, 97]) {
      const client = createPublicClient({ chain: tradeChain(id), transport: http('https://unused.invalid') });
      expect(() => assertLegacyTradeClient(client)).toThrow('only supports Robinhood');
    }
    expect(() => assertLegacyTradeClient(createPublicClient({ chain: robinhoodChain, transport: http('https://unused.invalid') }))).not.toThrow();
  });
});
