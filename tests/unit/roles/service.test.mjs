import test from 'node:test';
import assert from 'node:assert/strict';
import pkg from '../../../package.json' with { type: 'json' };
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encodeKey, generateIdentity } from '../../../src/core/keys.js';
import { seal } from '../../../src/core/envelope.js';
import { bytesToHex, le32, sha256Hex } from '../../../src/core/canonical.js';
import { split, randomScalar } from '../../../src/core/vss.js';
import { buildTerms, tradeId as termsTradeId } from '../../../src/core/terms.js';
import { selectCommittee } from '../../../src/core/committee.js';
import { openStore } from '../../../src/roles/store.js';
import { IN_FLIGHT_SLACK_SEC, BUSY_TRADES, TICKER_SOON_SEC, SHARE_REQUESTS, Service, MAX_UNPROVEN_WATCHES, UNMATCHED_PER_SENDER } from '../../../src/roles/service.js';
import { RegistryView, nowSec, random32, verifySummon, offerIdOf, SUMMON_SKEW_SEC } from '../../../src/roles/common.js';
import { fixture, tracAddress, hex, SOL, SOL2, MINT, SIG } from '../core/helpers.mjs';

const KEY = randomBytes(32);
const SIGNERS = 'intercom-dex:signers', OFFERS = 'intercom-dex:offers';
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

class FakeBridge extends EventEmitter {
  constructor() { super(); this.sent = []; }
  async setRelays(keys) { this.relays = keys; }
  async join() {}
  async send(ch, envelope) { this.sent.push({ ch, envelope }); }
}

// A service with fake chains (the escrow is claimed, the transfer final) and trades made from one offer.
function setup({ store = null, immediate = false, dir = store ? null : mkdtempSync(join(tmpdir(), 'dex-service-')), f = fixture({ n: 5, k: 3 }), removed = [], clock = { t: nowSec() }, refundSec = 2000 } = {}) {
  const bridge = new FakeBridge(), calls = { escrow: 0 };
  const solana = { assertFeeConfig: async () => {}, checkEscrow: async () => { calls.escrow++; if (!immediate) await settle(); return { ok: true, status: 'claimed' }; },
    settlementSignature: async () => ({ status: 'claimed', signature: '3'.repeat(88) }) };
  const trac = { verifyTransfer: async () => ({ ok: true, final: true }) };
  const { version: _v, issuedAt: _i, ...input } = f.registry;
  const service = new Service({ firstLaunch: true, bridge, identity: { secretKey: encodeKey(f.service.secretKey), publicKey: encodeKey(f.service.publicKey) },
    store: store ?? openStore(dir, KEY), solana, trac, log: () => {}, now: () => clock.t,
    registryInput: { ...input, params: { ...input.params, sendWindowSec: 600, refundSec }, signers: input.signers.filter(x => !removed.some(r => r.dexKey === x.dexKey)), removed } });
  const registry = service.registry, now = clock.t;
  const buyer = encodeKey(f.buyer.publicKey), seller = encodeKey(f.seller.publicKey);
  const offer = { peerKey: hex(), registryVersion: registry.version, software: '0.1.0', pair: 'TNK/USDC', side: 'sell', baseAmount: '3000000000000000000', price: '5', maker: { dexKey: seller, tracAddr: tracAddress(seller), solAddr: SOL2 }, expiresAt: now + 3000 };
  offer.offerId = offerIdOf(offer);
  const trade = (R = hex()) => {
    const committee = selectCommittee(registry, R, { n: 5, k: 3, quoteAmount: '5000000', pair: 'TNK/USDC', exclude: [buyer, seller] }).map(({ dexKey, boxKey }) => ({ dexKey, boxKey }));
    const terms = buildTerms({ offerId: offer.offerId, base: f.terms.base, pair: 'TNK/USDC', baseAmount: '1000000000000000000', quoteAmount: '5000000', mint: MINT,
      seller: { dexKey: seller, tracAddr: tracAddress(seller), solRecipient: SOL2 }, buyer: { dexKey: buyer, tracAddr: tracAddress(buyer), solPayer: SOL },
      registryVersion: registry.version, committee, k: 3, fees: { ...registry.fee, platformFeeBps: 10, platformCollector: SOL },
      sendBy: now + 600, refundAfter: now + refundSec, graceSec: 300, R });
    const id = termsTradeId(terms), secret = randomScalar(), dealt = split(secret, 3, [1, 2, 3, 4, 5]);
    return { terms, id, H: sha256Hex(le32(secret)), shares: dealt.shares.map(p => bytesToHex(le32(p.share))), commitments: dealt.commitments };
  };
  const envelope = (identity, kind, body, ch) => seal({ kind, ch, body }, identity.secretKey, { ts: clock.t, nonce: random32() });
  const member = dexKey => f.signers.find(s => encodeKey(s.identity.publicKey) === dexKey).identity;
  const emit = async (ch, env) => { if (immediate) return service.host.hooks.unrouted[0](ch, env); bridge.emit('message', ch, env); await settle(); };
  const summon = t => emit(SIGNERS, envelope(f.buyer, 'summon', { tradeId: t.id, terms: t.terms, sigs: [
    envelope(f.buyer, 'termsSig', { tradeId: t.id }, `intercom-dex:t:${t.id}`), envelope(f.seller, 'termsSig', { tradeId: t.id }, `intercom-dex:t:${t.id}`)] }, SIGNERS));
  const publish = (t, index, share, from = member(t.terms.committee[index - 1].dexKey)) =>
    emit(SIGNERS, envelope(from, 'sharePublish', { tradeId: t.id, H: t.H, signerIndex: index, share, commitments: t.commitments }, SIGNERS));
  const report = (t, offerId = offer.offerId) =>
    emit(OFFERS, envelope(f.seller, 'settled', { offerId, tradeId: t.id, terms: t.terms, hashHex: t.H, claimSignature: SIG, txHash: hex() }, OFFERS));
  return { f, service, bridge, dir, clock, calls, offer, trade, summon, publish, report, emit, envelope, member };
}

test('a reported settlement is logged once both chains prove it, and published', async () => {
  const s = setup(), t = s.trade();
  await s.service.start(); s.service.stop();
  await s.report(t); await s.report(t);
  await s.service.reconcile();
  assert.equal(s.service.trades.length, 1);
  assert.equal(s.calls.escrow, 1, 'one record per trade, proven once');
  assert.equal(s.service.trades[0].claimSignature, '3'.repeat(88), 'the claim transaction comes from the chain');
  const logged = s.bridge.sent.find(x => x.envelope.kind === 'tradeLog').envelope.body;
  assert.equal(logged.price, '5');
  assert.deepEqual(logged.seller, { tracAddr: t.terms.seller.tracAddr, solAddr: t.terms.seller.solRecipient });
  assert.deepEqual(logged.buyer, { tracAddr: t.terms.buyer.tracAddr, solAddr: t.terms.buyer.solPayer });
});

test('a fee rotation retains old-trade settlement and signer credits, accounted separately by collector', async () => {
  const s = setup({ immediate: true }), old = s.trade();
  await s.service.start(); s.service.stop();
  await s.summon(old);
  const next = await s.service.publishFees({ ...s.service.registry.fee, collector: SOL, tradeFeeBps: 75, signerShareBps: 6000 });
  const fresh = s.trade();
  fresh.terms = buildTerms({ ...fresh.terms, registryVersion: next.version, fees: { ...next.fee, platformCollector: SOL } });
  fresh.id = termsTradeId(fresh.terms);
  await s.summon(fresh);
  for (const t of [old, fresh]) {
    for (const i of [1, 2, 3]) await s.publish(t, i, t.shares[i - 1]);
    await s.report(t);
  }
  s.clock.t = old.terms.refundAfter + 300; await s.service.reconcile();
  assert.equal(s.service.trades.length, 2);
  const accounting = s.service.status().feeAccounting;
  assert.deepEqual(accounting[SOL2], { tradeFeeBps: 50, fees: '25000', signerCredits: '12498', trades: 1 });
  assert.deepEqual(accounting[SOL], { tradeFeeBps: 75, fees: '37500', signerCredits: '22500', trades: 1 });
  const credits = Object.values(s.service.payouts).flat();
  assert.equal(credits.filter(c => c.collector === SOL2 && c.amount === '4166').length, 3);
  assert.equal(credits.filter(c => c.collector === SOL && c.amount === '7500').length, 3);
  const restarted = setup({ dir: s.dir, f: s.f, clock: s.clock });
  assert.equal(restarted.service.registry.version, 2);
  assert.deepEqual(restarted.service.status().feeAccounting, accounting);
});

