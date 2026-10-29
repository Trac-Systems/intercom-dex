import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SellerStrikes, STRIKE_WINDOW_SEC as WEEK, strikeCandidate, strikeSettings, STRIKE_READ_TIMEOUT_MS } from '../../../src/roles/signer-strikes.js';
import { openStore } from '../../../src/roles/store.js';
import { TradeHost, tradeChannel } from '../../../src/roles/host.js';
import { rescueTrade } from '../../../src/core/trade-signer.js';
import { encodeKey } from '../../../src/core/keys.js';
import { seal } from '../../../src/core/envelope.js';
import { simulation } from '../core/simulation.mjs';
import { hex } from '../core/helpers.mjs';
import { networkId, proveParty, proofWallet } from '../core/address-proof-fixture.mjs';

const sim = simulation({ holdSellerFunds: true }), seller = sim.state('signer1').terms.seller;
function memory() {
  const rows = new Map();
  return { get: k => structuredClone(rows.get(k)), put: (k, v) => rows.set(k, structuredClone(v)),
    list: prefix => [...rows.keys()].filter(k => k.startsWith(prefix)) };
}
function record(key = hex(), phase = 'holding') {
  const state = structuredClone(sim.state('signer1'));
  Object.assign(state, { tradeId: hex(), phase, sellerAddressProven: true });
  for (const role of ['seller', 'buyer']) state.terms[role] = proveParty(state.terms[role], { wallet: proofWallet(sim.f[role]) });
  return { key, state, role: 'signer', lifetimeSec: 90000, outbox: {}, raw: [], buffer: [], signerAckedAt: 101 };
}
const deadline = r => r.state.terms.sendBy + r.state.terms.graceSec;

test('one strike permits, two refuse the proven address across DEX identities; no extension during refusal', () => {
  const b = new SellerStrikes({ enabled: true, store: memory() });
  b.record(seller, 'a', 100);
  assert.equal(b.refusal(seller, 100), null);
  b.record(seller, 'b', 200);
  assert.equal(b.refusal(seller, 200).until, 200 + WEEK);
  assert.ok(b.refusal({ ...seller, dexKey: hex() }, 200));
  assert.equal(b.refusal({ ...seller, tracAddr: 'another-address' }, 200), null);
  b.record(seller, 'c', 300);
  assert.equal(b.refusal(seller, 300).until, 200 + WEEK);
  assert.equal(b.record(seller, 'c', 301), false);
  b.forget('a', 302);
  assert.equal(b.refusal(seller, 302).until, 300 + WEEK, 'two genuine strikes still refuse after one was cancelled');
});

test('strikes expire exactly at seven days; refusal lasts seven days from the second strike', () => {
  const b = new SellerStrikes({ enabled: true, store: memory() });
  b.record(seller, 'a', 100); b.record(seller, 'b', 200);
  assert.equal(b.list(100 + WEEK).strikes.length, 1);
  assert.ok(b.refusal(seller, 100 + WEEK));
  assert.equal(b.refusal(seller, 200 + WEEK), null);
  assert.deepEqual(b.list(200 + WEEK).strikes, []);
  b.record(seller, 'c', 200 + WEEK);
  assert.equal(b.refusal(seller, 200 + WEEK), null);
});

test('restart uses the encrypted durable ledger; clear and late evidence remove dependent refusals', t => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-strikes-')), key = randomBytes(32);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new SellerStrikes({ enabled: true, store: openStore(dir, key) });
  first.record(seller, 'a', 100); first.record(seller, 'b', 200);
  const logs = [], second = new SellerStrikes({ enabled: true, store: openStore(dir, key), log: line => logs.push(line) });
  assert.equal(second.refusal(seller, 201).until, 200 + WEEK);
  second.forget('a', 202); assert.equal(second.refusal(seller, 202), null);
  assert.deepEqual(second.list(202).strikes.map(s => s.tradeId), ['b']);
  second.record(seller, 'c', 203);
  assert.deepEqual(second.clear(seller, 204), { cleared: true, strikes: 2, refusals: 1 });
  assert.deepEqual(new SellerStrikes({ enabled: true, store: openStore(dir, key) }).list(204), { strikes: [], refusals: [] });
  assert.ok(logs.some(l => l.startsWith('seller strike clear seller=')));
});

