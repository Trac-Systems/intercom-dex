import { createBuyer } from '../core/trade-buyer.js';
import { isAbsolute } from 'node:path';
import { createSeller } from '../core/trade-seller.js';
import { tradeId as termsTradeId } from '../core/terms.js';
import { TradeHost, tradeChannel, isFinished } from './host.js';
import { RegistryView, buildDraft, publicReceiver, nowSec, random32, offerIdOf, validOffer } from './common.js';
import { quoteAmount, registryPair, pairStatus } from '../market/assets.js';
import { BookView } from '../market/book-feed.js';
import { freshOffer, availableOffer, STALE_OFFER_MESSAGE } from '../market/book.js';
import { RegistryRelays } from '../net/relays.js';
import { CertificatePool } from './certificate-pool.js';
import { SOFTWARE, meetsVersion } from '../core/software.js';
import { checkProfileTerms } from '../net/profile.js';
import { chatInputSchema, parseBody } from '../core/schemas.js';
import { seal } from '../core/envelope.js';
import { sha256Hex } from '../core/canonical.js';
import { CHAT_CHANNEL, MarketChat } from '../market/chat.js';
import { createLocksClient } from '../locks/client.js';

const OFFERS = 'intercom-dex:offers', MAIN = 'intercom-dex', SIGNERS = 'intercom-dex:signers';
export const SIGNER_ONLINE_SEC = 90;
// An own offer missing from a venue book heard this long after announcing it is reported as not listed.
export const LISTED_AFTER_SEC = 10;
// Signers send a heartbeat every 30 s: until this long after start, a missing heartbeat says nothing, so running trades
// do not abort for signers this app has not heard from yet.
export const SIGNER_WARMUP_MS = 35_000;
// Own open offers are announced again this often; takers on 0.1.14+ count a maker silent for 70 s as probably offline.
export const REANNOUNCE_MS = 45_000;
// While the dashboard shows a market, the makers of its best offer on each side (on 0.1.14+, heard within 70 s) are kept
// connected, at most four in all, so a take there starts talking at once. Older makers are left alone: before 0.1.8
// their peers stop at 64 connections.
export const WARM_MS = 15_000, WARM_VIEW_SEC = 60, WARM_MAX = 4, WARM_SOFTWARE = '0.1.14', WARM_LIVE_SEC = 70;
const WARM_RETRY_SEC = 180;
// A cancel whose announce failed is announced again every 10 s, up to six times.
export const CANCEL_RETRY_MS = 10_000, CANCEL_RETRIES = 6;
export const MAX_TRADES_PER_OFFER = 3;
export const MAX_NEGOTIATIONS_PER_TAKER = 3;
// Declines answer strangers, so they are bounded: one per sender per minute, DECLINES_PER_MINUTE in total. A decline
// marker outlives the take's envelope window (120 s either side of its timestamp) and is then pruned.
export const DECLINES_PER_MINUTE = 30;
const DECLINE_MARKER_SEC = 300;
const beforeLock = t => !isFinished(t) && !t.state.lockAttempted && !t.state.locked && !t.state.escrowOk &&
  !['transferring', 'awaitShares', 'claiming'].includes(t.state.phase);

// A trader: posts and takes offers, then runs the buyer or seller side of each trade.
// `me` = {dexKey, tracAddr, solAddr}; `solana`/`trac` are the chain adapters for this trader's own keys.
export class Trader {
  constructor({ bridge, identity, store, solana, trac, me, serviceKey, mint, platformCollector, profile = null, proof, log = console.log, locks = null }) {
    if (typeof proof?.zkey !== 'string' || !isAbsolute(proof.zkey)) throw new Error('Traders require proof.zkey as an absolute path');
    Object.assign(this, { bridge, identity, store, me, serviceKey, mint: profile?.mint ?? mint, platformCollector: profile?.platformCollector ?? platformCollector, profile, log });
    this.certificates = new CertificatePool({ store, proof, log });
    this.heartbeats = new Map(); this.startedAt = performance.now();
    this.takeQueue = Promise.resolve();
    this.declined = new Map();   // sender -> time of its last decline, for the last minute
    this.host = new TradeHost({ bridge, identity, store, solana, trac, proof, profile, log, certificatePool: this.certificates,
      onlineSigners: registry => this.#warming() ? null : this.onlineSigners(registry),
      eligibleOnline: (amount, pair, registry) => this.#warming() ? null : this.eligibleOnline(amount, pair, registry),
      // An own open offer's channel stays joined after a trade on it ended: the next taker comes through it.
      keepChannel: ch => this.mine?.has(ch.slice(tradeChannel('').length)) ?? false });
    this.registry = new RegistryView(serviceKey, store, log, profile);
    this.relays = new RegistryRelays(bridge);
    this.receive = publicReceiver();
    this.offers = new Map();     // offerId -> {offer, from, firstSeen, lastSeen}
    this.mine = new Map();       // own active offers: offerId -> offer (sizes come from the trades, see #inventory)
    this.bookView = new BookView();
    this.book = this.bookView.books;       // pair -> latest service book
    this.tickers = new Map();
    this.chat = new MarketChat({ chatRelays: profile?.chatRelays ?? [] });
    if (locks?.venueKey) this.locks = createLocksClient({ ...locks,
      adapters: { ...locks.adapters, lastPrice: locks.adapters?.lastPrice ?? ((asset = 'RESET') => this.tickers.get(`${asset}/USDC`)?.last ?? null) } });
  }