test('48-hour watch and envelope retention accepts late copies of original shares, with credits only after refundAfter', async () => {
  const f = fixture(); f.registry.params.refundSec = 172800;
  const s = setup({ f, refundSec: 172800, immediate: true }), trade = s.trade();
  await s.service.start(); s.service.stop();
  const sigs = [s.f.buyer, s.f.seller].map(id => s.envelope(id, 'termsSig', { tradeId: trade.id }, `intercom-dex:t:${trade.id}`));
  assert.equal(verifySummon({ tradeId: trade.id, terms: trade.terms, sigs }, s.service.registry, s.clock.t).lifetimeSec, 176400);
  await s.summon(trade);
  const shares = [1, 2, 3].map(index => s.envelope(s.member(trade.terms.committee[index - 1].dexKey), 'sharePublish', {
    tradeId: trade.id, H: trade.H, signerIndex: index, share: trade.shares[index - 1], commitments: trade.commitments }, SIGNERS));
  s.clock.t += 47 * 3600;
  for (const envelope of shares) await s.emit(SIGNERS, envelope);
  assert.ok(s.service.store.get(`watch-${trade.id}`));
  await s.report(trade); await s.service.reconcile(); assert.deepEqual(s.service.payouts, {});
  s.clock.t = trade.terms.refundAfter + 300; await s.service.reconcile();
  assert.equal(Object.keys(s.service.payouts).length, 3);
});

test('credits go only to signers whose share verifies against the dealing, decided after the refund time', async () => {
  const s = setup(), t = s.trade();
  await s.service.start(); s.service.stop();
  await s.publish(t, 1, t.shares[0]);                                        // before the summon: kept and merged later
  await s.summon(t);
  await s.publish(t, 2, t.shares[1]); await s.publish(t, 3, t.shares[2]);
  await s.publish(t, 4, bytesToHex(le32(randomScalar())));                  // a wrong share
  await s.publish(t, 5, t.shares[4], s.member(t.terms.committee[0].dexKey)); // index 5 sent by someone else
  await s.report(t); await s.service.reconcile();
  assert.deepEqual(s.service.payouts, {}, 'nothing is decided before the refund time');
  s.clock.t = t.terms.refundAfter + 300;
  await s.service.reconcile();
  assert.deepEqual(Object.keys(s.service.payouts).sort(), t.terms.committee.slice(0, 3).map(m => m.dexKey).sort());
});

test('one escrow is logged for one trade only', async () => {
  const s = setup(), a = s.trade(), b = s.trade();
  b.H = a.H;
  await s.service.start(); s.service.stop();
  await s.report(a); await s.service.reconcile();
  await s.report(b); await s.service.reconcile();
  assert.equal(s.service.trades.length, 1);
  assert.equal(s.service.settlements.has(b.id), false);
});

test('a settlement fills only the offer named in its signed terms, and the fill survives a restart', async () => {
  const s = setup(), clock = s.clock;
  await s.service.start(); s.service.stop();
  const other = { ...s.offer, expiresAt: s.offer.expiresAt + 1 }; other.offerId = offerIdOf(other);
  for (const o of [s.offer, other]) await s.emit(OFFERS, s.envelope(s.f.seller, 'offer', o, OFFERS));
  await s.report(s.trade(), other.offerId); await s.service.reconcile();
  assert.equal(s.service.book.get(other.offerId, clock.t).remaining, 3000000000000000000n, 'not the offer of these terms');
  await s.report(s.trade()); await s.service.reconcile();
  assert.equal(s.service.book.get(s.offer.offerId, clock.t).remaining, 2000000000000000000n);
  const again = setup({ dir: s.dir, f: s.f, clock });
  await again.service.start(); again.service.stop();
  await again.emit(OFFERS, again.envelope(again.f.seller, 'offer', s.offer, OFFERS));
  assert.equal(again.service.book.get(s.offer.offerId, clock.t).remaining, 2000000000000000000n);
});

test('a restart continues a pending settlement, and a removed signer forfeits its unpaid credits', async () => {
  const s = setup(), t = s.trade();
  await s.service.start(); s.service.stop();
  await s.summon(t);
  for (const i of [1, 2, 3]) await s.publish(t, i, t.shares[i - 1]);
  s.service.solana.checkEscrow = async () => { throw new Error('RPC unavailable'); };
  await s.report(t);
  const gone = t.terms.committee[0].dexKey;
  const again = setup({ dir: s.dir, f: s.f, clock: s.clock, removed: [{ dexKey: gone, removedAt: s.clock.t, reason: 'test' }] });
  s.clock.t = t.terms.refundAfter + 300;
  await again.service.reconcile();
  await again.service.reconcile();
  assert.equal(again.service.trades.length, 1);
  assert.equal(again.service.payouts[gone][0].forfeited, 'test');
  assert.equal(again.service.payouts[t.terms.committee[1].dexKey][0].forfeited, false);
});

test('a summon is refused unless its committee is the registry selection and its fees are the registry fees', () => {
  const s = setup(), t = s.trade(), reg = s.service.registry, now = s.clock.t;
  const sigs = [s.envelope(s.f.buyer, 'termsSig', { tradeId: t.id }, `intercom-dex:t:${t.id}`), s.envelope(s.f.seller, 'termsSig', { tradeId: t.id }, `intercom-dex:t:${t.id}`)];
  assert.equal(verifySummon({ tradeId: t.id, terms: t.terms, sigs }, reg, now).tradeId, t.id);
  const swapped = buildTerms({ ...t.terms, committee: [...t.terms.committee].reverse() });
  assert.throws(() => verifySummon({ tradeId: termsTradeId(swapped), terms: swapped, sigs }, reg, now), /registry selection/);
  const cheap = buildTerms({ ...t.terms, fees: { ...t.terms.fees, tradeFeeBps: 1 } });
  assert.throws(() => verifySummon({ tradeId: termsTradeId(cheap), terms: cheap, sigs }, reg, now), /follow the registry/);
  assert.throws(() => verifySummon({ tradeId: t.id, terms: t.terms, sigs: [sigs[0], sigs[0]] }, reg, now), /both traders|Repeated/);
});

test('a registry view never goes back to an older version, even after a restart, and pauses on equivocation', () => {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), 'dex-registry-')), key = encodeKey(f.service.publicKey);
  const msg = registry => ({ kind: 'registry', from: key, body: registry });
  const v1 = f.registry, v2 = { ...f.registry, version: 2, issuedAt: 20 };
  const view = new RegistryView(key, openStore(dir, KEY));
  assert.equal(view.offer(msg(v2), 100), true);
  const again = new RegistryView(key, openStore(dir, KEY));
  assert.equal(again.offer(msg(v1), 100), false);
  assert.equal(again.current.version, 2);
  assert.equal(again.offer(msg({ ...v2, version: 3, issuedAt: 1000 }), 100), false, 'issued in the future');
  assert.equal(again.offer(msg({ ...v2, fee: { ...v2.fee, tradeFeeBps: 60 } }), 100), false);
  assert.equal(again.usable, null);
  assert.ok(new RegistryView(key, openStore(dir, KEY)).conflict, 'the conflict is remembered');
});

