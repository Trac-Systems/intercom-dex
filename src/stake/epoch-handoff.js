import { stableJSON, sha256Hex } from '../core/canonical.js';
import { validatePolicyTransition } from './settings.js';
import { matchingCertificate, verifyCertificate, factDigest } from './certificates.js';
import { stakeContext } from './price-service.js';
import { unitId } from './ledger.js';
import { CompletionLog } from './price.js';

// A draining handoff keeps new admission closed. It transfers occupied capacity
// and retains original custody routes; it does not re-share old private keys or
// reconstruct historical price/reward inventory from current balances.
export class StakeEpochHandoff {
  constructor({ store, registry, clock, request, publish, prepare = async () => {} }) {
    Object.assign(this, { store, registry, clock, request, publish, prepare }); this.queue = Promise.resolve();
  }
  run(fn) { const work = this.queue.then(fn); this.queue = work.catch(() => {}); return work; }
  quiesce() { return this.run(async () => {
    const previous = this.registry().sellerBond;
    if (!previous) throw new Error('Stake policy required');
    const now = (await this.clock()).at;
    const policy = { ...previous, acceptNew: false, epoch: { ...previous.epoch, stopNewAt: previous.epoch.stopNewAt ?? now + 30 } };
    await this.publish(policy);
    this.store.put(`stake-venue-epoch-${policy.epoch.id}`, policy);
    return { ok: true, epochId: policy.epoch.id, stopNewAt: policy.epoch.stopNewAt, acceptNew: false };
  }); }
  handoff(next) { return this.run(async () => {
    const digest = sha256Hex(stableJSON(next));
    let op = this.store.get('stake-epoch-handoff');
    if (op?.resumed && op.digest === digest) return { ok: true, epochId: op.next.epoch.id, previousEpochId: op.previous.epoch.id,
      acceptNew: true, adopted: op.adopted.length, state: 'active' };
    if (op && !op.done && op.digest !== digest) throw new Error('A different epoch handoff is pending');
    if (!op || op.done && op.digest !== digest) {
      await this.prepare();
      const previous = this.registry().sellerBond;
      validatePolicyTransition(previous, next, (await this.clock()).at);
      if (previous.epoch.id === next.epoch.id) throw new Error('A distinct successor epoch is required');
      op = { digest, previous, next, adopted: [], done: false };
      this.store.put('stake-epoch-handoff', op);
      this.store.put(`stake-venue-epoch-${previous.epoch.id}`, previous);
    }
    const save = () => this.store.put('stake-epoch-handoff', op);
    const body = { previousEpochId: op.previous.epoch.id, nextPolicy: op.next };
    if (!op.certificate) {
      const replies = await Promise.allSettled(op.previous.epoch.members.map(async m => this.request(m.dexKey, 'capacityHandoffVote', body)));
      op.certificate = matchingCertificate(replies.flatMap(r => r.status === 'fulfilled' ? [r.value] : []),
        stakeContext({ sellerBond: op.previous }), 'capacity-handoff'); save();
    }
    // Signer admission can precede the owner's final venue archive reply. Keep
    // the original price epoch available until that recoverable step finishes.
    const frozen = op.certificate[0].fact.body.state;
    for (const piece of Object.values(frozen.pieces).filter(p => !p.retired)) {
      const certificate = this.store.get(`stake-venue-funded-${piece.unitId}`);
      if (!certificate) throw new Error('Original custody archive incomplete; finish funding recovery before handoff');
      const context = piece.epochId === op.previous.epoch.id ? stakeContext({ sellerBond: op.previous }) : frozen.predecessors?.[piece.epochId];
      if (!context) throw new Error('Original funding epoch unavailable');
      const { body: funded } = verifyCertificate(certificate, context, 'funded');
      if (funded.unitId !== piece.unitId || unitId(funded.descriptor) !== piece.unitId || funded.descriptor.epochId !== piece.epochId ||
          funded.descriptor.owner.tracAddr !== piece.ownerAddress || funded.descriptor.principalReset !== piece.principalReset)
        throw new Error('Original custody archive differs from capacity');
    }
    const adopted = await Promise.allSettled(op.next.epoch.members.map(async m => {
      const result = await this.request(m.dexKey, 'capacityHandoffAdopt', { ...body, certificate: op.certificate });
      if (result?.adopted !== true || result.epochId !== op.next.epoch.id) throw new Error('Successor adoption not confirmed');
      const snapshot = op.certificate[0].fact.body.state, retirements = result.retirements ?? [];
      if (!Array.isArray(retirements) || retirements.length > 2000) throw new Error('Invalid handoff retirements');
      for (const certificate of retirements) {
        const piece = snapshot.pieces[certificate?.[0]?.fact.body.unitId];
        const context = piece?.epochId === op.previous.epoch.id ? stakeContext({ sellerBond: op.previous }) : snapshot.predecessors?.[piece?.epochId];
        if (!context) throw new Error('Unknown handoff retirement');
        verifyCertificate(certificate, context, 'collected');
      }
      return { key: m.dexKey, retirements };
    }));
    const accepted = adopted.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
    op.adopted = [...new Set([...op.adopted, ...accepted.map(r => r.key)])];
    op.retirements ??= {};
    for (const certificate of accepted.flatMap(r => r.retirements)) {
      const fact = certificate[0].fact, id = fact.body.unitId;
      if (op.retirements[id] && factDigest(op.retirements[id][0].fact) !== factDigest(fact)) throw new Error('Conflicting handoff retirement');
      op.retirements[id] = certificate;
    }
    save();
    if (op.adopted.length < 3) throw new Error('Successor capacity adoption quorum unavailable; admissions remain closed');
    // An original collection may have finished after the frozen snapshot. Send
    // its certificate to new members before publishing, and retry on restart.
    for (const certificate of Object.values(op.retirements)) {
      const retired = await Promise.allSettled(op.next.epoch.members.map(async m => {
        if ((await this.request(m.dexKey, 'capacityRetire', { certificate }))?.retired !== true) throw new Error('Retirement not confirmed');
      }));
      if (retired.filter(r => r.status === 'fulfilled').length < 3) throw new Error('Successor retirement quorum unavailable; admissions remain closed');
    }
    // Preserve original histories and liabilities. Fresh accrual/admission must
    // wait for a separate complete historical inventory/price reconciliation.
    this.store.put(`stake-epoch-draining-${op.next.epoch.id}`, { previousEpochId: op.previous.epoch.id });
    await this.publish(op.next);
    op.done = true; save();
    return { ok: true, epochId: op.next.epoch.id, previousEpochId: op.previous.epoch.id,
      acceptNew: false, adopted: op.adopted.length, state: 'draining' };
  }); }
  resume() { return this.run(async () => {
    const op = this.store.get('stake-epoch-handoff');
    if (!op?.done || this.registry().sellerBond.epoch.id !== op.next.epoch.id) throw new Error('Completed capacity handoff required');
    if (op.resumed) return { ok: true, epochId: op.next.epoch.id, state: 'active', acceptNew: true };
    const save = () => this.store.put('stake-epoch-handoff', op), previous = stakeContext({ sellerBond: op.previous });
    const body = { previousEpochId: op.previous.epoch.id, nextEpochId: op.next.epoch.id };
    if (!op.history) {
      const head = new CompletionLog({ store: this.store, context: previous }).read();
      if (!head.position) throw new Error('Original completed price history required');
      const replies = await Promise.allSettled(op.previous.epoch.members.map(m => this.request(m.dexKey, 'priceHistoryVote',
        { ...body, head: { nextEpochId: op.next.epoch.id, headPosition: head.position, headHash: head.hash } })));
      op.history = matchingCertificate(replies.flatMap(r => r.status === 'fulfilled' ? [r.value] : []), previous, 'history-head'); save();
    }
    const payout = op.previous.rewardService;
    if (stableJSON(payout ?? null) !== stableJSON(op.next.rewardService ?? null)) throw new Error('Unchanged payout authority required');
    if (payout && !op.liability) { op.liability = await this.request(payout.dexKey, 'rewardHandoffFreeze', body); save(); }
    const input = { ...body, certificate: op.history, ...(op.liability ? { liability: op.liability } : {}) };
    const adopted = await Promise.allSettled(op.next.epoch.members.map(async m => {
      const result = await this.request(m.dexKey, 'priceHistoryAdopt', input);
      if (result?.adopted !== true) throw new Error('History adoption unconfirmed');
    }));
    if (adopted.filter(r => r.status === 'fulfilled').length < 3) throw new Error('Successor history quorum unavailable');
    new CompletionLog({ store: this.store, context: stakeContext({ sellerBond: op.next }) }).adoptHistory(op.history, previous);
    if (payout && !op.liabilityAdopted) {
      if ((await this.request(payout.dexKey, 'rewardHandoffAdopt', input))?.adopted !== true) throw new Error('Reward adoption unconfirmed');
      op.liabilityAdopted = true; save();
    }
    const ready = await Promise.allSettled(op.next.epoch.members.map(async m => {
      const result = await this.request(m.dexKey, 'priceHistoryReady', input);
      if (result?.ready !== true || result.epochId !== op.next.epoch.id) throw new Error('History readiness unconfirmed');
    }));
    if (ready.filter(r => r.status === 'fulfilled').length < 3) throw new Error('Successor history readiness quorum unavailable');
    this.store.put(`stake-history-ready-${op.next.epoch.id}`, input);
    this.store.put(`stake-epoch-draining-${op.next.epoch.id}`, null);
    await this.publish({ ...op.next, acceptNew: true });
    if (payout && (await this.request(payout.dexKey, 'rewardHandoffRelease', input))?.adopted !== true) throw new Error('Reward release unconfirmed');
    op.resumed = true; save();
    return { ok: true, epochId: op.next.epoch.id, state: 'active', acceptNew: true };
  }); }
}