  async start() {
    await this.relays.update(this.registry.usable);
    for (const ch of [MAIN, OFFERS, SIGNERS, CHAT_CHANNEL]) await this.bridge.join(ch);
    this.host.hooks.unrouted.push((ch, m) => this.#public(ch, m));
    this.host.hooks.afterStep.push((trade, before) => this.#afterStep(trade, before));
    await this.host.start();
    for (const t of this.host.trades.values()) if (t.role === 'seller' && t.state.phase === 'complete') this.#recordReport(t);
    await this.#sendReports().catch(e => this.log('settlement report', e.message));
    this.reports = setInterval(() => this.#sendReports().catch(e => this.log('settlement report', e.message)), 60000);
    await this.#restoreOffers();
    this.#pruneDeclines();
    this.reannounce = setInterval(() => {
      try { this.#pruneDeclines(); this.pruneOffers(); } catch (e) { this.log('prune', e.message); }
      this.#reannounce().catch(e => this.log('offer announce', e.message));
    }, REANNOUNCE_MS);
    this.certificates.start();
    this.viewing = new Map();
    this.warmTimer = setInterval(() => this.#warm().catch(() => {}), WARM_MS);
    this.warmTimer.unref?.();
    // Locks never keep spot trading from starting.
    if (this.locks) await this.locks.start().catch(e => this.log('locks start', e.message));
  }

  stop() { this.host.stop(); this.certificates.stop(); clearInterval(this.reannounce); clearInterval(this.reports); clearInterval(this.warmTimer);
    this.locks?.stop().catch(e => this.log('locks stop', e.message)); }

  // The dashboard reports the offers a click on its best ask and bid would take.
  noteViewing(pair, offerIds) { this.viewing?.set(pair, { at: nowSec(), offerIds: offerIds.filter(Boolean) }); }

  async warmNow() { this.warmSig = null; await this.#warm(true); return this.warmKept ?? []; }

  async #warm(explain = false) {
    const now = nowSec(), keys = [], skipped = new Set();
    if (now < (this.warmRetryAt ?? 0)) {
      if (explain) this.log('warm makers: no peer keys', `retry in ${this.warmRetryAt - now}s after a failed request`);
      return;
    }
    for (const [pair, v] of this.viewing) {
      if (now - v.at > WARM_VIEW_SEC) { this.viewing.delete(pair); skipped.add('view expired'); continue; }
      for (const id of v.offerIds) {
        const seen = this.offers.get(id), o = seen?.offer;
        let reason;
        if (!o) reason = 'offer not found';
        else if (!o.peerKey) reason = 'missing peerKey';
        else if (o.maker.dexKey === this.identity.publicKey) reason = 'own offer';
        else if (now - (seen.lastSeen ?? 0) > WARM_LIVE_SEC) reason = 'maker not heard within 70s';
        else try { if (!meetsVersion(o.software, WARM_SOFTWARE)) reason = 'maker software too old'; }
        catch { reason = 'invalid maker software'; }
        if (reason) { skipped.add(reason); continue; }
        if (!keys.includes(o.peerKey)) keys.push(o.peerKey);
      }
    }
    const list = keys.slice(0, WARM_MAX), sig = list.join(',');
    if (!list.length && (explain || this.warmSig)) this.log('warm makers: no peer keys', [...skipped].join(', ') || 'no viewed offers');
    if (sig === this.warmSig) return;
    try {
      this.warmKept = (await this.bridge.request({ type: 'dex_warm', peerKeys: list })).peerKeys ?? list;
      // A full peer or a peer still starting may keep fewer keys; retry that selection on the next interval.
      this.warmSig = this.warmKept.join(',');
      // Logged when it starts, not on every interval while it lasts.
      const none = list.length > 0 && !this.warmKept.length;
      if (none && !this.warmNone) this.log('warm makers: no peer keys', 'peer kept none; connection not ready or maker peer limit reached (see peer log)');
      this.warmNone = none;
    } catch (e) {
      this.warmRetryAt = now + WARM_RETRY_SEC; this.warmSig = null; this.warmKept = [];
      this.log('warm makers unavailable', e.message, `retry in ${WARM_RETRY_SEC}s`);
    }
  }

  #warming() { return performance.now() - this.startedAt < SIGNER_WARMUP_MS; }

  onlineSigners(registry = this.registry.usable) {
    const reg = this.registry.usable, now = performance.now(), minimum = registry?.minSoftware;
    return (reg?.signers ?? []).filter(s => s.status === 'active' && !reg.removed.some(r => r.dexKey === s.dexKey) &&
      this.heartbeats.has(s.dexKey) && now - this.heartbeats.get(s.dexKey).at <= SIGNER_ONLINE_SEC * 1000 &&
      meetsVersion(s.software, minimum) && meetsVersion(this.heartbeats.get(s.dexKey).software, minimum)).map(s => s.dexKey);
  }

  eligibleOnline(amount, pair, registry = this.registry.usable) {
    const online = new Set(this.onlineSigners(registry));
    return this.#eligible(amount, pair, registry).filter(s => online.has(s.dexKey));
  }

  #eligible(amount, pair, registry = this.registry.usable, exclude = []) {
    if (!registry || !pair) return [];
    let entry;
    try { entry = registryPair(registry, pair); } catch { return []; }
    return registry.signers.filter(s => s.status === 'active' && s.assets.includes(entry.base.id) &&
      meetsVersion(s.software, registry.minSoftware) && BigInt(s.limitUsdc) >= BigInt(amount) && !exclude.includes(s.dexKey));
  }

  #newPair(pair, version, software = SOFTWARE) {
    const current = this.registry.usable, snapshot = this.registry.snapshot(version);
    if (!current || !snapshot) throw new Error('No usable registry');
    if (!meetsVersion(SOFTWARE, current.minSoftware) || !meetsVersion(software, current.minSoftware) ||
        !meetsVersion(SOFTWARE, snapshot.minSoftware) || !meetsVersion(software, snapshot.minSoftware)) throw new Error('update required');
    registryPair(current, pair);
    return registryPair(snapshot, pair);
  }

  // Takes that fail authentication or basic validity get no answer at all; the transport stamps declines last.
  #decline(channel, m, reason) {
    const now = nowSec(), name = `decline-${sha256Hex(m.from + m.nonce)}`;
    for (const [key, at] of this.declined) if (at <= now - 60) this.declined.delete(key);
    if (this.declined.has(m.from) || this.declined.size >= DECLINES_PER_MINUTE || this.store.get(name)) return;
    this.declined.set(m.from, now);
    this.store.put(name, { at: now, reason });
    this.host.sendPublic(channel, 'decline', { offerId: m.body.offerId, takeNonce: m.nonce, reason })
      .catch(e => this.log('decline failed', e.message));
  }

  #pruneDeclines(now = nowSec()) {
    for (const name of this.store.list('decline-')) if (!(this.store.get(name)?.at > now - DECLINE_MARKER_SEC)) this.store.delete(name);
  }

  async #public(channel, raw) {
    if (channel === CHAT_CHANNEL) { this.chat.receive(raw); return; }
    const m = this.receive(raw);
    if (!m || m.ch !== channel) return;
    if (channel === MAIN && m.from === this.serviceKey) {
      if (m.kind === 'registry') {
        if (this.registry.offer(m)) this.log('registry', this.registry.current.version);
        await this.relays.update(this.registry.usable);
      }
      if (m.kind === 'book' && this.#marketMessage(m.body)) this.bookView.full(m.body, nowSec());
      if (m.kind === 'bookDelta') this.bookView.delta(m.body, m.ts, nowSec());
      if (m.kind === 'ticker' && this.#marketMessage(m.body)) this.tickers.set(m.body.pair, m.body);
      if (m.kind === 'status') this.serviceStatus = m.body;
      if (m.kind === 'tradeLog' && this.#marketMessage(m.body, false) && this.store.get(`report-${m.body.tradeId}`)) this.store.put(`report-${m.body.tradeId}`, { delivered: true });
    } else if (channel === SIGNERS && m.kind === 'heartbeat') {
      const reg = this.registry.usable;
      if (reg?.signers.some(s => s.dexKey === m.from && s.status === 'active') && !reg.removed.some(s => s.dexKey === m.from)) {
        if (m.body.status === 'online') this.heartbeats.set(m.from, { at: performance.now(), software: m.body.software, registryVersion: m.body.registryVersion });
        else this.heartbeats.delete(m.from);
      }
    } else if (channel === OFFERS && m.kind === 'offer' && validOffer(m.body, m.from)) {
      try { this.#newPair(m.body.pair, m.body.registryVersion, m.body.software); } catch { return; }
      const now = nowSec();
      this.pruneOffers(now);
      if (m.body.expiresAt > now) this.offers.set(m.body.offerId, {
        offer: m.body, from: m.from, firstSeen: this.offers.get(m.body.offerId)?.firstSeen ?? now, lastSeen: now,
      });
    } else if (channel === OFFERS && m.kind === 'cancel') {
      if (this.offers.get(m.body.offerId)?.from === m.from) this.offers.delete(m.body.offerId);
    } else if (channel.startsWith('intercom-dex:t:') && m.kind === 'take') {
      this.takeQueue = this.takeQueue.then(() => this.wallets ? this.wallets.exclusive(() => this.#onTake(channel, m)) : this.#onTake(channel, m))
        .catch(e => this.log('take refused', e.message));
      await this.takeQueue;
    }
  }

  // Maker admission is serialized: capacity is reserved before the next take is considered.
  async #onTake(channel, m) {
    const offer = this.mine.get(m.body.offerId), known = offer ?? this.store.get(`offer-${m.body.offerId}`)?.offer;
    const now = nowSec(), reg = this.registry.snapshot(m.body.registryVersion);
    if (channel !== tradeChannel(m.body.offerId) || !known) return;
    const decline = reason => this.#decline(channel, m, reason);
    if (m.from !== m.body.taker.dexKey || m.from === this.me.dexKey) return;
    if (!offer || offer.expiresAt <= now) return decline('expired');
    if (!this.registry.usable) return;
    if (!reg || m.body.pair !== offer.pair || m.body.registryVersion !== offer.registryVersion) return decline('invalid');
    let pair;
    try { pair = this.#newPair(offer.pair, offer.registryVersion, m.body.software); }
    catch (e) { return e.message === 'update required' ? decline('version') : undefined; }
    const trades = [...this.host.trades.values()];
    const duplicate = trades.find(t => t.state.mode === 'maker' && t.state.offerId === offer.offerId && t.state.peer === m.from &&
      t.raw.some(x => x.kind === 'take' && x.body.commitment === m.body.commitment));
    if (duplicate) {
      if (isFinished(duplicate)) return decline('expired');
      for (const envelope of duplicate.outbox[channel] ?? []) this.host.sendEnvelope(duplicate, channel, envelope).catch(e => this.log('send failed', envelope.kind, e.message));
      return;
    }
    if (trades.filter(t => t.state.mode === 'maker' && t.state.offerId === offer.offerId && beforeLock(t)).length >= MAX_TRADES_PER_OFFER) return decline('busy');
    if (trades.filter(t => t.state.mode === 'maker' && t.state.peer === m.from && beforeLock(t)).length >= MAX_NEGOTIATIONS_PER_TAKER) return decline('busy');
    const amount = BigInt(m.body.baseAmount);
    const p = reg.params;
    // A take below the pair's smallest trade gets a clear answer instead of silence.
    if (amount < BigInt(pair.minBaseAmount)) return decline('invalid');
    if (m.body.sendBy <= now || Math.abs(m.body.sendBy - (m.ts + p.sendWindowSec)) > 120 ||
        m.body.refundAfter - m.body.sendBy !== p.refundSec - p.sendWindowSec) return decline('invalid');
    if (amount > this.#inventory(offer).available) return decline('insufficient');
    if (this.wallets) {
      // A maker whose clock is off starts no trade; the taker may try again later.
      try { await this.wallets.checkClock(); } catch (e) { this.log('take refused', e.message); return decline('busy'); }
    }
    const quote = quoteAmount(pair, m.body.baseAmount, offer.price), exclude = [this.me.dexKey, m.from];
    if (this.#eligible(quote, offer.pair, reg, exclude).length < p.n ||
        this.eligibleOnline(quote, offer.pair).filter(s => !exclude.includes(s.dexKey)).length < p.k + 1) return decline('signers');
    const draft = buildDraft({ offer, baseAmount: m.body.baseAmount, maker: this.me, taker: m.body.taker, registry: reg,
      sendBy: m.body.sendBy, refundAfter: m.body.refundAfter, mint: this.mint, platformCollector: this.platformCollector });
    if (this.profile) checkProfileTerms(draft, this.profile);
    const role = offer.side === 'sell' ? 'seller' : 'buyer';
    const create = role === 'seller' ? createSeller : createBuyer;
    const state = create({ mode: 'maker', offerId: offer.offerId, terms: draft, registry: reg, nonce: random32(), entropy: random32(), now });
    const key = `${offer.offerId}-${sha256Hex(m.from + m.body.commitment)}`;
    await this.host.addTrade({ key, role, state, lifetimeSec: p.refundSec + 3600 });
    // The durable reservation is installed. Network sends run on this trade's queue, outside admission and the wallet lock.
    this.host.deliver(key, { type: 'tick' });
    this.host.inject(key, m);
  }

  // Whether the venue's last full book lists this own offer: false when a book heard LISTED_AFTER_SEC after the offer
  // was announced leaves it out (the venue does that while the wallet cannot fund the smallest trade), null when
  // that is not known yet, the list is cut at 200 offers, or trades in progress hold part of the offer.
  #listed(o, inv) {
    const at = this.bookView.listedAt.get(o.pair), ids = this.bookView.listed.get(o.pair), posted = this.offers.get(o.offerId)?.firstSeen;
    if (at == null || posted == null || at < posted + LISTED_AFTER_SEC || ids.size >= 200 || inv.reserved > 0n || inv.available <= 0n) return null;
    if (this.bookView.inventory.get(o.pair)?.registryVersion !== o.registryVersion) return null;
    return ids.has(o.offerId);
  }

  makeOffer(input) {
    return this.wallets ? this.wallets.exclusive(() => this.#makeOffer(input)) : this.#makeOffer(input);
  }

  async #makeOffer({ pair, side, baseAmount, price, ttlSec = 3600 }) {
    if (!Number.isSafeInteger(ttlSec) || ttlSec < 60 || ttlSec > 30 * 86400) throw new Error('ttlSec must be 60 s to 30 days');
    const reg = this.registry.usable;
    const entry = this.#newPair(pair, reg?.version);
    if (BigInt(baseAmount) < BigInt(entry.minBaseAmount)) throw new Error('Amount below pair minimum');
    const { info } = await this.bridge.info();
    const offer = { registryVersion: reg.version, software: SOFTWARE, pair, side, baseAmount: String(baseAmount), price: String(price), maker: this.me,
      peerKey: info.swarmPublicKey, expiresAt: nowSec() + ttlSec };
    while (this.mine.has(offerIdOf(offer)) || this.store.get(`offer-${offerIdOf(offer)}`)) offer.expiresAt++;
    offer.offerId = offerIdOf(offer);
    parseBody('offer', offer);
    if (this.wallets) await this.wallets.requireFunds({ role: side === 'sell' ? 'seller' : 'buyer', base: entry.base,
      baseAmount, quoteAmount: quoteAmount(entry, baseAmount, price), fees: { platformFeeBps: reg.fee.platformFeeBps, tradeFeeBps: reg.fee.tradeFeeBps } });
    this.store.put(`offer-${offer.offerId}`, { offer, cancelled: false });
    this.mine.set(offer.offerId, offer);
    await this.bridge.join(tradeChannel(offer.offerId));
    await this.host.sendPublic(OFFERS, 'offer', offer);
    this.offers.set(offer.offerId, { offer, from: this.identity.publicKey, firstSeen: nowSec(), lastSeen: nowSec() });
    return offer;
  }

  async cancelOffer(offerId) {
    const offer = this.mine.get(offerId);
    if (!offer) throw new Error('Not my offer');
    this.store.put(`offer-${offerId}`, { offer, cancelled: true });
    this.mine.delete(offerId); this.offers.delete(offerId);
    // The cancel stands once stored. A failed announce is repeated in the background (until then peers keep the offer
    // up to 300 s and their takes of it are declined as expired), so the caller is never told it failed.
    try { await this.host.sendPublic(OFFERS, 'cancel', { offerId }); }
    catch { this.#announceCancel(offerId, CANCEL_RETRIES); }
    return { offerId, cancelled: true };
  }

  #announceCancel(offerId, left) {
    const timer = setTimeout(() => this.host.sendPublic(OFFERS, 'cancel', { offerId })
      .catch(() => { if (left > 1) this.#announceCancel(offerId, left - 1); }), CANCEL_RETRY_MS);
    timer.unref?.();
  }

  // Own offers that are not cancelled, expired or filled come back after a restart.
  async #restoreOffers() {
    const now = nowSec();
    for (const name of this.store.list('offer-')) {
      const rec = this.store.get(name);
      if (!rec?.offer || rec.cancelled || rec.offer.expiresAt <= now || rec.offer.maker.dexKey !== this.identity.publicKey) continue;
      if (rec.offer.offerId !== offerIdOf(rec.offer) || this.#inventory(rec.offer).filled >= BigInt(rec.offer.baseAmount)) continue;
      this.mine.set(rec.offer.offerId, rec.offer);
      this.offers.set(rec.offer.offerId, { offer: rec.offer, from: this.identity.publicKey, firstSeen: now, lastSeen: now });
      await this.bridge.join(tradeChannel(rec.offer.offerId));
      this.log('offer restored', rec.offer.offerId.slice(0, 12));
    }
  }

  // Sizes of an own offer, derived from this maker's trades on it (trades are persisted, so this survives restarts):
  // a trade holds its amount while it runs, keeps it once it completed (or the seller's tokens may have left), and
  // gives it back when it ended before any funds moved (aborted) or the buyer was refunded.
  #inventory(offer) {
    let reserved = 0n, filled = 0n;
    for (const t of this.host.trades.values()) {
      const s = t.state;
      if (s.offerId !== offer.offerId || s.mode !== 'maker' || ['aborted', 'refunded'].includes(s.phase)) continue;
      const amount = BigInt(s.terms?.baseAmount ?? s.draft.baseAmount);
      if (isFinished(t)) filled += amount; else reserved += amount;
    }
    return { reserved, filled, available: BigInt(offer.baseAmount) - reserved - filled };
  }

  async #reannounce() {
    const now = nowSec();
    for (const [id, offer] of this.mine) {
      const inv = this.#inventory(offer);
      if (offer.expiresAt <= now || inv.filled >= BigInt(offer.baseAmount)) { this.mine.delete(id); continue; }
      try { this.#newPair(offer.pair, offer.registryVersion, offer.software); } catch { continue; }
      if (inv.available > 0n) {
        await this.host.sendPublic(OFFERS, 'offer', offer);
        this.offers.set(id, { offer, from: this.identity.publicKey, firstSeen: this.offers.get(id)?.firstSeen ?? now, lastSeen: nowSec() });
      }
    }
  }

  pruneOffers(now = nowSec()) {
    for (const [id, seen] of this.offers) if (!freshOffer(seen, now)) this.offers.delete(id);
  }

  availableOffer(offerId, now = nowSec()) {
    const seen = this.offers.get(offerId);
    if (!freshOffer(seen, now)) { this.offers.delete(offerId); return null; }
    if (seen.offer.maker.dexKey === this.me.dexKey) return null;
    const pair = seen.offer.pair;
    return availableOffer(seen, this.book.get(pair), this.bookView.inventory.get(pair) ?? this.book.get(pair), now, this.bookView.heard.get(pair));
  }

  // Taker side. `price` is the price the caller saw; the take only starts when the offer has exactly that price.
  takeOffer(offerId, baseAmount, price) {
    return this.wallets ? this.wallets.exclusive(() => this.#takeOffer(offerId, baseAmount, price)) : this.#takeOffer(offerId, baseAmount, price);
  }

  async #takeOffer(offerId, baseAmount, price) {
    const seen = this.offers.get(offerId), reg = seen && this.registry.snapshot(seen.offer.registryVersion), now = nowSec();
    if (!seen) throw new Error(STALE_OFFER_MESSAGE);
    if (seen.offer.maker.dexKey === this.identity.publicKey) throw new Error('Own offer');
    const offer = this.availableOffer(offerId, now);
    if (!offer) throw new Error(STALE_OFFER_MESSAGE);
    if (!reg) throw new Error(this.registry.conflict ? 'The venue published two different registries; trading is paused' : 'No registry yet');
    const amount = String(baseAmount ?? offer.baseAmount);
    const pair = this.#newPair(offer.pair, offer.registryVersion, offer.software);
    if (price === undefined || String(price) !== offer.price) throw new Error(`Offer price is ${offer.price}, not ${price}`);
    if (offer.expiresAt <= now + 60) throw new Error('Offer expires too soon');
    if (!/^[1-9][0-9]*$/.test(amount) || BigInt(amount) > BigInt(offer.baseAmount)) throw new Error('Amount must be 1 to the offer size in base units');
    const quote = quoteAmount(pair, amount, offer.price), exclude = [this.me.dexKey, offer.maker.dexKey];
    if (this.#eligible(quote, offer.pair, reg, exclude).length < reg.params.n ||
        this.eligibleOnline(quote, offer.pair).filter(s => !exclude.includes(s.dexKey)).length < reg.params.k + 1) throw new Error('Not enough signers online');
    const draft = buildDraft({ offer, baseAmount: amount, maker: offer.maker, taker: this.me, registry: reg,
      sendBy: now + reg.params.sendWindowSec, refundAfter: now + reg.params.refundSec, mint: this.mint, platformCollector: this.platformCollector });
    if (this.profile) checkProfileTerms(draft, this.profile);
    const role = offer.side === 'sell' ? 'buyer' : 'seller';
    if (this.wallets) await this.wallets.requireFunds({ role, ...draft });
    const current = this.availableOffer(offerId);
    if (!current) throw new Error(STALE_OFFER_MESSAGE);
    if (BigInt(amount) > BigInt(current.baseAmount)) throw new Error('Amount must be 1 to the offer size in base units');
    const create = role === 'seller' ? createSeller : createBuyer;
    const state = create({ mode: 'taker', offerId, terms: draft, registry: reg, nonce: random32(), entropy: random32(), now });
    const key = `${offerId}-${random32()}`;
    await this.host.addTrade({ key, role, state, makerPeer: offer.peerKey, lifetimeSec: reg.params.refundSec + 3600 });
    await this.host.deliver(key, { type: 'tick' });
    return { key, role, offerId, baseAmount: amount, quoteAmount: draft.quoteAmount };
  }

  async #afterStep(trade, before) {
    const s = trade.state;
    // The buyer summons the committee after both signatures, repeating until enough acks arrive.
    if (trade.role === 'buyer' && s.tradeId && s.terms && !['aborted', 'complete', 'refunded'].includes(s.phase)) {
      const sigs = this.#termsSigs(trade);
      const waiting = ['awaitCertificate', 'preparingDeal', 'proving', 'awaitAcks', 'locking'].includes(s.phase);
      if (sigs && waiting && (!trade.summonedAt || nowSec() - trade.summonedAt >= 20) && (s.acks?.length ?? 0) < s.terms.k) {
        trade.summonedAt = nowSec();
        await this.host.sendPublic(SIGNERS, 'summon', { tradeId: s.tradeId, terms: s.terms, sigs });
      }
    }
    // Maker bookkeeping and the settlement report for the service.
    if (s.phase === 'complete' && trade.role === 'seller' && this.#recordReport(trade)) await this.#sendReports();
  }

  // A completed sale's report is kept until the venue logs the trade (its tradeLog): sent every minute for two days,
  // then every half hour. Recorded on completion and, for a completion just before a crash, again at start. The
  // venue takes its proof from the chains; the claim signature is only included when this harness saw it.
  #recordReport(trade) {
    const s = trade.state, now = nowSec();
    if (this.store.get(`report-${s.tradeId}`)) return false;
    const claimSignature = this.#claimSignature(trade);
    this.store.put(`report-${s.tradeId}`, { firstAt: now, lastSentAt: 0, body: { offerId: s.offerId, tradeId: s.tradeId, terms: s.terms,
      hashHex: s.H, txHash: s.txHash, ...(claimSignature ? { claimSignature } : {}) } });
    return true;
  }

  async #sendReports() {
    const now = nowSec();
    for (const t of this.host.trades.values()) {
      if (t.role === 'seller' && t.state.phase === 'complete') try { this.#recordReport(t); } catch (e) { this.log('settlement report', e.message); }
    }
    for (const name of this.store.list('report-')) {
      const r = this.store.get(name);
      if (!r || r.delivered || now - r.lastSentAt < (now - r.firstAt < 2 * 86400 ? 55 : 1800)) continue;
      try {
        if (this.profile) checkProfileTerms(r.body.terms, this.profile);
        await this.host.sendPublic(OFFERS, 'settled', r.body);
        this.store.put(name, { ...r, lastSentAt: now });
      } catch (e) { this.log('settlement report', name.slice(7, 19), e.message); }
    }
  }

  #termsSigs(trade) {
    const s = trade.state;
    const own = (trade.outbox[tradeChannel(s.tradeId)] ?? []).find(e => e.kind === 'termsSig');
    const peer = trade.raw.find(m => m.kind === 'termsSig' && m.from === s.peer && m.body.tradeId === s.tradeId);
    return own && peer && termsTradeId(s.terms) === s.tradeId ? [own, peer] : null;
  }

  #claimSignature(trade) {
    const sent = (trade.outbox[tradeChannel(trade.state.tradeId)] ?? []).find(e => e.kind === 'claimed');
    return sent?.body.claimSignature;
  }

  #marketMessage(body, current = true) {
    try {
      registryPair(this.registry.snapshot(body.registryVersion), body.pair);
      if (current) registryPair(this.registry.usable, body.pair);
      if (body.offers?.some(o => o.pair !== body.pair || o.registryVersion !== body.registryVersion)) return false;
      return true;
    } catch { return false; }
  }

  readChat(since) { return this.chat.read(since); }

  async sayChat(input) {
    const body = { ...chatInputSchema.parse(input), ts: nowSec() };
    const envelope = seal({ kind: 'chat', ch: CHAT_CHANNEL, body }, this.identity.secretKey, { ts: body.ts, nonce: random32() });
    // Reserve before awaiting transport: concurrent sends and our network echo share the same limits.
    const record = this.chat.receive(envelope);
    if (!record) throw new Error('Wait a few seconds before the next message');
    await this.bridge.send(CHAT_CHANNEL, envelope);
    return record;
  }

  status() {
    this.pruneOffers();
    return {
      software: SOFTWARE, updateRequired: !!this.registry.usable && !meetsVersion(SOFTWARE, this.registry.usable.minSoftware),
      message: this.registry.usable && !meetsVersion(SOFTWARE, this.registry.usable.minSoftware) ? 'update required' : '',
      pairs: pairStatus(this.registry.usable), serviceStatus: this.serviceStatus ?? null,
      me: this.me, registryVersion: this.registry.current?.version ?? null, registryConflict: this.registry.conflict,
      signersOnline: this.onlineSigners(), certificatesReady: this.certificates.available().length,
      // lastSeen: when this program last heard the maker announce the offer (Unix seconds); makers announce every 45 s.
      offers: [...this.offers.keys()].map(id => { const o = this.availableOffer(id); return o && { ...o, lastSeen: this.offers.get(id).lastSeen }; }).filter(Boolean),
      mine: [...this.mine.values()].map(o => { const inv = this.#inventory(o);
        return { ...o, available: inv.available.toString(), reserved: inv.reserved.toString(), filled: inv.filled.toString(), listed: this.#listed(o, inv) }; }),
      trades: [...this.host.trades.values()].map(t => ({ key: t.key, role: t.role, phase: t.state.phase, reason: t.state.reason ?? null,
        tradeId: t.state.tradeId, H: t.state.H ?? null, committee: t.state.terms?.committee.map(c => c.dexKey) ?? [],
        pair: t.state.draft?.pair, baseAmount: t.state.draft?.baseAmount, quoteAmount: t.state.draft?.quoteAmount })),
      book: Object.fromEntries(this.book), tickers: Object.fromEntries(this.tickers), chat: this.readChat(),
    };
  }
}