test('a different registry under an earlier version is caught as equivocation', () => {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), 'dex-registry-')), key = encodeKey(f.service.publicKey);
  const msg = registry => ({ kind: 'registry', from: key, body: registry });
  const view = new RegistryView(key, openStore(dir, KEY));
  assert.equal(view.offer(msg(f.registry), 100), true);
  assert.equal(view.offer(msg({ ...f.registry, version: 2, issuedAt: 20 }), 100), true);
  assert.equal(view.offer(msg({ ...f.registry, fee: { ...f.registry.fee, tradeFeeBps: 60 } }), 100), false);
  assert.ok(view.conflict); assert.equal(view.usable, null);
});

test('a settlement proven before its offer is seen fills that offer once it arrives', async () => {
  const s = setup();
  await s.service.start(); s.service.stop();
  await s.report(s.trade()); await s.service.reconcile();
  assert.equal(s.service.trades.length, 1);
  await s.emit(OFFERS, s.envelope(s.f.seller, 'offer', s.offer, OFFERS));
  assert.equal(s.service.book.get(s.offer.offerId, s.clock.t).remaining, 2000000000000000000n);
});

test('share messages re-sent long after they were signed still count, once per index', async () => {
  const s = setup(), t = s.trade();
  await s.service.start(); s.service.stop();
  const signedAt = s.clock.t;
  const old = [1, 2, 3].map(i => s.envelope(s.member(t.terms.committee[i - 1].dexKey), 'sharePublish',
    { tradeId: t.id, H: t.H, signerIndex: i, share: t.shares[i - 1], commitments: t.commitments }, SIGNERS));
  s.clock.t = signedAt + 900;                                                  // the service was away for 15 minutes
  await s.report(t); await s.service.reconcile();
  for (const env of [...old, ...old]) await s.emit(SIGNERS, env);
  s.clock.t = t.terms.refundAfter + 300;
  await s.service.reconcile();
  assert.equal(Object.keys(s.service.payouts).length, 3);
  for (const list of Object.values(s.service.payouts)) assert.equal(list.length, 1);
});

test('settlement proof applies the whole registry policy, and publishes the trade log once', async () => {
  const s = setup(), t = s.trade(), loose = buildTerms({ ...t.terms, k: 1 });
  await s.service.start(); s.service.stop();
  await s.emit(OFFERS, s.envelope(s.f.seller, 'settled', { offerId: s.offer.offerId, tradeId: termsTradeId(loose), terms: loose, hashHex: t.H, txHash: hex() }, OFFERS));
  await s.service.reconcile();
  assert.equal(s.service.settlements.has(termsTradeId(loose)), false);
  await s.report(t);
  s.clock.t = t.terms.refundAfter + 300;
  await s.service.reconcile(); await s.service.reconcile();
  assert.equal(s.bridge.sent.filter(x => x.envelope.kind === 'tradeLog').length, 1);
});

test('a logged trade without a watch gets one, and a store from the earlier layout is refused', async () => {
  const s = setup(), t = s.trade();
  await s.service.start(); s.service.stop();
  await s.report(t); await s.service.reconcile();
  s.service.store.delete(`watch-${t.id}`);
  const again = setup({ dir: s.dir, f: s.f, clock: s.clock });
  await again.service.reconcile();
  assert.ok(again.service.store.get(`watch-${t.id}`));
  again.service.store.put('service-trades', []);
  assert.throws(() => setup({ dir: s.dir, f: s.f, clock: s.clock }), /earlier layout/);
});

test('an equivocation that could not be stored is stored with the next registry message', () => {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), 'dex-registry-')), key = encodeKey(f.service.publicKey);
  const msg = registry => ({ kind: 'registry', from: key, body: registry });
  const store = openStore(dir, KEY), put = store.put;
  const view = new RegistryView(key, store);
  assert.equal(view.offer(msg(f.registry), 100), true);
  const other = { ...f.registry, fee: { ...f.registry.fee, tradeFeeBps: 60 } };
  store.put = (name, value) => { if (name === 'registry-conflict') { store.put = put; throw new Error('disk busy'); } return put(name, value); };
  assert.throws(() => view.offer(msg(other), 100));
  assert.equal(view.usable, null, 'paused even though not stored yet');
  view.offer(msg(other), 100);
  assert.ok(new RegistryView(key, openStore(dir, KEY)).conflict);
});

test('a share counts by when the service received it, not by the time its signer wrote into it', async () => {
  const s = setup(), t = s.trade();
  await s.service.start(); s.service.stop();
  await s.summon(t);
  for (const i of [1, 2, 3]) await s.publish(t, i, t.shares[i - 1]);
  const backdated = s.envelope(s.member(t.terms.committee[3].dexKey), 'sharePublish',
    { tradeId: t.id, H: t.H, signerIndex: 4, share: t.shares[3], commitments: t.commitments }, SIGNERS);
  await s.report(t); await s.service.reconcile();
  s.clock.t = t.terms.refundAfter + 200;
  await s.emit(SIGNERS, backdated);
  s.clock.t = t.terms.refundAfter + 300;
  await s.service.reconcile();
  assert.equal(Object.keys(s.service.payouts).length, 3);
});

test('a share whose write failed is taken from the signer re-sending the same message', async () => {
  const s = setup(), t = s.trade();
  await s.service.start(); s.service.stop();
  await s.summon(t);
  const env = s.envelope(s.member(t.terms.committee[0].dexKey), 'sharePublish',
    { tradeId: t.id, H: t.H, signerIndex: 1, share: t.shares[0], commitments: t.commitments }, SIGNERS);
  const put = s.service.store.put;
  s.service.store.put = (name, value) => { if (name.startsWith('watch-')) { s.service.store.put = put; throw new Error('disk busy'); } return put(name, value); };
  s.bridge.emit('message', SIGNERS, env); await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(s.service.store.get(`watch-${t.id}`).shares, {});
  await s.emit(SIGNERS, env);
  assert.ok(s.service.store.get(`watch-${t.id}`).shares[1]);
});

test('one seller cannot fill the queue of unproven reports', async () => {
  const s = setup();
  await s.service.start(); s.service.stop();
  s.service.solana.checkEscrow = async () => { throw new Error('RPC unavailable'); };
  for (let i = 0; i < 52; i++) await s.report(s.trade());
  assert.equal([...s.service.settlements.values()].filter(r => r.status === 'pending').length, 50);
});

function memoryStore() {
  const records = new Map();
  return {
    get: name => structuredClone(records.get(name) ?? null),
    put: (name, value) => records.set(name, structuredClone(value)),
    delete: name => records.delete(name),
    list: prefix => [...records.keys()].filter(name => name.startsWith(prefix)),
  };
}

async function fastSetup(options = {}) {
  const s = setup({ store: memoryStore(), immediate: true, ...options });
  await s.service.start(); s.service.stop();
  return s;
}

const publication = (s, t, i) => s.envelope(s.member(t.terms.committee[i - 1].dexKey), 'sharePublish',
  { tradeId: t.id, H: t.H, signerIndex: i, share: t.shares[i - 1], commitments: t.commitments }, SIGNERS);
const threeShares = async (s, t) => { for (const i of [1, 2, 3]) await s.publish(t, i, t.shares[i - 1]); };
const creditKeys = s => Object.keys(s.service.payouts).sort();
const expectedKeys = t => t.terms.committee.slice(0, 3).map(m => m.dexKey).sort();
const fillWatchMap = s => {
  for (let i = 0; i < MAX_UNPROVEN_WATCHES; i++) { s.service.watched.set(`capacity-${i}`, s.clock.t + 30 * 86400); s.service.unproven.set(`capacity-${i}`, s.clock.t + 86400); }
};
const freeWatch = (s, id = 'capacity-0') => { s.service.watched.delete(id); s.service.unproven.delete(id); };
const summonFor = (s, terms) => {
  const id = termsTradeId(terms), ch = `intercom-dex:t:${id}`;
  return { tradeId: id, terms, sigs: [s.envelope(s.f.buyer, 'termsSig', { tradeId: id }, ch), s.envelope(s.f.seller, 'termsSig', { tradeId: id }, ch)] };
};

