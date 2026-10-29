import test from 'node:test';
import assert from 'node:assert/strict';
import { BuyerPauses, buyerPauseText } from '../../../src/market/buyer-pauses.js';
import { STRIKE_WINDOW_SEC as WEEK } from '../../../src/roles/signer-strikes.js';
const buyer = { tracAddr: 'proven-buyer', dexKey: 'ab'.repeat(32) };
function setup() {
  const clock = { now: 100 }, rows = new Map(), store = { get: k => structuredClone(rows.get(k)), put: (k, v) => rows.set(k, structuredClone(v)) };
  const registry = { params: { k: 2 }, removed: [], signers: ['s1', 's2', 's3'].map(dexKey => ({ dexKey, status: 'active' })) };
  const make = () => new BuyerPauses({ store, registry: () => registry, now: () => clock.now });
  const pauses = make();
  const notice = (from, until = 200, ts = clock.now) => ({ from, ts, ch: 'intercom-dex:signers', kind: 'status', body: { message: buyerPauseText({ ...buyer, until }) } });
  return { clock, registry, make, pauses, notice };
}

test('venue hides a buyer only on k current independent signer refusals; DEX-key rotation does not bypass the proven address', () => {
  const f = setup(); f.pauses.receive(f.notice('s1')); f.pauses.receive(f.notice('outsider'));
  assert.equal(f.pauses.refusal(buyer), null);
  f.pauses.receive(f.notice('s2', 210)); assert.deepEqual(f.pauses.refusal({ ...buyer, dexKey: 'cd'.repeat(32) }), { until: 200 });
  assert.deepEqual(f.make().refusal(buyer), { until: 200 });
  f.registry.removed.push({ dexKey: 's1' }); assert.equal(f.pauses.refusal(buyer), null);
  f.registry.removed = []; f.clock.now = 200; assert.equal(f.pauses.refusal(buyer), null);
});

test('operator clear cancels a vote durably, older signed notices cannot undo it, and later genuine refusals can', () => {
  const f = setup(); f.pauses.receive(f.notice('s1')); f.pauses.receive(f.notice('s2'));
  f.clock.now = 110; f.pauses.receive(f.notice('s1', 0));
  assert.equal(f.make().refusal(buyer), null);
  assert.equal(f.pauses.receive(f.notice('s1', 200, 100)), false);
  assert.equal(f.pauses.receive(f.notice('s1', 200, 110)), false);
  f.clock.now = 120; assert.ok(f.pauses.receive(f.notice('s1', 200)));
  assert.ok(f.pauses.refusal(buyer));
});

test('malformed, excessive, foreign-channel and unlisted policy messages cannot pause bids', () => {
  const f = setup();
  for (const m of [{ ...f.notice('s1'), ch: 'intercom-dex' }, f.notice('s1', f.clock.now + WEEK + 1),
    { ...f.notice('s1'), body: { message: 'buyer-pause {"until":200}' } }, { ...f.notice('s1'), body: { message: 'hello' } }]) {
    assert.equal(f.pauses.receive(m), false);
  }
  assert.equal(f.pauses.refusal(buyer), null);
});
