import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { generateBox, encodeKey } from '../../../src/core/keys.js';
import { le32 } from '../../../src/core/canonical.js';
import { fixture, identity, party, position } from './helpers.mjs';
import { selectCommittee, describePosition } from '../../../src/locks/position.js';
import * as vss from '../../../src/locks/crypto/edvss.js';
import * as dkg from '../../../src/locks/dkg.js';
import * as wire from '../../../src/locks/transport.js';
import { address } from '../../../src/locks/trac-lock.js';
import { lockChannel, LOCKS_CHANNEL } from '../../../src/locks/client.js';
import products from '../../../src/locks/products/index.js';

function put(side = 'taker') {
  const f = fixture(), maker = side === 'maker' ? f.key : identity(), box = generateBox(), signers = Array.from({ length: 5 }, identity);
  f.me.boxKey = encodeKey(box.publicKey); f.client.me.boxKey = f.me.boxKey; f.client.box = { secretKey: box.secretKey };
  f.reg.signers = signers.map(s => ({ lockKey: s.publicKey, boxKey: identity().publicKey, software: '0.2.0', status: 'active' }));
  const p = position('put', side === 'maker' ? f.me : party(maker), f.reg); if (side === 'taker') p.taker = f.me;
  p.takeId = 'ab'.repeat(32); p.committee = selectCommittee(f.reg, p.positionId);
  const splits = [7n, 11n].map(a => vss.split(a, 3, [1, 2, 3, 4, 5]));
  p.lock = { A: vss.publicOf(7n), C: splits[0].commitments, chain: 'solana', address: new PublicKey(Buffer.from(vss.publicOf(7n), 'hex')).toBase58() };
  p.holderLock = { A: vss.publicOf(11n), C: splits[1].commitments, chain: 'trac', address: address(vss.publicOf(11n)) }; f.put(p, maker);
  f.client.adapters.edvss = vss; delete f.client.adapters.openRelease;
  f.client.adapters.escrowLock = { claimAndSweep: input => input }; f.client.adapters.escrowBalance = async () => '0';
  f.client.transport.open = (_ch, raw) => wire.open(raw, { now: f.time.now, maxAgeSec: Number.MAX_SAFE_INTEGER });
  const release = async (holder, winner, j) => {
    const lock = holder ? p.holderLock : p.lock, to = winner === 'maker' ? p.post.maker : p.taker;
    const context = { positionId: p.positionId, ...(holder ? { takeId: p.takeId } : {}), from: j, to: to.lockKey };
    const body = { positionId: p.positionId, ...(holder ? { takeId: p.takeId } : {}), j, winner, outcome: 'exercised', A: lock.A, C: lock.C,
      sealed: dkg.sealShare(le32(splits[holder ? 1 : 0].shares[j - 1].share), to.boxKey, context, 'release') };
    return f.client.receive(lockChannel(p.positionId), wire.seal({ ch: lockChannel(p.positionId), kind: 'release', body }, signers.find(s => s.publicKey === p.committee[j - 1].lockKey).secretKey, { ts: f.time.now }));
  };
  const receipts = () => f.sent.filter(s => s[1] === 'releaseReceipt').map(s => s[2]);
  return { ...f, p, release, receipts };
}

test('put keeps collecting after E; final claim alone exposes only E receipt keys', async () => {
  const f = put(); let finalized = false;
  f.client.adapters.hasIntent = () => true;
  f.client.adapters.submit = async () => ({ ok: false });
  f.client.adapters.reconcile = async () => ({ ok: finalized, finalized });
  await f.release(false, 'taker', 1); await f.release(false, 'taker', 2);
  await assert.rejects(f.release(false, 'taker', 3), /payment_pending/);
  assert.equal(f.receipts().length, 0);
  finalized = true; await f.client.onClock();
  assert.equal(f.p.state, 'ended:exercised'); assert.equal(f.receipts().length, 3);
  assert.ok(f.receipts().every(r => !r.takeId));
  f.time.now += 8 * 86400;
  for (let j = 1; j <= 3; j++) await f.release(true, 'maker', j);
  assert.equal(f.p.state, 'released'); assert.equal(f.p.holderDecision.winner, 'maker');
  assert.equal(f.p.collectedAt, f.time.now, 'late writer collection restarts the holder E receipt window');
  await f.client.stop();
});

