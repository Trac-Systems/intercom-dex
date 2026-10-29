import { z } from 'zod';

// Each signer keeps its own evidence. No stake or deposit; buyer pause decisions reach the venue in status text.
export const STRIKE_WINDOW_SEC = 7 * 86400;
export const MAX_SELLER_STRIKES = 4096;
export const STRIKE_HEALTH_INTERVAL_SEC = 15;
export const STRIKE_READ_TIMEOUT_MS = 30_000;
const settingsSchema = z.object({ enabled: z.boolean().default(false) }).strict();
export const strikeSettings = input => settingsSchema.parse(input === undefined ? {} : input);

// Existing sellers report a failed send in a signed abort. The gateway message is truncated to 160 characters
// by the host; match its stable prefix. Generic send_failed/insufficient-funds errors are not outage evidence.
export function sellerInfrastructureNotice(trade, message) {
  const { terms, tradeId } = trade.state;
  if (message.kind !== 'abort' || message.from !== terms.seller.dexKey || message.body.tradeId !== tradeId ||
      message.ts < trade.sellerStrikeWindowStart || message.ts >= terms.refundAfter) return false;
  const prefix = 'Transfer not sent before the deadline: ';
  if (!message.body.reason.startsWith(prefix)) return false;
  const reason = message.body.reason.slice(prefix.length);
  return reason.startsWith('RESET transfers are paused:') ||
    ['read_failed', 'gateway_rejected', 'reset_gateway_required', 'invalid_gateway_response'].includes(reason);
}

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
    !trade.sellerStrikeExemption &&
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
  constructor({ store, log = () => {}, cap = MAX_SELLER_STRIKES, enabled = false, party = 'seller' }) {
    if (!Number.isSafeInteger(cap) || cap < 2) throw new Error('Invalid strike cap');
    if (typeof enabled !== 'boolean') throw new Error('Invalid strikes.enabled');
    if (!['seller', 'buyer'].includes(party)) throw new Error('Invalid strike party');
    Object.assign(this, { store, log, cap, enabled, party, recordName: `${party}-strikes` });
  }

  list(now) {
    const record = this.store.get(this.recordName) ?? { strikes: [], refusals: [] };
    // Pre-proof strikes could name somebody else's address. Never promote those into address-wide refusals.
    return { strikes: record.strikes.filter(s => s.proven === true && s.at + STRIKE_WINDOW_SEC > now),
      refusals: record.refusals.filter(r => r.proven === true && r.until > now) };
  }

  refusal(seller, now) { return this.enabled ? this.list(now).refusals.find(r => sameSeller(r, seller)) ?? null : null; }

  record(seller, tradeId, now) {
    if (!this.enabled) return false;
    // The host calls this only for a trade whose address proof passed before its first ack.
    const data = this.list(now);
    if (data.strikes.some(s => s.tradeId === tradeId)) return false;
    const entry = { ...validateSeller(seller), proven: true, tradeId, at: now };
    data.strikes.push(entry);
    const refusal = refusalFor(seller, data.strikes);
    if (refusal && !data.refusals.some(r => sameSeller(r, seller))) data.refusals.push(refusal);
    data.strikes = data.strikes.sort(oldestFirst).slice(-this.cap);
    data.refusals = data.refusals.sort(oldestFirst).slice(-this.cap);
    this.store.put(this.recordName, data);
    this.log(`${this.party} strike tradeId=${tradeId} ${this.party}=${seller.tracAddr} identity=${seller.dexKey} at=${now}`);
    return true;
  }

  // Late authenticated transfer evidence cancels its strike and any refusal that depended on it.
  forget(tradeId, now, reason = 'transfer-or-completion-seen') {
    const data = this.list(now), strikes = data.strikes.filter(s => s.tradeId !== tradeId),
      refusals = data.refusals.filter(r => !r.tradeIds.includes(tradeId));
    if (strikes.length === data.strikes.length && refusals.length === data.refusals.length) return;
    for (const prior of data.refusals.filter(r => r.tradeIds.includes(tradeId))) {
      const remaining = refusalFor(prior, strikes);
      if (remaining) refusals.push(remaining);
    }
    this.store.put(this.recordName, { strikes, refusals });
    this.log(`${this.party} strike clear tradeId=${tradeId} reason=${reason}`);
  }

  clear(seller, now) {
    validateSeller(seller);
    const data = this.list(now), strikes = data.strikes.filter(s => !sameSeller(s, seller)),
      refusals = data.refusals.filter(r => !sameSeller(r, seller));
    this.store.put(this.recordName, { strikes, refusals });
    this.log(`${this.party} strike clear ${this.party}=${seller.tracAddr} identity=${seller.dexKey} strikes=${data.strikes.length - strikes.length} refusals=${data.refusals.length - refusals.length}`);
    return { cleared: true, strikes: data.strikes.length - strikes.length, refusals: data.refusals.length - refusals.length };
  }
}

export class BuyerStrikes extends SellerStrikes {
  constructor(options) { super({ ...options, party: 'buyer' }); }
}

export const BUYER_PAUSED_MESSAGE = 'Your bids are paused for 7 days: 2 trades were accepted but never paid';

// Both parties signed the exact terms, the seller was able to deliver, and the whole payment window was observed.
// The host still needs a fresh, definitive Solana absence check; silence alone is never evidence of no payment.
export function buyerStrikeCandidate(trade, now) {
  const s = trade.state, deadline = s.terms.sendBy + s.terms.graceSec;
  return trade.role === 'signer' && trade.buyerAddressProven === true && Number.isSafeInteger(trade.buyerAcceptedAt) &&
    trade.buyerAcceptedAt < s.terms.sendBy && trade.buyerSellerReady === true &&
    !trade.buyerStrikeExemption && !trade.buyerPaymentSeen && !trade.sellerTransferSeen && !s.txHash &&
    s.finalizedAt == null && s.phase !== 'published' && now >= deadline && now < deadline + STRIKE_WINDOW_SEC;
}
