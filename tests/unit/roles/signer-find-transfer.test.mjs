import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { TradeHost } from '../../../src/roles/host.js';
import { createTracAdapter } from '../../../src/trac/adapter.js';
import { encodeKey } from '../../../src/core/keys.js';
import { seal } from '../../../src/core/envelope.js';
import { transferNonce } from '../../../src/core/terms.js';
import { simulation } from '../core/simulation.mjs';
import { hex } from '../core/helpers.mjs';
import PeerWallet from '../../../peer/node_modules/trac-wallet/index.js';

const sims = Object.fromEntries(['TNK', 'RESET'].map(asset => [asset, simulation({ pair: asset + '/USDC', capturePhases: true })]));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

async function fixture(t, asset = 'RESET') {
  const sim = sims[asset], state = structuredClone(sim.snapshots.get('signer1:holding'));
  const clock = { now: state.now }, timers = [], logs = [], sent = [], calls = [], requests = [], phases = [], records = new Map();
  t.mock.method(Date, 'now', () => clock.now * 1000);
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const txHash = hex(), rows = [{ tx: txHash, address: state.terms.seller.tracAddr, to: state.terms.buyer.tracAddr,
    type: asset === 'RESET' ? '12' : '13', am: state.terms.baseAmount, createdAt: new Date(state.now * 1000).toISOString() }];
  const f = { clock, logs, sent, calls, requests, phases, records, state, txHash, rows, verifies: 0, reserves: 0,
    response: () => Response.json({ transactions: JSON.stringify(f.rows), nextOffset: 10, count: 100 }),
    proof: () => ({ ok: true, final: true, amount: state.terms.baseAmount }) };
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, options }); return f.response(); });
  const bridge = new EventEmitter();
  bridge.join = async () => {}; bridge.leave = async () => {}; bridge.send = async (_ch, m) => { sent.push(m); };
  bridge.call = async (type, params) => { assert.equal(type, 'dex_verify'); calls.push(params); return f.proof(params); };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 's1-find-'));
  const trac = createTracAdapter({ bridge, usedTxFolder: folder });
  const verify = trac.verifyTransfer.bind(trac), reserve = trac.reserveTx.bind(trac);
  trac.verifyTransfer = a => { f.verifies++; return verify(a); };
  trac.reserveTx = a => { f.reserves++; return reserve(a); };
  const store = { list: () => [], get: n => records.get(n), put: (n, v) => records.set(n, structuredClone(v)) };
  const signer = sim.nodes.get('signer1').identity;
  const host = new TradeHost({ bridge, store, trac, identity: { publicKey: encodeKey(signer.publicKey), secretKey: signer.secretKey },
    now: () => clock.now, log: (...args) => logs.push(args.join(' ')) });
  host.hooks.afterStep.push(trade => phases.push(trade.state.phase));
  t.after(() => { host.stop(); trac.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  await host.start(); await host.addTrade({ key: 'test', role: 'signer', state, lifetimeSec: 86400 });
  const trade = host.trades.get('test');
  const flush = async () => { for (let i = 0; i < 4; i++) { await new Promise(r => setImmediate(r)); await trade.queue; } };
  const tick = async now => { clock.now = now; timers.find(timer => timer.ms === 1000).fn(); await flush(); };
  const notice = async (hash = txHash) => {
    await host.inject('test', seal({ kind: 'transferSent', ch: 'intercom-dex:t:' + state.tradeId,
      body: { tradeId: state.tradeId, txHash: hash } }, sim.f.seller.secretKey, { ts: clock.now, nonce: hex() }));
    await flush();
  };
  return Object.assign(f, { host, trac, trade, store, flush, tick, notice });
}

for (const asset of ['RESET', 'TNK']) test(`${asset}: a lost message is discovered on the own peer, reserved and published once`, async t => {
  const f = await fixture(t, asset), { terms } = f.state;
  await f.tick(f.state.holdingSince + 29);
  assert.equal(f.requests.length, 0);
  await f.tick(f.state.holdingSince + 30);
  assert.equal(f.trade.state.phase, 'published');
  assert.equal(f.requests.length, 1); assert.equal(f.verifies, 1); assert.equal(f.reserves, 1);
  const address = a => asset === 'RESET' ? Buffer.from(PeerWallet.decodeBech32mSafe(a)).toString('hex') : a;
  assert.deepEqual(f.calls, [{ asset, txHash: f.txHash, from: address(terms.seller.tracAddr), to: address(terms.buyer.tracAddr),
    minAmount: terms.baseAmount, nonce: transferNonce(f.state.tradeId) }]);
  assert.ok(f.phases.includes('verifyingTransfer')); assert.ok(f.phases.includes('persistingTransfer'));
  assert.equal(f.records.get('trade-test').state.phase, 'published');
  assert.equal(f.sent.filter(m => m.kind === 'sharePublish').length, 2, 'one publication to each existing channel');
  assert.deepEqual(f.logs.filter(line => line.startsWith('found transfer')), [
    `found transfer ${f.txHash.slice(0, 12)} for ${f.state.tradeId.slice(0, 12)} on the explorer`]);
  await f.notice();
  assert.equal(f.verifies, 1); assert.equal(f.reserves, 1);
});

test('wrong amount, recipient, nonce and non-final candidates leave the signer holding, then a later round succeeds', async t => {
  const f = await fixture(t);
  f.rows = Array.from({ length: 5 }, (_, i) => ({ ...f.rows[0], tx: String(i + 1).repeat(64) }));
  let n = 0;
  f.proof = () => [
    { ok: true, final: true, amount: '1' },
    { ok: false, final: true, reason: 'wrong_recipient' },
    { ok: false, final: true, reason: 'wrong_nonce' },
    { ok: true, final: false, amount: f.state.terms.baseAmount },
    { ok: false, final: false, reason: 'read_failed' },
  ][n++];
  await f.tick(f.state.now + 30);
  assert.equal(f.verifies, 5); assert.equal(f.reserves, 0); assert.equal(f.trade.state.phase, 'holding');
  assert.equal(f.sent.filter(m => m.kind === 'sharePublish' || m.kind === 'abort').length, 0);
  assert.deepEqual(f.logs, []);
  await f.tick(f.state.now + 44); assert.equal(f.requests.length, 1);
  f.proof = () => ({ ok: true, final: true, amount: f.state.terms.baseAmount });
  await f.tick(f.state.now + 45); assert.equal(f.trade.state.phase, 'published');
});

test('empty pages and an unavailable explorer are silent and retried after 15 seconds', async t => {
  const f = await fixture(t);
  f.rows = []; await f.tick(f.state.now + 30);
  f.response = () => { throw Error('explorer down'); };
  await f.tick(f.state.now + 45);
  assert.equal(f.requests.length, 2); assert.equal(f.verifies, 0);
  assert.equal(f.trade.state.phase, 'holding'); assert.deepEqual(f.logs, []);
  f.response = () => Response.json({ transactions: JSON.stringify([{ tx: f.txHash, address: f.state.terms.seller.tracAddr,
    type: '12', createdAt: new Date(f.state.now * 1000).toISOString() }]) });
  await f.tick(f.state.now + 60); assert.equal(f.trade.state.phase, 'published');
});

test('a seller notice before discovery avoids the explorer entirely', async t => {
  const f = await fixture(t);
  await f.notice(); await f.tick(f.state.now + 30);
  assert.equal(f.requests.length, 0); assert.equal(f.verifies, 1); assert.equal(f.trade.state.phase, 'published');
});

test('a notice during the explorer request wins and suppresses discovery verification', async t => {
  const f = await fixture(t), pending = deferred(); f.response = () => pending.promise;
  await f.tick(f.state.now + 30); await f.tick(f.state.now + 45);
  assert.equal(f.requests.length, 1, 'polls never overlap');
  await f.notice(); pending.resolve(Response.json({ transactions: JSON.stringify(f.rows) })); await f.flush();
  assert.equal(f.verifies, 1); assert.equal(f.reserves, 1); assert.equal(f.trade.state.phase, 'published');
  assert.equal(f.logs.filter(line => line.startsWith('found transfer')).length, 0);
});

test('a notice racing the same in-flight candidate shares one verification', async t => {
  const f = await fixture(t), pending = deferred(); f.proof = () => pending.promise;
  await f.tick(f.state.now + 30); assert.equal(f.verifies, 1);
  await f.notice(); assert.equal(f.verifies, 1);
  pending.resolve({ ok: true, final: true, amount: f.state.terms.baseAmount }); await f.flush();
  assert.equal(f.trade.state.phase, 'published'); assert.equal(f.verifies, 1); assert.equal(f.reserves, 1);
});

test('no discovery starts at the cutoff, and an explorer response arriving there is discarded', async t => {
  const f = await fixture(t), deadline = f.state.terms.sendBy + f.state.terms.graceSec, pending = deferred();
  f.response = () => pending.promise;
  await f.tick(deadline - 1); assert.equal(f.requests.length, 1);
  await f.tick(deadline); assert.equal(f.trade.state.phase, 'expired');
  pending.resolve(Response.json({ transactions: JSON.stringify(f.rows) })); await f.flush();
  assert.equal(f.verifies, 0); assert.equal(f.requests.length, 1); assert.equal(f.reserves, 0);
});

test('candidate verification completing at the cutoff never publishes shares', async t => {
  const f = await fixture(t), deadline = f.state.terms.sendBy + f.state.terms.graceSec, pending = deferred();
  f.proof = () => pending.promise;
  await f.tick(deadline - 1);
  f.clock.now = deadline; pending.resolve({ ok: true, final: true, amount: f.state.terms.baseAmount }); await f.flush();
  assert.equal(f.trade.state.phase, 'holding'); assert.equal(f.reserves, 0);
  await f.tick(deadline); assert.equal(f.trade.state.phase, 'expired');
  assert.equal(f.sent.filter(m => m.kind === 'sharePublish').length, 0);
});

test('restoring an old holding record uses its first ack time and resumes discovery without waiting again', async t => {
  const f = await fixture(t);
  f.host.stop();
  const record = f.records.get('trade-test');
  delete record.state.holdingSince;
  record.signerAckedAt = f.state.now;
  record.state.now += 25;
  f.clock.now = f.state.now + 30;
  f.store.list = prefix => [...f.records.keys()].filter(name => name.startsWith(prefix));
  const host = new TradeHost({ bridge: f.host.bridge, store: f.store, trac: f.trac, identity: f.host.identity,
    now: () => f.clock.now, log: (...args) => f.logs.push(args.join(' ')) });
  t.after(() => host.stop());
  await host.start();
  const restored = host.trades.get('test');
  await restored.queue;
  assert.equal(restored.state.holdingSince, f.state.now);
  await host.deliver('test', { type: 'tick' });
  for (let i = 0; i < 4; i++) { await new Promise(r => setImmediate(r)); await restored.queue; }
  assert.equal(restored.state.phase, 'published'); assert.equal(f.verifies, 1);
  assert.equal(Object.hasOwn(f.records.get('trade-test'), 'discoveryCheck'), false);
});

test('a reserved hash never reaches candidate verification, and stopping discards a pending explorer response', async t => {
  const f = await fixture(t);
  f.trac.reserveTx({ txHash: f.txHash, tradeId: hex() });
  await f.tick(f.state.now + 30);
  assert.equal(f.verifies, 0); assert.equal(f.trade.state.phase, 'holding');
  const pending = deferred(); f.response = () => pending.promise;
  await f.tick(f.state.now + 45); f.host.stop();
  pending.resolve(Response.json({ transactions: JSON.stringify([{ ...f.rows[0], tx: hex() }]) })); await f.flush();
  assert.equal(f.verifies, 0); assert.equal(f.trade.state.phase, 'holding'); assert.deepEqual(f.logs, []);
});