test('a different signed publication with the same nonce has its own receipt time', async () => {
  const s = await fastSetup(), t = s.trade(), early = s.clock.t;
  await s.summon(t); await threeShares(s, t);
  const from = s.member(t.terms.committee[3].dexKey), original = publication(s, t, 4);
  const unrelated = seal({ kind: 'sharePublish', ch: SIGNERS, body: { ...original.body, tradeId: hex() } }, from.secretKey,
    { ts: early, nonce: original.nonce });
  await s.emit(SIGNERS, unrelated);
  s.clock.t = t.terms.refundAfter + 1;
  const late = seal({ kind: 'sharePublish', ch: SIGNERS, body: original.body }, from.secretKey, { ts: s.clock.t, nonce: original.nonce });
  await s.emit(SIGNERS, late);
  assert.equal(s.service.store.get(`watch-${t.id}`).shares[4], undefined);
  await s.report(t); s.clock.t += 300; await s.service.reconcile();
  assert.deepEqual(creditKeys(s), expectedKeys(t));
  for (const key of expectedKeys(t)) assert.equal(s.service.payouts[key][0].amount, '4166');
});

test('an exact retry after a failed durable write keeps its pre-cutoff receipt', async () => {
  const s = await fastSetup(), t = s.trade(), at = s.clock.t, env = publication(s, t, 1);
  await s.summon(t);
  const put = s.service.store.put;
  s.service.store.put = (name, value) => { if (name === `watch-${t.id}`) throw Error('disk busy'); return put(name, value); };
  await assert.rejects(s.emit(SIGNERS, env), /disk busy/);
  s.service.store.put = put; s.clock.t = t.terms.refundAfter + 1;
  await s.emit(SIGNERS, env); await s.emit(SIGNERS, env);
  const w = s.service.store.get(`watch-${t.id}`);
  assert.equal(w.shares[1].at, at); assert.equal(Object.keys(w.shares).length, 1);
});

test('pre-watch retransmissions count once and preserve all timely publishers', async () => {
  const s = await fastSetup(), t = s.trade(), env = publication(s, t, 1), at = s.clock.t;
  for (let i = 0; i < 64; i++) await s.emit(SIGNERS, env);
  s.clock.t = t.terms.refundAfter - 1;
  await s.emit(SIGNERS, publication(s, t, 1)); // same body, fresh nonce: still the same publication
  await s.publish(t, 2, t.shares[1]); await s.publish(t, 3, t.shares[2]);
  const u = s.service.store.get(`unmatched-${t.id}`);
  assert.equal(u.messages.length, 3); assert.equal(u.messages[0].receivedAt, at);
  assert.equal(s.service.unmatchedCounts.get(env.from), 1);
  s.clock.t = t.terms.refundAfter + 301;
  await s.report(t); await s.service.reconcile();
  assert.deepEqual(creditKeys(s), expectedKeys(t));
  assert.equal(s.service.store.get(`unmatched-${t.id}`), null);
});

test('unmatched shares are kept only from registry signers, capped per sender and record', async () => {
  const s = await fastSetup(), t = s.trade(), outsider = generateIdentity(), flooder = s.member(t.terms.committee[4].dexKey);
  for (let i = 0; i < 3; i++) await s.emit(SIGNERS, s.envelope(outsider, 'sharePublish', { ...publication(s, t, 1).body, H: hex() }, SIGNERS));
  assert.equal(s.service.store.get(`unmatched-${t.id}`), null, 'a key outside every registry stores nothing');
  for (let i = 0; i <= UNMATCHED_PER_SENDER; i++) await s.emit(SIGNERS, s.envelope(flooder, 'sharePublish',
    { ...publication(s, t, 1).body, H: hex() }, SIGNERS));
  assert.equal(s.service.store.get(`unmatched-${t.id}`).messages.length, UNMATCHED_PER_SENDER);
  await threeShares(s, t);
  assert.equal(s.service.store.get(`unmatched-${t.id}`).messages.length, UNMATCHED_PER_SENDER + 3);
  // The sender-wide bound is independent of another sender's allowance.
  s.service.unmatchedCounts.set(encodeKey(flooder.publicKey), 5000);
  let other;
  do other = s.trade(); while (other.terms.committee[0].dexKey === encodeKey(flooder.publicKey));
  await s.emit(SIGNERS, s.envelope(flooder, 'sharePublish', publication(s, other, 1).body, SIGNERS));
  assert.equal(s.service.store.get(`unmatched-${other.id}`), null);
  await s.publish(other, 1, other.shares[0]);
  assert.equal(s.service.store.get(`unmatched-${other.id}`).messages.length, 1);
  s.clock.t = t.terms.refundAfter + 301; await s.report(t);
  assert.deepEqual(creditKeys(s), expectedKeys(t));
});

for (const pending of [false, true]) {
  test(`archived evidence survives restart ${pending ? 'with a pending report' : 'before a late report'}`, async () => {
    const s = await fastSetup(), t = s.trade();
    await s.summon(t); await threeShares(s, t);
    if (pending) {
      s.service.solana.checkEscrow = async () => ({ ok: false, status: 'pending' });
      await s.report(t);
      assert.equal(s.service.settlements.get(t.id).status, 'pending');
    }
    s.clock.t = t.terms.refundAfter + 8 * 86400 + 1;
    const later = await fastSetup({ store: s.service.store, f: s.f, clock: s.clock });
    await later.summon(later.trade());
    assert.equal(later.service.watched.has(t.id), false);
    assert.equal(later.service.store.get(`watch-${t.id}`), null);
    const archive = later.service.store.get(`watcharchive-${t.id}`);
    assert.equal(Object.keys(archive.shares).length, 3); assert.ok(archive.summon.sigs);
    assert.deepEqual(archive.terms, t.terms);
    const again = await fastSetup({ store: s.service.store, f: s.f, clock: s.clock });
    if (!pending) { s.clock.t += 100 * 86400; await again.report(t); }
    await again.service.reconcile();
    assert.deepEqual(creditKeys(again), expectedKeys(t));
    assert.ok(again.service.store.get(`watcharchive-${t.id}`), 'kept while credits are provisional');
    s.clock.t += 7 * 86400; await again.service.reconcile();
    assert.equal(again.service.settlements.get(t.id).creditsFinal, true);
    assert.equal(again.service.store.get(`watcharchive-${t.id}`), null);
  });
}

test('failed archive writes and failed active-copy deletion preserve evidence', async () => {
  for (const failAt of ['archive', 'delete']) {
    const s = await fastSetup(), t = s.trade(); await s.summon(t); await threeShares(s, t);
    s.clock.t = t.terms.refundAfter + 8 * 86400 + 1;
    const later = await fastSetup({ store: s.service.store, f: s.f, clock: s.clock });
    const put = s.service.store.put, remove = s.service.store.delete;
    s.service.store.put = (name, value) => { if (failAt === 'archive' && name === `watcharchive-${t.id}`) throw Error('disk busy'); return put(name, value); };
    s.service.store.delete = name => { if (failAt === 'delete' && name === `watch-${t.id}`) throw Error('disk busy'); return remove(name); };
    await later.summon(later.trade());
    assert.equal(later.service.watched.has(t.id), true);
    assert.equal(Object.keys(s.service.store.get(`watch-${t.id}`).shares).length, 3);
    s.service.store.put = put; s.service.store.delete = remove;
    await later.summon(later.trade());
    assert.equal(later.service.watched.has(t.id), false);
    assert.equal(Object.keys(s.service.store.get(`watcharchive-${t.id}`).shares).length, 3);
  }
});

