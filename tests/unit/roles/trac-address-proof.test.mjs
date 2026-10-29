import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TradeHost } from '../../../src/roles/host.js';
import { MakerFunds } from '../../../src/market/funds.js';
import { offerIdOf, validOffer } from '../../../src/roles/common.js';
import { generateIdentity, encodeKey } from '../../../src/core/keys.js';
import { SellerStrikes } from '../../../src/roles/signer-strikes.js';
import { simulation } from '../core/simulation.mjs';
import { fixture, hex, tracAddress, SOL } from '../core/helpers.mjs';
import { proveParty } from '../core/address-proof-fixture.mjs';

const networkId = 7, now = 101;
const policy = { networkId, now, required: true };
function store() {
  const records = new Map();
  return { put: (k, v) => records.set(k, structuredClone(v)), get: k => structuredClone(records.get(k)),
    list: prefix => [...records.keys()].filter(k => k.startsWith(prefix)) };
}
function attack() {
  const f = fixture();
  // Only the third party's PUBLIC key/address is available to the attacker.
  f.terms.seller.tracAddr = tracAddress('ab'.repeat(32));
  const offer = { pair: 'TNK/USDC', side: 'sell', baseAmount: '123456', price: '1',
    maker: { dexKey: f.terms.seller.dexKey, tracAddr: f.terms.seller.tracAddr, solAddr: SOL },
    peerKey: hex(), expiresAt: 2000, registryVersion: 1, software: '0.1.34' };
  offer.offerId = offerIdOf(offer);
  return { f, offer };
}

test('a valid DEX offer signature/id must not authenticate a third-party Trac address', () => {
  const { offer } = attack();
  assert.equal(validOffer(offer, offer.maker.dexKey, policy), false);
});

test('MakerFunds must reject an unproven rich address, even before its first balance read', () => {
  const { offer } = attack();
  const funds = new MakerFunds({ now: () => now, addressProof: () => policy });
  funds.wallets.set('trac:' + offer.maker.tracAddr, { at: now, failures: 0,
    balances: { TNK: '999999999999999999999999', feeTnk: '3' } });
  assert.equal(funds.funded(offer, { minBaseAmount: '1', base: { id: 'TNK' } }), false);
});

test('a third-party rich address cannot receive the first signer ack', async t => {
  const { f } = attack(), sim = simulation({ fixture: f, holdSellerFunds: true, neverSend: true });
  const state = structuredClone(sim.state('signer1')), bridge = new EventEmitter(), sent = [], reads = [];
  bridge.join = bridge.leave = async () => {};
  bridge.send = async (ch, m) => { sent.push(m); };
  const identity = sim.nodes.get('signer1').identity;
  const host = new TradeHost({ bridge, store: store(), identity: { publicKey: encodeKey(identity.publicKey), secretKey: identity.secretKey },
    profile: { peer: { msbNetworkId: networkId }, mint: state.terms.mint, platformCollector: state.terms.fees.platformCollector },
    addressProofRequired: () => true, now: () => now,
    trac: { balances: async address => { reads.push(address); return { TNK: '999999999999999999999999', feeTnk: '3' }; } } });
  t.after(() => host.stop());
  await host.addTrade({ key: 'attack', state, role: 'signer', lifetimeSec: 90000, outbox: {}, raw: [], buffer: [] });
  await host.deliver('attack', { type: 'resume' });
  for (let i = 0; i < 8; i++) { await new Promise(r => setImmediate(r)); await host.trades.get('attack').queue; }
  assert.equal(sent.filter(m => m.kind === 'ack').length, 0, 'must not promise a share for an unproven seller');
  assert.deepEqual(reads, [], 'proof must precede the balance lookup');
});

test('rotating the DEX identity must not escape strikes on a proven Trac address', () => {
  const strikes = new SellerStrikes({ enabled: true, store: store() }), seller = attack().f.terms.seller;
  strikes.record(seller, hex(), now);
  strikes.record(seller, hex(), now + 1);
  assert.ok(strikes.refusal({ ...seller, dexKey: encodeKey(generateIdentity().publicKey) }, now + 2));
});

async function flush(host) {
  for (let i = 0; i < 8; i++) { await new Promise(r => setImmediate(r)); await Promise.all([...host.trades.values()].map(t => t.queue)); }
}
function hostFixture(t, { proven = true, disk = store(), balances, required = () => true } = {}) {
  const f = fixture();
  if (proven) for (const role of ['seller', 'buyer']) f.terms[role] = proveParty(f.terms[role], { expiresAt: f.terms.sendBy });
  const sim = simulation({ fixture: f, networkId, holdSellerFunds: true }), state = sim.state('signer1');
  const bridge = new EventEmitter(), sent = [], identity = sim.nodes.get('signer1').identity;
  bridge.join = bridge.leave = async () => {};
  bridge.send = async (ch, m) => sent.push(m);
  const options = { bridge, store: disk, identity: { publicKey: encodeKey(identity.publicKey), secretKey: identity.secretKey },
    profile: { peer: { msbNetworkId: networkId }, mint: state.terms.mint, platformCollector: state.terms.fees.platformCollector },
    now: () => now, addressProofRequired: required, trac: { balances: balances ?? (async () => ({ TNK: '999999999999999999999999', feeTnk: '3' })) } };
  const host = new TradeHost(options); t.after(() => host.stop());
  return { host, state, options, sent, disk,
    record: { key: 'test', state, role: 'signer', lifetimeSec: 90000, outbox: {}, raw: [], buffer: [] } };
}

