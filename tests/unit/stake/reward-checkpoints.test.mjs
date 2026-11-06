import test from 'node:test';
import assert from 'node:assert/strict';
import { RewardCheckpoints } from '../../../src/stake/reward-checkpoints.js';
import { PayoutRole } from '../../../src/roles/payout-runtime.js';
import { EventEmitter } from 'node:events';
import { memoryStore, registryPolicy, secrets } from './helpers.mjs';
import { tracAddress, fixture as tradeFixture } from '../core/helpers.mjs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { verifyCertificate, factDigest, signFact } from '../../../src/stake/certificates.js';
import { stakeContext } from '../../../src/stake/price-service.js';
const h = n => n.toString(16).padStart(64, '0');
const venueSecret = new Uint8Array(32).fill(8), payoutSecret = new Uint8Array(32).fill(9);
const key = secret => Buffer.from(ed25519.getPublicKey(secret)).toString('hex');
async function fixture() {
  const policy = registryPolicy({ networkId: 1, venueKey: key(venueSecret), epochId: h(8) });
  policy.rewardService = { dexKey: key(payoutSecret), tracAddr: tracAddress(h(4)) };
  const registry = { ...tradeFixture().registry, sellerBond: policy }, context = stakeContext(registry), owner = tracAddress(h(3));
  let height = 0, now = 4000, offers = [], awards = [];
  const clock = async () => ({ at: now }), blockClock = { counted: async () => height, hash: async n => h(n + 100) };
  const price = { handle: async () => ({}), import: async () => ({ numerator: '2000000000', denominator: '1' }) };
  const stores = secrets.map(() => memoryStore());
  for (const store of stores) store.put('stake-ledger-test', { pieces: { [h(9)]: { unitId: h(9), generation: 0, state: 'free',
    descriptor: { networkId: 1, venueKey: context.venueKey, epochId: context.epoch.id, owner: { tracAddr: owner }, principalReset: '25000', purpose: 'seller' } } } });
  const signers = secrets.map((secretKey, i) => new RewardCheckpoints({ store: stores[i], identity: { publicKey: key(secretKey), secretKey },
    registry: () => registry, clock, blockClock, price, offers: () => offers, balances: async () => ({ RESET: '1000000000', TNK: '1000000000', feeTnk: '1' }) }));
  const store = memoryStore(), venue = new RewardCheckpoints({ store, identity: { publicKey: context.venueKey, secretKey: venueSecret },
    registry: () => registry, clock, blockClock, price, venue: true, offers: () => offers,
    request: (to, method, body) => signers[context.epoch.members.findIndex(m => m.dexKey === to)].handle(method, body, context.venueKey) });
  const observe = () => Promise.all([venue, ...signers].map(s => s.observe()));
  await observe(); height = 1; now += 5; await observe();
  return { registry, context, owner, venue, signers, stores, blockClock, setHeight: async n => { height = n; now += 5; await observe(); },
    setOffers: o => { offers = o; }, setAwards: rows => { awards = rows; }, request: (method, body) => method === 'penaltyAwards' ? { after: body.after, through: awards.length, total: awards.length, awards: awards.slice(body.after) } : venue.handle(method, body, policy.rewardService.dexKey) };
}
test('real checkpoint roles agree on durable inventory and bind all components to one original head', async () => {
  const f = await fixture(), block = await f.request('rewardBlock', { height: 1 });
  const head = verifyCertificate(block.headCertificate, f.context, 'reward-head').body;
  for (const kind of ['inventory', 'book', 'price']) assert.equal(head[kind + 'Digest'], factDigest(verifyCertificate(block[kind + 'Certificate'], f.context, kind)));
  assert.equal(verifyCertificate(block.inventoryCertificate, f.context, 'inventory').body.accounts[0].pieces[0].principalReset, '25000');
  await f.setHeight(2);
  assert.deepEqual(await f.request('rewardBlock', { height: 1 }), block, 'historical retrieval returns the saved checkpoint');
  await assert.rejects(f.request('rewardBlock', { height: 3 }), /Current counted/);
  f.setOffers([]); await f.setHeight(3); assert.ok(await f.request('rewardBlock', { height: 3 }));
  await assert.rejects(f.venue.handle('rewardBlock', { height: 2 }, h(90)), /Configured/);
});
test('one missing signer can be tolerated; three current matching original views are required', async () => {
  const f = await fixture(); f.stores[3].put('stake-ledger-test', { pieces: {} });
  assert.ok(await f.request('rewardBlock', { height: 1 }));
  f.stores[2].put('stake-ledger-test', { pieces: {} }); await f.setHeight(2);
  await assert.rejects(f.request('rewardBlock', { height: 2 }), /Three matching/);
});
test('missed heights cannot be reconstructed from current stake inventory', async () => {
  const f = await fixture(); await f.setHeight(3);
  await assert.rejects(f.request('rewardBlock', { height: 3 }), /Contemporaneous/);
  await assert.rejects(f.request('rewardBlock', { height: 2 }), /Current counted/);
});
test('configured payout listener starts with the next block, pauses empty, pays after refill and recovers without duplication', async () => {
  const f = await fixture(), store = memoryStore(); store.put('registry-current', f.registry);
  let pool = '0', sent = 0, final = false, poolReads = 0;
  const adapter = { pool: async () => { poolReads++; return { confirmed: true, RESET: pool, TNK: '3', feeTnk: '3' }; },
    prepare: async p => ({ txHash: h(77), bytes: 'signed', amount: p.amount, to: p.to, nonce: p.nonce, feeTnk: '3' }),
    sendPrepared: async () => { sent++; final = true; }, outcome: async p => ({ confirmed: final, txHash: p.txHash, amount: p.amount, to: p.to }) };
  const bridge = new EventEmitter(); bridge.join = async () => {}; bridge.setRelays = async () => {};
  const make = () => {
    const role = new PayoutRole({ bridge, store, identity: { publicKey: key(payoutSecret), secretKey: payoutSecret }, serviceKey: f.context.venueKey,
      address: f.registry.sellerBond.rewardService.tracAddr, adapter, blockClock: f.blockClock, now: () => 10000 });
    role.stakeRuntime = { request: (_to, method, body) => f.request(method, body) }; return role;
  };
  const role = make(); await role.tick(); assert.equal(role.status().height, null);
  await role.start(); await role.running; role.stop(); assert.equal(bridge.listenerCount('message'), 0);
  await f.setHeight(2); await role.tick(); assert.equal(role.status().poolState, 'empty'); assert.equal(role.status().accounts.length, 0);
  pool = '500000000';
  for (const n of [3, 4, 5]) { await f.setHeight(n); await role.tick(); }
  assert.equal(sent, 1); await make().tick(); assert.equal(sent, 1);
  assert.ok(BigInt(make().store.get(role.service.ledger.name).accounts[f.owner].paidTotal) > 0n);
  assert.equal(role.rewardRead('rewardAudit', { height: 2 }).summary.body.accrued, '0');
  assert.equal(verifyCertificate(role.rewardRead('rewardAudit', { height: 2 }).headCertificate, f.context, 'reward-head').body.height, 2);
  pool = '0'; await role.tick();
  assert.equal(role.status().summary.body.state, 'active', 'the block audit remains immutable');
  assert.equal(role.rewardRead('rewardStatus', { address: f.owner }).rewards.poolBalance, '0');
  assert.equal(role.status().poolState, 'empty', 'live status uses the newest confirmed pool read');
  role.now = () => 10031;
  assert.equal(role.rewardRead('rewardStatus', { address: f.owner }).rewards.poolState, 'unknown');
  assert.equal(role.status().poolBalance, null);
  const readsBeforeReorg = poolReads;
  f.blockClock.hash = async () => h(999);
  await assert.rejects(make().tick(), /chain or epoch/);
  assert.equal(poolReads, readsBeforeReorg, 'a restarted role checks its chain before any payment work');
  await assert.rejects(new PayoutRole({ bridge, store, identity: { publicKey: h(99) }, serviceKey: f.context.venueKey, adapter,
    address: f.registry.sellerBond.rewardService.tracAddr, blockClock: f.blockClock }).tick(), /Signed payout/);
});