test('a logged settlement gets its watch and credits while unproven watches fill the capacity', async () => {
  const s = await fastSetup(), t = s.trade(); await threeShares(s, t); fillWatchMap(s);
  s.clock.t = t.terms.refundAfter + 301;
  await s.report(t);
  assert.equal(s.service.settlements.get(t.id).status, 'logged');
  assert.equal(s.service.waitingForWatch.has(t.id), false);
  assert.equal(s.service.watched.has(t.id), true); assert.equal(s.service.unproven.has(t.id), false);
  assert.equal(s.service.unproven.size, MAX_UNPROVEN_WATCHES);
  assert.deepEqual(creditKeys(s), expectedKeys(t));
  assert.equal(s.service.store.get(`unmatched-${t.id}`), null);
});

test('a summon watch becomes proven with its settlement, and survives a restart as proven', async () => {
  const s = await fastSetup(), t = s.trade(); await s.summon(t);
  assert.equal(s.service.unproven.get(t.id), t.terms.sendBy + t.terms.graceSec);
  await s.report(t);
  assert.equal(s.service.unproven.has(t.id), false); assert.equal(s.service.watched.has(t.id), true);
  const again = await fastSetup({ store: s.service.store, f: s.f, clock: s.clock });
  assert.equal(again.service.watched.has(t.id), true); assert.equal(again.service.unproven.has(t.id), false);
});

test('a full unproven capacity archives an expired watch without a report, never one with a report', async () => {
  const s = await fastSetup(); fillWatchMap(s);
  s.service.unproven.set('capacity-7', s.clock.t - 1);
  s.service.unproven.set('capacity-8', s.clock.t - 1); s.service.settlements.set('capacity-8', { tradeId: 'capacity-8', status: 'pending' });
  const first = s.trade(); await s.summon(first);
  assert.equal(s.service.watched.has(first.id), true); assert.equal(s.service.watched.has('capacity-7'), false);
  assert.equal(s.service.unproven.size, MAX_UNPROVEN_WATCHES);
  const second = s.trade(); await s.summon(second);
  assert.equal(s.service.watched.has(second.id), false); assert.ok(s.service.store.get(`watchwait-${second.id}`));
  assert.equal(s.service.watched.has('capacity-8'), true);
});

test('signers and the venue accept a summon only inside the registry send window', async () => {
  const s = await fastSetup(), t = s.trade(), reg = s.service.registry, now = s.clock.t, p = reg.params;
  const shifted = (sendBy, refundAfter = sendBy + p.refundSec - p.sendWindowSec) => buildTerms({ ...t.terms, sendBy, refundAfter });
  const ok = shifted(now + p.sendWindowSec + SUMMON_SKEW_SEC);
  assert.equal(verifySummon(summonFor(s, ok), reg, now).tradeId, termsTradeId(ok));
  for (const terms of [shifted(now + p.sendWindowSec + SUMMON_SKEW_SEC + 1), shifted(now + 365 * 86400), shifted(now),
    shifted(now + 600, now + 600 + p.refundSec - p.sendWindowSec + 1)]) {
    assert.throws(() => verifySummon(summonFor(s, terms), reg, now), /outside the registry window/);
    await s.emit(SIGNERS, s.envelope(s.f.buyer, 'summon', summonFor(s, terms), SIGNERS));
    assert.equal(s.service.watched.has(termsTradeId(terms)), false);
  }
  await s.emit(SIGNERS, s.envelope(s.f.buyer, 'summon', summonFor(s, ok), SIGNERS));
  assert.equal(s.service.watched.has(termsTradeId(ok)), true);
});

test('a verified watch waiting for capacity protects unmatched evidence without a report, across restart', async () => {
  const s = await fastSetup(), t = s.trade(); await threeShares(s, t); fillWatchMap(s);
  await s.summon(t);
  assert.ok(s.service.store.get(`watchwait-${t.id}`));
  const again = await fastSetup({ store: s.service.store, f: s.f, clock: s.clock });
  fillWatchMap(again); s.clock.t += 2 * 86400;
  await again.publish(again.trade(), 1, t.shares[0]);
  assert.equal(again.service.store.get(`unmatched-${t.id}`).messages.length, 3);
  freeWatch(again); await again.service.reconcile();
  assert.equal(Object.keys(again.service.store.get(`watch-${t.id}`).shares).length, 3);
});

test('failed evidence import retains the source and retries before credits finalize', async () => {
  const s = await fastSetup(), t = s.trade(); await threeShares(s, t);
  s.clock.t = t.terms.refundAfter + 301;
  const put = s.service.store.put;
  s.service.store.put = (name, value) => { if (name === `watch-${t.id}` && value.shares[2]) throw Error('disk busy'); return put(name, value); };
  await s.report(t);
  assert.equal(s.service.store.get(`unmatched-${t.id}`).messages.length, 3);
  assert.equal(s.service.settlements.get(t.id).credits, null);
  s.service.store.put = put; await s.service.reconcile();
  assert.deepEqual(creditKeys(s), expectedKeys(t));
  assert.equal(s.service.store.get(`unmatched-${t.id}`), null);
});

test('100 identities with 51 fabricated reports each occupy no slots; honest proof still logs', async () => {
  const s = await fastSetup(), template = s.trade(), check = s.service.solana.checkEscrow;
  s.service.solana.checkEscrow = async () => { s.calls.escrow++; return { ok: false, status: 'missing' }; };
  for (let seller = 0; seller < 100; seller++) {
    const identity = generateIdentity(), dexKey = encodeKey(identity.publicKey);
    for (let i = 0; i < 51; i++) {
      const R = hex(), committee = selectCommittee(s.service.registry, R, { n: 5, k: 3, quoteAmount: template.terms.quoteAmount, pair: template.terms.pair,
        exclude: [template.terms.buyer.dexKey, dexKey] }).map(({ dexKey, boxKey }) => ({ dexKey, boxKey }));
      const terms = buildTerms({ ...template.terms, seller: { ...template.terms.seller, dexKey, tracAddr: tracAddress(dexKey) }, R, committee });
      await s.emit(OFFERS, s.envelope(identity, 'settled', { offerId: s.offer.offerId, tradeId: termsTradeId(terms), terms, hashHex: hex(), txHash: hex() }, OFFERS));
    }
  }
  assert.equal(s.calls.escrow, 5100); assert.equal(s.service.settlements.size, 0);
  assert.deepEqual(s.service.store.list('settle-'), []);
  s.service.solana.checkEscrow = check; await s.report(template);
  assert.equal(s.service.trades.length, 1);
  assert.equal(s.bridge.sent.filter(x => x.envelope.kind === 'tradeLog').length, 1);
});

for (const stage of ['escrow', 'transfer', 'claim']) {
  test(`${stage} read failures stay pending and recover; successful negative reads leave no record`, async () => {
    const s = await fastSetup(), t = s.trade();
    const target = stage === 'transfer' ? s.service.trac : s.service.solana;
    const method = { escrow: 'checkEscrow', transfer: 'verifyTransfer', claim: 'settlementSignature' }[stage], original = target[method];
    const failures = stage === 'transfer' ? [{ ok: false, final: false, reason: 'read_failed' }, { ok: false, final: false, reason: 'verification_failed' }] : [{ ok: false, status: 'pending' }];
    for (const failed of failures) {
      target[method] = async () => failed; await s.report(t); await s.service.reconcile();
      assert.equal(s.service.settlements.get(t.id).status, 'pending');
      assert.equal(s.service.trades.length, 0);
    }
    target[method] = original; await s.service.reconcile();
    assert.equal(s.service.trades.length, 1);
    assert.equal(s.bridge.sent.filter(x => x.envelope.kind === 'tradeLog').length, 1);
    const absent = s.trade();
    target[method] = async () => stage === 'claim' ? null : stage === 'transfer' ? { ok: false, final: false, reason: 'unknown_or_not_final' } : { ok: false, status: 'mismatch' };
    await s.report(absent);
    assert.equal(s.service.settlements.has(absent.id), false);
    assert.equal(s.service.store.get(`settle-${absent.id}`), null);
  });
}

