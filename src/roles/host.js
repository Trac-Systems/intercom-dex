import { randomBytes } from 'node:crypto';
import { seal, open, createReplayCache } from '../core/envelope.js';
import { step as buyerStep, ackRejectionReason } from '../core/trade-buyer.js';
import { verifiedMessage } from '../core/trade-common.js';
import { stepFinalized as sellerStep } from '../core/trade-seller.js';
import { sendFinalTransfer } from '../trac/finality.js';
import { step as signerStep } from '../core/trade-signer.js';
import { RANDOMNESS, STEP_BUDGET_MS } from '../core/terms.js';
import { sha256Hex, hexToBytes } from '../core/canonical.js';
import { proveLock, verifyLock } from '../proof/lockproof.js';
import { checkProfileRegistry, checkProfileTerms } from '../net/profile.js';

const STEPS = { buyer: buyerStep, seller: sellerStep, signer: signerStep };
const ANY = '*';
const NEEDS_CHAIN = new Set(['take', 'accept', 'reveal']);
// Which message kinds each role's state machine takes in which phase. Anything else waits in the trade's buffer
// (protocol order is the runner's job; the state machines abort on out-of-order input).
const NEGOTIATION = { take: ['awaitTake'], accept: ['awaitAccept'], decline: ['awaitAccept'], reveal: ['awaitReveal'], terms: ['awaitTerms'], termsSig: ['awaitTermsSig'] };
const ACCEPTS = {
  buyer: { ...NEGOTIATION, transferSent: ['locking', 'locked'], ack: ['awaitAcks', 'locking', 'locked'],
    sharePublish: ['locking', 'locked'], claimed: ['locked'], abort: ANY },
  seller: { ...NEGOTIATION, deal: ['awaitDeal'], working: ['awaitDeal'],
    ack: ['awaitReady', 'transferring', 'awaitShares', 'claiming'], sharePublish: ['awaitShares', 'claiming', 'complete'], abort: ANY },
  signer: { termsSig: ['awaitTermsSignatures'], deal: ['awaitDeal'], working: ['awaitDeal'],
    transferSent: ['holding'], ack: ANY, sharePublish: ANY, claimed: ANY, refunded: ANY, abort: ANY },
};
const DONE = { buyer: ['complete', 'refunded'], seller: ['complete', 'aborted', 'lost'], signer: ['published', 'expired', 'aborted'] };
export const tradeChannel = ref => `intercom-dex:t:${ref}`;
// Signed trade evidence a committee signer passes on over the signers channel.
export const FORWARDED = ['deal', 'working', 'transferSent'];
const MAX_PER_SENDER = 400;
// A published signer repeats its share on its own at 10, 20, 40 ... 640 seconds and then only answers requests: every
// repeat costs a fresh work stamp, and a seller that still misses shares asks for them (shareRequest) every 30 s.
export const PUBLICATION_LAST_DELAY_SEC = 640;
// Randomness lookups 2 s apart, enough to cover the whole randomness step.
const RANDOMNESS_LOOKUPS = STEP_BUDGET_MS.randomness / 2000;
export const REVEAL_RESEND_SEC = 2;
// What one sender may have waiting in a trade's buffer: a flood from one member never pushes out another's messages.
const BUFFER_PER_SENDER = 100, BUFFER_BYTES_PER_SENDER = 4_000_000;
const sizes = new WeakMap();
const byteSize = m => {
  if (!sizes.has(m)) sizes.set(m, Buffer.byteLength(JSON.stringify(m.body)));
  return sizes.get(m);
};

// The senders allowed to send `kind` into this trade. Unknown kinds and everyone else are dropped unseen.
function senders(trade, kind) {
  const s = trade.state, t = s.terms ?? s.draft;
  const buyer = t.buyer.dexKey, seller = t.seller.dexKey, committee = (s.terms?.committee ?? []).map(c => c.dexKey);
  const traders = [buyer, seller];
  if (trade.role === 'signer') {
    return { termsSig: traders, abort: traders, deal: [buyer], working: [buyer], refunded: [buyer],
      transferSent: [seller], claimed: [seller], ack: committee, sharePublish: committee, present: [...traders, ...committee], shareRequest: [seller, trade.serviceKey] }[kind] ?? [];
  }
  const peer = [s.peer];
  return { take: peer, accept: peer, decline: peer, reveal: peer, terms: peer, termsSig: peer, abort: peer, deal: [buyer], working: [buyer],
    refunded: [buyer], transferSent: [seller], claimed: [seller], ack: committee, sharePublish: committee,
    present: [...peer, ...committee] }[kind]?.filter(k => k !== s.self) ?? [];
}

export function isFinished(trade) {
  const s = trade.state;
  if (trade.role === 'buyer') return DONE.buyer.includes(s.phase) || (s.phase === 'aborted' && !s.locked);
  return DONE[trade.role].includes(s.phase);
}

const NEGOTIATING = new Set(['new', 'awaitTake', 'awaitAccept', 'awaitReveal']);
const FINISHED = new Set(['complete', 'aborted', 'refunded', 'lost']);

