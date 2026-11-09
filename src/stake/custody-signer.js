import { z } from 'zod';
import { StakeLedger, unitId } from './ledger.js';
import { CapacityLedger, assertEpochAdmission, capacityName, abandonSchema } from './capacity.js';
import { StakeDkg } from './dkg.js';
import { effectiveSettings, validatePolicyTransition } from './settings.js';
import { stakeContext } from './price-service.js';
import { signFact, verifyFact, verifyCertificate, factDigest } from './certificates.js';
import { stableJSON, sha256Hex } from '../core/canonical.js';
import { validAddressProof } from '../core/address-proof.js';
import { transferNonce } from '../trac/transfers.js';

const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const exact = (body, keys) => { if (!body || Object.keys(body).some(k => !keys.includes(k))) throw new Error('Unknown custody request field'); };

export class StakeCustodySigner {
  constructor({ store, identity, box, registry, clock, trac, price, verifyFunding, timeoutNow }) {
    if (typeof verifyFunding !== 'function') throw new Error('Exact stake funding verifier required');
    Object.assign(this, { store, identity, box, registry, clock, trac, price, verifyFunding, timeoutNow }); this.queue = Promise.resolve();
  }
  context() { return stakeContext({ sellerBond: this.selectedPolicy ?? this.registry().sellerBond }); }
  ledger(address) { return new StakeLedger({ store: this.store, context: this.context(), address }); }
  dkg(at) { return new StakeDkg({ store: this.store, context: this.context(), identity: this.identity, box: this.box, now: () => at, timeoutNow: this.timeoutNow }); }
  capacity() { return new CapacityLedger({ store: this.store, context: this.context(), identity: this.identity }); }
  sign(kind, body) {
    const c = this.context();
    return signFact({ v: 1, networkId: c.networkId, venueKey: c.venueKey, epochId: c.epoch.id, kind, body }, this.identity.secretKey);
  }
  handle(method, body, from) {
    const work = this.queue.then(async () => {
      const current = this.registry()?.sellerBond;
      if (!current) throw new Error('A signed stake policy is required');
      if (['capacityHandoffVote', 'capacityHandoffAdopt'].includes(method)) {
        if (from !== current.venueKey) throw new Error('Venue handoff authorization required');
        exact(body, ['previousEpochId', 'nextPolicy', 'certificate']);
        const previous = current.epoch.id === body.previousEpochId ? current : this.store.get(`stake-retained-epoch-${body.previousEpochId}`);
        if (!previous || previous.networkId !== current.networkId || previous.venueKey !== current.venueKey) throw new Error('Pinned original epoch required');
        const { at } = await this.clock(), next = validatePolicyTransition(previous, body.nextPolicy, at);
        const oldContext = stakeContext({ sellerBond: previous }), nextContext = stakeContext({ sellerBond: next });
        if (method === 'capacityHandoffVote') {
          const capacity = new CapacityLedger({ store: this.store, context: oldContext, identity: this.identity });
          const funded = new Set(this.store.list('stake-ledger-').flatMap(name => Object.values(this.store.get(name)?.pieces ?? {})
            .filter(p => p.fundingCertificate && p.descriptor.networkId === previous.networkId && p.descriptor.venueKey === previous.venueKey)
            .map(p => p.unitId)));
          if (Object.values(capacity.read().pieces).some(p => !p.retired && !funded.has(p.unitId)))
            throw new Error('Finish pending stake funding before handoff');
          this.store.put(`stake-retained-epoch-${previous.epoch.id}`, previous);
          return capacity.handoffVote(nextContext, at);
        }
        const capacity = new CapacityLedger({ store: this.store, context: nextContext, identity: this.identity });
        const adopted = capacity.adoptHandoff(body.certificate, oldContext);
        this.store.put(`stake-retained-epoch-${previous.epoch.id}`, previous);
        this.store.put(`stake-capacity-successor-${next.epoch.id}`, next);
        this.store.put(`stake-epoch-draining-${next.epoch.id}`, { previousEpochId: previous.epoch.id });
        return { adopted: true, epochId: next.epoch.id,
          retirements: Object.values(adopted.pieces).filter(p => p.retired).map(p => p.retirementCertificate) };
      }
      if (method === 'capacityRetire') {
        exact(body, ['certificate']);
        const state = this.store.get(capacityName(current));
        const policy = state && state.epochId !== current.epoch.id
          ? this.store.get(`stake-capacity-successor-${state.epochId}`) ?? this.store.get(`stake-retained-epoch-${state.epochId}`) : current;
        if (!policy || policy.networkId !== current.networkId || policy.venueKey !== current.venueKey) throw new Error('Original capacity policy required');
        new CapacityLedger({ store: this.store, context: stakeContext({ sellerBond: policy }), identity: this.identity }).retire(body.certificate);
        return { retired: true };
      }
      const id = body?.unitId ?? body?.unitIds?.[0] ?? body?.pieces?.[0]?.unitId ?? body?.decision?.pieces?.[0]?.unitId ??
        body?.certificate?.[0]?.fact.body.unitId ?? body?.certificate?.[0]?.fact.body.pieces?.[0]?.unitId ??
        body?.accepts?.[0]?.fact.body.pieces?.[0]?.unitId;
      const record = hex.safeParse(id).success ? this.store.get(`stake-dkg-${id}`) : null;
      const epoch = record?.descriptor.epochId ?? body?.descriptor?.epochId ?? current.epoch.id;
      const retained = this.store.get(`stake-retained-epoch-${epoch}`);
      this.selectedPolicy = ['capacityPropose', 'capacityVote', 'dkgStart'].includes(method) ? current : retained ?? current;
      if (this.selectedPolicy.epoch.id !== epoch || this.selectedPolicy.networkId !== current.networkId || this.selectedPolicy.venueKey !== current.venueKey)
        throw new Error('Original stake epoch is unavailable');
      try {
        if (['capacityVote', 'dkgStart'].includes(method) && !retained)
          this.store.put(`stake-retained-epoch-${epoch}`, this.selectedPolicy);
        return await this.apply(method, body, from);
      } finally { this.selectedPolicy = null; }
    }); this.queue = work.catch(() => {}); return work;
  }
  // This member voted to release the piece's capacity because its key setup failed before any funding.
  abandoned(id) { return !!this.store.get(`stake-abandon-vote-${id}`); }
  piece(id, from) {
    hex.parse(id); const record = this.dkg(0).read(id);
    if (!record || record.descriptor.owner.dexKey !== from) throw new Error('Stake owner authorization required');
    return record;
  }
  async apply(method, b, from) {
    const c = this.context(), { at } = await this.clock(), policy = this.selectedPolicy;
    const settings = effectiveSettings(policy, at)?.settings;
    if (!settings) throw new Error('Stake settings are not effective');
    const dkg = this.dkg(at);
    if (['capacityPropose', 'capacityVote'].includes(method)) {
      exact(b, ['descriptors', 'proof', 'price', 'grant', 'replacement']);
      if (!policy.acceptNew || !policy.custody || !Array.isArray(b.descriptors) || !b.descriptors.length || b.descriptors.length > 100)
        throw new Error('Stake creation is unavailable');
      const price = await this.price.import(b.price);
      let replacement;
      if (b.replacement) {
        replacement = verifyCertificate(b.replacement, c, 'decision').body;
        if (!replacement.replacement || stableJSON(replacement.replacement.descriptors) !== stableJSON(b.descriptors))
          throw new Error('Certified replacement descriptors required');
        const ledger = this.ledger(b.descriptors[0].owner.tracAddr).read();
        if (ledger.decisions[replacement.decisionId]?.hash !== factDigest(b.replacement[0].fact) ||
            replacement.pieces.some(ref => ledger.pieces[ref.unitId]?.state !== 'retired' || !ledger.pieces[ref.unitId]?.collectionCertificate))
          throw new Error('Source collection must finish before replacement capacity');
      }
      for (const d of b.descriptors) {
        unitId(d);
        if (d.owner.dexKey !== from || d.createdAt > at || at - d.createdAt > policy.custody.fundingWindowSec ||
            (d.replacementOf ? !replacement : replacement || d.expiresAt !== d.createdAt + policy.custody.lifetimeSec) ||
            d.expiresAt <= at || d.tnkReserve !== policy.custody.tnkReserve ||
            !validAddressProof({ ...d.owner, tracProof: b.proof }, { networkId: c.networkId, now: at })) throw new Error('Invalid deposit owner or signed lifetime');
      }
      const options = { settings, price, now: at }, capacity = this.capacity();
      return method === 'capacityPropose' ? capacity.propose(b.descriptors, options) : capacity.vote(b.grant, b.descriptors, options);
    }
    if (method === 'dkgStart') {
      assertEpochAdmission(this.store, c);
      exact(b, ['descriptor', 'capacity']);
      if (b.descriptor?.owner.dexKey !== from || !policy.custody) throw new Error('Deposit owner required');
      const id = unitId(b.descriptor);
      if (this.abandoned(id) || this.capacity().read().pieces[id]?.retired) throw new Error('Stake piece was abandoned before funding');
      const grant = verifyCertificate(b.capacity, c, 'capacity');
      if (!this.capacity().read().grants[grant.body.grantId]) throw new Error('Recover the capacity grant before DKG');
      return { messages: dkg.start(b.descriptor, b.capacity, { timeoutSec: policy.custody.dkgTimeoutSec }) };
    }
    if (method === 'dkgDeals') {
      exact(b, ['unitId', 'deals']); this.piece(b.unitId, from);
      if (this.abandoned(b.unitId)) throw new Error('Stake piece was abandoned before funding');
      if (!Array.isArray(b.deals) || b.deals.length > 4) throw new Error('Invalid DKG bundle');
      const messages = [];
      for (const vote of b.deals) {
        if (vote.fact?.body?.positionId !== b.unitId) throw new Error('Wrong DKG unit');
        messages.push(...dkg.receive(vote));
      }
      messages.push(...dkg.resume(b.unitId));
      return { messages };
    }
    if (method === 'fundedVote') {
      exact(b, ['unitId', 'ready', 'funding', 'price']);
      const record = this.piece(b.unitId, from), d = record.descriptor;
      if (this.abandoned(b.unitId)) throw new Error('Stake piece was abandoned before funding');
      const lock = dkg.readiness(b.unitId, b.ready);
      const existing = this.store.get(`stake-funded-vote-${b.unitId}`);
      if (existing) return existing.vote;
      if (this.store.get(`stake-refund-vote-${b.unitId}`)) throw new Error('Funding already committed to return');
      const price = await this.price.import(b.price);
      if (!policy.custody || at >= d.createdAt + policy.custody.fundingWindowSec) throw new Error('Deposit funding window expired; recovery required');
      const balances = await this.trac.balances(lock.address);
      if (BigInt(balances.RESET) < BigInt(d.principalReset) || BigInt(balances.TNK) < BigInt(d.tnkReserve) ||
          BigInt(d.tnkReserve) < 3n * BigInt(balances.feeTnk)) throw new Error('Stake principal or TNK reserve is not confirmed');
      await this.verifyFunding({ descriptor: d, unitId: b.unitId, address: lock.address, funding: b.funding });
      // Capacity was committed before DKG and remains held until certified collection.
      const grant = this.capacity().read().pieces[b.unitId];
      if (!grant || grant.retired) throw new Error('Stake capacity is unavailable');
      const vote = this.sign('funded', { descriptor: d, unitId: b.unitId, address: lock.address, fundingDigest: sha256Hex(stableJSON(b.funding)) });
      this.store.put(`stake-funded-vote-${b.unitId}`, { vote, options: { settings, price, now: at } });
      return vote;
    }
    // A deposit piece whose key setup failed holds capacity but can never be funded: funding waits for three members'
    // readiness. A member votes to release it when its own setup failed (or never started within the funding window),
    // or when two other members show their votes: they never become ready, so three readiness signatures, and with
    // them a lock address, can never exist. A member that voted refuses that piece's setup, funding and return for
    // good. The certificate retires the capacity through capacityRetire.
    if (method === 'abandonVote') {
      exact(b, ['descriptor', 'votes']);
      const d = b.descriptor, id = unitId(d), name = `stake-abandon-vote-${id}`, prior = this.store.get(name);
      if (d.owner.dexKey !== from) throw new Error('Stake owner authorization required');
      if (prior) return prior;
      const held = this.capacity().read().pieces[id];
      if (!held || held.retired || held.ownerAddress !== d.owner.tracAddr || held.principalReset !== d.principalReset) throw new Error('Stake capacity is unavailable');
      if (this.store.get(`stake-funded-vote-${id}`) || this.store.get(`stake-refund-vote-${id}`) || this.ledger(d.owner.tracAddr).read().pieces[id])
        throw new Error('Stake piece may hold funding; it returns through its funding refund');
      const body = abandonSchema.parse({ unitId: id, ownerAddress: d.owner.tracAddr, principalReset: d.principalReset,
        descriptorDigest: sha256Hex(stableJSON(d)) }), fact = { v: 1, networkId: c.networkId, venueKey: c.venueKey, epochId: c.epoch.id, kind: 'capacity-abandon', body };
      if (b.votes !== undefined && (!Array.isArray(b.votes) || b.votes.length > 3)) throw new Error('Invalid abandonment votes');
      const others = new Set((b.votes ?? []).filter(v => {
        try { return v.from !== this.identity.publicKey && c.epoch.members.some(m => m.dexKey === v.from) &&
          factDigest(verifyFact(v, c, 'capacity-abandon', v.from)) === factDigest(fact); } catch { return false; }
      }).map(v => v.from));
      if (others.size < 2) {
        if (dkg.read(id)) {
          if (stableJSON(dkg.read(id).descriptor) !== stableJSON(d)) throw new Error('Stake creation conflicts');
          dkg.resume(id); // A setup past its wait settles first.
          if (dkg.read(id).state.phase !== 'failed') throw new Error('Stake key setup is still usable');
        } else if (at < d.createdAt + policy.custody.fundingWindowSec) throw new Error('Stake key setup may still start');
      }
      const vote = this.sign('capacity-abandon', body);
      this.store.put(name, vote); return vote;
    }
    if (method === 'fundedCommit') {
      exact(b, ['certificate']); const fact = verifyCertificate(b.certificate, c, 'funded');
      const id = fact.body.unitId, saved = this.store.get(`stake-funded-vote-${id}`), options = saved?.options;
      if (!options || factDigest(saved?.vote.fact) !== factDigest(fact)) throw new Error('Independent funding verification required');
      this.ledger(fact.body.descriptor.owner.tracAddr).admitFunded(b.certificate, options); return { funded: true };
    }
    if (method === 'fundedRecover') {
      exact(b, ['certificate', 'funding', 'price', 'inventoryCertificate']);
      const fact = verifyCertificate(b.certificate, c, 'funded'), f = fact.body;
      const record = this.piece(f.unitId, from), d = record.descriptor, ledger = this.ledger(d.owner.tracAddr);
      if (unitId(d) !== f.unitId || stableJSON(d) !== stableJSON(f.descriptor) || !record.lock || record.state.phase !== 'ready' ||
          record.lock.address !== f.address || record.release || this.abandoned(f.unitId) || this.store.get(`stake-refund-vote-${f.unitId}`))
        throw new Error('Original active funding custody required');
      const grant = this.capacity().read().pieces[f.unitId];
      if (!grant || grant.retired) throw new Error('Stake capacity is unavailable');
      const saved = this.store.get(`stake-funded-vote-${f.unitId}`);
      if (saved && factDigest(saved.vote.fact) !== factDigest(fact)) throw new Error('Conflicting original funding vote');
      const prior = ledger.read().pieces[f.unitId];
      if (!prior) {
        if (sha256Hex(stableJSON(b.funding)) !== f.fundingDigest) throw new Error('Funding receipts differ from certificate');
        const balances = await this.trac.balances(f.address);
        if (BigInt(balances.RESET) < BigInt(d.principalReset) || BigInt(balances.TNK) < BigInt(d.tnkReserve) ||
            BigInt(d.tnkReserve) < 3n * BigInt(balances.feeTnk)) throw new Error('Stake principal or TNK reserve is not confirmed');
        await this.verifyFunding({ descriptor: d, unitId: f.unitId, address: f.address, funding: b.funding });
      }
      const price = await this.price.import(b.price), options = { settings, price, now: at };
      const piece = ledger.recoverFunded(b.certificate, options, b.inventoryCertificate);
      // Retain the exact independently checked fact so ordinary fundedCommit
      // retries from released apps continue to work after catch-up.
      this.store.put(`stake-funded-vote-${f.unitId}`, { vote: this.sign('funded', f), options });
      return { funded: true, generation: piece.generation };
    }
    if (method === 'refundVote') {
      exact(b, ['unitId', 'ready', 'returnReset']);
      if (this.abandoned(b.unitId)) throw new Error('Stake piece was abandoned before funding');
      const record = this.piece(b.unitId, from), d = record.descriptor, lock = dkg.readiness(b.unitId, b.ready);
      const name = `stake-refund-vote-${b.unitId}`, prior = this.store.get(name);
      if (prior) return prior;
      if (at < d.createdAt + policy.custody.fundingWindowSec || this.store.get(`stake-funded-vote-${b.unitId}`) ||
          this.ledger(d.owner.tracAddr).read().pieces[b.unitId]) throw new Error('Funding is still eligible or may already be admitted');
      const balances = await this.trac.balances(lock.address), grant = this.capacity().read().pieces[b.unitId];
      if (!grant || grant.retired || balances.RESET !== b.returnReset) throw new Error('Funding refund balance or capacity differs');
      const vote = this.sign('funding-refund', { descriptor: d, unitId: b.unitId, address: lock.address, returnReset: balances.RESET, exposureUsd: grant.exposureUsd });
      this.store.put(name, vote); return vote;
    }
    if (method === 'refundCommit') {
      exact(b, ['certificate']); const fact = verifyCertificate(b.certificate, c, 'funding-refund');
      const p = this.piece(fact.body.unitId, from);
      return this.ledger(p.descriptor.owner.tracAddr).admitRefund(b.certificate);
    }
    if (method === 'freezePrepare') {
      exact(b, ['operationId', 'pieces']); hex.parse(b.operationId);
      if (!Array.isArray(b.pieces) || !b.pieces.length || b.pieces.length > 100) throw new Error('Invalid withdrawal size');
      const first = this.piece(b.pieces[0].unitId, from), ledger = this.ledger(first.descriptor.owner.tracAddr);
      for (const ref of b.pieces) if (this.piece(ref.unitId, from).descriptor.owner.tracAddr !== first.descriptor.owner.tracAddr) throw new Error('Mixed withdrawal owner');
      return this.sign('freeze-accept', ledger.prepareFreeze({ ...b, acceptedAt: at }));
    }
    if (method === 'withdrawIntent') {
      exact(b, ['operationId', 'unitIds']);
      if (!Array.isArray(b.unitIds) || !b.unitIds.length || b.unitIds.length > 100) throw new Error('Invalid withdrawal intent');
      const first = this.piece(b.unitIds[0], from);
      for (const id of b.unitIds) if (this.piece(id, from).descriptor.owner.tracAddr !== first.descriptor.owner.tracAddr) throw new Error('Mixed withdrawal owner');
      return this.sign('withdraw-intent', this.ledger(first.descriptor.owner.tracAddr).requestWithdrawal(b));
    }
    if (method === 'freezeVote') {
      exact(b, ['accepts']);
      if (!Array.isArray(b.accepts) || b.accepts.length < 3 || b.accepts.length > 4 || new Set(b.accepts.map(v => v.from)).size !== b.accepts.length) throw new Error('Withdrawal barrier quorum required');
      const accepts = b.accepts.map(v => {
        if (!c.epoch.members.some(m => m.dexKey === v.from)) throw new Error('Unknown withdrawal signer');
        return verifyFact(v, c, 'freeze-accept', v.from).body;
      });
      const { operationId, pieces } = accepts[0], acceptedAt = Math.max(...accepts.map(a => a.acceptedAt));
      if (acceptedAt > at || accepts.some(a => a.operationId !== operationId || stableJSON(a.pieces) !== stableJSON(pieces))) throw new Error('Withdrawal barriers disagree');
      const p = this.piece(pieces[0].unitId, from), ledger = this.ledger(p.descriptor.owner.tracAddr);
      const own = ledger.read().freezeVotes?.[operationId];
      if (!own || own.acceptedAt > acceptedAt || stableJSON(own.pieces) !== stableJSON(pieces)) throw new Error('Local withdrawal barrier is missing');
      const vote = this.sign('freeze', { operationId, pieces, acceptedAt, withdrawDelaySec: settings.stake.withdrawDelaySec });
      const name = `stake-freeze-vote-${operationId}`, prior = this.store.get(name);
      if (prior && factDigest(prior.fact) !== factDigest(vote.fact)) throw new Error('Withdrawal vote already fixed');
      this.store.put(name, vote); return vote;
    }
    if (method === 'freezeCommit') {
      exact(b, ['certificate']); const f = verifyCertificate(b.certificate, c, 'freeze');
      const p = this.piece(f.body.pieces[0].unitId, from);
      return this.ledger(p.descriptor.owner.tracAddr).freeze(b.certificate, settings);
    }
    if (method === 'returnVote') {
      exact(b, ['decision']);
      if (!['seller-withdraw', 'seller-expiry', 'seller-unfunded'].includes(b.decision?.outcome) || b.decision.at > at) throw new Error('Only matured withdrawal returns are accepted');
      const p = this.piece(b.decision.pieces?.[0]?.unitId, from), ledger = this.ledger(p.descriptor.owner.tracAddr);
      for (const ref of b.decision.pieces) this.piece(ref.unitId, from);
      return this.sign('decision', ledger.prepareDecision(b.decision));
    }
    if (method === 'release') {
      exact(b, ['unitId', 'certificate']); hex.parse(b.unitId); const p = dkg.read(b.unitId);
      if (!p) throw new Error('Original stake record required');
      return dkg.release(b.unitId, b.certificate, this.ledger(p.descriptor.owner.tracAddr));
    }
    if (method === 'collectedVote') {
      exact(b, ['unitId', 'txHash', 'amount', 'asset']); hex.parse(b.unitId); const p = dkg.read(b.unitId);
      if (!p) throw new Error('Original stake record required');
      const ledger = this.ledger(p.descriptor.owner.tracAddr);
      const piece = ledger.read().pieces[b.unitId], decision = ledger.read().decisions[piece?.decisionId];
      const emptyRefund = piece?.refundCertificate && piece.returnReset === '0', asset = b.asset ?? 'RESET';
      if (!decision || !/^(0|[1-9][0-9]*)$/.test(b.amount) ||
          (!emptyRefund && (asset !== 'RESET' || BigInt(b.amount) < BigInt(piece.returnReset ?? p.descriptor.principalReset)))) throw new Error('No principal return is authorized');
      if (emptyRefund) {
        const balance = await this.trac.balances(p.lock.address);
        if (asset !== 'TNK' || balance.RESET !== '0' || BigInt(balance.TNK) > BigInt(balance.feeTnk)) throw new Error('Funding residue is not collected');
      }
      if (b.txHash !== null) {
        const id = sha256Hex(`intercom-locks/v1/sweep:${b.unitId}:${p.lock.A}:${asset}`);
        const proof = await this.trac.verifyTransfer({ asset, txHash: b.txHash, from: p.lock.address,
          to: decision.winnerAddress, minAmount: b.amount, nonce: transferNonce(id), tradeId: id, finalBefore: Number.MAX_SAFE_INTEGER, fresh: true });
        if (!proof.ok || !proof.final) throw new Error('Principal collection is not finalized');
      } else if (!emptyRefund || b.amount !== '0') throw new Error('Principal transaction required');
      const name = `stake-collected-vote-${b.unitId}`, prior = this.store.get(name);
      const vote = this.sign('collected', { unitId: b.unitId, generation: piece.generation, decisionId: piece.decisionId, txHash: b.txHash,
        ...(emptyRefund ? { asset: 'TNK' } : {}) });
      if (prior && factDigest(prior.fact) !== factDigest(vote.fact)) throw new Error('Collection vote already fixed');
      this.store.put(name, vote); return vote;
    }
    if (method === 'collectedCommit') {
      exact(b, ['certificate']); const f = verifyCertificate(b.certificate, c, 'collected'), p = dkg.read(f.body.unitId);
      if (!p) throw new Error('Original stake record required');
      this.ledger(p.descriptor.owner.tracAddr).collected(b.certificate); this.capacity().retire(b.certificate); return { retired: true };
    }
    throw new Error('Unsupported custody request');
  }
}
