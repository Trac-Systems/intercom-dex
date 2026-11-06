import test from 'node:test';
import assert from 'node:assert/strict';
import { StakePriceService } from '../../../src/stake/price-service.js';
import { prepareBond, validateBond } from '../../../src/stake/admission.js';
import { signFact } from '../../../src/stake/certificates.js';
import { defaultSettings } from '../../../src/stake/settings.js';
import { memoryStore, registryPolicy, policy, members, secrets } from './helpers.mjs';
import { admissionFixture } from './admission-helpers.mjs';

const h = n => n.toString(16).padStart(64, '0');
test('venue snapshots, deposit readers and signer admission agree across midnight and signed lookback changes', async () => {
  const scope = { networkId: 1, venueKey: members[0].dexKey, epochId: h(300) };
  const registry = { sellerBond: registryPolicy(scope) }, midnight = 86400;
  let now = midnight - 1;
  const common = { registry: () => registry, clock: async () => ({ at: now }) };
  const signers = members.map((m, i) => new StakePriceService({ ...common, store: memoryStore(),
    identity: { publicKey: m.dexKey, secretKey: secrets[i] }, request: (_to, method, body) => venue.handle(method, body, m.dexKey) }));
  const venue = new StakePriceService({ ...common, store: memoryStore(), venue: true,
    identity: { publicKey: scope.venueKey, secretKey: secrets[0] },
    request: (to, method, body) => signers[members.findIndex(m => m.dexKey === to)].handle(method, body, scope.venueKey) });
  const signed = (kind, body) => {
    const fact = { v: 1, networkId: 1, venueKey: scope.venueKey, epochId: scope.epochId, kind, body };
    return { venue: signFact(fact, secrets[0]), certificate: secrets.slice(0, 3).map(s => signFact(fact, s)) };
  };
  for (const [i, quoteAmount] of ['1000000000', '2000000000', '9000000000'].entries()) {
    const position = i + 1;
    venue.log().append(signed('completion', { logPosition: position, prevHash: venue.log().read().hash,
      tradeId: h(position), escrowId: h(position + 10), nonce: h(position + 20), pair: 'RESET/USDC',
      baseAmount: '100000000', quoteAmount, completedAt: now - 2 + i,
      termsDigest: h(40), escrowDigest: h(50), deliveryDigest: h(60) }), now);
  }
  const before = await venue.handle('priceSnapshot', {}, members[1].dexKey);
  now = midnight;
  // Deposit/import callers also accept a still-fresh pre-midnight certificate.
  const reader = new StakePriceService({ ...common, store: memoryStore(),
    request: (_to, method, body) => venue.handle(method, body, members[1].dexKey) });
  assert.deepEqual(await reader.import(before), { numerator: '2000000000', denominator: '1' });
  const snapshot = await venue.handle('priceSnapshot', {}, members[1].dexKey);
  assert.equal(snapshot.reference.utcDay, '1970-01-01');
  assert.equal(snapshot.reference.cutoffAt, midnight);
  for (const signer of signers) assert.deepEqual(await signer.import(snapshot), snapshot.reference.q);
  const f = admissionFixture(), terms = { ...f.terms, sendBy: now + 1000, refundAfter: now + 10000, committee: members };
  const inventory = { ...f.inventory, at: now };
  const args = { terms, policy: registry.sellerBond, context: venue.context(),
    inventoryCertificate: signed('admission-inventory', inventory).certificate,
    priceCheckpoint: snapshot.checkpoint, priceReference: snapshot.reference, priceLog: venue.log(), now };
  const bond = prepareBond(args);
  assert.equal(bond.payoutReset, '25000');
  for (const signer of signers) assert.deepEqual(validateBond({ ...args, terms: { ...terms, bond }, priceLog: signer.log() }), bond);
  const altered = structuredClone(snapshot); altered.reference.q.numerator = '9000000000';
  await assert.rejects(reader.import(altered), /differs/);
  const forged = structuredClone(registry.sellerBond); forged.economics.active.settings.priceLookbackSec = 2592000;
  assert.throws(() => prepareBond({ ...args, policy: forged }), /digest/);

  registry.sellerBond.economics.pending = policy({ ...defaultSettings(), priceLookbackSec: 0 }, now, scope);
  now += 3599;
  const duringNotice = await venue.handle('priceSnapshot', {}, members[1].dexKey);
  assert.deepEqual(await reader.import(duringNotice), snapshot.reference.q);
  now++;
  await assert.rejects(venue.handle('priceSnapshot', {}, members[1].dexKey), /unavailable/);
  await assert.rejects(reader.import(duringNotice), /unavailable/);
  assert.throws(() => prepareBond({ ...args, now, inventoryCertificate: signed('admission-inventory', { ...inventory, at: now }).certificate,
    priceCheckpoint: duringNotice.checkpoint, priceReference: duringNotice.reference }), /unavailable/);
  // A policy with no field has the same explicit no-fallback behavior.
  const legacy = defaultSettings(); delete legacy.priceLookbackSec;
  registry.sellerBond.economics = { active: policy(legacy, 100, scope) };
  await assert.rejects(venue.handle('priceSnapshot', {}, members[1].dexKey), /unavailable/);
});
