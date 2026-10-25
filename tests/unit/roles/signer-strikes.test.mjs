import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SellerStrikes, STRIKE_WINDOW_SEC as WEEK, strikeCandidate } from '../../../src/roles/signer-strikes.js';
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
  const b = new SellerStrikes({ store: memory() });
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
  const b = new SellerStrikes({ store: memory() });
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
  const first = new SellerStrikes({ store: openStore(dir, key) });
  first.record(seller, 'a', 100); first.record(seller, 'b', 200);
  const logs = [], second = new SellerStrikes({ store: openStore(dir, key), log: line => logs.push(line) });
  assert.equal(second.refusal(seller, 201).until, 200 + WEEK);
  second.forget('a', 202); assert.equal(second.refusal(seller, 202), null);
  assert.deepEqual(second.list(202).strikes.map(s => s.tradeId), ['b']);
  second.record(seller, 'c', 203);
  assert.deepEqual(second.clear(seller, 204), { cleared: true, strikes: 2, refusals: 1 });
  assert.deepEqual(new SellerStrikes({ store: openStore(dir, key) }).list(204), { strikes: [], refusals: [] });
  assert.ok(logs.some(l => l.startsWith('seller strike clear seller=')));
});

test('caps evict oldest strikes and refusals; clearing one address leaves other addresses intact', () => {
  const disk = memory(), b = new SellerStrikes({ store: disk, cap: 2 });
  const others = [seller, { ...seller, tracAddr: 'second-address' }, { ...seller, tracAddr: 'another' }];
  others.forEach((s, i) => { b.record(s, `a${i}`, 100 + i * 2); b.record(s, `b${i}`, 101 + i * 2); });
  assert.deepEqual(b.list(110).strikes.map(s => s.tradeId), ['a2', 'b2']);
  assert.equal(b.list(110).refusals.length, 2);
  assert.equal(b.refusal(seller, 110), null);
  b.clear(others[1], 111);
  assert.ok(b.refusal(others[2], 111));
  const clock = new SellerStrikes({ store: memory(), cap: 2 });
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

async function fixture(t, { disk = memory(), check, send, now = 101 } = {}) {
  const bridge = new EventEmitter(), sent = [], logs = [], clock = { now }, timers = [];
  t.mock.method(globalThis, 'setInterval', fn => { timers.push(fn); return fn; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  bridge.join = bridge.leave = async () => {};
  bridge.send = send ?? (async (_ch, m) => { sent.push(m); });
  const strikes = new SellerStrikes({ store: disk, log: l => logs.push(l) });
  const identity = sim.nodes.get('signer1').identity;
  const host = new TradeHost({ bridge, store: disk, identity: { publicKey: encodeKey(identity.publicKey), secretKey: identity.secretKey },
    profile: { peer: { msbNetworkId: networkId }, mint: sim.f.terms.mint, platformCollector: sim.f.terms.fees.platformCollector },
    now: () => clock.now, signerStrikes: strikes, signerSolana: { checkEscrow: check ?? (async ({ hashHex, purpose }) => ({ ok: true, hashHex, purpose, status: 'active' })) },
    trac: { balances: async () => ({ TNK: '1000000000000000000', feeTnk: '3' }), reserveTx: async ({ tradeId }) => ({ ok: true, reservedFor: tradeId }) },
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

test('restart records overdue acked trades once, preserves clear, and reconciles interrupted evidence cancellation', async t => {
  const disk = memory(), r = record('restart', 'expired'); disk.put('trade-restart', r);
  const first = await fixture(t, { disk, now: deadline(r) }); await first.tick(); first.host.stop();
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