test('pending proof later disproved releases its slot but keeps the archive, and fresh resend can prove it', async () => {
  const s = await fastSetup(), t = s.trade(), check = s.service.solana.checkEscrow;
  await s.summon(t); await threeShares(s, t);
  s.service.store.put(`watcharchive-${t.id}`, s.service.store.get(`watch-${t.id}`));
  s.service.solana.checkEscrow = async () => { throw Error('offline'); }; await s.report(t);
  s.service.solana.checkEscrow = async () => ({ ok: false, status: 'missing' }); await s.service.reconcile();
  assert.equal(s.service.settlements.has(t.id), false); assert.ok(s.service.store.get(`watcharchive-${t.id}`), 'a rejected report never deletes share evidence');
  s.service.solana.checkEscrow = check; await s.report(t);
  assert.equal(s.service.trades.length, 1);
});

test('the global pending cap is enforced after proof, and does not refuse proven settlements', async () => {
  const s = await fastSetup(), t = s.trade(), check = s.service.solana.checkEscrow;
  for (let i = 0; i < 5000; i++) {
    const id = hex();
    const r = { tradeId: id, status: 'pending', reportedAt: s.clock.t - 3 * 86400, triedAt: s.clock.t,
      report: { terms: t.terms, offerId: s.offer.offerId, hashHex: hex(), txHash: hex() } };
    s.service.settlements.set(id, r); s.service.store.put(`settle-${id}`, r);
  }
  s.service.solana.checkEscrow = async () => ({ ok: false, status: 'pending' }); await s.report(t);
  assert.equal(s.service.settlements.has(t.id), false); assert.equal(s.service.settlements.size, 5000);
  s.service.solana.checkEscrow = check; await s.report(t);
  assert.equal(s.service.trades.length, 1); assert.equal(s.service.settlements.size, 5001);
});

test('concurrent proven reports still log each escrow only once', async () => {
  const s = await fastSetup(), a = s.trade(), b = s.trade(); b.H = a.H;
  await Promise.all([s.report(a), s.report(b), s.report(a)]);
  assert.equal(s.service.trades.length, 1); assert.equal(s.service.settlements.size, 1);
  assert.equal(s.bridge.sent.filter(x => x.envelope.kind === 'tradeLog').length, 1);
});

test('a failed final-credit write cannot delete the archive', async () => {
  const s = await fastSetup(), t = s.trade(); await s.summon(t); await threeShares(s, t); await s.report(t);
  s.service.store.put(`watcharchive-${t.id}`, s.service.store.get(`watch-${t.id}`));
  s.clock.t += 8 * 86400;
  const put = s.service.store.put;
  s.service.store.put = (name, value) => { if (name === `settle-${t.id}` && value.creditsFinal) throw Error('disk busy'); return put(name, value); };
  await s.service.reconcile();
  assert.ok(s.service.store.get(`watcharchive-${t.id}`));
  assert.notEqual(s.service.settlements.get(t.id).creditsFinal, true);
  s.service.store.put = put; await s.service.reconcile();
  assert.equal(s.service.settlements.get(t.id).creditsFinal, true);
  assert.equal(s.service.store.get(`watcharchive-${t.id}`), null);
});

test('paused pairs and a higher software minimum block new market offers while earlier trades still settle', async () => {
  const original = setup(), trade = original.trade();
  await original.service.start(); original.service.stop();
  const changed = structuredClone(original.f.registry);
  changed.minSoftware = '0.2.0'; changed.pairs[0].status = 'paused';
  const next = setup({ dir: original.dir, f: { ...original.f, registry: changed } });
  await next.service.start(); next.service.stop();
  assert.equal(next.service.registry.version, 2); assert.equal(next.service.status().message, 'update required');
  await next.emit(OFFERS, next.envelope(next.f.seller, 'offer', original.offer, OFFERS));
  assert.equal(next.service.book.snapshot('TNK/USDC', next.clock.t).length, 0);
  await next.report(trade); await next.service.reconcile();
  assert.equal(next.service.trades.length, 1); assert.equal(next.service.trades[0].registryVersion, 1);
});

test('service status announces software and latest metadata without starting work from the announcement', async () => {
  const s = setup();
  s.service.latest = { version: '0.2.0', commit: 'a'.repeat(40), sha256: random32() };
  await s.service.start(); s.service.stop();
  const status = s.bridge.sent.find(x => x.envelope.kind === 'status').envelope.body;
  assert.equal(status.software, pkg.version); assert.deepEqual(status.latest, s.service.latest);
  assert.equal(s.service.host.trades.size, 0); assert.equal(s.calls.escrow, 0);
});

test('service requests missing committee shares of logged settlements at most every ten minutes until refund', async () => {
  const s = setup({ immediate: true }), trade = s.trade();
  await s.service.start(); s.service.stop(); await s.summon(trade);
  const requests = () => s.bridge.sent.filter(x => x.envelope.kind === 'shareRequest');
  await s.service.reconcile(); assert.equal(requests().length, 0, 'a summoned trade without a logged settlement is not asked about');
  s.clock.t += 600; await s.service.reconcile(); assert.equal(requests().length, 0);
  await s.report(trade); await s.service.reconcile();
  assert.equal(s.service.settlements.get(trade.id).status, 'logged'); assert.equal(requests().length, 1);
  await s.service.reconcile(); assert.equal(requests().length, 1);
  s.clock.t += 599; await s.service.reconcile(); assert.equal(requests().length, 1);
  s.clock.t++; await s.service.reconcile(); assert.equal(requests().length, 2);
  for (let i = 1; i <= 5; i++) await s.publish(trade, i, trade.shares[i - 1]);
  s.clock.t += 600; await s.service.reconcile(); assert.equal(requests().length, 2);
  const second = s.trade(); await s.summon(second); await s.report(second); s.clock.t = second.terms.refundAfter;
  await s.service.reconcile(); assert.equal(requests().length, 2);
});

test('service asks for a missing share at most SHARE_REQUESTS times, then stops', async () => {
  const s = setup({ immediate: true }), trade = s.trade();
  await s.service.start(); s.service.stop(); await s.summon(trade); await s.report(trade);
  const requests = () => s.bridge.sent.filter(x => x.envelope.kind === 'shareRequest');
  for (let i = 1; i < 5; i++) await s.publish(trade, i, trade.shares[i - 1]);   // the fifth signer never publishes
  for (let i = 0; i < SHARE_REQUESTS + 3; i++) { await s.service.reconcile(); s.clock.t += 600; }
  assert.equal(requests().length, SHARE_REQUESTS);
});

test('only signers of the current registry count as online; other heartbeats are not kept', async () => {
  const s = setup({ immediate: true });
  await s.service.start(); s.service.stop();
  const beat = identity => s.emit(SIGNERS, s.envelope(identity, 'heartbeat', { registryVersion: s.service.registry.version, software: '0.1.0', status: 'online', holdCount: 0 }, SIGNERS));
  const listed = s.f.signers[0].identity;
  await beat(listed); await beat(s.f.buyer);
  assert.deepEqual(s.service.status().signersOnline, [encodeKey(listed.publicKey)]);
  assert.equal(s.service.heartbeats.size, 1);
  s.clock.t += 90; assert.deepEqual(s.service.status().signersOnline, []);
});

