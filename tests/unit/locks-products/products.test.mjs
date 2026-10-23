import test from 'node:test';
import assert from 'node:assert/strict';
import products from '../../../src/locks/products/index.js';
import { majority, describePosition, validatePost, positionId, selectCommittee, errorResult } from '../../../src/locks/position.js';
import { position } from './helpers.mjs';

for (const product of ['loan', 'call']) {
  test(`${product}: one full finalized payment, strict timestamp, and offline decision equality`, () => {
    const p = position(product), step = product === 'loan' ? 'repay' : 'exercise', amount = p.post.terms[product === 'loan' ? 'repay' : 'strikeTotal'];
    const success = { winner: product === 'loan' ? 'maker' : 'taker', outcome: product === 'loan' ? 'repaid' : 'exercised' };
    const failure = { winner: product === 'loan' ? 'taker' : 'maker', outcome: product === 'loan' ? 'defaulted' : 'expired' };
    for (const blockTime of [1999, 2000, 2001]) for (const value of [BigInt(amount) - 1n, BigInt(amount), BigInt(amount) + 1n]) {
      const facts = { counted: 244, T: 2000, payments: [{ step, amount: value.toString(), blockTime, ok: true }] };
      const expected = blockTime < 2000 && value >= BigInt(amount) ? success : failure;
      assert.deepEqual(products[product].decide(p, facts), expected);
      assert.deepEqual(products[product].decide(p, { ...facts, counted: 999 }), expected);
    }
    assert.deepEqual(products[product].decide(p, { counted: 244, T: 2000, payments: [1, 2].map(() => ({ step, amount: (BigInt(amount) / 2n).toString(), blockTime: 1999, ok: true })) }), failure);
    assert.deepEqual(products[product].decide(p, { counted: 244, T: 2000, payments: [{ step, blockTime: 1999, amount, ok: false }] }), failure);
    assert.deepEqual(products[product].decide(p, { counted: 243, M: 1999, payments: [{ step, blockTime: 1999, amount, ok: true }] }), success);
    assert.equal(products[product].decide(p, { counted: 243, payments: [{ step, blockTime: 1999, amount, ok: true }] }).winner, null, 'no irreversible decision against an unknown header');
    assert.equal(products[product].decide(p, { counted: 244, T: 2000, payments: [], scanned: false }).winner, null);
  });
}

for (const asset of ['RESET', 'TNK']) test(`put ${asset}: memo boundary, median release and both lock winners`, () => {
  const p = position('put'); p.post.terms.asset = asset;
  for (const blockTime of [1999, 2000, 2001]) {
    const d = products.put.decide(p, { counted: 244, T: 2000, payments: [{ step: 'exercise', ok: true, blockTime }] });
    assert.deepEqual(d.winners, blockTime < 2000 ? { E: 'taker', H: null } : { E: 'maker', H: 'taker' });
  }
  assert.equal(products.put.decide(p, { counted: 101, M: 1000, payments: [{ step: 'exercise', ok: true, blockTime: 1000 }] }).winner, 'taker');
  assert.equal(products.put.decide(p, { counted: 101, M: 1000, payments: [{ step: 'exercise', ok: true, blockTime: 1001 }] }).winner, null);
  assert.equal(products.put.decide(p, { counted: 244, T: 2000, resetExercise: { ok: true, beforeExpiry: true }, payments: [] }).winner, 'maker');
  assert.equal(products.put.decide(p, { counted: 244, T: 2000, scanned: false }).winner, null);
});

for (const product of ['loan', 'call', 'put']) test(`${product}: never taken, cancel reservation race and no cancel after open`, () => {
  const p = position(product); p.state = 'posted'; p.opened = false; delete p.dueBlock;
  assert.deepEqual(products[product].decide(p, { counted: 100, cancelAccepted: true }), { winner: 'maker', outcome: 'cancelled', ...(product === 'put' ? { winners: { E: 'maker', H: 'taker' } } : {}) });
  assert.equal(products[product].decide(p, { counted: 100, cancelAccepted: true, reservation: { live: true } }).winner, null);
  assert.deepEqual(products[product].decide(p, { counted: 200 }), { winner: 'maker', outcome: 'expired', ...(product === 'put' ? { winners: { E: 'maker', H: 'taker' } } : {}) });
  assert.deepEqual(products[product].decide(p, { counted: 200, funded: false }), { winner: 'maker', outcome: 'unfunded', ...(product === 'put' ? { winners: { E: 'maker', H: 'taker' } } : {}) });
  p.opened = true; p.state = 'running';
  assert.equal(products[product].decide(p, { counted: 100, cancelAccepted: true }).winner, null);
});

