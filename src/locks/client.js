import { PositionMap, Deadlines } from './indexes.js';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import * as solanaPay from './solana-pay.js';
import * as edvss from './crypto/edvss.js';
import * as tracLock from './trac-lock.js';
import { scalarSigner } from './crypto/scalar-sign.js';
import * as dkg from './dkg.js';
import { bodySchemas, SOFTWARE as LOCKS_SOFTWARE } from './transport.js';
import { openingAmounts } from './products/fees.js';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { stableJSON, sha256Hex, fromLe32 } from '../core/canonical.js';
import { meetsVersion } from '../core/software.js';
import { products, deadlineOf, assetOf } from './products/index.js';
import { createPost, validatePost, positionId, selectCommittee, majority, describePosition, hex32, partySchema,
  lockError, errorResult, OUTCOMES, formatUnits } from './position.js';

export const LOCKS_CHANNEL = 'intercom-locks';
export const lockChannel = id => `${LOCKS_CHANNEL}:p:${hex32.parse(id)}`;
export const DEFAULT_SETTINGS = Object.freeze({ autoRepay: true, repayBlocksBefore: 6, autoExercise: true,
  exerciseBlocksBefore: 6, exerciseMarginBps: 100, autoSweep: true });
export const CLIENT_EVENTS = Object.freeze(['creating', 'funding', 'posted', 'taking', 'running', 'paid', 'cancel_requested',
  'ended', 'released', 'settings', 'attention']);
const clone = value => structuredClone(value);
const seconds = () => Math.floor(Date.now() / 1000);
const postBytes = post => Buffer.from('intercom-locks/v1/post\n' + stableJSON(post));
export const signPost = (post, secretKey) => Buffer.from(ed25519.sign(postBytes(post), secretKey)).toString('hex');
export function verifyPost(post, sig) {
  try { return typeof sig === 'string' && /^[0-9a-f]{128}$/.test(sig) && ed25519.verify(Buffer.from(sig, 'hex'), postBytes(post), Buffer.from(post.maker.lockKey, 'hex'), { zip215: false }); }
  catch { return false; }
}

export function validateSettings(input, previous = DEFAULT_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(DEFAULT_SETTINGS, k))) throw lockError('settings_invalid');
  const value = { ...previous, ...input };
  if (typeof value.autoRepay !== 'boolean' || typeof value.autoExercise !== 'boolean' || value.autoSweep !== true ||
      !['repayBlocksBefore', 'exerciseBlocksBefore'].every(k => Number.isSafeInteger(value[k]) && value[k] >= 1 && value[k] <= 12960) ||
      !Number.isSafeInteger(value.exerciseMarginBps) || value.exerciseMarginBps < 0 || value.exerciseMarginBps > 10000) throw lockError('settings_invalid');
  return value;
}

export function inTheMoney(position, price, marginBps = 100) {
  if (typeof price !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/.test(price)) return false;
  const [whole, fraction = ''] = price.split('.'), scaled = BigInt(whole + fraction.padEnd(12, '0'));
  const value = BigInt(position.post.terms.amount) * scaled;
  const strike = BigInt(position.post.terms.strikeTotal) * 10n ** BigInt((assetOf(position) === 'TNK' ? 18 : 8) + 6);
  return position.post.product === 'call' ? value * BigInt(10000 - marginBps) > strike * 10000n
    : position.post.product === 'put' && value * BigInt(10000 + marginBps) < strike * 10000n;
}

// What people read in the activity line.
const EVENT_TEXT = { creating: 'Setting up your offer.', funding: 'Moving your coins into the lock.', posted: 'Your offer is open.', taking: 'Someone is taking an offer.',
  running: 'It is running now.', paid: 'Your payment was sent.', cancel_requested: 'You asked to cancel.', released: 'The coins were sent out.',
  settings: 'Your settings were saved.', attention: 'Something needs your attention.' };
const ENDED_TEXT = { repaid: 'The loan was paid back.', defaulted: 'The loan was not paid back in time.', exercised: 'The option was used.',
  expired: 'The option ended unused.', cancelled: 'The offer was cancelled.', unfunded: 'The offer stopped before anything was locked.' };

