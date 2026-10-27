import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { hexKey, chatInputSchema, chatSinceSchema } from '../core/schemas.js';
import { seal } from '../core/envelope.js';
import { sha256Hex, stableJSON } from '../core/canonical.js';
import { tradeId } from '../core/terms.js';
import { SOFTWARE, meetsVersion } from '../core/software.js';
import { addressProofRequired } from '../core/address-proof.js';
import { RegistryView, publicReceiver, nowSec, random32, checkTermsAgainstRegistry } from './common.js';
import { checkProfileTerms } from '../net/profile-core.js';
import { RegistryRelays } from '../net/relays.js';
import { registryPair } from '../market/assets.js';
import { BookView } from '../market/book-feed.js';
import { CHAT_CHANNEL, MarketChat } from '../market/chat.js';
import { MarketView } from '../market-feed/view.js';
import { TradeHistory } from '../market-feed/history.js';
import { MAIN as LOCKS_MAIN, receiver as locksReceiver, join as joinLocks } from '../locks/transport.js';

const MAIN = 'intercom-dex', OFFERS = 'intercom-dex:offers';
const viewerInput = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$(?![\s\S])/), name: z.string().min(1).max(256), text: z.string() }).strict();

// Public data only. No trade host, proof worker, chain adapter or wallet is constructed.
export class MarketFeed {
  constructor({ bridge, identity, store, serviceKey, profile, locksVenueKey = null, now = nowSec, log = () => {}, history = new TradeHistory() }) {
    hexKey.parse(serviceKey); hexKey.parse(identity.publicKey); if (locksVenueKey !== null) hexKey.parse(locksVenueKey);
    Object.assign(this, { bridge, identity, store, serviceKey, profile, locksVenueKey, now, log, history });
    this.locksReceive = locksReceiver(now); this.locks = null;
    this.registry = new RegistryView(serviceKey, store, log, profile);
    this.relays = new RegistryRelays(bridge);
    this.verify = publicReceiver(now);
    this.market = new MarketView({ store, now, history, addressProof: () => ({
      networkId: this.profile?.peer?.msbNetworkId, now: this.now(), required: addressProofRequired(this.registry.usable) }) });
    this.books = new BookView();
    this.chat = new MarketChat({ now, chatRelays: profile?.chatRelays ?? [] });
    this.epoch = randomBytes(8).toString('hex'); this.seq = 0; this.messages = [];
    this.viewerIds = new Map(store.get('market-feed-viewer-ids') ?? []);
    this.queue = Promise.resolve();
    this.listener = (channel, raw) => {
      this.queue = this.queue.then(() => this.receive(channel, raw)).catch(() => log('market-feed message rejected'));
    };
  }

  async start() {
    if (this.started) return;
    this.started = true; this.bridge.on('message', this.listener);
    try {
      await this.relays.update(this.registry.usable);
      for (const channel of [MAIN, OFFERS, CHAT_CHANNEL]) await this.bridge.join(channel);
      if (this.locksVenueKey) await joinLocks(this.bridge, LOCKS_MAIN);
      this.timer = setInterval(() => { try { this.view(); } catch { this.log('market-feed refresh failed'); } }, 1000);
    } catch (error) { this.stop(); throw error; }
  }

  stop() { clearInterval(this.timer); this.bridge.off('message', this.listener); this.started = false; }