// Runs trades for one identity: verifies and routes channel messages, buffers out-of-order input, re-sends its own
// messages to members who announce themselves late, and carries out the state machines' actions.
export class TradeHost {
  constructor({ bridge, identity, store, solana, trac, proof, profile, certificatePool, onlineSigners, eligibleOnline,
    serviceKey, log = () => {}, now = () => Math.floor(Date.now() / 1000), tickMs = 1000, keepChannel = () => false }) {
    // keepChannel(ch): a channel the owner of this host still needs after its trades there ended (a maker's open offer).
    Object.assign(this, { bridge, identity, store, solana, trac, proof, profile, certificatePool, onlineSigners, eligibleOnline, serviceKey, log, now, tickMs, keepChannel });
    this.trades = new Map();
    this.byChannel = new Map();
    this.joined = new Set();
    this.makerPins = new Map();
    this.stopped = false;
    this.slot = null;
    this.hooks = { afterStep: [], unrouted: [] };
  }

  async start() {
    this.stopped = false;
    this.bridge.on('message', (channel, message) => { this.#route(channel, message).catch(e => this.log('route error', e.message)); });
    // Pushed slots keep the chain view fresh without requests; polling remains for when no pushed view is fresh.
    this.watch = this.solana?.chainWatch?.({ onUpdate: () => this.#fromWatch() }) ?? null;
    this.watch?.start();
    if (this.solana) await this.#refreshSlot();
    this.timer = setInterval(() => this.#tickAll(), this.tickMs);
    this.slotTimer = this.solana ? setInterval(() => this.#needsChain() && !this.#watchFresh() ? this.#refreshSlot().catch(() => {}) : null, 2000) : null;
    for (const name of this.store.list('trade-')) {
      const record = this.store.get(name);
      if (record) await this.#install(record, { resume: true });
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer); clearInterval(this.slotTimer);
    this.watch?.stop();
    this.#releaseMakerPins();
  }

  // The chain view negotiation needs: the latest finalized slot and the tip. Messages that need it wait in the
  // buffer while it is stale and are applied once it is fresh again (they are never consumed against a stale view).
  // Each reading is dated when its request started (its age includes all waiting), and a slower older request never
  // replaces a newer reading.
  async #refreshSlot() {
    if (this.#fromWatch()) return;
    const started = performance.now();
    await Promise.allSettled([
      this.solana.finalizedSlot().then(v => { if (started >= (this.slotAt ?? -1)) { this.slot = v; this.slotAt = started; } }),
      this.solana.tipSlot().then(v => { if (started >= (this.tipAt ?? -1)) { this.tip = v; this.tipAt = started; } }),
    ]);
    if (this.#chainFresh()) for (const trade of this.trades.values()) if (trade.buffer.length) this.#enqueue(trade, () => this.#drain(trade));
  }

  #watchFresh() {
    return this.watch?.view(Math.min(RANDOMNESS.TIP_MAX_AGE_MS, RANDOMNESS.FINALIZED_MAX_AGE_MS) / 2) != null;
  }

  // Takes a fresh pushed view (newer readings only) and applies waiting messages at once; true when it was fresh.
  #fromWatch() {
    const v = this.watch?.view(Math.min(RANDOMNESS.TIP_MAX_AGE_MS, RANDOMNESS.FINALIZED_MAX_AGE_MS) / 2);
    if (!v) return false;
    if (!this.watchSeen) { this.watchSeen = true; this.log('chain view from pushed slots'); }
    const wasFresh = this.#chainFresh();
    if (v.at >= (this.slotAt ?? -1)) { this.slot = v.finalized; this.slotAt = v.at; }
    if (v.at >= (this.tipAt ?? -1)) { this.tip = v.tip; this.tipAt = v.at; }
    // Messages arriving while the view is fresh are applied on arrival; only a view that just became fresh drains here.
    if (!wasFresh && this.#chainFresh()) for (const trade of this.trades.values()) if (trade.buffer.length) this.#enqueue(trade, () => this.#drain(trade));
    return true;
  }

  // Only a negotiation, or a message waiting for a fresh view, needs the chain view. An idle trader doesn't poll
  // Solana, which keeps it under the public RPC servers' rate limits.
  #needsChain() {
    for (const trade of this.trades.values()) {
      if (FINISHED.has(trade.state.phase)) continue;
      if (trade.buffer.length || NEGOTIATING.has(trade.state.phase)) return true;
    }
    return false;
  }

  #chainFresh() {
    const now = performance.now();
    return this.slotAt != null && now - this.slotAt < RANDOMNESS.FINALIZED_MAX_AGE_MS && this.tipAt != null && now - this.tipAt < RANDOMNESS.TIP_MAX_AGE_MS;
  }

  // `trade` = {key, role, state, lifetimeSec}. Channels and the senders allowed per message kind follow from the state.
  async addTrade(trade) { await this.#install({ ...trade, outbox: {}, raw: [], buffer: [] }, { resume: false }); }

  async #install(record, { resume }) {
    this.#checkState(record.state);
    const trade = { ...record, serviceKey: this.serviceKey, seen: createReplayCache({ maxEntries: 8192 }), queue: Promise.resolve(), busy: new Set(),
      lastResend: new Map(), perSender: new Map(), presentSent: [], budgetAt: performance.now(), makerConnectedAt: null };
    if (resume) { trade.state.stepElapsedMs = 0; trade.state.connectedAtMs = null; }
    this.trades.set(trade.key, trade);
    this.#save(trade);
    // A finished trade (a signer's once it no longer serves) needs no channel: a restart that joined every stored trade's
    // channel at once (hundreds of topics) held the heartbeats back for minutes, and traders kept them for the whole uptime.
    if (this.#idle(trade)) {
      trade.channelsLeft = true;
      if (resume) this.log('resumed', trade.key, trade.role, trade.state.phase);
      return;
    }
    // A published signer past its repeat schedule only answers share requests: a restart re-publishes nothing for it
    // (re-publishing every recent trade at once queued hundreds of work stamps ahead of the heartbeats).
    if (this.#serving(trade) && trade.sellerClaimed) {
      trade.channelsLeft = true;
      if (resume) this.log('resumed', trade.key, trade.role, trade.state.phase);
      return;
    }
    const quiet = this.#serving(trade) && ((trade.publicationDelay ?? 10) > PUBLICATION_LAST_DELAY_SEC ||
      this.now() - (trade.publicationAt ?? 0) >= 2 * PUBLICATION_LAST_DELAY_SEC);
    this.#joinChannels(trade, { announce: !quiet }).then(() => quiet ? null : this.#presence(trade)).catch(e => this.log('join', e.message));
    if (resume) {
      // Re-issue whatever was outstanding when the process stopped (the state machines know which actions).
      this.log('resumed', trade.key, trade.role, trade.state.phase);
      if (!quiet && (!isFinished(trade) || this.#serving(trade))) this.deliver(trade.key, { type: 'resume' });
    }
  }

  #checkState(state) {
    if (!this.profile) return;
    for (const terms of [state.draft, state.terms]) if (terms) checkProfileTerms(terms, this.profile);
    if (state.registry) checkProfileRegistry(state.registry, this.profile);
  }

  #channels(trade) {
    const s = trade.state, refs = [];
    if (s.offerId && s.role !== 'signer') refs.push(s.offerId);
    if (s.tradeId) refs.push(s.tradeId);
    return refs.map(tradeChannel);
  }

  async #joinChannels(trade, { announce = true } = {}) {
    for (const ch of this.#channels(trade)) {
      if (!this.byChannel.has(ch)) this.byChannel.set(ch, new Set());
      this.byChannel.get(ch).add(trade.key);
      const makerPeer = !this.stopped && !isFinished(trade) && trade.state.mode === 'taker' && ch === tradeChannel(trade.state.offerId) ? trade.makerPeer : undefined;
      if (!this.joined.has(ch) || (makerPeer && !this.makerPins.has(ch))) {
        const pin = makerPeer && !this.makerPins.has(ch) ? { peerKey: makerPeer } : null;
        if (pin) this.makerPins.set(ch, pin);
        try {
          await this.bridge.join(ch, makerPeer);
          this.joined.add(ch);
        } catch (error) {
          if (pin && this.makerPins.get(ch) === pin) this.makerPins.delete(ch);
          throw error;
        }
      }
      const waitingForDeal = trade.role === 'signer' && ['awaitTermsSignatures', 'awaitDeal'].includes(trade.state.phase);
      if (announce && !(waitingForDeal && this.now() >= trade.state.terms.sendBy) && !trade.presentSent.includes(ch)) {
        trade.presentSent.push(ch);
        await this.#send(trade, ch, 'present', { ref: ch.slice('intercom-dex:t:'.length) }, { keep: false });
      }
    }
  }

  #releaseMakerPins() {
    for (const [channel, pin] of this.makerPins) {
      if (!this.stopped && [...this.trades.values()].some(trade => !isFinished(trade) && trade.state.mode === 'taker' &&
          trade.makerPeer === pin.peerKey && tradeChannel(trade.state.offerId) === channel)) continue;
      this.makerPins.delete(channel);
      this.bridge.join(channel, null).catch(error => this.log('maker release', error.message));
    }
  }

  #save(trade) {
    const { seen, queue, busy, lastResend, perSender, presentSent, presentAt, budgetAt, makerConnectedAt, channelsLeft, forwarded, ...record } = trade;
    this.store.put(`trade-${trade.key}`, record);
  }