test('refunded put returns H to its holder and releases E receipts only after verified refund', async () => {
  const f = put(); let sweepFinal = false;
  f.client.adapters.escrowSettlement = async () => ({ ok: true, status: 'refunded' });
  f.client.adapters.submit = async () => { throw Error('Refunded escrow must not be claimed'); };
  f.client.adapters.tracLock = { address, sweep: async () => ({ ok: sweepFinal }) };
  for (let j = 1; j <= 3; j++) await f.release(false, 'taker', j);
  assert.equal(f.p.escrowStatus, 'refunded'); assert.equal(f.p.state, 'ended:exercised');
  f.time.now += 8 * 86400;
  await f.release(true, 'taker', 1); await f.release(true, 'taker', 2);
  await assert.rejects(f.release(true, 'taker', 3), /payment_pending/);
  assert.ok(f.receipts().every(r => !r.takeId));
  sweepFinal = true; await f.client.onClock();
  assert.equal(f.p.state, 'released'); assert.equal(f.p.holderDecision.winner, 'taker');
  assert.equal(f.receipts().filter(r => r.takeId).length, 3);
  assert.equal(f.p.collectedAt, f.time.now, 'delayed H starts a fresh receipt delivery window');
  assert.match(describePosition(f.p, { lockKey: f.me.lockKey }).now, /collected 1 RESET/);
  await f.client.stop();
});

test('writer follows an H refund winner instead of inferring ownership from exercise', async () => {
  const f = put('maker');
  for (let j = 1; j <= 3; j++) await f.release(false, 'taker', j);
  assert.equal(f.p.state, 'ended:exercised');
  for (let j = 1; j <= 3; j++) await f.release(true, 'taker', j);
  assert.equal(f.p.state, 'released'); assert.equal(f.calls.length, 0); assert.equal(f.receipts().length, 0);
  assert.match(describePosition(f.p, { lockKey: f.me.lockKey }).now, /refunded your 300 USDC/);
});

for (const blocked of ['clock read', 'request send']) test(`put writer collects H when the old pickup expires during a retry ${blocked}`, async t => {
  const f = put('maker'); t.after(() => f.client.stop()); t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let j = 1; j <= 3; j++) await f.release(false, 'taker', j);
  assert.equal(f.p.state, 'ended:exercised');
  await f.client.requestRelease(f.p.positionId);
  t.mock.timers.tick(59000); f.time.now += 60;
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  if (blocked === 'clock read') {
    const read = f.client.clock.read;
    f.client.clock.read = async () => { entered.resolve(); await resume.promise; return read(); };
  } else {
    const send = f.client.transport.send;
    f.client.transport.send = async (...args) => {
      if (args[1] === 'releaseRequest') { entered.resolve(); await resume.promise; }
      return send(...args);
    };
  }
  const retry = f.client.onClock(); await entered.promise;
  t.mock.timers.tick(1000); resume.resolve(); await retry; await f.client.queue;
  assert.equal(f.sent.filter(([, kind]) => kind === 'releaseRequest').length, 2);
  // A peer delivers the later holder releases only while the writer is joined.
  if (f.client.joined.has(lockChannel(f.p.positionId))) for (let j = 1; j <= 5; j++) await f.release(true, 'maker', j);
  assert.equal(f.p.state, 'released', 'an expired pickup must not leave the renewed pickup channel');
  assert.equal(f.p.holderReleases.length, 5);
  assert.equal(f.p.operations[`sweep:H:${f.p.takeId}`].status, 'confirmed');
  assert.equal(f.receipts().length, 5);
});

test('put product leaves H pending until verified terminal escrow evidence is supplied', () => {
  const p = position('put'), facts = { counted: 200, M: 1500, payments: [{ ok: true, step: 'exercise', amount: '0', blockTime: 1400 }] };
  assert.deepEqual(products.put.decide(p, facts).winners, { E: 'taker', H: null });
  assert.deepEqual(products.put.decide(p, { ...facts, escrowStatus: 'claimed' }).winners, { E: 'taker', H: 'maker' });
  assert.deepEqual(products.put.decide(p, { ...facts, escrowStatus: 'refunded' }).winners, { E: 'taker', H: 'taker' });
});

