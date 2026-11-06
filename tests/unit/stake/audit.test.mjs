import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { auditRewardBlock } from '../../../src/stake/audit.js';
import { RewardLedger } from '../../../src/stake/rewards.js';
import { signFact } from '../../../src/stake/certificates.js';
import { defaultSettings } from '../../../src/stake/settings.js';
import { bytesToHex, stableJSON, utf8 } from '../../../src/core/canonical.js';
import { registryPolicy, secrets, memoryStore } from './helpers.mjs';
import { tracAddress } from '../core/helpers.mjs';
const h = n => n.toString(16).padStart(64, '0');
function fixture(poolBalance = '500000000', noWeight = false) {
  const context = { networkId: 1, venueKey: h(1), epoch: registryPolicy().epoch }, settings = defaultSettings();
  const secretKey = new Uint8Array(32).fill(9), payoutKey = bytesToHex(ed25519.getPublicKey(secretKey));
  const block = { height: 1, blockHash: h(2), previousHash: h(3), at: 100 };
  const head = { height: block.height, blockHash: block.blockHash }, address = tracAddress(h(4));
  const certificate = (kind, body) => secrets.slice(0, 3).map(secret => signFact({ v: 1, networkId: 1, venueKey: context.venueKey,
    epochId: context.epoch.id, kind, body }, secret));
  const inventoryCertificate = certificate('inventory', { ...head, accounts: [{ address, pieces: noWeight ? [] :
    [{ unitId: h(5), generation: 0, principalReset: '100000000', purpose: 'buyer', state: 'free' }] }] });
  const bookCertificate = certificate('book', { ...head, backing: [] }),
    priceCertificate = certificate('price', { ...head, price: { numerator: '20000000', denominator: '1' } });
  const input = { block, settings, poolBalance, inventoryCertificate, bookCertificate, priceCertificate };
  const ledger = new RewardLedger({ context, identity: { secretKey }, store: memoryStore() });
  const summary = ledger.accrue({ ...block, settings, poolBalance, inventoryCertificate, bookCertificate, priceCertificate });
  const resign = body => ({ body, from: payoutKey, sig: bytesToHex(ed25519.sign(utf8('intercom-dex/rewards/v1/summary\n' + stableJSON(body)), secretKey)) });
  return { ...input, context, payoutKey, unpaidBefore: '0', summary, resign };
}

test('public audit reproduces active, empty and zero-weight blocks without a payout signing key', () => {
  for (const f of [fixture(), fixture('0'), fixture('500000000', true)]) {
    assert.deepEqual(auditRewardBlock(f), f.summary.body);
    assert.notEqual(auditRewardBlock(f), f.summary.body);
  }
});

test('a valid publisher signature cannot hide altered allocation, facts, liabilities or policy', () => {
  const f = fixture();
  const changed = structuredClone(f.summary.body); changed.allocations[0].amount = '1';
  assert.throws(() => auditRewardBlock({ ...f, summary: f.resign(changed) }), /differs/);
  for (const override of [{ unpaidBefore: '500000000' }, { poolBalance: '0' },
    { block: { ...f.block, at: 101 } }, { block: { ...f.block, previousHash: h(99) } },
    { settings: { ...f.settings, rewards: { ...f.settings.rewards, dailyReset: '1' } } }]) {
    assert.throws(() => auditRewardBlock({ ...f, ...override }), /differs/);
  }
  assert.throws(() => auditRewardBlock({ ...f, payoutKey: h(98) }), /signature/);
  assert.throws(() => auditRewardBlock({ ...f, context: { ...f.context, networkId: 2 } }), /certificate/);
  assert.throws(() => auditRewardBlock({ ...f, inventoryCertificate: f.inventoryCertificate.slice(0, 2) }), /three/);
  assert.throws(() => auditRewardBlock({ ...f, unpaidBefore: '-1' }));
  assert.throws(() => auditRewardBlock({ ...f, block: { ...f.block, blockHash: h(99) } }), /block/);
});
