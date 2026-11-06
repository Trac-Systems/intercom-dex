// Offline reward paging load row. Real wire codecs, PoW, rate buckets, signatures
// and relay paths run on memory streams; there are no sockets or chain servers.
// PG1_OLD_REPO points to an untouched local v0.1.48 archive with dependency links.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stakeNetwork, identity, turn } from '../fixtures/stake-network.mjs';
import { StakeTransport, STAKE_CHANNEL } from '../../src/stake/transport.js';
import { STAKE_PAYOUT_RATE } from '../../src/stake/paging.js';
import { RewardCheckpoints } from '../../src/stake/reward-checkpoints.js';
import { rewardWeights, RewardLedger } from '../../src/stake/rewards.js';
import { memoryStore, registryPolicy } from '../unit/stake/helpers.mjs';
import { tracAddress, fixture as tradeFixture } from '../unit/core/helpers.mjs';
import { stakeContext } from '../../src/stake/price-service.js';
import { verifyCertificate, factDigest } from '../../src/stake/certificates.js';
import { sha256Hex, stableJSON } from '../../src/core/canonical.js';
import { DEX_POW_BITS } from '../../peer/features/dex-transport.js';
import { powWorker } from '../../peer/features/sidechannel/pow-client.js';

const oldRepo = process.env.PG1_OLD_REPO;
if (!oldRepo || JSON.parse(readFileSync(path.join(oldRepo, 'package.json'))).version !== '0.1.48') throw Error('PG1_OLD_REPO must be an untouched local v0.1.48 archive');
const { default: LegacySidechannel } = await import(pathToFileURL(path.join(oldRepo, 'peer/features/sidechannel/index.js')));
const { dexTransport: legacyDexTransport } = await import(pathToFileURL(path.join(oldRepo, 'peer/features/dex-transport.js')));
const { RewardCheckpoints: LegacyCheckpoints } = await import(pathToFileURL(path.join(oldRepo, 'src/stake/reward-checkpoints.js')));
const { StakeTransport: LegacyTransport } = await import(pathToFileURL(path.join(oldRepo, 'src/stake/transport.js')));
const pieces = Number(process.env.PG1_PIECES ?? 2000), offerCount = Number(process.env.PG1_OFFERS ?? 1000);
const baseline = process.env.PG1_BASELINE === '1', oldMember = process.env.PG1_OLD_MEMBER === '1', publicLoad = process.env.PG1_PUBLIC_LOAD === '1';
if (!Number.isSafeInteger(pieces) || pieces < 1 || pieces > 5000 || !Number.isSafeInteger(offerCount) || offerCount < 1 || offerCount > Math.min(pieces, 1000))
  throw Error('Use 1..5000 pieces and 1..min(pieces,1000) offers');
const started = performance.now(), at = () => Math.floor(Date.now() / 1000), h = n => sha256Hex(String(n));
const net = stakeNetwork({ pow: process.env.PG1_NO_POW !== '1', legacySidechannel: LegacySidechannel, legacyDexTransport });
const venue = net.node(identity(8), 'service', { legacy: baseline }), signers = [1, 2, 3, 4].map(n => net.node(identity(n), 'signer', { legacy: baseline || oldMember && n === 4 })),
  payout = net.node(identity(9), 'payout', { legacy: baseline }), trader = net.node(identity(10), 'trader', { legacy: true }), feed = net.node(identity(11), 'market-feed', { legacy: true });
const policy = registryPolicy({ networkId: 1, venueKey: venue.identity.publicKey, epochId: h('epoch') });
policy.rewardService = { dexKey: payout.identity.publicKey, tracAddr: tracAddress(h('pool')) };
const registry = { ...tradeFixture().registry, sellerBond: policy }, context = stakeContext(registry);
const accounts = Array.from({ length: offerCount }, (_, n) => tracAddress(h(`account-${n}`)));
const offers = accounts.map((owner, n) => ({ offerId: h(`offer-${n}`), pair: 'RESET/USDC', side: 'sell', baseAmount: '50000', price: '2000', expiresAt: at() + 3600,
  maker: { tracAddr: owner, dexKey: h(`maker-${n}`) }, registryVersion: 1, software: '0.1.48', peerKey: h(`peer-${n}`) }));
