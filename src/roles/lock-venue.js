import { PositionMap, BookIndex, Deadlines } from '../locks/indexes.js';
import { sha256Hex, stableJSON } from '../core/canonical.js';
import { validate, selectCommittee, activeSigners } from '../locks/registry.js';
import { MAIN, HEARTBEAT_MS, channel, join, seal, open, receiver } from '../locks/transport.js';
import { identicalReady, releaseDigest, verifyReleaseReceipt } from '../locks/dkg.js';
import * as payments from '../locks/solana-pay.js';
import { lockSummary } from '../locks/summary.js';

const DELAY = 7 * 86400, SUMMARY_SOON_MS = 3000, SUMMARY_KEEPALIVE_SEC = 120, SETUP_GRACE_SEC = 300;
const creditStart = p => p.post.product === 'put' ? p.settledAt ?? (p.creditsFinal ? p.endedAt : undefined) : p.endedAt;
const lockOf = b => ({ A: b.A, C: b.C, Q: b.Q, chain: b.chain, address: b.address });
const releaseKey = b => `${b.takeId ?? ''}:${b.j}`;
export class LockVenue {
  constructor({ bridge, identity, store, registryInput, rpc = {}, chain = payments, clock = null, now = () => Math.floor(Date.now() / 1000), log = console.log }) {
    Object.assign(this, { bridge, identity, store, now, log, rpc, chain, clock });
    this.signerSeen = new Map(); this.summarySent = null;
    const r = validate(registryInput), prior = store.get('locks-venue-registry');
    if (prior && (r.version < prior.version || r.version === prior.version && stableJSON(r) !== stableJSON(prior))) throw new Error('Registry version reused or regressed');
    if (r.issuedAt > now() + 60 || prior && r.issuedAt < prior.issuedAt) throw new Error('Invalid registry issue time');
    store.put(`locks-venue-registry-v${r.version}`, r); store.put('locks-venue-registry', r); this.registry = r;
    this.positions = new PositionMap(p => !p.state.startsWith('ended:')); this.book = new BookIndex(); this.creditDeadlines = new Deadlines(); this.snapshots = new Map([[r.version, r]]);
    for (const name of store.list('locks-book-')) { const p = store.get(name); this.positions.set(p.positionId, p); this.book.update(p); this.trackCredit(p); }
    this.receive = receiver(now, { historical: ['release'] }); this.queue = Promise.resolve(); this.joined = new Set(); this.requests = new Map();
    this.listener = (ch, raw) => { void this.handle(ch, raw).catch(e => this.log('locks venue rejected', e.message)); };
  }
  async start() {
    this.bridge.on('message', this.listener); await join(this.bridge, MAIN); await this.publish();
    this.timer = setInterval(() => {
      void this.enqueue(() => this.publish()).catch(e => this.log('locks registry', e.message));
      void this.publishSummary().catch(e => this.log('locks summary', e.message));
    }, HEARTBEAT_MS); this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); clearTimeout(this.summaryTimer); this.bridge.off('message', this.listener); }
  // The public summary goes out a few seconds after a change (several changes become one message) and every two
  // minutes otherwise, so viewers that just arrived get a picture.
  summarySoon() {
    if (this.summaryTimer || !this.timer) return;
    this.summaryTimer = setTimeout(() => { this.summaryTimer = null; void this.publishSummary().catch(e => this.log('locks summary', e.message)); }, SUMMARY_SOON_MS);
    this.summaryTimer.unref?.();
  }
  async publishSummary() {
    let counted = null, blockAt = null;
    if (this.clock) { try { counted = await this.clock.counted(); blockAt = await this.clock.T(counted); } catch {} }
    const summary = lockSummary(this.positions.values(), { now: this.now(), counted, blockAt, signers: this.registry.signers, seen: this.signerSeen });
    const { ts, ...content } = summary, key = stableJSON(content);
    if (this.summarySent && this.summarySent.key === key && ts - this.summarySent.ts < SUMMARY_KEEPALIVE_SEC) return false;
    await this.send(MAIN, 'summary', summary); this.summarySent = { key, ts }; return true;
  }
  enqueue(fn) { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  send(ch, kind, body) { return this.bridge.send(ch, seal({ kind, ch, body }, this.identity.secretKey, { ts: this.now() })); }
  publish() { this.expireSetups(); this.finalizeCredits(); return this.send(MAIN, 'registry', this.registry); }
  // A lock whose setup never finished (no k signers posted it) ends as unfunded, as the maker's app already shows,
  // so it stops counting against the maker's and the service's limits.
  expireSetups() {
    for (const current of [...this.positions.active.values()]) {
      if (current.state !== 'creating') continue;
      const timeout = this.snapshot(current.post.registryVersion)?.params.dkgTimeoutSec ?? 120;
      if (this.now() < current.post.createdAt + timeout + SETUP_GRACE_SEC) continue;
      const p = structuredClone(current); p.state = 'ended:unfunded'; p.endedAt = this.now(); this.save(p);
      void this.unwatch(p).catch(() => {});
    }
  }
  save(p) {
    const before = this.positions.get(p.positionId)?.state;
    this.store.put(`locks-book-${p.positionId}`, p); const saved = structuredClone(p); this.positions.set(p.positionId, saved); this.book.update(saved); this.trackCredit(saved);
    if (before !== saved.state) this.summarySoon();
  }
  trackCredit(p) { this.creditDeadlines.set(p.positionId, p.takeId && !p.creditsFinal && creditStart(p) !== undefined ? creditStart(p) + DELAY : undefined); }
  async watch(p) { const ch = channel(p.positionId); if (!this.joined.has(ch)) { await join(this.bridge, ch); this.joined.add(ch); } }
  async unwatch(p) { const ch = channel(p.positionId); if (this.joined.has(ch)) { await this.bridge.leave(ch); this.joined.delete(ch); } }
  snapshot(version) {
    if (this.snapshots.has(version)) return this.snapshots.get(version);
    const snapshot = this.store.get(`locks-venue-registry-v${version}`);
    if (snapshot) this.snapshots.set(version, snapshot);
    return snapshot;
  }
  claimRequest(key) {
    const now = this.now();
    if (now - (this.requests.get(key) ?? -Infinity) < 60) return false;
    for (const [k, at] of this.requests) if (at < now - 60) this.requests.delete(k);
    if (this.requests.size >= 10000) return false;
    this.requests.set(key, now); return true;
  }
  async handle(ch, raw) {
    const m = this.receive(raw); if (!m || m.ch !== ch) return;
    if (['bookRequest', 'releaseRequest'].includes(m.kind)) return this.apply(m);
    return this.enqueue(() => this.apply(m));
  }
  async apply(m) {
    if (m.kind === 'bookRequest') {
      return this.send(MAIN, 'book', { ...this.book.page(m.body), requester: m.from });
    }
    if (m.kind === 'heartbeat') {
      const was = this.signerSeen.has(m.from);
      if (this.registry.signers.some(s => s.lockKey === m.from)) { this.signerSeen.set(m.from, this.now()); if (!was) this.summarySoon(); }
      return;
    }
    const id = m.body.positionId;
    if (!id) return;
    let p = structuredClone(this.positions.get(id));
    if (['lockRequest', 'posted'].includes(m.kind)) {
      const post = m.body.post, r = this.snapshot(post.registryVersion);
      if (!r || sha256Hex(stableJSON(post)) !== id) return;
      if (m.kind === 'lockRequest' && m.from !== post.maker?.lockKey) return;
      if (!p) {
        if (this.positions.size >= 20000 || [...this.positions.active.values()].filter(p => p.post.maker.lockKey === post.maker.lockKey).length >= 50) return;
        let draw;
        if (activeSigners(r).length > r.params.n) {
          const slot = await this.chain.finalizedSlot(this.rpc);
          if (!Number.isSafeInteger(post.drawSlot) || Math.abs(slot - post.drawSlot) > 150) return;
          draw = await this.chain.firstFinalizedBlockAtLeast(post.drawSlot, this.rpc);
        }
        p = { positionId: id, post, committee: selectCommittee(r, id, draw?.blockhash), k: r.params.k, posted: {}, releases: {}, opened: {}, dkgs: {}, takes: {}, receipts: {}, state: 'creating' };
      }
      if (stableJSON(p.post) !== stableJSON(post)) return;
      if (m.kind === 'posted' && p.posted[m.from] && stableJSON(p.posted[m.from].body) === stableJSON(m.body)) return;
      if (m.kind === 'posted') {
        if (p.committee[m.body.j - 1]?.lockKey !== m.from || m.body.registryVersion !== r.version) return;
        const lock = lockOf(m.body);
        if (p.lock && stableJSON(p.lock) !== stableJSON(lock)) return;
        p.lock = lock; p.posted[m.from] = m;
        if (Object.keys(p.posted).length >= p.k && p.state === 'creating') p.state = 'posted';
      }
      this.save(p); if (!p.state.startsWith('ended:')) await this.watch(p); return;
    }
    if (!p) return;
    const b = m.body;
    if (m.kind === 'take') {
      if (m.from !== b.taker.lockKey || p.takes[b.takeId] || Object.keys(p.takes).length >= 100) return;
      p.takes[b.takeId] = m; this.save(p); return;
    }
    if (m.kind === 'releaseRequest') {
      const member = p.committee.some(x => x.lockKey === m.from);
      if (!member && ![p.post.maker.lockKey, ...Object.values(p.takes).map(x => x.body.taker.lockKey)].includes(m.from)) return;
      const key = `${id}:${m.from}:${b.pickup ?? 'release'}:${b.takeId ?? ''}`, now = this.now();
      if (now - (this.requests.get(key) ?? -Infinity) < 60) return;
      await this.watch(p);
      if (b.pickup === 'receipts') return;
      if (b.pickup === 'dkg') {
        const d = p.dkgs[b.takeId ?? ''];
        if (!d) return;
        const ready = identicalReady(Object.values(d.ready), p.committee, id, b.takeId, p.k);
        if (!ready || !this.claimRequest(key)) return;
        return this.send(channel(id), 'dkgBundle', { positionId: id, ...(b.takeId ? { takeId: b.takeId, take: p.takes[b.takeId] } : {}), post: p.post,
          deals: Object.values(d.deals).filter(x => ready.Q.includes(x.body.i)), ready: Object.values(d.ready) });
      }
      const opened = b.pickup === 'release' && b.takeId && b.takeId === p.takeId ? [] : Object.values(p.opened);
      const proofs = [...opened, ...Object.values(p.releases)];
      if (!proofs.length || !this.claimRequest(key)) return;
      for (const proof of proofs) {
        open(proof, { now, maxAgeSec: Number.MAX_SAFE_INTEGER }); await this.bridge.send(channel(id), proof);
      }
      return;
    }
    if (m.kind === 'releaseReceipt') {
      if (creditStart(p) !== undefined && this.now() >= creditStart(p) + DELAY) { this.credit(p); this.save(p); return; }
      const release = p.releases[releaseKey(b)], target = release?.body.winner === 'maker' ? p.post.maker : p.takes[release?.body.takeId ?? p.takeId]?.body.taker ?? p.taker;
      if (!release || m.from !== target?.lockKey || b.releaseHash !== releaseDigest(release) || p.creditsFinal) return;
      if (p.receipts[releaseKey(b)] && stableJSON(p.receipts[releaseKey(b)].body) === stableJSON(b)) return;
      const context = { positionId: id, ...(b.takeId ? { takeId: b.takeId } : {}), from: b.j, to: m.from };
      if (!verifyReleaseReceipt(release, b.key, context)) return;
      p.receipts[releaseKey(b)] = m; this.credit(p); this.save(p); return;
    }
    if (['dkgDeal', 'lockReady'].includes(m.kind)) {
      const j = b.i ?? b.j;
      if (p.committee[j - 1]?.lockKey !== m.from || b.takeId && !p.takes[b.takeId]) return;
      const d = p.dkgs[b.takeId ?? ''] ??= { deals: {}, ready: {} }, rows = m.kind === 'dkgDeal' ? d.deals : d.ready;
      if (rows[m.from]) return;
      rows[m.from] = m; this.save(p); return;
    }
    if (!['opened', 'release'].includes(m.kind) || p.committee[b.j - 1]?.lockKey !== m.from) return;
    if (m.kind === 'opened') {
      if (p.opened[m.from]) return;
      p.opened[m.from] = m;
      const { j, ...value } = b;
      const matching = Object.values(p.opened).filter(x => { const { j, ...v } = x.body; return stableJSON(v) === stableJSON(value); });
      if (matching.length >= p.k) {
        p.takeId = b.takeId; p.taker = b.taker; if (b.holderLock) p.holderLock = b.holderLock;
        if (!p.state.startsWith('ended:')) p.state = 'running';
      }
    } else {
      const lock = b.takeId ? p.holderLock : p.lock;
      // Unfunded holder returns are stored against a certified DKG, without ending the offer.
      const ready = b.takeId && !lock ? identicalReady(Object.values(p.dkgs[b.takeId]?.ready ?? {}), p.committee, id, b.takeId, p.k) : lock;
      if (!ready || b.A !== ready.A || stableJSON(b.C) !== stableJSON(ready.C)) return;
      const key = releaseKey(b);
      if (p.releases[key]) return;
      p.releases[key] = m;
      if (!b.takeId) {
        const matching = Object.values(p.releases).filter(x => !x.body.takeId && x.body.winner === b.winner && x.body.outcome === b.outcome);
        if (matching.length >= p.k) { p.state = `ended:${b.outcome}`; p.winner = b.winner; p.endedAt ??= this.now(); }
      }
    }
    this.credit(p); this.save(p);
    // Keep the active channel through the provisional window so late receipts/deals can be picked up.
  }
  credit(p) {
    if (p.creditsFinal || p.endedAt === undefined || !p.takeId) return;
    if (p.post.product === 'put' && p.settledAt === undefined) {
      const winners = p.state === 'ended:exercised' ? ['maker', 'taker'] : ['taker'];
      const winner = winners.find(winner => Object.values(p.releases).filter(x => x.body.takeId === p.takeId &&
        x.body.outcome === p.state.slice(6) && x.body.winner === winner).length >= p.k);
      if (!winner) return;
      p.holderWinner = winner; p.settledAt = this.now();
    }
    const fee = this.snapshot(p.post.registryVersion).fee, amount = payments.openingFee(p.post.terms.principal ?? p.post.terms.premium, p.post.product, fee);
    const valid = p.committee.filter((s, i) => {
      const j = i + 1, main = p.releases[`:${j}`]?.body;
      if (!p.lock.Q.includes(j) || !p.receipts[`:${j}`] || main?.winner !== p.winner || main.outcome !== p.state.slice(6)) return false;
      if (p.post.product !== 'put') return true;
      const holder = p.releases[`${p.takeId}:${j}`]?.body;
      return p.holderLock?.Q.includes(j) && p.receipts[`${p.takeId}:${j}`] && holder?.outcome === main.outcome && holder.winner === p.holderWinner;
    });
    const each = valid.length ? amount * BigInt(fee.signerShareBps ?? 4000) / 10000n / BigInt(valid.length) : 0n;
    p.fee = amount.toString(); p.credits = Object.fromEntries(valid.map(s => [s.lockKey, each.toString()]));
    p.venueCredit = (amount - each * BigInt(valid.length)).toString(); p.creditsFinal = this.now() >= creditStart(p) + DELAY;
  }
  finalizeCredits() {
    for (const id of this.creditDeadlines.due(this.now())) {
      const p = structuredClone(this.positions.get(id)); this.credit(p); this.save(p);
    }
  }
  signerCredits() {
    this.finalizeCredits(); const out = {};
    for (const p of this.positions.values()) for (const [lockKey, amount] of Object.entries(p.credits ?? {})) {
      (out[lockKey] ??= []).push({ positionId: p.positionId, collector: this.snapshot(p.post.registryVersion).fee.collector, amount, final: p.creditsFinal === true, payableAfter: creditStart(p) + DELAY, paid: p.paid?.[lockKey] === true });
    }
    return out;
  }
  markPaid(lockKey, positionIds) {
    return this.enqueue(() => {
      this.finalizeCredits();
      if (!Array.isArray(positionIds) || !positionIds.length || new Set(positionIds).size !== positionIds.length) throw new Error('Name unique positions');
      const rows = positionIds.map(id => structuredClone(this.positions.get(id)));
      if (rows.some(p => !p?.creditsFinal || !p.credits?.[lockKey] || p.paid?.[lockKey])) throw new Error('Credits are not final and unpaid');
      for (const p of rows) { p.paid = { ...p.paid, [lockKey]: true }; this.save(p); }
      return { lockKey, positions: rows.length, amount: rows.reduce((n, p) => n + BigInt(p.credits[lockKey]), 0n).toString() };
    });
  }
  status() {
    this.finalizeCredits();
    const accounting = {};
    for (const p of this.positions.values()) if (p.fee !== undefined) {
      const collector = this.snapshot(p.post.registryVersion).fee.collector, row = accounting[collector] ??= { fees: 0n, signerCredits: 0n, venueCredit: 0n, positions: 0 };
      row.fees += BigInt(p.fee); row.signerCredits += Object.values(p.credits ?? {}).reduce((n, amount) => n + BigInt(amount), 0n); row.venueCredit += BigInt(p.venueCredit); row.positions++;
    }
    const feeAccounting = Object.fromEntries(Object.entries(accounting).map(([collector, r]) => [collector, { ...r, fees: r.fees.toString(), signerCredits: r.signerCredits.toString(), venueCredit: r.venueCredit.toString() }]));
    return { role: 'lock-venue', lockKey: this.identity.publicKey, registryVersion: this.registry.version, signerCredits: this.signerCredits(), feeAccounting,
      positions: [...this.positions.values()].map(p => ({ positionId: p.positionId, state: p.state, winner: p.winner ?? null, releases: Object.keys(p.releases).length,
        ...(p.post.product === 'put' && p.takeId ? { holderWinner: p.holderWinner ?? null } : {}),
        fee: p.fee ?? '0', venueCredit: p.venueCredit ?? '0', creditsFinal: p.creditsFinal ?? false })) };
  }
}
