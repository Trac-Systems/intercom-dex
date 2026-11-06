import { allocatePieces, penaltyTarget } from './amounts.js';
import { quoteAmount, registryPair } from '../market/assets.js';
import { stableJSON } from '../core/canonical.js';
import { OfferBook } from '../market/book.js';
import { publicReceiver, validOffer } from '../roles/common.js';

// Every signer retains its own authenticated live maker announcements. A venue
// may select a funded subset, but cannot invent an offer or enlarge its size.
export class RewardOffers {
  constructor({ bridge, registry, now = () => Math.floor(Date.now() / 1000) }) {
    Object.assign(this, { bridge, registry, now }); this.book = new OfferBook(); this.receive = publicReceiver(now);
    this.listener = (ch, raw) => {
      if (ch !== 'intercom-dex:offers') return;
      const m = this.receive(raw), p = this.registry()?.sellerBond;
      if (!m || m.ch !== ch || !p) return;
      if (m.kind === 'offer' && validOffer(m.body, m.from, { networkId: p.networkId, required: true, now: this.now() })) this.book.add(m.body, this.now());
      if (m.kind === 'cancel') this.book.cancel(m.body.offerId, m.from);
    };
  }
  async start() { this.bridge.on('message', this.listener); await this.bridge.join('intercom-dex:offers'); }
  stop() { this.bridge.off('message', this.listener); }
  snapshot() { return (this.registry()?.pairs ?? []).flatMap(p => this.book.snapshot(p.pair, this.now())); }
}

export function verifyObservedOffers(proposed, observed, at) {
  if (!Array.isArray(proposed) || proposed.length > 2000 || new Set(proposed.map(o => o.offerId)).size !== proposed.length) throw new Error('Invalid live reward offers');
  for (const offer of proposed) {
    const own = observed.find(o => o.offerId === offer.offerId);
    if (!own || own.expiresAt <= at || !/^[1-9][0-9]*$/.test(offer.baseAmount) || BigInt(offer.baseAmount) > BigInt(own.baseAmount) ||
        stableJSON({ ...own, baseAmount: offer.baseAmount }) !== stableJSON(offer)) throw new Error('Live reward offer was not independently observed');
  }
}

export function liveRewardBook({ inventory, offers, registry, settings, price, at }) {
  const used = new Set(), backing = [];
  for (const o of [...offers].filter(o => o.side === 'sell' && o.expiresAt > at).sort((a, b) => a.offerId.localeCompare(b.offerId))) {
    const account = inventory.accounts.find(a => a.address === o.maker.tracAddr);
    if (!account) continue;
    const pair = registryPair(registry, o.pair);
    const target = penaltyTarget({ base: pair.base, baseAmount: o.baseAmount, quoteAmount: quoteAmount(pair, o.baseAmount, o.price), fees: registry.fee }, price, settings).targetReset;
    const candidates = account.pieces.filter(p => !used.has(p.unitId) && p.purpose === 'seller' && ['free', 'reserved'].includes(p.state))
      .map(p => ({ ...p, expiresAt: 0 }));
    const allocation = allocatePieces(candidates, target);
    if (!allocation) continue;
    for (const p of allocation.pieces) { used.add(p.unitId); backing.push({ address: account.address, unitId: p.unitId, amount: p.principalReset }); }
  }
  return { height: inventory.height, blockHash: inventory.blockHash, backing: backing.sort((a, b) => a.unitId.localeCompare(b.unitId)) };
}
