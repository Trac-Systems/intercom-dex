import { EventEmitter } from 'node:events';
import { generateIdentity, encodeKey } from '../../../src/core/keys.js';
import { seal } from '../../../src/core/envelope.js';
import { offerIdOf, random32 } from '../../../src/roles/common.js';
import { fixture, SOL, SIG, hex } from '../core/helpers.mjs';
import { MarketFeed } from '../../../src/roles/market-feed.js';

export function memoryStore(seed = {}) {
  const data = new Map(Object.entries(seed));
  return { get: key => structuredClone(data.get(key) ?? null), put: (key, value) => data.set(key, structuredClone(value)),
    list: prefix => [...data.keys()].filter(k => k.startsWith(prefix)), delete: key => data.delete(key) };
}
export class FakeBridge extends EventEmitter {
  sent = []; joined = [];
  async join(channel) { this.joined.push(channel); }
  async setRelays(keys) { this.relays = keys; }
  async send(channel, envelope) { this.sent.push({ channel, envelope }); }
}
export function setup({ store = memoryStore(), profile, clock = { t: 200000 }, f = fixture({ pair: 'RESET/USDC' }), key = generateIdentity() } = {}) {
  const bridge = new FakeBridge(), identity = { publicKey: encodeKey(key.publicKey), secretKey: encodeKey(key.secretKey) };
  profile ??= { mint: f.terms.mint, platformCollector: f.terms.fees.platformCollector, chatRelays: [identity.publicKey] };
  const feed = new MarketFeed({ bridge, identity, store, serviceKey: encodeKey(f.service.publicKey), profile, now: () => clock.t });
  const wire = (kind, body, from = f.service, ch = 'intercom-dex') => seal({ kind, ch, body }, from.secretKey, { ts: clock.t, nonce: random32() });
  const send = (kind, body, from, ch = 'intercom-dex') => feed.receive(ch, wire(kind, body, from, ch));
  const offer = (extra = {}) => {
    const row = { pair: 'RESET/USDC', side: 'sell', baseAmount: '500000000000', price: '0.42',
      maker: { dexKey: f.terms.seller.dexKey, tracAddr: f.terms.seller.tracAddr, solAddr: f.terms.seller.solRecipient },
      peerKey: hex(), expiresAt: clock.t + 1000, registryVersion: 1, software: '0.1.0', ...extra };
    return { ...row, offerId: offerIdOf(row) };
  };
  const trade = (extra = {}) => ({ tradeId: hex(), pair: 'RESET/USDC', price: '0.42', registryVersion: 1,
    baseAmount: '120000000000', quoteAmount: '504000000', ts: clock.t, termsHash: hex(), escrowAddress: SOL, claimSignature: SIG, tracTxHash: hex(),
    seller: { tracAddr: f.terms.seller.tracAddr, solAddr: f.terms.seller.solRecipient },
    buyer: { tracAddr: f.terms.buyer.tracAddr, solAddr: f.terms.buyer.solPayer }, ...extra });
  return { f, feed, key, identity, store, clock, bridge, profile, wire, send, offer, trade,
    view: () => JSON.parse(feed.view().json), register: () => send('registry', f.registry) };
}
