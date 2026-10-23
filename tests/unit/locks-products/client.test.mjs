import test from 'node:test';
import assert from 'node:assert/strict';
import { LocksClient, lockChannel, DEFAULT_SETTINGS, inTheMoney, signPost } from '../../../src/locks/client.js';
import { accountBalances, accountLockBalances, lockCommitments } from '../../../src/wallets/accounting.js';
import { fixture, identity, party, position, terms } from './helpers.mjs';

async function posted(f) {
  const row = await f.client.post({ product: 'loan', terms: terms('loan') }), p = f.client.positions.get(row.positionId);
  for (let i = 0; i < 5; i++) await f.receive(p, 'lockReady', i, { j: i + 1, A: f.A, C: [f.A, f.A, f.A], address: f.options.adapters.tracLock.address(f.A), chain: 'trac' });
  for (let i = 0; i < 3; i++) await f.receive(p, 'posted', i);
  return p;
}
function taking(f) {
  const maker = identity(), p = position('loan', party(maker), f.reg);
  p.opened = false; p.state = 'posted'; delete p.dueBlock; delete p.taker;
  p.votes.posted = p.committee.slice(0, 3).map(s => ({ from: s.lockKey, body: { positionId: p.positionId } }));
  f.put(p, maker); return p;
}

test('creation requires n−1 matching ready attestations; funds once, then k posted', async () => {
  const f = fixture(), p = await posted(f);
  assert.equal(p.state, 'posted'); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(c => c.asset), ['RESET', 'TNK']);
  assert.equal(f.sent.filter(s => s[1] === 'funded').length, 1);
  assert.ok(f.leaves.includes(lockChannel(p.positionId)));
  const view = f.client.status()[0];
  for (const name of ['operations', 'releases', 'secretKey', 'share', 'sig']) assert.ok(!Object.hasOwn(view, name));
  const restored = new LocksClient(f.options); await restored.start();
  assert.deepEqual(f.joins.slice(-1), ['intercom-locks'], 'restart does not join all position channels');
  assert.equal(restored.status()[0].state, 'posted');
});

test('unsupported put adapters fail before lock request or any funding', async () => {
  const f = fixture();
  await assert.rejects(f.client.post({ product: 'put', terms: terms('put') }), /protocol_unavailable|adapter_unavailable/);
  assert.equal(f.sent.length, 0); assert.equal(f.calls.length, 0);
});

test('differing lock addresses and duplicate votes never unlock funding', async () => {
  const f = fixture(), row = await f.client.post({ product: 'call', terms: terms('call') }), p = f.client.positions.get(row.positionId);
  await assert.rejects(f.receive(p, 'lockReady', 0, { j: 1, A: f.A, C: [f.A, f.A, f.A], address: 'bad', chain: 'trac' }), /lock_mismatch/);
  for (let i = 0; i < 5; i++) await f.receive(p, 'lockReady', 0, { j: 1, A: f.A, C: [f.A, f.A, f.A], address: f.options.adapters.tracLock.address(f.A), chain: 'trac' });
  assert.equal(f.calls.length, 0); assert.equal(p.state, 'creating');
  f.time.now += 151; await f.client.onClock(); assert.equal(p.state, 'ended:unfunded');
});

test('reservation quorum and pay margin are checked before building and again after building', async () => {
  const f = fixture(), old = taking(f); await f.client.take(old.positionId); const p = f.client.positions.get(old.positionId);
  const reserve = (i, expiresAt) => f.receive(p, 'reserve', i, { takeId: p.takeId, takerKey: f.me.lockKey, expiresAt });
  await reserve(0, 1120); await reserve(1, 1120); assert.equal(f.calls.length, 0);
  f.options.adapters.solanaPay.build = async input => { f.time.now++; return input; };
  await assert.rejects(reserve(2, 1120), /payment_pending/);
  assert.equal(f.calls.length, 0, 'no submission after build consumed the margin');
  await assert.rejects(f.client.take(p.positionId), /payment_pending/);
  assert.equal(f.calls.length, 0, 'ambiguous journal entry must reconcile rather than send again');
});