test('payout imports certified original-piece awards before sending and never forfeits twice after restart', async () => {
  const f = await fixture(), store = memoryStore(); store.put('registry-current', f.registry);
  const bridge = new EventEmitter(); bridge.join = async () => {}; bridge.setRelays = async () => {};
  let sends = 0;
  const make = () => {
    const role = new PayoutRole({ bridge, store, identity: { publicKey: key(payoutSecret), secretKey: payoutSecret }, serviceKey: f.context.venueKey,
      address: f.registry.sellerBond.rewardService.tracAddr, blockClock: f.blockClock, now: () => 10000,
      adapter: { pool: async () => ({ confirmed: true, RESET: '500000000', TNK: '3', feeTnk: '3' }),
        prepare: async () => { throw Error('Must not prepare forfeited rewards'); }, sendPrepared: async () => { sends++; }, outcome: async () => ({ unknown: true }) } });
    role.stakeRuntime = { request: (_to, method, body) => f.request(method, body) }; return role;
  };
  const role = make(); await role.tick(); await f.setHeight(2); await role.tick();
  const before = role.service.ledger.read().accounts[f.owner].unpaid; assert.ok(BigInt(before) > 0n);
  const cert = (kind, body) => secrets.slice(0, 3).map(secret => signFact({ v: 1, networkId: f.context.networkId, venueKey: f.context.venueKey, epochId: f.context.epoch.id, kind, body }, secret));
  f.setAwards([{ address: f.owner, fundedCertificates: [cert('funded', { unitId: h(9), descriptor: { owner: { tracAddr: f.owner }, purpose: 'seller' } })],
    decisionCertificate: cert('decision', { decisionId: h(80), reservationId: h(81), outcome: 'buyer-no-show', pieces: [{ unitId: h(9), generation: 0 }],
      at: 5000, winnerAddress: tracAddress(h(82)), winnerBoxKey: h(83), evidenceDigest: h(84) }) }]);
  await role.tick(); assert.equal(role.service.ledger.read().accounts[f.owner].unpaid, '0');
  assert.equal(role.service.ledger.read().accounts[f.owner].forfeited, before); assert.equal(sends, 0);
  await make().tick(); assert.equal(role.service.ledger.read().accounts[f.owner].forfeited, before);
  assert.equal(store.get('stake-payout-award-cursor').after, 1);
});

