import test from 'node:test';
import assert from 'node:assert/strict';
import { FundingRecovery, fundingReceipts, FUNDING_RECOVERY_PAGE } from '../../../src/stake/funding-recovery.js';
import { admissionFixture } from './admission-helpers.mjs';
import { memoryStore, secrets } from './helpers.mjs';
import { StakeLedger, unitId } from '../../../src/stake/ledger.js';
import { admissionInventory } from '../../../src/stake/admission.js';
import { signFact } from '../../../src/stake/certificates.js';
import { sha256Hex, stableJSON } from '../../../src/core/canonical.js';
import { fundingNonce } from '../../../src/locks/trac-lock.js';
import { tracAddress } from '../core/helpers.mjs';

const hex = n => n.toString(16).padStart(64, '0');
function fixture(count = 1) {
  const f = admissionFixture(), store = memoryStore(), owner = f.terms.seller;
  const ledger = new StakeLedger({ store, context: f.context, address: owner.tracAddr });
  const template = f.ledger.read().pieces[f.id].descriptor;
  for (let i = 0; i < count; i++) {
    const descriptor = { ...template, nonce: hex(100 + i) }, id = unitId(descriptor), address = tracAddress(hex(200 + i));
    const funding = { TNK: hex(300 + i), RESET: hex(400 + i) };
    const certificate = f.cert('funded', { descriptor, unitId: id, address, fundingDigest: sha256Hex(stableJSON(funding)) });
    ledger.admitFunded(certificate, { settings: f.policy.economics.active.settings, price: f.priceReference.q, now: 4000 });
    for (const asset of ['TNK', 'RESET']) store.put(`locks-trac-${sha256Hex(`stake-fund:${id}:${asset}`)}`,
      { asset, from: owner.tracAddr, to: address, amount: asset === 'RESET' ? descriptor.principalReset : descriptor.tnkReserve,
        nonce: fundingNonce(id, asset), txHash: funding[asset], payload: { privateJournalField: 'never sent' } });
  }
  let ms = 0;
  const requests = [];
  const request = async (to, method, body) => {
    requests.push({ to, method, body });
    if (method === 'priceSnapshot') return {};
    if (method === 'admissionInventory') {
      const i = f.context.epoch.members.findIndex(m => m.dexKey === to);
      return signFact({ v: 1, networkId: f.context.networkId, venueKey: f.context.venueKey, epochId: f.context.epoch.id,
        kind: 'admission-inventory', body: admissionInventory(ledger.read(), owner, 4000, f.context.epoch.id) }, secrets[i]);
    }
    if (method === 'fundedRecover') throw Error('old member or stale reader');
    throw Error('Unexpected method');
  };
  const options = { store, registry: () => ({ sellerBond: f.policy }), owner, clock: async () => ({ at: 4000 }), request, now: () => ms };
  return { ...f, store, ledger, owner, options, requests, advance: () => { ms += 60000; } };
}

test('legacy funding journals supply only exact public transfer receipts', () => {
  const f = fixture(), p = Object.values(f.ledger.read().pieces)[0];
  const receipts = fundingReceipts(f.store, p);
  assert.deepEqual(Object.keys(receipts).sort(), ['RESET', 'TNK']);
  assert.equal(sha256Hex(stableJSON(receipts)), p.fundingCertificate[0].fact.body.fundingDigest);
  const name = `locks-trac-${sha256Hex(`stake-fund:${p.unitId}:RESET`)}`, original = f.store.get(name);
  for (const field of ['from', 'to', 'amount', 'nonce', 'txHash']) {
    f.store.put(name, { ...original, [field]: 'invalid' });
    assert.equal(fundingReceipts(f.store, p), null, field);
  }
});

test('funding retry pages rotate beyond unavailable members and rate limits survive restart', async () => {
  const f = fixture(21), seen = new Set();
  for (let i = 0; i < 3; i++) {
    const before = f.requests.length;
    assert.equal(await new FundingRecovery(f.options).tick(), true);
    const page = f.requests.slice(before).filter(r => r.method === 'fundedRecover');
    assert.equal(page.length, FUNDING_RECOVERY_PAGE * 4);
    assert.equal(new Set(page.map(r => r.body.certificate[0].fact.body.unitId)).size, FUNDING_RECOVERY_PAGE);
    page.forEach(r => seen.add(r.body.certificate[0].fact.body.unitId));
    assert.ok(page.every(r => !JSON.stringify(r).includes('privateJournalField')));
    const after = f.requests.length;
    assert.equal(await new FundingRecovery(f.options).tick(), false);
    assert.equal(f.requests.length, after);
    f.advance();
  }
  assert.equal(seen.size, 21);
});

test('funding retry skips confirmed destinations and overlapping rounds', async () => {
  const f = fixture(), oldRequest = f.options.request;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  f.options.request = async (...args) => {
    if (args[1] === 'fundedRecover') { await held; return { funded: true, generation: 0 }; }
    return oldRequest(...args);
  };
  const driver = new FundingRecovery(f.options), pending = driver.tick();
  assert.equal(await driver.tick(), false);
  release(); await pending;
  f.advance(); const before = f.requests.length;
  await new FundingRecovery(f.options).tick();
  assert.equal(f.requests.length, before, 'all confirmed pieces need no further network work');
});

test('generation catch-up requires a fresh free quorum and cannot overwrite local custody', () => {
  for (const conflict of ['reserved', 'withdrawal', 'decision', 'stale', 'two-votes', 'backward', 'disk']) {
    const f = fixture(), p = Object.values(f.ledger.read().pieces)[0];
    const inv = admissionInventory(f.ledger.read(), f.owner, 4000, f.context.epoch.id);
    inv.pieces[0].generation = 2;
    const record = f.ledger.read();
    if (conflict === 'reserved') record.pieces[p.unitId].state = 'reserved';
    if (conflict === 'withdrawal') record.pieces[p.unitId].returnIntent = hex(900);
    if (conflict === 'decision') record.pieces[p.unitId].decisionVote = hex(900);
    if (conflict === 'backward') record.pieces[p.unitId].generation = 3;
    if (conflict === 'stale') inv.at = 3969;
    f.store.put(f.ledger.name, record);
    const before = f.ledger.read();
    let certificate = f.cert('admission-inventory', inv);
    if (conflict === 'two-votes') certificate = certificate.slice(0, 2);
    if (conflict === 'disk') f.store.put = () => { throw Error('disk full'); };
    assert.throws(() => f.ledger.recoverFunded(p.fundingCertificate,
      { settings: f.policy.economics.active.settings, price: f.priceReference.q, now: 4000 }, certificate), undefined, conflict);
    assert.deepEqual(f.ledger.read(), before, conflict);
  }
});
