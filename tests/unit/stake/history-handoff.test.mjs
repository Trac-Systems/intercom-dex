import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CompletionLog } from '../../../src/stake/price.js';
import { StakePriceService, stakeContext } from '../../../src/stake/price-service.js';
import { StakeEpochHandoff } from '../../../src/stake/epoch-handoff.js';
import { RewardCheckpoints } from '../../../src/stake/reward-checkpoints.js';
import { RewardLedger } from '../../../src/stake/rewards.js';
import { PayoutRole } from '../../../src/roles/payout-runtime.js';
import { signFact, verifyCertificate, verifyFact } from '../../../src/stake/certificates.js';
import { memoryStore, registryPolicy, secrets, members } from './helpers.mjs';
import { fixture, tracAddress } from '../core/helpers.mjs';
const h = n => n.toString(16).padStart(64, '0');
const A = registryPolicy({ networkId: 1, venueKey: members[0].dexKey, epochId: h(1) });
const B = registryPolicy({ networkId: 1, venueKey: A.venueKey, epochId: h(2) });
const context = policy => stakeContext({ sellerBond: policy });
const cert = (policy, kind, body) => secrets.slice(0, 3).map(s => signFact({ v: 1, networkId: 1, venueKey: A.venueKey, epochId: policy.epoch.id, kind, body }, s));
function seed(store) {
  const log = new CompletionLog({ store, context: context(A) });
  for (let i = 1; i <= 15; i++) {
    const certificate = cert(A, 'completion', { logPosition: i, prevHash: log.read().hash, tradeId: h(i + 100), escrowId: h(i + 200), nonce: h(i + 300), pair: 'RESET/USDC', baseAmount: '100000000', quoteAmount: String(i), completedAt: 86400 + i, termsDigest: h(400), escrowDigest: h(500), deliveryDigest: h(600) });
    log.append({ venue: certificate[0], certificate }, 86500);
  }
  return log;
}
const history = log => cert(A, 'history-head', { nextEpochId: B.epoch.id, headPosition: log.read().position, headHash: log.read().hash });

test('successor keeps every original completion, date, median and identity across paged adoption and restart', async () => {
  const venueStore = memoryStore(), source = seed(venueStore), store = memoryStore();
  for (const s of [venueStore, store]) { s.put('stake-retained-epoch-' + A.epoch.id, A); s.put('stake-epoch-draining-' + B.epoch.id, { previousEpochId: A.epoch.id }); }
  const args = { registry: () => ({ sellerBond: B }), clock: async () => ({ at: 86500 }), identity: { publicKey: members[1].dexKey, secretKey: secrets[1] } };
  const venue = new StakePriceService({ ...args, store: venueStore, venue: true });
  const make = () => new StakePriceService({ ...args, store, request: (_to, method, body) => venue.handle(method, body, members[1].dexKey) });
  const input = { previousEpochId: A.epoch.id, certificate: history(source) };
  assert.throws(() => make().log(), /reconciliation/);
  await assert.rejects(make().handle('priceHistoryAdopt', input, members[2].dexKey), /authorization/);
  assert.equal((await make().handle('priceHistoryAdopt', input, A.venueKey)).position, 15);
  assert.throws(() => make().log(), /reconciliation/);
  await make().handle('priceHistoryReady', input, A.venueKey);
  await make().handle('priceHistoryAdopt', input, A.venueKey);
  const log = make().log(); assert.deepEqual(log.read(), source.read());
  assert.deepEqual(log.entry(1), source.entry(1));
  const certificate = cert(B, 'price-head', { cutoffAt: 86500, headPosition: 15, headHash: log.read().hash });
  assert.deepEqual(log.reference({ venue: certificate[0], certificate }, 86500).q, { numerator: '8', denominator: '1' });
  assert.throws(() => log.adoptHistory(cert(A, 'history-head', { ...input.certificate[0].fact.body, headPosition: 14 }), context(A)), /Complete original/);
  const nextDay = cert(B, 'price-head', { cutoffAt: 172800, headPosition: 15, headHash: log.read().hash });
  assert.throws(() => log.reference({ venue: nextDay[0], certificate: nextDay }, 172800), /unavailable/);
  const fallback = log.reference({ venue: nextDay[0], certificate: nextDay }, 172800, 60, B.economics.active.settings.priceLookbackSec);
  assert.equal(fallback.utcDay, '1970-01-02'); assert.equal(fallback.dayCount, 15);
  assert.deepEqual(fallback.q, { numerator: '8', denominator: '1' });
  assert.deepEqual(make().log().entry(1), source.entry(1), 'fallback across epochs preserves original certificates and date');
});

