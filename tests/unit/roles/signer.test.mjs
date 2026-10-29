import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Signer, MAX_HELD_TRADES, MAX_HELD_PER_TRADER, HEARTBEAT_MS, OLD_REGISTRY_SEC } from '../../../src/roles/signer.js';
import { seal } from '../../../src/core/envelope.js';
import { encodeKey } from '../../../src/core/keys.js';
import { selectCommittee } from '../../../src/core/committee.js';
import { tradeId, buildTerms } from '../../../src/core/terms.js';
import { SUMMON_SKEW_SEC } from '../../../src/roles/common.js';
import { fixture, hex } from '../core/helpers.mjs';
import { proveParty, networkId } from '../core/address-proof-fixture.mjs';

async function setup() {
  const f = fixture(), now = Math.floor(Date.now() / 1000);
  f.terms.sendBy = now + 900; f.terms.refundAfter = now + 86400;
  f.terms.committee = selectCommittee(f.registry, f.terms.R, { pair: f.terms.pair, n: 5, k: 3, quoteAmount: f.terms.quoteAmount }).map(({ dexKey, boxKey }) => ({ dexKey, boxKey }));
  const member = f.signers.find(s => encodeKey(s.identity.publicKey) === f.terms.committee[0].dexKey);
  const bridge = new EventEmitter(), sent = [], records = new Map();
  bridge.setRelays = async keys => { bridge.relays = keys; }; bridge.join = async () => {}; bridge.send = async (_ch, envelope) => sent.push(envelope);
  const store = { list: () => [], get: k => records.get(k), put: (k, v) => records.set(k, structuredClone(v)) };
  const signer = new Signer({ bridge, store, trac: null, log: () => {}, serviceKey: encodeKey(f.service.publicKey),
    identity: { publicKey: encodeKey(member.identity.publicKey), secretKey: member.identity.secretKey },
    box: { publicKey: encodeKey(member.box.publicKey), secretKey: member.box.secretKey } });
  signer.registry.current = f.registry;
  await signer.start(); signer.stop();
  const id = tradeId(f.terms), ch = 'intercom-dex:t:' + id;
  const envelope = (identity, kind, body, channel) => seal({ kind, ch: channel, body }, identity.secretKey, { ts: now, nonce: hex() });
  const summonTerms = terms => {
    const tid = tradeId(terms), tch = 'intercom-dex:t:' + tid;
    return signer.host.hooks.unrouted[0]('intercom-dex:signers', envelope(f.buyer, 'summon', { tradeId: tid, terms,
      sigs: [f.buyer, f.seller].map(i => envelope(i, 'termsSig', { tradeId: tid }, tch)) }, 'intercom-dex:signers'));
  };
  const summon = () => summonTerms(f.terms);
  return { signer, f, summon, summonTerms, sent, member, now, id, ch, envelope };
}

const held = (signer, key, buyer, seller) => signer.host.trades.set(key, { key, role: 'signer',
  state: { phase: 'holding', terms: { buyer: { dexKey: buyer }, seller: { dexKey: seller } } } });

test('current registry rejects unproven summons naming an old snapshot; both proven parties are admitted', async () => {
  const { signer, f, summonTerms, now } = await setup();
  const next = { ...f.registry, version: 2, issuedAt: now - 1, minSoftware: '0.1.34',
    signers: f.registry.signers.map(s => ({ ...s, software: '0.1.34' })) };
  signer.registry.current = next;
  signer.registry.snapshot = v => v === 1 ? f.registry : v === 2 ? next : null;
  signer.profile = { mint: f.terms.mint, platformCollector: f.terms.fees.platformCollector, peer: { msbNetworkId: networkId } };
  await summonTerms(f.terms); assert.equal(signer.host.trades.size, 0);
  const terms = structuredClone(f.terms);
  for (const role of ['seller', 'buyer']) {
    terms[role] = proveParty(terms[role], { expiresAt: now + 2000 });
    await summonTerms(terms);
    assert.equal(signer.host.trades.size, role === 'buyer' ? 1 : 0);
  }
  assert.equal([...signer.host.trades.values()][0].state.requireAddressProof, true);
});

test('signers gate new summons by self version, advertised capabilities and pinned profile', async () => {
  for (const reason of ['self-version', 'asset', 'profile', 'eligible']) {
    const { signer, f, summon } = await setup();
    const me = f.registry.signers.find(s => s.dexKey === signer.identity.publicKey);
    if (reason === 'self-version') f.registry.minSoftware = '9.0.0';
    if (reason === 'asset') me.assets = ['RESET'];
    if (reason === 'profile') signer.profile = { mint: f.terms.mint, platformCollector: f.terms.seller.solRecipient };
    await summon();
    assert.equal(signer.host.trades.size, reason === 'eligible' ? 1 : 0, reason);
    if (reason === 'self-version') assert.equal(signer.status().message, 'update required');
  }
});