  #pair(body, current = true) {
    const snapshot = this.registry.snapshot(body.registryVersion), registry = this.registry.usable;
    if (!registry || !snapshot || !meetsVersion(SOFTWARE, registry.minSoftware) || !meetsVersion(SOFTWARE, snapshot.minSoftware)) throw new Error('No usable registry');
    if (current) registryPair(registry, body.pair);
    const pair = registryPair(snapshot, body.pair, { open: current });
    if (body.software && (!meetsVersion(body.software, registry.minSoftware) || !meetsVersion(body.software, snapshot.minSoftware))) throw new Error('Unsupported offer software');
    return pair;
  }

  async receive(channel, raw) {
    if (raw?.ch !== channel) return false;
    if (channel === LOCKS_MAIN) return this.#locks(raw);
    if (channel === CHAT_CHANNEL) {
      const record = this.chat.receive(raw);
      if (!record) return false;
      this.#line(record); return true;
    }
    if (![MAIN, OFFERS].includes(channel) || channel === MAIN && raw.from !== this.serviceKey) return false;
    const m = this.verify(raw);
    if (!m) return false;
    try {
      if (channel === MAIN && m.kind === 'registry') {
        const accepted = this.registry.offer(m, this.now());
        await this.relays.update(this.registry.usable); this.view(); return accepted;
      }
      let changed = false;
      if (channel === MAIN && m.kind === 'status') changed = this.market.status(m.body);
      else if (channel === MAIN && ['book', 'ticker', 'tradeLog'].includes(m.kind)) {
        this.#pair(m.body, m.kind !== 'tradeLog');
        if (m.body.ts > this.now()) return false;
        if (m.kind === 'book') {
          if (this.books.full(m.body)) changed = this.market.book(m.body);
        } else if (m.kind === 'ticker') changed = this.market.ticker(m.body);
        else changed = this.market.trade(m.body);
      } else if (channel === MAIN && m.kind === 'bookDelta') {
        const base = this.books.books.get(m.body.pair);
        if (!base || m.ts > this.now()) return false;
        this.#pair(base);
        if (this.books.delta(m.body, m.ts)) changed = this.market.book(this.books.books.get(m.body.pair));
      } else if (channel === OFFERS && m.kind === 'offer') {
        const pair = this.#pair(m.body);
        if (BigInt(m.body.baseAmount) < BigInt(pair.minBaseAmount)) return false;
        changed = this.market.offer(m.body, m.from);
      } else if (channel === OFFERS && m.kind === 'cancel') changed = this.market.cancel(m.body, m.from);
      else if (channel === OFFERS && m.kind === 'settled') {
        const t = m.body.terms;
        this.#pair(t, false);
        if (t.seller.dexKey !== m.from || tradeId(t) !== m.body.tradeId || t.offerId !== m.body.offerId) return false;
        checkTermsAgainstRegistry(t, this.registry.snapshot(t.registryVersion));
        if (this.profile) checkProfileTerms(t, this.profile);
        changed = this.market.settlement(m.body);
      }
      if (changed) this.view();
      return changed;
    } catch { return false; }
  }

  view() { return this.market.snapshot(this.registry.usable); }

  // The lock venue's newest signed summary, served as it came (Market World's loans and options).
  #locks(raw) {
    if (!this.locksVenueKey || raw.from !== this.locksVenueKey || raw.kind !== 'summary') return false;
    const m = this.locksReceive(raw);
    if (!m || m.body.ts > this.now() + 60 || this.locks && m.body.ts <= this.locks.ts) return false;
    const json = JSON.stringify({ v: 1, ...m.body });
    this.locks = { ts: m.body.ts, json, etag: '"' + createHash('sha256').update(json).digest('hex') + '"' };
    return true;
  }

  locksView() { return this.locks; }

  historyPair(pair) { return registryPair(this.registry.usable, pair, { open: false }); }

  readCandles(query) { this.historyPair(query.pair); return this.history.candles(query); }

  readTrades(query) { return this.history.trades({ ...query, decimals: this.historyPair(query.pair).base.decimals }); }

  #line(record) {
    const viewer = record.viewer || record.from === this.identity.publicKey;
    const line = { seq: ++this.seq, kind: viewer ? 'viewer' : 'agent', from: record.from,
      ...(viewer ? { name: record.name ?? 'Viewer' } : {}), text: record.text, ts: record.ts };
    this.messages.push(line);
    if (this.messages.length > 100) this.messages.shift();
    return line.seq;
  }

  readChat(after = null) {
    if (after !== null) chatSinceSchema.parse(after);
    if (after > this.seq) after = null;
    const wanted = after === null ? this.messages.slice(-20) : this.messages.filter(m => m.seq > after);
    const page = wanted.map(({ from, ...message }) => ({ ...message,
      ...(message.kind === 'agent' ? { addr: this.market.address(from) } : {}) }));
    const next = page.at(-1)?.seq ?? after ?? this.seq;
    const result = { ok: true, epoch: this.epoch, now: this.now(), next, oldest: this.messages[0]?.seq ?? this.seq + 1,
      more: after !== null && this.messages.some(m => m.seq > next), messages: page };
    while (Buffer.byteLength(JSON.stringify(result)) > 60000 && page.length) {
      page.shift(); result.more = true;
    }
    return result;
  }

  async postViewer(input) {
    const parsed = viewerInput.parse(input);
    const name = parsed.name.replace(/[^A-Za-z0-9 ._-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24).trim() || 'Viewer';
    const body = { ...chatInputSchema.parse({ text: parsed.text, name }), ts: this.now() };
    const id = sha256Hex(parsed.id), fingerprint = sha256Hex(stableJSON({ name: body.name, text: body.text }));
    for (const [key, row] of this.viewerIds) if (row.at <= this.now() - 86400) this.viewerIds.delete(key);
    const previous = this.viewerIds.get(id);
    if (previous) return previous.fingerprint === fingerprint ? { ok: true, duplicate: true } : { ok: false, error: 'id_conflict' };
    if (!this.chat.relays.has(this.identity.publicKey)) return { ok: false, error: 'relay_not_configured' };
    if (this.viewerIds.size >= 10000) return { ok: false, error: 'capacity' };
    const envelope = seal({ kind: 'chat', ch: CHAT_CHANNEL, body }, this.identity.secretKey, { ts: body.ts, nonce: random32() });
    const record = this.chat.receive(envelope);
    if (!record) return { ok: false, error: 'slow_down' };
    // Persist the reservation before transport: an ambiguous send must never cause a second publication.
    const reservation = { at: this.now(), fingerprint };
    this.viewerIds.set(id, reservation);
    try { this.store.put('market-feed-viewer-ids', [...this.viewerIds]); }
    catch (error) { this.viewerIds.delete(id); throw error; }
    const seq = this.#line(record);
    try { await this.bridge.send(CHAT_CHANNEL, envelope); }
    catch { return { ok: false, error: 'transport' }; }
    return { ok: true, seq };
  }
}
