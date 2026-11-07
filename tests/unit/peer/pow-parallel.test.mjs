import test from 'node:test';
import assert from 'node:assert/strict';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
import { powWorker } from '../../../peer/features/sidechannel/pow-client.js';
import { stakeMessageExpired, STAKE_POW_CHANNEL, dexTransport } from '../../../peer/features/dex-transport.js';

const classes = [['heartbeat'], ['deal', 'stakeRequest', 'stakeReply']];
function channel(t) {
  const sc = new Sidechannel({}, { powEnabled: true, powDifficulty: 1, powClasses: classes, powWorkers: 4, powParallelChannels: [STAKE_POW_CHANNEL] });
  sc._now = () => 100000;
  let running = 0, most = 0; const gates = [];
  t.mock.method(sc, '_buildPayload', async (ch, message) => {
    running++; most = Math.max(most, running);
    await new Promise(resolve => gates.push(resolve));
    running--; return { channel: ch, message, ts: 100000 };
  });
  return { sc, gates, most: () => most };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('stake messages stamp side by side, one lane per worker, while other channels keep their order', async t => {
  const a = channel(t);
  assert.equal(powWorker.size, 4);
  const stake = Array.from({ length: 6 }, (_, i) => a.sc._stampedPayload(STAKE_POW_CHANNEL, { kind: 'stakeReply', n: i }));
  await tick();
  assert.equal(a.most(), 4, 'four lanes for four workers');
  while (a.gates.length) { a.gates.shift()(); await tick(); }
  await Promise.all(stake);
  assert.ok(a.sc.powLanes[1].every(lane => lane.pending === 0));
  const b = channel(t);
  const deals = Array.from({ length: 3 }, (_, i) => b.sc._stampedPayload('intercom-dex:t:' + 'a'.repeat(64), { kind: 'deal', n: i }));
  await tick();
  assert.equal(b.most(), 1, 'trade dealings keep one ordered queue');
  while (b.gates.length) { b.gates.shift()(); await tick(); }
  await Promise.all(deals);
});

test('a stake message nobody waits for any more is dropped before stamping', async () => {
  assert.equal(stakeMessageExpired(STAKE_POW_CHANNEL, { at: 100, method: 'priceHeadVote' }, 145000), false);
  assert.equal(stakeMessageExpired(STAKE_POW_CHANNEL, { at: 100, method: 'priceHeadVote' }, 146000), true);
  assert.equal(stakeMessageExpired(STAKE_POW_CHANNEL, { at: 100, method: 'rewardBlock' }, 175000), false);
  assert.equal(stakeMessageExpired('intercom-dex:signers', { at: 100 }, 999999000), false);
  const sc = new Sidechannel({}, { powEnabled: true, powDifficulty: 1, powExpired: (ch, m) => m.old === true });
  sc._now = () => 100000;
  await assert.rejects(sc._attachPow({ channel: 'x', from: null, id: '1', message: { old: true }, origin: null, ts: 100000 }), /expired before stamping/);
  const fresh = { channel: 'x', from: null, id: '2', message: { old: false }, origin: null, ts: 100000 };
  await sc._attachPow(fresh); assert.equal(sc._checkPow(fresh, 'x'), true);
});

test('every DEX peer, traders included, stamps stake messages in their own lane and drops expired ones', () => {
  for (const role of ['trader', 'service', 'signer', 'payout']) {
    const sc = dexTransport({ role, servicePeerKey: 'f'.repeat(64) }).sidechannel;
    assert.deepEqual(sc.powParallelChannels, [STAKE_POW_CHANNEL]);
    assert.equal(sc.powExpired, stakeMessageExpired);
    assert.equal(sc.powWorkers, role === 'trader' ? undefined : 8);
  }
});
