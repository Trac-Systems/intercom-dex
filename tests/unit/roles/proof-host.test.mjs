import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TradeHost, isFinished } from '../../../src/roles/host.js';
import { Trader } from '../../../src/roles/trader.js';
import { seal } from '../../../src/core/envelope.js';
import { encodeKey } from '../../../src/core/keys.js';
import { hex } from '../core/helpers.mjs';
import { simulation } from '../core/simulation.mjs';

const sim = simulation({ capturePhases: true });
class Bridge extends EventEmitter {
  sent = [];
  async join() {}
  async send(ch, m) { this.sent.push(m); }
}
const snapshot = (name, phase) => structuredClone(sim.snapshots.get(name + ':' + phase));
const identity = name => ({ publicKey: encodeKey(sim.nodes.get(name).identity.publicKey), secretKey: sim.nodes.get(name).identity.secretKey });
function setup(name, state, options = {}) {
  const records = new Map();
  const store = { put: (k, v) => records.set(k, structuredClone(v)), get: k => structuredClone(records.get(k)), list: prefix => [...records.keys()].filter(k => k.startsWith(prefix)) };
  const bridge = new Bridge(), effects = [];
  const host = new TradeHost({ bridge, store, identity: identity(name), now: () => 101, tickMs: 100000,
    solana: null, trac: { sendTransfer: () => effects.push('send') }, ...options });
  const key = name;
  const record = { key, role: state.role, state, lifetimeSec: 90000 };
  return { records, store, bridge, host, effects, key, record };
}
async function finished(host, key) {
  for (let i = 0; i < 500; i++) {
    const t = host.trades.get(key);
    if (isFinished(t) && t.busy.size === 0) { await t.queue; return t; }
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Proof result did not reach the trade');
}

test('host resumes proving from persisted state and returns file errors as proved:false without locking', async t => {
  const s = snapshot('buyer', 'proving'), x = setup('buyer', s, { proof: { zkey: '/no-such-unit-test.zkey' } });
  x.store.put('trade-buyer', { ...x.record, outbox: {}, raw: [], buffer: [] });
  t.after(() => x.host.stop()); await x.host.start();
  const result = await finished(x.host, x.key);
  assert.equal(result.state.phase, 'aborted'); assert.equal(result.state.locked, false); assert.ok(!result.state.lockAttempted);
  assert.equal(x.store.get('trade-buyer').state.phase, 'aborted');
  assert.ok(!x.bridge.sent.some(m => m.kind === 'deal')); assert.deepEqual(x.effects, []);
});
test('host restores pending proof checks and persists refusal, with no seller transfer or signer ack', async t => {
  for (const name of ['seller', 'signer1']) {
    const s = snapshot(name, 'checkingProof'); s.deal.proof = {}; // malformed: cheap rejection, no real proving
    const x = setup(name, s);
    x.store.put('trade-' + name, { ...x.record, outbox: {}, raw: [], buffer: [] });
    t.after(() => x.host.stop()); await x.host.start();
    const result = await finished(x.host, x.key);
    assert.equal(result.state.reason, 'Invalid lock certificate'); assert.equal(x.store.get('trade-' + name).state.phase, 'aborted');
    assert.ok(!x.bridge.sent.some(m => m.kind === 'ack')); assert.deepEqual(x.effects, []);
  }
});
test('host buffers only the buyer deal and executes its pending proof check', async t => {
  const x = setup('seller', snapshot('seller', 'awaitDeal'));
  t.after(() => x.host.stop()); await x.host.start(); await x.host.addTrade(x.record);
  const ch = 'intercom-dex:t:' + x.record.state.tradeId, body = sim.state('seller').deal;
  for (const name of ['signer1', 'buyer']) {
    const m = seal({ kind: 'deal', ch, body }, identity(name).secretKey, { ts: 101, nonce: hex() });
    x.bridge.emit('message', ch, m);
    if (name === 'signer1') {
      await new Promise(r => setImmediate(r));
      assert.equal(x.host.trades.get(x.key).state.phase, 'awaitDeal');
    }
  }
  const result = await finished(x.host, x.key);
  assert.equal(result.state.reason, 'Invalid lock certificate', 'the shape-valid placeholder does not verify');
  assert.deepEqual(x.effects, []);
});
test('trader requires an absolute proof.zkey', () => {
  for (const proof of [undefined, {}, { zkey: 'relative' }, { zkey: 1 }]) assert.throws(() => new Trader({ proof }), /proof.zkey/);
});
