import { buyerStrikeCandidate, STRIKE_HEALTH_INTERVAL_SEC, STRIKE_READ_TIMEOUT_MS } from './signer-strikes.js';
import { sellerFunds } from './signer-funds.js';
import { LOCK_START_MARGIN_SEC } from '../core/trade-buyer.js';

// Local signer observation only. No money is held and no new message from a trader is required.
export class BuyerStrikeObserver {
  constructor({ ledger, solana, trac, store, now, save, proven, health, stopped, changed = () => {}, log = () => {} }) {
    Object.assign(this, { ledger, solana, trac, store, now, save, proven, health, stopped, changed, log });
    this.pending = new Set();
  }

  install(t, resume) {
    if (t.role !== 'signer') return;
    if (!t.buyerStrikeDone && (resume || !this.ledger.enabled)) this.exempt(t, resume ? 'unobserved-window' : 'strikes-disabled');
    if (t.buyerStrikeExemption || t.buyerPaymentSeen) this.ledger.forget(t.state.tradeId, this.now());
  }

  exempt(t, reason) {
    t.buyerStrikeExemption ??= { reason, at: this.now() };
    this.save(t); this.ledger.forget(t.state.tradeId, this.now(), reason); this.changed();
  }

  evidence(t, m) {
    const s = t.state;
    if (t.role !== 'signer' || m.body.tradeId !== s.tradeId) return;
    if (m.kind === 'ack' && s.terms.committee.some(c => c.dexKey === m.from) && m.ts < s.terms.sendBy - LOCK_START_MARGIN_SEC && this.now() < s.terms.sendBy - LOCK_START_MARGIN_SEC &&
        m.body.holdUntil >= s.terms.refundAfter) {
      (t.buyerAcks ??= {})[m.from] = m.body.H; this.save(t);
    }
    if (m.from === s.terms.buyer.dexKey && m.kind === 'refunded' ||
        m.from === s.terms.seller.dexKey && ['transferSent', 'claimed'].includes(m.kind)) {
      t.buyerPaymentSeen = true; this.save(t); this.ledger.forget(s.tradeId, this.now(), 'payment-or-transfer-seen'); this.changed();
    }
    if (m.kind === 'abort' && m.ts >= (t.buyerAcceptedAt ?? Infinity) && m.ts < s.terms.sendBy + s.terms.graceSec &&
        [s.terms.buyer.dexKey, s.terms.seller.dexKey].includes(m.from)) {
      const reason = m.body.reason;
      if (/^(Signers did not confirm|Not enough .*signers online|Timed out: certificate|.*read_failed|.*gateway_rejected|.*RESET transfers are paused:|.*RPC unavailable|.*could not read Solana|No .*quorum|Too few endpoints|fetch failed)/.test(reason)) {
        this.exempt(t, 'trader-infrastructure-notice');
      }
    }
  }

  clear(party, trades) {
    for (const t of trades) if (t.role === 'signer' && t.state.terms.buyer.tracAddr.toLowerCase() === party.tracAddr.toLowerCase()) {
      t.buyerStrikeDone = true; this.exempt(t, 'operator-clear');
    }
    const result = this.ledger.clear(party, this.now()); this.changed(); return result;
  }

