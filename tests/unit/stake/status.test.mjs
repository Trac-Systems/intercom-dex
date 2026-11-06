import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { stakeStatus, rewardsStatus, deliveryStatus, deliveryWarnings, formatAmount, stakeRequestSchema, rewardsRequestSchema, DELIVERY_STATES, withdrawalStatus } from '../../../src/stake/status.js';
import { errorDetails, stakeError } from '../../../src/stake/errors.js';
import { defaultSettings } from '../../../src/stake/settings.js';
import { registerStakeTools } from '../../../src/mcp/stake-tools.js';
import { parseStakeCommand } from '../../../src/stake/cli.js';
import { controlHandler } from '../../../src/roles/control.js';
import { Trader } from '../../../src/roles/trader.js';
import { StakeLedger, unitId } from '../../../src/stake/ledger.js';
import { signFact } from '../../../src/stake/certificates.js';
import { registryPolicy, memoryStore, secrets } from './helpers.mjs';
import { tracAddress } from '../core/helpers.mjs';
const h = '1'.repeat(64);
const piece = (state, principalReset) => ({ state, descriptor: { principalReset } });

test('withdrawal status separates deferred, returning, returned and forfeited principal', () => {
  assert.equal(withdrawalStatus(null, []), null);
  const op = { kind: 'withdraw', operationId: h, amount: 'all', targets: [
    { unitId: 'one', amount: '1' }, { unitId: 'two', amount: '2' },
    { unitId: 'three', amount: '3', done: true }, { unitId: 'four', amount: '4', done: true, forfeited: h }] };
  const status = withdrawalStatus(op, [{ unitId: 'one', state: 'reserved' }, { unitId: 'two', state: 'withdrawing' }]);
  assert.equal(status.deferred, '1'); assert.equal(status.withdrawing, '2'); assert.equal(status.returned, '3'); assert.equal(status.forfeited, '4');
  assert.equal(status.formatted.deferred, '0.00000001'); assert.equal(status.pending, true);
});