test('caps evict oldest strikes and refusals; clearing one address leaves other addresses intact', () => {
  const disk = memory(), b = new SellerStrikes({ enabled: true, store: disk, cap: 2 });
  const others = [seller, { ...seller, tracAddr: 'second-address' }, { ...seller, tracAddr: 'another' }];
  others.forEach((s, i) => { b.record(s, `a${i}`, 100 + i * 2); b.record(s, `b${i}`, 101 + i * 2); });
  assert.deepEqual(b.list(110).strikes.map(s => s.tradeId), ['a2', 'b2']);
  assert.equal(b.list(110).refusals.length, 2);
  assert.equal(b.refusal(seller, 110), null);
  b.clear(others[1], 111);
  assert.ok(b.refusal(others[2], 111));
  const clock = new SellerStrikes({ enabled: true, store: memory(), cap: 2 });
  clock.record(seller, 'newer', 200); clock.record(seller, 'oldest', 100); clock.record(seller, 'newest', 300);
  assert.deepEqual(clock.list(300).strikes.map(s => s.tradeId), ['newer', 'newest']);
});

test('each local evidence condition is necessary, including attempts never accepted by the reducer', () => {
  const r = record(), now = deadline(r);
  assert.ok(strikeCandidate(r, now)); assert.ok(!strikeCandidate(r, now - 1));
  assert.ok(!strikeCandidate(r, now + WEEK));
  for (const patch of [{ role: 'seller' }, { signerAckedAt: undefined }, { sellerTransferSeen: true }, { sellerClaimed: true },
    { buffer: [{ kind: 'transferSent', from: seller.dexKey }] }, { raw: [{ kind: 'transferSent', from: seller.dexKey }] }]) {
    assert.ok(!strikeCandidate({ ...r, ...patch }, now), JSON.stringify(patch));
  }
  for (const patch of [{ sellerAddressProven: false }, { H: null }, { txHash: hex() }, { finalizedAt: 0 }, { phase: 'published' }, { phase: 'complete' }, { phase: 'aborted' }]) {
    assert.ok(!strikeCandidate({ ...r, state: { ...r.state, ...patch } }, now), JSON.stringify(patch));
  }
});