test('an offer whose maker cannot fund the smallest trade is left out of the published book until funds arrive', async t => {
  const timers = []; t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const s = setup({ immediate: true }); await s.service.start(); t.after(() => s.service.stop());
  let tnk = '0';
  s.service.funds.trac = { balances: async () => ({ TNK: tnk, RESET: '0', feeTnk: '30000000000000000' }) };
  await s.emit(OFFERS, s.envelope(s.f.seller, 'offer', s.offer, OFFERS));
  const tick = async seconds => { s.clock.t += seconds; timers.find(x => x.ms === 5000).fn(); for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)); };
  const shown = () => {
    const last = s.bridge.sent.filter(x => ['book', 'bookDelta'].includes(x.envelope.kind) && x.envelope.body.pair === s.offer.pair).at(-1)?.envelope;
    return last?.kind === 'book' ? last.body.remaining.map(r => r.offerId) : last;
  };
  await tick(5); assert.deepEqual(shown(), [s.offer.offerId], 'shown until its wallet was read');
  await tick(5); await tick(60);
  assert.deepEqual(shown(), [], 'an empty wallet hides the offer');
  assert.equal(s.service.status().unfunded[s.offer.pair], 1);
  assert.equal(s.service.book.snapshot(s.offer.pair, s.clock.t).length, 1, 'the offer itself stays');
  tnk = '1000000000000000000'; await tick(300);
  await s.emit(OFFERS, s.envelope(s.f.seller, 'offer', s.offer, OFFERS)); await tick(60);
  assert.deepEqual(shown(), [s.offer.offerId]);
  assert.equal(s.service.status().unfunded[s.offer.pair], 0);
});

test('a restarted venue keeps its book: offers seen in the last five minutes return, cancelled and stale ones do not', async () => {
  const s = setup({ immediate: true }); await s.service.start();
  await s.emit(OFFERS, s.envelope(s.f.seller, 'offer', s.offer, OFFERS));
  s.service.book.fill(s.offer.offerId, '1000000000000000000');
  s.service.stop();
  const again = setup({ dir: s.dir, immediate: true, clock: s.clock });
  const [kept] = again.service.book.snapshot(s.offer.pair, s.clock.t);
  assert.equal(kept.offerId, s.offer.offerId); assert.equal(kept.baseAmount, '2000000000000000000');
  s.clock.t += 300;
  assert.equal(setup({ dir: s.dir, immediate: true, clock: s.clock }).service.book.snapshot(s.offer.pair, s.clock.t).length, 0, 'not heard for five minutes');
  s.clock.t -= 300;
  await again.service.start(); await again.emit(OFFERS, again.envelope(s.f.seller, 'cancel', { offerId: s.offer.offerId }, OFFERS)); again.service.stop();
  assert.equal(setup({ dir: s.dir, immediate: true, clock: s.clock }).service.book.snapshot(s.offer.pair, s.clock.t).length, 0, 'cancelled');
});

test('the published size leaves out summoned trades in progress, counts a logged trade once, and frees a dead one', async t => {
  const timers = []; t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const s = setup({ immediate: true }); await s.service.start(); t.after(() => s.service.stop());
  await s.emit(OFFERS, s.envelope(s.f.seller, 'offer', s.offer, OFFERS));
  const tick = async seconds => { s.clock.t += seconds; timers.find(x => x.ms === 5000).fn(); for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)); };
  const size = () => s.bridge.sent.filter(x => x.envelope.kind === 'book' && x.envelope.body.pair === s.offer.pair).at(-1)
    .envelope.body.remaining.find(r => r.offerId === s.offer.offerId)?.amount ?? null;
  await tick(5); assert.equal(size(), '3000000000000000000');
  const done = s.trade(), dead = s.trade();
  await s.summon(done); await s.summon(dead);
  await tick(60); assert.equal(size(), '1000000000000000000', 'two trades of 1 in progress');
  await s.report(done); await s.service.reconcile();
  await tick(60); assert.equal(size(), '1000000000000000000', 'the logged trade is a fill, not counted twice');
  s.clock.t = dead.terms.sendBy + dead.terms.graceSec + IN_FLIGHT_SLACK_SEC;
  await s.emit(OFFERS, s.envelope(s.f.seller, 'offer', s.offer, OFFERS));
  await tick(60); assert.equal(size(), '2000000000000000000', 'a trade past its window frees the size');
});

test('service schedules full books at sixty seconds and sends only changed deltas between them', async t => {
  const timers = []; t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const s = setup({ immediate: true }); await s.service.start(); t.after(() => s.service.stop());
  await s.emit(OFFERS, s.envelope(s.f.seller, 'offer', s.offer, OFFERS));
  const tick = async seconds => { s.clock.t += seconds; timers.find(x => x.ms === 5000).fn(); await new Promise(r => setImmediate(r)); };
  const books = () => s.bridge.sent.filter(x => ['book', 'bookDelta'].includes(x.envelope.kind));
  await tick(5); assert.equal(books().length, 2);
  const first = books().find(x => x.envelope.body.pair === s.offer.pair).envelope;
  assert.deepEqual(first.body.remaining, [{ offerId: s.offer.offerId, amount: s.offer.baseAmount }]);
  assert.equal(Object.hasOwn(first.body, 'offers'), false);
  await tick(5); assert.equal(books().length, 2);
  s.service.book.fill(s.offer.offerId, '1000000000000000000');
  await tick(5); assert.equal(books().at(-1).envelope.kind, 'bookDelta');
  assert.equal(books().at(-1).envelope.body.seq, first.body.seq);
  assert.equal(books().at(-1).envelope.body.upserts[0].baseAmount, '2000000000000000000');
  assert.deepEqual(Object.keys(books().at(-1).envelope.body).sort(), ['pair', 'removes', 'seq', 'upserts']);
  await tick(45); assert.equal(books().length, 3);
  await tick(5); assert.equal(books().length, 5);
  assert.deepEqual(books().findLast(x => x.envelope.body.pair === s.offer.pair).envelope.body.remaining,
    [{ offerId: s.offer.offerId, amount: '2000000000000000000' }]);
  assert.ok(books().at(-1).envelope.body.seq > first.body.seq);
});

test('venue alerts for fewer than k valid shares 10 minutes after finality, repeats at 2 h, survives restart and clears', async () => {
  const s = setup({ immediate: true, refundSec: 20000 }), t = s.trade(), logs = [];
  s.service.log = (...a) => logs.push(a.join(' '));
  await s.service.start(); s.service.stop(); await s.summon(t);
  await s.publish(t, 1, t.shares[0]);
  await s.publish(t, 2, bytesToHex(le32(randomScalar())));
  await s.report(t);
  const finalAt = s.clock.t;
  s.clock.t = finalAt + 599; await s.service.reconcile(); assert.deepEqual(s.service.status().alerts, []);
  s.clock.t++; await s.service.reconcile();
  assert.deepEqual(s.service.status().alerts, [{ tradeId: t.id, have: 1, needed: 3, transferFinalAt: finalAt, refundAfter: t.terms.refundAfter }]);
  assert.equal(logs.filter(x => x.startsWith('ALERT')).length, 1);
  assert.ok(logs.includes(`ALERT shares missing ${t.id} 1/3`));
  const again = setup({ dir: s.dir, f: s.f, clock: s.clock, immediate: true });
  again.service.log = (...a) => logs.push(a.join(' '));
  await again.service.start(); again.service.stop();
  s.clock.t += 7199; await again.service.reconcile(); assert.equal(logs.filter(x => x.startsWith('ALERT')).length, 1);
  s.clock.t++; await again.service.reconcile(); assert.equal(logs.filter(x => x.startsWith('ALERT')).length, 2);
  await again.publish(t, 3, t.shares[2]); await again.publish(t, 4, t.shares[3]);
  assert.deepEqual(again.service.status().alerts, []);
  s.clock.t = t.terms.refundAfter; await again.service.reconcile();
  assert.equal(logs.filter(x => x.startsWith('ALERT')).length, 2);
});