test('a claim pending when the writer refunds reconciles terminal escrow before disclosing E', async () => {
  const f = put(); let refunded = false;
  f.client.adapters.hasIntent = () => true;
  f.client.adapters.submit = async () => ({ ok: false });
  f.client.adapters.reconcile = async () => ({ ok: false });
  f.client.adapters.escrowSettlement = async () => ({ ok: true, status: refunded ? 'refunded' : 'active' });
  await f.release(false, 'taker', 1); await f.release(false, 'taker', 2);
  await assert.rejects(f.release(false, 'taker', 3), /payment_pending/);
  assert.equal(f.receipts().length, 0);
  refunded = true; await f.client.onClock();
  assert.equal(f.p.operations.sweep.receipt.refunded, true); assert.equal(f.receipts().length, 3);
  await f.client.stop();
});

test('pickup stays joined through replayed opened votes and finalized release receipts', async () => {
  const f = fixture(), p = f.put(position('loan', f.me, f.reg));
  p.takeId = 'aa'.repeat(32); p.lock = { A: f.A, C: [f.A, f.A, f.A], chain: 'trac' };
  await f.client.requestRelease(p.positionId);
  for (let j = 0; j < 5; j++) await f.receive(p, 'opened', j, { takeId: p.takeId, taker: p.taker, takeAnchor: p.takeAnchor, dueBlock: p.dueBlock });
  assert.equal(f.leaves.length, 0, 'opened replay cannot discard following releases');
  for (let j = 0; j < 5; j++) await f.receive(p, 'release', j, { winner: 'maker', outcome: 'repaid', sealed: {} });
  assert.equal(p.state, 'released'); assert.equal(p.releases.length, 5); assert.equal(f.leaves.length, 0);
  await f.client.stop();
});

test('venue return replays only finalized receipt keys, with a bounded delivery window', async () => {
  const f = fixture(), p = f.put(position('put', f.me, f.reg));
  p.state = 'ended:exercised'; p.collectedAt = f.time.now; p.takeId = 'ab'.repeat(32);
  p.operations.sweep = { status: 'confirmed' }; p.operations[`sweep:H:${p.takeId}`] = { status: 'pending' };
  p.receipts = { E: { positionId: p.positionId, j: 1 }, H: { positionId: p.positionId, takeId: p.takeId, j: 1 } };
  f.client.registry.offer = () => true;
  const registry = { auth: true, ch: LOCKS_CHANNEL, from: f.client.venueKey, kind: 'registry', body: {} };
  await f.client.receive(LOCKS_CHANNEL, registry);
  const receipts = () => f.sent.filter(s => s[1] === 'releaseReceipt');
  assert.equal(receipts().length, 1); assert.equal(receipts()[0][2].takeId, undefined);
  await f.client.receive(LOCKS_CHANNEL, registry); assert.equal(receipts().length, 1);
  f.time.now += 61; await f.client.receive(LOCKS_CHANNEL, registry); assert.equal(receipts().length, 2);
  f.time.now += 7 * 86400; await f.client.receive(LOCKS_CHANNEL, registry); assert.equal(receipts().length, 2);
  await f.client.stop();
});

test('late valid shares send only their new receipt instead of repeating the whole quorum', async () => {
  const f = put();
  for (let j = 1; j <= 5; j++) await f.release(false, 'taker', j);
  assert.equal(f.receipts().length, 5); assert.equal(new Set(f.receipts().map(r => r.j)).size, 5);
  await f.client.onClock(); assert.equal(f.receipts().length, 5);
  await f.client.stop();
});

test('put writer refund waits for finality and cannot be requested by the holder', async () => {
  const f = fixture(), p = f.put(position('put', f.me, f.reg));
  p.funded = true; p.refundAfter = 2000; let final = false;
  f.client.adapters.hasIntent = () => true;
  f.client.adapters.refundEscrow = async () => ({ ok: false });
  f.client.adapters.reconcile = async () => ({ ok: final, finalized: final });
  await assert.rejects(f.client.refund(p.positionId), /payment_pending/);
  assert.equal(p.escrowStatus, undefined);
  final = true; await f.client.refund(p.positionId); assert.equal(p.escrowStatus, 'refunded');
  const holder = put(); holder.p.funded = true; holder.p.refundAfter = 2000;
  await assert.rejects(holder.client.refund(holder.p.positionId), /not_your_position/);
  await f.client.stop(); await holder.client.stop();
});