async function fixture(t, { disk = memory(), check, send, now = 101, enabled = true, trac = {} } = {}) {
  const bridge = new EventEmitter(), sent = [], logs = [], clock = { now }, timers = [];
  t.mock.method(globalThis, 'setInterval', fn => { timers.push(fn); return fn; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  bridge.join = bridge.leave = async () => {};
  bridge.send = send ?? (async (_ch, m) => { sent.push(m); });
  const strikes = new SellerStrikes({ enabled, store: disk, log: l => logs.push(l) });
  const identity = sim.nodes.get('signer1').identity;
  const host = new TradeHost({ bridge, store: disk, identity: { publicKey: encodeKey(identity.publicKey), secretKey: identity.secretKey },
    profile: { peer: { msbNetworkId: networkId }, mint: sim.f.terms.mint, platformCollector: sim.f.terms.fees.platformCollector },
    now: () => clock.now, signerStrikes: strikes, signerSolana: { checkEscrow: check ?? (async ({ hashHex, purpose }) => ({ ok: true, hashHex, purpose, status: 'active' })) },
    trac: { balances: async () => ({ TNK: '1000000000000000000', RESET: '1000000000000000000', feeTnk: '3' }),
      gatewayHealth: async () => ({ ok: true, eligible: 3 }), recentTransferCandidates: async () => [],
      reserveTx: async ({ tradeId }) => ({ ok: true, reservedFor: tradeId }), ...trac },
    log: (...a) => logs.push(a.join(' ')) });
  await host.start(); t.after(() => host.stop());
  return { bridge, sent, logs, strikes, host, clock, disk, tick: async () => { timers[0](); await flush(host); } };
}
async function flush(host) {
  for (let i = 0; i < 8; i++) { await new Promise(r => setImmediate(r)); await Promise.all([...host.trades.values()].map(t => t.queue)); }
}

test('only a matching confirmed escrow can strike; failed/missing/claimed/foreign reads cannot', async t => {
  for (const result of [null, { ok: false, status: 'missing' }, { ok: false, status: 'pending' }, { ok: true, status: 'claimed' },
    { ok: true, status: 'active', hashHex: hex() }, { ok: true, status: 'active', purpose: 'lock' }, 'throw']) {
    const r = record(), f = await fixture(t, { now: deadline(r), check: async ({ hashHex, purpose }) => {
      if (result === 'throw') throw Error('RPC unavailable');
      return result && { hashHex, purpose, ...result };
    } });
    await f.host.addTrade(r); await f.tick();
    assert.deepEqual(f.strikes.list(f.clock.now).strikes, [], JSON.stringify(result));
  }
});

test('no ack means no strike; unsuccessful bridge sends and failed ack persistence do not count', async t => {
  for (const failure of ['send', 'save']) {
    const r = record('ack', 'checkingSellerFunds'); delete r.signerAckedAt;
    const f = await fixture(t, { send: failure === 'send' ? async () => { throw Error('offline'); } : undefined });
    const put = f.disk.put;
    if (failure === 'save') f.disk.put = (k, v) => { if (v.signerAckedAt != null) throw Error('disk full'); put(k, v); };
    await f.host.addTrade(r); await f.host.deliver(r.key, { type: 'resume' }); await flush(f.host);
    assert.equal(f.host.trades.get(r.key).signerAckedAt, undefined);
    f.clock.now = deadline(r); await f.tick();
    assert.deepEqual(f.strikes.list(f.clock.now).strikes, []);
  }
});

test('two locked no-send trades strike once each, third refuses at funds check; acked trades keep their promise', async t => {
  const f = await fixture(t), held = record('already-acked', 'checkingSellerFunds');
  delete held.signerAckedAt;
  held.state.terms.sendBy += 5000;
  await f.host.addTrade(held);
  await f.host.deliver(held.key, { type: 'resume' }); await flush(f.host);
  for (const key of ['first', 'second']) {
    const r = record(key, 'checkingSellerFunds'); delete r.signerAckedAt;
    f.clock.now = 101;
    await f.host.addTrade(r); await f.host.deliver(key, { type: 'resume' }); await flush(f.host);
    assert.ok(f.sent.some(m => m.kind === 'ack' && m.body.tradeId === r.state.tradeId));
    f.clock.now = deadline(r); await f.tick(); await f.tick();
  }
  assert.equal(f.strikes.list(f.clock.now).strikes.length, 2);
  assert.ok(f.strikes.refusal(seller, f.clock.now));
  const third = record('third', 'checkingSellerFunds'); delete third.signerAckedAt;
  third.state.terms.sendBy += 5000; third.state.sellerFundsDeadline = f.clock.now + 100;
  await f.host.addTrade(third); await f.host.deliver('third', { type: 'resume' }); await flush(f.host);
  assert.equal(f.host.trades.get('third').state.phase, 'checkingSellerFunds');
  assert.ok(!f.sent.some(m => m.kind === 'ack' && m.body.tradeId === third.state.tradeId));
  assert.ok(f.logs.some(l => l.startsWith('seller struck ')));
  await f.host.deliver('already-acked', { type: 'resume' }); await flush(f.host);
  assert.equal(f.host.trades.get('already-acked').state.phase, 'holding');
  assert.ok(f.sent.some(m => m.kind === 'ack' && m.body.tradeId === held.state.tradeId));
});

test('late authenticated attempt cancels a strike; wrong sender or trade cannot exempt a seller', async t => {
  const r = record('late'), f = await fixture(t, { now: deadline(r) });
  await f.host.addTrade(r); await f.tick();
  assert.equal(f.strikes.list(f.clock.now).strikes.length, 1);
  const emit = (identity, tradeId = r.state.tradeId) => {
    const ch = tradeChannel(r.state.tradeId), envelope = seal({ kind: 'transferSent', ch, body: { tradeId, txHash: hex() } }, identity.secretKey,
      { ts: f.clock.now, nonce: hex() });
    f.bridge.emit('message', ch, envelope);
  };
  emit(sim.f.buyer); emit(sim.f.seller, hex()); await flush(f.host);
  assert.equal(f.strikes.list(f.clock.now).strikes.length, 1);
  emit(sim.f.seller); await flush(f.host);
  assert.equal(f.strikes.list(f.clock.now).strikes.length, 0);
  assert.equal(f.disk.get('trade-late').sellerTransferSeen, true);
});

test('forwarded late evidence still cancels after channel cleanup and is forwarded to other signers', async t => {
  const r = record('forwarded'), f = await fixture(t, { now: deadline(r) });
  await f.host.addTrade(r); await f.tick(); await f.tick();
  assert.equal(f.host.trades.get(r.key).channelsLeft, true);
  const ch = tradeChannel(r.state.tradeId), message = seal({ kind: 'transferSent', ch,
    body: { tradeId: r.state.tradeId, txHash: hex() } }, sim.f.seller.secretKey, { ts: f.clock.now, nonce: hex() });
  f.bridge.emit('message', 'intercom-dex:signers', message); await flush(f.host);
  assert.deepEqual(f.strikes.list(f.clock.now).strikes, []);
  assert.ok(f.sent.some(m => m.sig === message.sig));
});

test('RPC race with transfer evidence or operator clear cannot produce a strike', async t => {
  for (const what of ['transfer', 'clear']) {
    let release;
    const r = record(what), f = await fixture(t, { now: deadline(r), check: ({ hashHex, purpose }) => new Promise(resolve => {
      release = () => resolve({ hashHex, purpose, ok: true, status: 'active' });
    }) });
    await f.host.addTrade(r); await f.tick();
    if (what === 'clear') f.host.clearSellerStrikes(seller);
    else {
      const ch = tradeChannel(r.state.tradeId);
      f.bridge.emit('message', ch, seal({ kind: 'transferSent', ch, body: { tradeId: r.state.tradeId, txHash: hex() } }, sim.f.seller.secretKey, { ts: f.clock.now, nonce: hex() }));
      await flush(f.host);
    }
    release(); await flush(f.host);
    assert.deepEqual(f.strikes.list(f.clock.now).strikes, []);
  }
});

test('restart preserves recorded strikes and clear, and reconciles interrupted evidence cancellation', async t => {
  const disk = memory(), r = record('restart', 'expired');
  const first = await fixture(t, { disk, now: deadline(r) }); await first.host.addTrade(r); await first.tick(); first.host.stop();
  const second = await fixture(t, { disk, now: deadline(r) + 1 }); await second.tick();
  assert.equal(second.strikes.list(second.clock.now).strikes.length, 1);
  second.host.clearSellerStrikes(seller); await second.tick(); second.host.stop();
  const third = await fixture(t, { disk, now: deadline(r) + 2 }); await third.tick();
  assert.deepEqual(third.strikes.list(third.clock.now).strikes, []);
  third.strikes.record(seller, r.state.tradeId, third.clock.now);
  const saved = disk.get('trade-restart'); saved.sellerTransferSeen = true; disk.put('trade-restart', saved); third.host.stop();
  const fourth = await fixture(t, { disk, now: deadline(r) + 3 });
  assert.deepEqual(fourth.strikes.list(fourth.clock.now).strikes, []);
});

test('a read failure can recover later, while ledger and trade-save failures stay retryable without duplicate strikes', async t => {
  for (const failure of ['read', 'ledger', 'trade']) {
    let fail = true;
    const r = record(failure), f = await fixture(t, { now: deadline(r), check: async ({ hashHex, purpose }) =>
      ({ ok: failure !== 'read' || !fail, hashHex, purpose, status: 'active' }) });
    const put = f.disk.put;
    f.disk.put = (k, v) => {
      if (fail && ((failure === 'ledger' && k === 'seller-strikes') || (failure === 'trade' && v.sellerStrikeDone))) throw Error('disk full');
      put(k, v);
    };
    await f.host.addTrade(r); await f.tick();
    assert.ok(!f.host.trades.get(r.key).sellerStrikeDone);
    assert.equal(f.strikes.list(f.clock.now).strikes.length, failure === 'trade' ? 1 : 0);
    fail = false; f.clock.now += 30; await f.tick();
    assert.equal(f.strikes.list(f.clock.now).strikes.length, 1);
    assert.equal(f.host.trades.get(r.key).sellerStrikeDone, true);
  }
});

test('late final transfer accepted by rescue publishes the share without a strike', async t => {
  const r = record('rescue', 'expired'); r.state.txHash = hex();
  const f = await fixture(t, { now: deadline(r) + 10 });
  r.state = rescueTrade(r.state, f.clock.now); assert.ok(r.state);
  f.host.trac.verifyTransfer = async a => ({ ok: true, final: true, txHash: a.txHash, amount: a.minAmount, from: a.from, to: a.to,
    asset: a.asset, nonce: a.nonce, finalizedAt: f.clock.now });
  await f.host.addTrade(r); await f.host.deliver(r.key, { type: 'resume' }); await flush(f.host); await f.tick();
  assert.equal(f.host.trades.get(r.key).state.phase, 'published');
  assert.deepEqual(f.strikes.list(f.clock.now).strikes, []);
});

test('strike configuration is strictly boolean and defaults off; old records remain inspectable', () => {
  assert.deepEqual(strikeSettings(), { enabled: false });
  assert.deepEqual(strikeSettings({}), { enabled: false });
  for (const enabled of [true, false]) assert.deepEqual(strikeSettings({ enabled }), { enabled });
  for (const input of [null, false, [], 'true', { enabled: 'false' }, { enabled: 0 }, { enabled: null }, { enable: true }]) {
    assert.throws(() => strikeSettings(input));
  }
  const store = memory(), prior = new SellerStrikes({ store, enabled: true });
  prior.record(seller, 'a', 100); prior.record(seller, 'b', 101);
  const paused = new SellerStrikes({ store });
  assert.equal(paused.refusal(seller, 102), null);
  assert.equal(paused.record(seller, 'c', 102), false);
  assert.deepEqual(paused.list(102), prior.list(102));
});

test('disabled host neither records nor refuses existing records, and does not probe infrastructure', async t => {
  const disk = memory(), prior = new SellerStrikes({ store: disk, enabled: true });
  prior.record(seller, 'old-a', 100); prior.record(seller, 'old-b', 101);
  const r = record('disabled'), f = await fixture(t, { disk, enabled: false, now: deadline(r),
    check: () => assert.fail('disabled strikes must not read escrow'),
    trac: { gatewayHealth: () => assert.fail('disabled strikes must not poll gateway') } });
  await f.host.addTrade(r); await f.tick();
  const next = record('admit', 'checkingSellerFunds'); delete next.signerAckedAt;
  next.state.terms.sendBy += 5000; next.state.sellerFundsDeadline = f.clock.now + 100;
  await f.host.addTrade(next); await f.host.deliver(next.key, { type: 'resume' }); await flush(f.host);
  assert.equal(f.host.trades.get(next.key).state.phase, 'holding');
  assert.ok(f.sent.some(m => m.kind === 'ack' && m.body.tradeId === next.state.tradeId));
  assert.deepEqual(f.strikes.list(f.clock.now).strikes.map(s => s.tradeId), ['old-a', 'old-b']);
  assert.ok(!f.logs.some(l => l.startsWith('seller struck ')));
  assert.equal(f.disk.get('trade-disabled').sellerStrikeExemption.reason, 'strikes-disabled');
});

test('a failed pre-ack seller balance read remains exempt after recovery and acknowledgement', async t => {
  let healthy = false;
  const r = record('pre-ack', 'checkingSellerFunds'); delete r.signerAckedAt;
  const f = await fixture(t, { trac: { balances: async () => {
    if (!healthy) throw Error('RESET balance unavailable: read timed out');
    return { TNK: '1000000000000000000', RESET: '1000000000000000000', feeTnk: '3' };
  } } });
  await f.host.addTrade(r); await f.host.deliver(r.key, { type: 'resume' }); await flush(f.host);
  healthy = true; f.clock.now += 10; await f.tick();
  assert.equal(f.host.trades.get(r.key).state.phase, 'holding');
  assert.ok(f.sent.some(m => m.kind === 'ack'));
  assert.equal(f.disk.get('trade-pre-ack').sellerStrikeExemption.reason, 'seller-read-failed');
  f.clock.now = deadline(r); await f.tick();
  assert.deepEqual(f.strikes.list(f.clock.now).strikes, []);
});

for (const asset of ['TNK', 'RESET']) test(`${asset}: a post-ack balance failure exempts only that trade, even after recovery`, async t => {
  const r = record('outage'), f = await fixture(t);
  if (asset === 'RESET') { r.state.terms.base = { kind: 'RESET', id: 'RESET', decimals: 8 }; r.state.terms.pair = 'RESET/USDC'; }
  await f.host.addTrade(r); await f.tick();
  const balances = f.host.trac.balances;
  f.host.trac.balances = async () => { throw Error('read unavailable'); };
  f.clock.now += 15; await f.tick();
  assert.equal(f.disk.get('trade-outage').sellerStrikeExemption.reason, 'seller-read-failed');
  f.host.trac.balances = balances;
  const healthy = record('healthy'); await f.host.addTrade(healthy); await f.tick();
  f.clock.now = deadline(r); await f.tick();
  assert.deepEqual(f.strikes.list(f.clock.now).strikes.map(s => s.tradeId), [healthy.state.tradeId]);
});

test('a read begun inside the window cannot race a strike when its failure arrives after the deadline', async t => {
  let reject;
  const r = record('pending'), f = await fixture(t, { now: deadline(r) - 1,
    trac: { balances: () => new Promise((_, no) => { reject = no; }) } });
  await f.host.addTrade(r); await f.tick();
  f.clock.now = deadline(r); await f.tick();
  assert.deepEqual(f.strikes.list(f.clock.now).strikes, []);
  reject(Error('read timed out')); await flush(f.host); await f.tick();
  assert.equal(f.disk.get('trade-pending').sellerStrikeExemption.reason, 'seller-read-failed');
  assert.deepEqual(f.strikes.list(f.clock.now).strikes, []);
});

test('a hung own-node read is bounded and exempts the trade instead of hanging strike evaluation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = record('timeout'), f = await fixture(t, { now: deadline(r) - 1,
    trac: { balances: () => new Promise(() => {}) } });
  await f.host.addTrade(r); await f.tick();
  f.clock.now = deadline(r); await f.tick();
  t.mock.timers.tick(STRIKE_READ_TIMEOUT_MS); await flush(f.host); await f.tick();
  assert.equal(f.disk.get('trade-timeout').sellerStrikeExemption.reason, 'seller-read-failed');
  assert.equal(f.host.trades.get(r.key).sellerReadsPending, 0);
  assert.deepEqual(f.strikes.list(f.clock.now).strikes, []);
});