test('live nonempty book checkpoints give covered seller pieces 2x and reject unobserved or enlarged offers', async () => {
  const f = await fixture(), offer = { offerId: h(90), pair: 'RESET/USDC', side: 'sell', baseAmount: '50000', price: '2000', expiresAt: 90000,
    maker: { tracAddr: f.owner, dexKey: h(91) }, registryVersion: 1, software: '0.1.0', peerKey: h(92) };
  f.setOffers([offer]); await f.setHeight(2);
  const block = await f.request('rewardBlock', { height: 2 });
  assert.deepEqual(verifyCertificate(block.bookCertificate, f.context, 'book').body.backing, [{ address: f.owner, unitId: h(9), amount: '25000' }]);
  const { rewardWeights } = await import('../../../src/stake/rewards.js');
  const weights = rewardWeights({ inventory: block.inventoryCertificate[0].fact.body, book: block.bookCertificate[0].fact.body,
    price: block.priceCertificate[0].fact.body, settings: f.registry.sellerBond.economics.active.settings });
  assert.equal(weights[0].weight, '500000000'); assert.equal(weights[0].activeReset, '25000');
  const { verifyObservedOffers } = await import('../../../src/stake/reward-book.js');
  assert.throws(() => verifyObservedOffers([offer], [], 4000), /independently observed/);
  assert.throws(() => verifyObservedOffers([{ ...offer, baseAmount: '50001' }], [offer], 4000), /independently observed/);
  f.setOffers([offer, { ...offer, offerId: h(93) }]); await f.setHeight(3);
  assert.equal(verifyCertificate((await f.request('rewardBlock', { height: 3 })).bookCertificate, f.context, 'book').body.backing.length, 1, 'one piece cannot back two offers twice');
});