test('stake contract uses strings, separate formatting, subsets and unknown coverage', () => {
  const status = stakeStatus({ settings: defaultSettings(), openOffersUsd: '100000000',
    pieces: [piece('free', '100000000'), piece('reserved', '20000000'), piece('withdrawing', '30000000'), piece('retired', '90000000')] });
  assert.equal(status.locked, '150000000'); assert.equal(status.reserved, '20000000'); assert.equal(status.free, '100000000');
  assert.equal(status.formatted.locked, '1.5'); assert.equal(status.suggestedUsd, '4500000'); assert.equal(status.capUsd, '400000000');
  assert.equal(status.state, 'withdrawing'); assert.equal(status.coverageUsd, null);
  assert.equal(stakeStatus({ pending: '1' }).state, 'pending'); assert.equal(stakeStatus().state, 'none');
  assert.throws(() => stakeStatus({ pending: '-1' })); assert.throws(() => formatAmount('1', -1)); assert.equal(formatAmount('10', 0), '10');
});
test('reward contract preserves unknown pool state and exact base units', () => {
  const status = rewardsStatus({ unpaid: '10000000', poolBalance: '500000000', dailyBudget: '500000000', weight: 'idle' });
  assert.equal(status.formatted.unpaid, '0.1'); assert.equal(status.poolState, 'unknown');
  assert.equal(rewardsStatus().poolBalance, null); assert.throws(() => rewardsStatus({ weight: 'other' }));
  assert.throws(() => rewardsStatus({ unpaid: '-1' }));
  const lastPayout = { amount: '10000000', tx: h, at: '1970-01-01T00:01:00.000Z' };
  assert.equal(rewardsStatus({ lastPayout }).lastPayout.atUnix, 60);
  assert.equal(rewardsStatus({ lastPayout }).lastPayout.formatted.amount, '0.1');
  assert.throws(() => rewardsStatus({ lastPayout: { ...lastPayout, atUnix: 61 } }));
  assert.throws(() => rewardsStatus({ lastPayout: { ...lastPayout, bytes: 'private transfer' } }));
});
test('trader reads stake inventory in its authenticated publication scope without a fallback network', t => {
  t.mock.method(Date, 'now', () => 4000 * 1000);
  const policy = registryPolicy(), store = memoryStore(), address = tracAddress('2'.repeat(64));
  const context = { networkId: policy.networkId, venueKey: policy.venueKey, epoch: policy.epoch };
  const descriptor = { networkId: context.networkId, venueKey: context.venueKey, epochId: context.epoch.id,
    batchId: h, nonce: h, owner: { dexKey: h, tracAddr: address, boxKey: h }, purpose: 'buyer', principalReset: '2500000',
    tnkReserve: '90000000000000000', createdAt: 0, expiresAt: 100000 };
  const fact = { v: 1, ...context, epochId: context.epoch.id, kind: 'funded', body: { descriptor, unitId: unitId(descriptor),
    address: tracAddress('3'.repeat(64)), fundingDigest: h } };
  delete fact.epoch;
  new StakeLedger({ store, context, address }).admitFunded(secrets.slice(0, 3).map(s => signFact(fact, s)),
    { now: 4000, settings: defaultSettings(), price: { numerator: '20000000', denominator: '1' } });
  const status = Trader.prototype.stakeView.call({ registry: { usable: { sellerBond: policy } }, store,
    me: { tracAddr: address }, mine: new Map() });
  assert.equal(status.stake.locked, '2500000'); assert.equal(status.stake.free, '2500000');
  assert.equal(status.stake.capUsd, '400000000'); assert.equal(status.rewards.poolState, 'unknown');
});
test('delivery states and warnings bind deadline and fixed amount at risk; negotiation has none', () => {
  const trade = { role: 'seller', state: { tradeId: h, phase: 'transferring', escrowOk: true, terms: { sendBy: 1000,
    bond: { overdueDelaySec: 1800, payoutReset: '2500000', payoutUsd: '500000' } } } };
  const state = changes => deliveryStatus({ ...trade, state: { ...trade.state, ...changes } }, 1500).state;
  assert.equal(state({}), 'delivery_sending'); assert.equal(state({ deliveryFailure: 'send_failed' }), 'delivery_failed');
  assert.equal(state({ txHash: h }), 'delivery_confirming'); assert.equal(state({ transferFinal: true }), 'delivered');
  assert.equal(state({ penaltyPaid: true }), 'penalty_paid'); assert.equal(deliveryStatus(trade, 2800).state, 'delivery_overdue');
  const warnings = deliveryWarnings([trade], 2800); assert.equal(warnings.length, 1); assert.match(warnings[0].message, /0.025 RESET \(\$0.5\)/);
  assert.equal(warnings[0].deadlineUnix, 2800); assert.equal(warnings[0].tradeId, h);
  for (const [reason, text] of [['coin_short', /sold coin/], ['tnk_short', /TNK.*fee/],
    ['gateway_unavailable', /gateway is unavailable/], ['send_failed', /could not be sent/], ['confirmation_pending', /final confirmation/]]) {
    const failed = { ...trade, state: { ...trade.state, deliveryFailure: reason } };
    const [warning] = deliveryWarnings([failed], 1500);
    assert.match(warning.message, text); assert.match(warning.message, /0.025 RESET \(\$0.5\).*Fix by/);
    assert.doesNotMatch(warning.message, new RegExp(reason));
  }
  assert.equal(deliveryStatus({ state: { phase: 'awaitTake' } }, 100), null);
  assert.equal(DELIVERY_STATES.length, 6); assert.throws(() => deliveryWarnings([], -1));
});
test('stake requests have action-specific amount validation and a fixed error set', () => {
  for (const request of [{ action: 'deposit' }, { action: 'deposit', amount: '0' }, { action: 'deposit', amount: 'all' },
    { action: 'deposit', amount: '0.000000001' }, { action: 'status', amount: '1' }, { action: 'withdraw', penalty: 2 }])
    assert.equal(stakeRequestSchema.safeParse(request).success, false);
  assert.equal(stakeRequestSchema.parse({ action: 'withdraw' }).action, 'withdraw');
  assert.equal(stakeRequestSchema.parse({ action: 'deposit', amount: '0.00000001' }).amount, '0.00000001');
  assert.equal(rewardsRequestSchema.safeParse({ action: 'payout' }).success, false);
  assert.equal(Object.keys(errorDetails).length, 14);
  const e = stakeError('bond_setup_unavailable', { retrySec: 60 }); assert.equal(e.result.ok, false); assert.match(e.message, /moved no money/);
  const unknown = stakeError('bond_pending', { etaSec: 60 }, { pending: true, operationId: h,
    money: [{ asset: 'RESET', amount: '1', direction: 'outgoing', state: 'unknown' }] });
  assert.equal(unknown.result.ok, true); assert.match(unknown.message, /money may have moved/); assert.doesNotMatch(unknown.message, /moved no money/);
  assert.throws(() => stakeError('bond_not_reserved', {}, { money: unknown.result.money }));
  assert.throws(() => stakeError('bond_new_code', {})); assert.throws(() => stakeError('bond_required', { extra: true }));
});
test('MCP and CLI route the same strict stake/rewards contract and retain structured errors', async () => {
  const tools = new Map(), calls = [];
  registerStakeTools({ registerTool: (name, schema, run) => tools.set(name, { schema, run }) }, async (...args) => {
    calls.push(args); return stakeError('bond_setup_unavailable', { retrySec: 60 }).result;
  });
  const response = await tools.get('dex_stake').run({ action: 'deposit', amount: '1' }); assert.equal(response.isError, true);
  assert.equal(JSON.parse(response.content[0].text).code, 'bond_setup_unavailable');
  assert.deepEqual(calls[0], ['POST', '/stake/deposit', { amount: '1' }]);
  await tools.get('dex_rewards').run({ action: 'status' }); assert.deepEqual(calls[1], ['GET', '/rewards']);
  await assert.rejects(() => tools.get('dex_stake').run({ action: 'status', amount: '1' }));
  assert.deepEqual(parseStakeCommand(['stake', 'deposit', '1']), { method: 'POST', route: '/stake/deposit', body: { amount: '1' } });
  assert.deepEqual(parseStakeCommand(['stake', 'withdraw']), { method: 'POST', route: '/stake/withdraw', body: {} });
  assert.deepEqual(parseStakeCommand(['rewards', 'status']), { method: 'GET', route: '/rewards' });
  assert.throws(() => parseStakeCommand(['stake', 'status', '1'])); assert.throws(() => parseStakeCommand(['rewards', 'withdraw']));
});
test('control routes keep auth, reject unknown fields and return movement-aware refusal JSON', async t => {
  const role = { stakeView: () => ({ stake: stakeStatus(), rewards: rewardsStatus() }), stakeAction: input => {
    const args = stakeRequestSchema.parse(input); if (args.action === 'status') return { ok: true, stake: stakeStatus() };
    throw stakeError('bond_setup_unavailable', { retrySec: 60 });
  } };
  const server = createServer(controlHandler({ token: 'synthetic', role }));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`, headers = { authorization: 'Bearer synthetic', 'content-type': 'application/json' };
  assert.equal((await fetch(url + '/stake')).status, 401);
  assert.equal((await fetch(url + '/stake', { headers })).status, 200);
  const response = await fetch(url + '/stake/deposit', { method: 'POST', headers, body: '{"amount":"1"}' });
  assert.equal(response.status, 400); assert.equal((await response.json()).code, 'bond_setup_unavailable');
  const bad = await fetch(url + '/stake/deposit', { method: 'POST', headers, body: '{"amount":"1","action":"status"}' });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /Unknown/);
});

test('dashboard stake fields retain exact units, policy weights, maturity and safe links', () => {
  const settings = defaultSettings(), status = stakeStatus({ settings, price: { numerator: '2000000000', denominator: '1' },
    pieces: [{ ...piece('withdrawing', '25000'), availableAt: 90000 }] });
  assert.equal(status.withdrawDelaySec, 86400); assert.equal(status.withdrawingUntil, 90000);
  assert.equal(status.penaltyBps, 300); assert.equal(status.minPenaltyUsd, '500000'); assert.equal(status.priceUsd, '2000');
  assert.equal(stakeStatus().priceUsd, null);
  const lastPayout = { amount: '1', tx: h, at: '1970-01-01T00:01:00.000Z', link: 'https://explorer.example/tx/' + h };
  assert.equal(rewardsStatus({ lastPayout, activeWeightBps: 20000 }).lastPayout.link, lastPayout.link);
  assert.equal(rewardsStatus({ activeWeightBps: 20000 }).activeWeightBps, 20000);
  for (const link of ['http://explorer.example/tx', 'javascript:alert(1)', 'https://password@explorer.example/'])
    assert.throws(() => rewardsStatus({ lastPayout: { ...lastPayout, link } }));
  const trade = { state: { tradeId: h, phase: 'transferring', escrowOk: true, gatewayPaused: true, terms: { sendBy: 1000 }, deliveryLink: lastPayout.link } };
  assert.equal(deliveryStatus(trade, 100).reason, 'gateway_paused');
  assert.equal(deliveryStatus(trade, 100).link, lastPayout.link);
  assert.equal(deliveryStatus({ state: { ...trade.state, deliveryLink: 'javascript:alert(1)' } }, 100).link, undefined);
});

test('reward status can cross authenticated RPC twice without trusting formatted values', () => {
  const input = { unpaid: '3', paidTotal: '5', lastPayout: { amount: '5', tx: 'a'.repeat(64), at: '2026-11-03T16:00:00.000Z' } };
  const first = rewardsStatus(input), second = rewardsStatus(first);
  assert.deepEqual(first, second);
  assert.equal(rewardsStatus({ ...first, lastPayout: { ...first.lastPayout, formatted: { amount: '999' } } }).lastPayout.formatted.amount, '0.00000005');
  assert.throws(() => rewardsStatus({ ...first, lastPayout: { ...first.lastPayout, bytes: 'internal' } }));
});

test('stake status uses the fixed dashboard reason list for missing price and excess marked value', () => {
  const settings = defaultSettings();
  assert.equal(stakeStatus({ settings }).reason, 'price_unavailable');
  const piece = { state: 'free', descriptor: { principalReset: '3000000000' } };
  assert.equal(stakeStatus({ settings, pieces: [piece], price: { numerator: '20000000', denominator: '1' } }).reason, 'over_cap');
  assert.equal(stakeStatus({ settings, price: { numerator: '20000000', denominator: '1' }, reason: 'tnk_short' }).reason, 'tnk_short');
  assert.throws(() => stakeStatus({ reason: 'invented' }), /Invalid stake/);
});
