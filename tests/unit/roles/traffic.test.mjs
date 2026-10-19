import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TradeHost, tradeChannel } from '../../../src/roles/host.js';
import { simulation } from '../core/simulation.mjs';
import { seal } from '../../../src/core/envelope.js';
import { encodeKey } from '../../../src/core/keys.js';
import { hex } from '../core/helpers.mjs';

const sim = simulation({ capturePhases: true });
async function host(t, role, state, identity) {
  const timers = [], sent = [], records = new Map(), clock = { now: state.now };
  t.mock.method(globalThis, 'setInterval', fn => { timers.push(fn); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const bridge = new EventEmitter(); bridge.join = async () => {}; bridge.send = async (ch, envelope) => sent.push({ ch, envelope });
  const store = { list: () => [], get: k => records.get(k), put: (k, v) => records.set(k, structuredClone(v)) };
  const h = new TradeHost({ bridge, store, identity: { secretKey: identity.secretKey, publicKey: encodeKey(identity.publicKey) },
    serviceKey: encodeKey(sim.f.service.publicKey), now: () => clock.now });
  await h.start(); t.after(() => h.stop());
  await h.addTrade({ key: 'trade', role, state: structuredClone(state), lifetimeSec: 172800 + 3600 });
  await new Promise(r => setImmediate(r)); sent.length = 0;
  const tr = h.trades.get('trade');
  const tick = async seconds => { clock.now += seconds; timers[0](); await tr.queue; await new Promise(r => setImmediate(r)); };
  const receive = async (from, kind, body, channel = tradeChannel(state.tradeId)) => {
    bridge.emit('message', channel, seal({ kind, body, ch: channel }, from.secretKey, { ts: clock.now, nonce: hex() }));
    await new Promise(r => setImmediate(r)); await tr.queue;
  };
  return { h, tr, clock, sent, tick, receive, records };
}

test('published signer repeats only publications at 10,20,40 seconds to 600 cap, persists schedule and stops at refund', async t => {
  const node = sim.nodes.get('signer1'), f = await host(t, 'signer', node.state, node.identity);
  const pub = sim.log.find(x => x.name === 'signer1' && x.action.type === 'publishShare').action;
  for (const ch of pub.channels) f.tr.outbox[ch] = [seal({ kind: 'ack', ch, body: { tradeId: node.state.tradeId, H: pub.body.H, holdUntil: node.state.terms.refundAfter } }, node.identity.secretKey, { ts: f.clock.now, nonce: hex() }),
    seal({ kind: 'sharePublish', ch, body: pub.body }, node.identity.secretKey, { ts: f.clock.now, nonce: hex() })];
  f.tr.publicationAt = f.clock.now; f.tr.publicationDelay = 10;
  for (const delay of [10, 20, 40, 80, 160, 320, 600, 600]) {
    const n = f.sent.length; await f.tick(delay - 1); assert.equal(f.sent.length, n);
    await f.tick(1); assert.equal(f.sent.length, n + 2);
    assert.ok(f.sent.every(x => x.envelope.kind === 'sharePublish'));
  }
  assert.equal(f.records.get('trade-trade').publicationDelay, 600);
  const count = f.sent.length; f.clock.now = node.state.terms.refundAfter; await f.tick(0); assert.equal(f.sent.length, count);
});

test('publication recovery authenticates seller/service, rate limits each requester and does not exhaust the ordinary message cap', async t => {
  const node = sim.nodes.get('signer1'), f = await host(t, 'signer', node.state, node.identity), id = node.state.tradeId;
  const pub = sim.log.find(x => x.name === 'signer1' && x.action.type === 'publishShare').action;
  for (const ch of pub.channels) f.tr.outbox[ch] = [seal({ kind: 'sharePublish', ch, body: pub.body }, node.identity.secretKey, { ts: f.clock.now, nonce: hex() })];
  await f.receive(sim.f.buyer, 'shareRequest', { tradeId: id }); assert.equal(f.sent.length, 0);
  await f.receive(sim.f.seller, 'shareRequest', { tradeId: hex() }); assert.equal(f.sent.length, 0);
  f.tr.perSender.set(encodeKey(sim.f.seller.publicKey), 400);
  await f.receive(sim.f.seller, 'shareRequest', { tradeId: id }); assert.equal(f.sent.length, 1);
  await f.receive(sim.f.seller, 'shareRequest', { tradeId: id }); assert.equal(f.sent.length, 1);
  await f.receive(sim.f.service, 'shareRequest', { tradeId: id }, 'intercom-dex:signers'); assert.equal(f.sent.length, 2);
  f.clock.now += 29; await f.receive(sim.f.seller, 'shareRequest', { tradeId: id }); assert.equal(f.sent.length, 2);
  f.clock.now++; await f.receive(sim.f.seller, 'shareRequest', { tradeId: id }); assert.equal(f.sent.length, 3);
  await f.receive(sim.f.seller, 'present', { ref: id }); assert.equal(f.sent.length, 4);
  await f.receive(sim.f.seller, 'present', { ref: id }); assert.equal(f.sent.length, 4);
  f.clock.now = node.state.terms.refundAfter;
  await f.receive(sim.f.seller, 'shareRequest', { tradeId: id }); assert.equal(f.sent.length, 4);
});

test('seller requests missing valid shares every thirty seconds, stops at k or refund, and waiting outbox still repeats at ten seconds', async t => {
  const state = sim.snapshots.get('seller:awaitShares'), f = await host(t, 'seller', state, sim.f.seller);
  f.tr.outbox[tradeChannel(state.tradeId)] = [seal({ kind: 'transferSent', ch: tradeChannel(state.tradeId), body: { tradeId: state.tradeId, txHash: state.txHash } }, sim.f.seller.secretKey, { ts: f.clock.now, nonce: hex() })];
  await f.tick(0); await f.tick(10);
  assert.equal(f.sent.filter(x => x.envelope.kind === 'shareRequest').length, 1);
  assert.equal(f.sent.filter(x => x.envelope.kind === 'transferSent').length, 1);
  await f.tick(20); assert.equal(f.sent.filter(x => x.envelope.kind === 'shareRequest').length, 2);
  f.tr.state.shares = Array.from({ length: state.terms.k }, (_, i) => ({ id: i + 1, share: hex() }));
  await f.tick(30); assert.equal(f.sent.filter(x => x.envelope.kind === 'shareRequest').length, 2);
});
