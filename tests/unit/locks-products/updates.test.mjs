import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, Transaction } from '@solana/web3.js';
import { openingAmounts } from '../../../src/locks/products/fees.js';
import products from '../../../src/locks/products/index.js';
import { createPost, selectCommittee, positionId, describePosition } from '../../../src/locks/position.js';
import { lockCommitments } from '../../../src/wallets/accounting.js';
import { fundingNonce } from '../../../src/locks/trac-lock.js';
import { fixture, position, terms, party, identity } from './helpers.mjs';

const fee = { loanBps: 50, optionBps: 1000, optionMin: '50000' };
for (const asset of ['RESET', 'TNK']) for (const product of ['loan', 'call', 'put']) test(`${product} ${asset}: median boundary and exact fees`, () => {
  const p = position(product); p.post.terms.asset = asset;
  const step = product === 'loan' ? 'repay' : 'exercise', amount = product === 'loan' ? p.post.terms.repay : product === 'call' ? p.post.terms.strikeTotal : '0';
  const payment = { ok: true, step, amount, blockTime: 1234 };
  assert.equal(products[product].decide(p, { counted: 243, M: 1233, payments: [payment] }).winner, null);
  assert.equal(products[product].decide(p, { counted: 243, M: c => c === 243 ? 1234 : null, payments: [payment] }).winner, product === 'loan' ? 'maker' : 'taker');
  assert.equal(products[product].decide(p, { counted: 244, M: 99999, T: 1234, payments: [payment] }).winner, product === 'loan' ? 'taker' : 'maker');
  const amounts = openingAmounts(product, p.post.terms, fee);
  assert.equal(BigInt(amounts.makerReceives) + BigInt(amounts.openingFee), BigInt(amounts.openingTotal));
  assert.equal(amounts.openingFee, product === 'loan' ? '500000' : '500000');
});

test('option minimum, premium cap, floor and maximum integer precision', () => {
  assert.deepEqual(openingAmounts('put', { premium: '10000' }, fee), { opening: '10000', openingTotal: '10000', openingFee: '10000', makerReceives: '0' });
  assert.equal(openingAmounts('call', { premium: '100001' }, fee).openingFee, '50000');
  assert.equal(openingAmounts('loan', { principal: '199' }, fee).openingFee, '0');
  const p = '18446744073709551615';
  assert.equal(openingAmounts('loan', { principal: p }, fee).openingFee, (BigInt(p) * 50n / 10000n).toString());
});

test('put settlement sentences describe the distinct funds collected by each party', () => {
  const p = position('put'); p.state = 'ended:exercised'; p.outcome = 'exercised'; p.winner = 'taker'; p.holderDecision = { winner: 'maker', outcome: 'exercised' };
  assert.match(describePosition(p, { lockKey: p.post.maker.lockKey }).now, /Collecting your 1 RESET/);
  assert.match(describePosition(p, { lockKey: p.taker.lockKey }).now, /Collecting your 300 USDC/);
  p.state = 'released'; p.outcome = 'expired'; p.winner = 'maker'; p.holderDecision = { winner: 'taker', outcome: 'expired' };
  assert.match(describePosition(p, { lockKey: p.post.maker.lockKey }).now, /collected 300 USDC/);
  assert.match(describePosition(p, { lockKey: p.taker.lockKey }).now, /collected 1 RESET/);
});

for (const asset of ['RESET', 'TNK']) test(`put ${asset}: holder lock finality before premium, exercise is memo only`, async () => {
  const f = fixture(), maker = identity(), p = position('put', party(maker), f.reg);
  p.post.terms.asset = asset; p.positionId = positionId(p.post); p.state = 'posted'; p.opened = false; delete p.taker;
  p.votes.posted = p.committee.slice(0, 3).map(s => ({ from: s.lockKey, body: { positionId: p.positionId } }));
  f.options.adapters.holderProtocol = true;
  f.put(p, maker); await f.client.take(p.positionId); const active = f.client.positions.get(p.positionId);
  for (let i = 0; i < 3; i++) await f.receive(active, 'reserve', i, { takeId: active.takeId, takerKey: f.me.lockKey, expiresAt: 1600 });
  assert.equal(f.calls.length, 0);
  const lock = { A: f.A, C: [f.A, f.A, f.A], address: f.options.adapters.tracLock.address(f.A), chain: 'trac' };
  for (let i = 0; i < 3; i++) await f.receive(active, 'lockReady', i, { takeId: active.takeId, j: i + 1, ...lock });
  assert.equal(f.calls.length, 0, 'three shares can release but readiness still needs four members');
  await f.receive(active, 'lockReady', 3, { takeId: active.takeId, j: 4, ...lock });
  assert.deepEqual(f.calls.filter(c => c.asset).map(c => c.asset), asset === 'TNK' ? ['TNK'] : ['RESET', 'TNK']);
  assert.equal(f.calls[0].nonce, fundingNonce(active.positionId, asset, active.takeId));
  if (asset === 'TNK') assert.equal(f.calls[0].amount, (BigInt(p.post.terms.amount) + BigInt(f.reg.params.tnkReserve)).toString());
  assert.equal(f.calls.at(-1).transaction.amount, '4975000');
  assert.equal(f.sent.filter(s => s[1] === 'funded').at(-1)[2].takeId, active.takeId);
  for (let i = 0; i < 3; i++) await f.receive(active, 'opened', i, { takeId: active.takeId, taker: f.me, holderLock: lock });
  assert.equal(active.state, 'running');
  const count = f.calls.length; await f.client.pay(active.positionId, 'exercise');
  assert.equal(f.calls.length, count + 1);
  const tx = f.calls.at(-1).transaction;
  assert.ok(tx instanceof Transaction); assert.equal(tx.instructions.length, 1);
  assert.equal(tx.instructions[0].keys[0].pubkey.toBase58(), f.me.sol);
  assert.equal(tx.instructions[0].keys[0].isSigner, true);
  assert.equal(tx.instructions[0].data.toString(), `intercom-locks:v1:${active.positionId}:exercise`);
});

