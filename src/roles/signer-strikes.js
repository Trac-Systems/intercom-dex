// Local signer policy only. No stake, deposit, shared reputation or protocol messages.
export const STRIKE_WINDOW_SEC = 7 * 86400;
export const MAX_SELLER_STRIKES = 4096;
const RECORD = 'seller-strikes';
const sameSeller = (a, b) => a.tracAddr.toLowerCase() === b.tracAddr.toLowerCase();
const oldestFirst = (a, b) => a.at - b.at;
const refusalFor = (seller, strikes) => {
  const own = strikes.filter(s => sameSeller(s, seller)).sort(oldestFirst);
  if (own.length < 2) return null;
  return { ...validateSeller(seller), proven: true, at: own[1].at, until: own[1].at + STRIKE_WINDOW_SEC,
    tradeIds: own.slice(0, 2).map(s => s.tradeId) };
};

export function strikeCandidate(trade, now) {
  const s = trade.state;
  return trade.role === 'signer' && s.sellerAddressProven === true && Number.isSafeInteger(trade.signerAckedAt) && !!s.H &&
    !trade.sellerTransferSeen && !trade.sellerClaimed && !s.txHash && s.finalizedAt == null &&
    !['published', 'complete', 'aborted'].includes(s.phase) &&
    ![...(trade.raw ?? []), ...(trade.buffer ?? [])].some(m => m.kind === 'transferSent' && m.from === s.terms.seller.dexKey) &&
    now >= s.terms.sendBy + s.terms.graceSec && now < s.terms.sendBy + s.terms.graceSec + STRIKE_WINDOW_SEC;
}

export function validateSeller({ tracAddr, dexKey } = {}) {
  if (typeof tracAddr !== 'string' || !tracAddr.length || tracAddr.length > 256 || /\s/.test(tracAddr) ||
      typeof dexKey !== 'string' || !/^[0-9a-f]{64}$/.test(dexKey)) throw new Error('Provide the exact seller Trac address and DEX identity key');
  return { tracAddr: tracAddr.toLowerCase(), dexKey };
}

// One atomic encrypted record, with independent caps for strikes and refusals. Refusals retain the two triggering
// trade ids after the first strike expires, so the full seven days from the second strike survives a restart.
export class SellerStrikes {
  constructor({ store, log = () => {}, cap = MAX_SELLER_STRIKES }) {
    if (!Number.isSafeInteger(cap) || cap < 2) throw new Error('Invalid strike cap');
    Object.assign(this, { store, log, cap });
  }

  list(now) {
    const record = this.store.get(RECORD) ?? { strikes: [], refusals: [] };
    // Pre-proof strikes could name somebody else's address. Never promote those into address-wide refusals.
    return { strikes: record.strikes.filter(s => s.proven === true && s.at + STRIKE_WINDOW_SEC > now),
      refusals: record.refusals.filter(r => r.proven === true && r.until > now) };
  }

  refusal(seller, now) { return this.list(now).refusals.find(r => sameSeller(r, seller)) ?? null; }

  record(seller, tradeId, now) {
    // The host calls this only for a trade whose address proof passed before its first ack.
    const data = this.list(now);
    if (data.strikes.some(s => s.tradeId === tradeId)) return false;
    const entry = { ...validateSeller(seller), proven: true, tradeId, at: now };
    data.strikes.push(entry);
    const refusal = refusalFor(seller, data.strikes);
    if (refusal && !data.refusals.some(r => sameSeller(r, seller))) data.refusals.push(refusal);
    data.strikes = data.strikes.sort(oldestFirst).slice(-this.cap);
    data.refusals = data.refusals.sort(oldestFirst).slice(-this.cap);
    this.store.put(RECORD, data);
    this.log(`seller strike tradeId=${tradeId} seller=${seller.tracAddr} identity=${seller.dexKey} at=${now}`);
    return true;
  }

  // Late authenticated transfer evidence cancels its strike and any refusal that depended on it.
  forget(tradeId, now) {
    const data = this.list(now), strikes = data.strikes.filter(s => s.tradeId !== tradeId),
      refusals = data.refusals.filter(r => !r.tradeIds.includes(tradeId));
    if (strikes.length === data.strikes.length && refusals.length === data.refusals.length) return;
    for (const prior of data.refusals.filter(r => r.tradeIds.includes(tradeId))) {
      const remaining = refusalFor(prior, strikes);
      if (remaining) refusals.push(remaining);
    }
    this.store.put(RECORD, { strikes, refusals });
    this.log(`seller strike clear tradeId=${tradeId} reason=transfer-or-completion-seen`);
  }

  clear(seller, now) {
    validateSeller(seller);
    const data = this.list(now), strikes = data.strikes.filter(s => !sameSeller(s, seller)),
      refusals = data.refusals.filter(r => !sameSeller(r, seller));
    this.store.put(RECORD, { strikes, refusals });
    this.log(`seller strike clear seller=${seller.tracAddr} identity=${seller.dexKey} strikes=${data.strikes.length - strikes.length} refusals=${data.refusals.length - refusals.length}`);
    return { cleared: true, strikes: data.strikes.length - strikes.length, refusals: data.refusals.length - refusals.length };
  }
}
