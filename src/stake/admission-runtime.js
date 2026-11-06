import { stableJSON } from '../core/canonical.js';
import { admissionInventory, prepareBond, validateBond, bondReservation, bondAck } from './admission.js';
import { stakeContext } from './price-service.js';
import { StakeLedger } from './ledger.js';
import { signFact, matchingCertificate } from './certificates.js';
import { quoteAmount, registryPair } from '../market/assets.js';
import { assertEpochAdmission } from './capacity.js';

export class StakeAdmission {
  constructor({ store, identity, registry, price, clock, request, role, trader = false }) {
    Object.assign(this, { store, identity, registry, price, clock, request, role, trader });
    this.cache = new Map();
  }
  context() { return stakeContext(this.registry()); }
  ledger(address) { return new StakeLedger({ store: this.store, context: this.context(), address }); }
  async inventoryVote({ owner, at }) {
    const c = this.context(), now = (await this.clock()).at;
    if (!c.epoch.members.some(m => m.dexKey === this.identity.publicKey) || !Number.isSafeInteger(at) || at > now || now - at > 30)
      throw new Error('Fresh original signer inventory required');
    const body = admissionInventory(this.ledger(owner.tracAddr).read(), owner, at, c.epoch.id);
    return signFact({ v: 1, networkId: c.networkId, venueKey: c.venueKey, epochId: c.epoch.id, kind: 'admission-inventory', body }, this.identity.secretKey);
  }
  async refresh(owners = []) {
    if (!this.registry()?.sellerBond) return;
    const c = this.context(), snapshot = await this.request(c.venueKey, 'priceSnapshot', {});
    await this.price.import(snapshot);
    if (this.trader) owners = [this.role.me];
    const at = (await this.clock()).at;
    for (const owner of owners.slice(0, 20)) {
      const results = await Promise.allSettled(c.epoch.members.map(m => this.request(m.dexKey, 'admissionInventory', { owner, at })));
      try {
        const inventoryCertificate = matchingCertificate(results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []), c, 'admission-inventory');
        this.cache.set(owner.dexKey, { inventoryCertificate, priceCheckpoint: snapshot.checkpoint, priceReference: snapshot.reference });
      } catch { this.cache.delete(owner.dexKey); }
    }
  }
  propose(terms, now, historyFromSlot = terms.bond?.historyFromSlot ?? 0) {
    const cached = this.cache.get(terms.seller.dexKey);
    if (!cached) throw new Error('bond_setup_unavailable');
    return prepareBond({ terms, policy: this.registry().sellerBond, context: this.context(), ...cached, priceLog: this.price.log(), now, historyFromSlot });
  }
  validate(terms, now) {
    return validateBond({ terms, policy: this.registry().sellerBond, context: this.context(), priceLog: this.price.log(), now });
  }
  reserve(state, { fromSlot, sigs }) {
    const c = this.context(), ledger = this.ledger(state.terms.seller.tracAddr), reservation = bondReservation(state.terms, state.H);
    const prior = ledger.read().reservations[bondAck(state.terms, state.H).reservationId];
    if (prior) {
      if (prior.state !== 'reserved' || stableJSON(prior.body) !== stableJSON(reservation) ||
          stableJSON(prior.admission?.terms ?? null) !== stableJSON(state.terms)) throw new Error('bond_not_reserved');
      this.store.put(`stake-retained-epoch-${prior.admission.policy.epoch.id}`, prior.admission.policy);
      return bondAck(state.terms, state.H);
    }
    assertEpochAdmission(this.store, c);
    this.validate(state.terms, state.now);
    if (!Number.isSafeInteger(fromSlot) || state.terms.bond.historyFromSlot < 1 || state.terms.bond.historyFromSlot > fromSlot) throw new Error('Finalized admission frontier required');
    // All ledgers are loaded by the encrypted store before host admission. This
    // synchronous section also serializes against withdrawal/terminal writes.
    ledger.reserve(reservation, { terms: state.terms, sigs, fromSlot: state.terms.bond.historyFromSlot, policy: this.registry().sellerBond });
    this.store.put(`stake-retained-epoch-${c.epoch.id}`, this.registry().sellerBond);
    return bondAck(state.terms, state.H);
  }
  covered(offer, now) {
    return this.coverage(offer, now) === null;
  }
  coverage(offer, now) {
    try {
      const r = this.registry(), pair = registryPair(r, offer.pair);
      this.propose({ seller: offer.maker, buyer: { boxKey: '0'.repeat(64) }, base: pair.base, baseAmount: offer.baseAmount,
        quoteAmount: quoteAmount(pair, offer.baseAmount, offer.price), fees: r.fee, sendBy: now + r.params.sendWindowSec,
        refundAfter: now + r.params.refundSec }, now);
      return null;
    } catch (error) {
      return error.code === 'bond_stale'
        ? { code: 'stake_stale', message: 'The stake check is out of date; this offer is paused until it refreshes.' }
        : { code: error.message === 'bond_price_unavailable' ? 'price_unavailable' : 'stake_short', message: 'Stake coverage is unavailable; this offer is paused.' };
    }
  }
}