test('put writer public preimage is persisted before funding, escrow cost reserves platform fee', async () => {
  const f = fixture(); f.options.adapters.holderProtocol = true;
  f.options.adapters.escrowCosts = async () => ({ total: '300300000' });
  f.options.adapters.fundEscrow = async ({ position: p }) => {
    assert.equal(f.store.get(`locks-position-${p.positionId}`).post.escrowPreimage, p.post.escrowPreimage);
    return { ok: true, finalized: true, signature: 'escrow', refundAfter: 900000, escrow: { refundAfter: 900000 } };
  };
  const view = await f.client.post({ product: 'put', terms: { ...terms('put'), asset: 'RESET' } }), p = f.client.positions.get(view.positionId);
  assert.match(p.post.escrowPreimage, /^[0-9a-f]{64}$/); assert.equal(lockCommitments([p], f.me.lockKey).USDC.pending, '300300000');
  const address = new PublicKey(Buffer.from(f.A, 'hex')).toBase58();
  for (let i = 0; i < 4; i++) await f.receive(p, 'lockReady', i, { j: i + 1, A: f.A, C: [f.A, f.A, f.A], address, chain: 'solana' });
  assert.equal(p.refundAfter, 900000); assert.equal(p.funded, true);
  assert.deepEqual(f.sent.at(-1).slice(1), ['funded', { positionId: p.positionId, escrow: { refundAfter: 900000 } }]);
  assert.equal(lockCommitments([p], f.me.lockKey).USDC.locked, '300000000');
});

test('TNK asset limits and larger-pool draws require verified randomness and operator minimum', () => {
  const f = fixture(); f.reg.assets = { RESET: 'open', TNK: 'open' };
  f.reg.signers.forEach(s => { s.group = 'operator'; });
  f.reg.limits.TNK = { min: '1', max: '2000000000000000000000' };
  f.reg.limits.totalLocked.TNK = '4000000000000000000000';
  const post = createPost({ product: 'loan', maker: f.me, registryVersion: 1, terms: { ...terms('loan'), asset: 'TNK', collateral: '2000000000000000000000' } }, f.reg, { counted: 100 });
  assert.equal(post.terms.asset, 'TNK');
  f.reg.signers.push({ ...f.reg.signers[0], lockKey: identity().publicKey, boxKey: identity().publicKey, group: 'external' });
  const id = positionId(post); assert.throws(() => selectCommittee(f.reg, id), /protocol_unavailable/);
  const drawn = selectCommittee(f.reg, id, 'ab'.repeat(32));
  assert.ok(drawn.filter(s => s.group === 'operator').length >= 3);
  assert.deepEqual(drawn, selectCommittee({ ...f.reg, signers: f.reg.signers.toReversed() }, id, 'ab'.repeat(32)));
});

test('take checks the full premium and live asset pause before reserving holder funds', async () => {
  const f = fixture(), maker = identity(), p = position('put', party(maker), f.reg);
  p.state = 'posted'; p.opened = false; delete p.taker;
  f.put(p, maker); f.options.adapters.holderProtocol = true;
  f.options.adapters.freeBalance = async asset => asset === 'USDC' ? '4999999' : '99999999999999999999';
  await assert.rejects(f.client.take(p.positionId), /insufficient_funds/);
  assert.equal(f.sent.length, 0); assert.equal(p.state, 'posted'); assert.equal(p.takeId, undefined);
  f.reg.assets = { RESET: 'paused', TNK: 'open' };
  await assert.rejects(f.client.take(p.positionId), /product_paused/);
  assert.equal(f.calls.length, 0);
});

test('a saved intent with no signed chain transaction can resume after a transient build failure', async () => {
  const f = fixture(), p = f.put(position('loan', f.me, f.reg)); let attempts = 0;
  f.options.adapters.hasIntent = () => false;
  f.options.adapters.submit = async () => { if (++attempts === 1) throw Error('temporary blockhash read failure'); return { ok: true, finalized: true, signature: 'same-intent' }; };
  await assert.rejects(f.client.pay(p.positionId, 'repay'), /payment_pending/);
  const id = p.operations.repay.id;
  await f.client.pay(p.positionId, 'repay');
  assert.equal(p.operations.repay.id, id); assert.equal(p.operations.repay.status, 'confirmed'); assert.equal(attempts, 2);
});

test('expired put reservation collects holder funds before admitting a new take', async () => {
  const f = fixture(), maker = identity(), p = position('put', party(maker), f.reg);
  p.taker = f.me; p.state = 'taking'; p.opened = false; p.takeId = 'aa'.repeat(32); p.takingAt = 100;
  p.holderLock = { A: f.A, C: [f.A, f.A, f.A], address: f.options.adapters.tracLock.address(f.A), chain: 'trac' };
  p.holderFunded = true; const takeId = p.takeId; f.put(p, maker);
  await f.client.onClock();
  assert.equal(p.state, 'taking'); assert.equal(p.takeId, takeId); assert.equal(p.reason, 'reservation_expired');
  for (let i = 0; i < 3; i++) await f.receive(p, 'release', i, { takeId, A: f.A, C: p.holderLock.C, winner: 'taker', outcome: 'unfunded', sealed: {} });
  assert.equal(p.state, 'posted'); assert.equal(p.takeId, undefined); assert.equal(p.holderLock, undefined);
  assert.equal(p.failedTakes[0].takeId, takeId); assert.equal(f.calls.length, 1);
  await f.client.stop();
});
