import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RewardLedger, rewardWeights, verifyRewardSummary } from '../../../src/stake/rewards.js';
import { PayoutService } from '../../../src/roles/payout.js';
import { signFact } from '../../../src/stake/certificates.js';
import { defaultSettings } from '../../../src/stake/settings.js';
import { registryPolicy, memoryStore, secrets } from './helpers.mjs';
import { tracAddress } from '../core/helpers.mjs';
import { bytesToHex } from '../../../src/core/canonical.js';
import { ed25519 } from '@noble/curves/ed25519.js';
const cap400 = () => { const s = defaultSettings(); s.stake.maxUsdPerAddress = '400000000'; return s; }; // the first mainnet cap, which these cases measure
const h = n => n.toString(16).padStart(64, '0'), owner = tracAddress(h(1)), buyer = tracAddress(h(2));
const context = { networkId: 1, venueKey: h(3), epoch: registryPolicy().epoch }, identity = { secretKey: new Uint8Array(32).fill(9) };
const payoutKey = bytesToHex(ed25519.getPublicKey(identity.secretKey));
const settings = { ...cap400(), rewards: { ...defaultSettings().rewards, payoutMinReset: '1' } };
const certificate = (kind, body) => secrets.slice(0, 3).map(s => signFact({ v: 1, networkId: 1, venueKey: h(3), epochId: context.epoch.id, kind, body }, s));
function snapshots(height = 1) {
  const head = { height, blockHash: h(height + 100) };
  return { inventory: { ...head, accounts: [{ address: owner, pieces: [
    { unitId: h(10), generation: 0, principalReset: '100000000', purpose: 'seller', state: 'free' },
    { unitId: h(11), generation: 0, principalReset: '900000000', purpose: 'seller', state: 'withdrawing' }] },
    { address: buyer, pieces: [{ unitId: h(12), generation: 0, principalReset: '100000000', purpose: 'buyer', state: 'free' }] }] },
    book: { ...head, backing: [{ address: owner, unitId: h(10), amount: '100000000' }] },
    price: { ...head, price: { numerator: '20000000', denominator: '1' } } };
}
function block(height = 1, poolBalance = '500000000', at = height * 600) {
  const s = snapshots(height);
  return { height, blockHash: s.inventory.blockHash, previousHash: h(height + 99), at, settings, poolBalance,
    inventoryCertificate: certificate('inventory', s.inventory), bookCertificate: certificate('book', s.book), priceCertificate: certificate('price', s.price) };
}
const ledger = (store = memoryStore()) => new RewardLedger({ store, context, identity });

