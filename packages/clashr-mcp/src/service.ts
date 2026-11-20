import { formatEther, type Address } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import { statementFor } from '@rushr/agents/siwe';
import { Refusal, type Config } from './config.ts';
import { createWalletFile, loadWallet } from './wallet.ts';
import { createApi } from './api.ts';
import { assertQuote, type Chain, type Quote } from './chain.ts';

export class Clashr {
  private wallet;
  private readonly api;
  private readonly quotes = new Map<string, Quote>();
  private registering = false;
  constructor(
    readonly config: Config,
    private readonly chain: Chain,
    fetcher?: typeof fetch,
  ) {
    this.wallet = loadWallet(config.walletFile, config.apiUrl);
    this.api = createApi(config, () => this.wallet?.apiKey(), fetcher);
  }
  private async check(rpc = false) {
    const health = await this.api('/health');
    if (health.chainId !== 56 || health.product !== 'bnb' || health.ok !== true)
      throw new Refusal('wrong_api_chain', 'Expected an independent, healthy BNB product');
    if (rpc && (await this.chain.chainId()) !== 56)
      throw new Refusal('wrong_rpc_chain', 'RPC must report BNB mainnet chain ID 56');
  }
  private account() {
    if (!this.wallet)
      throw new Refusal('no_wallet', 'Call create_wallet or configure CLASHR_WALLET_FILE');
    return this.wallet;
  }
  async createWallet() {
    if (this.wallet) throw new Refusal('wallet_exists', 'This server already has a wallet');
    const address = createWalletFile(this.config.walletFile);
    this.wallet = loadWallet(this.config.walletFile, this.config.apiUrl);
    return {
      address,
      chainId: 56,
      next: 'Register this address with your chosen handle. BNB funding is needed only for gas-aware simulation and future trading.',
      transactionsEnabled: false,
    };
  }
  async status() {
    await this.check(true);
    if (!this.wallet)
      return {
        chainId: 56,
        wallet: null,
        dryRun: true,
        transactionsEnabled: false,
        next: 'Call create_wallet to make a dedicated local agent wallet',
      };
    const balance = await this.chain.balance(this.wallet.address);
    const member = this.wallet.apiKey() ? await this.api('/v1/agents/me', undefined, true) : null;
    return {
      chainId: 56,
      address: this.wallet.address,
      balanceBnb: formatEther(balance),
      member: member?.member ?? null,
      dryRun: true,
      transactionsEnabled: false,
      maxBuyBnb: formatEther(this.config.maxBuyWei),
    };
  }
  async register(input: {
    handle: string;
    displayName?: string;
    bio?: string;
    recoverKey?: boolean;
  }) {
    if (this.registering) throw new Refusal('busy', 'Registration is already in progress');
    this.registering = true;
    try {
      await this.check(true);
      const wallet = this.account();
      if (wallet.apiKey() && !input.recoverKey)
        return {
          status: 'already_registered',
          ...(await this.api('/v1/agents/me', undefined, true)),
        };
      const prove = async (purpose: 'register' | 'login') => {
        const challenge = await this.api(
          `/v1/auth/nonce?${new URLSearchParams({ address: wallet.address, purpose })}`,
        );
        const message = challenge.message;
        if (typeof message !== 'string' || message.length > 4000)
          throw new Refusal('invalid_challenge', 'Invalid wallet challenge');
        const proof = parseSiweMessage(message),
          now = new Date(),
          origin = new URL(this.config.productOrigin);
        if (
          proof.chainId !== 56 ||
          proof.domain !== origin.host ||
          proof.uri !== origin.origin ||
          proof.version !== '1' ||
          proof.address?.toLowerCase() !== wallet.address.toLowerCase() ||
          proof.statement !== statementFor(purpose) ||
          proof.nonce !== challenge.nonce ||
          !proof.issuedAt ||
          !proof.expirationTime ||
          proof.resources?.length !== 1 ||
          proof.resources[0] !== `${origin.origin}/terms` ||
          now.getTime() - proof.issuedAt.getTime() > 600000 ||
          proof.issuedAt.getTime() > now.getTime() + 60000 ||
          proof.expirationTime.getTime() - proof.issuedAt.getTime() > 600000 ||
          !validateSiweMessage({ message: proof, domain: origin.host, time: now })
        )
          throw new Refusal(
            'invalid_challenge',
            'Refusing a challenge for a different wallet, chain, domain, purpose or time window',
          );
        return { message, signature: await wallet.signMessage(message) };
      };
      // Recovery explicitly rotates the key; it is never an automatic retry.
      const purpose = input.recoverKey ? 'login' : 'register';
      const proof = await prove(purpose);
      const data = await this.api(
        `/v1/agents/${purpose}`,
        purpose === 'login'
          ? proof
          : { ...proof, handle: input.handle, displayName: input.displayName, bio: input.bio },
      );
      const member = data.member,
        key = data.apiKey;
      if (
        member?.kind !== 'agent' ||
        member?.wallet?.toLowerCase() !== wallet.address.toLowerCase() ||
        typeof member.id !== 'string' ||
        typeof member.handle !== 'string' ||
        typeof key?.key !== 'string' ||
        !key.key.startsWith('rk_') ||
        typeof key.id !== 'string'
      )
        throw new Refusal('invalid_registration', 'API returned an inconsistent agent identity');
      wallet.saveRegistration({
        handle: member.handle,
        memberId: member.id,
        apiKeyId: key.id,
        apiKey: key.key,
        apiOrigin: this.config.apiUrl,
      });
      return {
        status: purpose === 'login' ? 'key_recovered' : 'registered',
        member,
        apiKeyStoredLocally: true,
      };
    } finally {
      this.registering = false;
    }
  }
  async scan(column: 'new' | 'almost' | 'migrated', limit: number) {
    await this.check();
    const data = await this.api('/flap/market');
    if (
      data.chainId !== 56 ||
      data.provenance !== 'finalized-onchain' ||
      !Array.isArray(data.items)
    )
      throw new Refusal('invalid_market', 'Expected finalized BNB index data');
    const items = data.items
      .filter(
        (item: any) =>
          item.chainId === 56 &&
          (column === 'migrated'
            ? item.listed
            : !item.listed && (column === 'almost' ? item.progress >= 50 : item.progress < 50)),
      )
      .slice(0, limit);
    return {
      chainId: 56,
      column,
      items,
      cursor: data.cursor,
      stale: data.stale,
      lagBlocks: data.lagBlocks,
    };
  }
  async token(address: Address) {
    await this.check();
    const [market, safety] = await Promise.all([
      this.api(`/flap/market?address=${address.toLowerCase()}`),
      this.api(`/v1/tokens/${address.toLowerCase()}/safety`),
    ]);
    if (market.chainId !== 56 || safety.chainId !== 56)
      throw new Refusal('wrong_api_chain', 'Token data must identify chain 56');
    return {
      chainId: 56,
      token:
        market.items?.find(
          (item: any) => item.coin?.address?.toLowerCase() === address.toLowerCase(),
        ) ?? null,
      safety: safety.safety,
      note: 'Missing safety coverage is unknown, not a passing verdict.',
    };
  }
  async feed(limit: number) {
    await this.check();
    return this.api(`/v1/feed?limit=${limit}`);
  }
  async leaderboard(window: string, kind: string, limit: number) {
    await this.check();
    return this.api(
      `/v1/leaderboard?${new URLSearchParams({ window, kind, limit: String(limit) })}`,
    );
  }
  async quote(input: {
    token: Address;
    side: 'buy' | 'sell';
    amountIn: string;
    venue: 'flap' | 'pancake';
    trader?: Address;
  }) {
    await this.check(true);
    const trader = this.wallet?.address ?? input.trader;
    if (!trader)
      throw new Refusal(
        'no_trader',
        'Configure a wallet or provide a public trader address for quote preview',
      );
    if (input.trader && input.trader.toLowerCase() !== trader.toLowerCase())
      throw new Refusal('wrong_trader', 'Quote must use the configured wallet');
    const amountIn = BigInt(input.amountIn);
    if (input.side === 'buy' && amountIn > this.config.maxBuyWei)
      throw new Refusal('buy_cap', 'Buy exceeds CLASHR_MAX_BUY_BNB');
    const safety = await this.api(`/v1/tokens/${input.token.toLowerCase()}/safety`);
    if (safety.chainId !== 56) throw new Refusal('wrong_api_chain', 'Expected BNB safety response');
    if (input.side === 'buy' && safety.safety?.blocked === true)
      throw new Refusal('blocked_token', 'Token is blocked by the Clashr API');
    const quote = await this.chain.quote(
      {
        chainId: 56,
        token: input.token,
        trader,
        side: input.side,
        amountIn,
        slippageBps: this.config.slippageBps,
      },
      input.venue,
    );
    assertQuote(quote);
    if (
      quote.request.trader.toLowerCase() !== trader.toLowerCase() ||
      quote.request.token.toLowerCase() !== input.token.toLowerCase() ||
      quote.request.side !== input.side ||
      quote.request.amountIn !== amountIn ||
      quote.request.slippageBps !== this.config.slippageBps ||
      (input.venue === 'flap') !== (quote.venue === 'flap')
    )
      throw new Refusal('quote_mismatch', 'Quote does not match requested trade');
    for (const [id, q] of this.quotes) if (q.expiresAt <= Date.now() / 1000) this.quotes.delete(id);
    if (this.quotes.size >= 100) this.quotes.delete(this.quotes.keys().next().value!);
    this.quotes.set(quote.id, quote);
    return {
      chainId: 56,
      quote,
      safety: safety.safety,
      dryRun: true,
      inputAsset: input.side === 'buy' ? 'BNB' : input.token,
      outputAsset:
        quote.venue === 'flap' ? quote.outputToken : input.side === 'buy' ? input.token : 'BNB',
      note: 'Quote only. No approval, signature or transaction was submitted.',
    };
  }
  async dryRun(id: string) {
    await this.check(true);
    const quote = this.quotes.get(id);
    if (!quote)
      throw new Refusal('quote_not_found', 'Quote must be created in this server session');
    assertQuote(quote);
    const safety = await this.api(`/v1/tokens/${quote.request.token}/safety`);
    if (safety.chainId !== 56) throw new Refusal('wrong_api_chain', 'Expected BNB safety response');
    if (quote.request.side === 'buy' && safety.safety?.blocked === true)
      throw new Refusal('blocked_token', 'Token safety changed; simulation refused');
    const simulation = await this.chain.simulate(quote);
    return {
      chainId: 56,
      dryRun: true,
      signed: false,
      broadcast: false,
      simulation,
      safety: safety.safety,
      note: 'Uses actual balances and allowances. An unfunded wallet or unsupported simulation RPC will fail; no balance overrides are used.',
    };
  }
}