const ledger = { pieces: Object.fromEntries(Array.from({ length: pieces }, (_, n) => [h(`piece-${n}`), { unitId: h(`piece-${n}`), generation: 0, state: 'free',
  descriptor: { networkId: 1, venueKey: context.venueKey, epochId: context.epoch.id, owner: { tracAddr: accounts[n % accounts.length] }, principalReset: '25000', purpose: 'seller' } }])) };
let height = 0, captureAt;
const clock = async () => ({ at: at() }), blockClock = { counted: async () => height, hash: async n => h(`block-${n}`) };
const priceValue = { numerator: '2000000000', denominator: '1' }, price = { handle: async () => ({}), import: async () => priceValue };
const allowPagingPeer = key => [venue, ...signers, payout].some(n => n.identity.publicKey === key);
const voteAt = [], errors = [], allTransports = [], logical = [];
function transport(n, handle) {
  const Transport = baseline || oldMember && n === signers[3] ? LegacyTransport : StakeTransport;
  const result = new Transport({ bridge: n.bridge, identity: n.identity, handle, allowPagingPeer,
    pageRate: to => to === payout.identity.publicKey ? STAKE_PAYOUT_RATE : 0 });
  // Record logical sizes before compression and signatures, without retaining bodies.
  const send = result.send.bind(result);
  result.send = input => { logical.push({ method: input.method, kind: input.kind, bytes: Buffer.byteLength(stableJSON(input.body)) }); return send(input); };
  allTransports.push(result); return result;
}
const checkpoint = n => {
  n.store = memoryStore(); if (n !== venue) n.store.put('stake-ledger-scale', ledger);
  return new (baseline || oldMember && n === signers[3] ? LegacyCheckpoints : RewardCheckpoints)({ store: n.store, identity: n.identity, registry: () => registry, clock, blockClock, price,
    venue: n === venue, offers: () => offers, balances: async () => ({ RESET: '1000000000', TNK: '1000000000', feeTnk: '1' }),
    request: (to, method, body) => n.transport.request(to, method, body) });
};
for (const n of [venue, ...signers]) {
  n.checkpoint = checkpoint(n);
  n.transport = transport(n, async (method, body, from) => {
    if (method === 'status' || method === 'admissionInventory') return body;
    if (method === 'rewardVote') voteAt.push({ signer: n.identity.publicKey, ageSec: at() - body.at });
    try {
      return await n.checkpoint.handle(method, body, from);
    } catch (e) { errors.push({ method, error: e.message }); throw e; }
  });
}
payout.transport = transport(payout, async () => ({}));
const legacy = new LegacyTransport({ bridge: trader.bridge, identity: trader.identity }); allTransports.push(legacy);
const inbound = n => n.bandwidth.filter(r => r.ch === STAKE_CHANNEL && r.direction === 'received').reduce((sum, r) => sum + r.bytes, 0);
let before, publicBefore, frameStart, logicalStart, begin, background;
const result = { baseline, oldMember, publicLoad, payoutPageRate: STAKE_PAYOUT_RATE, pieces, offers: offerCount, mode: 'real-checkpoint', powBits: process.env.PG1_NO_POW === '1' ? 0 : DEX_POW_BITS,
  releasedTrader: '0.1.48', captureToleranceSec: 15, voteFreshnessSec: 60 };
