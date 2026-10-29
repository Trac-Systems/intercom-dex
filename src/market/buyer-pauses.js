import { STRIKE_WINDOW_SEC, MAX_SELLER_STRIKES, validateSeller } from '../roles/signer-strikes.js';

// Signed signer-to-venue policy, carried in the existing status text envelope. Old traders ignore signer status;
// their existing book snapshots still hide paused bids. No registry or trader wire-schema change is needed.
const PREFIX = 'buyer-pause ';
export function buyerPauseText({ tracAddr, dexKey, until }) {
  validateSeller({ tracAddr, dexKey });
  if (!Number.isSafeInteger(until) || until < 0) throw new Error('Invalid buyer pause deadline');
  return PREFIX + JSON.stringify({ tracAddr: tracAddr.toLowerCase(), dexKey, until });
}

export class BuyerPauses {
  constructor({ store, registry, now }) { Object.assign(this, { store, registry, now }); this.rows = store.get('buyer-pauses') ?? []; }
  receive(m) {
    const reg = this.registry(), now = this.now();
    if (m.kind !== 'status' || m.ch !== 'intercom-dex:signers' || !m.body.message.startsWith(PREFIX) ||
        !reg.signers.some(s => s.dexKey === m.from && s.status === 'active') || reg.removed.some(r => r.dexKey === m.from)) return false;
    let p;
    try {
      p = JSON.parse(m.body.message.slice(PREFIX.length));
      if (Object.keys(p).sort().join(',') !== 'dexKey,tracAddr,until') return false;
      validateSeller(p);
      if (!Number.isSafeInteger(p.until) || p.until < 0 || p.until > m.ts + STRIKE_WINDOW_SEC || m.ts > now + 120) return false;
    } catch { return false; }
    p.tracAddr = p.tracAddr.toLowerCase();
    // Keep clears as tombstones so an older signed refusal cannot re-pause a cleared wallet.
    const rows = this.rows.filter(r => r.at + STRIKE_WINDOW_SEC > now), prior = rows.find(r => r.from === m.from && r.tracAddr === p.tracAddr);
    if (prior && (prior.at > m.ts || prior.at === m.ts && prior.until === 0 && p.until !== 0)) return false;
    if (!prior && rows.filter(r => r.from === m.from).length >= MAX_SELLER_STRIKES) return false;
    const next = [...rows.filter(r => r !== prior), { ...p, from: m.from, at: m.ts }];
    this.store.put('buyer-pauses', next); this.rows = next; return true;
  }
  refusal(party) {
    const reg = this.registry(), now = this.now(), allowed = new Set(reg.signers.filter(s => s.status === 'active' &&
      !reg.removed.some(r => r.dexKey === s.dexKey)).map(s => s.dexKey));
    const votes = this.rows.filter(r => r.tracAddr === party.tracAddr.toLowerCase() && r.until > now && allowed.has(r.from));
    if (votes.length < reg.params.k) return null;
    // The kth longest refusal is the time until which k current signers independently refuse.
    return { until: votes.map(r => r.until).sort((a, b) => b - a)[reg.params.k - 1] };
  }
}