test('honest proof authorizes a durable ack; restart preserves the promise without a new funds read', async t => {
  const f = hostFixture(t);
  await f.host.addTrade(f.record); await f.host.deliver('test', { type: 'resume' }); await flush(f.host);
  assert.equal(f.sent.filter(m => m.kind === 'ack').length, 1);
  assert.equal(f.disk.get('trade-test').state.sellerAddressProven, true);
  f.host.stop();
  const restarted = new TradeHost({ ...f.options, now: () => f.state.terms.sendBy + 1,
    trac: { balances: () => assert.fail('do not reread a committed balance') } });
  t.after(() => restarted.stop());
  await restarted.start(); await flush(restarted);
  assert.equal(f.sent.filter(m => m.kind === 'ack').length, 2);
  assert.equal(restarted.trades.get('test').state.phase, 'holding', 'expired ownership proof cannot revoke an existing promise');
});

test('legacy committed trades still serve after activation, but cannot strike an unproven address', async t => {
  let active = false;
  const f = hostFixture(t, { proven: false, required: () => active });
  await f.host.addTrade(f.record); await f.host.deliver('test', { type: 'resume' }); await flush(f.host);
  assert.equal(f.sent.filter(m => m.kind === 'ack').length, 1);
  assert.equal(f.disk.get('trade-test').state.sellerAddressProven, false);
  active = true; f.host.stop();
  const restarted = new TradeHost({ ...f.options, trac: { balances: () => assert.fail('already committed') } });
  t.after(() => restarted.stop());
  await restarted.start(); await flush(restarted);
  assert.equal(f.sent.filter(m => m.kind === 'ack').length, 2);
});

test('activation while a legacy balance read is pending cannot authorize its result', async t => {
  let active = false, resolve, reads = 0;
  const f = hostFixture(t, { proven: false, required: () => active,
    balances: () => { reads++; return new Promise(r => { resolve = r; }); } });
  await f.host.addTrade(f.record); await f.host.deliver('test', { type: 'resume' });
  assert.equal(reads, 1); active = true;
  resolve({ TNK: '999999999999999999999999', feeTnk: '3' }); await flush(f.host);
  assert.equal(f.sent.filter(m => m.kind === 'ack').length, 0);
  assert.equal(f.disk.get('trade-test').state.phase, 'checkingSellerFunds');
});

test('restart with a stored pre-activation pending trade rechecks the current policy', async t => {
  const f = hostFixture(t, { proven: false, balances: () => assert.fail('unproven address must not be queried') });
  f.disk.put('trade-test', f.record);
  await f.host.start(); await flush(f.host);
  assert.equal(f.sent.filter(m => m.kind === 'ack').length, 0);
});

test('invalid buyer proof and proofs expiring before sendBy cannot reach seller balances', async t => {
  for (const role of ['buyer', 'seller']) {
    const f = hostFixture(t, { balances: () => assert.fail('invalid proof must precede balances') });
    f.record.state.terms[role].tracProof.expiresAt = 102;
    await f.host.addTrade(f.record); await f.host.deliver('test', { type: 'resume' }); await flush(f.host);
    assert.equal(f.sent.filter(m => m.kind === 'ack').length, 0);
  }
});

test('MakerFunds rejects missing/forged proofs on both sides and never reads their balances', async () => {
  const { offer } = attack(), reads = [];
  const funds = new MakerFunds({ now: () => now, addressProof: () => policy,
    trac: { balances: async address => reads.push(address) }, solana: { walletBalances: async address => reads.push(address) } });
  for (const side of ['sell', 'buy']) {
    const o = { ...offer, side };
    assert.equal(funds.funded(o, { minBaseAmount: '1', base: { id: 'TNK' } }), false);
    funds.refresh([o]); assert.equal(funds.balances(o), null);
  }
  await new Promise(r => setImmediate(r)); assert.deepEqual(reads, []);
  const valid = { ...offer, maker: proveParty(offer.maker) };
  assert.equal(funds.funded(valid, { minBaseAmount: '1', base: { id: 'TNK' } }), true, 'unknown balance remains available for a proven maker');
});

test('legacy ledger entries cannot poison a proven address; clear spans all rotated identities', () => {
  const disk = store(), seller = attack().f.terms.seller;
  disk.put('seller-strikes', { strikes: [{ ...seller, tradeId: 'old-a', at: now }],
    refusals: [{ ...seller, until: now + 1000, tradeIds: ['old-a', 'old-b'] }] });
  const strikes = new SellerStrikes({ enabled: true, store: disk });
  assert.deepEqual(strikes.list(now), { strikes: [], refusals: [] });
  strikes.record(seller, 'a', now); strikes.record({ ...seller, dexKey: hex() }, 'b', now + 1);
  const rotated = { ...seller, tracAddr: seller.tracAddr.toUpperCase(), dexKey: hex() };
  assert.ok(strikes.refusal(rotated, now + 2));
  assert.deepEqual(strikes.clear(rotated, now + 2), { cleared: true, strikes: 2, refusals: 1 });
});
