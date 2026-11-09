import { StakeLedger } from './ledger.js';
import { stakeContext } from './price-service.js';
import { matchingCertificate } from './certificates.js';
import { sha256Hex, stableJSON } from '../core/canonical.js';
import { fundingNonce } from '../locks/trac-lock.js';

export const FUNDING_RECOVERY_MS = 60000;
export const FUNDING_RECOVERY_PAGE = 8;

// Old apps retain each original transfer intent even after replacing their
// current deposit operation. Only its public receipt fields leave this process.
export function fundingReceipts(store, piece) {
  const id = piece.unitId, saved = store.get(`stake-client-funding-${id}`);
  if (saved) return saved;
  const funding = {};
  for (const asset of ['TNK', 'RESET']) {
    const intent = store.get(`locks-trac-${sha256Hex(`stake-fund:${id}:${asset}`)}`);
    if (!intent || intent.asset !== asset || intent.from !== piece.descriptor.owner.tracAddr || intent.to !== piece.address ||
        intent.amount !== (asset === 'RESET' ? piece.descriptor.principalReset : piece.descriptor.tnkReserve) ||
        intent.nonce !== fundingNonce(id, asset) || !/^[0-9a-f]{64}$/.test(intent.txHash)) return null;
    funding[asset] = intent.txHash;
  }
  return funding;
}

export class FundingRecovery {
  constructor({ store, registry, owner, clock, request, now = Date.now }) {
    Object.assign(this, { store, registry, owner, clock, request, now }); this.last = -Infinity;
  }
  async tick() {
    const state = this.store.get('stake-funding-recovery') ?? { after: '', confirmed: {} };
    if (this.running || this.now() - Math.max(this.last, state.lastAt ?? -Infinity) < FUNDING_RECOVERY_MS || !this.registry()?.sellerBond) return false;
    this.running = true; this.last = this.now();
    try {
      state.lastAt = this.last; this.store.put('stake-funding-recovery', state);
      await this.page(); return true;
    } finally { this.running = false; }
  }
  async page() {
    const context = stakeContext(this.registry()), ledger = new StakeLedger({ store: this.store, context, address: this.owner.tracAddr });
    const state = this.store.get('stake-funding-recovery') ?? { after: '', confirmed: {} };
    const active = Object.values(ledger.read().pieces).filter(p => p.fundingCertificate && p.descriptor.epochId === context.epoch.id && p.state !== 'retired');
    state.confirmed = Object.fromEntries(Object.entries(state.confirmed).filter(([id]) => active.some(p => p.unitId === id)));
    const pieces = active.filter(p =>
      p.state === 'free' && context.epoch.members.some(m => !state.confirmed[p.unitId]?.includes(m.dexKey))).sort((a, b) => a.unitId.localeCompare(b.unitId));
    if (!pieces.length) return;
    const start = pieces.findIndex(p => p.unitId > state.after);
    const page = (start < 0 ? pieces : [...pieces.slice(start), ...pieces.slice(0, start)]).slice(0, FUNDING_RECOVERY_PAGE);
    // Advance before I/O: an unavailable piece cannot starve later pages after a restart.
    state.after = page.at(-1).unitId; this.store.put('stake-funding-recovery', state);
    const { at } = await this.clock();
    const results = await Promise.allSettled(context.epoch.members.map(m => this.request(m.dexKey, 'admissionInventory', { owner: this.owner, at })));
    const inventoryCertificate = matchingCertificate(results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []), context, 'admission-inventory');
    const price = await this.request(context.venueKey, 'priceSnapshot', {});
    for (const piece of page) {
      const funding = fundingReceipts(this.store, piece), entry = inventoryCertificate[0].fact.body.pieces.find(p => p.unitId === piece.unitId);
      if (!funding || sha256Hex(stableJSON(funding)) !== piece.fundingCertificate[0].fact.body.fundingDigest || entry?.state !== 'free' || entry.blocked) continue;
      const pending = context.epoch.members.filter(m => !state.confirmed[piece.unitId]?.includes(m.dexKey));
      const replies = await Promise.allSettled(pending.map(async m => {
        const reply = await this.request(m.dexKey, 'fundedRecover', { certificate: piece.fundingCertificate, funding, price, inventoryCertificate });
        if (reply?.funded !== true || reply.generation !== entry.generation) throw new Error('Funding catch-up not confirmed');
        return m.dexKey;
      }));
      state.confirmed[piece.unitId] = [...new Set([...(state.confirmed[piece.unitId] ?? []), ...replies.flatMap(r => r.status === 'fulfilled' ? [r.value] : [])])];
      this.store.put('stake-funding-recovery', state);
    }
  }
}
