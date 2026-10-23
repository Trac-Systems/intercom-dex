import { PositionMap } from '../locks/indexes.js';
import { PublicKey } from '@solana/web3.js';
import PeerWallet from '../../peer/node_modules/trac-wallet/index.js';
import { sha256Hex, stableJSON, hexToBytes, fromLe32 } from '../core/canonical.js';
import { meetsVersion } from '../core/software.js';
import { RegistryView, selectCommittee, activeSigners } from '../locks/registry.js';
import { MAIN, SOFTWARE, HEARTBEAT_MS, channel, join, seal, open, receiver, partySchema } from '../locks/transport.js';
import * as dkg from '../locks/dkg.js';
import { Clock } from '../locks/clock.js';
import * as solanaPay from '../locks/solana-pay.js';
import * as escrowLock from '../locks/escrow-lock.js';
import * as tracLock from '../locks/trac-lock.js';
import { rpcCall } from '../solana/rpc.js';

const positive = x => typeof x === 'string' && /^[1-9][0-9]*$/.test(x) && x.length <= 78;
const height = x => Number.isSafeInteger(x) && x >= 0;
const pendingHolder = p => p.post.product === 'put' && p.decision?.outcome === 'exercised' && p.takeId && !p.holders?.[p.takeId]?.release;
const ended = p => !!p.decision && !pendingHolder(p) || p.state === 'failed';
// A running position without a recorded payment gets a history sweep about every half hour (spread by its id); the
// payer's own "paid" message is checked at once, and the decisive scan at the deadline always runs. A missed message
// can only delay an early release, never change an outcome.
const SWEEP_SEC = 1800, RPC_PER_SECOND = 10, SWEEP_RPC_PER_SECOND = 10;
const deadline = p => p.dueBlock ?? p.post.terms.expiryBlock ?? Infinity;
// Calls spaced to at most `perSecond`, in arrival order, so a large book never floods the operator's endpoint.
export function rateLimited(fn, perSecond) {
  let next = 0;
  return async (...args) => {
    const now = performance.now(), at = Math.max(now, next); next = at + 1000 / perSecond;
    if (at > now) await new Promise(resolve => setTimeout(resolve, at - now));
    return fn(...args);
  };
}