test('weights count only live backing twice, buyers once, withdrawals zero, with per-address cap', () => {
  const s = snapshots(), weights = rewardWeights({ ...s, settings });
  assert.equal(weights.find(w => w.address === owner).weight, '2000000000000');
  assert.equal(weights.find(w => w.address === buyer).weight, '1000000000000');
  const huge = snapshots(); huge.inventory.accounts[0].pieces[0].principalReset = '3000000000'; huge.book.backing[0].amount = '3000000000';
  assert.equal(rewardWeights({ ...huge, settings }).find(w => w.address === owner).eligibleReset, '2000000000');
  const duplicate = snapshots(); duplicate.inventory.accounts.push(duplicate.inventory.accounts[0]);
  assert.throws(() => rewardWeights({ ...duplicate, settings }), /Duplicate/);
  const bogus = snapshots(); bogus.book.backing[0].unitId = h(12); assert.throws(() => rewardWeights({ ...bogus, settings }), /backing/);
});
test('accrual is deterministic, signed, conserves budget and rejects unsigned or mixed facts', () => {
  const l = ledger(), b = block(), result = l.accrue(b);
  assert.equal(verifyRewardSummary(result, payoutKey), true); assert.equal(verifyRewardSummary(result, h(33)), false);
  assert.equal(result.body.allocations.reduce((n, a) => n + BigInt(a.amount), 0n).toString(), result.body.budget);
  assert.deepEqual(l.accrue(b), result);
  assert.throws(() => l.accrue({ ...b, poolBalance: '1' }), /replay/);
  const skipped = ledger(); skipped.accrue(b);
  assert.equal(skipped.accrue(block(3)).body.height, 3, 'a missed height is skipped instead of stopping rewards');
  assert.throws(() => ledger().accrue({ ...b, inventoryCertificate: b.inventoryCertificate.slice(0, 2) }));
  assert.throws(() => ledger().accrue({ ...b, bookCertificate: block(2).bookCertificate }), /disagree/);
});
test('empty pool pauses with no debt, refill resumes on the next block only', () => {
  const l = ledger(), first = l.accrue(block(1, '0'));
  assert.equal(first.body.state, 'empty'); assert.equal(first.body.accrued, '0'); assert.deepEqual(l.read().accounts, {});
  const second = l.accrue(block(2)); assert.equal(second.body.state, 'active');
  const liabilities = Object.values(l.read().accounts).reduce((n, a) => n + BigInt(a.unpaid), 0n);
  const third = l.accrue(block(3, liabilities.toString())); assert.equal(third.body.state, 'empty');
  assert.equal(Object.values(l.read().accounts).reduce((n, a) => n + BigInt(a.unpaid), 0n), liabilities);
  assert.equal(l.status(owner, settings).poolState, 'empty');
});
test('write-ahead accrual crash after archive resumes once without double accrual', () => {
  const store = memoryStore(), l = ledger(store), put = store.put;
  let fail = true; store.put = (key, value) => { if (key === l.name && fail) throw new Error('disk interrupted'); return put(key, value); };
  const b = block(); assert.throws(() => l.accrue(b), /interrupted/);
  assert.throws(() => l.beginPayout(1000, settings), /interrupted/);
  fail = false; const resumed = ledger(store); assert.equal(resumed.read().height, 1);
  resumed.accrue(b); const before = resumed.read(); resumed.accrue(b);
  assert.deepEqual(resumed.read(), before);
});
test('certified penalty forfeits only that seller unpaid amount; replay cannot forfeit later rewards', () => {
  const l = ledger(), b = block(); l.accrue(b);
  const body = { decisionId: h(40), outcome: 'buyer-no-show', pieces: [{ unitId: h(10), generation: 0 }], reservationId: h(41),
    at: 600, winnerAddress: buyer, winnerBoxKey: h(42), evidenceDigest: h(43) };
  const input = { address: owner, decisionCertificate: certificate('decision', body), inventoryCertificate: b.inventoryCertificate, now: 600 };
  const amount = l.read().accounts[owner].unpaid, buyerAmount = l.read().accounts[buyer].unpaid;
  assert.equal(l.forfeit(input).amount, amount); assert.equal(l.read().accounts[owner].unpaid, '0');
  assert.equal(l.read().accounts[buyer].unpaid, buyerAmount);
  l.accrue(block(2)); const earned = l.read().accounts[owner].unpaid; l.forfeit(input); assert.equal(l.read().accounts[owner].unpaid, earned);
  assert.throws(() => l.forfeit({ ...input, address: buyer }), /another/);
});
test('payout eligibility honors the threshold or weekly positive balance and journals one transfer', () => {
  const l = ledger(); l.accrue(block());
  const weekly = { ...settings, rewards: { ...settings.rewards, payoutMinReset: '10000000000' } };
  assert.equal(l.beginPayout(601, weekly), null);
  const most = Object.values(l.read().accounts).reduce((m, a) => BigInt(a.unpaid) > m ? BigInt(a.unpaid) : m, 0n);
  assert.equal(l.beginPayout(600 + 604800, weekly, String(most + 1n)), null, 'a weekly balance below the floor stays unpaid');
  const p = l.beginPayout(600 + 604800, weekly, String(most)); assert.ok(p); assert.equal(p.amount, String(most));
  assert.deepEqual(l.beginPayout(700000, weekly), p);
  assert.throws(() => l.prepared(p.id, { txHash: h(50), bytes: 'synthetic', amount: '999', to: p.address, nonce: p.id, feeTnk: '3' }), /mismatch/);
  l.prepared(p.id, { txHash: h(50), bytes: 'synthetic', amount: p.amount, to: p.address, nonce: p.id, feeTnk: '3' });
  assert.throws(() => l.paid(p.id, { txHash: h(51), at: 700000 }), /Unknown/);
  l.paid(p.id, { txHash: h(50), at: 700000 }); assert.equal(l.read().accounts[p.address].unpaid, '0');
  assert.equal(l.read().accounts[p.address].paidTotal, p.amount); assert.equal(l.status(p.address, settings).lastPayout.tx, h(50));
});
test('payout service survives crash after send by reconciling original bytes, never paying twice', async () => {
  const store = memoryStore(); let sent = 0, prepared = 0, transferred, poolTnk = '3', crash = true, published = [];
  const adapter = { pool: async () => ({ confirmed: true, RESET: '500000000', TNK: poolTnk, feeTnk: '3' }),
    prepare: async p => { prepared++; return { txHash: h(60), bytes: 'synthetic-signed-transfer', amount: p.amount, to: p.to, nonce: p.nonce, feeTnk: '3' }; },
    sendPrepared: async tx => { sent++; transferred = tx; if (crash) throw new Error('crash after broadcast'); },
    outcome: async tx => ({ confirmed: true, txHash: tx.txHash, amount: tx.amount, to: tx.to }) };
  const make = () => new PayoutService({ store, context, identity, adapter, settings: () => settings, now: () => 1000, publish: async s => published.push(s) });
  const service = make(); await service.onBlock(block()); assert.equal(published.length, 1);
  poolTnk = '0'; assert.equal((await service.payout()).reason, 'tnk_short'); assert.equal(prepared, 0);
  poolTnk = '3'; await assert.rejects(service.payout(), /broadcast/); assert.equal(sent, 1); assert.equal(prepared, 1);
  crash = false; const restarted = make(); const result = await restarted.payout(); assert.equal(result.tx, transferred.txHash);
  assert.equal(sent, 1); assert.equal(prepared, 1); assert.equal(restarted.ledger.read().pending, null);
  assert.equal(restarted.status(transferred.to).paidTotal, transferred.amount);
});
test('unknown payout outcome remains pending and concurrent requests cannot create two intents', async () => {
  const store = memoryStore(); let sends = 0;
  const adapter = { pool: async () => ({ confirmed: true, RESET: '500000000', TNK: '3', feeTnk: '3' }),
    prepare: async p => ({ txHash: h(70), bytes: 'synthetic', amount: p.amount, to: p.to, nonce: p.nonce, feeTnk: '3' }),
    sendPrepared: async () => { sends++; }, outcome: async () => ({ unknown: true }) };
  const service = new PayoutService({ store, context, identity, adapter, settings: () => settings, now: () => 1000 });
  await service.onBlock(block()); await Promise.all([service.payout(), service.payout()]);
  assert.equal(sends, 1); assert.equal(service.ledger.read().payoutSequence, 1);
  assert.throws(() => new PayoutService({ store, context, identity, adapter: {}, settings: () => settings }), /requires/);
});

