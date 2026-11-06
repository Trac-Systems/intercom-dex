import { defaultSettings, policyId, publicationBytes } from '../../../src/stake/settings.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { StakePriceService } from '../../../src/stake/price-service.js';
import { fixture, hex } from '../core/helpers.mjs';
import { proveParty } from '../core/address-proof-fixture.mjs';
import { encodeKey } from '../../../src/core/keys.js';
import { selectCommittee } from '../../../src/core/committee.js';
import { tradeId } from '../../../src/core/terms.js';
import { seal } from '../../../src/core/envelope.js';
import { memoryStore } from './helpers.mjs';
import { signFact } from '../../../src/stake/certificates.js';

test('venue price index verifies final legs, retains completion time and rejects equivocation after restart', async () => {
  const f = fixture({ n: 4, pair: 'RESET/USDC' }), venueKey = encodeKey(f.service.publicKey), epochId = hex();
  const settings = defaultSettings(), publishedAt = 0;
  f.registry.sellerBond = { protocol: 1, acceptNew: true, enforceAfter: 100000, networkId: 7, venueKey,
    economics: { active: { policyId: policyId(settings), settings, publishedAt, effectiveAt: 3600,
      receipts: f.signers.slice(0, 3).map(s => ({ from: encodeKey(s.identity.publicKey), at: publishedAt,
        sig: Buffer.from(ed25519.sign(publicationBytes(policyId(settings), publishedAt, { networkId: 7, venueKey, epochId }), s.identity.secretKey)).toString('hex') })) } },
    epoch: { id: epochId, n: 4, k: 3, maxFaulty: 1, startAt: 0,
    members: f.registry.signers.map(({ dexKey, boxKey }) => ({ dexKey, boxKey })) } };
  const terms = { ...f.terms, buyer: proveParty(f.terms.buyer), seller: proveParty(f.terms.seller) };
  terms.committee = selectCommittee(f.registry, terms.R, { n: 4, k: 3, quoteAmount: terms.quoteAmount, pair: terms.pair,
    exclude: [terms.buyer.dexKey, terms.seller.dexKey] }).map(({ dexKey, boxKey }) => ({ dexKey, boxKey }));
  const id = tradeId(terms), summon = { tradeId: id, terms, sigs: [f.buyer, f.seller].map(identity => seal({ kind: 'termsSig',
    ch: `intercom-dex:t:${id}`, body: { tradeId: id } }, identity.secretKey, { ts: 100, nonce: hex() })) };
  let now = 1100, transferFinal = true, claimed = true;
  const stores = f.signers.map(memoryStore), venueStore = memoryStore();
  const common = { registry: () => f.registry, snapshot: () => f.registry, clock: async () => ({ at: now }),
    solana: { checkEscrow: async () => ({ ok: true, status: claimed ? 'claimed' : 'active' }) },
    trac: { verifyTransfer: async () => ({ ok: true, final: transferFinal }) },
    request: (to, method, body) => venue().handle(method, body, venueKey) };
  const signer = i => new StakePriceService({ ...common, store: stores[i], identity: {
    publicKey: encodeKey(f.signers[i].identity.publicKey), secretKey: f.signers[i].identity.secretKey } });
  let signers = f.signers.map((_, i) => signer(i));
  const venue = () => new StakePriceService({ ...common, store: venueStore, identity: { publicKey: venueKey, secretKey: f.service.secretKey },
    venue: true, request: (to, method, body) => signers[f.registry.signers.findIndex(s => s.dexKey === to)].handle(method, body, venueKey) });
  const report = { terms, hashHex: hex(), txHash: hex() };
  transferFinal = false;
  await assert.rejects(venue().observe(report, summon), /Three/);
  assert.equal(venue().log().read().position, 0);
  transferFinal = true; now += 1;
  await venue().observe(report, summon);
  const first = venue().log().entry(1);
  assert.equal(first.entry.completedAt, 1100);
  now += 5; signers = f.signers.map((_, i) => signer(i));
  await venue().observe(report, summon); assert.equal(venue().log().read().position, 1);
  const snapshot = await venue().handle('priceSnapshot', {}, terms.buyer.dexKey);
  const sharedVenue = venue(), originalRequest = sharedVenue.request;
  let headReads = 0, unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  sharedVenue.request = async (...args) => { if (args[1] === 'priceHeadVote') { headReads++; await blocked; } return originalRequest(...args); };
  const overlapping = Array.from({ length: 12 }, () => sharedVenue.handle('priceSnapshot', {}, terms.buyer.dexKey));
  unblock(); const snapshots = await Promise.all(overlapping);
  assert.equal(headReads, 4, 'overlapping readers share one original signer round');
  assert.ok(snapshots.every(s => JSON.stringify(s) === JSON.stringify(snapshots[0])));
  now++;
  await sharedVenue.handle('priceSnapshot', {}, terms.buyer.dexKey);
  assert.equal(headReads, 8, 'a completed response is not reused as a fresh price head');
  sharedVenue.request = async () => { throw Error('reader offline'); };
  await assert.rejects(sharedVenue.handle('priceSnapshot', {}, terms.buyer.dexKey), /Three/);
  sharedVenue.request = originalRequest;
  await sharedVenue.handle('priceSnapshot', {}, terms.buyer.dexKey);
  const reader = new StakePriceService({ ...common, store: memoryStore() });
  assert.deepEqual(await reader.import(snapshot), snapshot.reference.q);
  const conflicting = signFact({ ...first.venue.fact, body: { ...first.entry, completedAt: 1101 } }, f.service.secretKey);
  await assert.rejects(signers[0].handle('priceVote', { venue: conflicting, report, summon }, venueKey), /Conflicting/);
  // Populate a certified synthetic prefix to exercise real pagination and an
  // offline member's catch-up; final-leg verification is exercised above.
  now = 1500;
  for (let position = 2; position <= 101; position++) {
    const head = venue().log().read();
    const fact = { ...first.venue.fact, body: { ...first.entry, logPosition: position, prevHash: head.hash,
      tradeId: hex(), escrowId: hex(), nonce: hex(), completedAt: 1100 + position } };
    venue().log().append({ venue: signFact(fact, f.service.secretKey),
      certificate: f.signers.slice(0, 3).map(s => signFact(fact, s.identity.secretKey)) }, now);
  }
  const paged = await venue().handle('priceSnapshot', {}, terms.buyer.dexKey);
  assert.equal(paged.entries.length, 12); assert.equal(paged.reference.dayCount, 101);
  assert.equal(signers[0].log().read().position, 101, 'offline signers recover missing committed pages before voting');
  const freshReader = new StakePriceService({ ...common, store: memoryStore() });
  assert.deepEqual(await freshReader.import(paged), paged.reference.q);
  assert.equal(freshReader.log().read().position, 101);
  await assert.rejects(venue().handle('pricePrefix', { from: 1, limit: 13 }, venueKey), /Invalid/);
  const freshSigner = new StakePriceService({ ...common, store: memoryStore(), identity: { secretKey: f.signers[0].identity.secretKey } });
  now = 90000;
  await assert.rejects(freshSigner.handle('priceVote', { venue: first.venue, report, summon }, venueKey), /Stale/);
  await assert.rejects(reader.import(snapshot), /unavailable/);
});
