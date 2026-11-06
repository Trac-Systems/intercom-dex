import { readFileSync } from 'node:fs';
import { isMainThread } from 'node:worker_threads';
// Explicitly preloaded only by the fresh local stake-penalty stack. Production
// terms retain the signed 24-hour window; only this test clock is accelerated.
import { PenaltySigner } from '../../src/stake/penalty-signer.js';
import { Trader } from '../../src/roles/trader.js';
// Native cryptographic workers inherit preloads without the role argv.
if (isMainThread) {
  if (!process.env.DEX_E2E_ATTACK_FILE) throw new Error('Local stack fixture required');
  const configIndex = process.argv.indexOf('--config');
  const config = configIndex >= 0 && JSON.parse(readFileSync(process.argv[configIndex + 1], 'utf8'));
  if (config?.network !== 'local' || !config.solana?.endpoints?.length || config.solana.endpoints.some(endpoint => !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname)))
    throw new Error('Penalty acceleration is restricted to the local stack');
  const start = Trader.prototype.start;
  Trader.prototype.start = function() {
    const lock = this.host.solana.lockEscrow.bind(this.host.solana);
    const held = new Set();
    this.host.solana.lockEscrow = input => {
      const attack = JSON.parse(readFileSync(process.env.DEX_E2E_ATTACK_FILE, 'utf8'));
      if (attack.kind === 'stake-buyer-no-lock') held.add(input.hashHex);
      if (held.has(input.hashHex)) {
        console.log('DEX_E2E_STAKE_LOCK_WITHHELD', input.hashHex);
        return Promise.resolve({ ok: false, unknown: true, hashHex: input.hashHex, reason: 'local buyer withholds lock' });
      }
      return lock(input);
    };
    return start.call(this);
  };
  const available = Trader.prototype.availableOffer;
  Trader.prototype.availableOffer = function(id, now = Math.floor(Date.now() / 1000)) {
    const result = available.call(this, id, now);
    if (process.env.DEX_E2E_AVAILABILITY_TRACE === '1' && !result && this.offers.has(id) && this.offers.get(id).from !== this.identity.publicKey && this.lastAvailabilityTrace !== now) {
      this.lastAvailabilityTrace = now;
      const seen = this.offers.get(id), pair = seen.offer.pair;
      console.log('DEX_E2E_OFFER_UNAVAILABLE', JSON.stringify({ now, id, lastSeen: seen.lastSeen, firstSeen: seen.firstSeen,
        expiresAt: seen.offer.expiresAt, inventory: this.bookView.inventory.get(pair), book: this.book.get(pair) }));
    }
    return result;
  };
  PenaltySigner.prototype.timing = function(terms) {
    return { triggerAt: process.env.DEX_E2E_HANDOFF === '1' ? terms.sendBy + 5 : terms.sendBy - 400, windowSec: 20 };
  };

  const apply = PenaltySigner.prototype.apply;
  PenaltySigner.prototype.apply = async function(method, body, from) {
    const selected = JSON.parse(readFileSync(process.env.DEX_E2E_ATTACK_FILE, 'utf8'));
    if (method !== 'penaltySample' || !selected.stakePause) return apply.call(this, method, body, from);
    const health = this.health; this.health = async () => false;
    try { return await apply.call(this, method, body, from); } finally { this.health = health; }
  };
}