test('an existing signer continues holding and serving after minSoftware rises', async () => {
  const { signer, f, summon } = await setup(); await summon();
  const record = [...signer.host.trades.values()][0];
  record.state.phase = 'holding'; record.state.share = hex(); record.state.H = hex();
  const held = record.state.share;
  signer.registry.current = { ...f.registry, version: 2, minSoftware: '9.0.0' };
  await signer.host.deliver(record.key, { type: 'tick' });
  assert.equal(record.state.phase, 'holding'); assert.equal(record.state.share, held);
  assert.equal(signer.status().updateRequired, true);
});

test('signers accept trades on offers posted under the previous registry until it was replaced OLD_REGISTRY_SEC ago', async () => {
  for (const [age, accepted] of [[3600, true], [OLD_REGISTRY_SEC - 60, true], [OLD_REGISTRY_SEC + 60, false]]) {
    const { signer, f, summon, now } = await setup();
    const next = { ...f.registry, version: f.registry.version + 1, issuedAt: now - age };
    signer.registry.current = next;
    signer.registry.snapshot = v => (v === next.version ? next : v === f.registry.version ? f.registry : null);
    await summon();
    assert.equal(signer.host.trades.size, accepted ? 1 : 0, `replaced ${age} s ago`);
  }
  const { signer, f, summon, now } = await setup();
  const next = { ...f.registry, version: f.registry.version + 1, issuedAt: now - 3600, removed: [{ dexKey: f.terms.committee[1].dexKey, removedAt: now - 3600, reason: 'test' }] };
  signer.registry.current = next;
  signer.registry.snapshot = v => (v === next.version ? next : v === f.registry.version ? f.registry : null);
  await summon();
  assert.equal(signer.host.trades.size, 0, 'a committee member removed since');
});

test('signers accept a summon only inside the registry send window with the pinned refund distance', async () => {
  const { signer, f, summonTerms, now } = await setup(), p = f.registry.params;
  const shifted = (sendBy, refundAfter = sendBy + p.refundSec - p.sendWindowSec) => buildTerms({ ...f.terms, sendBy, refundAfter });
  for (const terms of [shifted(now + p.sendWindowSec + SUMMON_SKEW_SEC + 1), shifted(now + 365 * 86400), shifted(now),
    shifted(now + 600, now + 600 + p.refundSec - p.sendWindowSec - 1)]) await summonTerms(terms);
  assert.equal(signer.host.trades.size, 0);
  await summonTerms(shifted(now + p.sendWindowSec + SUMMON_SKEW_SEC));
  assert.equal(signer.host.trades.size, 1);
});

test('signers cap unfinished held trades in total and per trader key', async () => {
  const { signer, f, summon } = await setup();
  for (let i = 0; i < MAX_HELD_PER_TRADER; i++) held(signer, `fake-${i}`, hex(), f.terms.seller.dexKey);
  await summon(); assert.equal(signer.host.trades.size, MAX_HELD_PER_TRADER, 'the seller key holds its maximum');
  signer.host.trades.get('fake-0').state.phase = 'published';
  await summon(); assert.equal(signer.host.trades.size, MAX_HELD_PER_TRADER + 1, 'a finished trade frees its slot');
  const other = await setup();
  for (let i = 0; i < MAX_HELD_TRADES; i++) held(other.signer, `fake-${i}`, hex(), hex());
  await other.summon(); assert.equal(other.signer.host.trades.size, MAX_HELD_TRADES);
  other.signer.host.trades.get('fake-0').state.phase = 'expired';
  await other.summon(); assert.equal(other.signer.host.trades.size, MAX_HELD_TRADES + 1);
});

