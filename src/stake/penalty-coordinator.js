import { matchingCertificate, factDigest, verifyCertificate } from './certificates.js';
import { createProofClock, applyProofClock } from './proof-clock.js';
import { penaltyClockBody } from './penalty-clock.js';
import { stakeContext } from './price-service.js';
import { sha256Hex, stableJSON } from '../core/canonical.js';
import { proofClockSettings } from './settings.js';

const hash = value => sha256Hex(stableJSON(value));
export class PenaltyCoordinator {
  constructor({ store, registry, request, clock, position, timing }) { Object.assign(this, { store, registry, request, clock, position, timing }); }
  save(job) { this.store.put(`stake-penalty-job-${job.id}`, job); }
  archiveAward(job) {
    if (!job.decision) return;
    const index = this.store.get('stake-penalty-awards') ?? { ids: [] };
    if (!index.ids.includes(job.id)) { index.ids.push(job.id); this.store.put('stake-penalty-awards', index); }
  }
  awards(after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid award cursor');
    const ids = (this.store.get('stake-penalty-awards') ?? { ids: [] }).ids;
    if (after > ids.length) throw new Error('Award cursor exceeds archive');
    return { after, through: Math.min(ids.length, after + 32), total: ids.length, awards: ids.slice(after, after + 32).map(id => {
      const job = this.store.get(`stake-penalty-job-${id}`);
      return { address: job.reservation.admission.terms.seller.tracAddr, decisionCertificate: job.decision, fundedCertificates: job.funded };
    }) };
  }
  async all(context, method, body, failures = []) {
    const results = await Promise.allSettled(context.epoch.members.map(async m => this.request(m.dexKey, method, body)));
    failures.push(...results.flatMap(r => r.status === 'rejected' ? [String(r.reason?.message ?? r.reason).slice(0, 120)] : []));
    return results.flatMap((r, i) => r.status === 'fulfilled' && (!r.value?.from || r.value.from === context.epoch.members[i].dexKey) ? [r.value] : []);
  }
  async certificate(context, method, body, kind) {
    const failures = [], votes = await this.all(context, method, body, failures);
    try { return matchingCertificate(votes, context, kind); }
    catch (error) { throw new Error(`${error.message} (${method}${failures.length ? ': ' + [...new Set(failures)].join('; ') : ''})`); }
  }
  async tick() {
    if (!this.registry()?.sellerBond) return;
    // A registry replacement changes new admission, never the committee that
    // owes an existing proof window or release. Retain routing independently
    // of the ordinary bounded registry cache and resume it after restart.
    const current = this.registry().sellerBond, policies = new Map([[current.epoch.id, current]]);
    for (const name of this.store.list('stake-venue-epoch-')) {
      const policy = this.store.get(name);
      if (policy?.networkId === current.networkId && policy.venueKey === current.venueKey) policies.set(policy.epoch.id, policy);
    }
    for (const name of this.store.list('stake-penalty-job-')) {
      const policy = this.store.get(name)?.reservation.admission.policy;
      if (policy?.networkId === current.networkId && policy.venueKey === current.venueKey) policies.set(policy.epoch.id, policy);
    }
    for (const policy of policies.values()) await this.tickEpoch(stakeContext({ sellerBond: policy }));
  }
  async tickEpoch(context) {
    const lists = await this.all(context, 'penaltyList', {});
    const found = [...new Set(lists.flat())].sort();
    this.listAfterByEpoch ??= new Map();
    const start = found.findIndex(id => id > (this.listAfterByEpoch.get(context.epoch.id) ?? ''));
    const ids = (start < 0 ? found : [...found.slice(start), ...found.slice(0, start)]).slice(0, 32);
    this.listAfterByEpoch.set(context.epoch.id, ids.at(-1));
    for (const id of ids) {
      const saved = this.store.get(`stake-penalty-job-${id}`);
      if (saved && saved.reservation.admission.policy.epoch.id !== context.epoch.id) continue;
      try { await this.advance(id, context); }
      catch (e) { const job = this.store.get(`stake-penalty-job-${id}`); if (job) { job.error = e.message; this.save(job); } }
    }
  }
  async advance(id, context) {
    let job = this.store.get(`stake-penalty-job-${id}`);
    const states = await this.all(context, 'penaltyState', { reservationId: id });
    if (states.length < 3) throw new Error('Penalty state quorum unavailable');
    if (!job) {
      const original = states.find(s => states.filter(other => stableJSON(other.reservation.body) === stableJSON(s.reservation.body)).length >= 3);
      if (!original) throw new Error('Reservation quorum unavailable');
      const r = original.reservation;
      if (r.admission.policy.epoch.id !== context.epoch.id) return;
      job = { id, reservation: r, funded: original.funded }; this.save(job);
    }
    if (job.resolved || job.decision) {
      this.archiveAward(job);
      await this.all(context, job.resolved ? 'penaltyResolveCommit' : 'penaltyCommit', { reservationId: id, certificate: job.resolved ?? job.decision });
      return;
    }
    const r = job.reservation, terms = r.admission.terms, timing = this.timing(terms), clock = await this.clock();
    const bounds = proofClockSettings(r.admission.policy, terms);
    if (job.pendingDecision) {
      await this.all(context, 'penaltySample', { reservationId: id, position: await this.position() });
      job.decision = await this.certificate(context, 'penaltyVote', { reservationId: id, ...job.pendingDecision }, 'decision');
      this.save(job); this.archiveAward(job);
      await this.all(context, 'penaltyCommit', { reservationId: id, certificate: job.decision }); return;
    }
    const candidates = [...new Set(states.flatMap(s => Object.keys(s.candidates)))].slice(0, 8);
    for (const txHash of candidates) await this.all(context, 'penaltyEvidence', { reservationId: id, txHash });
    // Exact positive proof can close before the trigger. No-show decisions always
    // wait for the complete independently certified healthy proof window.
    if (states.some(s => s.reservation.delivery) || clock.at > terms.sendBy) {
      try {
        job.pendingResolve ??= { reservationId: id, throughSlot: clock.slot, evidenceDigest: hash({ id, candidates, throughSlot: clock.slot }) };
        this.save(job);
        job.resolved = await this.certificate(context, 'penaltyResolveVote', job.pendingResolve, 'resolved');
        this.save(job); await this.all(context, 'penaltyResolveCommit', { reservationId: id, certificate: job.resolved }); return;
      } catch { /* A qualifying unclaimed lock stays reserved. */ }
    }
    if (clock.at < timing.triggerAt) return;
    if (job.cutoff) await this.all(context, 'penaltyCutoffCommit', { reservationId: id, certificate: job.cutoff });
    const position = await this.position();
    let samples = await this.all(context, 'penaltySample', { reservationId: id, position });
    if (samples.length < 3) throw new Error('Penalty health quorum unavailable');
    if (!job.cutoff) {
      const healthy = samples.filter(v => v.fact.body.healthy && stableJSON(v.fact.body.position) === stableJSON(position));
      if (healthy.length < 3) { job.samples = samples; this.save(job); return; }
      job.cutoffProposal ??= { reservationId: id, at: Math.min(...healthy.map(v => v.fact.body.at)), position, samples: healthy };
      this.save(job);
      job.cutoff = await this.certificate(context, 'penaltyCutoffVote', job.cutoffProposal, 'delivery-cutoff');
      this.save(job);
      await this.all(context, 'penaltyCutoffCommit', { reservationId: id, certificate: job.cutoff });
      samples = await this.all(context, 'penaltySample', { reservationId: id, position: await this.position() });
    }
    const previous = job.clock ?? createProofClock({ tradeId: r.body.tradeId, reservationId: id, ...timing });
    let before = job.samples ?? [], after = samples;
    let body = penaltyClockBody(previous, before, after, context, bounds.sampleGapSec);
    // State/cutoff/commit RPCs can take longer than the maximum healthy sample
    // gap. Obtain consecutive observations without those rounds in between;
    // the unobserved gap remains paused and slow probes still earn no time.
    if (!job.pendingClock && Math.min(...samples.map(v => v.fact.body.at)) - previous.throughAt > bounds.sampleGapSec &&
        samples.filter(v => v.fact.body.healthy).length >= 3) {
      before = samples;
      after = await this.all(context, 'penaltySample', { reservationId: id, position: await this.position() });
      body = penaltyClockBody(previous, before, after, context, bounds.sampleGapSec);
    }
    job.pendingClock ??= { before, after, body }; this.save(job);
    const certificate = await this.certificate(context, 'penaltyClockVote', { reservationId: id, before: job.pendingClock.before, after: job.pendingClock.after }, 'clock');
    job.clock = applyProofClock(previous, certificate, context, (await this.clock()).at);
    const committed = job.pendingClock;
    job.samples = committed.after; delete job.pendingClock; this.save(job);
    await this.all(context, 'penaltyClockCommit', { reservationId: id, certificate, before: committed.before, after: committed.after });
    if (job.clock.remainingSec) return;
    // Clock votes and commits can outlive the signer's health freshness bound.
    // Observe again before each terminal round; the certified clock and all
    // signer-side freshness checks remain authoritative.
    await this.all(context, 'penaltySample', { reservationId: id, position: await this.position() });
    const frontier = await this.clock();
    const prepare = await this.certificate(context, 'penaltyPrepare', { reservationId: id, throughSlot: frontier.slot, candidates }, 'penalty-prepare');
    const decision = { decisionId: hash({ id, prepared: factDigest(prepare[0].fact) }), outcome: 'buyer-no-show', pieces: r.body.pieces,
      reservationId: id, at: frontier.at, winnerAddress: terms.buyer.tracAddr, winnerBoxKey: terms.buyer.boxKey, evidenceDigest: factDigest(prepare[0].fact) };
    // A fixed proposal survives response loss; never sign another successor after
    // a partial terminal vote, even when the coordinator has not seen a quorum.
    job.pendingDecision ??= { decision, prepare, throughSlot: frontier.slot, candidates }; this.save(job);
    await this.all(context, 'penaltySample', { reservationId: id, position: await this.position() });
    job.decision = await this.certificate(context, 'penaltyVote', { reservationId: id, ...job.pendingDecision }, 'decision'); this.save(job); this.archiveAward(job);
    await this.all(context, 'penaltyCommit', { reservationId: id, certificate: job.decision });
  }
  collection(id, certificate) {
    const job = this.store.get(`stake-penalty-job-${id}`);
    if (!job?.decision) throw new Error('Certified award required');
    const context = stakeContext({ sellerBond: job.reservation.admission.policy }), fact = verifyCertificate(certificate, context, 'collected'), b = fact.body;
    const decision = job.decision[0].fact.body;
    if (b.decisionId !== decision.decisionId || !decision.pieces.some(p => p.unitId === b.unitId && p.generation === b.generation)) throw new Error('Collection belongs to another award');
    job.collections ??= {};
    if (job.collections[b.unitId] && factDigest(job.collections[b.unitId][0].fact) !== factDigest(fact)) throw new Error('Conflicting award collection');
    job.collections[b.unitId] = certificate; this.save(job); return { accepted: true };
  }
  result(id) {
    const job = this.store.get(`stake-penalty-job-${id}`);
    if (!job) return null;
    return { reservation: job.reservation, funded: job.funded, resolved: job.resolved ?? null, decision: job.decision ?? null,
      clock: job.clock ?? null, collections: job.collections ?? {}, error: job.error ?? null };
  }
}