try {
  for (const n of [...signers, payout, trader, feed]) await net.connect(venue, n);
  for (const t of allTransports) await t.start();
  for (const n of [...signers, payout]) await n.transport.request(venue.identity.publicKey, 'status');
  assert.deepEqual(await legacy.request(signers[0].identity.publicKey, 'admissionInventory', { legacy: 'before' }), { legacy: 'before' });
  await Promise.all([venue, ...signers].map(n => n.checkpoint.observe()));
  if (publicLoad) {
    await venue.sc.broadcast('intercom-dex', { kind: 'background', data: 'x'.repeat(180000) });
    background = setInterval(() => { void venue.sc.broadcast('intercom-dex', { kind: 'background', data: 'x'.repeat(6400) }); }, 200);
  }
  height = 1; captureAt = at(); await Promise.all([venue, ...signers].map(n => n.checkpoint.observe()));
  before = [trader, feed].map(inbound); publicBefore = venue.sc.publicSend.stats(); frameStart = net.frames.length; logicalStart = logical.length; begin = performance.now();
  const archive = await payout.transport.request(venue.identity.publicKey, 'rewardBlock', { height }, 60000);
  result.checkpointMs = Math.round(performance.now() - begin); assert.ok(result.checkpointMs < 60000);
  for (const kind of ['inventory', 'book', 'price']) assert.equal(verifyCertificate(archive.headCertificate, context, 'reward-head').body[kind + 'Digest'], factDigest(verifyCertificate(archive[kind + 'Certificate'], context, kind)));
  const inventory = verifyCertificate(archive.inventoryCertificate, context, 'inventory').body;
  assert.equal(inventory.accounts.reduce((sum, a) => sum + a.pieces.length, 0), pieces);
  const weightInput = { inventory, book: archive.bookCertificate[0].fact.body, price: archive.priceCertificate[0].fact.body, settings: policy.economics.active.settings };
  {
    assert.equal(rewardWeights(weightInput).length, accounts.length);
    const ledger = new RewardLedger({ store: memoryStore(), context, identity: payout.identity });
    const summary = ledger.accrue({ ...archive, settings: policy.economics.active.settings, poolBalance: '500000000' });
    assert.equal(summary.body.state, 'active'); result.accruedReset = summary.body.accrued; result.rewardAccounts = summary.body.weights.length;
  }
  assert.ok(voteAt.length >= 3 && voteAt.every(v => v.ageSec <= 60));
  assert.ok([venue, ...signers].every(n => Math.abs(n.store.get(`stake-reward-capture-${context.epoch.id}-1`).at - captureAt) <= 15));
  await turn();
  result.traderRewardInboundBytes = inbound(trader) - before[0]; result.feedRewardInboundBytes = inbound(feed) - before[1];
  if (!baseline) { assert.equal(result.traderRewardInboundBytes, 0); assert.equal(result.feedRewardInboundBytes, 0);
    if (!publicLoad) assert.deepEqual(venue.sc.publicSend.stats(), publicBefore); }
  const frames = net.frames.slice(frameStart).map(row => row.message);
  result.messages = frames.length; result.manifests = frames.filter(m => m.kind === 'stakeManifest').length; result.pages = frames.filter(m => m.kind === 'stakePage').length;
  result.wireStakeBytes = frames.reduce((sum, m) => sum + Buffer.byteLength(stableJSON(m)), 0);
  result.maxStakeBytes = Math.max(...frames.map(m => Buffer.byteLength(stableJSON(m))));
  result.maxSidechannelBytes = Math.max(...net.nodes.flatMap(n => n.bandwidth.filter(r => r.ch === STAKE_CHANNEL).map(r => r.bytes)));
  result.manifestBodies = frames.filter(m => m.kind === 'stakeManifest').map(m => ({ method: m.method, kind: m.body.kind, rawBytes: m.body.rawBytes, compressedBytes: m.body.bytes, pages: m.body.pages }));
  result.logical = logical.slice(logicalStart); result.voteAgesSec = voteAt.map(v => v.ageSec);
  assert.ok(result.maxStakeBytes <= 180000 && result.maxSidechannelBytes <= 200000);
  for (const n of net.nodes) for (const connection of n.sc.connections.keys()) assert.equal(n.sc._isBlocked(connection), false, 'existing rate bucket remains unblocked');
  assert.deepEqual(await legacy.request(signers[0].identity.publicKey, 'admissionInventory', { legacy: 'after' }), { legacy: 'after' });
  result.rateDrops = net.nodes.map(n => n.sc.rateDrops); assert.ok(result.rateDrops.every(n => n === 0));
  result.ok = true;
} catch (error) { result.ok = false; result.error = error.message; process.exitCode = 1; }
finally {
  if (before && result.traderRewardInboundBytes === undefined) { result.traderRewardInboundBytes = inbound(trader) - before[0]; result.feedRewardInboundBytes = inbound(feed) - before[1]; }
  result.elapsedMs = Math.round(performance.now() - started); result.errors = errors;
  clearInterval(background); allTransports.forEach(t => t.stop()); await net.close(); await powWorker.close();
  if (process.env.PG1_OUTPUT) writeFileSync(process.env.PG1_OUTPUT, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