  tick(t) {
    const s = t.state, now = this.now(), deadline = s.terms?.sendBy + s.terms?.graceSec;
    if (t.role !== 'signer' || this.stopped() || t.buyerStrikeExemption || t.buyerPaymentSeen) return;
    if (!this.ledger.enabled) { if (!t.buyerStrikeDone) this.exempt(t, 'strikes-disabled'); return; }
    if (t.buyerAcceptedAt == null) {
      if (![s.terms.buyer.dexKey, s.terms.seller.dexKey].every(k => s.signatures?.includes(k))) return;
      if (!this.proven(s)) return;
      t.buyerAddressProven = true; t.buyerAcceptedAt = now;
      if (now >= s.terms.sendBy - LOCK_START_MARGIN_SEC) { this.exempt(t, 'late-observation'); return; }
      this.save(t);
    }
    if (now >= s.terms.refundAfter || this.pending.has(t.key) || now < (t.buyerReadAt ?? 0)) return;
    if (!t.buyerStrikeDone && t.buyerHealthAt != null && now - t.buyerHealthAt > 2 * STRIKE_HEALTH_INTERVAL_SEC) {
      this.exempt(t, 'unobserved-window'); return;
    }
    t.buyerReadAt = now + (t.buyerStrikeDone ? 300 : STRIKE_HEALTH_INTERVAL_SEC);
    this.pending.add(t.key);
    this.#read(t, deadline).catch(error => this.log('buyer strike observation', error.message)).finally(() => this.pending.delete(t.key));
  }

  async #bounded(fn) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Buyer infrastructure read timed out')), STRIKE_READ_TIMEOUT_MS); timer.unref?.();
    })]); } finally { clearTimeout(timer); }
  }

  async #read(t, deadline) {
    const s = t.state, started = this.now();
    try {
      if (!t.buyerStrikeDone) {
        const healthy = this.health?.(s.terms);
        if (healthy !== true) { this.exempt(t, 'venue-or-signers-unavailable'); return; }
        const [balances, wallet, time, gateway] = await this.#bounded(() => Promise.all([
          this.trac.balances(s.terms.seller.tracAddr), this.solana.walletBalances(s.terms.buyer.solPayer), this.solana.chainTime(),
          s.terms.base.id === 'RESET' ? this.trac.gatewayHealth() : Promise.resolve({ ok: true, eligible: 3 }),
        ]));
        if (!wallet || !['USDC', 'SOL'].every(k => typeof wallet[k] === 'string' && /^(0|[1-9][0-9]*)$/.test(wallet[k])) ||
            !Number.isSafeInteger(time) || time < started - 60 || gateway?.ok !== true || !Number.isSafeInteger(gateway.eligible) || gateway.eligible < 3) {
          this.exempt(t, 'chain-or-gateway-unavailable'); return;
        }
        // The seller signed the terms and could deliver the entire trade, including other reserved sends and fees.
        if (!sellerFunds({ state: s, balances, store: this.store, now: started }).ok) { this.exempt(t, 'seller-not-ready'); return; }
        if (this.now() - started > 2 * STRIKE_HEALTH_INTERVAL_SEC) { this.exempt(t, 'unobserved-window'); return; }
        t.buyerSellerReady = true; t.buyerHealthAt = started; this.save(t);
      }
      if (started < deadline) return;
      if (s.H && Object.values(t.buyerAcks ?? {}).filter(H => H === s.H).length < s.terms.k) {
        this.exempt(t, 'signers-did-not-confirm'); return;
      }
      const payment = await this.#bounded(() => this.solana.buyerPayment({ terms: s.terms, after: deadline }));
      if (this.stopped() || !this.ledger.enabled || t.buyerStrikeExemption) return;
      if (payment?.ok !== true) {
        if (!t.buyerStrikeDone && payment?.reason !== 'chain-behind') this.exempt(t, 'payment-read-failed');
        return;
      }
      if (payment.seen === true) {
        t.buyerPaymentSeen = true; this.save(t); this.ledger.forget(s.tradeId, this.now(), 'payment-seen'); this.changed(); return;
      }
      if (payment.seen !== false || !Number.isSafeInteger(payment.chainTime) || payment.chainTime < deadline) return;
      if (!t.buyerStrikeDone && buyerStrikeCandidate(t, this.now())) {
        this.ledger.record(s.terms.buyer, s.tradeId, this.now());
        t.buyerStrikeDone = true; this.save(t); this.changed();
      }
    } catch (error) {
      if (!t.buyerStrikeDone) this.exempt(t, 'infrastructure-read-failed');
      this.log('buyer strike read failed', s.tradeId, error.message);
    }
  }
}
