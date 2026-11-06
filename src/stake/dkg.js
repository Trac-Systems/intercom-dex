import { z } from 'zod';
import * as dkg from '../locks/dkg.js';
import { hexToBytes, stableJSON } from '../core/canonical.js';
import { encodeKey, identityPublic } from '../core/keys.js';
import { unitId } from './ledger.js';
import { signFact, verifyFact, verifyCertificate, factDigest } from './certificates.js';

const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const committeeFor = epoch => epoch.members.map(m => ({ lockKey: m.dexKey, boxKey: m.boxKey }));

// This coordinator owns only the encrypted DKG/share journal. Capacity, chain funding and terminal adjudication
// remain independently certified boundaries. Transport sends the returned signed facts after each durable write.
export class StakeDkg {
  constructor({ store, context, identity, box, now = () => Math.floor(Date.now() / 1000), timeoutNow = () => Math.floor(Date.now() / 1000) }) {
    if (!store?.get || !store?.put || !identity?.secretKey || !box?.secretKey) throw new Error('Stake DKG requires encrypted storage and signer keys');
    const e = context.epoch;
    if (e.n !== 4 || e.k !== 3 || e.maxFaulty !== 1 || e.members.length !== 4 || new Set(e.members.map(m => m.dexKey)).size !== 4)
      throw new Error('Invalid stake DKG epoch');
    this.j = e.members.findIndex(m => m.dexKey === identity.publicKey) + 1;
    if (!this.j || encodeKey(identityPublic(identity.secretKey)) !== identity.publicKey) throw new Error('Signer is outside the stake epoch');
    Object.assign(this, { store, context: structuredClone(context), identity, box, now, timeoutNow });
  }
  name(id) { hex.parse(id); return `stake-dkg-${id}`; }
  read(id) { return this.store.get(this.name(id)); }
  fact(kind, body) {
    return signFact({ v: 1, networkId: this.context.networkId, venueKey: this.context.venueKey,
      epochId: this.context.epoch.id, kind, body }, this.identity.secretKey);
  }
  save(record) { this.store.put(this.name(record.unitId), record); }
  start(descriptor, capacityCertificate, { timeoutSec = 120 } = {}) {
    const id = unitId(descriptor), now = uint.parse(this.now()), d = descriptor, e = this.context.epoch;
    if (d.networkId !== this.context.networkId || d.venueKey !== this.context.venueKey || d.epochId !== e.id ||
        d.createdAt > now || d.expiresAt <= now || e.members.some(m => m.dexKey === d.owner.dexKey)) throw new Error('Invalid stake DKG descriptor');
    const grant = verifyCertificate(capacityCertificate, this.context, 'capacity');
    if (!Array.isArray(grant.body.units) || !grant.body.units.some(u => u.unitId === id && u.ownerAddress === d.owner.tracAddr && u.principalReset === d.principalReset))
      throw new Error('Capacity does not cover this stake piece');
    const prior = this.read(id);
    if (prior) {
      if (prior.release) throw new Error('Stake address is retired');
      if (stableJSON(prior.descriptor) !== stableJSON(d) || prior.capacityDigest !== factDigest(grant)) throw new Error('Stake creation conflicts');
      return this.resume(id);
    }
    if (now < e.startAt || e.stopNewAt !== undefined && now >= e.stopNewAt) throw new Error('Stake epoch is closed to new creation');
    const committee = committeeFor(e), ownDeal = dkg.deal({ positionId: id, i: this.j, committee, k: e.k });
    const state = dkg.create({ positionId: id, committee, k: e.k, j: this.j, boxSecret: this.box.secretKey,
      ownDeal, chain: 'trac', now, timeoutSec });
    const record = { unitId: id, descriptor: structuredClone(d), capacityDigest: factDigest(grant), capacityCertificate,
      localDeadline: uint.parse(uint.parse(this.timeoutNow()) + timeoutSec),
      state, outgoing: [], deals: {} };
    this.save(record);
    return this.advance(record, { type: 'message', now, message: { kind: 'dkgDeal', from: this.identity.publicKey, body: ownDeal } }, true);
  }
  advance(record, event, announce = false) {
    // Missing-dealer selection is a local availability timeout. Finalized time
    // can stall (including after a validator warp); it still exclusively gates
    // descriptor admission and release authorization in start() and release().
    const localNow = uint.parse(this.timeoutNow());
    if (record.state.phase === 'dealing') {
      // Older journals have only a chain-time deadline. Start a conservative
      // local wait once, then retain it across retries and process restarts.
      record.localDeadline ??= uint.parse(localNow + Math.max(0, record.state.deadline - record.state.now));
    }
    event = { ...event, now: Math.max(uint.parse(event.now), record.state.now,
      record.state.phase === 'dealing' && localNow >= record.localDeadline ? record.state.deadline : 0) };
    const result = dkg.step(record.state, event); record.state = result.state;
    const messages = announce ? [this.fact('dkg-deal', record.state.ownDeal)] : [];
    for (const action of result.actions) {
      if (action.type === 'persist') {
        record.lock = action.record;
        // The share is durable before acknowledging persisted and making a readiness signature visible.
        this.save(record);
        const next = dkg.step(record.state, { type: 'persisted', positionId: record.unitId, now: event.now, ok: true });
        record.state = next.state;
        for (const a of next.actions) if (a.kind === 'lockReady') messages.push(this.fact('dkg-ready', a.body));
      } else if (action.kind === 'dkgDeal') messages.push(this.fact('dkg-deal', action.body));
      else if (action.kind === 'lockReady') messages.push(this.fact('dkg-ready', action.body));
    }
    record.outgoing = messages; this.save(record); return structuredClone(messages);
  }
  receive(vote) {
    if (!this.context.epoch.members.some(m => m.dexKey === vote?.from)) throw new Error('Unknown DKG sender');
    const fact = verifyFact(vote, this.context, 'dkg-deal', vote.from), id = fact.body.positionId, record = this.read(id);
    if (!record) throw new Error('Stake creation has not been admitted');
    if (record.release) throw new Error('Stake address is retired');
    const prior = record.deals[vote.from];
    if (prior && factDigest(prior.fact) !== factDigest(fact)) throw new Error('Stake dealer equivocated');
    record.deals[vote.from] = vote;
    return this.advance(record, { type: 'message', now: this.now(), message: { kind: 'dkgDeal', from: vote.from, body: fact.body } });
  }
  resume(id) {
    const record = this.read(id); if (!record) throw new Error('Missing stake DKG history');
    if (record.release) return [structuredClone(record.release)];
    if (record.state.phase === 'dealing' && !record.state.deals[this.j])
      return this.advance(record, { type: 'message', now: this.now(), message: { kind: 'dkgDeal', from: this.identity.publicKey, body: record.state.ownDeal } }, true);
    return this.advance(record, { type: 'resume', now: this.now() });
  }
  readiness(id, votes) {
    const record = this.read(id); if (!record) throw new Error('Missing stake DKG history');
    if (record.release) throw new Error('Stake address is retired');
    if (!Array.isArray(votes) || votes.length < 3 || votes.length > 4 || new Set(votes.map(v => v.from)).size !== votes.length)
      throw new Error('Three distinct original readiness signatures required');
    const messages = votes.map(v => ({ kind: 'lockReady', from: v.from, body: verifyFact(v, this.context, 'dkg-ready', v.from).body }));
    const ready = dkg.identicalReady(messages, committeeFor(this.context.epoch), id, undefined, 3);
    if (!ready || ready.chain !== 'trac') throw new Error('Stake readiness differs');
    if (record.lock && stableJSON({ A: record.lock.A, C: record.lock.C, Q: record.lock.Q, address: record.lock.address }) !==
        stableJSON({ A: ready.A, C: ready.C, Q: ready.Q, address: ready.address })) throw new Error('Local stake commitments differ');
    return structuredClone(ready);
  }
  recover(id, { deals, ready }) {
    const record = this.read(id); if (!record || record.release) throw new Error('Missing active stake DKG history');
    this.readiness(id, ready);
    const messages = deals.map(v => ({ kind: 'dkgDeal', from: v.from, body: verifyFact(v, this.context, 'dkg-deal', v.from).body }));
    const readiness = ready.map(v => ({ kind: 'lockReady', from: v.from, body: verifyFact(v, this.context, 'dkg-ready', v.from).body }));
    return this.advance(record, { type: 'recover', now: this.now(), deals: messages, ready: readiness });
  }
  release(id, decisionCertificate, ledger) {
    const record = this.read(id); if (!record?.lock || record.state.phase !== 'ready') throw new Error('Stake share unavailable');
    const decision = verifyCertificate(decisionCertificate, this.context, 'decision'), digest = factDigest(decision);
    if (!Number.isSafeInteger(decision.body.at) || decision.body.at > uint.parse(this.now())) throw new Error('Future stake decision');
    if (record.release) {
      if (record.release.fact.body.decisionDigest !== digest) throw new Error('Stake already has an immutable winner');
      return structuredClone(record.release);
    }
    if (ledger.context.networkId !== this.context.networkId || ledger.context.venueKey !== this.context.venueKey || ledger.context.epoch.id !== this.context.epoch.id)
      throw new Error('Stake release ledger scope differs');
    const piece = ledger.read().pieces[id];
    if (!piece || stableJSON(piece.descriptor) !== stableJSON(record.descriptor) || piece.address !== record.lock.address ||
        !decision.body.pieces?.some(p => p.unitId === id && p.generation === piece.generation)) throw new Error('Stake release binding differs');
    // Validate winner, reservation and immutable generation, then persist the decision before sealing a share.
    ledger.decide(decisionCertificate);
    const scope = { positionId: id, decisionDigest: digest, winnerAddress: decision.body.winnerAddress, j: this.j };
    const sealed = dkg.sealShare(hexToBytes(record.lock.share, 32), decision.body.winnerBoxKey, scope, 'release');
    record.release = this.fact('release', { ...scope, A: record.lock.A, C: record.lock.C, sealed });
    this.save(record); return structuredClone(record.release);
  }
}