test('RESET gateway counts below three, unknown health and failed checks exempt RESET; three permits a healthy no-show strike', async t => {
  for (const eligible of [0, 1, 2, 3, null, 'throw']) {
    const r = record(String(eligible)), f = await fixture(t, { trac: { gatewayHealth: async () => {
      if (eligible === 'throw') throw Error('gateway timeout');
      return { ok: eligible === 3, eligible };
    } } });
    r.state.terms.base = { kind: 'RESET', id: 'RESET', decimals: 8 }; r.state.terms.pair = 'RESET/USDC';
    await f.host.addTrade(r); await f.tick();
    f.host.trac.gatewayHealth = async () => ({ ok: true, eligible: 3 });
    f.clock.now += 15; await f.tick();
    f.clock.now = deadline(r); await f.tick();
    assert.equal(f.strikes.list(f.clock.now).strikes.length, eligible === 3 ? 1 : 0, String(eligible));
    if (eligible !== 3) assert.equal(f.disk.get(`trade-${r.key}`).sellerStrikeExemption.reason, 'reset-gateway-unavailable');
  }
});

test('RESET gateway requests that hang across the deadline time out without a strike', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = record('gateway-timeout'), f = await fixture(t, { now: deadline(r) - 1,
    trac: { gatewayHealth: () => new Promise(() => {}) } });
  r.state.terms.base = { kind: 'RESET', id: 'RESET', decimals: 8 }; r.state.terms.pair = 'RESET/USDC';
  await f.host.addTrade(r); await f.tick();
  f.clock.now = deadline(r); await f.tick();
  assert.deepEqual(f.strikes.list(f.clock.now).strikes, []);
  t.mock.timers.tick(STRIKE_READ_TIMEOUT_MS); await flush(f.host); await f.tick();
  assert.equal(f.disk.get('trade-gateway-timeout').sellerStrikeExemption.reason, 'reset-gateway-unavailable');
  assert.deepEqual(f.strikes.list(f.clock.now).strikes, []);
});