test('144 consecutive blocks distribute exactly the daily budget without rounding debt', () => {
  const l = ledger(); let total = 0n;
  for (let height = 1; height <= 144; height++) total += BigInt(l.accrue(block(height, '10000000000')).body.accrued);
  assert.equal(total.toString(), settings.rewards.dailyReset);
  assert.equal(Object.values(l.read().accounts).reduce((n, a) => n + BigInt(a.unpaid), 0n), total);
});

test('failed audit publication replays the frozen block even when pool balance and current policy change', async () => {
  const store = memoryStore(); let poolReads = 0, publishing = 0, current = settings;
  const adapter = { pool: async () => { poolReads++; return { confirmed: true, RESET: '500000000' }; }, prepare() {}, sendPrepared() {}, outcome() {} };
  const service = new PayoutService({ store, context, identity, adapter, settings: () => current,
    publish: async () => { if (++publishing === 1) throw Error('publish unavailable'); } });
  await assert.rejects(service.onBlock(block()), /publish unavailable/);
  const before = service.ledger.read();
  current = { ...settings, rewards: { ...settings.rewards, dailyReset: '1' } };
  const summary = await service.onBlock(block());
  assert.equal(poolReads, 1); assert.equal(publishing, 2); assert.deepEqual(service.ledger.read(), before);
  assert.equal(summary.body.budget, before.lastSummary.body.budget);
});

const penalty = (inventoryCertificate, now = 600) => ({ address: owner, now, inventoryCertificate,
  decisionCertificate: certificate('decision', { decisionId: h(40), outcome: 'buyer-no-show', pieces: [{ unitId: h(10), generation: 0 }],
    reservationId: h(41), at: now, winnerAddress: buyer, winnerBoxKey: h(42), evidenceDigest: h(43) }) });

