import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolveNetwork, checkProfileRegistry, checkProfileTerms } from '../../../src/net/profile.js';
import { buildRegistry } from '../../../src/core/registry.js';
import { buildTerms, tradeId } from '../../../src/core/terms.js';
import { createBuyer } from '../../../src/core/trade-buyer.js';
import { selectCommittee } from '../../../src/core/committee.js';
import { encodeKey } from '../../../src/core/keys.js';
import { seal } from '../../../src/core/envelope.js';
import { sha256Hex, hexToBytes } from '../../../src/core/canonical.js';
import { RegistryView, offerIdOf, nowSec } from '../../../src/roles/common.js';
import { Service } from '../../../src/roles/service.js';
import { Trader } from '../../../src/roles/trader.js';
import { Signer } from '../../../src/roles/signer.js';
import { TradeHost } from '../../../src/roles/host.js';
import { fixture, hex, SIG } from '../core/helpers.mjs';

const MAIN = 'intercom-dex', SIGNERS = 'intercom-dex:signers', OFFERS = 'intercom-dex:offers';
const mainnet = resolveNetwork({ network: 'mainnet' });
const local = resolveNetwork({ network: 'local', platformCollector: mainnet.platformCollector,
  peer: { ...mainnet.peer, environment: 'development' } });
const short = { sendWindowSec: 300, refundSec: 960, graceSec: 60 };
const real = { sendWindowSec: 900, refundSec: 172800, graceSec: 300 };

function memory() {
  const records = new Map();
  return { get: key => structuredClone(records.get(key)), put: (key, value) => records.set(key, structuredClone(value)),
    list: prefix => [...records.keys()].filter(key => key.startsWith(prefix)), delete: key => records.delete(key) };
}

