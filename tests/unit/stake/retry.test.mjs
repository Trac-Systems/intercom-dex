import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Trader } from '../../../src/roles/trader.js';
import { controlHandler } from '../../../src/roles/control.js';
import { stepFinalized } from '../../../src/core/trade-seller.js';
import { simulation } from '../core/simulation.mjs';
import { memoryStore } from './helpers.mjs';
const original = simulation({ capturePhases: true }).snapshots.get('seller:transferring');
function fixture(t, afterDeadline = false) {
  const trade = { role: 'seller', key: 'retry', state: structuredClone(original) }, actions = [];
  let now = afterDeadline ? trade.state.terms.sendBy : trade.state.now;
  t.mock.method(Date, 'now', () => now * 1000);
  const store = memoryStore(), role = { store, host: { trades: new Map([[trade.key, trade]]), deliver: async (key, event) => {
    assert.equal(key, trade.key); const result = stepFinalized(trade.state, { ...event, now });
    trade.state = result.state; actions.push(...result.actions);
  } } };
  role.retryDelivery = input => Trader.prototype.retryDelivery.call(role, input);
  return { role, trade, actions, advance: seconds => { now += seconds; } };
}

test('delivery retry resumes only the existing seller trade and throttles across durable reloads', async t => {
  const f = fixture(t), input = { tradeId: f.trade.state.tradeId };
  await f.role.retryDelivery(input);
  assert.equal(f.actions.filter(a => a.type === 'sendTransfer').length, 1);
  const send = f.actions.find(a => a.type === 'sendTransfer'); assert.equal(send.resume, true); assert.equal(send.amount, original.terms.baseAmount);
  const next = await Trader.prototype.retryDelivery.call({ ...f.role }, input); assert.equal(next.throttled, true);
  f.advance(10); await f.role.retryDelivery(input); assert.equal(f.actions.filter(a => a.type === 'sendTransfer').length, 2);
  await assert.rejects(f.role.retryDelivery({ ...input, amount: '1000' }));
  await assert.rejects(f.role.retryDelivery({ tradeId: '1'.repeat(64) }), /No active/);
  f.trade.role = 'buyer'; await assert.rejects(f.role.retryDelivery(input), /No active/);
});

test('delivery retry after the send deadline requests read-only recovery and cannot originate a transfer', async t => {
  const f = fixture(t, true); await f.role.retryDelivery({ tradeId: f.trade.state.tradeId });
  assert.ok(f.actions.some(a => a.type === 'checkSellerTransfer'));
  assert.ok(f.actions.every(a => a.type !== 'sendTransfer'));
  f.trade.state.phase = 'complete'; await assert.rejects(f.role.retryDelivery({ tradeId: f.trade.state.tradeId }), /No active/);
});

test('retry control route authenticates and rejects extra fields before dispatching recovery', async t => {
  const f = fixture(t), server = createServer(controlHandler({ token: 'synthetic', role: f.role }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/retry-delivery`, body = JSON.stringify({ tradeId: f.trade.state.tradeId });
  assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
  const headers = { authorization: 'Bearer synthetic', 'content-type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 200);
  const bad = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ tradeId: f.trade.state.tradeId, sendBy: 999999 }) });
  assert.equal(bad.status, 400); assert.equal(f.actions.filter(a => a.type === 'sendTransfer').length, 1);
});

test('dashboard retry accepts only a full own seller host key', async t => {
  const f = fixture(t);
  await f.role.retryDelivery(f.trade.key);
  assert.equal(f.actions.filter(a => a.type === 'sendTransfer').length, 1);
  await assert.rejects(f.role.retryDelivery('unknown-host-key'), /No active seller/);
});
