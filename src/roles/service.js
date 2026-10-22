import { buildRegistry } from '../core/registry.js';
import { tradeId as termsTradeId, transferNonce, validateTerms } from '../core/terms.js';
import { stableJSON, sha256Hex, hexToBytes, fromLe32, le32 } from '../core/canonical.js';
import { reconstruct, verifyShare } from '../core/vss.js';
import { quoteAmount, registryPair, pairStatus, supportedBase, tradePrice } from '../market/assets.js';
import { BookFeed } from '../market/book-feed.js';
import { RegistryRelays } from '../net/relays.js';
import { OfferBook } from '../market/book.js';
import { ticker } from '../market/ticker.js';
import { MakerFunds } from '../market/funds.js';
import { TradeHost } from './host.js';
import { deriveEscrowPda } from '../solana/escrow.js';
import { open, createReplayCache } from '../core/envelope.js';
import { publicReceiver, nowSec, validOffer, verifySummon, checkTermsAgainstRegistry } from './common.js';

import { SOFTWARE, meetsVersion } from '../core/software.js';
import { checkProfileRegistry, checkProfileTerms } from '../net/profile.js';
import { parseBody } from '../core/schemas.js';
import { CHAT_CHANNEL, MarketChat } from '../market/chat.js';

const MAIN = 'intercom-dex', OFFERS = 'intercom-dex:offers', SIGNERS = 'intercom-dex:signers';
const DAY = 86400, PAYOUT_DELAY = 7 * DAY, CREDIT_AFTER_SEC = 300;
// Watches made from summons alone (no logged settlement yet) share this capacity. Share messages for unknown trades
// are kept only from registry signers, at most UNMATCHED_PER_SENDER distinct ones per sender and trade.
export const MAX_UNPROVEN_WATCHES = 20000, UNMATCHED_PER_SENDER = 16;

// The venue: publishes the signer registry, the order book and tickers, checks every reported trade on both chains
// before logging it, and accounts the signers' share of the venue fee (paid later, after a holding period).
//
// Every reported settlement is one durable record (`settle-<tradeId>`): pending until both chains prove it, then
// logged together with its offer fill, published, and finally credited once the publication window has closed.
// Each step is a single record write, so a restart continues exactly where it stopped.
export class Service {
  constructor({ bridge, identity, store, solana, trac, registryInput, profile = null, latest, log = console.log, now = nowSec,
    bookMs = 5000, tickerMs = 30000, registryMs = 30000, reconcileMs = 15000, firstLaunch = false }) {
    Object.assign(this, { bridge, identity, store, solana, trac, profile, latest, log, now, bookMs, tickerMs, registryMs, reconcileMs, firstLaunch });
    for (const legacy of ['service-trades', 'service-payouts']) {
      if (store.get(legacy)) throw new Error(`The service store holds ${legacy} from an earlier layout; start with an empty data folder.`);
    }
    this.host = new TradeHost({ bridge, identity, store, solana: null, trac: null, profile, log, now });
    this.receive = publicReceiver(now);
    this.chat = new MarketChat({ now, chatRelays: profile?.chatRelays ?? [] });
    // Signers keep re-sending their original share messages until the refund time, so the service accepts them for
    // as long as a trade can run (logically deduplicated per trade and index).
    // First receipt time per share message: a copy re-sent after a failed write keeps its original receipt time.
    this.firstSeen = new Map();
    this.book = new OfferBook();
    // A restart keeps the book: dashboards hide offers the venue's book does not list, so an empty book emptied them.
    try { this.book.restore(store.get('book-offers'), this.now()); } catch (e) { this.log('book restore', e.message); }
    this.bookFeed = new BookFeed();
    this.relays = new RegistryRelays(bridge);
    const savedFee = store.get('service-fee-policy');
    this.registry = this.#registry({ ...registryInput, ...(savedFee ? { fee: savedFee.fee } : {}) });
    this.registryQueue = Promise.resolve();
    this.registries = new Map();
    for (const name of store.list('service-registry-v')) { const r = store.get(name); if (r) this.registries.set(r.version, r); }
    this.registries.set(this.registry.version, this.registry);
    this.settlementQueue = Promise.resolve();
    this.settlements = new Map();  // tradeId -> settlement record
    this.byEscrow = new Map();     // escrow address -> tradeId of the logged trade it funded
    this.fills = new Map();        // offerId -> base units filled by logged trades
    for (const name of store.list('settle-')) {
      const r = store.get(name);
      if (r) {
        if (profile) checkProfileTerms(r.report.terms, profile);
        this.settlements.set(r.tradeId, r); if (r.status === 'logged') this.#index(r);
      }
    }
    this.fillsDue = new Map();     // offerId -> tradeIds of logged trades whose offer has not been seen yet
    for (const r of this.settlements.values()) if (r.status === 'logged' && r.fillPending) this.#fillDue(r);
    this.watched = new Map();      // tradeId -> refundAfter, for trades whose committee the service knows
    this.unproven = new Map();     // tradeId -> sendBy + graceSec, for watched trades without a logged settlement
    for (const name of store.list('watch-')) {
      const w = store.get(name);
      if (!w) continue;
      if (profile) checkProfileTerms(w.terms, profile);
      this.watched.set(w.tradeId, w.terms.refundAfter);
      if (this.settlements.get(w.tradeId)?.status !== 'logged') this.unproven.set(w.tradeId, w.terms.sendBy + w.terms.graceSec);
    }
    this.waitingForWatch = new Map();
    for (const name of store.list('watchwait-')) {
      const w = store.get(name);
      if (w) { if (profile) checkProfileTerms(w.terms, profile); this.waitingForWatch.set(w.tradeId, w); }
    }
    this.unmatchedCounts = new Map();
    this.unmatched = new Map();    // tradeId -> receivedAt, for share messages kept in `unmatched-<tradeId>` until a watch exists
    for (const name of store.list('unmatched-')) {
      const u = store.get(name);
      if (!u) continue;
      this.unmatched.set(u.tradeId, u.receivedAt);
      for (const m of u.messages) this.unmatchedCounts.set(m.from, (this.unmatchedCounts.get(m.from) ?? 0) + 1);
    }
    this.heartbeats = new Map();
    this.funds = new MakerFunds({ solana, trac, now: () => this.now(), log: (...a) => this.log(...a) });
    this.unfunded = {}; this.hidden = new Set();
    if (latest) parseBody('status', { status: 'online', ts: now(), message: '', software: SOFTWARE, latest });
  }