test('own-node discovery read errors exempt; a healthy not-final candidate does not', async t => {
  for (const reason of ['read_failed', 'verification_failed', 'not_final']) {
    const r = record(reason), f = await fixture(t, { trac: {
      recentTransferCandidates: async () => [hex()], verifyTransfer: async () => ({ ok: false, final: false, reason }),
    } });
    await f.host.addTrade(r); f.clock.now += 30; await f.tick();
    f.clock.now = deadline(r); await f.tick();
    assert.equal(f.strikes.list(f.clock.now).strikes.length, reason === 'not_final' ? 1 : 0, reason);
  }
});

test('existing signed seller outage aborts exempt, including gateway message truncation and late forwarded delivery', async t => {
  const gateway = "RESET transfers are paused: the RESET gateway can't reach enough validators right now. Try again in a few minutes.";
  for (const reason of [gateway, 'read_failed', 'gateway_rejected']) {
    const r = record(), f = await fixture(t, { now: deadline(r) });
    await f.host.addTrade(r); await f.tick(); await f.tick();
    assert.equal(f.strikes.list(f.clock.now).strikes.length, 1);
    const ch = tradeChannel(r.state.tradeId), notice = seal({ kind: 'abort', ch, body: { tradeId: r.state.tradeId,
      reason: ('Transfer not sent before the deadline: ' + reason).slice(0, 160) } }, sim.f.seller.secretKey,
      { ts: r.state.terms.sendBy, nonce: hex() });
    f.bridge.emit('message', 'intercom-dex:signers', notice); await flush(f.host);
    assert.deepEqual(f.strikes.list(f.clock.now).strikes, []);
    assert.equal(f.disk.get(`trade-${r.key}`).sellerStrikeExemption.reason, 'seller-infrastructure-notice');
    assert.ok(f.sent.some(m => m.sig === notice.sig));
    assert.equal(f.host.trades.get(r.key).state.phase, 'expired', 'an exemption never publishes a share');
  }
});

