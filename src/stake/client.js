import { randomBytes } from 'node:crypto';
import { effectiveSettings } from './settings.js';
import { StakeLedger, unitId } from './ledger.js';
import { splitDeposit, allocatePieces, usdForReset } from './amounts.js';
import { stakeContext } from './price-service.js';
import { verifyCertificate, verifyFact, factDigest, matchingCertificate } from './certificates.js';
import { sha256Hex, stableJSON, fromLe32 } from '../core/canonical.js';
import { fundingNonce, sweep, address as lockAddress } from '../locks/trac-lock.js';
import { identicalReady, openShare } from '../locks/dkg.js';
import { reconstruct, publicOf, verifyShare } from '../locks/crypto/edvss.js';

const random = () => randomBytes(32).toString('hex');
const tnkText = units => { const v = BigInt(units), whole = v / 10n ** 18n, frac = (v % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`; };
// Each piece is its own Trac lock: the deposit pays two transfer fees per piece and leaves a reserve in it, so the
// lock can pay its own fee when the RESET goes back out. The unspent part of the reserve comes back.
export function tnkShort(count, reserve, fee, free) {
  const need = count * (reserve + 2n * fee), back = reserve > 2n * fee ? count * (reserve - 2n * fee) : 0n;
  return `This deposit needs ${tnkText(need)} TNK and the wallet has ${tnkText(free)} TNK free. The stake is split into ${count} ` +
    `piece${count === 1n ? '' : 's'}; each piece pays two Trac network fees (${tnkText(2n * fee)} TNK) and keeps ${tnkText(reserve)} TNK so it can pay ` +
    `its own fee when the RESET is returned. About ${tnkText(back)} TNK comes back when you withdraw. Buy TNK on intercom-dex or send TNK to this wallet, then try again.`;
}
const positive = x => typeof x === 'string' && /^[1-9][0-9]{0,30}$/.test(x);
// Deposit pieces released because their key setup failed: nothing was sent to them.
const notDeposited = op => op.pieces.some(p => p.abandoned)
  ? { notDeposited: op.pieces.filter(p => p.abandoned).reduce((n, p) => n + BigInt(p.descriptor.principalReset), 0n).toString() } : {};
export class StakeClient {
  constructor({ store, identity, box, me, registry, clock, trac, price, request, funding, collector, exclusive = fn => fn(), freeBalances = null, log = () => {} }) {
    Object.assign(this, { store, identity, box, me, registry, clock, trac, price, request, funding, collector, exclusive, freeBalances, log });
    this.queue = Promise.resolve();
    this.retirementQueue = Promise.resolve();
  }
  context() { return this.operationContext ?? stakeContext(this.registry()); }
  ledger() { return new StakeLedger({ store: this.store, context: this.context(), address: this.me.tracAddr }); }
  save(op) {
    this.store.put('stake-client-operation', this.rootOperation ?? op);
  }
  async all(method, body, members = this.context().epoch.members) {
    const results = await Promise.allSettled(members.map(m => this.request(m.dexKey, method, body)));
    const good = results.flatMap((r, i) => r.status === 'fulfilled' && (!r.value?.from || r.value.from === members[i].dexKey) ? [r.value] : []);
    if (good.length < 3) throw new Error(`Stake quorum unavailable for ${method}: ${results.find(r => r.status === 'rejected')?.reason?.message ?? ''}`);
    return good;
  }
  async certificate(method, body, kind) {
    return matchingCertificate(await this.all(method, body), this.context(), kind);
  }
  // Members whose own setup failed vote first; two of their votes let the others vote too (custody-signer abandonVote).
  async abandonCertificate(descriptor) {
    const members = this.context().epoch.members, ask = async (list, body) => (await Promise.allSettled(list.map(m =>
      this.request(m.dexKey, 'abandonVote', body)))).flatMap((r, i) => r.status === 'fulfilled' && r.value?.from === list[i].dexKey ? [r.value] : []);
    let votes = await ask(members, { descriptor });
    if (votes.length === 2) votes = [...votes, ...await ask(members.filter(m => !votes.some(v => v.from === m.dexKey)), { descriptor, votes })];
    return matchingCertificate(votes, this.context(), 'capacity-abandon');
  }
  async archive(kind, certificate) { return this.request(this.context().venueKey, 'custodyRecord', { kind, certificate }); }
  retirementWork(fn) {
    const work = this.retirementQueue.then(fn); this.retirementQueue = work.catch(() => {}); return work;
  }
  retireCapacity(certificate, context = this.context()) { return this.retirementWork(async () => {
    const fact = verifyCertificate(certificate, context, certificate?.[0]?.fact.kind === 'capacity-abandon' ? 'capacity-abandon' : 'collected');
    const name = `stake-capacity-retirement-${fact.body.unitId}`, prior = this.store.get(name);
    if (prior && factDigest(prior.certificate[0].fact) !== factDigest(fact)) throw new Error('Conflicting capacity retirement');
    const op = prior ?? { certificate, context, members: context.epoch.members.map(m => m.dexKey), confirmed: [] };
    const policy = this.retirementPolicy(op);
    await this.sendRetirement(name, op, policy);
    // Preserve the successor quorum boundary; a missed fourth member remains
    // in the durable outbox even after the money operation has completed.
    if (policy && policy.epoch.id !== context.epoch.id &&
        policy.epoch.members.filter(m => op.confirmed.includes(m.dexKey)).length < 3)
      throw new Error('Stake quorum unavailable for capacityRetire');
  }); }
  retirementPolicy(op) {
    const policy = this.registry()?.sellerBond;
    return policy?.networkId === op.context.networkId && policy.venueKey === op.context.venueKey ? policy : null;
  }
  async sendRetirement(name, op, policy) {
    op.members = [...new Set([...op.members, ...(policy?.epoch.members.map(m => m.dexKey) ?? [])])];
    op.done = op.members.every(key => op.confirmed.includes(key));
    this.store.put(name, op); // Retain the certificate and every destination before sending.
    const pending = op.members.filter(key => !op.confirmed.includes(key));
    const results = await Promise.allSettled(pending.map(async key => {
      const reply = await this.request(key, 'capacityRetire', { certificate: op.certificate });
      if (reply?.retired !== true || reply.from && reply.from !== key) throw new Error('Retirement not confirmed');
      return key;
    }));
    op.confirmed.push(...results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []));
    op.done = op.members.every(key => op.confirmed.includes(key));
    this.store.put(name, op);
  }
  recoverRetirements() { return this.retirementWork(async () => {
    for (const name of this.store.list('stake-capacity-retirement-')) {
      const op = this.store.get(name);
      if (op && !op.done) await this.sendRetirement(name, op, this.retirementPolicy(op));
    }
  }); }
  run(fn) { const work = this.queue.then(() => this.exclusive(fn)); this.queue = work.catch(() => {}); return work; }
  async preview(amount) {
    if (!positive(amount)) throw new Error('Stake deposit requires positive base units');
    const { at } = await this.clock(), policy = this.registry()?.sellerBond;
    const settings = policy && effectiveSettings(policy, at)?.settings;
    if (!policy?.acceptNew || !policy.custody || !settings) throw new Error('Stake creation is unavailable');
    const snapshot = await this.request(policy.venueKey, 'priceSnapshot', {}), q = await this.price.import(snapshot);
    const pieces = splitDeposit(amount, q), balances = await this.trac.balances(this.me.tracAddr);
    const available = this.freeBalances ? await this.freeBalances() : { TNK: { free: balances.TNK }, RESET: { free: balances.RESET } };
    const reserve = BigInt(policy.custody.tnkReserve), fee = BigInt(balances.feeTnk), count = BigInt(pieces.length);
    const depositUsd = usdForReset(amount, q, true), active = Object.values(this.ledger().read().pieces).filter(p => p.state !== 'retired');
    const heldUsd = active.reduce((sum, p) => sum + BigInt(p.exposureUsd), 0n);
    const markedUsd = active.reduce((sum, p) => sum + BigInt(usdForReset(p.descriptor.principalReset, q, true)), 0n);
    if (active.length + pieces.length > 200 ||
        [heldUsd, markedUsd].some(held => held + BigInt(depositUsd) > BigInt(settings.stake.maxUsdPerAddress))) throw new Error('This deposit exceeds the stake cap. Reduce the amount.');
    if (reserve < 3n * fee) throw new Error('The Trac network fee is above the stake lock reserve right now. Try again later.');
    if (BigInt(available.TNK.free) < count * (reserve + 2n * fee)) throw new Error(tnkShort(count, reserve, fee, available.TNK.free));
    if (BigInt(available.RESET.free) < BigInt(amount)) throw new Error('The wallet does not have enough free RESET for this deposit.');
    return { amount, pieces: pieces.length, tnkFee: (2n * fee * count).toString(), tnkReserve: (reserve * count).toString(),
      tnkTotal: (count * (reserve + 2n * fee)).toString(), maintenanceTnk: (count * (reserve + 2n * fee)).toString(), depositUsd, capUsd: settings.stake.maxUsdPerAddress,
      expiresAt: at + policy.custody.lifetimeSec, withdrawDelaySec: settings.stake.withdrawDelaySec, capacityPending: true };
  }
  deposit(amount) {
    if (this.depositPending) return this.depositAmount === amount ? this.depositPending : Promise.reject(new Error('A stake deposit is already pending'));
    const requested = this.store.get('stake-client-operation');
    const requestedId = requested && !requested.done ? requested.operationId : null;
    if (!positive(amount)) return Promise.reject(new Error('Stake deposit requires positive base units'));
    const work = this.run(async () => {
      let op = this.store.get('stake-client-operation');
      if (requestedId && op?.operationId === requestedId && op.done) return this.receipt(op);
      if (op && !op.done && (op.kind !== 'deposit' || op.amount !== amount)) throw new Error('A stake operation is already pending');
      if (!op || op.done) {
        const preview = await this.preview(amount);
        const { at } = await this.clock(), policy = this.registry()?.sellerBond, settings = effectiveSettings(policy, at)?.settings;
        if (!policy.acceptNew || !policy.custody || !settings) throw new Error('Stake creation is unavailable');
        const snapshot = await this.request(policy.venueKey, 'priceSnapshot', {}), q = await this.price.import(snapshot);
        const pieces = splitDeposit(amount, q), balances = await this.trac.balances(this.me.tracAddr);
        const available = this.freeBalances ? await this.freeBalances() : { TNK: { free: balances.TNK }, RESET: { free: balances.RESET } };
        const reserve = BigInt(policy.custody.tnkReserve), fee = BigInt(balances.feeTnk);
        if (reserve < 3n * fee) throw new Error('The Trac network fee is above the stake lock reserve right now. Try again later.');
        if (BigInt(available.TNK.free) < BigInt(pieces.length) * (reserve + 2n * fee)) throw new Error(tnkShort(BigInt(pieces.length), reserve, fee, available.TNK.free));
        if (BigInt(available.RESET.free) < BigInt(amount)) throw new Error('The wallet does not have enough free RESET for this deposit.');
        const batchId = random(), owner = { dexKey: this.identity.publicKey, tracAddr: this.me.tracAddr, boxKey: this.box.publicKey };
        this.store.put(`stake-client-epoch-${policy.epoch.id}`, policy);
        op = { kind: 'deposit', operationId: batchId, amount, preview, policy, settings, q, snapshot, context: this.context(),
          proof: await this.trac.proveAddress({ dexKey: owner.dexKey, expiresAt: at + policy.custody.fundingWindowSec }),
          pieces: pieces.map(p => ({ descriptor: { networkId: policy.networkId, venueKey: policy.venueKey, epochId: policy.epoch.id,
            batchId, nonce: random(), owner, purpose: 'seller', principalReset: p.principalReset, tnkReserve: reserve.toString(),
            createdAt: at, expiresAt: at + policy.custody.lifetimeSec } })) };
        this.save(op);
        this.store.put(`stake-maintenance-budget-${batchId}`, { limit: (BigInt(pieces.length) * (reserve + 2n * fee)).toString(), allocations: {} });
      }
      return this.advance(op);
    }).catch(error => this.pendingOrThrow(error, 'deposit'));
    this.depositAmount = amount; this.depositPending = work;
    work.finally(() => { if (this.depositPending === work) this.depositPending = null; }).catch(() => {});
    return work;
  }
  withdraw(amount = 'all') {
    if (amount !== 'all' && !positive(amount)) return Promise.reject(new Error('Stake withdrawal requires base units or all'));
    return this.run(async () => {
      let op = this.store.get('stake-client-operation');
      if (op && !op.done && (op.kind !== 'withdraw' || op.amount !== amount)) throw new Error('A stake operation is already pending');
      if (!op || op.done) {
        const inventory = Object.values(this.ledger().read().pieces).filter(p => p.state !== 'retired' && p.descriptor.owner.dexKey === this.identity.publicKey);
        const available = inventory.filter(p => p.state === 'free' && !p.withdrawal && !p.decisionVote);
        const eligible = inventory.filter(p => ['free', 'reserved', 'evidence-pending'].includes(p.state) && !p.withdrawal && !p.decisionVote);
        const allocation = amount === 'all' ? null : allocatePieces(available.map(p => ({ ...p, ...p.descriptor })), amount)
          ?? allocatePieces(eligible.map(p => ({ ...p, ...p.descriptor })), amount);
        const chosen = (amount === 'all' ? inventory : allocation?.pieces)?.sort((a, b) => a.unitId.localeCompare(b.unitId));
        if (!chosen?.length || chosen.length > 200) throw new Error('No stake pieces available for this withdrawal');
        const epochs = [...new Set(chosen.map(p => p.descriptor.epochId))];
        const policies = Object.fromEntries(epochs.map(id => {
          const policy = this.store.get(`stake-client-epoch-${id}`) ?? this.registry().sellerBond;
          if (policy.epoch.id !== id) throw new Error('Original stake policy is unavailable');
          return [id, policy];
        })), policy = policies[epochs[0]];
        let remaining = amount === 'all' ? chosen.reduce((n, p) => n + BigInt(p.descriptor.principalReset), 0n) : BigInt(amount);
        const targets = chosen.map(p => { const total = BigInt(p.descriptor.principalReset), value = remaining < total ? remaining : total;
          remaining -= value; return { unitId: p.unitId, amount: value.toString(), operationId: random() }; });
        op = { kind: 'withdraw', operationId: random(), amount, policy, policies, context: stakeContext({ sellerBond: policy }), targets, batches: [],
          pieces: chosen.map(p => ({ unitId: p.unitId, generation: p.generation })).sort((a, b) => a.unitId.localeCompare(b.unitId)) };
        this.save(op);
      }
      return this.advance(op);
    });
  }
  receipt(op) {
    return { ok: true, operationId: op.operationId, ...(op.kind === 'deposit' ? {
      funded: op.pieces.filter(p => p.funded).reduce((n, p) => n + BigInt(p.descriptor.principalReset), 0n).toString(),
      ...(op.pieces.some(p => p.refund) ? { refunded: op.pieces.filter(p => p.refund).reduce((n, p) => n + BigInt(p.refund[0].fact.body.returnReset), 0n).toString() } : {}),
      ...notDeposited(op)
    } : { collected: !op.targets?.some(t => t.forfeited),
      ...(op.targets ? { returned: op.targets.filter(t => !t.forfeited).reduce((n, t) => n + BigInt(t.amount), 0n).toString(),
        forfeited: op.targets.filter(t => t.forfeited).reduce((n, t) => n + BigInt(t.amount), 0n).toString() } : {}) }) };
  }
  pendingOrThrow(error, kind) {
    const op = this.store.get('stake-client-operation');
    if (!op || op.done || op.kind !== kind) throw error;
    const money = kind === 'deposit' ? op.pieces.flatMap(p => ['TNK', 'RESET'].flatMap(asset => {
      const intent = this.store.get(`locks-trac-${sha256Hex(`stake-fund:${unitId(p.descriptor)}:${asset}`)}`);
      return intent ? [{ asset, amount: intent.amount, direction: 'outgoing', tx: intent.txHash,
        state: p.funding?.[asset] ? 'confirmed' : 'unknown' }] : [];
    })) : [];
    return { ok: true, pending: true, state: 'pending', operationId: op.operationId, message: error.message, money };
  }
  recover() { return this.run(async () => {
    await this.recoverRetirements();
    let op = this.store.get('stake-client-operation');
    if (op && !op.done) return this.advance(op);
    if (!this.registry()?.sellerBond) return;
    const { at } = await this.clock();
    const due = Object.values(this.ledger().read().pieces).filter(p => ['free', 'withdrawing'].includes(p.state) &&
      !p.decisionVote && !p.decisionId && p.descriptor.expiresAt <= at);
    if (!due.length) return;
    const epochId = due[0].descriptor.epochId, policy = this.store.get(`stake-client-epoch-${epochId}`);
    if (!policy) throw new Error('Original expiry policy is unavailable');
    op = { kind: 'withdraw', expiry: true, operationId: random(), amount: 'all', policy, context: stakeContext({ sellerBond: policy }),
      pieces: due.filter(p => p.descriptor.epochId === epochId).slice(0, 100).map(p => ({ unitId: p.unitId, generation: p.generation }))
        .sort((a, b) => a.unitId.localeCompare(b.unitId)) };
    this.save(op); return this.advance(op);
  }); }
  async advance(op) {
    this.operationContext = op.context;
    this.rootOperation = op;
    try { return await (op.kind === 'deposit' ? this.fund(op) : op.targets ? this.collectRequest(op) : this.collect(op)); }
    finally { this.operationContext = null; this.rootOperation = null; }
  }

  async collectRequest(op) {
    for (const target of op.targets) {
      let piece = this.ledger().read().pieces[target.unitId];
      const policy = op.policies?.[piece.descriptor.epochId] ?? op.policy;
      if (policy.epoch.id !== piece.descriptor.epochId) throw new Error('Original return policy is unavailable');
      this.operationContext = stakeContext({ sellerBond: policy });
      if (!target.intent) {
        target.intent = await this.certificate('withdrawIntent', { operationId: target.operationId, unitIds: [target.unitId] }, 'withdraw-intent');
        this.ledger().requestWithdrawal({ operationId: target.operationId, unitIds: [target.unitId] }); this.save(op);
      }
      if (target.done) continue;
      let batch = op.batches.find(b => b.operationId === target.operationId);
      if (!batch) {
        if (piece.state === 'retired') { target.done = true; target.forfeited = piece.decisionId; this.save(op); continue; }
        if (!['free', 'withdrawing'].includes(piece.state) || piece.decisionVote) continue;
        batch = { kind: 'withdraw', operationId: target.operationId, amount: target.amount, policy, context: this.context(),
          surplus: (BigInt(piece.descriptor.principalReset) - BigInt(target.amount)).toString(), pieces: [{ unitId: piece.unitId, generation: piece.generation }] };
        op.batches.push(batch); this.save(op);
      }
      await this.collect(batch);
      if (batch.done) { target.done = true; this.save(op); }
    }
    op.done = op.targets.every(t => t.done); this.save(op);
    if (op.done) return this.receipt(op);
    const inventory = this.ledger().read().pieces;
    const deferred = op.targets.filter(t => !t.done && !op.batches.some(b => b.operationId === t.operationId)).reduce((n, t) => n + BigInt(t.amount), 0n);
    const maturities = op.batches.filter(b => !b.done).map(b => b.availableAt);
    const availableAt = deferred === 0n && maturities.length && maturities.every(Number.isSafeInteger) ? Math.max(...maturities) : null;
    return { ok: true, pending: true, operationId: op.operationId, deferred: deferred.toString(), availableAt,
      withdrawing: op.targets.filter(t => !t.done && inventory[t.unitId]?.state === 'withdrawing').reduce((n, t) => n + BigInt(t.amount), 0n).toString() };
  }
  async fund(op) {
    const descriptors = op.pieces.map(p => p.descriptor);
    if (!op.capacity) {
      op.snapshot = await this.request(this.context().venueKey, 'priceSnapshot', {});
      const body = { descriptors, proof: op.proof, price: op.snapshot, ...(op.replacementCertificate ? { replacement: op.replacementCertificate } : {}) };
      op.grant ??= await this.request(this.context().epoch.members[0].dexKey, 'capacityPropose', body); this.save(op);
      op.capacity = await this.certificate('capacityVote', { ...body, grant: op.grant }, 'capacity'); this.save(op);
    }
    for (const p of op.pieces) {
      const id = unitId(p.descriptor);
      if (p.abandoned) continue;
      if (!p.ready && !p.abandoning) {
        const starts = await this.all('dkgStart', { descriptor: p.descriptor, capacity: op.capacity });
        const deals = starts.flatMap(r => r.messages).filter(v => v.fact.kind === 'dkg-deal');
        // Original deals are retained before relay, including across a partial DKG restart.
        p.deals = [...new Map([...(p.deals ?? []), ...deals].map(v => [v.from, v])).values()]; this.save(op);
        const replies = await this.all('dkgDeals', { unitId: id, deals: p.deals });
        const ready = [...new Map(replies.flatMap(r => r.messages).filter(v => v.fact.kind === 'dkg-ready').map(v => [v.from, v])).values()];
        for (const v of ready) verifyFact(v, this.context(), 'dkg-ready', v.from);
        const lock = identicalReady(ready.map(v => ({ kind: 'lockReady', from: v.from, body: v.fact.body })),
          this.context().epoch.members.map(m => ({ lockKey: m.dexKey, boxKey: m.boxKey })), id, undefined, 3);
        if (!lock) {
          // A member whose key setup failed answers with nothing. With two of them, three readiness signatures can
          // never come together, so nothing was sent to this piece and it never can be: release it instead of waiting.
          if (starts.filter(r => !r.messages?.length).length < 2) return { ok: true, pending: true, operationId: op.operationId };
          p.abandoning = true; this.save(op);
        } else { p.ready = ready; p.lock = lock; this.save(op); }
      }
      if (p.abandoning) {
        p.abandon ??= await this.abandonCertificate(p.descriptor); this.save(op);
        await this.retireCapacity(p.abandon);
        p.abandoned = true; this.save(op);
        this.log('stake deposit piece not created: its key setup failed, nothing was sent', id.slice(0, 12), p.descriptor.principalReset);
        continue;
      }
      p.funding ??= {};
      const expired = (await this.clock()).at >= p.descriptor.createdAt + op.policy.custody.fundingWindowSec;
      for (const asset of ['TNK', 'RESET']) if (!p.funding[asset]) {
        const transferId = sha256Hex(`stake-fund:${id}:${asset}`), at = (await this.clock()).at;
        if (op.fundingFeeTnk && !this.funding.hasIntent?.(transferId) &&
            BigInt((await this.trac.balances(this.me.tracAddr)).feeTnk) > BigInt(op.fundingFeeTnk))
          throw new Error('Replacement fee exceeds its recorded TNK ceiling');
        const until = p.descriptor.createdAt + (op.policy ?? this.registry().sellerBond).custody.fundingWindowSec;
        if (at >= until && !this.funding.hasIntent?.(transferId)) continue;
        const transfer = await this.funding.transfer({ id: transferId, asset,
          to: p.lock.address, amount: asset === 'RESET' ? p.descriptor.principalReset : p.descriptor.tnkReserve, nonce: fundingNonce(id, asset) });
        if (!transfer.ok) return { ok: true, pending: true, operationId: op.operationId };
        p.funding[asset] = transfer.txHash; this.save(op);
      }
      if (expired && !p.funded) {
        // Recover the original funding quorum before considering an unadmitted return.
        if (p.funding.RESET && p.funding.TNK && !p.refund) {
          try {
            p.funded = await this.certificate('fundedVote', { unitId: id, ready: p.ready, funding: p.funding, price: op.snapshot }, 'funded');
            p.q = op.q; p.fundedAt = p.descriptor.createdAt; this.save(op);
          } catch { /* Refunding members independently refuse any competing funded vote. */ }
        }
        if (!p.funded) {
          p.returning = true; this.save(op);
          if (!p.refund) {
            const balance = await this.trac.balances(p.lock.address);
            p.refund = await this.certificate('refundVote', { unitId: id, ready: p.ready, returnReset: balance.RESET }, 'funding-refund'); this.save(op);
          }
          await this.all('refundCommit', { certificate: p.refund }); await this.archive('funding-refund', p.refund);
          this.ledger().admitRefund(p.refund);
          p.refundOperation ??= { kind: 'withdraw', operationId: random(), refund: true, amount: p.refund[0].fact.body.returnReset,
            policy: op.policy, context: op.context, pieces: [{ unitId: id, generation: 0 }] };
          this.save(op); await this.collect(p.refundOperation);
          if (!p.refundOperation.done) return { ok: true, pending: true, operationId: op.operationId };
          continue;
        }
      }
      if (!p.funded) {
        const price = await this.request(this.context().venueKey, 'priceSnapshot', {});
        p.funded = await this.certificate('fundedVote', { unitId: id, ready: p.ready, funding: p.funding, price }, 'funded');
        p.q = await this.price.import(price); p.fundedAt = (await this.clock()).at; this.save(op);
      }
      await this.all('fundedCommit', { certificate: p.funded });
      await this.archive('funded', p.funded);
      this.ledger().admitFunded(p.funded, { settings: op.settings, price: p.q, now: p.fundedAt });
    }
    op.done = true; this.save(op);
    return { ok: true, operationId: op.operationId,
      funded: op.pieces.filter(p => p.funded).reduce((n, p) => n + BigInt(p.descriptor.principalReset), 0n).toString(),
      ...(op.pieces.some(p => p.refund) ? { refunded: op.pieces.filter(p => p.refund).reduce((n, p) => n + BigInt(p.refund[0].fact.body.returnReset), 0n).toString() } : {}),
      ...notDeposited(op) };
  }
  async collect(op) {
    const at = (await this.clock()).at, inventory = this.ledger().read().pieces;
    if (!op.decisionBody && op.pieces.every(ref => inventory[ref.unitId]?.descriptor.expiresAt <= at)) { op.expiry = true; this.save(op); }
    if (!op.refund && !op.expiry && !op.freeze) {
      {
        const replies = op.accepts ?? await this.all('freezePrepare', { operationId: op.operationId, pieces: op.pieces }), now = (await this.clock()).at;
        const accepts = replies.filter(v => {
          try {
            if (!this.context().epoch.members.some(m => m.dexKey === v.from)) return false;
            const b = verifyFact(v, this.context(), 'freeze-accept', v.from).body;
            return b.operationId === op.operationId && stableJSON(b.pieces) === stableJSON(op.pieces) &&
              Number.isSafeInteger(b.acceptedAt) && b.acceptedAt >= 0 && b.acceptedAt <= now;
          } catch { return false; }
        });
        if (new Set(accepts.map(v => v.from)).size < 3) throw new Error('Three valid original withdrawal barriers are required');
        op.accepts = accepts.slice(0, 3); this.save(op);
      }
      op.freeze = await this.certificate('freezeVote', { accepts: op.accepts }, 'freeze'); this.save(op);
    }
    const now = (await this.clock()).at, settings = effectiveSettings(op.policy, now).settings;
    if (!op.refund && !op.expiry && !op.frozen) {
      await this.all('freezeCommit', { certificate: op.freeze });
      await this.archive('freeze', op.freeze);
      op.availableAt = this.ledger().freeze(op.freeze, settings).availableAt; op.frozen = true; this.save(op);
    }
    if (!op.refund && !op.expiry && now < op.availableAt) return { ok: true, operationId: op.operationId, pending: true, availableAt: op.availableAt };
    if (!op.decisionBody) {
      if (BigInt(op.surplus ?? '0') > 0n && !op.expiry) await this.planReplacement(op, now);
      op.decisionBody = { decisionId: random(), outcome: op.refund ? 'seller-unfunded' : op.expiry ? 'seller-expiry' : 'seller-withdraw', pieces: op.pieces, at: now,
        winnerAddress: this.me.tracAddr, winnerBoxKey: this.box.publicKey,
        ...(op.replacementPlan ? { replacement: op.replacementPlan } : {}),
        evidenceDigest: op.refund ? inventory[op.pieces[0].unitId].refundHash : op.expiry ? sha256Hex(stableJSON(op.pieces.map(ref => inventory[ref.unitId].descriptor))) : factDigest(op.freeze[0].fact) }; this.save(op);
    }
    if (!op.decision) { op.decision = await this.certificate('returnVote', { decision: op.decisionBody }, 'decision'); this.save(op); }
    this.ledger().decide(op.decision);
    await this.archive('decision', op.decision);
    op.collections ??= {};
    for (const ref of op.pieces) {
      if (op.collections[ref.unitId]) continue;
      const releases = await this.all('release', { unitId: ref.unitId, certificate: op.decision });
      const digest = factDigest(op.decision[0].fact), members = this.context().epoch.members;
      const groups = new Map(), original = this.ledger().read().pieces[ref.unitId];
      for (const v of releases) try {
        const b = verifyFact(v, this.context(), 'release', v.from).body, j = members.findIndex(m => m.dexKey === v.from) + 1;
        if (!j || b.j !== j || b.positionId !== ref.unitId || b.decisionDigest !== digest || b.winnerAddress !== this.me.tracAddr ||
            lockAddress(b.A) !== original.address) continue;
        const share = fromLe32(openShare(b.sealed, this.box.secretKey,
          { positionId: ref.unitId, decisionDigest: digest, winnerAddress: this.me.tracAddr, j }, 'release'));
        if (!verifyShare(j, share, b.C)) continue;
        const key = stableJSON({ A: b.A, C: b.C }), group = groups.get(key) ?? { A: b.A, C: b.C, shares: [] };
        if (!group.shares.some(p => p.id === j)) group.shares.push({ id: j, share });
        groups.set(key, group);
      } catch { /* Invalid sealed responses do not override the original quorum. */ }
      const group = [...groups.values()].find(g => g.shares.length >= 3);
      if (!group) throw new Error('Three valid original sealed shares are required');
      const scalar = reconstruct(group.shares, 3, group.C);
      if (publicOf(scalar) !== group.A) throw new Error('Release commitments disagree');
      const result = await sweep({ a: scalar, to: this.me.tracAddr, adapter: this.collector(scalar), positionId: ref.unitId, journal: this.store });
      if (!result.ok) return { ok: true, pending: true, operationId: op.operationId };
      const emptyRefund = original.refundCertificate && original.returnReset === '0', step = result.steps[emptyRefund ? 'TNK' : 'RESET'];
      const certificate = await this.certificate('collectedVote', { unitId: ref.unitId, txHash: step.txHash ?? null, amount: step.amount ?? '0',
        ...(emptyRefund ? { asset: 'TNK' } : {}) }, 'collected');
      await this.all('collectedCommit', { certificate }); await this.retireCapacity(certificate); await this.archive('collected', certificate);
      this.ledger().collected(certificate); op.collections[ref.unitId] = certificate; this.save(op);
    }
    if (op.replacementOperation && !op.replacementOperation.done) {
      op.replacementOperation.replacementCertificate = op.decision; this.save(op);
      const funded = await this.fund(op.replacementOperation);
      if (!op.replacementOperation.done) return { ...funded, operationId: op.operationId };
    }
    op.done = true; this.save(op); return { ok: true, operationId: op.operationId, collected: true };
  }

  async planReplacement(op, at) {
    if (op.replacementPlan) return;
    const sources = op.pieces.map(ref => this.ledger().read().pieces[ref.unitId].descriptor);
    const expiresAt = Math.min(...sources.map(d => d.expiresAt)), policy = this.registry().sellerBond;
    if (!policy.acceptNew || policy.epoch.id !== op.context.epoch.id || expiresAt <= at + policy.custody.fundingWindowSec)
      throw new Error('Surplus replacement is pending safe funding time in its original epoch');
    const snapshot = await this.request(this.context().venueKey, 'priceSnapshot', {}), q = await this.price.import(snapshot);
    const pieces = splitDeposit(op.surplus, q), balances = await this.trac.balances(this.me.tracAddr);
    const fee = BigInt(balances.feeTnk), reserve = BigInt(policy.custody.tnkReserve), tnkLimit = BigInt(pieces.length) * (reserve + 2n * fee);
    const available = this.freeBalances ? await this.freeBalances() : { TNK: { free: balances.TNK } };
    if (reserve < 3n * fee || BigInt(available.TNK.free) < tnkLimit) throw new Error('Add TNK for the exact surplus replacement');
    const lineageIds = [...new Set(sources.flatMap(d => d.lineageIds ?? [d.batchId]))].sort();
    const budgets = lineageIds.map(id => ({ id, record: this.store.get(`stake-maintenance-budget-${id}`) }));
    const remaining = b => b ? BigInt(b.limit) - Object.values(b.allocations).reduce((n, v) => n + BigInt(v), 0n) : 0n;
    const already = budgets.reduce((n, b) => n + BigInt(b.record?.allocations[op.operationId] ?? '0'), 0n);
    if (budgets.reduce((n, b) => n + remaining(b.record), already) < tnkLimit) throw new Error('Surplus replacement exceeds the retained TNK allowance');
    let needed = tnkLimit - already;
    for (const budget of budgets) if (needed > 0n && budget.record) {
      const debit = remaining(budget.record) < needed ? remaining(budget.record) : needed;
      budget.record.allocations[op.operationId] = (BigInt(budget.record.allocations[op.operationId] ?? '0') + debit).toString();
      this.store.put(`stake-maintenance-budget-${budget.id}`, budget.record); needed -= debit;
    }
    const batchId = random(), owner = sources[0].owner;
    const descriptors = pieces.map(p => ({ networkId: policy.networkId, venueKey: policy.venueKey, epochId: policy.epoch.id,
      batchId, nonce: random(), owner, purpose: sources[0].purpose, principalReset: p.principalReset, tnkReserve: reserve.toString(),
      createdAt: at, expiresAt, replacementOf: op.operationId, lineageIds }));
    op.replacementPlan = { operationId: op.operationId, withdrawReset: op.amount, tnkLimit: tnkLimit.toString(), descriptors };
    op.replacementOperation = { kind: 'deposit', operationId: batchId, amount: op.surplus, policy, settings: effectiveSettings(policy, at).settings,
      q, snapshot, fundingFeeTnk: fee.toString(), context: op.context, proof: await this.trac.proveAddress({ dexKey: owner.dexKey, expiresAt: at + policy.custody.fundingWindowSec }),
      pieces: descriptors.map(descriptor => ({ descriptor })) };
    this.save(op);
  }
}