  // A new version only when the content changes; every version is kept in the store, and a new one is numbered above
  // every version stored. Every participant keeps each version it has seen, so issuing a known number again with
  // other content stops trading everywhere: without its stored registry the venue only starts on a first launch.
  #registry(input) {
    if (this.profile) checkProfileRegistry(input, this.profile);
    const previous = this.store.get('service-registry');
    if (!previous && !this.firstLaunch) throw new Error('This data folder has no venue registry. Restore the venue export or the old records/ folder; it holds the registry history. Pass --first-launch only on the very first start of a new venue: issuing version 1 again stops trading for every trader and signer.');
    const { version: _v, issuedAt: _i, ...content } = input;
    if (previous && stableJSON({ ...previous, version: 0, issuedAt: 0 }) === stableJSON({ ...content, version: 0, issuedAt: 0 })) return buildRegistry(previous);
    const highest = Math.max(0, ...this.store.list('service-registry').map(name => this.store.get(name)?.version ?? 0));
    const registry = buildRegistry({ ...content, version: highest + 1, issuedAt: this.now() });
    this.store.put(`service-registry-v${registry.version}`, registry);
    this.store.put('service-registry', registry);
    return registry;
  }

  #fillDue(r) {
    const list = this.fillsDue.get(r.report.offerId) ?? [];
    list.push(r.tradeId); this.fillsDue.set(r.report.offerId, list);
  }

  #index(r) {
    this.byEscrow.set(r.entry.escrowAddress, r.tradeId);
    if (r.fill) this.fills.set(r.fill.offerId, (this.fills.get(r.fill.offerId) ?? 0n) + BigInt(r.fill.amount));
  }

  get trades() {
    return [...this.settlements.values()].filter(r => r.status === 'logged').map(r => r.entry).sort((a, b) => a.ts - b.ts);
  }

  // Credits per signer, derived from the records. A signer the registry removed forfeits every credit not yet paid
  // out (payouts are made by the operator from this list; none is marked paid automatically).
  get payouts() {
    const removed = new Map(this.registry.removed.map(r => [r.dexKey, r.reason ?? 'removed']));
    const out = {};
    for (const r of this.settlements.values()) {
      if (r.status !== 'logged' || !r.credits) continue;
      for (const [dexKey, amount] of Object.entries(r.credits)) {
        (out[dexKey] ??= []).push({ tradeId: r.tradeId, collector: r.report.terms.fees.collector, amount, final: r.creditsFinal === true, payableAfter: r.loggedAt + PAYOUT_DELAY,
          paid: r.paid?.[dexKey] ?? false, forfeited: !(r.paid?.[dexKey]) && removed.has(dexKey) ? removed.get(dexKey) : false });
      }
    }
    return out;
  }

  async start() {
    if (this.profile) checkProfileRegistry(this.registry, this.profile);
    await this.solana.assertFeeConfig(this.registry.fee, this.profile?.platformCollector);
    await this.relays.update(this.registry);
    for (const ch of [MAIN, OFFERS, SIGNERS, CHAT_CHANNEL]) await this.bridge.join(ch);
    this.host.hooks.unrouted.push((ch, m) => this.#public(ch, m));
    await this.host.start();
    await this.#publishRegistry();
    const every = (ms, fn) => setInterval(() => fn().catch(e => this.log('service', e.message)), ms);
    this.timers = [every(this.registryMs, () => this.#publishRegistry()), every(this.bookMs, () => this.#publishBooks()),
      every(this.tickerMs, () => this.#publishTickers()), every(this.reconcileMs, () => this.reconcile())];
  }

  stop() { this.host.stop(); for (const t of this.timers ?? []) clearInterval(t); this.#saveBook(true); }

  #saveBook(now = false) {
    if (!now && this.now() - (this.bookSavedAt ?? -Infinity) < 30) return;
    this.bookSavedAt = this.now();
    try { this.store.put('book-offers', this.book.saved()); } catch (e) { this.log('book save', e.message); }
  }

  #registryWork(work) {
    const next = this.registryQueue.then(work);
    this.registryQueue = next.catch(() => {});
    return next;
  }

  #publishRegistry() { return this.#registryWork(() => this.#broadcastRegistry()); }

  publishFees(fee) {
    return this.#registryWork(async () => {
      const input = buildRegistry({ ...this.registry, fee });
      if (this.profile) checkProfileRegistry(input, this.profile);
      await this.solana.assertFeeConfig(input.fee, this.profile?.platformCollector);
      // Remember operator changes separately so a restart with the original config cannot undo a rotation.
      this.store.put('service-fee-policy', { fee: input.fee });
      this.registry = this.#registry(input);
      this.registries.set(this.registry.version, this.registry);
      await this.#broadcastRegistry();
      return this.registry;
    });
  }

  async #broadcastRegistry() {
    if (this.profile) checkProfileRegistry(this.registry, this.profile);
    await this.solana.assertFeeConfig(this.registry.fee, this.profile?.platformCollector);
    await this.relays.update(this.registry);
    await this.host.sendPublic(MAIN, 'registry', this.registry);
    this.store.put('service-registry-published', this.registry);
    this.registryPublishedAt = this.now();
    const update = !meetsVersion(SOFTWARE, this.registry.minSoftware);
    await this.host.sendPublic(MAIN, 'status', { status: update ? 'degraded' : 'online', ts: this.now(), software: SOFTWARE,
      message: update ? 'update required' : '', ...(this.latest ? { latest: this.latest } : {}) });
  }

  async #publishBooks() {
    const now = this.now();
    this.#saveBook();
    const makers = new Set();
    for (const p of this.registry.pairs.filter(p => supportedBase(p.base) && p.status === 'open')) {
      const listed = this.book.snapshot(p.pair, now).filter(o => o.registryVersion === this.registry.version && meetsVersion(o.software, this.registry.minSoftware));
      this.funds.refresh(listed);
      for (const o of listed) makers.add(o.side === 'sell' ? `trac:${o.maker.tracAddr}` : `solana:${o.maker.solAddr}`);
      const offers = listed.filter(o => {
        const funded = this.funds.funded(o, p);
        if (funded === this.hidden.has(o.offerId)) {
          if (funded) this.hidden.delete(o.offerId); else this.hidden.add(o.offerId);
          this.log(funded ? 'offer funded again' : 'offer hidden, maker cannot fund the smallest trade', p.pair, o.side, o.offerId.slice(0, 12),
            o.side === 'sell' ? o.maker.tracAddr : o.maker.solAddr, JSON.stringify(this.funds.balances(o)));
        }
        return funded;
      });
      this.unfunded[p.pair] = listed.length - offers.length;
      const message = this.bookFeed.next(p.pair, this.registry.version, offers, now, () => {
        const seq = (this.store.get('book-sequence')?.seq ?? 0) + 1;
        this.store.put('book-sequence', { seq }); return seq;
      });
      if (message) await this.host.sendPublic(MAIN, message.kind, message.body);
    }
    this.funds.forget(makers);
    for (const id of this.hidden) if (!this.book.get(id, now)) this.hidden.delete(id);
  }

  async #publishTickers() {
    const now = this.now() * 1000;
    const logged = this.trades.map(t => ({ pair: t.pair, ts: t.ts * 1000, baseAmount: t.baseAmount, quoteAmount: t.quoteAmount }));
    for (const p of this.registry.pairs.filter(p => supportedBase(p.base) && p.status === 'open')) {
      await this.host.sendPublic(MAIN, 'ticker', { ...ticker(p, logged, now), registryVersion: this.registry.version, ts: Math.floor(now / 1000) });
    }
  }

  async #public(channel, raw) {
    if (channel === CHAT_CHANNEL) { this.chat.receive(raw); return; }
    if (channel === SIGNERS && raw?.kind === 'sharePublish') return this.#shareMessage(raw);
    const m = this.receive(raw);
    if (!m || m.ch !== channel) return;
    if (channel === OFFERS && m.kind === 'offer' && validOffer(m.body, m.from)) {
      try {
        registryPair(this.registry, m.body.pair);
        const snapshot = this.registries.get(m.body.registryVersion);
        const pair = registryPair(snapshot, m.body.pair);
        if (BigInt(m.body.baseAmount) < BigInt(pair.minBaseAmount) || !meetsVersion(SOFTWARE, this.registry.minSoftware) ||
            !meetsVersion(m.body.software, this.registry.minSoftware) || !meetsVersion(m.body.software, snapshot.minSoftware)) return;
      } catch { return; }
      // Fills of logged trades survive restarts and reannouncements; trades logged before their offer was seen are
      // attributed now.
      if (this.book.add(m.body, this.now()) && this.fills.has(m.body.offerId)) this.book.fill(m.body.offerId, this.fills.get(m.body.offerId));
      if (this.fillsDue.has(m.body.offerId)) this.#applyDueFills(m.body.offerId);
    } else if (channel === OFFERS && m.kind === 'cancel') this.book.cancel(m.body.offerId, m.from);
    else if (channel === OFFERS && m.kind === 'settled') return this.#settled(m);
    else if (channel === SIGNERS && m.kind === 'summon') this.#summon(m);
    else if (channel === SIGNERS && m.kind === 'heartbeat' && this.#listed(m.from)) this.heartbeats.set(m.from, { ...m.body, at: this.now() });
  }

  // Only signers of the current registry count as online; anyone can send a heartbeat on the public channel.
  #listed(dexKey) { return this.registry.signers.some(s => s.dexKey === dexKey); }

  // The service watches trades whose committee it verified, so it knows who may publish which share.
  #summon(m) {
    try {
      const { terms } = verifySummon(m.body, this.registries.get(m.body.terms?.registryVersion), this.now());
      if (this.profile) checkProfileTerms(terms, this.profile);
      this.#watch(terms, m.body);
    } catch {}
  }

  // A logged settlement always gets its watch. Unproven watches share MAX_UNPROVEN_WATCHES; when it is full, one past
  // sendBy + grace without any settlement report is archived to make room (a later proven settlement restores it).
  #watch(terms, summon = null) {
    if (this.profile) checkProfileTerms(terms, this.profile);
    const tradeId = termsTradeId(terms), now = this.now(), proven = this.settlements.get(tradeId)?.status === 'logged';
    if (!this.watched.has(tradeId)) {
      for (const [id, refundAfter] of this.watched) if (refundAfter + PAYOUT_DELAY + DAY < now) this.#archive(id);
      for (const [id, until] of this.unproven) {
        if (proven || this.unproven.size < MAX_UNPROVEN_WATCHES) break;
        if (until <= now && !this.settlements.has(id)) this.#archive(id);
      }
      if (!proven && this.unproven.size >= MAX_UNPROVEN_WATCHES) {
        if (!this.waitingForWatch.has(tradeId)) {
          const waiting = { tradeId, terms, summon };
          this.store.put(`watchwait-${tradeId}`, waiting);
          this.waitingForWatch.set(tradeId, waiting);
        }
        return;
      }
      const archived = this.store.get(`watcharchive-${tradeId}`);
      if (archived && this.profile) checkProfileTerms(archived.terms, this.profile);
      this.store.put(`watch-${tradeId}`, archived ?? { tradeId, terms, summon, shares: {} });
      this.watched.set(tradeId, terms.refundAfter);
      if (!proven) this.unproven.set(tradeId, terms.sendBy + terms.graceSec);
    }
    if (proven) this.unproven.delete(tradeId);
    this.#mergeUnmatched(tradeId);
    this.store.delete(`watchwait-${tradeId}`);
    this.waitingForWatch.delete(tradeId);
  }

  // Archive before dropping the active copy; absence of a report never retires accepted evidence.
  #archive(id) {
    const r = this.settlements.get(id), w = this.store.get(`watch-${id}`);
    if (w && r?.status !== 'rejected' && !r?.creditsFinal) this.store.put(`watcharchive-${id}`, w);
    this.store.delete(`watch-${id}`);
    this.watched.delete(id); this.unproven.delete(id);
  }

  #dropUnmatched(tradeId) {
    const u = this.store.get(`unmatched-${tradeId}`);
    this.store.delete(`unmatched-${tradeId}`);
    this.unmatched.delete(tradeId);
    for (const m of u?.messages ?? []) {
      const count = (this.unmatchedCounts.get(m.from) ?? 1) - 1;
      if (count) this.unmatchedCounts.set(m.from, count);
      else this.unmatchedCounts.delete(m.from);
    }
  }

  // Delete the source only once every share reached a durable watch.
  #mergeUnmatched(tradeId) {
    const u = this.store.get(`unmatched-${tradeId}`);
    if (!u || !this.watched.has(tradeId) || !this.store.get(`watch-${tradeId}`)) return;
    for (const m of u.messages) this.#share(m);
    this.#dropUnmatched(tradeId);
  }

  #shareMessage(raw) {
    let m;
    // Signers re-send their original messages for as long as a trade can run, under any registry version still in use.
    // Copies are deduplicated per trade and index (#share), not by a replay cache, so a copy that arrives after a
    // failed write is still taken.
    const longest = Math.max(...[...this.registries.values()].map(r => r.params.refundSec));
    try { m = open(raw, { now: this.now(), seen: createReplayCache(), maxAgeSec: Math.max(3 * DAY, longest + DAY) }); } catch { return; }
    if (m.kind !== 'sharePublish') return;
    const key = sha256Hex(stableJSON(m));
    if (!this.firstSeen.has(key)) {
      if (this.firstSeen.size >= 200000) this.firstSeen.delete(this.firstSeen.keys().next().value);
      this.firstSeen.set(key, this.now());
    }
    this.#share({ ...m, receivedAt: this.firstSeen.get(key) });
  }

  // Receipt time, not the publisher's timestamp, determines eligibility. Unknown trades have per-sender bounds;
  // a verified trade waiting for capacity, or referenced by a settlement, keeps its evidence until import.
  #share(m) {
    const b = m.body, now = this.now();
    const watchName = this.watched.has(b.tradeId) ? `watch-${b.tradeId}` : `watcharchive-${b.tradeId}`;
    const w = this.store.get(watchName);
    if (!w) {
      if (![...this.registries.values()].some(r => r.signers.some(s => s.dexKey === m.from))) return;
      const u = this.store.get(`unmatched-${b.tradeId}`) ?? { tradeId: b.tradeId, receivedAt: m.receivedAt ?? now, messages: [] };
      const digest = sha256Hex(stableJSON(b));
      const duplicate = u.messages.find(x => x.from === m.from && x.body.signerIndex === b.signerIndex &&
        x.body.tradeId === b.tradeId && sha256Hex(stableJSON(x.body)) === digest);
      if (duplicate) {
        if (m.receivedAt < duplicate.receivedAt) {
          duplicate.receivedAt = m.receivedAt;
          u.receivedAt = Math.min(u.receivedAt, m.receivedAt);
          this.store.put(`unmatched-${b.tradeId}`, u);
          this.unmatched.set(b.tradeId, u.receivedAt);
        }
        return;
      }
      for (const [id, at] of this.unmatched) {
        if (id !== b.tradeId && at < now - DAY && !this.settlements.has(id) && !this.waitingForWatch.has(id)) this.#dropUnmatched(id);
      }
      if (u.messages.filter(x => x.from === m.from).length >= UNMATCHED_PER_SENDER || (this.unmatchedCounts.get(m.from) ?? 0) >= 5000) return;
      u.messages.push(m);
      u.receivedAt = Math.min(u.receivedAt, m.receivedAt ?? now);
      this.store.put(`unmatched-${b.tradeId}`, u);
      this.unmatched.set(b.tradeId, u.receivedAt);
      this.unmatchedCounts.set(m.from, (this.unmatchedCounts.get(m.from) ?? 0) + 1);
      return;
    }
    if (this.profile) checkProfileTerms(w.terms, this.profile);
    if (w.terms.committee[b.signerIndex - 1]?.dexKey !== m.from || w.shares[b.signerIndex]) return;
    const receivedAt = m.receivedAt ?? now;
    if (receivedAt > w.terms.refundAfter) return;
    w.shares[b.signerIndex] = { share: b.share, H: b.H, commitments: b.commitments, at: receivedAt };
    this.store.put(watchName, w);
  }

  #serialize(work) {
    const next = this.settlementQueue.then(work);
    this.settlementQueue = next.catch(() => {});
    return next;
  }

  // Check reports before they may occupy a slot. Only unavailable reads leave a pending record.
  async #settled(m) {
    const b = m.body;
    let terms;
    try { terms = validateTerms(b.terms); } catch { return; }
    if (termsTradeId(terms) !== b.tradeId || m.from !== terms.seller.dexKey || terms.fees.collector !== this.registries.get(terms.registryVersion)?.fee.collector) return;
    const logged = await this.#serialize(async () => {
      if (this.settlements.has(b.tradeId)) return false;
      const record = { tradeId: b.tradeId, status: 'pending', reportedAt: this.now(),
        report: { offerId: b.offerId, terms, hashHex: b.hashHex, txHash: b.txHash } };
      return this.#applyProof(record);
    });
    if (logged) await this.reconcile();
  }

  // Admission and reconciliation share a queue, including escrow uniqueness and capacity checks.
  reconcile() {
    return this.#serialize(async () => {
      // Shares only count toward credits of logged settlements, so only those are asked for; summoned trades that never
      // settled would otherwise cost a public message each every ten minutes until their refund time.
      for (const [tradeId, refundAfter] of this.watched) {
        if (this.now() >= refundAfter || this.settlements.get(tradeId)?.status !== 'logged') continue;
        const w = this.store.get(`watch-${tradeId}`);
        if (!w || this.now() - (w.shareRequestAt ?? -Infinity) < 600 || w.terms.committee.every((_, i) => w.shares[i + 1])) continue;
        this.store.put(`watch-${tradeId}`, { ...w, shareRequestAt: this.now() });
        this.host.sendPublic(SIGNERS, 'shareRequest', { tradeId }).catch(e => this.log('share request', e.message));
      }
      for (const w of this.waitingForWatch.values()) {
        try { this.#watch(w.terms, w.summon); } catch (e) { this.log('watch', w.tradeId.slice(0, 12), e.message); }
      }
      for (const id of [...this.settlements.keys()]) {
        try {
          let r = this.settlements.get(id);
          const now = this.now();
          if (r.status === 'pending' && (now - r.reportedAt < 2 * DAY || now - (r.triedAt ?? 0) >= 3600)) {
            await this.#applyProof(r);
            r = this.settlements.get(id);
          }
          if (r?.status !== 'logged') continue;
          if (!r.creditsFinal) {
            this.#watch(r.report.terms);
            this.#mergeUnmatched(id);
          }
          if (!r.published) await this.#publish(r);
          r = this.settlements.get(id);
          if (!r.creditsFinal && this.watched.has(id) && now >= r.report.terms.refundAfter + CREDIT_AFTER_SEC) this.#credit(r);
          if (this.settlements.get(id).creditsFinal) this.store.delete(`watcharchive-${id}`);
        } catch (e) { this.log('settlement', id.slice(0, 12), e.message); }
      }
    });
  }

  async #applyProof(r) {
    const proof = await this.#prove(r);
    if (proof.status === 'rejected') {
      this.store.delete(`settle-${r.tradeId}`);
      this.settlements.delete(r.tradeId);
      // Archived share evidence stays: a rejected report (even the seller's own) never retires signers' liabilities.
      this.log('settlement rejected', r.tradeId.slice(0, 12), proof.reason);
      return false;
    }
    if (proof.status === 'pending') {
      if (!this.settlements.has(r.tradeId)) {
        const pending = [...this.settlements.values()].filter(x => x.status === 'pending');
        if (pending.length >= 5000 || pending.filter(x => x.report.terms.seller.dexKey === r.report.terms.seller.dexKey).length >= 50) return false;
      }
      this.#save(r, { triedAt: this.now() });
      return false;
    }
    const logged = this.#save(r, proof);
    this.#index(logged);
    if (logged.fill) this.book.fill(logged.fill.offerId, BigInt(logged.fill.amount));
    if (logged.fillPending) this.#fillDue(logged);
    this.log('trade logged', r.tradeId.slice(0, 12), r.report.terms.pair, r.report.terms.baseAmount, r.report.terms.quoteAmount);
    return true;
  }

  #save(r, changes) {
    const next = { ...r, ...changes };
    this.store.put(`settle-${r.tradeId}`, next);
    this.settlements.set(r.tradeId, next);
    return next;
  }

  async #prove(r) {
    const { terms, hashHex, txHash, offerId } = r.report, now = this.now();
    const rejected = reason => ({ status: 'rejected', reason });
    const escrowAddress = deriveEscrowPda(hashHex, this.profile?.programId).pda.toBase58();
    const other = this.byEscrow.get(escrowAddress);
    if (other && other !== r.tradeId) return rejected(`escrow already funded trade ${other}`);
    try { checkTermsAgainstRegistry(terms, this.registries.get(terms.registryVersion)); if (this.profile) checkProfileTerms(terms, this.profile); }
    catch (e) { return rejected(e.message); }
    try {
      const escrow = await this.solana.checkEscrow({ terms, hashHex, purpose: 'settlement' });
      if (escrow.status === 'pending' || escrow.unknown) return { status: 'pending' };
      if (!escrow.ok || escrow.status !== 'claimed') return rejected("escrow is not this trade's claimed escrow");
      const transfer = await this.trac.verifyTransfer({ asset: terms.base.id, txHash, from: terms.seller.tracAddr,
        to: terms.buyer.tracAddr, minAmount: terms.baseAmount, nonce: transferNonce(r.tradeId), tradeId: r.tradeId, finalBefore: Number.MAX_SAFE_INTEGER });
      if (['read_failed', 'verification_failed', 'adapter_closed', 'used_tx_store_required', 'reset_reader_required'].includes(transfer.reason)) return { status: 'pending' };
      if (!transfer.ok || !transfer.final) return rejected('no matching final Trac transfer');
      // The claim comes from the escrow's verified history, never from the seller's word.
      const settledTx = await this.solana.settlementSignature({ terms, hashHex });
      if (settledTx?.status === 'pending') return { status: 'pending' };
      if (settledTx?.status !== 'claimed') return rejected('no matching claim in escrow history');
      const entry = { tradeId: r.tradeId, pair: terms.pair, registryVersion: terms.registryVersion, baseAmount: terms.baseAmount, quoteAmount: terms.quoteAmount, ts: now,
        price: tradePrice({ base: terms.base }, terms.baseAmount, terms.quoteAmount),
        seller: { tracAddr: terms.seller.tracAddr, solAddr: terms.seller.solRecipient },
        buyer: { tracAddr: terms.buyer.tracAddr, solAddr: terms.buyer.solPayer },
        termsHash: sha256Hex(stableJSON(terms)), escrowAddress, claimSignature: settledTx.signature, tracTxHash: txHash };
      const match = terms.offerId === offerId ? this.#offerMatches(offerId, terms) : false;
      const fill = match === true ? { offerId, amount: terms.baseAmount } : null;
      return { status: 'logged', loggedAt: now, entry, fill, fillPending: match === null, published: false, credits: null };
    } catch (e) {
      if (e.definitive) return rejected(e.message);
      return { status: 'pending' };
    }
  }

  #applyDueFills(offerId) {
    for (const id of this.fillsDue.get(offerId) ?? []) {
      const r = this.settlements.get(id);
      if (!r?.fillPending) continue;
      const match = this.#offerMatches(offerId, r.report.terms);
      if (match === null) continue;
      const fill = match ? { offerId, amount: r.report.terms.baseAmount } : null;
      this.#save(r, { fill, fillPending: false });
      if (fill) {
        this.fills.set(offerId, (this.fills.get(offerId) ?? 0n) + BigInt(fill.amount));
        this.book.fill(offerId, BigInt(fill.amount));
      }
    }
    this.fillsDue.delete(offerId);
  }

  async #publish(r) {
    await this.host.sendPublic(MAIN, 'tradeLog', r.entry);
    this.#save(this.settlements.get(r.tradeId), { published: true });
  }

  // Only the offer the terms were made from loses inventory: the terms name it, and the maker on its side and its
  // price must match.
  // true, false, or null when the offer is not in the book.
  #offerMatches(offerId, terms) {
    const o = this.book.get(offerId, this.now());
    if (!o) return null;
    if (terms.offerId !== offerId || o.pair !== terms.pair || BigInt(terms.baseAmount) > o.remaining) return false;
    const maker = o.side === 'sell' ? terms.seller : terms.buyer;
    return maker.dexKey === o.maker.dexKey && quoteAmount(registryPair(this.registries.get(terms.registryVersion), o.pair), terms.baseAmount, o.price) === terms.quoteAmount;
  }

  // Signers whose published share verifies against the dealing's commitments, when those commitments belong to the
  // secret that opened the escrow (k verified shares reconstruct a secret hashing to H), split the signer part
  // of the venue fee. Computed after the publication window (refundAfter) closed and final at the payout date.
  #credit(r) {
    const { terms, hashHex } = r.report, w = this.store.get(`watch-${r.tradeId}`);
    const groups = new Map();
    for (const [id, x] of Object.entries(w?.shares ?? {})) {
      if (x.H !== hashHex || !Array.isArray(x.commitments) || x.commitments.length !== terms.k) continue;
      const key = stableJSON(x.commitments);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ id: Number(id), share: fromLe32(hexToBytes(x.share, 32)), commitments: x.commitments });
    }
    // With fewer than k dishonest signers (the protocol's assumption) only the dealt polynomial has k or more
    // publishers; the largest qualifying group is taken.
    let paid = [];
    for (const list of groups.values()) {
      const valid = list.filter(p => verifyShare(p.id, p.share, p.commitments));
      if (valid.length < terms.k || valid.length <= paid.length) continue;
      let secret;
      try { secret = reconstruct(valid.slice(0, terms.k), terms.k); } catch { continue; }
      if (sha256Hex(le32(secret)) === hashHex) paid = valid.map(p => terms.committee[p.id - 1].dexKey);
    }
    const credits = {};
    if (paid.length) {
      const fee = BigInt(terms.quoteAmount) * BigInt(terms.fees.tradeFeeBps) / 10000n;
      const each = fee * BigInt(terms.fees.signerShareBps) / 10000n / BigInt(paid.length);
      for (const k of paid) credits[k] = each.toString();
    }
    // Provisional until the payout date, so late-arriving evidence still counts; final from then on.
    const creditsFinal = this.now() >= r.loggedAt + PAYOUT_DELAY;
    if (stableJSON(credits) !== stableJSON(r.credits ?? null) || creditsFinal) this.#save(r, { credits, creditsFinal });
  }

  // Records that the operator paid a signer for exactly these final, unpaid credits (the payment itself happens
  // outside the venue). Refuses the whole list if any entry is no longer owed.
  markPaid(dexKey, tradeIds) {
    return this.#serialize(async () => {
      if (!Array.isArray(tradeIds) || !tradeIds.length || new Set(tradeIds).size !== tradeIds.length) throw new Error('Name the trades to mark paid');
      if (this.registry.removed.some(r => r.dexKey === dexKey)) throw new Error('A removed signer forfeits unpaid credits');
      const records = tradeIds.map(id => this.settlements.get(id));
      if (records.some(r => r?.status !== 'logged' || !r.creditsFinal || !r.credits?.[dexKey] || r.paid?.[dexKey])) throw new Error('Not every trade is owed to this signer');
      for (const r of records) this.#save(r, { paid: { ...r.paid, [dexKey]: true } });
      return { dexKey, trades: tradeIds.length, amount: records.reduce((a, r) => a + BigInt(r.credits[dexKey]), 0n).toString() };
    });
  }

  readChat(since) { return this.chat.read(since); }

  status() {
    const count = s => [...this.settlements.values()].filter(r => r.status === s).length;
    const accounting = {};
    for (const r of this.settlements.values()) {
      if (r.status !== 'logged') continue;
      const { terms } = r.report, collector = terms.fees.collector;
      const row = accounting[collector] ??= { tradeFeeBps: terms.fees.tradeFeeBps, fees: 0n, signerCredits: 0n, trades: 0 };
      row.fees += BigInt(terms.quoteAmount) * BigInt(terms.fees.tradeFeeBps) / 10000n;
      row.signerCredits += Object.values(r.credits ?? {}).reduce((n, amount) => n + BigInt(amount), 0n); row.trades++;
    }
    return { software: SOFTWARE, updateRequired: !meetsVersion(SOFTWARE, this.registry.minSoftware),
      message: !meetsVersion(SOFTWARE, this.registry.minSoftware) ? 'update required' : '', pairs: pairStatus(this.registry),
      ...(this.latest ? { latest: this.latest } : {}), dexKey: this.identity.publicKey, registryVersion: this.registry.version, trades: count('logged'),
      fee: this.registry.fee, chat: this.readChat(),
      feeAccounting: Object.fromEntries(Object.entries(accounting).map(([collector, r]) => [collector,
        { ...r, fees: r.fees.toString(), signerCredits: r.signerCredits.toString() }])),
      settlements: { pending: count('pending'), rejected: count('rejected'), expired: count('expired') },
      signersOnline: [...this.heartbeats].filter(([k, h]) => this.now() - h.at < 90 && this.#listed(k)).map(([k]) => k),
      book: Object.fromEntries(this.registry.pairs.filter(p => supportedBase(p.base) && p.status === 'open').map(p => [p.pair, this.book.snapshot(p.pair, this.now()).length])), unfunded: this.unfunded, payouts: this.payouts };
  }
}