test('reconciles check each stored share once, not again every round', async () => {
  const s = setup({ immediate: true, refundSec: 20000 }), t = s.trade();
  await s.service.start(); s.service.stop(); await s.summon(t);
  await s.publish(t, 1, t.shares[0]);
  await s.publish(t, 2, bytesToHex(le32(randomScalar())));
  await s.report(t);
  s.clock.t += 600; await s.service.reconcile();
  assert.equal(s.service.status().alerts[0].have, 1, 'the forged share stays rejected');
  const checked = s.service.shareChecks.size;
  assert.equal(checked, 2);
  for (let i = 0; i < 5; i++) { s.clock.t += 15; await s.service.reconcile(); }
  assert.equal(s.service.shareChecks.size, checked);
  assert.equal(s.service.status().alerts[0].have, 1);
});

test('known unclaimed transfers require local finality, reject forged hashes, and stop alerting at refundAfter', async () => {
  const s = setup({ immediate: true }), t = s.trade(), logs = [];
  s.service.log = (...a) => logs.push(a.join(' '));
  await s.service.start(); s.service.stop(); await s.summon(t);
  const hash = hex(), ch = `intercom-dex:t:${t.id}`;
  s.service.trac.verifyTransfer = async () => ({ ok: false, final: false });
  await s.emit(SIGNERS, s.envelope(s.f.buyer, 'transferSent', { tradeId: t.id, txHash: hash }, ch));
  assert.equal(s.service.store.get(`watch-${t.id}`).txHash, undefined);
  await s.emit(SIGNERS, s.envelope(s.f.seller, 'transferSent', { tradeId: t.id, txHash: hash }, ch));
  await s.service.reconcile();
  assert.deepEqual(s.service.status().alerts, []);
  s.service.trac.verifyTransfer = async request => {
    assert.equal(request.txHash, hash);
    return { ok: true, final: true, amount: t.terms.baseAmount, finalizedAt: s.clock.t };
  };
  await s.service.reconcile();
  s.clock.t += 600; await s.service.reconcile();
  assert.equal(s.service.status().alerts[0].have, 0, 'without the dealing no share is presumed valid');
  assert.equal(s.service.trades.length, 0, 'an unclaimed trade can alert');
  s.clock.t = t.terms.refundAfter; await s.service.reconcile();
  assert.deepEqual(s.service.status().alerts, []);
  assert.equal(logs.filter(x => x.startsWith('ALERT')).length, 1);
});

test('a known trade with a missed deal binds shares to the finalized escrow before clearing its alarm', async () => {
  const s = setup({ immediate: true }), t = s.trade();
  await s.service.start(); s.service.stop(); await s.summon(t);
  const name = `watch-${t.id}`;
  s.service.store.put(name, { ...s.service.store.get(name), txHash: hex(), transferFinalAt: s.clock.t });
  for (const i of [1, 2, 3]) await s.publish(t, i, t.shares[i - 1]);
  s.clock.t += 600;
  s.service.solana.checkEscrow = async () => ({ ok: false, status: 'missing' });
  await s.service.reconcile(); assert.equal(s.service.status().alerts[0].have, 0);
  s.service.solana.checkEscrow = async ({ terms, hashHex }) => {
    assert.equal(hashHex, t.H); assert.deepEqual(terms, t.terms);
    return { ok: true, status: 'active' };
  };
  s.clock.t += 60; await s.service.reconcile();
  assert.deepEqual(s.service.status().alerts, []);
});

test('forwarded transfer evidence reaches the venue through the running host route', async () => {
  const s = setup(), t = s.trade();
  await s.service.start(); s.service.stop(); await s.summon(t);
  const txHash = hex();
  await s.emit(SIGNERS, s.envelope(s.f.seller, 'transferSent', { tradeId: t.id, txHash }, `intercom-dex:t:${t.id}`));
  await s.service.settlementQueue;
  assert.equal(s.service.store.get(`watch-${t.id}`).txHash, txHash);
});

test('a seller with BUSY_TRADES dealt trades waiting for its transfer is busy until one ends', async () => {
  const s = setup({ immediate: true }), svc = s.service, t0 = s.clock.t;
  for (let i = 0; i < BUSY_TRADES; i++) svc.locked.set('t' + i, { seller: 'S', deadline: t0 + 1200 + i });
  svc.locked.set('o', { seller: 'O', deadline: t0 + 1200 });
  assert.deepEqual([...svc.busySellers()], ['S']);
  svc.delivered.set('t0', t0);
  assert.deepEqual([...svc.busySellers()], [], 'a delivered trade frees a slot');
  assert.equal(svc.delivered.size, 0);
  svc.locked.set('t0', { seller: 'S', deadline: t0 + 1200 });
  assert.deepEqual([...svc.busySellers()], ['S']);
  s.clock.t = t0 + 1200;
  assert.deepEqual([...svc.busySellers()], [], 'a trade past its deadline frees a slot');
  assert.equal(svc.locked.size, BUSY_TRADES - 1);
});

test('a listed signer\'s share marks a dealt trade delivered; a share from anyone else does not', async () => {
  const s = setup({ immediate: true }), t = s.trade();
  await s.service.start(); s.service.stop(); await s.summon(t);
  s.service.locked.set(t.id, { seller: t.terms.seller.dexKey, deadline: t.terms.sendBy + t.terms.graceSec });
  await s.publish(t, 1, t.shares[0], s.f.buyer);
  assert.equal(s.service.delivered.has(t.id), false);
  await s.publish(t, 1, t.shares[0]);
  assert.equal(s.service.delivered.has(t.id), true);
  assert.deepEqual([...s.service.busySellers()], []);
  assert.equal(s.service.locked.has(t.id), false);
});

test('the book leaves out sell offers of a busy seller', async t => {
  const timers = []; t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const s = setup({ immediate: true }); await s.service.start(); t.after(() => s.service.stop());
  s.service.funds.trac = { balances: async () => ({ TNK: '9000000000000000000', RESET: '0', feeTnk: '30000000000000000' }) };
  await s.emit(OFFERS, s.envelope(s.f.seller, 'offer', s.offer, OFFERS));
  const tick = async seconds => { s.clock.t += seconds; timers.find(x => x.ms === 5000).fn(); for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)); };
  const shown = () => {
    const last = s.bridge.sent.filter(x => ['book', 'bookDelta'].includes(x.envelope.kind) && x.envelope.body.pair === s.offer.pair).at(-1)?.envelope;
    return last?.kind === 'book' ? last.body.remaining.map(r => r.offerId) : last;
  };
  await tick(5); assert.deepEqual(shown(), [s.offer.offerId]);
  let hidden = true; s.service.busySellers = () => new Set(hidden ? [s.offer.maker.dexKey] : []);
  await tick(60); assert.deepEqual(shown(), [], 'hidden');
  hidden = false; await tick(60); assert.deepEqual(shown(), [s.offer.offerId], 'shown again');
});

test('a logged trade sends the tickers at once, at most every TICKER_SOON_SEC', async t => {
  const timers = []; t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const waits = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { waits.push({ fn, ms }); return waits.length; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const s = setup({ immediate: true }); await s.service.start(); t.after(() => s.service.stop());
  const tickers = () => s.bridge.sent.filter(x => x.envelope.kind === 'ticker').map(x => x.envelope.body);
  await s.report(s.trade()); await s.service.settlementQueue;
  assert.equal(waits.length, 1); assert.equal(waits[0].ms, 0);
  await s.report(s.trade()); await s.service.settlementQueue;
  assert.equal(waits.length, 1, 'a second trade before the tickers went out adds none');
  await waits[0].fn(); await new Promise(r => setImmediate(r));
  assert.equal(tickers().find(x => x.pair === 'TNK/USDC').last, '5');
  await s.report(s.trade()); await s.service.settlementQueue;
  assert.equal(waits.length, 2); assert.equal(waits[1].ms, TICKER_SOON_SEC * 1000, 'right after a ticker: waits the spacing');
  s.service.stop();
  await s.report(s.trade()); await s.service.settlementQueue;
  assert.equal(waits.length, 2, 'a stopped venue schedules nothing');
});