test('strict majority: exhaust every cancellation/take partition; duplicates cannot change the quorum', () => {
  const p = position();
  for (let mask = 0; mask < 32; mask++) {
    const votes = p.committee.map((s, i) => ({ from: s.lockKey, value: mask & (1 << i) ? 'cancel' : 'take' }));
    const cancel = votes.filter(v => v.value === 'cancel').length;
    assert.equal(majority(votes, p.committee, 3, v => v.value), cancel >= 3 ? 'cancel' : 'take');
    assert.equal(majority([votes[0], votes[0], votes[0]], p.committee, 3, v => v.value), null);
  }
  assert.throws(() => majority([], p.committee, 2), /registry_unavailable/);
  assert.throws(() => majority([{ from: p.committee[0].lockKey, value: 'cancel' }, { from: p.committee[0].lockKey, value: 'take' }], p.committee, 3, v => v.value), /invalid_message/);
});

test('canonical posts, deterministic draw and registry bounds', () => {
  const p = position();
  assert.equal(positionId(p.post), positionId(JSON.parse(JSON.stringify(p.post))));
  assert.deepEqual(selectCommittee({ ...p.registry, signers: [...p.registry.signers].reverse() }, p.positionId), p.committee);
  assert.throws(() => validatePost({ ...p.post, extra: true }), /invalid_input/);
  for (const patch of [{ collateral: '01' }, { principal: '-1' }, { termBlocks: 5 }, { offerUntilBlock: 99 }]) {
    assert.throws(() => validatePost({ ...p.post, terms: { ...p.post.terms, ...patch } }, p.registry, { counted: 100 }));
  }
  assert.throws(() => validatePost(p.post, p.registry, { makerPositions: 50 }), /limit_exceeded/);
  assert.throws(() => validatePost(p.post, p.registry, { openPositions: 2000 }), /limit_exceeded/);
  assert.throws(() => validatePost(p.post, p.registry, { totalLocked: { RESET: p.registry.limits.totalLocked.RESET } }), /limit_exceeded/);
});

test('plain position sentences use units, counted blocks and product rules', () => {
  const p = position(); p.dueBlock = 920160;
  const view = describePosition(p, { lockKey: p.post.maker.lockKey, counted: 918144 });
  assert.equal(view.now, 'Pay back 103 USDC by block 920,160 (~14 days).');
  assert.equal(view.ifMissed, 'The lender keeps your 1 RESET.');
  assert.equal(describePosition(p, { lockKey: p.taker.lockKey }).now, 'You get 103 USDC by block 920,160, or the 1 RESET. Nothing to do.');
  const call = position('call'); call.post.terms.expiryBlock = 920160;
  assert.equal(describePosition(call, { lockKey: call.taker.lockKey, counted: 919728 }).now, 'You may buy 1 RESET for 300 USDC until block 920,160 (~3 days).');
  const unknown = describePosition(call, { lockKey: call.taker.lockKey });
  assert.equal(unknown.now, 'You may buy 1 RESET for 300 USDC until block 920,160.');
  assert.equal(unknown.blocksLeft, null);
  call.state = 'posted'; call.opened = false;
  call.post.terms.offerUntilBlock = 920160;
  assert.equal(describePosition(call, { lockKey: call.post.maker.lockKey, counted: 919152 }).now, 'Anyone may buy your 1 RESET for 300 USDC until block 920,160 (~7 days) for a 5 USDC fee. Your RESET is locked.');
});

test('size refusals tell people the allowed amount in coins', () => {
  const p = position(), min = String(BigInt(p.post.terms.collateral) + 1n);
  const registry = { ...p.registry, limits: { ...p.registry.limits, RESET: { ...p.registry.limits.RESET, min } } };
  const error = (() => { try { validatePost(p.post, registry); } catch (e) { return e; } })();
  assert.equal(error.reason, 'limit_exceeded');
  assert.match(errorResult(error).whatToDo, /^The collateral is too small\. The smallest allowed is [0-9.]+ RESET\.$/);
  assert.doesNotMatch(errorResult(error).whatToDo, /limit_exceeded|registry|bps/);
});

test('an old preview and an unknown failure are explained, never shown as a form problem', async () => {
  const { createConfirmations } = await import('../../../src/dashboard/actions.js');
  let now = 0; const c = createConfirmations({ clock: () => now }), token = c.issue('locks:post', { a: 1 });
  now = 200000;
  const expired = (() => { try { c.consume('locks:post', { a: 1 }, token); } catch (e) { return e; } })();
  assert.equal(errorResult(expired).reason, 'confirmation_expired');
  assert.match(errorResult(expired).whatToDo, /out of date/);
  const odd = errorResult(new Error('RESET gateway rejected request'));
  assert.deepEqual(odd, { ok: false, reason: 'unexpected', whatToDo: 'Something went wrong: RESET gateway rejected request' });
});