function timers(t) {
  const list = [];
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { const timer = { fn, ms }; list.push(timer); return timer; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  return list;
}

function data(params = real, k = 2) {
  const f = fixture({ k }), now = nowSec();
  f.registry = buildRegistry({ ...f.registry, issuedAt: now, params: { ...f.registry.params, ...params } });
  const maker = { dexKey: f.terms.seller.dexKey, tracAddr: f.terms.seller.tracAddr, solAddr: f.terms.seller.solRecipient };
  f.offer = { pair: f.terms.pair, side: 'sell', baseAmount: f.terms.baseAmount, price: '1', maker, peerKey: hex(),
    expiresAt: now + 3600, registryVersion: 1, software: '0.1.0' };
  f.offer.offerId = offerIdOf(f.offer);
  f.terms = buildTerms({ ...f.terms, offerId: f.offer.offerId, sendBy: now + params.sendWindowSec, refundAfter: now + params.refundSec,
    graceSec: params.graceSec, fees: { ...f.terms.fees, platformCollector: mainnet.platformCollector },
    committee: selectCommittee(f.registry, f.terms.R, { n: f.registry.params.n, k, pair: f.terms.pair,
      quoteAmount: f.terms.quoteAmount }).map(({ dexKey, boxKey }) => ({ dexKey, boxKey })) });
  return f;
}

function harness(f, profile, store = memory()) {
  const bridge = new EventEmitter(), sent = [], logs = [];
  bridge.join = async () => {};
  bridge.send = async (_ch, message) => { sent.push(message); };
  bridge.setRelays = async () => {};
  bridge.peerPresent = async () => false;
  bridge.info = async () => ({ info: { swarmPublicKey: hex() } });
  const identity = id => ({ publicKey: encodeKey(id.publicKey), secretKey: id.secretKey });
  const common = { bridge, profile, store, log: (...args) => logs.push(args), serviceKey: encodeKey(f.service.publicKey) };
  const solana = { assertFeeConfig: async () => {}, checkEscrow: async () => ({ ok: true, status: 'claimed' }),
    settlementSignature: async () => ({ status: 'claimed', signature: SIG }) };
  return { bridge, store, sent, logs,
    service: () => new Service({ firstLaunch: true, ...common, identity: identity(f.service), registryInput: f.registry, solana,
      trac: { verifyTransfer: async () => ({ ok: true, final: true }) } }),
    trader: (id = f.buyer) => new Trader({ ...common, identity: identity(id), solana: { claimFunds: async () => ({ ok: true }),
      finalizedSlot: async () => { throw Error('No test slot'); }, tipSlot: async () => { throw Error('No test slot'); } }, trac: null,
      me: id === f.buyer ? { dexKey: f.terms.buyer.dexKey, tracAddr: f.terms.buyer.tracAddr, solAddr: f.terms.buyer.solPayer } : f.offer.maker,
      proof: { zkey: '/unit-test-unused.zkey', pool: 0 } }),
    signer: () => {
      const member = f.signers.find(s => encodeKey(s.identity.publicKey) === f.terms.committee[0].dexKey);
      return new Signer({ ...common, trac: null, identity: identity(member.identity), box: identity(member.box) });
    },
    host: () => new TradeHost({ ...common, identity: identity(f.buyer), solana: null, trac: null }),
  };
}

function envelope(id, kind, body, ch) {
  return seal({ kind, ch, body }, id.secretKey, { ts: nowSec(), nonce: hex() });
}
const post = (role, message) => role.host.hooks.unrouted[0](message.ch, message);
function summon(f, terms = f.terms) {
  const id = tradeId(terms), ch = `intercom-dex:t:${id}`;
  return envelope(f.buyer, 'summon', { tradeId: id, terms,
    sigs: [f.buyer, f.seller].map(key => envelope(key, 'termsSig', { tradeId: id }, ch)) }, SIGNERS);
}

test('profile checks require exact live timings and at least two signers, leaving local schema values alone', () => {
  for (const k of [2, 3]) {
    const f = data(real, k);
    assert.doesNotThrow(() => checkProfileRegistry(f.registry, mainnet));
    assert.doesNotThrow(() => checkProfileTerms(f.terms, mainnet));
  }
  const f = data();
  for (const [key, value] of Object.entries({ sendWindowSec: 901, refundSec: 172801, graceSec: 301, k: 1 })) {
    const registry = buildRegistry({ ...f.registry, params: { ...f.registry.params, [key]: value } });
    assert.throws(() => checkProfileRegistry(registry, mainnet), /network profile/);
  }
  for (const patch of [{ sendBy: f.terms.sendBy + 1 }, { refundAfter: f.terms.refundAfter - 1 },
    { refundAfter: f.terms.refundAfter + 1 }, { graceSec: 299 }, { graceSec: 301 }, { k: 1 }]) {
    assert.throws(() => checkProfileTerms(buildTerms({ ...f.terms, ...patch }), mainnet), /network profile/);
  }
  const fast = data(short, 1);
  assert.throws(() => checkProfileRegistry(fast.registry, mainnet), /network profile/);
  assert.throws(() => checkProfileTerms(fast.terms, mainnet), /network profile/);
  assert.doesNotThrow(() => checkProfileRegistry(fast.registry, local));
  assert.doesNotThrow(() => checkProfileTerms(fast.terms, local));
});

test('venue refuses short registries before persisting, including an unchanged saved registry', () => {
  for (const f of [data(short), data(real, 1)]) {
    const h = harness(f, mainnet);
    assert.throws(h.service, /network profile/);
    assert.equal(h.store.get('service-registry'), undefined);
    h.store.put('service-registry', f.registry);
    assert.throws(h.service, /network profile/);
    assert.equal(h.sent.length, 0);
  }
});

test('venue checks startup, fee changes and every periodic registry publication', async t => {
  const scheduled = timers(t), f = data(), h = harness(f, mainnet), venue = h.service();
  const original = structuredClone(venue.registry.params);
  venue.registry.params = { ...original, ...short };
  await assert.rejects(venue.start(), /network profile/);
  assert.equal(h.sent.length, 0);
  venue.registry.params = original;
  await venue.start(); t.after(() => venue.stop());
  await venue.publishFees({ ...venue.registry.fee, tradeFeeBps: 51 });
  const published = h.sent.filter(m => m.kind === 'registry').length;
  assert.equal(published, 2);
  const savedFee = h.store.get('service-fee-policy');
  venue.registry.params = { ...original, ...short };
  await assert.rejects(venue.publishFees({ ...venue.registry.fee, tradeFeeBps: 52 }), /network profile/);
  assert.deepEqual(h.store.get('service-fee-policy'), savedFee);
  await scheduled.find(timer => timer.ms === 30000).fn();
  assert.equal(h.sent.filter(m => m.kind === 'registry').length, published);
  const fast = harness(data(short, 1), local).service();
  await fast.start(); t.after(() => fast.stop());
  await fast.publishFees({ ...fast.registry.fee, tradeFeeBps: 52 });
});

test('trader and signer ignore signed short registries, log once, and accept real timings', async t => {
  timers(t);
  for (const roleName of ['trader', 'signer']) {
    const f = data(), h = harness(f, mainnet), role = h[roleName]();
    await role.start(); t.after(() => role.stop());
    const bad = buildRegistry({ ...f.registry, params: { ...f.registry.params, ...short } });
    for (let i = 0; i < 3; i++) await post(role, envelope(f.service, 'registry', bad, MAIN));
    assert.equal(role.registry.usable, null);
    assert.equal(role.registry.snapshot(bad.version), null);
    assert.equal(h.store.get('registry-current'), undefined);
    assert.equal(h.logs.filter(([label]) => label === 'registry ignored').length, 1);
    await post(role, envelope(f.service, 'registry', f.registry, MAIN));
    assert.deepEqual(role.registry.usable, f.registry);
    await post(role, envelope(f.service, 'registry', { ...f.registry, version: 2, params: { ...f.registry.params, k: 1 } }, MAIN));
    assert.deepEqual(role.registry.usable, f.registry);
    assert.equal(role.registry.snapshot(2), null);
    const fast = data(short, 1), localRole = harness(fast, local)[roleName]();
    await localRole.start(); t.after(() => localRole.stop());
    await post(localRole, envelope(fast.service, 'registry', fast.registry, MAIN));
    assert.deepEqual(localRole.registry.usable, fast.registry);
  }
});

test('registry restoration filters the current and historical short snapshots without losing digests', () => {
  const f = data(short), store = memory(), serviceKey = encodeKey(f.service.publicKey);
  const old = new RegistryView(serviceKey, store);
  old.offer({ kind: 'registry', from: serviceKey, body: f.registry });
  const logs = [], view = new RegistryView(serviceKey, store, (...args) => logs.push(args), mainnet);
  assert.equal(view.usable, null);
  assert.equal(view.snapshot(1), null);
  assert.equal(logs.length, 1);
  assert.deepEqual(view.digests, old.digests);
  const good = buildRegistry({ ...f.registry, version: 2, params: { ...f.registry.params, ...real } });
  assert.equal(view.offer({ kind: 'registry', from: serviceKey, body: good }), true);
  assert.equal(view.snapshot(1), null);
  assert.deepEqual(view.snapshot(2), good);
  const newerBad = { ...f.registry, version: 3 };
  store.put('registry-current', newerBad);
  store.put('registry-v3', newerBad);
  const restored = new RegistryView(serviceKey, store, () => {}, mainnet);
  assert.equal(restored.offer({ kind: 'registry', from: serviceKey, body: good }), false, 'filtering must not roll back the accepted version');
  assert.equal(restored.usable, null);
});

test('maker rejects skewed take deadlines; taker and accept retain pinned deadlines', async t => {
  timers(t);
  const f = data(), h = harness(f, mainnet), maker = h.trader(f.seller);
  await maker.start(); t.after(() => maker.stop());
  await post(maker, envelope(f.service, 'registry', f.registry, MAIN));
  for (const signer of f.registry.signers) maker.heartbeats.set(signer.dexKey, { at: performance.now(), software: '0.1.0' });
  const offer = await maker.makeOffer({ pair: f.offer.pair, side: 'sell', baseAmount: '1000000000000000000', price: '1' });
  const body = { offerId: offer.offerId, pair: offer.pair, baseAmount: offer.baseAmount, registryVersion: 1, software: '0.1.0',
    taker: { dexKey: f.terms.buyer.dexKey, tracAddr: f.terms.buyer.tracAddr, solAddr: f.terms.buyer.solPayer },
    commitment: hex(), sendBy: nowSec() + 900, refundAfter: nowSec() + 172799 };
  await post(maker, envelope(f.buyer, 'take', body, `intercom-dex:t:${offer.offerId}`));
  assert.equal(maker.host.trades.size, 0);
  assert.deepEqual(h.sent.filter(m => m.kind === 'decline').map(m => m.body.reason), ['invalid'], 'an invalid take is declined as invalid');
  await post(maker, envelope(f.buyer, 'take', { ...body, refundAfter: body.sendBy + 171900 }, `intercom-dex:t:${offer.offerId}`));
  assert.equal(maker.host.trades.size, 1);

  const taker = harness(f, mainnet).trader();
  await taker.start(); t.after(() => taker.stop());
  await post(taker, envelope(f.service, 'registry', f.registry, MAIN));
  await post(taker, envelope(f.seller, 'offer', offer, OFFERS));
  for (const signer of f.registry.signers) taker.heartbeats.set(signer.dexKey, { at: performance.now(), software: '0.1.0' });
  const taken = await taker.takeOffer(offer.offerId, offer.baseAmount, offer.price), trade = taker.host.trades.get(taken.key);
  assert.equal(trade.state.draft.refundAfter - trade.state.draft.sendBy, 171900);
  const draft = structuredClone(trade.state.draft);
  taker.host.slot = 100; taker.host.tip = 132; taker.host.slotAt = taker.host.tipAt = performance.now();
  await taker.host.inject(taken.key, envelope(f.seller, 'accept', { offerId: offer.offerId,
    takeCommitment: sha256Hex(hexToBytes(trade.state.nonce)), commitment: hex(), slot: 100 }, `intercom-dex:t:${offer.offerId}`));
  assert.equal(trade.state.phase, 'awaitReveal');
  assert.deepEqual(trade.state.draft, draft);
});

test('signer and venue reject signed short summons and settlement reports; real values and local short values work', async t => {
  timers(t);
  for (const [profile, params] of [[mainnet, real], [local, short]]) {
    const f = data(params), hs = harness(f, profile), hv = harness(f, profile), signer = hs.signer(), venue = hv.service();
    await signer.start(); await venue.start(); t.after(() => { signer.stop(); venue.stop(); });
    await post(signer, envelope(f.service, 'registry', f.registry, MAIN));
    const bad = buildTerms({ ...f.terms, refundAfter: f.terms.sendBy + 1200 });
    if (profile === mainnet) {
      await post(signer, summon(f, bad)); await post(venue, summon(f, bad));
      assert.equal(signer.host.trades.size, 0); assert.equal(venue.watched.size, 0);
      await post(venue, envelope(f.seller, 'settled', { offerId: bad.offerId, tradeId: tradeId(bad), terms: bad, hashHex: hex(), txHash: hex() }, OFFERS));
      assert.equal(venue.trades.length, 0);
    }
    await post(signer, summon(f)); await post(venue, summon(f));
    assert.equal(signer.host.trades.size, 1); assert.equal(venue.watched.size, 1);
    await post(venue, envelope(f.seller, 'settled', { offerId: f.terms.offerId, tradeId: tradeId(f.terms), terms: f.terms, hashHex: hex(), txHash: hex() }, OFFERS));
    assert.equal(venue.trades.length, 1);
  }
});

test('restored trader/signer states, venue watches and settlements cannot reintroduce short terms', async t => {
  timers(t);
  const fast = data(short), f = data();
  for (const role of ['buyer', 'seller', 'signer']) {
    const h = harness(fast, mainnet), host = h.host();
    h.store.put('trade-old', { key: 'old', role, state: { role, phase: 'complete', terms: fast.terms }, outbox: {}, raw: [], buffer: [], lifetimeSec: 4560 });
    await assert.rejects(host.start(), /network profile/); host.stop();
    assert.equal(host.trades.size, 0);
  }
  for (const prefix of ['watch-', 'watchwait-', 'settle-']) {
    const h = harness(f, mainnet);
    h.store.put(prefix + 'old', prefix === 'settle-' ? { tradeId: 'old', report: { terms: fast.terms }, status: 'pending' }
      : { tradeId: 'old', terms: fast.terms });
    assert.throws(h.service, /network profile/);
  }
  for (const [profile, source] of [[mainnet, f], [local, fast]]) {
    const h = harness(source, profile), host = h.host();
    const state = createBuyer({ mode: 'taker', offerId: source.terms.offerId, terms: source.terms, registry: source.registry,
      nonce: hex(), entropy: hex(), now: nowSec() });
    state.phase = 'complete';
    h.store.put('trade-good', { key: 'good', role: 'buyer', state, outbox: {}, raw: [], buffer: [], lifetimeSec: source.registry.params.refundSec + 3600 });
    await host.start(); t.after(() => host.stop());
    assert.equal(host.trades.size, 1);
  }
  const h = harness(f, mainnet), trader = h.trader();
  h.store.put('report-old', { body: { terms: fast.terms }, firstAt: nowSec(), lastSentAt: 0 });
  await trader.start(); t.after(() => trader.stop());
  assert.equal(h.sent.some(m => m.kind === 'settled'), false);
  assert.ok(h.logs.some(([label, ...message]) => label === 'settlement report' && /network profile/.test(message.join(' '))));
});