test('k timely reservations make exactly one opening payment with fee, repeated messages do not duplicate it', async () => {
  const f = fixture(), old = taking(f); await f.client.take(old.positionId); const p = f.client.positions.get(old.positionId);
  for (const i of [0, 1, 2, 2, 3]) await f.receive(p, 'reserve', i, { takeId: p.takeId, takerKey: f.me.lockKey, expiresAt: 1600 });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].transaction.amount, '99500000'); assert.equal(f.calls[0].transaction.fee, '500000');
  assert.match(f.calls[0].transaction.memo, /:open:/);
  assert.equal(p.state, 'taking');
  for (let i = 0; i < 3; i++) await f.receive(p, 'opened', i, { takeId: p.takeId, taker: f.me, takeAnchor: 100, dueBlock: 244 });
  assert.equal(p.state, 'running'); assert.equal(p.dueBlock, 244);
  await assert.rejects(f.client.take(p.positionId), /already_taken/);
});

test('missing finality is pending across restart and cannot pay a second time', async () => {
  const f = fixture(), p = f.put(position('loan', f.me, f.reg));
  f.options.adapters.submit = async input => { f.calls.push(input); return { ok: true, finalized: false, signature: 'pending' }; };
  await assert.rejects(f.client.pay(p.positionId, 'repay'), /payment_pending/);
  const restarted = new LocksClient(f.options);
  await assert.rejects(restarted.pay(p.positionId, 'repay'), /payment_pending/);
  assert.equal(f.calls.length, 1);
  f.options.adapters.reconcile = async () => ({ ok: true, finalized: true, signature: 'pending' });
  await restarted.pay(p.positionId, 'repay'); assert.equal(f.calls.length, 1);
});

test('automatic repayment waits until six blocks, honors balance and settings, never pays at deadline', async () => {
  const f = fixture(), p = f.put(position('loan', f.me, f.reg));
  assert.deepEqual(f.client.getSettings(), DEFAULT_SETTINGS);
  f.time.counted = 237; await f.client.onClock(); assert.equal(f.calls.length, 0);
  f.time.counted = 238; f.options.adapters.freeBalance = async () => '0'; await f.client.onClock(); assert.equal(f.calls.length, 0);
  assert.equal(f.client.status()[0].reason, 'insufficient_funds');
  f.options.adapters.freeBalance = async () => '999999999'; await f.client.onClock(); assert.equal(f.calls.length, 1);
  await f.client.onClock(); assert.equal(f.calls.length, 1);
  assert.throws(() => f.client.setSettings({ autoSweep: false }), /settings_invalid/);
  const g = fixture(), q = g.put(position('loan', g.me, g.reg)); g.time.counted = 244;
  await assert.rejects(g.client.pay(q.positionId, 'repay'), /deadline_passed/);
});

test('call/put automatic exercise uses last price with exact integer margin', async () => {
  const f = fixture(), maker = identity(), p = position('call', party(maker), f.reg); p.taker = f.me; f.put(p, maker);
  assert.equal(inTheMoney(p, '300', 100), false); assert.equal(inTheMoney(p, '303', 100), false); assert.equal(inTheMoney(p, '304', 100), true);
  const put = position('put'); assert.equal(inTheMoney(put, '297', 100), true); assert.equal(inTheMoney(put, '298', 100), false);
  f.time.counted = 238; await f.client.onClock(); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].transaction.amount, '300000000'); assert.equal(f.calls[0].transaction.fee, '0');
});

test('release shares need distinct authorized majority and matching public key before sweep', async () => {
  const f = fixture(), p = f.put(position('loan', f.me, f.reg)); p.lock = { A: f.A, C: [f.A, f.A, f.A], chain: 'trac' };
  for (const i of [0, 0, 1]) await f.receive(p, 'release', i, { j: i + 1, winner: 'maker', outcome: 'repaid', sealed: {} });
  assert.equal(f.calls.length, 0);
  await f.receive(p, 'release', 2, { j: 3, winner: 'maker', outcome: 'repaid', sealed: {} });
  assert.equal(f.calls.length, 1); assert.equal(p.state, 'released');
  assert.ok(!JSON.stringify(f.client.status()).includes('sealed'));
});