test('a holding signer repeats its ack only until sendBy, then sends it only to members that announce themselves', async t => {
  const timers = [];
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const { signer, f, summon, sent, member, now, id, ch, envelope } = await setup();
  const clock = { t: now }; signer.host.now = () => clock.t;
  await summon();
  const trade = [...signer.host.trades.values()][0], tick = timers.find(x => x.ms === 1000).fn;
  trade.state.phase = 'holding';
  trade.outbox[ch] = [envelope(member.identity, 'ack', { tradeId: id, H: hex(), holdUntil: f.terms.refundAfter }, ch)];
  const acks = () => sent.filter(e => e.kind === 'ack').length;
  const run = async seconds => { clock.t += seconds; tick(); await trade.queue; };
  await run(0); await run(10); await run(10);
  assert.equal(acks(), 2);
  clock.t = f.terms.sendBy; await run(0); await run(10); await run(10);
  assert.equal(acks(), 2, 'no periodic ack after sendBy');
  signer.bridge.emit('message', ch, seal({ kind: 'present', ch, body: { ref: id } }, f.buyer.secretKey, { ts: clock.t, nonce: hex() }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acks(), 3, 'a member that announces itself still gets the ack');
});

test('signers beat every 30 s, one heartbeat at a time, and resend at once when the peer times out a send', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { signer, sent } = await setup();
  let fail = 1, hold = null, attempts = 0;
  signer.bridge.send = async (_ch, envelope) => {
    attempts++;
    if (hold) await hold;
    if (fail-- > 0) throw new Error('Bridge timeout: send');
    sent.push(envelope);
  };
  const beats = () => sent.filter(e => e.kind === 'heartbeat').length;
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await signer.start();
  t.mock.timers.tick(HEARTBEAT_MS); for (let i = 0; i < 5; i++) await settle();
  assert.equal(attempts, 2); assert.equal(beats(), 1);
  let release; hold = new Promise(resolve => { release = resolve; });
  t.mock.timers.tick(HEARTBEAT_MS); t.mock.timers.tick(HEARTBEAT_MS); await settle();
  assert.equal(attempts, 3);
  release(); hold = null; for (let i = 0; i < 5; i++) await settle();
  assert.equal(beats(), 2);
  signer.stop();
});

test('signer asks for a missing deal every 30 s, only before sendBy and until the deal arrives', async t => {
  const timers = [];
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const { signer, summon, sent, now } = await setup();
  assert.equal(HEARTBEAT_MS, 30000);
  let clock = now; signer.host.now = () => clock;
  await summon();
  const trade = [...signer.host.trades.values()][0], tick = timers.find(x => x.ms === 1000).fn;
  const count = () => sent.filter(e => e.kind === 'present').length;
  const run = async at => { clock = at; tick(); await trade.queue; };
  const initial = count();
  await run(now); await run(now + 10); await run(now + 29); assert.equal(count(), initial);
  await run(now + 30); assert.equal(count(), initial + 1);
  await run(now + 59); assert.equal(count(), initial + 1);
  await run(now + 60); assert.equal(count(), initial + 2);
  trade.state.phase = 'checkingProof';
  await run(now + 90); assert.equal(count(), initial + 2);
  trade.state.phase = 'awaitDeal';
  await run(trade.state.terms.sendBy); assert.equal(count(), initial + 2);
  await run(trade.state.terms.sendBy + 30); assert.equal(count(), initial + 2);
});

test('a slow channel join cannot announce a missing deal at or after sendBy', async () => {
  const { signer, summon, sent, now, f } = await setup();
  let clock = now, release;
  signer.host.now = () => clock;
  signer.bridge.join = () => new Promise(resolve => { release = resolve; });
  await summon();
  clock = f.terms.sendBy; release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.filter(e => e.kind === 'present').length, 0);
});

test('signer role defaults strikes off and reports the effective setting', async () => {
  const { signer } = await setup();
  assert.equal(signer.strikes.enabled, false);
  assert.deepEqual(signer.status().strikes, { enabled: false });
  const enabled = new Signer({ bridge: signer.bridge, identity: signer.identity, box: signer.box, store: signer.store,
    trac: null, serviceKey: signer.serviceKey, strikes: { enabled: true } });
  assert.equal(enabled.host.signerStrikes.enabled, true);
  assert.deepEqual(enabled.status().strikes, { enabled: true });
  assert.throws(() => new Signer({ strikes: { enabled: 'true' } }));
});

test('buyer refusal blocks new signed summons before any ack, carries plain words, and the operator clear publishes a legacy status', async t => {
  const timers = [];
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return fn; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const { signer, f, summonTerms, sent, now } = await setup();
  signer.buyerStrikes.enabled = true;
  signer.profile = signer.host.profile = { mint: f.terms.mint, platformCollector: f.terms.fees.platformCollector, peer: { msbNetworkId: networkId } };
  const terms = structuredClone(f.terms);
  for (const role of ['seller', 'buyer']) terms[role] = proveParty(terms[role], { expiresAt: now + 2000 });
  signer.buyerStrikes.record(terms.buyer, 'first', now - 2); signer.buyerStrikes.record(terms.buyer, 'second', now - 1);
  await summonTerms(terms);
  const trade = [...signer.host.trades.values()][0];
  assert.equal(trade.state.phase, 'aborted');
  assert.equal(trade.state.reason, 'Your bids are paused for 7 days: 2 trades were accepted but never paid');
  assert.ok(sent.some(m => m.kind === 'refused' && m.body.reason === 'buyer-struck'));
  assert.ok(!sent.some(m => m.kind === 'ack'));
  // While the registry still allows legacy unproved terms, stripping a proof must not evade an existing proven pause.
  const legacy = structuredClone(terms); legacy.offerId = hex();
  delete legacy.buyer.tracProof; delete legacy.seller.tracProof;
  await summonTerms(legacy);
  assert.equal([...signer.host.trades.values()].at(-1).state.reason, trade.state.reason);
  timers.find(x => x.ms === HEARTBEAT_MS).fn();
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  const notice = sent.findLast(m => m.kind === 'status');
  assert.match(notice.body.message, /^buyer-pause /);
  assert.deepEqual(Object.keys(notice.body).sort(), ['message', 'software', 'status', 'ts']);
  assert.equal(signer.listSellerStrikes().buyers.refusals.length, 1);
  await signer.clearBuyerStrikes(terms.buyer);
  assert.equal(JSON.parse(sent.findLast(m => m.kind === 'status').body.message.slice('buyer-pause '.length)).until, 0);
  assert.equal(signer.buyerStrikes.refusal(terms.buyer, now), null);
  const fresh = { ...terms, offerId: hex() };
  await summonTerms(fresh);
  assert.equal([...signer.host.trades.values()].at(-1).state.phase, 'awaitDeal', 'cleared buyer may start a new trade');
});