// The runtime supplies authenticated transport, a pinned registry view and journaled chain operations.
// No network clients or timers are constructed here. onClock is driven by the local RESET clock.
export class LocksClient {
  constructor({ venueKey, identity, me, store, registry, transport, clock, adapters = {}, box = null, now = seconds, settings = {}, software = LOCKS_SOFTWARE }) {
    if (!venueKey) throw lockError('locks_disabled');
    hex32.parse(venueKey); partySchema.parse(me);
    if (identity?.publicKey !== me.lockKey || !identity.secretKey || !store?.get || !store?.put || !store?.list) throw lockError('adapter_unavailable');
    Object.assign(this, { venueKey, identity, box, me: clone(me), store, registry, transport, clock, adapters, now, software });
    this.adapters = adapters;
    for (const [key, value] of Object.entries({ solanaPay, edvss, tracLock })) this.adapters[key] ??= value;
    this.receiptPending = new Deadlines(); this.receiptComplete = new Deadlines(); this.pickupTimers = new Map();
    this.positions = new PositionMap(p => p.state !== 'released' && !(p.state === 'ended:unfunded' && !p.lock));
    this.book = new Map(); this.joined = new Set(); this.queue = Promise.resolve();
    const meta = store.get('locks-client') ?? {};
    this.settings = validateSettings(meta.settings ?? settings); this.events = meta.events ?? []; this.cursor = meta.cursor ?? 0;
    this.counted = null;
    for (const name of store.list('locks-position-')) {
      const p = store.get(name);
      if (!p || positionId(p.post) !== p.positionId || p.sig && !verifyPost(p.post, p.sig) || !p.sig && !p.postProofs?.length) throw lockError('invalid_message');
      this.positions.set(p.positionId, p);
    }
    for (const p of this.positions.values()) this.#trackReceipts(p);
  }
  #serial(work) { const next = this.queue.then(() => this.adapters.exclusive ? this.adapters.exclusive(work) : work()); this.queue = next.catch(() => {}); return next; }
  #need(object, name) { if (typeof object?.[name] !== 'function') throw lockError('adapter_unavailable'); return object[name].bind(object); }
  #save(p) { this.store.put(`locks-position-${p.positionId}`, p); this.positions.set(p.positionId, p); this.#trackReceipts(p); }
  #trackReceipts(p) {
    const at = p.collectedAt && Object.keys(p.receipts ?? {}).length && this.now() - p.collectedAt < 7 * 86400 ? p.lastReceiptReplay ?? 0 : undefined;
    const complete = this.#receiptProofsComplete(p);
    this.receiptPending.set(p.positionId, complete ? undefined : at);
    this.receiptComplete.set(p.positionId, complete ? at : undefined);
  }
  #nextReceipt() {
    for (const queue of [this.receiptPending, this.receiptComplete]) for (const id of queue.due(this.now() - 60)) {
      const p = this.positions.get(id);
      if (p && this.now() - p.collectedAt < 7 * 86400) return p;
    }
    return null;
  }
  #event(kind, p = null, data = {}) {
    this.events.push({ cursor: ++this.cursor, at: this.now(), kind, asset: p ? assetOf(p) : null, text: (kind === 'attention' && data.whatToDo) || EVENT_TEXT[kind] || (kind === 'ended' && data.state ? ENDED_TEXT[data.state.slice(6)] : null) || 'Something changed. Refresh to see it.', positionId: p?.positionId ?? null, ...data });
    this.events = this.events.slice(-1000);
    this.store.put('locks-client', { settings: this.settings, events: this.events, cursor: this.cursor });
  }
  #change(p, state) {
    if (p.state === state) return;
    p.state = state; if (state !== 'ended:unfunded') p.reason = null;
    this.#save(p); this.#event(state.startsWith('ended:') ? 'ended' : state, p, { state });
  }
  #registry() {
    if (this.registry?.conflict) throw lockError('registry_conflict');
    const reg = this.registry?.usable;
    if (!reg) throw lockError('registry_unavailable');
    if (!meetsVersion(this.software, reg.minSoftware)) throw lockError('update_required');
    return reg;
  }
  #position(id) { hex32.parse(id); const p = this.positions.get(id); if (!p) throw lockError('unknown_position'); return p; }
  #own(p) { return p.post.maker.lockKey === this.me.lockKey || p.taker?.lockKey === this.me.lockKey; }
  async #height() {
    const value = this.clock?.read ? await this.clock.read() : { counted: await this.#need(this.clock, 'counted')() };
    if (!Number.isSafeInteger(value?.counted) || value.counted < 0) throw lockError('clock_unavailable');
    this.counted = value.counted; return value.counted;
  }
  async #join(p) {
    const ch = lockChannel(p.positionId);
    if (!this.joined.has(ch)) { await this.#need(this.transport, 'join')(ch); this.joined.add(ch); }
  }
  async #leave(p) {
    const ch = lockChannel(p.positionId);
    if (this.joined.has(ch)) { await this.#need(this.transport, 'leave')(ch); this.joined.delete(ch); }
  }
  async #send(p, kind, body, publicChannel = false) {
    if (!publicChannel) await this.#join(p);
    return this.#need(this.transport, 'send')(publicChannel ? LOCKS_CHANNEL : lockChannel(p.positionId), kind, body);
  }
  async #funds(asset, amount, p = null) {
    const free = await this.#need(this.adapters, 'freeBalance')(asset, p ? { positionId: p.positionId } : {});
    if (free === null || free === undefined) throw lockError('insufficient_funds');
    if (BigInt(free) < BigInt(amount)) throw lockError('insufficient_funds', `Not enough ${asset}. This needs ${formatUnits(amount, asset)} free, you have ${formatUnits(free, asset)} free${asset === 'TNK' ? ' (TNK pays the network fees and travels with locked coins to send them out at the end)' : ''}.`);
  }
  async start() {
    this.unsubscribe = this.#need(this.transport, 'subscribe')((ch, raw) => this.receive(ch, raw).catch(() => {}));
    await this.#need(this.transport, 'join')(LOCKS_CHANNEL);
    // Neither the clock nor the venue may answer right after a start; the clock is read again on every tick, the book on every list.
    await this.#height().catch(() => {});
    await this.refreshBook().catch(() => {});
    this.unsubscribeClock = this.adapters.subscribeClock?.(() => this.onClock().catch(() => {}));
  }
  async stop() {
    this.unsubscribe?.(); this.unsubscribeClock?.();
    for (const timer of this.pickupTimers.values()) clearTimeout(timer); this.pickupTimers.clear();
    for (const ch of this.joined) await this.#need(this.transport, 'leave')(ch);
    this.joined.clear(); await this.#need(this.transport, 'leave')(LOCKS_CHANNEL);
  }
  async restoreTransport(current) {
    await Promise.all([LOCKS_CHANNEL, ...this.joined].map(async channel => {
      if (!current()) return;
      await this.#need(this.transport, 'join')(channel);
    }));
  }
  getSettings() { return clone(this.settings); }
  setSettings(input) {
    this.settings = validateSettings(input, this.settings); this.#event('settings'); return this.getSettings();
  }
  readEvents(since = 0) {
    if (!Number.isSafeInteger(since) || since < 0) throw lockError('invalid_input');
    const oldest = this.events[0]?.cursor ?? this.cursor;
    return { events: clone(this.events.filter(e => e.cursor > since)), next: this.cursor, oldest, truncated: since > 0 && since < oldest - 1 };
  }
  status(id) {
    const rows = id ? [this.#position(id)] : [...this.positions.values()].filter(p => this.#own(p));
    if (rows.some(p => !this.#own(p))) throw lockError('not_your_position');
    return rows.map(p => ({ ...describePosition(p, { lockKey: this.me.lockKey, counted: this.counted }),
      amounts: { ...openingAmounts(p.post.product, p.post.terms, p.registry.fee), ...(p.escrowCost ? { escrowTotal: p.escrowCost, escrowPlatformFee: (BigInt(p.escrowCost) - BigInt(p.post.terms.strikeTotal)).toString() } : {}), tnkReserve: p.registry.params.tnkReserve },
      reason: p.reason ?? null, whatToDo: p.reason ? errorResult({ reason: p.reason }).whatToDo : null, ...this.#releaseClock(p) }));
  }
  // A payment counts once Bitcoin's median time (the middle of the last 11 block times) has passed it: the card shows
  // both times so the wait is visible instead of a fixed "about an hour".
  #releaseClock(p) {
    const step = p.post.product === 'loan' ? 'repay' : 'exercise';
    if (p.operations?.[step]?.status !== 'confirmed') return {};
    const paidAt = p.operations[step].paidAt ?? this.events.findLast(e => e.kind === 'paid' && e.positionId === p.positionId)?.at ?? null;
    return { paidAt, bitcoinTime: this.median ?? null };
  }
  list({ product, asset, page = 0, minSize, maxSize, minTerm, maxTerm } = {}) {
    if (asset !== undefined && !['RESET', 'TNK'].includes(asset) || product !== undefined && !Object.hasOwn(products, product) || !Number.isSafeInteger(page) || page < 0 || page > 1000000 ||
      [minTerm, maxTerm].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0)) ||
      [minSize, maxSize].some(n => n !== undefined && (typeof n !== 'string' || !/^[1-9][0-9]{0,38}$/.test(n)))) throw lockError('invalid_input');
    const all = [...this.book.values()].filter(p => {
      const t = p.post.terms, size = BigInt(t.collateral ?? t.amount), term = t.termBlocks ?? Math.max(0, t.expiryBlock - (this.counted ?? 0));
      return p.state === 'posted' && (this.counted === null || t.offerUntilBlock > this.counted) && (!product || p.post.product === product) && (!asset || assetOf(p) === asset) &&
        (minSize === undefined || size >= BigInt(minSize)) && (maxSize === undefined || size <= BigInt(maxSize)) &&
        (minTerm === undefined || term >= minTerm) && (maxTerm === undefined || term <= maxTerm);
    }).sort((a, b) => (b.post.createdAt - a.post.createdAt) || a.positionId.localeCompare(b.positionId)); // newest first
    return { rows: all.slice(page * 50, page * 50 + 50).map(p => ({ ...describePosition(p, { lockKey: this.me.lockKey, counted: this.counted }), amounts: openingAmounts(p.post.product, p.post.terms, p.registry.fee) })),
      page, total: all.length, next: all.length > (page + 1) * 50 ? page + 1 : null };
  }
  async refreshBook({ product, asset, page = 0 } = {}) {
    this.list({ product, asset, page });
    if (!this.transport.requestBook) {
      await this.#need(this.transport, 'send')(LOCKS_CHANNEL, 'bookRequest', { ...(product ? { product } : {}), page, limit: 50 });
      return this.list({ product, asset, page });
    }
    if (!this.bookRead || this.now() - this.bookRead.at >= 10) {
      const read = { at: this.now() };
      read.promise = (async () => {
        const seen = new Set(); let size;
        for (let remote = 0; remote < 2000; remote++) {
          const raw = await this.transport.requestBook({ page: remote, limit: 100 });
          const m = await this.#need(this.transport, 'open')(LOCKS_CHANNEL, raw), b = m.body;
          if (m.from !== this.venueKey || m.kind !== 'book' || b.requester !== this.me.lockKey || b.page !== remote || size && size !== b.pageSize || b.total > 2000) throw lockError('invalid_message');
          size = b.pageSize;
          await this.receive(LOCKS_CHANNEL, raw);
          for (const p of b.positions) seen.add(p.positionId);
          if ((remote + 1) * size >= b.total) {
            for (const id of this.book.keys()) if (!seen.has(id)) this.book.delete(id);
            return;
          }
        }
        throw lockError('limit_exceeded');
      })().catch(error => { if (this.bookRead === read) this.bookRead = null; throw error; });
      this.bookRead = read;
    }
    await this.bookRead.promise;
    return this.list({ product, asset, page });
  }
  preview({ action = 'post', product, terms, positionId: id }) {
    if (!['post', 'take', 'repay', 'exercise', 'cancel', 'refund'].includes(action)) throw lockError('invalid_input');
    let p;
    if (action === 'post') {
      const reg = this.#registry();
      const post = createPost({ product, terms, maker: this.me, registryVersion: reg.version, createdAt: this.now() }, reg, { counted: this.counted ?? undefined });
      p = { post, registry: reg, state: 'posted' };
    } else p = this.positions.get(id) ?? this.book.get(id);
    if (!p) throw lockError('unknown_position');
    if (action === 'take' && p.state !== 'posted') throw lockError('already_taken');
    const t = p.post.terms;
    return { action, ...describePosition(p, { lockKey: this.me.lockKey, counted: this.counted }),
      amounts: { ...t, ...openingAmounts(p.post.product, t, p.registry.fee), tnkReserve: p.registry.params.tnkReserve } };
  }
  post(input) { return this.#serial(async () => {
    const reg = this.#registry(), counted = await this.#height();
    await this.adapters.admit?.({ registry: reg });
    const drawn = reg.signers.filter(s => s.status === 'active' && meetsVersion(s.software, reg.minSoftware)).length > reg.params.n;
    const drawSlot = drawn ? await this.#need(this.adapters, 'finalizedSlot')() + 32 : undefined;
    const post = createPost({ ...input, terms: { ...input.terms, asset: input.asset ?? input.terms.asset ?? 'RESET' }, drawSlot, maker: this.me, registryVersion: reg.version, createdAt: this.now() }, reg, { counted,
      makerPositions: [...this.positions.active.values()].filter(p => p.post.maker.lockKey === this.me.lockKey && !p.state.startsWith('ended:') && p.state !== 'released').length });
    let escrowCost;
    if (post.product === 'put') {
      this.#holderProtocol();
      const costs = await this.#need(this.adapters, 'escrowCosts')({ registry: reg, amount: post.terms.strikeTotal });
      escrowCost = costs.total; await this.#funds('USDC', escrowCost);
    } else await this.#assetFunds(post, reg);
    const id = positionId(post), p = { positionId: id, post, sig: signPost(post, this.identity.secretKey), registry: clone(reg),
      committee: drawn ? [] : selectCommittee(reg, id), state: 'creating', ...(escrowCost ? { escrowCost } : {}), votes: {}, operations: {}, releases: [] };
    this.#save(p); this.#event('creating', p);
    await this.#join(p); await this.#send(p, 'lockRequest', { positionId: id, post }, true);
    return this.status(id)[0];
  }); }
  async #operation(p, step, input, perform) {
    let operation = p.operations[step];
    if (operation?.status === 'confirmed') return operation.receipt;
    if (operation) {
      const resume = this.adapters.hasIntent && !this.adapters.hasIntent(operation.id);
      const receipt = resume || step.startsWith('sweep') && (p.post.product !== 'put' || step.includes(':H:')) ? await perform(operation.id)
        : await this.#need(this.adapters, 'reconcile')({ id: operation.id, step, position: clone(p), input: clone(operation.input) });
      if (receipt?.ok !== true || receipt.finalized !== true) throw lockError('payment_pending');
      operation.status = 'confirmed'; operation.receipt = receipt; this.#save(p); return receipt;
    }
    operation = { id: sha256Hex(`intercom-locks/v1/intent:${p.positionId}:${step}`), status: 'pending', input: clone(input) };
    p.operations[step] = operation; this.#save(p);
    let receipt;
    try { receipt = await perform(operation.id); }
    catch (error) { if (this.adapters.hasIntent && !this.adapters.hasIntent(operation.id) && error.reason) throw error; throw lockError('payment_pending'); }
    if (receipt?.ok !== true || receipt.finalized !== true) throw lockError('payment_pending');
    operation.status = 'confirmed'; operation.receipt = receipt; this.#save(p); return receipt;
  }
  async #committee(post, reg) {
    const active = reg.signers.filter(s => s.status === 'active' && meetsVersion(s.software, reg.minSoftware));
    const draw = active.length > reg.params.n ? await this.#need(this.adapters, 'drawBlock')(post.drawSlot) : null;
    if (draw && draw.finalized !== true) throw lockError('protocol_unavailable');
    return selectCommittee(reg, positionId(post), draw?.blockhash);
  }
  #holderProtocol() {
    if (!bodySchemas.lockReady.shape.takeId && !this.adapters.holderProtocol) throw lockError('protocol_unavailable');
  }
  async #assetFunds(post, registry) {
    const asset = assetOf(post), amount = BigInt(post.terms.collateral ?? post.terms.amount), reserve = BigInt(registry.params.tnkReserve);
    const fee = BigInt(await this.adapters.fundingFee?.() ?? '0');
    if (asset === 'TNK') await this.#funds('TNK', amount + reserve + fee);
    else { await this.#funds('RESET', amount); await this.#funds('TNK', reserve + fee * (reserve > 0n ? 2n : 1n)); }
  }
  async #fund(p, holder = false) {
    if (p.post.product === 'put' && !holder) {
      const receipt = await this.#operation(p, 'fund:USDC', { asset: 'USDC', amount: p.escrowCost ?? p.post.terms.strikeTotal },
        id => this.#need(this.adapters, 'fundEscrow')({ id, position: clone(p) }));
      p.escrow = receipt.escrow; p.refundAfter = receipt.refundAfter; p.funded = true; this.#save(p);
      await this.#send(p, 'funded', { positionId: p.positionId, escrow: p.escrow }); return;
    }
    const t = p.post.terms, base = assetOf(p), reserve = BigInt(p.registry.params.tnkReserve);
    const lock = holder ? p.holderLock : p.lock, prefix = holder ? `fund:H:${p.takeId}:` : 'fund:';
    const funding = base === 'TNK' ? [['TNK', (BigInt(t.collateral ?? t.amount) + reserve).toString()]]
      : [['RESET', t.collateral ?? t.amount], ['TNK', reserve.toString()]];
    for (const [asset, amount] of funding) {
      if (amount === '0') continue;
      if (holder && !p.operations[prefix + asset]) this.#reservation(p);
      const input = { asset, amount, to: lock.address, nonce: tracLock.fundingNonce(p.positionId, asset, holder ? p.takeId : undefined) };
      await this.#operation(p, prefix + asset, input, id => this.#need(this.adapters, 'transfer')({ ...input, id, position: clone(p) }));
    }
    if (holder) p.holderFunded = true; else p.funded = true;
    this.#save(p);
    await this.#send(p, 'funded', { positionId: p.positionId, ...(holder ? { takeId: p.takeId } : {}) });
    if (holder) await this.#openPayment(p);
  }
  take(id) { return this.#serial(async () => {
    const current = this.#registry();
    const existing = this.positions.get(id);
    if (existing) await this.#lapse(existing);
    if (existing?.state === 'taking' && existing.taker?.lockKey === this.me.lockKey) { await this.#openPayment(existing); return this.status(id)[0]; }
    const p = clone(existing ?? this.book.get(id));
    if (!p) throw lockError('unknown_position');
    if (current.products[p.post.product] !== 'open') throw lockError('product_paused');
    if (current.assets && current.assets[assetOf(p)] !== 'open') throw lockError('product_paused');
    if (p.post.maker.lockKey === this.me.lockKey) throw lockError('own_offer');
    if (p.state !== 'posted') throw lockError('already_taken');
    await this.adapters.admit?.({ post: p.post, registry: p.registry });
    await this.#funds('USDC', openingAmounts(p.post.product, p.post.terms, p.registry.fee).openingTotal);
    if (p.post.product === 'put') { this.#holderProtocol(); await this.#assetFunds(p.post, p.registry); }
    if (p.post.terms.offerUntilBlock <= await this.#height()) throw lockError('offer_expired');
    if (!majority(p.votes.posted ?? [], p.committee, p.registry.params.k, () => true)) throw lockError('signers_unavailable');
    p.takeId = randomBytes(32).toString('hex'); p.taker = clone(this.me); p.takeAnchor = this.counted; p.votes.reserve = []; p.takingAt = this.now();
    p.holderId = sha256Hex(`intercom-locks/v1/holder:${p.positionId}:${p.takeId}`);
    p.state = 'taking'; this.#save(p); this.#event('taking', p);
    await this.#send(p, 'take', { positionId: id, takeId: p.takeId, taker: p.taker, ...(p.post.product === 'loan' ? { takeAnchor: p.takeAnchor } : {}) });
    return this.status(id)[0];
  }); }
  async #lapse(p) {
    if (p.state !== 'taking' || Object.keys(p.operations).some(s => s.startsWith('open:'))) return;
    const reservations = p.votes.reserve ?? [];
    const expiresAt = reservations.length ? Math.max(...reservations.map(v => v.body.expiresAt)) : (p.takingAt ?? p.post.createdAt) + p.registry.params.reserveSec;
    if (this.now() <= expiresAt) return;
    if (p.holderLock || Object.keys(p.operations).some(s => s.startsWith('fund:H:'))) {
      p.reason = 'reservation_expired'; this.#save(p); await this.requestRelease(p.positionId); return;
    }
    delete p.taker; delete p.takeId; delete p.takeAnchor; delete p.takingAt;
    p.votes.reserve = []; p.votes.opened = []; this.#change(p, 'posted'); await this.#leave(p);
  }
  #reservation(p) {
    const { k, payMarginSec } = p.registry.params;
    const live = (p.votes.reserve ?? []).filter(v => v.body.takeId === p.takeId && v.body.takerKey === this.me.lockKey && v.body.expiresAt - this.now() >= payMarginSec);
    if (!majority(live, p.committee, k, () => true)) throw lockError('reservation_expired');
    // Use exactly k distinct live promises, with the longest window first.
    return live.sort((a, b) => b.body.expiresAt - a.body.expiresAt).slice(0, k);
  }
  async #openPayment(p) {
    if (p.taker?.lockKey !== this.me.lockKey || p.state !== 'taking') return;
    if (p.post.product === 'put' && !p.holderFunded) return;
    const step = `open:${p.takeId}`;
    if (!p.operations[step]) {
      this.#reservation(p);
      if (await this.#height() >= p.post.terms.offerUntilBlock) throw lockError('offer_expired');
    }
    const { makerReceives: amount, openingFee: fee, openingTotal } = openingAmounts(p.post.product, p.post.terms, p.registry.fee);
    if (!p.operations[step]) await this.#funds('USDC', openingTotal, p);
    const receipt = await this.#payment(p, step, amount, p.post.maker.sol, fee, () => { this.#reservation(p); });
    await this.#send(p, 'paid', { positionId: p.positionId, step, signature: receipt.signature });
  }
  async #payment(p, step, amount, payee, fee = '0', beforeSend = () => {}) {
    const pay = this.adapters.solanaPay;
    const input = { payer: this.me.sol, payee, amount, fee, collector: p.registry.fee.collector, mint: this.adapters.mint,
      memo: this.#need(pay, 'memo')(p.positionId, step) };
    const receipt = await this.#operation(p, step, input, async id => {
      const transaction = await this.#need(pay, 'build')(input);
      await beforeSend();
      return this.#need(this.adapters, 'submit')({ id, transaction, beforeSend,
        ...(step.startsWith('open:') ? { sendBefore: Math.min(...this.#reservation(p).map(v => v.body.expiresAt)) - p.registry.params.payMarginSec } : {}),
        position: clone(p), step });
    });
    if (typeof receipt.signature !== 'string' || !receipt.signature) throw lockError('payment_pending');
    return receipt;
  }
  pay(id, step) { return this.#serial(() => this.#pay(this.#position(id), step)); }
  async #pay(p, step) {
    const product = p.post.product, t = p.post.terms;
    if (!['repay', 'exercise'].includes(step) || (step === 'repay') !== (product === 'loan')) throw lockError('invalid_input');
    const payer = product === 'loan' ? p.post.maker : p.taker;
    if (payer?.lockKey !== this.me.lockKey) throw lockError('not_your_position');
    if (p.state !== 'running') throw lockError('wrong_state');
    if (!p.operations[step] && await this.#height() >= deadlineOf(p)) throw lockError('deadline_passed');
    const amount = product === 'loan' ? t.repay : product === 'call' ? t.strikeTotal : t.amount;
    if (!p.operations[step] && product !== 'put') await this.#funds('USDC', amount, p);
    let receipt;
    if (product === 'put') {
      const input = { payer: this.me.sol, memo: solanaPay.memo(p.positionId, 'exercise'), amount: '0' };
      receipt = await this.#operation(p, step, input, async id => {
        const transaction = solanaPay.buildExercise ? solanaPay.buildExercise(input) : new Transaction().add(new TransactionInstruction({ programId: solanaPay.MEMO_PROGRAM,
          keys: [{ pubkey: new PublicKey(this.me.sol), isSigner: true, isWritable: false }], data: Buffer.from(input.memo) }));
        transaction.feePayer = new PublicKey(this.me.sol);
        const beforeSend = async () => { if (await this.#height() >= deadlineOf(p)) throw lockError('deadline_passed'); };
        return this.#need(this.adapters, 'submit')({ id, transaction, beforeSend, position: clone(p), step });
      });
    } else receipt = await this.#payment(p, step, amount, product === 'loan' ? p.taker.sol : p.post.maker.sol, '0', async () => {
      if (await this.#height() >= deadlineOf(p)) throw lockError('deadline_passed');
    });
    await this.#send(p, 'paid', { positionId: p.positionId, step, signature: receipt.signature ?? receipt.txHash });
    p.operations[step].paidAt ??= this.now();
    p.reason = null; this.#save(p);
    this.#event('paid', p, { step }); return this.status(p.positionId)[0];
  }
  refund(id) { return this.#serial(() => this.#refund(this.#position(id))); }
  async #refund(p) {
    if (p.post.product !== 'put' || p.post.maker.lockKey !== this.me.lockKey) throw lockError('not_your_position');
    if (!p.funded || !p.refundAfter) throw lockError('wrong_state');
    await this.#operation(p, 'refund', { refundAfter: p.refundAfter }, id => this.#need(this.adapters, 'refundEscrow')({ id, position: clone(p) }));
    p.escrowStatus = 'refunded'; p.reason = null; this.#save(p);
    await this.requestRelease(p.positionId); return this.status(p.positionId)[0];
  }
  cancel(id) { return this.#serial(async () => {
    const p = this.#position(id);
    if (p.post.maker.lockKey !== this.me.lockKey) throw lockError('not_your_position');
    if (!['posted', 'taking'].includes(p.state)) throw lockError('wrong_state');
    if ((p.votes.reserve ?? []).some(v => v.body.expiresAt > this.now())) throw lockError('reservation_active');
    await this.#send(p, 'cancel', { positionId: id }); this.#event('cancel_requested', p); return this.status(id)[0];
  }); }
  async requestRelease(id) {
    const p = this.#position(id);
    if (!this.#own(p)) throw lockError('not_your_position');
    if (p.lastReleaseRequest != null && this.now() - p.lastReleaseRequest < 60) return false;
    clearTimeout(this.pickupTimers.get(id)); this.pickupTimers.delete(id);
    p.lastReleaseRequest = this.now(); this.#save(p);
    await this.#join(p);
    if (p.state === 'posted' && p.post.maker.lockKey === this.me.lockKey) await this.#send(p, 'lockRequest', { positionId: id, post: p.post }, true);
    await this.#send(p, 'releaseRequest', { positionId: id, ...(p.takeId && bodySchemas.releaseRequest.shape.takeId ? { takeId: p.takeId, ...(p.opened ? { pickup: 'release' } : {}) } : {}) }, true);
    // Keep pending replies reachable through the retry interval; completed collection leaves early.
    const timer = setTimeout(() => { this.#serial(async () => {
      if (this.pickupTimers.get(id) !== timer) return;
      this.pickupTimers.delete(id);
      if (!['creating', 'funding', 'taking'].includes(p.state)) await this.#leave(p);
    }).catch(() => {}); }, 60000); timer.unref?.(); this.pickupTimers.set(id, timer);
    return true;
  }
  async receive(channel, raw) {
    const m = await this.#need(this.transport, 'open')(channel, raw);
    if (!m || m.ch !== channel) throw lockError('invalid_message');
    if (channel === LOCKS_CHANNEL && m.from === this.venueKey && m.kind === 'registry') {
      const accepted = this.#need(this.registry, 'offer')(m);
      for (const p of this.positions.active.values()) this.#trackReceipts(p);
      const pending = this.receiptReplay ? null : this.#nextReceipt();
      if (pending && !this.receiptReplay) {
        this.receiptReplay = (async () => {
          pending.lastReceiptReplay = this.now(); this.#save(pending);
          try {
            if (!this.#receiptProofsComplete(pending)) await this.requestRelease(pending.positionId);
            else await this.#send(pending, 'releaseRequest', { positionId: pending.positionId, pickup: 'receipts' }, true);
            await this.#receipts(pending, true);
          } finally {
            const current = this.positions.get(pending.positionId);
            if (current?.state === 'released' && !this.pickupTimers.has(current.positionId)) await this.#leave(current);
          }
        })().finally(() => { this.receiptReplay = null; });
        await this.receiptReplay;
      }
      return accepted;
    }
    if (channel === LOCKS_CHANNEL && m.from === this.venueKey && m.kind === 'book') {
      if (!Array.isArray(m.body.positions) || m.body.positions.length > 100) throw lockError('invalid_message');
      if (m.body.requester !== this.me.lockKey) return false;
      for (const row of m.body.positions) await this.#adopt(row);
      return true;
    }
    if (!this.positions.has(m.body?.positionId)) return false;
    return this.#serial(async () => {
      const p = this.positions.get(m.body?.positionId);
      if (!p || channel !== lockChannel(p.positionId) && !(channel === LOCKS_CHANNEL && m.kind === 'posted')) return false;
      try { await this.#message(p, m); }
      catch (error) {
        const failure = errorResult(error);
        if (p.reason !== failure.reason) { p.reason = failure.reason; this.#save(p); this.#event('attention', p, failure); }
        throw error;
      }
      return true;
    });
  }
  #lock(p, body, holder = false) {
    const { A, C, address, chain } = body;
    hex32.parse(A);
    if (!Array.isArray(C) || C.length !== p.registry.params.k || C[0] !== A || chain !== (p.post.product === 'put' && !holder ? 'solana' : 'trac')) throw lockError('lock_mismatch');
    C.forEach(c => hex32.parse(c));
    const expected = chain === 'trac' ? this.#need(this.adapters.tracLock, 'address')(A) : new PublicKey(Buffer.from(A, 'hex')).toBase58();
    if (address !== expected) throw lockError('lock_mismatch');
    const Q = body.Q;
    if (p.registry.assets && !Q) throw lockError('lock_mismatch');
    if (Q !== undefined && (!Array.isArray(Q) || Q.length < p.committee.length - 1 || new Set(Q).size !== Q.length || Q.some(j => !Number.isInteger(j) || j < 1 || j > p.committee.length))) throw lockError('lock_mismatch');
    return { A, C, address, chain, ...(Q ? { Q } : {}) };
  }
  async #adopt(row) {
    const post = validatePost(row.post), id = positionId(post), reg = this.registry?.snapshot(post.registryVersion);
    if (!reg || id !== row.positionId) throw lockError('invalid_message');
    validatePost(post, reg);
    if (this.positions.has(id)) return;
    const p = { positionId: id, post, registry: clone(reg), committee: await this.#committee(post, reg), state: 'posted', funded: true,
      operations: {}, votes: {}, releases: [], postProofs: row.attestations };
    if (!Array.isArray(row.attestations) || row.attestations.length > 16) throw lockError('invalid_message');
    for (const raw of row.attestations) {
      const m = await this.#need(this.transport, 'open')(LOCKS_CHANNEL, raw, { historical: true });
      if (m?.ch !== LOCKS_CHANNEL || m.kind !== 'posted' || m.body?.positionId !== id ||
          p.committee[m.body.j - 1]?.lockKey !== m.from || m.body.registryVersion !== reg.version || stableJSON(m.body.post) !== stableJSON(post)) throw lockError('invalid_message');
      this.#lock(p, m.body); this.#vote(p, 'posted', m);
    }
    p.lock = majority(p.votes.posted ?? [], p.committee, reg.params.k, v => this.#lock(p, v.body));
    if (!p.lock || row.lock && (row.lock.A !== p.lock.A || stableJSON(row.lock.C) !== stableJSON(p.lock.C))) throw lockError('lock_mismatch');
    if (this.positions.has(id)) return;
    if (this.book.size >= 2000) this.book.delete(this.book.keys().next().value);
    this.book.set(id, p);
  }
  #vote(p, kind, m) {
    const votes = p.votes[kind] ??= [], previous = votes.find(v => v.from === m.from);
    if (previous && stableJSON(previous.body) !== stableJSON(m.body)) {
      // An expired reservation may be replaced by its signer for a later take.
      if (kind !== 'reserve' || previous.body.expiresAt > this.now()) throw lockError('invalid_message');
      votes.splice(votes.indexOf(previous), 1);
    } else if (previous) return;
    votes.push({ from: m.from, body: clone(m.body) });
  }
  async #message(p, m) {
    if (!p.committee.length) { p.committee = await this.#committee(p.post, p.registry); this.#save(p); }
    if (!p.committee.some(s => s.lockKey === m.from)) return;
    const b = m.body, { n, k } = p.registry.params;
    if (m.kind === 'dkgFail' && p.state === 'creating') {
      p.reason = 'dkg_failed'; p.winner = 'maker'; p.outcome = 'unfunded'; this.#change(p, 'ended:unfunded'); await this.#leave(p); return;
    }
    if (m.kind === 'lockReady' && p.state === 'posted' && !b.takeId && p.funded && p.post.maker.lockKey === this.me.lockKey) {
      if (b.j !== p.committee.findIndex(s => s.lockKey === m.from) + 1 || stableJSON(this.#lock(p, b)) !== stableJSON(p.lock)) throw lockError('lock_mismatch');
      await this.#send(p, 'funded', { positionId: p.positionId, ...(p.escrow ? { escrow: p.escrow } : {}) });
      if (!this.pickupTimers.has(p.positionId)) await this.#leave(p);
    } else if (m.kind === 'lockReady' && ['creating', 'funding', 'taking'].includes(p.state)) {
      const holder = b.takeId !== undefined;
      if (holder && (p.post.product !== 'put' || p.state !== 'taking' || b.takeId !== p.takeId)) throw lockError('invalid_message');
      if (!holder && p.state === 'taking') return;
      if (b.j !== p.committee.findIndex(s => s.lockKey === m.from) + 1) throw lockError('invalid_message');
      this.#lock(p, b, holder);
      const kind = holder ? 'holderReady' : 'lockReady'; this.#vote(p, kind, m); this.#save(p);
      const ready = majority(p.votes[kind], p.committee, Math.max(k, n - 1), v => this.#lock(p, v.body, holder));
      if (ready) {
        if (holder) { p.holderLock = ready; this.#save(p); if (!p.holderFunded) await this.#fund(p, true); }
        else { p.lock = ready; this.#change(p, 'funding'); if (!p.funded) await this.#fund(p); }
      }
    } else if (m.kind === 'posted' && ['funding', 'posted'].includes(p.state)) {
      if (b.j !== p.committee.findIndex(s => s.lockKey === m.from) + 1 || b.registryVersion !== p.registry.version || stableJSON(b.post) !== stableJSON(p.post)) throw lockError('invalid_message');
      const lock = this.#lock(p, b);
      if (p.lock && stableJSON(lock) !== stableJSON(p.lock)) throw lockError('lock_mismatch');
      this.#vote(p, 'posted', m); this.#save(p);
      if (majority(p.votes.posted, p.committee, k, v => this.#lock(p, v.body))) { this.#change(p, 'posted'); this.book.set(p.positionId, p); if (!this.pickupTimers.has(p.positionId)) await this.#leave(p); }
    } else if (m.kind === 'reserve' && p.state === 'taking') {
      if (b.takeId !== p.takeId || b.takerKey !== p.taker?.lockKey || !Number.isSafeInteger(b.expiresAt) || b.expiresAt > this.now() + p.registry.params.reserveSec) throw lockError('invalid_message');
      this.#vote(p, 'reserve', m); this.#save(p);
      if (p.votes.reserve.length >= k) {
        if (p.post.product === 'put' && p.holderLock && !p.holderFunded) await this.#fund(p, true);
        else await this.#openPayment(p);
      }
    } else if (m.kind === 'opened' && ['posted', 'taking', 'running'].includes(p.state)) {
      if (b.j !== p.committee.findIndex(s => s.lockKey === m.from) + 1) throw lockError('invalid_message');
      partySchema.parse(b.taker); hex32.parse(b.takeId);
      if (b.taker.lockKey === p.post.maker.lockKey || p.taker && (b.takeId !== p.takeId || stableJSON(b.taker) !== stableJSON(p.taker))) throw lockError('invalid_message');
      if (p.post.product === 'put') this.#lock(p, b.holderLock, true);
      if (p.post.product === 'loan' && (!Number.isSafeInteger(b.takeAnchor) || b.takeAnchor < 0 || !Number.isSafeInteger(b.dueBlock) || b.dueBlock !== b.takeAnchor + p.post.terms.termBlocks)) throw lockError('invalid_message');
      if (p.post.product === 'loan' && p.taker?.lockKey === this.me.lockKey && b.takeAnchor !== p.takeAnchor) throw lockError('invalid_message');
      this.#vote(p, 'opened', m); this.#save(p);
      const opened = majority(p.votes.opened, p.committee, k, v => { const { j, ...body } = v.body; return body; });
      if (opened) {
        p.taker = opened.taker; p.takeId = opened.takeId; p.opened = true;
        if (p.post.product === 'put') {
          const holderLock = this.#lock(p, opened.holderLock, true);
          if (p.holderLock && stableJSON(p.holderLock) !== stableJSON(holderLock)) throw lockError('lock_mismatch');
          p.holderLock = holderLock; p.holderFunded = true;
        }
        if (p.post.product === 'loan') { p.takeAnchor = opened.takeAnchor; p.dueBlock = opened.dueBlock; }
        this.book.delete(p.positionId); this.#change(p, 'running'); if (!this.pickupTimers.has(p.positionId)) await this.#leave(p);
      }
    } else if (m.kind === 'release') {
      const j = p.committee.findIndex(s => s.lockKey === m.from) + 1, holder = b.takeId !== undefined;
      if (b.j !== j || !['maker', 'taker'].includes(b.winner) || !OUTCOMES.includes(b.outcome)) throw lockError('invalid_message');
      const mine = (b.winner === 'maker' ? p.post.maker : p.taker)?.lockKey === this.me.lockKey;
      if (holder && (p.post.product !== 'put' || b.takeId !== p.takeId)) throw lockError('invalid_message');
      const lock = holder ? p.holderLock : p.lock;
      if (!lock || b.A !== lock.A || stableJSON(b.C) !== stableJSON(lock.C)) throw lockError('lock_mismatch');
      const previous = p.votes[holder ? 'holderRelease' : 'release']?.find(v => v.from === m.from);
      if (p.state === 'released' && previous && stableJSON(previous.body) === stableJSON(b)) {
        const key = `${holder ? p.takeId : ''}:${j}`;
        if (mine && m.sig && !p.releaseProofs?.[key]) { (p.releaseProofs ??= {})[key] = clone(m); this.#save(p); }
        return;
      }
      const context = { positionId: p.positionId, from: j, to: this.me.lockKey, ...(holder ? { takeId: p.takeId } : {}) };
      let share;
      if (mine) {
        share = this.adapters.openRelease ? await this.adapters.openRelease({ sealed: b.sealed, ...context })
          : fromLe32(dkg.openShare(b.sealed, this.box.secretKey, context, 'release'));
        if (!this.#need(this.adapters.edvss, 'verifyShare')(j, share, lock.C)) throw lockError('invalid_share');
      }
      const kind = holder ? 'holderRelease' : 'release';
      this.#vote(p, kind, m);
      const result = majority(p.votes[kind], p.committee, k, v => ({ winner: v.body.winner, outcome: v.body.outcome }));
      if (result) {
        if (holder) p.holderDecision = result;
        else Object.assign(p, result);
        if (p.state !== 'released') this.#change(p, `ended:${p.outcome ?? result.outcome}`);
      }
      if (!mine) { this.#save(p); this.#collected(p); await this.#finishPickup(p); return; }
      const releases = holder ? (p.holderReleases ??= []) : p.releases;
      if (!releases.some(s => s.id === j)) releases.push({ id: j, share: share.toString(), winner: b.winner, outcome: b.outcome });
      if (m.sig) (p.releaseProofs ??= {})[`${holder ? p.takeId : ''}:${j}`] = clone(m);
      if (dkg.releaseReceiptKey && this.box) {
        (p.receipts ??= {})[`${holder ? p.takeId : ''}:${j}`] = { positionId: p.positionId, ...(holder ? { takeId: p.takeId } : {}), j,
          releaseHash: dkg.releaseDigest(m), key: dkg.releaseReceiptKey(b.sealed, this.box.secretKey, context) };
      }
      this.#save(p);
      if (result) await this.#sweep(p, holder);
    } else if (m.kind === 'ended' && p.state !== 'released') {
      if (!['maker', 'taker'].includes(b.winner) || !OUTCOMES.includes(b.outcome)) throw lockError('invalid_message');
      this.#vote(p, 'ended', m); this.#save(p);
      const result = majority(p.votes.ended, p.committee, k, v => ({ winner: v.body.winner, outcome: v.body.outcome }));
      if (result && (!p.winner || p.winner === result.winner && p.outcome === result.outcome)) {
        Object.assign(p, result); this.book.delete(p.positionId); this.#change(p, `ended:${result.outcome}`); this.#collected(p);
      }
    }
  }
  #receiptProofsComplete(p) {
    if (!this.transport.forward || p.state !== 'released') return false;
    const legs = [{ lock: p.lock, winner: p.winner, takeId: '' }];
    if (p.post.product === 'put' && p.opened) legs.push({ lock: p.holderLock, winner: p.holderDecision?.winner, takeId: p.takeId });
    return legs.filter(leg => (leg.winner === 'maker' ? p.post.maker : p.taker)?.lockKey === this.me.lockKey).every(leg =>
      leg.lock?.Q?.every(j => p.releaseProofs?.[`${leg.takeId}:${j}`] && p.receipts?.[`${leg.takeId}:${j}`]));
  }
  async #finishPickup(p) {
    if (!this.#receiptProofsComplete(p)) return;
    clearTimeout(this.pickupTimers.get(p.positionId)); this.pickupTimers.delete(p.positionId);
    await this.#leave(p);
  }
  async #receipts(p, replay = false) {
    for (const [key, receipt] of Object.entries(p.receipts ?? {})) {
      const step = receipt.takeId ? `sweep:H:${receipt.takeId}` : 'sweep';
      if (p.operations[step]?.status !== 'confirmed' || !replay && p.sentReceipts?.[key]) continue;
      if (replay && this.transport.forward && p.releaseProofs?.[key]) {
        await this.#join(p); await this.transport.forward(lockChannel(p.positionId), p.releaseProofs[key]);
      }
      await this.#send(p, 'releaseReceipt', receipt);
      const current = this.positions.get(p.positionId);
      if (!current?.sentReceipts?.[key] && current?.receipts?.[key]?.releaseHash === receipt.releaseHash) { (current.sentReceipts ??= {})[key] = true; this.#save(current); }
    }
    await this.#finishPickup(this.positions.get(p.positionId) ?? p);
  }
  #collected(p) {
    if (!p.winner) return;
    const mine = winner => (winner === 'maker' ? p.post.maker : p.taker)?.lockKey === this.me.lockKey;
    if (mine(p.winner) && p.operations.sweep?.status !== 'confirmed') return;
    if (p.post.product === 'put' && p.opened) {
      if (!p.holderDecision || mine(p.holderDecision.winner) && p.operations[`sweep:H:${p.takeId}`]?.status !== 'confirmed') return;
      // Put credits wait for both keys, including a later collection owned by the other party.
      if (p.state !== 'released' && p.collectedAt) { p.collectedAt = this.now(); this.#save(p); }
    }
    this.#change(p, 'released');
  }
  async #sweep(p, holder = false) {
    const decision = holder ? p.holderDecision : p, lock = holder ? p.holderLock : p.lock;
    if (!decision || !lock || (decision.winner === 'maker' ? p.post.maker : p.taker)?.lockKey !== this.me.lockKey) return;
    const step = holder ? `sweep:H:${p.takeId}` : 'sweep';
    let a;
    if (p.operations[step]?.status !== 'confirmed') {
      const shares = (holder ? p.holderReleases ?? [] : p.releases).filter(s => s.winner === decision.winner && s.outcome === decision.outcome).map(s => ({ id: s.id, share: BigInt(s.share) }));
      if (shares.length < p.registry.params.k) return;
      a = this.#need(this.adapters.edvss, 'reconstruct')(shares, p.registry.params.k, lock.C);
      if (this.#need(this.adapters.edvss, 'publicOf')(a) !== lock.A) throw lockError('invalid_share');
    }
    if (p.post.product === 'put' && !holder && p.operations[step]?.status !== 'confirmed') {
      const settlement = await this.adapters.escrowSettlement?.(p);
      if (settlement?.ok && settlement.status === 'refunded' && await this.adapters.escrowBalance(p.lock.A) === '0') {
        p.operations[step] ??= { id: sha256Hex(`intercom-locks/v1/intent:${p.positionId}:${step}`), input: { winner: this.me.lockKey } };
        p.operations[step].status = 'confirmed'; p.operations[step].receipt = { ok: true, finalized: true, refunded: true };
        p.escrowStatus = 'refunded'; this.#save(p);
      }
    }
    const receipt = await this.#operation(p, step, { winner: this.me.lockKey }, async id => {
      if (p.post.product === 'put' && !holder) {
        const transaction = await this.#need(this.adapters.escrowLock, 'claimAndSweep')({ a, winnerSol: this.me.sol, mint: this.adapters.mint,
          amount: p.post.terms.strikeTotal, existingBalance: this.adapters.escrowBalance ? await this.adapters.escrowBalance(p.lock.A) : '0', escrowPreimage: p.post.escrowPreimage, preimageHex: p.post.escrowPreimage,
          tradeFeeCollector: p.registry.fee.escrowCollector, programId: this.adapters.programId });
        return this.#need(this.adapters, 'submit')({ id, transaction, scalar: a, position: clone(p), step });
      }
      const signer = scalarSigner(a), wallet = { ...signer, address: tracLock.address(signer.publicKey) };
      const adapter = this.adapters.tracFor ? await this.adapters.tracFor(wallet) : this.adapters.trac;
      const result = await this.#need(this.adapters.tracLock, 'sweep')({ a, to: this.me.trac, adapter,
        positionId: p.positionId, journal: this.store, asset: assetOf(p) });
      return { ...result, finalized: result.ok === true };
    });
    if (receipt?.ok !== true) throw lockError('sweep_pending');
    p.collected ??= {};
    if (!p.collected[step]) { p.collected[step] = this.now(); p.collectedAt = this.now(); }
    this.#save(p); this.#collected(p);
    await this.#receipts(p);
    if (p.state === 'released' && !this.pickupTimers.has(p.positionId)) await this.#leave(p);
    if (holder && decision.outcome === 'unfunded') {
      (p.failedTakes ??= []).push({ takeId: p.takeId, holderLock: p.holderLock, outcome: 'unfunded' });
      for (const key of ['takeId', 'taker', 'takeAnchor', 'takingAt', 'holderId', 'holderLock', 'holderFunded', 'holderReleases', 'holderDecision']) delete p[key];
      for (const key of ['reserve', 'opened', 'holderReady', 'holderRelease']) delete p.votes[key];
      this.#change(p, 'posted'); this.book.set(p.positionId, p);
    }
  }
  onClock() { return this.#serial(async () => {
    const counted = await this.#height();
    if (this.clock?.M && this.medianFor !== counted) { try { this.median = await this.clock.M(counted); this.medianFor = counted; } catch {} }
    const pickup = [...this.positions.active.values()].filter(p => this.#own(p) && ['posted', 'running'].includes(p.state) && this.now() - (p.lastReleaseRequest ?? -Infinity) >= 60)
      .sort((a, b) => (a.lastReleaseRequest ?? 0) - (b.lastReleaseRequest ?? 0))[0];
    if (pickup) await this.requestRelease(pickup.positionId);
    for (const p of this.positions.active.values()) {
      if (!this.#own(p) || p.state === 'released') continue;
      try {
        if (p.state === 'creating' && this.now() >= p.post.createdAt + p.registry.params.dkgTimeoutSec + 30) {
          p.reason = 'dkg_failed'; this.#change(p, 'ended:unfunded'); await this.#leave(p); continue;
        }
        if (p.operations.refund?.status === 'pending') await this.#refund(p);
        await this.#lapse(p);
        if (p.state.startsWith('ended:')) {
          await this.requestRelease(p.positionId);
          // Moving the released coins out of the lock is not a payment: say so while its transfer confirms.
          try { await this.#sweep(p); await this.#sweep(p, true); } catch (error) { throw error?.reason === 'payment_pending' ? lockError('collect_pending') : error; }
          continue;
        }
        if (p.state === 'funding' && p.lock && !p.funded) { await this.#fund(p); continue; }
        if (p.state === 'taking') {
          if (p.post.product === 'put' && p.holderLock && !p.holderFunded) await this.#fund(p, true);
          else if (p.votes.reserve?.length >= p.registry.params.k) await this.#openPayment(p);
          continue;
        }
        if (p.state === 'posted' && counted >= p.post.terms.offerUntilBlock) { await this.requestRelease(p.positionId); continue; }
        if (p.state !== 'running') continue;
        const paidStep = p.post.product === 'loan' ? 'repay' : 'exercise';
        if (p.operations[paidStep]?.status === 'pending') { await this.#pay(p, paidStep); continue; }
        const left = deadlineOf(p) - counted, product = p.post.product;
        if (left <= 0) { await this.requestRelease(p.positionId); continue; }
        if (product === 'loan' && this.settings.autoRepay && p.post.maker.lockKey === this.me.lockKey && left <= this.settings.repayBlocksBefore) {
          if (p.operations.repay?.status !== 'confirmed') await this.#pay(p, 'repay');
        } else if (product !== 'loan' && this.settings.autoExercise && p.taker?.lockKey === this.me.lockKey && left <= this.settings.exerciseBlocksBefore) {
          const price = await this.#need(this.adapters, 'lastPrice')(assetOf(p));
          if (p.operations.exercise?.status !== 'confirmed' && inTheMoney(p, price, this.settings.exerciseMarginBps)) await this.#pay(p, 'exercise');
        }
      } catch (error) {
        const result = errorResult(error);
        if (p.reason !== result.reason) { p.reason = result.reason; this.#save(p); this.#event('attention', p, result); }
      }
    }
  }); }
}

export const createLocksClient = options => new LocksClient(options);