  #seal(ch, kind, body) {
    return seal({ kind, ch, body }, this.identity.secretKey, { ts: this.now(), nonce: randomBytes(32).toString('hex') });
  }

  // Signers repeat their ack every 10 s until sendBy: each reason is logged once per trade and signer, and only while
  // the buyer still waits for acks (or with DEX_DEBUG).
  #ackNote(trade, what, from, reason, phase = trade.state.phase) {
    if (!process.env.DEX_DEBUG && phase !== 'awaitAcks') return;
    const key = `${what}:${from}:${reason}`;
    trade.ackNotes ??= new Set();
    if (trade.ackNotes.has(key)) return;
    trade.ackNotes.add(key);
    this.log(what, trade.key.slice(0, 12), String(from ?? '').slice(0, 8), reason);
  }

  sendEnvelope(trade, ch, envelope) {
    if (process.env.DEX_DEBUG && ch.startsWith('intercom-dex:t:')) {
      this.log('send', (trade?.key ?? ch.slice('intercom-dex:t:'.length)).slice(0, 12), ch.slice(-8), envelope.kind, envelope.from.slice(0, 8));
    }
    return this.bridge.send(ch, envelope);
  }

  async #send(trade, ch, kind, body, { keep = true } = {}) {
    if (kind === 'take' && trade) {
      const prior = trade.outbox[ch]?.find(e => e.kind === 'take' && e.body.commitment === body.commitment);
      if (prior) {
        try { await this.sendEnvelope(trade, ch, prior); } catch (error) { this.log('send failed', kind, error.message); }
        return prior;
      }
    }
    const envelope = this.#seal(ch, kind, body);
    if (keep && trade) {
      if (kind === 'take') trade.state.takeNonce = envelope.nonce;
      (trade.outbox[ch] ??= []).push(envelope);
      this.#save(trade);
    }
    // A failed send is not lost: the outbox is repeated while the trade waits (and on every 'present').
    try { await this.sendEnvelope(trade, ch, envelope); }
    catch (error) { if (!keep) throw error; this.log('send failed', kind, ch.slice(-8), error.message); }
    return envelope;
  }

  // Public helper for roles: sign and send a message that belongs to no trade.
  sendPublic(ch, kind, body) { return this.#send(null, ch, kind, body, { keep: false }); }
  sealPublic(ch, kind, body) { return this.#seal(ch, kind, body); }

  async #route(channel, message) {
    // Every take reaches the maker's serialized admission queue, including additional takes by the same peer.
    if (message?.kind === 'take' && this.hooks.unrouted.length) {
      for (const hook of this.hooks.unrouted) await hook(channel, message);
      return;
    }
    // A committee signer that got the buyer's dealing on the trade channel passes the signed original on over the
    // signers channel (FORWARDED). The others check it exactly as if it had arrived on the trade channel: the dealing
    // is sent once, often before every signer joined that new channel, and a signer that missed it timed out.
    if (channel === 'intercom-dex:signers' && FORWARDED.includes(message?.kind) && typeof message.ch === 'string') {
      for (const trade of this.trades.values()) {
        if (trade.role === 'signer' && trade.state.tradeId && message.ch === tradeChannel(trade.state.tradeId)) this.#accept(trade, message.ch, message);
      }
      for (const hook of this.hooks.unrouted) await hook(channel, message);
      return;
    }
    if (channel === 'intercom-dex:signers' && ['sharePublish', 'shareRequest'].includes(message?.kind)) {
      for (const trade of this.trades.values()) if (trade.state.tradeId && trade.state.tradeId === message.body?.tradeId) this.#accept(trade, channel, message);
      for (const hook of this.hooks.unrouted) await hook(channel, message);
      return;
    }
    let delivered = false;
    if (message?.kind === 'ack' && !this.byChannel.get(channel)?.size) {
      if (process.env.DEX_DEBUG) this.log('ack rejected', channel.slice(-8), String(message.from ?? '').slice(0, 8), 'no trade on channel');
    }
    for (const key of this.byChannel.get(channel) ?? []) {
      const trade = this.trades.get(key);
      if (trade && this.#accept(trade, channel, message)) delivered = true;
    }
    if (!delivered) for (const hook of this.hooks.unrouted) await hook(channel, message);
  }

  // A role already verified this message (e.g. the take that created the trade): queue it directly.
  inject(key, message) {
    const trade = this.trades.get(key);
    // Record it as seen, so the copies that members re-send later are dropped as replays.
    try { trade.seen.consume(`${message.from}:${message.nonce}`, message.ts + trade.lifetimeSec, this.now()); }
    catch { return trade.queue; }
    trade.raw.push(message); trade.buffer.push(message);
    return this.#enqueue(trade, () => this.#drain(trade));
  }

  // Cheap checks on the unverified fields first (channel, trade, sender allowed for this kind, per-sender cap), so
  // nobody else can spend this trade's replay memory or buffer; then the signature and replay check.
  #accept(trade, channel, message) {
    const reject = reason => {
      if (message?.kind === 'ack') this.#ackNote(trade, 'ack rejected', message.from, reason);
      return false;
    };
    if (!message || typeof message !== 'object' || message.ch !== channel || typeof message.from !== 'string') return reject('channel mismatch or invalid sender');
    if (isFinished(trade) && !this.#serving(trade)) return reject('trade finished');
    const s = trade.state, ref = message.body?.tradeId;
    if (message.kind === 'present' && channel !== tradeChannel(message.body?.ref)) return false;
    if (ref !== undefined && ref !== s.tradeId && !(message.kind === 'abort' && ref === s.offerId)) return reject('wrong trade id');
    if (!senders(trade, message.kind).includes(message.from)) return reject('sender not a committee member or permitted participant');
    const takeCommitment = s.role !== 'signer' && (s.mode === 'taker' ? sha256Hex(hexToBytes(s.nonce, 32)) : s.peerCommit);
    if (['accept', 'reveal'].includes(message.kind) && message.body?.takeCommitment !== takeCommitment) return false;
    if (message.kind === 'decline' && message.body?.takeNonce !== s.takeNonce) return false;
    if (message.kind === 'abort' && message.body?.commitment && message.body.commitment !== takeCommitment) return false;
    const recovery = ['shareRequest', 'present'].includes(message.kind);
    if (message.kind === 'shareRequest' && !this.#serving(trade)) return false;
    const count = trade.perSender.get(message.from) ?? 0;
    if (!recovery && count >= MAX_PER_SENDER) return reject('sender limit reached');
    let m;
    try { m = open(message, { now: this.now(), seen: trade.seen, maxAgeSec: recovery ? 120 : trade.lifetimeSec }); }
    catch (error) {
      if (process.env.DEX_DEBUG && error.code !== 'replay') this.log('reject', channel.slice(-8), message.kind, error.code ?? error.message);
      return reject(error.code ?? error.message);
    }
    if (!recovery) trade.perSender.set(m.from, count + 1);
    // An authenticated message/presence from the maker on this offer channel proves a usable peer path.
    if (s.mode === 'taker' && m.from === s.peer && channel === tradeChannel(s.offerId) && trade.makerConnectedAt == null) trade.makerConnectedAt = performance.now();
    if (process.env.DEX_DEBUG) this.log('recv', trade.key.slice(0, 12), channel.slice(-8), m.kind, m.from.slice(0, 8));
    if (trade.role === 'signer' && FORWARDED.includes(m.kind)) {
      trade.forwarded ??= new Set();
      if (!trade.forwarded.has(message.sig)) {
        trade.forwarded.add(message.sig);
        this.bridge.send('intercom-dex:signers', message).catch(e => this.log('forward', m.kind, e.message));
      }
    }
    if (recovery) { this.#resend(trade, channel, m.from, m.kind === 'shareRequest' ? 30 : 3); return true; }
    // The seller's signed 'claimed' means it holds the USDC and needs no more shares: a published signer stops repeating
    // its share and leaves the trade channel. The venue's share requests keep arriving over the signers channel.
    if (trade.role === 'signer' && m.kind === 'claimed' && !trade.sellerClaimed) { trade.sellerClaimed = true; this.#save(trade); }
    if (m.kind === 'termsSig') trade.raw.push(m);   // kept for the signer summons; nothing else is retained
    const waiting = trade.buffer.filter(x => x.from === m.from);
    if (waiting.length >= BUFFER_PER_SENDER || waiting.reduce((sum, x) => sum + byteSize(x), 0) + byteSize(m) > BUFFER_BYTES_PER_SENDER) return reject('buffer limit reached');
    if (m.kind === 'ack' && ACCEPTS[trade.role].ack !== ANY && !ACCEPTS[trade.role].ack.includes(s.phase)) {
      this.#ackNote(trade, 'ack deferred', m.from, `phase ${s.phase}`);
    }
    trade.buffer.push(m);
    this.#enqueue(trade, () => this.#drain(trade));
    return true;
  }

  // A signer that published keeps serving its share until the escrow's refund time (sellers may reconnect late).
  #serving(trade) {
    return trade.role === 'signer' && trade.state.phase === 'published' && this.now() < trade.state.terms.refundAfter;
  }

  #idleSigner(trade) {
    return trade.role === 'signer' && isFinished(trade) && !this.#serving(trade);
  }

  #idle(trade) {
    return trade.role === 'signer' ? this.#idleSigner(trade) : isFinished(trade);
  }

  // Leave a channel once no trade of this host needs it; joined topics otherwise piled up for the whole uptime.
  #leaveChannels(trade) {
    trade.channelsLeft = true;
    for (const ch of this.#channels(trade)) {
      const keys = this.byChannel.get(ch);
      keys?.delete(trade.key);
      if (keys?.size || this.keepChannel(ch)) continue;
      this.byChannel.delete(ch);
      if (!this.joined.delete(ch)) continue;
      Promise.resolve().then(() => this.bridge.leave(ch)).catch(e => this.log('leave', ch.slice(-8), e.message));
    }
  }

  // Someone joined late: send them everything this identity already said on that channel (receivers drop repeats).
  #resend(trade, channel, from, seconds = 3) {
    const id = `${seconds}:${from}`, last = trade.lastResend.get(id) ?? -Infinity;
    if (this.now() - last < seconds) return;
    trade.lastResend.set(id, this.now());
    for (const envelope of trade.outbox[channel] ?? []) {
      if (this.#serving(trade) && envelope.kind !== 'sharePublish') continue;
      this.sendEnvelope(trade, channel, envelope).catch(() => {});
    }
  }

  #resendAll(trade) {
    for (const [ch, list] of Object.entries(trade.outbox)) for (const e of list) {
      if (this.#serving(trade) && e.kind !== 'sharePublish') continue;
      this.sendEnvelope(trade, ch, e).catch(() => {});
    }
  }

  #enqueue(trade, fn) {
    trade.queue = trade.queue.then(fn).catch(e => this.log('trade error', trade.key, e.stack ?? e.message));
    return trade.queue;
  }

  async #drain(trade) {
    for (;;) {
      const accepts = ACCEPTS[trade.role];
      const fresh = this.#chainFresh();
      const i = trade.buffer.findIndex(m => {
        const phases = accepts[m.kind];
        return (phases === ANY || phases?.includes(trade.state.phase)) && (fresh || !NEEDS_CHAIN.has(m.kind));
      });
      if (i < 0) return;
      const [m] = trade.buffer.splice(i, 1);
      const observedAt = performance.now();
      await this.#apply(trade, { type: 'message', message: m, now: this.now(), observedSlot: this.slot ?? 0,
        finalizedAgeMs: this.slotAt == null ? Infinity : observedAt - this.slotAt,
        tipSlot: this.tip ?? 0, tipAgeMs: this.tipAt == null ? Infinity : observedAt - this.tipAt });
    }
  }

  deliver(key, event) {
    const trade = this.trades.get(key);
    return this.#enqueue(trade, () => this.#apply(trade, { now: this.now(), ...event }));
  }

  async #apply(trade, event) {
    if (event.now < trade.state.now) event = { ...event, now: trade.state.now };
    const before = trade.state;
    const observedAt = performance.now();
    if (event.type === 'makerPresence' && event.connected && trade.makerConnectedAt == null) trade.makerConnectedAt = observedAt;
    if (event.type === 'makerPresence') event = { ...event, type: 'tick' };
    const online = this.onlineSigners?.(before.registry), eligible = this.eligibleOnline?.(before.draft?.quoteAmount, before.draft?.pair, before.registry);
    event = { ...event, stepElapsedMs: Math.max(0, observedAt - trade.budgetAt),
      makerConnected: trade.makerConnectedAt != null,
      makerConnectedElapsedMs: trade.makerConnectedAt == null ? 0 : Math.max(0, observedAt - trade.makerConnectedAt),
      observedSlot: this.slot ?? 0, finalizedAgeMs: this.slotAt == null ? Infinity : observedAt - this.slotAt,
      tipSlot: this.tip ?? 0, tipAgeMs: this.tipAt == null ? Infinity : observedAt - this.tipAt,
      ...(online ? { onlineSigners: online } : {}), ...(eligible ? { eligibleOnline: eligible.length } : {}) };
    const { state, actions } = STEPS[trade.role](trade.state, event);
    this.#checkState(state);
    if (trade.role === 'buyer' && event.message?.kind === 'ack') {
      let reason;
      try { reason = ackRejectionReason(before, verifiedMessage(before, event)); }
      catch (error) { reason = error.message; }
      if (!reason && !state.acks.includes(event.message.from)) reason = state.reason ?? 'state validation failed';
      if (reason) this.#ackNote(trade, 'ack rejected', event.message.from, reason, before.phase);
    }
    trade.state = state;
    if (state.phase !== before.phase) this.log(trade.role, trade.key.slice(0, 12), before.phase, '->', state.phase, state.reason ?? '',
      ...(state.phase === 'aborted' && event.message?.kind === 'accept'
        ? [`(their accept slot ${event.message.body?.slot}, our finalized ${event.observedSlot} tip ${event.tipSlot})`] : []));
    try {
      if (event.type !== 'tick' || actions.length || state.phase !== before.phase || state.stepElapsedMs !== before.stepElapsedMs) this.#save(trade);
    }
    catch (error) { trade.state = before; throw error; }
    if (isFinished(trade)) this.#releaseMakerPins();
    if (state.stepStage !== before.stepStage || event.type === 'resume') trade.budgetAt = observedAt;
    if (state.tradeId && !before.tradeId) this.#joinChannels(trade).catch(e => this.log('join', e.message));
    for (const action of actions) await this.#act(trade, action);
    for (const hook of this.hooks.afterStep) await hook(trade, before, event);
    if (trade.buffer.length) await this.#drain(trade);
  }

  // Adapter calls run outside the trade's queue; their results come back as events.
  #background(trade, label, fn, toEvent, { retries = 3, retryMs = 3000, steady = false } = {}) {
    if (trade.busy.has(label)) return;
    trade.busy.add(label);
    if (process.env.DEX_DEBUG) this.log('start', label, trade.key.slice(0, 12));
    const started = Date.now();
    (async () => {
      for (let attempt = 1; ; attempt++) {
        try { return toEvent(await fn()); }
        catch (error) {
          this.log('retry', label, trade.key.slice(0, 12), `${attempt}/${retries}`, error.message);
          if (attempt >= retries) return { type: 'error', reason: `${label}: ${error.message}` };
          await new Promise(r => setTimeout(r, steady ? retryMs : retryMs * attempt));
        }
      }
    })().then(event => {
      if (process.env.DEX_DEBUG) this.log('done', label, trade.key.slice(0, 12), `${Date.now() - started} ms`, JSON.stringify(event).slice(0, 200));
      trade.busy.delete(label);
      return this.deliver(trade.key, { tradeId: trade.state.tradeId, ...event });
    });
  }

  async #act(trade, action) {
    const s = trade.state, tradeId = s.tradeId;
    switch (action.type) {
      case 'send': return this.#send(trade, action.ch, action.kind, action.body);
      case 'acquireCertificate':
        this.deliver(trade.key, { type: 'certificateAssigned', tradeId, certificate: this.certificatePool?.take() ?? null });
        return;
      case 'prepareDeal':
        this.certificatePool?.consumed(s.certificate?.H);
        this.deliver(trade.key, { type: 'prepareDeal', tradeId });
        return;
      case 'prove':
        return this.#background(trade, 'prove', async () => {
          try { return { type: 'proved', ok: true, proof: await proveLock(action, { zkeyPath: this.proof?.zkey }) }; }
          catch (error) { return { type: 'proved', ok: false, reason: error.message }; }
        }, result => result, { retries: 1 });
      case 'checkProof':
        return this.#background(trade, 'check-proof', () => verifyLock(action.statement, action.proof),
          ok => ({ type: 'proofChecked', ok }), { retries: 1 });
      // One escrow pays for one trade: the first trade of this harness to reserve an escrow keeps it, for good.
      case 'reserveEscrow': {
        const name = `escrowres-${action.hashHex}`;
        let reservedFor = null;
        try {
          const held = this.store.get(name);
          if (!held) this.store.put(name, { tradeId: action.tradeId, at: this.now() });
          reservedFor = this.store.get(name)?.tradeId ?? null;
        } catch (error) { this.log('escrow reservation', trade.key.slice(0, 12), error.message); }
        // No holder read back (store trouble): a failure without a holder, which the seller retries.
        this.deliver(trade.key, { type: 'escrowReserved', tradeId: action.tradeId, hashHex: action.hashHex, ok: reservedFor === action.tradeId,
          ...(reservedFor ? { reservedFor } : {}) });
        return;
      }
      case 'lockOutcome':
        return this.#background(trade, 'lock-outcome', () => this.solana.lockOutcome({ terms: action.terms, hashHex: action.hashHex }),
          r => ({ type: 'lockOutcome', outcome: r.ok ? r.outcome : 'unknown' }));
      case 'publishShare':
        for (const ch of action.channels) {
          const prior = trade.outbox[ch]?.find(e => e.kind === 'sharePublish');
          if (prior) await this.sendEnvelope(trade, ch, prior).catch(() => {});
          else await this.#send(trade, ch, 'sharePublish', action.body);
        }
        trade.publicationDelay ??= 10;
        trade.publicationAt ??= this.now();
        this.#save(trade);
        return;
      case 'persist': {
        if (action.scope === 'verifiedTransfer') {
          return this.#background(trade, 'reserve', () => this.trac.reserveTx({ txHash: action.record.txHash, tradeId }),
            r => ({ type: 'persisted', scope: 'verifiedTransfer', ok: r.ok === true, txHash: action.record.txHash, reservedFor: r.reservedFor }));
        }
        this.store.put(`${action.scope}-${tradeId ?? s.offerId}`, action.record);
        // Queued behind the current step; awaiting it here would wait on this very queue.
        this.deliver(trade.key, { type: 'persisted', scope: action.scope, ok: true, tradeId });
        return;
      }
      // Solana results: ok, unknown (a signed transaction may have landed; the adapter journaled it), or a definite
      // failure with nothing sent. Failures that only reflect unreadable chain state are retried here.
      case 'lockEscrow':
        return this.#background(trade, 'lock', () => this.solana.lockEscrow({ terms: action.terms, hashHex: action.hashHex }), r => {
          if (r.ok) return { type: 'escrowLocked', ok: true, hashHex: r.hashHex };
          if (r.unknown) return { type: 'escrowLocked', ok: false, unknown: true, hashHex: action.hashHex, reason: r.reason };
          if (/pending|quorum|timed? ?out|fetch|unavailable/i.test(r.reason ?? '')) throw new Error(r.reason);
          return { type: 'escrowLocked', ok: false, hashHex: action.hashHex, reason: r.reason };
        }, { retries: 4, retryMs: 5000 });
      case 'checkEscrow':
        return this.#background(trade, `check-${action.purpose ?? 'lock'}`,
          () => this.solana.checkEscrow({ terms: action.terms, hashHex: action.hashHex, purpose: action.purpose ?? 'lock' }),
          r => ({ type: 'escrowChecked', purpose: action.purpose, ...r }));
      case 'sendTransfer':
        // The adapter's own result says whether a transfer may have gone out (unknown + txHash) or surely did not.
        return this.#background(trade, 'transfer', () => sendFinalTransfer(this.trac, { terms: s.terms, tradeId, resume: action.resume === true }),
          r => ({ type: 'transferSent', ok: r.ok === true, final: r.final === true, finalizedAt: r.finalizedAt,
            unknown: r.unknown === true, txHash: r.txHash, sentAt: r.sentAt, reason: r.reason }), { retries: 1 });
      case 'verifyTransfer':
        return this.#background(trade, 'verify', () => this.#pollTransfer(action), r => ({ type: 'transferVerified', ...r }), { retries: 1 });
      case 'claim':
        return this.#background(trade, 'claim', () => this.solana.claim({ terms: action.terms, hashHex: action.hashHex, preimageHex: action.preimageHex }), r => {
          if (r.ok) return { type: 'claimed', ok: true, claimSignature: r.claimSignature };
          if (r.reason === 'escrow_refunded' && !r.unknown) return { type: 'claimed', ok: false, status: 'refunded', reason: r.reason };
          return { type: 'claimed', ok: false, unknown: r.unknown === true, reason: r.reason };
        });
      case 'refund':
        return this.#background(trade, 'refund', () => this.solana.refund({ terms: action.terms, hashHex: action.hashHex }),
          r => (r.ok ? { type: 'refunded', ok: true, refundSignature: r.refundSignature } : { type: 'refunded', ok: false, unknown: r.unknown === true, reason: r.reason }));
      case 'abort':
        this.log('abort', trade.role, trade.key.slice(0, 12), action.reason);
        if (trade.role !== 'signer' && !trade.abortSent) {
          trade.abortSent = true;
          const ch = tradeChannel(tradeId ?? s.offerId);
          const commitment = s.mode === 'taker' ? sha256Hex(hexToBytes(s.nonce, 32)) : s.peerCommit;
          await this.#send(trade, ch, 'abort', { tradeId: tradeId ?? s.offerId,
            ...(!tradeId && commitment ? { commitment } : {}), reason: String(action.reason).slice(0, 160) }).catch(() => {});
        }
        return;
      default: throw new Error(`Unknown action ${action.type}`);
    }
  }

  // Polls the own node until the transfer is final, definitively wrong, or the window closed.
  async #pollTransfer(action) {
    for (;;) {
      let r;
      try { r = await this.trac.verifyTransfer(action); }
      catch (error) { r = { ok: false, final: false, reason: error.message }; }
      if (r.ok && r.final) return r;
      if (r.final || this.now() >= action.finalBefore) return { ...r, ok: false };
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  #tickAll() {
    const now = this.now();
    for (const trade of this.trades.values()) {
      const s = trade.state;
      if (this.#serving(trade)) {
        if (trade.sellerClaimed) { if (!trade.channelsLeft) this.#leaveChannels(trade); continue; }
        const delay = trade.publicationDelay ?? 10;
        if (delay <= PUBLICATION_LAST_DELAY_SEC && now - (trade.publicationAt ?? 0) >= delay) {
          trade.publicationAt = now; trade.publicationDelay = delay * 2;
          this.#save(trade); this.#resendAll(trade);
        }
        continue;
      }
      if (this.#idle(trade) && !trade.channelsLeft) this.#leaveChannels(trade);
      if (isFinished(trade)) continue;
      this.#presence(trade);
      if (trade.role === 'seller' && s.phase === 'awaitShares' && s.shares.length < s.terms.k && now < s.terms.refundAfter &&
          now - (trade.shareRequestAt ?? -Infinity) >= 30) {
        trade.shareRequestAt = now;
        this.sendPublic(tradeChannel(s.tradeId), 'shareRequest', { tradeId: s.tradeId }).catch(() => {});
      }
      // Messages on sidechannels are not stored anywhere: while a trade waits, repeat what this side already said.
      // A signer's ack only matters until sendBy; after it, the ack goes only to members that announce themselves.
      // A signer still missing the dealing asks again every 30 s until sendBy (joining announced it once): every trader answers
      // 'present' by repeating what it said on that channel.
      if (trade.role === 'signer' && s.phase === 'awaitDeal' && now < s.terms.sendBy) {
        trade.presentAt ??= now;
        if (now - trade.presentAt >= 30) {
          trade.presentAt = now;
          for (const ch of this.#channels(trade)) this.#send(trade, ch, 'present', { ref: ch.slice('intercom-dex:t:'.length) }, { keep: false }).catch(() => {});
        }
      }
      // While both sides wait for a reveal, the reveal cutoff leaves seconds, so a lost accept or reveal is repeated
      // every 2 s; every other wait repeats every 10 s.
      const every = s.phase === 'awaitReveal' ? REVEAL_RESEND_SEC : 10;
      if (trade.phaseSeen !== s.phase) { trade.phaseSeen = s.phase; trade.phaseSince = now; }
      else if (now - trade.phaseSince >= every && now - (trade.autoResendAt ?? 0) >= every && !(trade.role === 'signer' && now >= s.terms.sendBy)) {
        trade.autoResendAt = now;
        this.#resendAll(trade);
      }
      // The randomness block is looked up once the pushed chain view shows it finalized, so waiting for it costs no
      // requests and both sides see it within a second of each other. Without a fresh pushed view, and when a node
      // has not finalized it yet, the lookup repeats every 2 s for as long as the step's budget lasts.
      if (s.phase === 'awaitRandomness' && this.solana && !(this.#watchFresh() && this.slot < s.acceptSlot + RANDOMNESS.TARGET)) {
        this.#background(trade, 'randomness', () => this.solana.firstFinalizedBlockAtLeast(s.acceptSlot + RANDOMNESS.TARGET),
          r => ({ type: 'tick', chain: { acceptSlot: s.acceptSlot, slot: r.slot, blockhash: r.blockhash, finalized: true, firstFinalized: true } }),
          { retries: RANDOMNESS_LOOKUPS, retryMs: 2000, steady: true });
      }
      this.#enqueue(trade, () => this.#apply(trade, { type: 'tick', now }));
    }
  }

  #presence(trade) {
    if (!trade.makerPeer || trade.state.phase !== 'awaitAccept' || trade.makerConnectedAt != null || trade.busy.has('presence')) return;
    trade.busy.add('presence');
    this.bridge.peerPresent(tradeChannel(trade.state.offerId), trade.makerPeer).then(connected => {
      if (connected && trade.state.phase === 'awaitAccept' && trade.makerConnectedAt == null) {
        trade.makerConnectedAt = performance.now();
        this.#resendAll(trade);
        this.deliver(trade.key, { type: 'makerPresence', connected });
      }
    }).catch(() => {}).finally(() => trade.busy.delete('presence'));
  }
}