test('bad signatures, other senders/trades, old timestamps and generic aborts cannot claim an outage exemption', async t => {
  const r = record('invalid-notice'), f = await fixture(t, { now: deadline(r) });
  await f.host.addTrade(r); await f.tick();
  const ch = tradeChannel(r.state.tradeId);
  for (const what of ['signature', 'buyer', 'foreign-trade', 'old', 'generic']) {
    const notice = seal({ kind: 'abort', ch, body: { tradeId: what === 'foreign-trade' ? hex() : r.state.tradeId,
      reason: 'Transfer not sent before the deadline: ' + (what === 'generic' ? 'send_failed' : 'read_failed') } },
    (what === 'buyer' ? sim.f.buyer : sim.f.seller).secretKey,
    { ts: what === 'old' ? 0 : r.state.terms.sendBy, nonce: hex() });
    if (what === 'signature') notice.sig = '00'.repeat(64);
    f.bridge.emit('message', 'intercom-dex:signers', notice); await flush(f.host);
    assert.equal(f.strikes.list(f.clock.now).strikes.length, 1, what);
    assert.equal(f.disk.get('trade-invalid-notice').sellerStrikeExemption, undefined, what);
  }
});

test('exemptions survive restart; legacy and paused windows are never struck retrospectively', async t => {
  const r = record('durable'), f = await fixture(t, { trac: { balances: async () => { throw Error('read failed'); } } });
  await f.host.addTrade(r); await f.tick(); f.host.stop();
  const legacy = record('legacy', 'expired'); f.disk.put('trade-legacy', legacy);
  const again = await fixture(t, { disk: f.disk, now: deadline(r) }); await again.tick();
  assert.equal(f.disk.get('trade-durable').sellerStrikeExemption.reason, 'seller-read-failed');
  assert.equal(f.disk.get('trade-legacy').sellerStrikeExemption.reason, 'unobserved-window');
  assert.deepEqual(again.strikes.list(again.clock.now).strikes, []);
  again.host.stop();
  const paused = await fixture(t, { disk: f.disk, now: deadline(r), enabled: false });
  const off = record('off', 'expired'); await paused.host.addTrade(off); paused.host.stop();
  const enabled = await fixture(t, { disk: f.disk, now: deadline(r) + 1 }); await enabled.tick();
  assert.equal(f.disk.get('trade-off').sellerStrikeExemption.reason, 'strikes-disabled');
  assert.deepEqual(enabled.strikes.list(enabled.clock.now).strikes, []);
});

test('disabled signers suppress saved seller-struck refusals and ignore an in-flight escrow result', async t => {
  let release;
  const r = record('switch'), f = await fixture(t, { now: deadline(r), check: ({ hashHex, purpose }) => new Promise(resolve => {
    release = () => resolve({ ok: true, hashHex, purpose, status: 'active' });
  }) });
  await f.host.addTrade(r); await f.tick();
  f.strikes.enabled = false;
  release(); await flush(f.host);
  const ch = tradeChannel(r.state.tradeId), trade = f.host.trades.get(r.key);
  await f.host.sendEnvelope(trade, ch, seal({ kind: 'refused', ch, body: { tradeId: r.state.tradeId, reason: 'seller-struck' } },
    sim.nodes.get('signer1').identity.secretKey, { ts: f.clock.now, nonce: hex() }));
  assert.deepEqual(f.strikes.list(f.clock.now).strikes, []);
  assert.ok(!f.sent.some(m => m.kind === 'refused'));
});