test('forfeit cancels an unprepared payout and durably waits on an uncertain signed send', () => {
  const l = ledger(), b = block(); l.accrue(b);
  // Only the seller's larger weighted accrual reaches this threshold.
  const r = l.read();
  const threshold = { ...settings, rewards: { ...settings.rewards, payoutMinReset: r.accounts[owner].unpaid } };
  assert.equal(l.beginPayout(601, threshold).address, owner);
  const first = l.forfeit(penalty(b.inventoryCertificate));
  assert.equal(first.state, 'complete'); assert.equal(l.read().pending, null); assert.equal(l.read().accounts[owner].unpaid, '0');
  const other = ledger(); other.accrue(b); const p = other.beginPayout(601, threshold); assert.equal(p.address, owner);
  other.prepared(p.id, { txHash: h(80), bytes: 'synthetic', amount: p.amount, to: p.address, nonce: p.id, feeTnk: '3' });
  const deferred = other.forfeit(penalty(b.inventoryCertificate));
  assert.equal(deferred.state, 'pending'); other.accrue(block(2));
  const earnedLater = BigInt(other.read().accounts[owner].unpaid) - BigInt(p.amount);
  const restarted = new RewardLedger({ store: other.store, context, identity });
  restarted.paid(p.id, { txHash: h(80), at: 1200 });
  assert.equal(restarted.read().accounts[owner].unpaid, earnedLater.toString());
  assert.equal(restarted.forfeit(penalty(b.inventoryCertificate)).state, 'complete');
  assert.throws(() => restarted.forfeit({ ...penalty(b.inventoryCertificate), now: 599 }), /certified/);
});

test('award while a prepared transfer is unresolved suppresses every further broadcast', async () => {
  let sends = 0;
  const adapter = { pool: async () => ({ confirmed: true, RESET: '500000000', TNK: '3', feeTnk: '3' }),
    prepare: async p => ({ txHash: h(81), bytes: 'synthetic', amount: p.amount, to: p.to, nonce: p.id ?? p.nonce, feeTnk: '3' }),
    sendPrepared: async () => { sends++; }, outcome: async () => ({ pending: false, unknown: false }) };
  const threshold = { ...settings, rewards: { ...settings.rewards, payoutMinReset: '2000000' } };
  const service = new PayoutService({ store: memoryStore(), context, identity, adapter, settings: () => threshold, now: () => 1000 });
  const b = block(); await service.onBlock(b); await service.payout(); assert.equal(sends, 1);
  assert.equal(service.ledger.read().pending.address, owner);
  await service.forfeit(penalty(b.inventoryCertificate));
  assert.equal((await service.payout()).reason, 'forfeit_reconciliation'); assert.equal(sends, 1);
});

test('reward verification accepts 5000 pieces with unchanged weights and rejects larger or duplicate inventories', () => {
  const s = snapshots(); s.book.backing = [];
  s.inventory.accounts = Array.from({ length: 25 }, (_, account) => ({ address: tracAddress(h(20000 + account)),
    pieces: Array.from({ length: 200 }, (_, piece) => ({ unitId: h(10000 + account * 200 + piece), generation: 0,
      principalReset: '25000', purpose: 'seller', state: 'free' })) }));
  const weights = rewardWeights({ ...s, settings });
  assert.equal(weights.length, 25);
  assert.equal(weights.reduce((sum, w) => sum + BigInt(w.eligibleReset), 0n), 125000000n);
  assert.equal(weights.reduce((sum, w) => sum + BigInt(w.weight), 0n), 1250000000000n);
  const active = structuredClone(s);
  active.book.backing = active.inventory.accounts.flatMap(a => a.pieces.map(p => ({ address: a.address, unitId: p.unitId, amount: p.principalReset })));
  assert.equal(rewardWeights({ ...active, settings }).reduce((sum, w) => sum + BigInt(w.weight), 0n), 2500000000000n);
  const separate = structuredClone(s);
  separate.inventory.accounts = s.inventory.accounts.flatMap(a => a.pieces).map((piece, n) => ({ address: tracAddress(h(50000 + n)), pieces: [piece] }));
  assert.equal(rewardWeights({ ...separate, settings }).length, 5000);
  const larger = structuredClone(s);
  larger.inventory.accounts.push({ address: tracAddress(h(30000)), pieces: [{ ...s.inventory.accounts[0].pieces[0], unitId: h(40000) }] });
  assert.throws(() => rewardWeights({ ...larger, settings }), /piece cap/);
  const duplicate = structuredClone(s); duplicate.inventory.accounts[1].pieces[0].unitId = duplicate.inventory.accounts[0].pieces[0].unitId;
  assert.throws(() => rewardWeights({ ...duplicate, settings }), /Duplicate stake piece/);
  const perAccount = structuredClone(s); perAccount.inventory.accounts[0].pieces.push(perAccount.inventory.accounts[1].pieces.pop());
  assert.throws(() => rewardWeights({ ...perAccount, settings }));
});