test('accounting separates pending wallet funding and externally locked balances', () => {
  const f = fixture(), p = position('loan', f.me, f.reg); p.state = 'funding';
  assert.equal(lockCommitments([p], f.me.lockKey).RESET.pending, '100000000');
  p.operations['fund:RESET'] = { status: 'confirmed' }; p.operations['fund:TNK'] = { status: 'confirmed' };
  const balances = accountBalances({ balances: { RESET: '500000000', USDC: '500000000' }, registry: () => f.reg });
  const withLocks = accountLockBalances(balances, [p], f.me.lockKey);
  assert.equal(withLocks.RESET.balance, '600000000'); assert.equal(withLocks.RESET.free, balances.RESET.free);
  assert.equal(withLocks.RESET.breakdown.locked, '100000000'); assert.equal(balances.RESET.breakdown.locked, undefined);
  p.state = 'released'; assert.equal(lockCommitments([p], f.me.lockKey).RESET.locked, '0');
});

test('venue book authenticates original posted envelopes and matching commitments', async () => {
  const f = fixture(), maker = identity(), p = position('call', party(maker), f.reg);
  const lock = { A: f.A, C: [f.A, f.A, f.A], chain: 'trac', address: f.options.adapters.tracLock.address(f.A) };
  const row = { positionId: p.positionId, post: p.post, lock,
    attestations: [0, 1, 2].map(i => ({ auth: true, from: p.committee[i].lockKey, kind: 'posted', ch: 'intercom-locks',
      body: { positionId: p.positionId, post: p.post, registryVersion: f.reg.version, j: i + 1, ...lock } })) };
  const book = positions => f.client.receive('intercom-locks', { auth: true, ch: 'intercom-locks', kind: 'book', from: f.options.venueKey,
    body: { positions, page: 0, pageSize: 50, total: positions.length, requester: f.me.lockKey } });
  const forged = structuredClone(row); forged.attestations[0].body.post.maker.sol = f.me.sol;
  await assert.rejects(book([forged]), /invalid_message/);
  await assert.rejects(book([{ ...row, attestations: [row.attestations[0], row.attestations[0], row.attestations[0]] }]), /lock_mismatch/);
  await book([row]); assert.equal(f.client.list().total, 1);
  await f.client.take(p.positionId);
  assert.equal(f.client.positions.get(p.positionId).lock.A, f.A);
  assert.equal(new LocksClient(f.options).positions.get(p.positionId).postProofs.length, 3);
});

test('settings and event cursors survive restart, and release requests are paced', async () => {
  const f = fixture(), p = f.put(position('loan', f.me, f.reg));
  f.client.setSettings({ autoRepay: false, exerciseMarginBps: 300 });
  assert.equal(await f.client.requestRelease(p.positionId), true);
  assert.equal(await f.client.requestRelease(p.positionId), false);
  f.time.now += 60; assert.equal(await f.client.requestRelease(p.positionId), true);
  const cursor = f.client.readEvents().next;
  const restarted = new LocksClient(f.options);
  assert.equal(restarted.getSettings().autoRepay, false); assert.equal(restarted.getSettings().exerciseMarginBps, 300);
  assert.equal(restarted.readEvents(cursor).events.length, 0);
});

test('an unanswered take lapses on an event or a later user request without a payment', async () => {
  const f = fixture(), p = taking(f); await f.client.take(p.positionId);
  const first = f.client.positions.get(p.positionId).takeId;
  f.time.now += 601;
  await f.client.take(p.positionId);
  assert.notEqual(f.client.positions.get(p.positionId).takeId, first);
  f.time.now += 601; await f.client.onClock();
  assert.equal(f.client.positions.get(p.positionId).state, 'posted'); assert.equal(f.calls.length, 0);
});