test('real signer admission observes a proven accepted no-deal buyer through healthy heartbeats and a finalized absence', async t => {
  const timers = [], clock = { ms: Date.now() };
  t.mock.method(Date, 'now', () => clock.ms);
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return fn; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const { signer, f, now } = await setup(); t.after(() => signer.stop());
  signer.host.stopped = false; signer.buyerStrikes.enabled = true;
  signer.profile = signer.host.profile = { mint: f.terms.mint, platformCollector: f.terms.fees.platformCollector, peer: { msbNetworkId: networkId } };
  signer.host.buyerObserver.trac = { balances: async () => ({ TNK: '100000000000000000000', feeTnk: '3' }) };
  let scans = 0;
  signer.host.buyerObserver.solana = { walletBalances: async () => ({ SOL: '10000000', USDC: '0' }),
    chainTime: async () => Math.floor(clock.ms / 1000), buyerPayment: async () => { scans++; return { ok: true, seen: false, chainTime: Math.floor(clock.ms / 1000) }; } };
  const terms = structuredClone(f.terms);
  for (const role of ['seller', 'buyer']) terms[role] = proveParty(terms[role], { expiresAt: now + 2000 });
  const message = (identity, kind, body, ch) => seal({ kind, body, ch }, identity.secretKey, { ts: Math.floor(clock.ms / 1000), nonce: hex() });
  const receive = (ch, m) => signer.host.hooks.unrouted[0](ch, m);
  const health = async () => {
    await receive('intercom-dex', message(f.service, 'status', { status: 'online', software: '0.1.43', ts: Math.floor(clock.ms / 1000), message: '' }, 'intercom-dex'));
    for (const member of f.signers) await receive('intercom-dex:signers', message(member.identity, 'heartbeat', { status: 'online', software: '0.1.43', registryVersion: 1, holdCount: 0 }, 'intercom-dex:signers'));
    await timers.find(x => x.ms === HEARTBEAT_MS).fn();
  };
  await health();
  const id = tradeId(terms), ch = 'intercom-dex:t:' + id;
  await receive('intercom-dex:signers', message(f.buyer, 'summon', { tradeId: id, terms,
    sigs: [f.buyer, f.seller].map(identity => message(identity, 'termsSig', { tradeId: id }, ch)) }, 'intercom-dex:signers'));
  const record = [...signer.host.trades.values()][0];
  assert.equal(record.state.phase, 'awaitDeal');
  for (let at = now; at <= terms.sendBy + terms.graceSec + 15; at += 15) {
    clock.ms = at * 1000; await health();
    timers.find(x => x.ms === 1000).fn();
    for (let i = 0; i < 8; i++) { await new Promise(r => setImmediate(r)); await record.queue; }
  }
  assert.ok(scans > 0);
  assert.deepEqual(signer.buyerStrikes.list(Math.floor(clock.ms / 1000)).strikes.map(s => s.tradeId), [id]);
  assert.equal(record.buyerStrikeExemption, undefined);
});

test('a stalled buyer pause announcement never holds back signer heartbeats', async t => {
  const timers = []; t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return fn; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const { signer, f, now, sent } = await setup();
  signer.buyerStrikes.enabled = true;
  signer.buyerStrikes.record(f.terms.buyer, 'first', now - 2); signer.buyerStrikes.record(f.terms.buyer, 'second', now - 1);
  const send = signer.bridge.send; let release;
  signer.bridge.send = (ch, m) => m.kind === 'status' ? new Promise(resolve => { release = resolve; }) : send(ch, m);
  const beat = timers.find(x => x.ms === HEARTBEAT_MS).fn;
  await beat(); await beat();
  assert.equal(sent.filter(m => m.kind === 'heartbeat').length, 2);
  assert.ok(release); release(); await signer.publishingBuyerPauses;
});
