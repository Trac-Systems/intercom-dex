import test from 'node:test';
import assert from 'node:assert/strict';
import { stack } from '../../integration/locks/harness.mjs';
import { rateLimited } from '../../../src/roles/lock-signer.js';

async function running(t) {
  const scans = [], s = await stack({ paymentAdapter: null }); t.after(s.stop);
  const id = await s.post(), takeId = await s.take(id); await s.pay(id, 'open:' + takeId);
  for (const signer of s.signers) {
    const inner = signer.payments;
    signer.payments = { ...inner, scan: async args => { scans.push({ signer: signer.identity.publicKey, ...args }); return { ...(await inner.scan(args)), newest: 'sig-' + scans.length }; } };
    signer.clock = { ...signer.clock, M: async () => 1500 };
  }
  return { s, id, scans, signer: s.signers[0], mine: () => scans.filter(x => x.signer === s.signers[0].identity.publicKey) };
}

test('an unpaid running loan is swept once, then only after the sweep interval, continuing from the newest transaction', async t => {
  const { s, signer, mine } = await running(t);
  let writes = 0; const put = signer.store.put.bind(signer.store); signer.store.put = (k, v) => { writes++; return put(k, v); };
  await signer.reconcile();
  assert.equal(mine().length, 1); assert.equal(mine()[0].until, undefined);
  writes = 0; await signer.reconcile(); await signer.reconcile();
  assert.equal(mine().length, 1, 'no new sweep within the interval');
  assert.equal(writes, 0, 'an unchanged position is not written again');
  s.time.now += 1800 + 600;
  await signer.reconcile();
  assert.equal(mine().length, 2);
  assert.match(mine()[1].until, /^sig-\d+$/, 'the next sweep continues from the newest checked transaction');
});

test('a recorded payment only waits for the median time; the deadline still reads the whole history when nothing counts', async t => {
  const { s, id, signer, mine } = await running(t);
  await s.pay(id, 'repay', { blockTime: 1600 });
  const before = mine().length;
  await signer.reconcile(); await signer.reconcile();
  assert.equal(mine().length, before, 'no scan while a recorded payment waits for Bitcoin\'s median time');
  const other = await running(t);
  other.s.chain.counted = 200; // past the deadline, nothing paid
  await other.signer.reconcile();
  assert.ok(other.mine().some(x => x.beforeTime === other.s.chain.T), 'the decisive scan runs at the deadline');
});

test('rate-limited lanes: calls are spaced, and an urgent lane never waits behind a full background lane', async () => {
  const times = [], call = async name => { times.push([name, performance.now()]); };
  const background = rateLimited(call, 20), urgent = rateLimited(call, 20), t0 = performance.now();
  const queued = Array.from({ length: 10 }, () => background('bg'));
  await urgent('now');
  assert.ok(times.find(([n]) => n === 'now')[1] - t0 < 40, 'urgent call went first');
  await Promise.all(queued);
  const bg = times.filter(([n]) => n === 'bg').map(([, at]) => at);
  assert.ok(bg.at(-1) - bg[0] >= 9 * 50 - 15, 'background calls spaced at 20 per second');
});