export class LockSigner {
  constructor({ bridge, identity, box, store, serviceKey, profile, products = null, clock = new Clock({ bridge }),
    payments = solanaPay, escrow = escrowLock, rpc = {}, now = () => Math.floor(Date.now() / 1000), log = console.log }) {
    if (!store?.put || !store?.get || !store?.list) throw new Error('Encrypted durable store required');
    Object.assign(this, { bridge, identity, box, store, serviceKey, profile, products, clock, payments, escrow, now, log });
    // Two lanes on the operator's endpoint: requests that someone waits for (new locks, "paid" checks) never queue
    // behind the background sweeps of the whole book.
    const call = rpc.rpc ?? rpcCall;
    this.rpc = Array.isArray(rpc.endpoints) ? { ...rpc, rpc: rateLimited(call, rpc.maxPerSecond ?? RPC_PER_SECOND) } : rpc;
    this.sweepRpc = Array.isArray(rpc.endpoints) ? rateLimited(call, rpc.sweepPerSecond ?? SWEEP_RPC_PER_SECOND) : null;
    this.registry = new RegistryView(serviceKey, store); this.receive = receiver(now); this.positions = new PositionMap(p => !ended(p));
    for (const name of store.list('locks-position-')) { const p = store.get(name); this.positions.set(p.positionId, p); }
    this.queues = new Map(); this.timers = new Map(); this.joined = new Set();
    this.listener = (ch, raw) => { void this.handle(ch, raw).catch(e => this.log('locks rejected', e.message)); };
  }
  async start() {
    if (!this.products) { const m = await import('../locks/products/index.js'); this.products = m.products ?? m.default ?? m; }
    if (!this.products) throw new Error('Locks product decide functions unavailable');
    this.bridge.on('message', this.listener); await join(this.bridge, MAIN);
    this.heartbeat = setInterval(() => { void this.enqueue(async () => {
      await this.send(MAIN, 'heartbeat', { registryVersion: this.registry.current?.version ?? 0, software: SOFTWARE, status: 'online',
        holdCount: this.positions.active.size });
    }).catch(e => this.log('locks heartbeat', e.message)); void this.reconcile(); }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
    // Pending asset settlements also keep their channel for claim receipts.
    for (const p of this.positions.values()) {
      if (pendingHolder(p)) await this.enter(p);
      if (p.state === 'creating') this.arm(p);
      for (const [id, h] of Object.entries(p.holders ?? {})) if (h.state === 'creating') this.arm(p, id);
    }
  }
  stop() { clearInterval(this.heartbeat); for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); this.bridge.off('message', this.listener); }
  // One queue per position: a slow chain check on one position never holds up another position or a new lock
  // request. Work without a position (heartbeat, registry) uses the '' queue; new lock requests share their own.
  enqueue(fn, key = '') {
    const previous = this.queues.get(key) ?? Promise.resolve(), p = previous.then(fn), tail = p.catch(() => {});
    this.queues.set(key, tail); void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return p;
  }
  async send(ch, kind, body) { return this.bridge.send(ch, seal({ kind, ch, body }, this.identity.secretKey, { ts: this.now() })); }
  save(p) { this.store.put(`locks-position-${p.positionId}`, p); this.positions.set(p.positionId, structuredClone(p)); }
  async enter(p) { const ch = channel(p.positionId); if (!this.joined.has(ch)) { await join(this.bridge, ch); this.joined.add(ch); } }
  async leave(p) { const ch = channel(p.positionId); if (this.joined.has(ch)) { await this.bridge.leave(ch); this.joined.delete(ch); } }
  arm(p, takeId) {
    const target = takeId ? p.holders[takeId] : p, key = `${p.positionId}:${takeId ?? ''}`;
    clearTimeout(this.timers.get(key));
    const t = setTimeout(() => { void this.enqueue(async () => {
      const current = structuredClone(this.positions.get(p.positionId)), h = takeId ? current?.holders[takeId] : current;
      if (h?.state === 'creating') await this.advance(current, { type: 'timeout', now: this.now() }, takeId);
    }, p.positionId).catch(e => this.log('locks timeout', e.message)); }, Math.max(0, target.dkg.deadline - this.now()) * 1000);
    t.unref?.(); this.timers.set(key, t);
  }
  async advance(p, event, takeId) {
    const h = takeId ? p.holders[takeId] : p, key = `${p.positionId}:${takeId ?? ''}`;
    const result = dkg.step(h.dkg, event); h.dkg = result.state;
    if (h.dkg.phase === 'failed') h.state = 'failed';
    this.save(p);
    for (const action of result.actions) {
      if (action.type === 'persist') {
        h.lock = action.record; h.state = 'funding'; this.save(p);
        await this.advance(p, { type: 'persisted', positionId: p.positionId, ok: true, now: this.now() }, takeId);
      } else {
        if (action.kind === 'lockReady') {
          h.ready[this.identity.publicKey] = { kind: 'lockReady', from: this.identity.publicKey, body: action.body }; this.save(p);
        }
        await this.enter(p); await this.send(channel(p.positionId), action.kind, action.body);
      }
    }
    if (['ready', 'failed'].includes(h.dkg.phase)) { clearTimeout(this.timers.get(key)); this.timers.delete(key); }
    if (p.state === 'failed') await this.leave(p);
  }
  async holder(p, reservation) {
    const takeId = reservation.takeId;
    p.holders ??= {};
    if (p.holders[takeId]) return;
    const ownDeal = dkg.deal({ positionId: p.positionId, takeId, i: p.j, committee: p.committee, k: p.registry.params.k });
    p.holders[takeId] = { state: 'creating', deal: ownDeal, ready: {},
      dkg: dkg.create({ positionId: p.positionId, takeId, committee: p.committee, k: p.registry.params.k, j: p.j, boxSecret: this.box.secretKey,
        ownDeal, chain: 'trac', now: this.now(), timeoutSec: p.registry.params.dkgTimeoutSec }) };
    this.save(p); this.arm(p, takeId);
    await this.advance(p, { type: 'message', now: this.now(), message: { kind: 'dkgDeal', from: this.identity.publicKey, body: ownDeal } }, takeId);
    await this.send(channel(p.positionId), 'dkgDeal', ownDeal);
  }
  validatePost(post, id, r, counted) {
    if (sha256Hex(stableJSON(post)) !== id || post.v !== 1 || post.registryVersion !== r.version ||
        !height(post.createdAt) || post.createdAt > this.now() + 60 || !/^[0-9a-f]{64}$/.test(post.nonce ?? '') ||
        !['loan', 'call', 'put'].includes(post.product) || r.products[post.product] !== 'open' || !meetsVersion(SOFTWARE, r.minSoftware)) throw new Error('Invalid lock post');
    if (Object.keys(post).some(k => !['v', 'product', 'maker', 'terms', 'registryVersion', 'createdAt', 'nonce', 'drawSlot', 'escrowPreimage'].includes(k))) throw new Error('Unknown post field');
    this.validateParty(post.maker);
    const t = post.terms;
    if (!['RESET', 'TNK'].includes(t?.asset) || r.assets[t.asset] !== 'open') throw new Error('Asset unavailable');
    if (post.product === 'put') hexToBytes(post.escrowPreimage, 32);
    if (!t || !height(t.offerUntilBlock) || t.offerUntilBlock <= counted || t.offerUntilBlock > counted + r.params.offerMaxBlocks) throw new Error('Invalid offer deadline');
    const amounts = post.product === 'loan' ? ['collateral', 'principal', 'repay'] : ['amount', 'premium', 'strikeTotal'];
    for (const key of amounts) {
      const lim = r.limits[key === 'collateral' || key === 'amount' ? t.asset : 'USDC'];
      if (!positive(t[key]) || BigInt(t[key]) < BigInt(lim.min) || BigInt(t[key]) > BigInt(lim.max)) throw new Error('Amount outside registry limits');
    }
    if (post.product === 'loan' ? !height(t.termBlocks) || t.termBlocks < r.params.termBlocks.min || t.termBlocks > r.params.termBlocks.max :
      !height(t.expiryBlock) || t.expiryBlock <= t.offerUntilBlock || t.expiryBlock > counted + r.params.offerMaxBlocks) throw new Error('Invalid product deadline');
    if (t.tnkReserve !== undefined && (!positive(t.tnkReserve) || BigInt(t.tnkReserve) < BigInt(r.params.tnkReserve))) throw new Error('TNK reserve too low');
    const allowed = [...amounts, 'asset', 'offerUntilBlock', 'tnkReserve', post.product === 'loan' ? 'termBlocks' : 'expiryBlock'];
    if (Object.keys(t).some(k => !allowed.includes(k))) throw new Error('Unknown term field');
  }
  validateParty(p) {
    partySchema.parse(p); new PublicKey(p.sol);
    const key = PeerWallet.decodeBech32mSafe(p.trac);
    if (!key || key.length !== 32 || PeerWallet.encodeBech32mSafe('trac', key) !== p.trac) throw new Error('Invalid party address');
  }
  async request(m) {
    const { positionId, post } = m.body;
    if (post.maker?.lockKey !== m.from) return;
    let p = structuredClone(this.positions.get(positionId));
    if (p) {
      if (stableJSON(p.post) !== stableJSON(post)) return;
      if (p.decision) return this.release(p, m.from, true);
      if (p.state === 'failed') {
        await this.enter(p); await this.send(MAIN, 'releaseRequest', { positionId, pickup: 'dkg' }); return;
      }
      await this.enter(p);
      if (p.state === 'creating' || p.state === 'funding') await this.advance(p, { type: 'resume', now: this.now() });
      else if (p.state === 'posted') await this.posted(p);
      return;
    }
    const r = this.registry.usable;
    if (!r || r.version !== post.registryVersion) return;
    const counted = await this.clock.counted(); this.validatePost(post, positionId, r, counted);
    const open = [...this.positions.active.values()];
    if (open.length >= (r.params.maxPositions ?? 2000) || open.filter(p => p.post.maker.lockKey === m.from).length >= (r.params.maxPerMaker ?? 50)) throw new Error('Signer position limit');
    const extra = this.exposure({ post, registry: r, holders: {} });
    const total = this.lockedTotals();
    for (const asset of ['RESET', 'TNK', 'USDC']) if (total[asset] + extra[asset] > BigInt(r.limits.totalLocked[asset])) throw new Error('Signer locked exposure limit');
    let draw;
    if (activeSigners(r).length > r.params.n) {
      const slot = await this.payments.finalizedSlot(this.rpc);
      if (!height(post.drawSlot) || Math.abs(post.drawSlot - slot) > 150) throw new Error('Draw slot outside acceptance window');
      draw = await this.payments.firstFinalizedBlockAtLeast(post.drawSlot, this.rpc);
    }
    const committee = selectCommittee(r, positionId, draw?.blockhash), j = committee.findIndex(s => s.lockKey === this.identity.publicKey) + 1;
    if (!j || committee[j - 1].boxKey !== this.box.publicKey || committee.some(s => s.lockKey === m.from)) return;
    const ownDeal = dkg.deal({ positionId, i: j, committee, k: r.params.k });
    p = { positionId, post, registry: r, committee, j, ...(draw ? { draw } : {}), deal: ownDeal, state: 'creating', ready: {}, posted: {}, reservations: {}, payments: [], requests: {},
      dkg: dkg.create({ positionId, committee, k: r.params.k, j, boxSecret: this.box.secretKey, ownDeal, chain: post.product === 'put' ? 'solana' : 'trac', now: Math.min(post.createdAt, this.now()), timeoutSec: r.params.dkgTimeoutSec }) };
    this.save(p); this.arm(p); await this.enter(p);
    await this.advance(p, { type: 'message', now: this.now(), message: { kind: 'dkgDeal', from: this.identity.publicKey, body: ownDeal } });
    await this.send(channel(positionId), 'dkgDeal', ownDeal);
    await this.enter(p); await this.send(MAIN, 'releaseRequest', { positionId, pickup: 'dkg' });
  }
  async pickup(m) {
    if (m.from !== this.serviceKey) return;
    const b = m.body, ready = b.ready.map(raw => open(raw, { now: this.now(), maxAgeSec: Number.MAX_SAFE_INTEGER }));
    const deals = b.deals.map(raw => open(raw, { now: this.now(), maxAgeSec: Number.MAX_SAFE_INTEGER }));
    let p = structuredClone(this.positions.get(b.positionId));
    if (!p) {
      if (this.positions.active.size >= 2000) throw new Error('Signer position limit');
      const r = this.registry.snapshot(b.post.registryVersion);
      if (!r || sha256Hex(stableJSON(b.post)) !== b.positionId) return;
      const draw = activeSigners(r).length > r.params.n ? await this.payments.firstFinalizedBlockAtLeast(b.post.drawSlot, this.rpc) : null;
      const committee = selectCommittee(r, b.positionId, draw?.blockhash), j = committee.findIndex(x => x.lockKey === this.identity.publicKey) + 1;
      if (!j || b.takeId || !dkg.identicalReady(ready, committee, b.positionId, undefined, r.params.k)) return;
      const ownDeal = dkg.deal({ positionId: b.positionId, i: j, committee, k: r.params.k });
      p = { positionId: b.positionId, post: b.post, registry: r, committee, j, deal: ownDeal, state: 'creating', ready: {}, posted: {}, reservations: {}, payments: [], requests: {},
        dkg: dkg.create({ positionId: b.positionId, committee, k: r.params.k, j, boxSecret: this.box.secretKey, ownDeal, chain: b.post.product === 'put' ? 'solana' : 'trac', now: this.now() }) };
    }
    if (stableJSON(p.post) !== stableJSON(b.post)) return;
    if (b.takeId && !p.holders?.[b.takeId]) {
      const take = open(b.take, { now: this.now(), maxAgeSec: Number.MAX_SAFE_INTEGER });
      if (take.kind !== 'take' || take.body.positionId !== p.positionId || take.body.takeId !== b.takeId || take.from !== take.body.taker.lockKey || p.post.product !== 'put') return;
      if (!dkg.identicalReady(ready, p.committee, p.positionId, b.takeId, p.registry.params.k)) return;
      const ownDeal = dkg.deal({ positionId: p.positionId, takeId: b.takeId, i: p.j, committee: p.committee, k: p.registry.params.k });
      p.holders ??= {}; p.holders[b.takeId] = { state: 'creating', ready: {}, deal: ownDeal, recoveryOnly: true,
        dkg: dkg.create({ positionId: p.positionId, takeId: b.takeId, committee: p.committee, k: p.registry.params.k, j: p.j,
          boxSecret: this.box.secretKey, ownDeal, chain: 'trac', now: this.now() }) };
    }
    const h = b.takeId ? p.holders[b.takeId] : p;
    if (h.lock || !dkg.identicalReady(ready, p.committee, p.positionId, b.takeId, p.registry.params.k)) return;
    h.ready = Object.fromEntries(ready.map(x => [x.from, x]));
    await this.advance(p, { type: 'recover', now: this.now(), ready, deals }, b.takeId);
  }
  async posted(p) {
    const { A, C, Q, chain, address } = p.lock;
    const body = { positionId: p.positionId, post: p.post, A, C, Q, chain, address, j: p.j, registryVersion: p.registry.version };
    p.posted[this.identity.publicKey] = body; this.save(p); await this.send(MAIN, 'posted', body);
  }
  async handle(ch, raw) {
    const m = this.receive(raw); if (!m || m.ch !== ch) return;
    const key = m.kind === 'registry' ? '' : typeof m.body?.positionId === 'string' ? m.body.positionId : '';
    return this.enqueue(async () => {
      if (m.kind === 'registry') { this.registry.offer(m, this.now()); return; }
      if (m.kind === 'lockRequest') return this.request(m);
      if (m.kind === 'dkgBundle') return this.pickup(m);
      let p = structuredClone(this.positions.get(m.body.positionId)); if (!p) return;
      if (m.kind === 'releaseRequest') {
        if (m.body.pickup === 'receipts') return;
        const opening = !(m.body.pickup === 'release' && m.body.takeId === p.takeId);
        if (p.decision) return this.release(p, m.from, opening);
        if (m.body.takeId && p.holders?.[m.body.takeId]?.release && m.from === p.reservations[m.body.takeId]?.taker.lockKey) {
          if (this.now() - (p.requests[m.from] ?? -Infinity) < 60) return;
          p.requests[m.from] = this.now(); this.save(p);
          await this.enter(p); return this.send(channel(p.positionId), 'release', p.holders[m.body.takeId].release);
        }
        if ([p.post.maker.lockKey, p.taker?.lockKey].includes(m.from)) {
          if (opening && p.state === 'running') {
            if (this.now() - (p.requests[m.from] ?? -Infinity) < 60) return;
            p.requests[m.from] = this.now(); this.save(p); await this.enter(p); await this.opened(p);
          } else await this.enter(p);
          return this.evaluate(p);
        }
        return;
      }
      if (p.decision) {
        if (pendingHolder(p) && m.from === p.taker.lockKey &&
            (m.kind === 'paid' && m.body.step === 'exercise' || m.kind === 'releaseReceipt' && !m.body.takeId &&
              m.body.j === p.j && m.body.releaseHash === dkg.releaseDigest({ body: p.release }))) return this.release(p, m.from);
        return;
      }
      if (p.state === 'failed') return;
      if (['dkgDeal', 'dkgFail', 'lockReady'].includes(m.kind)) {
        const takeId = m.body.takeId, h = takeId ? p.holders?.[takeId] : p;
        if (!h || h.release) return;
        if (m.kind === 'lockReady') {
          if (p.committee[m.body.j - 1]?.lockKey !== m.from) return;
          if (h.ready[m.from] && stableJSON(h.ready[m.from].body) !== stableJSON(m.body)) throw new Error('Conflicting lockReady');
          h.ready[m.from] = m; this.save(p); return;
        }
        if (!['creating', 'funding'].includes(h.state)) return;
        h.dkgReplies ??= {};
        const answer = m.kind === 'dkgDeal' && m.from !== this.identity.publicKey && p.committee[m.body.i - 1]?.lockKey === m.from &&
          this.now() - (h.dkgReplies[m.from] ?? -Infinity) >= 5;
        if (answer) h.dkgReplies[m.from] = this.now();
        await this.advance(p, { type: 'message', now: this.now(), message: m }, takeId);
        if (answer && h.state !== 'failed') {
          await this.send(channel(p.positionId), 'dkgDeal', h.deal);
          if (h.lock) await this.send(channel(p.positionId), 'lockReady', h.ready[this.identity.publicKey].body);
        }
        return;
      }
      if (m.kind === 'funded') {
        if (m.body.takeId) {
          const r = p.reservations[m.body.takeId], h = p.holders?.[m.body.takeId];
          if (!r || !h || m.from !== r.taker.lockKey || r.closed || this.now() > r.expiresAt || h.release) return;
          if (await this.checkHolder(p, r)) { h.fundedAt = this.now(); this.save(p); }
          return;
        }
        if (m.from !== p.post.maker.lockKey) return;
        if (p.state === 'posted') return this.posted(p);
        if (p.state !== 'funding' || !p.lock || !dkg.identicalReady(Object.values(p.ready), p.committee, p.positionId, undefined, p.registry.params.k)) return;
        if (p.post.product === 'put') {
          const refundAfter = m.body.escrow?.refundAfter, counted = await this.clock.counted();
          if (!height(refundAfter) || refundAfter < this.now() + Math.max(0, p.post.terms.expiryBlock - counted) * 600 + p.registry.params.recoveryMarginSec) return;
          const config = await this.escrow.config({ ...this.rpc, escrowCollector: p.registry.fee.escrowCollector, programId: this.profile.programId });
          const check = await this.escrow.verify({ ...this.rpc, ...config, A: p.lock.A, escrowPreimage: p.post.escrowPreimage, payer: p.post.maker.sol,
            amount: p.post.terms.strikeTotal, mint: this.profile.mint, refundAfter, escrowCollector: p.registry.fee.escrowCollector, programId: this.profile.programId });
          if (!check.ok) return;
          p.escrow = { refundAfter, ...config };
        } else if (!tracLock.funded(await tracLock.balances({ A: p.lock.A, bridge: this.bridge }), this.fundingArgs(p))) return;
        p.state = 'posted'; this.save(p); await this.posted(p); return;
      }
      if (m.kind === 'posted') {
        if (p.committee[m.body.j - 1]?.lockKey !== m.from || !p.lock || m.body.A !== p.lock.A || m.body.chain !== p.lock.chain || m.body.address !== p.lock.address || m.body.registryVersion !== p.registry.version || stableJSON(m.body.Q) !== stableJSON(p.lock.Q) || stableJSON(m.body.C) !== stableJSON(p.lock.C) || stableJSON(m.body.post) !== stableJSON(p.post)) return;
        p.posted[m.from] = m.body; this.save(p); return;
      }
      if (m.kind === 'take') return this.take(p, m);
      if (m.kind === 'paid') return this.paid(p, m);
      if (m.kind === 'cancel' && m.from === p.post.maker.lockKey && ['funding', 'posted'].includes(p.state) && p.lock) {
        if (p.reservation && p.reservation.expiresAt >= this.now()) return;
        // An expired reservation still needs a finalized history scan before cancellation can win.
        if (!await this.resolveReservations(p)) return;
        if (p.state === 'running') return this.evaluate(p);
        p.cancelAccepted = true; this.save(p); return this.evaluate(p);
      }
    }, key);
  }
  async take(p, m) {
    const b = m.body, counted = await this.clock.counted();
    if (m.from !== b.taker.lockKey || p.post.maker.lockKey === m.from || p.committee.some(s => s.lockKey === m.from) || p.state !== 'posted' || p.cancelAccepted ||
        p.posted && Object.keys(p.posted).length < p.registry.params.k || counted >= p.post.terms.offerUntilBlock) return;
    this.validateParty(b.taker);
    if (p.post.product === 'loan' && (!height(b.takeAnchor) || Math.abs(b.takeAnchor - counted) > 2)) return;
    if (p.reservation?.expiresAt >= this.now()) {
      if (p.reservation.takeId === b.takeId && stableJSON(p.reservation.taker) === stableJSON(b.taker)) {
        await this.reserve(p);
        if (p.post.product === 'put') {
          await this.holder(p, p.reservation);
          await this.advance(p, { type: 'resume', now: this.now() }, b.takeId);
          await this.send(MAIN, 'releaseRequest', { positionId: p.positionId, takeId: b.takeId, pickup: 'dkg' });
        }
        return;
      }
      return;
    }
    if (!await this.resolveReservations(p) || p.state === 'running') return;
    if (p.reservations[b.takeId]) return;
    if (p.post.product === 'put') {
      const locked = this.lockedTotals(), extra = tracLock.required(this.fundingArgs(p));
      for (const asset of ['RESET', 'TNK']) if (locked[asset] + BigInt(extra[asset]) > BigInt(p.registry.limits.totalLocked[asset])) throw new Error('Holder exposure limit');
    }
    const fromSlot = await this.payments.finalizedSlot(this.rpc);
    p.reservation = { takeId: b.takeId, taker: b.taker, fromSlot, expiresAt: this.now() + p.registry.params.reserveSec, ...(b.takeAnchor !== undefined ? { takeAnchor: b.takeAnchor } : {}) };
    p.reservations[b.takeId] = p.reservation; this.save(p); await this.enter(p); await this.reserve(p);
    if (p.post.product === 'put') await this.holder(p, p.reservation);
  }
  reserve(p) { return this.send(channel(p.positionId), 'reserve', { positionId: p.positionId, takeId: p.reservation.takeId, takerKey: p.reservation.taker.lockKey, expiresAt: p.reservation.expiresAt }); }
  exposure(p) {
    const units = tracLock.required(this.fundingArgs(p)), holders = Object.values(p.holders ?? {}).filter(h => !h.release).length;
    const count = BigInt(p.post.product === 'put' ? holders : 1);
    return { RESET: BigInt(units.RESET) * count, TNK: BigInt(units.TNK) * count, USDC: p.post.product === 'put' && !p.release ? BigInt(p.post.terms.strikeTotal) : 0n };
  }
  lockedTotals() {
    return [...this.positions.active.values()].reduce((total, p) => {
      const amounts = this.exposure(p); for (const asset of ['RESET', 'TNK', 'USDC']) total[asset] += amounts[asset]; return total;
    }, { RESET: 0n, TNK: 0n, USDC: 0n });
  }
  fundingArgs(p) { return { asset: p.post.terms.asset, amount: p.post.terms.collateral ?? p.post.terms.amount, tnkReserve: p.post.terms.tnkReserve ?? p.registry.params.tnkReserve }; }
  async checkHolder(p, r) {
    const h = p.holders?.[r.takeId];
    return !!h?.lock && !h.release && !!dkg.identicalReady(Object.values(h.ready), p.committee, p.positionId, r.takeId, p.registry.params.k) &&
      tracLock.funded(await tracLock.balances({ A: h.lock.A, bridge: this.bridge }), this.fundingArgs(p));
  }
  paymentArgs(p, step, reservation = p.reservation) {
    const t = p.post.terms, opening = step.startsWith('open:'), repayment = step === 'repay', memoOnly = !opening && p.post.product === 'put';
    const gross = opening ? t.principal ?? t.premium : repayment ? t.repay : t.strikeTotal;
    const fee = opening ? solanaPay.openingFee(gross, p.post.product, p.registry.fee) : 0n;
    const payer = opening ? reservation.taker.sol : repayment ? p.post.maker.sol : p.taker.sol;
    return { ...this.rpc, payer, payee: repayment ? p.taker.sol : p.post.maker.sol, amount: (BigInt(gross) - fee).toString(), fee: fee.toString(),
      collector: p.registry.fee.collector, mint: this.profile.mint, memo: solanaPay.memo(p.positionId, step), memoOnly, allowOverpay: !opening && !memoOnly,
      fromSlot: opening ? reservation.fromSlot : p.payments.find(x => x.step === `open:${p.takeId}`)?.slot,
      ...(opening ? { expiresAt: reservation.expiresAt } : {}) };
  }
  async openPosition(p, reservation, payment) {
    if (p.state === 'running') return;
    if (p.post.product === 'put') {
      const h = p.holders?.[reservation.takeId];
      if (!Number.isSafeInteger(h?.fundedAt) || h.fundedAt > reservation.expiresAt || !await this.checkHolder(p, reservation)) return;
    }
    p.taker = reservation.taker; p.takeId = reservation.takeId; p.takeAnchor = reservation.takeAnchor ?? null;
    if (p.post.product === 'loan') p.dueBlock = reservation.takeAnchor + p.post.terms.termBlocks;
    p.state = 'running'; p.payments.push({ ...payment, step: `open:${p.takeId}` }); this.save(p);
    await this.enter(p);
    await this.opened(p);
  }
  opened(p) {
    return this.send(channel(p.positionId), 'opened', { positionId: p.positionId, takeId: p.takeId, taker: p.taker, j: p.j,
      ...(p.post.product === 'put' ? { holderLock: this.publicLock(p.holders[p.takeId].lock) } : {}),
      ...(p.dueBlock === undefined ? {} : { dueBlock: p.dueBlock, takeAnchor: p.takeAnchor }) });
  }
  async resolveReservations(p) {
    for (const reservation of Object.values(p.reservations)) {
      if (reservation.closed) continue;
      if (reservation.expiresAt >= this.now()) return false;
      const result = await this.payments.scan({ ...this.paymentArgs(p, `open:${reservation.takeId}`, reservation), beforeTime: reservation.expiresAt + 1 });
      if (result.complete !== true) return false;
      if (result.payments.length) { await this.openPosition(p, reservation, result.payments[0]); if (p.state === 'running') return true; }
      if (p.post.product === 'put') await this.returnHolder(p, reservation);
      reservation.closed = true; if (p.reservation?.takeId === reservation.takeId) p.reservation = null; this.save(p);
    }
    return true;
  }
  async paid(p, m) {
    const { step, signature } = m.body, opening = step.startsWith('open:');
    const reservation = opening ? p.reservations[step.slice(5)] : null;
    if (opening ? p.state !== 'posted' || !reservation || reservation.closed || m.from !== reservation.taker.lockKey :
      p.state !== 'running' || step !== (p.post.product === 'loan' ? 'repay' : 'exercise') ||
      m.from !== (p.post.product === 'loan' ? p.post.maker.lockKey : p.taker.lockKey)) return;
    const payment = await this.payments.verify({ ...this.paymentArgs(p, step, reservation), signature });
    if (!payment.ok) return;
    if (opening) await this.openPosition(p, reservation, payment);
    else { if (!p.payments.some(x => x.signature === signature)) p.payments.push({ ...payment, step }); this.save(p); }
    await this.evaluate(p);
  }
  publicLock(lock) { const { A, C, Q, chain, address } = lock; return { A, C, Q, chain, address }; }
  makeRelease(p, lock, winner, outcome, target, takeId) {
    const ref = { positionId: p.positionId, ...(takeId ? { takeId } : {}) };
    return { ...ref, j: p.j, winner, outcome, A: lock.A, C: lock.C,
      sealed: dkg.sealShare(hexToBytes(lock.share, 32), target.boxKey, { ...ref, from: p.j, to: target.lockKey }, 'release') };
  }
  async returnHolder(p, r) {
    const h = p.holders?.[r.takeId];
    if (!h?.lock || h.release) return;
    h.release = this.makeRelease(p, h.lock, 'taker', 'unfunded', r.taker, r.takeId); this.save(p);
    await this.enter(p); await this.send(channel(p.positionId), 'release', h.release);
  }
  // One complete scan per step continues from the newest transaction the last complete scan checked.
  async scanPayments(p, step, extra = {}) {
    const prior = p.scans?.[step];
    const result = await this.payments.scan({ ...this.paymentArgs(p, step), ...(this.sweepRpc ? { rpc: this.sweepRpc } : {}), ...extra,
      ...(prior?.newest ? { until: prior.newest } : {}) });
    for (const payment of result.payments) if (!p.payments.some(x => x.signature === payment.signature)) p.payments.push({ ...payment, step });
    if (result.complete) (p.scans ??= {})[step] = { newest: result.newest ?? prior?.newest ?? null, at: this.now() };
    return result;
  }
  sweepDue(p, step) {
    const at = p.scans?.[step]?.at;
    return at === undefined || this.now() >= at + SWEEP_SEC + parseInt(p.positionId.slice(0, 4), 16) % 600 - 300;
  }
  async median(counted) {
    if (this.medianOf?.counted !== counted) this.medianOf = { counted, M: await this.clock.M(counted) };
    return this.medianOf.M;
  }
  async evaluate(p) {
    if (p.decision) return this.settleHolder(p);
    if (ended(p) || !p.lock || !['funding', 'posted', 'running'].includes(p.state)) return;
    // Within one reconcile round the height is read once for all positions.
    const counted = this.roundCounted ?? await this.clock.counted();
    if (p.state === 'posted' && p.reservation && (counted >= p.post.terms.offerUntilBlock || p.reservation.expiresAt < this.now()) && !await this.resolveReservations(p)) return;
    let T, M, decision;
    if (p.state === 'running') {
      const N = p.dueBlock ?? p.post.terms.expiryBlock, step = p.post.product === 'loan' ? 'repay' : 'exercise';
      const recorded = () => p.payments.filter(x => x.step === step && x.ok && Number.isSafeInteger(x.blockTime));
      const before = stableJSON([p.payments, p.scans ?? null]);
      if (counted >= N) {
        T = await this.clock.T(N);
        // A recorded payment before the deadline decides it; otherwise the full history up to T must be read.
        if (!recorded().some(x => x.blockTime < T) && !(await this.scanPayments(p, step, { beforeTime: T })).complete) return;
      } else if (this.clock.M) {
        M = await this.median(counted);
        // A recorded payment only waits for Bitcoin's median time; without one, an occasional sweep finds a payment
        // whose "paid" message never arrived.
        if (!recorded().length && this.sweepDue(p, step)) await this.scanPayments(p, step);
      }
      if (stableJSON([p.payments, p.scans ?? null]) !== before) this.save(p);
      const paid = p.payments.some(x => x.step === step && x.ok && Number.isSafeInteger(x.blockTime) && (T !== undefined ? x.blockTime < T : M !== undefined && x.blockTime <= M));
      if (paid) decision = { winner: p.post.product === 'loan' ? 'maker' : 'taker', outcome: p.post.product === 'loan' ? 'repaid' : 'exercised' };
      else if (T !== undefined) decision = { winner: p.post.product === 'loan' ? 'taker' : 'maker', outcome: p.post.product === 'loan' ? 'defaulted' : 'expired' };
    } else {
      const decide = this.products?.[p.post.product]?.decide;
      if (typeof decide !== 'function') throw new Error('Product decide function required');
      decision = decide({ ...p, product: p.post.product, maker: p.post.maker, terms: p.post.terms },
        { counted, T, M, payments: p.payments, cancelAccepted: p.cancelAccepted === true, reservation: p.reservation ?? null });
    }
    if (!decision?.winner) return;
    if (!['maker', 'taker'].includes(decision.winner) || decision.winner === 'taker' && !p.taker) throw new Error('Invalid product decision');
    const target = decision.winner === 'maker' ? p.post.maker : p.taker;
    p.decision = { winner: decision.winner, outcome: decision.outcome }; p.state = `ended:${decision.outcome}`;
    p.release = this.makeRelease(p, p.lock, decision.winner, decision.outcome, target);
    if (p.post.product === 'put' && p.takeId && decision.outcome !== 'exercised') {
      const winner = 'taker', h = p.holders[p.takeId];
      if (h.release) throw new Error('Holder lock already released');
      h.decision = { winner, outcome: decision.outcome };
      h.release = this.makeRelease(p, h.lock, winner, decision.outcome, p.taker, p.takeId);
    }
    this.save(p); await this.publishRelease(p);
    await this.settleHolder(p);
  }
  async settleHolder(p) {
    if (!pendingHolder(p)) return;
    const h = p.holders[p.takeId];
    h.checkedAt = this.now(); this.save(p);
    let check;
    try {
      check = await this.escrow.settlement({ ...this.rpc, ...p.escrow, A: p.lock.A, escrowPreimage: p.post.escrowPreimage,
        payer: p.post.maker.sol, amount: p.post.terms.strikeTotal, mint: this.profile.mint,
        escrowCollector: p.registry.fee.escrowCollector, programId: this.profile.programId });
    } catch (error) { this.log('locks escrow pending', p.positionId, error.message); return; }
    if (!check.ok || !['claimed', 'refunded'].includes(check.status)) return;
    const winner = check.status === 'claimed' ? 'maker' : 'taker';
    h.decision = { winner, outcome: p.decision.outcome, escrowStatus: check.status, ...(check.reads?.escrow ? { slot: check.reads.escrow.slot } : {}) };
    h.release = this.makeRelease(p, h.lock, winner, p.decision.outcome, winner === 'maker' ? p.post.maker : p.taker, p.takeId);
    this.save(p);
    await this.enter(p); await this.send(channel(p.positionId), 'release', h.release); await this.leave(p);
  }
  async publishRelease(p) {
    await this.enter(p); await this.send(channel(p.positionId), 'release', p.release);
    for (const h of Object.values(p.holders ?? {})) if (h.release) await this.send(channel(p.positionId), 'release', h.release);
    await this.send(channel(p.positionId), 'ended', { positionId: p.positionId, ...p.decision });
    if (!pendingHolder(p)) await this.leave(p);
  }
  async release(p, requester, opening = false) {
    if (![p.post.maker.lockKey, p.taker?.lockKey, this.serviceKey].includes(requester) || !p.release) return;
    const at = p.requests[requester]; if (at !== undefined && this.now() - at < 60) return;
    p.requests[requester] = this.now(); this.save(p);
    if (opening && p.takeId && p.taker) { await this.enter(p); await this.opened(p); }
    await this.publishRelease(p);
    await this.settleHolder(p);
  }
  // Each position is checked as its own queued step, so new requests (a lock request has a two-minute DKG window)
  // are handled between them instead of waiting for every position's chain checks. One round runs at a time.
  async reconcile() {
    if (this.reconciling) return; this.reconciling = true;
    try {
      this.roundCounted = await this.clock.counted().catch(() => undefined);
      // Nearest deadlines first.
      const ids = [...this.positions.active.values()].sort((a, b) => deadline(a) - deadline(b)).map(p => p.positionId);
      for (const id of ids) await this.enqueue(async () => {
        const current = this.positions.get(id); if (!current) return;
        if (pendingHolder(current)) {
          if (this.now() - (current.holders[current.takeId].checkedAt ?? -Infinity) < 600) return;
        } else if (ended(current) || !['funding', 'posted', 'running'].includes(current.state)) return;
        try { await this.evaluate(structuredClone(current)); } catch (error) { this.log('locks pending', current.positionId, error.message); }
      }, id);
    } finally { this.reconciling = false; this.roundCounted = undefined; }
  }
  status() { return { role: 'lock-signer', lockKey: this.identity.publicKey, registryVersion: this.registry.current?.version ?? null,
    positions: [...this.positions.values()].map(p => ({ positionId: p.positionId, state: p.state, ...(p.lock ? { lock: this.publicLock(p.lock) } : {}), decision: p.decision ?? null,
      ...(p.post.product === 'put' && p.takeId ? { holderDecision: p.holders[p.takeId].decision ?? null } : {}) })) }; }
}
