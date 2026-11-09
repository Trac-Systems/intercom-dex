import { z } from 'zod';
import { sha256Hex, stableJSON } from '../core/canonical.js';
import { signFact, verifyFact, verifyCertificate, factDigest } from './certificates.js';
import { StakeLedger, terminalDecisionSchema } from './ledger.js';
import { stakeContext } from './price-service.js';
import { createProofClock, applyProofClock, qualifyingLock } from './proof-clock.js';
import { penaltyClockBody, positionSchema, penaltySampleSchema } from './penalty-clock.js';
import { proofClockSettings } from './settings.js';
import { verifyOrphanReservation, verifyOrphanReady } from './orphan.js';

const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const hash = value => sha256Hex(stableJSON(value));

export class PenaltySigner {
  constructor({ store, identity, clock, position, verifyDelivery, history, health, policyFor, now = () => Math.ceil(Date.now() / 1000) }) {
    Object.assign(this, { store, identity, clock, position, verifyDelivery, history, health, policyFor, now }); this.queue = Promise.resolve();
  }
  timing(terms) { return { triggerAt: terms.sendBy + terms.bond.overdueDelaySec, windowSec: terms.bond.proofWindowSec }; }
  find(id) {
    hex.parse(id);
    for (const name of this.store.list('stake-ledger-')) {
      const record = this.store.get(name), r = record.reservations[id];
      if (r?.admission) {
        const context = stakeContext({ sellerBond: r.admission.policy });
        return { r, context, ledger: new StakeLedger({ store: this.store, context, address: r.admission.terms.seller.tracAddr }) };
      }
    }
    throw new Error('Unknown penalty reservation');
  }
  record(id) { return this.store.get(`stake-penalty-${id}`) ?? { seq: 0, candidates: {}, receiptSeq: 0 }; }
  save(id, value) { this.store.put(`stake-penalty-${id}`, value); }
  sign(context, kind, body) { return signFact({ v: 1, networkId: context.networkId, venueKey: context.venueKey, epochId: context.epoch.id, kind, body }, this.identity.secretKey); }
  handle(method, input, from) {
    const work = this.queue.then(() => this.apply(method, input, from)); this.queue = work.catch(() => {}); return work;
  }
  assertSettlement(id, txHash) {
    const { r, ledger } = this.find(id);
    if (r.state === 'delivered' && r.delivery?.txHash === txHash) return;
    if (r.delivery?.txHash !== txHash || !['reserved', 'delivered'].includes(r.state) || r.body.pieces.some(ref => ledger.read().pieces[ref.unitId].decisionVote))
      throw new Error('Penalty decision blocks share publication');
  }
  settlement(id, txHash) {
    const work = this.queue.then(async () => {
      const { r, ledger } = this.find(id);
      if (r.state === 'delivered' && r.delivery?.txHash === txHash) return;
      const proof = await this.evidence(id, txHash);
      if (proof.state !== 'in-time') throw new Error('Timely delivery proof required before settlement shares');
      ledger.deliveryIntent(id, { txHash, evidenceDigest: hash(proof), share: true });
    }); this.queue = work.catch(() => {}); return work;
  }
  async evidence(id, txHash, submitter = null) {
    const { r } = this.find(id), rec = this.record(id); hex.parse(txHash);
    if (rec.proofClosed && !rec.candidates[txHash]) {
      rec.afterClose = [...(rec.afterClose ?? []).filter(h => h !== txHash), txHash].slice(-8); this.save(id, rec);
      return { state: 'closed', reason: 'proof_window_complete' };
    }
    const seller = submitter === null || submitter === r.admission.terms.seller.dexKey;
    if (!rec.candidates[txHash]) {
      const entries = Object.entries(rec.candidates), limit = seller ? 8 : 4;
      if (entries.length >= limit) {
        const evict = entries.find(([, p]) => !p.seller && (p.state === 'invalid' || p.reason === 'unknown_or_not_final'));
        if (!evict) throw new Error('Proof candidate limit reached');
        delete rec.candidates[evict[0]];
      }
      rec.candidates[txHash] = { state: 'received', seller }; rec.receiptSeq++; this.save(id, rec);
    }
    const clock = await this.clock(), { triggerAt } = this.timing(r.admission.terms);
    const cutoff = rec.cutoff?.[0]?.fact.body;
    const position = cutoff?.position ?? (clock.at < triggerAt ? await this.position() : null);
    if (!position) {
      const proof = { state: 'unknown', reason: 'cutoff_unavailable' };
      rec.candidates[txHash] = { ...rec.candidates[txHash], ...proof }; this.save(id, rec);
      return proof;
    }
    let proof = await this.verifyDelivery(r.admission.terms, txHash, position);
    if (proof.state === 'late' && (rec.pendingPausePosition || rec.unknownPausePosition)) proof = { state: 'unknown', reason: 'pause_position_unavailable' };
    if (proof.state === 'late') for (const range of rec.pausePositions ?? []) {
      const before = await this.verifyDelivery(r.admission.terms, txHash, range.start);
      const after = await this.verifyDelivery(r.admission.terms, txHash, range.end);
      if (before.state === 'late' && after.state === 'in-time') { proof = { ...after, basis: 'certified-pause' }; break; }
      if (before.state === 'unknown' || after.state === 'unknown') { proof = { state: 'unknown', reason: 'pause_position_unavailable' }; break; }
    }
    rec.candidates[txHash] = { state: proof.state, reason: proof.reason ?? null, seller: rec.candidates[txHash].seller || seller };
    rec.receiptSeq++; this.save(id, rec);
    if (proof.state === 'in-time' && r.state === 'reserved') {
      const { ledger } = this.find(id); ledger.deliveryIntent(id, { txHash, evidenceDigest: hash({ txHash, position }), share: false });
    }
    return proof;
  }
  async check(id, throughSlot) {
    const { r } = this.find(id), terms = r.admission.terms;
    const h = await this.history({ terms, hashHex: r.body.H, fromSlot: r.admission.fromSlot, throughSlot });
    if (h.status !== 'complete') throw new Error('Complete finalized escrow history required');
    const timely = h.locks.filter(l => qualifyingLock({ ...l, finalized: true, historyComplete: true }, terms.sendBy, 120));
    if (timely.length > 1) throw new Error('Ambiguous qualifying lock');
    return { history: h, timely: timely.length === 1 };
  }
  async apply(method, b, from) {
    if (method === 'penaltyOrphanVote' || method === 'penaltyResolveCommit' && b.reservation) {
      const policy = this.policyFor?.(b.reservation?.admission?.terms);
      const { body, admission, context, terms } = verifyOrphanReservation(b.reservation, policy, b.reservationId);
      if (from !== context.venueKey || !context.epoch.members.some(m => m.dexKey === this.identity.publicKey))
        throw new Error('Original venue and signer required');
      const ledger = new StakeLedger({ store: this.store, context, address: terms.seller.tracAddr });
      if (method === 'penaltyResolveCommit') {
        const fact = verifyCertificate(b.certificate, context, 'resolved');
        ledger.orphanClosure(body, admission, fact.body, b.certificate); return { resolved: true };
      }
      verifyOrphanReady(b.ready, b.reservation, context);
      const prior = ledger.read().reservations[b.reservationId];
      // Existing holders use the original RPC, including old software. This
      // extension only supplies the missing non-holder votes.
      if (prior && !prior.orphanClosure) throw new Error('Use holder closure vote');
      const rec = this.record(b.reservationId);
      if (rec.resolveVote) {
        if (rec.resolveVote.fact.body.evidenceDigest !== b.evidenceDigest) throw new Error('Closure already fixed');
        return rec.resolveVote;
      }
      hex.parse(b.evidenceDigest);
      const clock = await this.clock();
      if (clock.at <= terms.sendBy + terms.graceSec) throw new Error('Trade verification window is still open');
      // Never accept the coordinator's possibly old history frontier. The local
      // finalized clock closes the range after the entire trade window.
      const h = await this.history({ terms, hashHex: body.H, fromSlot: admission.fromSlot, throughSlot: clock.slot });
      if (h.status !== 'complete' || h.locks.some(l => qualifyingLock({ ...l, finalized: true, historyComplete: true }, terms.sendBy, 120)))
        throw new Error('Complete history without a qualifying lock required');
      const closure = { reservationId: b.reservationId, outcome: 'unfunded', pieces: body.pieces, evidenceDigest: b.evidenceDigest };
      ledger.orphanClosure(body, admission, closure);
      rec.resolveVote = this.sign(context, 'resolved', closure); this.save(b.reservationId, rec); return rec.resolveVote;
    }
    if (method === 'penaltyList') {
      const found = [];
      for (const name of this.store.list('stake-ledger-')) {
        const ledger = this.store.get(name);
        for (const r of Object.values(ledger.reservations)) {
          if (r.admission && from === r.admission.policy.venueKey && ['reserved', 'decided'].includes(r.state) &&
              !(r.state === 'decided' && r.body.pieces.every(p => ledger.pieces[p.unitId]?.state === 'retired'))) found.push(r.reservationId);
        }
      }
      found.sort();
      const start = found.findIndex(id => id > (this.listAfter ?? ''));
      const ordered = start < 0 ? found : [...found.slice(start), ...found.slice(0, start)];
      const page = ordered.slice(0, 32); this.listAfter = page.at(-1);
      return page;
    }
    const { r, context, ledger } = this.find(b.reservationId), terms = r.admission.terms, id = r.reservationId;
    if (!context.epoch.members.some(m => m.dexKey === this.identity.publicKey)) throw new Error('Original penalty signer required');
    if (method === 'penaltyEvidence') {
      const proof = await this.evidence(id, b.txHash, from);
      return this.sign(context, 'delivery-result', { reservationId: id, txHash: b.txHash, ...proof, receiptSeq: this.record(id).receiptSeq });
    }
    if (method === 'penaltyState') return { reservation: r, candidates: this.record(id).candidates,
      funded: r.body.pieces.map(ref => ledger.read().pieces[ref.unitId].fundingCertificate) };
    if (from !== context.venueKey) throw new Error('Venue coordinates penalty certificates');
    const rec = this.record(id), timing = this.timing(terms), bounds = proofClockSettings(r.admission.policy, terms), clock = await this.clock();
    if (method === 'penaltyVote') {
      const body = terminalDecisionSchema.parse(b.decision), digest = hash(body);
      if (ledger.read().decisionVotes?.[digest] && body.reservationId === id) return this.sign(context, 'decision', body);
    }
    if (method === 'penaltyResolveVote' && rec.resolveVote?.fact.body.evidenceDigest === b.evidenceDigest) return rec.resolveVote;
    if (method === 'penaltySample') {
      let position = null, healthy = false;
      try { position = positionSchema.parse(await this.position(b.position)); healthy = await this.health({ terms, reservationId: id }) === true; }
      catch { /* Missing service/reader data is an outage. */ }
      const observed = await this.clock(), slow = observed.at - clock.at > bounds.sampleFreshSec;
      if (slow) healthy = false;
      if (Object.values(rec.candidates).some(p => ['received', 'unknown'].includes(p.state) && !['unknown_or_not_final', 'cutoff_unavailable'].includes(p.reason))) healthy = false;
      const body = penaltySampleSchema.parse({ reservationId: id, seq: rec.seq + 1, at: observed.at, slot: observed.slot,
        healthy, reason: slow ? 'sample-slow' : healthy ? 'healthy' : 'service-unavailable', position,
        receiptHead: hash({ seq: rec.receiptSeq, candidates: rec.candidates }) });
      rec.seq++; rec.sample = this.sign(context, 'penalty-health', body);
      this.store.put(`stake-penalty-sample-${id}-${rec.seq}`, rec.sample);
      this.save(id, rec); return rec.sample;
    }
    if (method === 'penaltyCutoffVote') {
      const body = { reservationId: id, triggerAt: timing.triggerAt, at: b.at, position: positionSchema.parse(b.position) };
      if (rec.cutoffVote) { if (stableJSON(rec.cutoffVote.fact.body) !== stableJSON(body)) throw new Error('Cutoff already fixed'); return rec.cutoffVote; }
      const own = b.samples?.find(v => v.from === this.identity.publicKey);
      if (!own || stableJSON(own) !== stableJSON(this.store.get(`stake-penalty-sample-${id}-${own.fact.body.seq}`)) ||
          b.at < timing.triggerAt || b.at > clock.at || own.fact.body.healthy !== true ||
          Math.abs(own.fact.body.at - b.at) > 15 || stableJSON(own.fact.body.position) !== stableJSON(body.position)) throw new Error('Healthy cutoff observation required');
      await this.position(body.position);
      rec.cutoffVote = this.sign(context, 'delivery-cutoff', body); this.save(id, rec); return rec.cutoffVote;
    }
    if (method === 'penaltyCutoffCommit') {
      const fact = verifyCertificate(b.certificate, context, 'delivery-cutoff');
      if (fact.body.reservationId !== id || fact.body.triggerAt !== timing.triggerAt || fact.body.at < timing.triggerAt) throw new Error('Wrong cutoff');
      if (rec.cutoff && factDigest(rec.cutoff[0].fact) !== factDigest(fact)) throw new Error('Conflicting cutoff');
      rec.cutoff = b.certificate; this.save(id, rec); return { accepted: true };
    }
    if (method === 'penaltyClockVote') {
      if (!rec.cutoff) throw new Error('Certified cutoff required');
      const previous = rec.clock ?? createProofClock({ tradeId: r.body.tradeId, reservationId: id, ...timing });
      const body = penaltyClockBody(previous, b.before, b.after, context, bounds.sampleGapSec);
      if (body.throughAt > clock.at) throw new Error('Future proof clock');
      const own = b.after.find(v => v.from === this.identity.publicKey);
      if (!own || stableJSON(own) !== stableJSON(this.store.get(`stake-penalty-sample-${id}-${own.fact.body.seq}`))) throw new Error('Own current health observation required');
      if (body.healthyIntervals.some(i => i.to > previous.throughAt) && !own.fact.body.healthy) throw new Error('Cannot attest healthy time');
      if (rec.clockVote?.fact.body.seq === body.seq && stableJSON(rec.clockVote.fact.body) !== stableJSON(body)) throw new Error('Clock vote already fixed');
      rec.clockVote = this.sign(context, 'clock', body); this.save(id, rec); return rec.clockVote;
    }
    if (method === 'penaltyClockCommit') {
      const previous = rec.clock ?? createProofClock({ tradeId: r.body.tradeId, reservationId: id, ...timing });
      const fact = verifyCertificate(b.certificate, context, 'clock');
      if (rec.clock?.hash === factDigest(fact)) return rec.clock;
      rec.clock = applyProofClock(previous, b.certificate, context, clock.at);
      if (rec.clock.remainingSec === 0) rec.proofClosed = true;
      if (b.after?.length && stableJSON(penaltyClockBody(previous, b.before, b.after, context, bounds.sampleGapSec)) === stableJSON(fact.body)) {
        const position = votes => {
          const positions = (votes ?? []).map(v => verifyFact(v, context, 'penalty-health', v.from).body.position);
          return positions.find(p => p && positions.filter(other => stableJSON(other) === stableJSON(p)).length >= 3);
        };
        const end = position(b.after);
        const pause = rec.clock.pausedIntervals.find(i => i.to > previous.throughAt);
        if (pause) {
          // A fresh sample after a slow round is already beyond the unknown
          // gap. Start at the last committed position and stop at the before
          // sample when a healthy tail follows that gap.
          const start = rec.pendingPausePosition?.start ?? rec.lastPosition ?? (previous.seq === 0 ? rec.cutoff?.[0]?.fact.body.position : null);
          const from = rec.pendingPausePosition?.from ?? previous.throughAt;
          const pauseEnd = rec.clock.healthyIntervals.some(i => i.from === pause.to && i.to > previous.throughAt) ? position(b.before) : end;
          if (!start) rec.unknownPausePosition = true;
          else if (pauseEnd) {
            (rec.pausePositions ??= []).push({ from, to: pause.to, start, end: pauseEnd });
            delete rec.pendingPausePosition;
          } else rec.pendingPausePosition = { from, start };
        }
        if (end) rec.lastPosition = end;
      }
      this.save(id, rec); return rec.clock;
    }
    if (method === 'penaltyResolveVote') {
      const checked = await this.check(id, clock.slot);
      const delivered = !!ledger.read().reservations[id].delivery;
      const outcome = delivered ? 'delivered' : !checked.timely && clock.at > terms.sendBy ? 'unfunded' : null;
      if (!outcome || r.state !== 'reserved' || r.body.pieces.some(ref => ledger.read().pieces[ref.unitId].decisionVote)) throw new Error('No safe reservation closure');
      const body = { reservationId: id, outcome, pieces: r.body.pieces, evidenceDigest: b.evidenceDigest };
      if (rec.resolveVote && stableJSON(rec.resolveVote.fact.body) !== stableJSON(body)) throw new Error('Closure already fixed');
      ledger.closureIntent(id, body); rec.resolveVote = this.sign(context, 'resolved', body); this.save(id, rec); return rec.resolveVote;
    }
    if (method === 'penaltyResolveCommit') {
      ledger.resolve(b.certificate); return { resolved: true };
    }
    if (method === 'penaltyPrepare' || method === 'penaltyVote') {
      if (!rec.clock || rec.clock.remainingSec || rec.clock.throughAt > clock.at || method === 'penaltyPrepare' && clock.at - rec.clock.throughAt > bounds.checkpointFreshSec ||
          rec.sample?.fact.body.healthy !== true || rec.sample.fact.body.at > clock.at || clock.at - rec.sample.fact.body.at > bounds.sampleFreshSec) throw new Error('Complete healthy proof window required');
      for (const txHash of b.candidates ?? []) await this.evidence(id, txHash);
      const latest = this.record(id), lr = ledger.read().reservations[id];
      if (lr.delivery || lr.shareIntent || lr.closureVote || Object.values(latest.candidates).some(p => !['late', 'invalid'].includes(p.state) && p.reason !== 'unknown_or_not_final')) throw new Error('Delivery proof blocks penalty');
      const checked = await this.check(id, b.throughSlot);
      if (!checked.timely || !['active', 'refunded'].includes(checked.history.escrowState)) throw new Error('Timely unclaimed buyer lock required');
      const manifest = { reservationId: id, clockDigest: rec.clock.hash, throughSlot: b.throughSlot,
        historyDigest: checked.history.evidenceDigest, candidates: Object.keys(latest.candidates).sort(), escrowState: checked.history.escrowState };
      if (method === 'penaltyPrepare') {
        const vote = this.sign(context, 'penalty-prepare', manifest); latest.prepare = vote; this.save(id, latest); return vote;
      }
      const prepared = verifyCertificate(b.prepare, context, 'penalty-prepare');
      for (const key of ['reservationId', 'clockDigest', 'throughSlot', 'candidates'])
        if (stableJSON(manifest[key]) !== stableJSON(prepared.body[key])) throw new Error('Receipt manifest changed');
      const fresh = await this.check(id, clock.slot);
      if (!fresh.timely || !['active', 'refunded'].includes(fresh.history.escrowState)) throw new Error('Fresh unclaimed buyer lock required');
      const decision = terminalDecisionSchema.parse(b.decision);
      if (decision.outcome !== 'buyer-no-show' || decision.reservationId !== id || decision.evidenceDigest !== factDigest(prepared) ||
          decision.at > clock.at) throw new Error('Decision evidence differs');
      ledger.prepareDecision(decision); return this.sign(context, 'decision', decision);
    }
    if (method === 'penaltyCommit') { ledger.decide(b.certificate); return { decided: true }; }
    throw new Error('Unsupported penalty request');
  }
}