test('resume stays closed without successor history quorum and replays a lost publication exactly', async () => {
  const store = memoryStore(), source = seed(store); let policy = { ...B, acceptNew: false }, available = false, lost = true, votes = 0;
  store.put('stake-epoch-handoff', { done: true, previous: A, next: policy });
  store.put('stake-epoch-draining-' + B.epoch.id, { previousEpochId: A.epoch.id });
  const args = { store, registry: () => ({ sellerBond: policy }), request: async (to, method, input) => {
    const i = members.findIndex(m => m.dexKey === to);
    if (method === 'priceHistoryVote') { votes++; return history(source)[i % 3]; }
    if (!available) throw Error('offline');
    return method === 'priceHistoryAdopt' ? { adopted: true } : { ready: true, epochId: B.epoch.id };
  }, publish: async p => { policy = p; if (lost) { lost = false; throw Error('reply lost'); } } };
  await assert.rejects(new StakeEpochHandoff(args).resume(), /history quorum/); assert.equal(policy.acceptNew, false);
  available = true; await assert.rejects(new StakeEpochHandoff(args).resume(), /reply lost/);
  assert.equal((await new StakeEpochHandoff(args).resume()).state, 'active');
  await new StakeEpochHandoff(args).resume(); assert.equal(votes, 4); assert.deepEqual(new CompletionLog({ store, context: context(B) }).read(), source.read());
});

test('B reward inventory includes contemporaneous certified A pieces and refuses unavailable originals', async () => {
  const store = memoryStore(), old = seed(store), log = new CompletionLog({ store, context: context(B) }); log.adoptHistory(history(old), context(A));
  const address = tracAddress(h(800)), head = { height: 3, blockHash: h(3), previousHash: h(2) };
  const capture = { inventory: { height: 3, blockHash: h(3), accounts: [{ address, pieces: [{ unitId: h(20), principalReset: '200', purpose: 'seller', state: 'free', generation: 0 }] }] } };
  let available = true;
  const role = new RewardCheckpoints({ store, registry: () => ({ sellerBond: B }), request: async (to) => {
    if (!available) throw Error('offline');
    const certificate = cert(A, 'inventory', { height: 3, blockHash: h(3), accounts: [{ address, pieces: [{ unitId: h(10), principalReset: '100', purpose: 'seller', state: 'reserved', generation: 1 }] }] });
    return certificate[members.findIndex(m => m.dexKey === to) % 3];
  } });
  available = false; await assert.rejects(role.completeInventory(head, capture), /Three matching/);
  available = true; const inventory = await role.completeInventory(head, capture);
  assert.deepEqual(inventory.accounts[0].pieces.map(p => p.principalReset), ['100', '200']);
  available = false; assert.deepEqual(await role.completeInventory(head, capture), inventory);
  await assert.rejects(role.completeInventory({ ...head, blockHash: h(99) }, capture), /block differs/);
});

test('payout handoff preserves unpaid/paid/forfeited liabilities, cursor and sequence, and rejects pending transfers', async () => {
  const store = memoryStore(), previous = { ...A, rewardService: { dexKey: members[3].dexKey, tracAddr: tracAddress(h(44)) } };
  const next = { ...B, rewardService: previous.rewardService }, registry = { ...fixture().registry, sellerBond: next };
  store.put('registry-current', registry); store.put('registry-v1', { sellerBond: previous });
  const ledger = new RewardLedger({ store, context: context(previous), identity: { secretKey: secrets[3] } }), record = ledger.read();
  record.accounts[tracAddress(h(55))] = { unpaid: '12', paidTotal: '7', forfeited: '3', since: 4000 }; record.payoutSequence = 9;
  record.pending = { id: h(66) }; ledger.save(record);
  store.put('stake-payout-cursor', { height: 3, blockHash: h(3), epochId: A.epoch.id });
  const make = () => new PayoutRole({ bridge: new EventEmitter(), store, serviceKey: A.venueKey, identity: { publicKey: members[3].dexKey, secretKey: secrets[3] }, address: previous.rewardService.tracAddr,
    now: () => 10000, blockClock: { counted: async () => 3, hash: async n => h(n) }, adapter: { pool: async () => ({ confirmed: true, RESET: '100', TNK: '3', feeTnk: '3' }) } });
  const input = { previousEpochId: A.epoch.id, nextEpochId: B.epoch.id };
  await assert.rejects(make().rewardHandoff('rewardHandoffFreeze', input, A.venueKey), /reconciliation/);
  record.pending = null; ledger.save(record);
  const liability = await make().rewardHandoff('rewardHandoffFreeze', input, A.venueKey);
  assert.equal(verifyFact(liability, context(A), 'liability-handoff', members[3].dexKey).body.unpaid, '12');
  assert.deepEqual(await make().rewardHandoff('rewardHandoffFreeze', input, A.venueKey), liability);
  await make().rewardHandoff('rewardHandoffAdopt', { ...input, liability }, A.venueKey);
  assert.deepEqual(ledger.read(), record); assert.equal(store.get('stake-payout-cursor').epochId, B.epoch.id);
  await make().rewardHandoff('rewardHandoffRelease', { ...input, liability }, A.venueKey);
  record.accounts[tracAddress(h(55))].unpaid = '13'; ledger.save(record);
  await make().rewardHandoff('rewardHandoffRelease', { ...input, liability }, A.venueKey);
  assert.equal(store.get('stake-payout-handoff').frozen, false); assert.equal(ledger.read().payoutSequence, 9);
});
