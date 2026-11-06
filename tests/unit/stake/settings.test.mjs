import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, settingsSchema, stakeRegistrySchema, effectiveSettings, validatePolicyTransition, earlierActivationNotice, policyId, publicationBytes, proofClockSettings } from '../../../src/stake/settings.js';
import { registryPolicy, policy, memoryStore } from './helpers.mjs';

test('SB4 defaults use exact base units and are fresh copies', () => {
  const s = defaultSettings();
  assert.equal(s.penaltyBps, 300); assert.equal(s.minPenaltyUsd, '500000');
  assert.equal(s.priceLookbackSec, 604800);
  assert.deepEqual(s.stake, { withdrawDelaySec: 86400, suggestBufferBps: 15000, maxUsdPerAddress: '10000000000' });
  assert.deepEqual(s.rewards, { dailyReset: '500000000', activeWeightBps: 20000, payoutMinReset: '10000000', payoutIntervalSec: 604800 });
  s.stake.withdrawDelaySec = 0; assert.equal(defaultSettings().stake.withdrawDelaySec, 86400);
});

test('all numeric settings enforce inclusive app bounds and strict fields', () => {
  for (const [path, low, high] of [ ['penaltyBps', 50, 1000], ['minPenaltyUsd', '50000', '5000000'],
    ['admissionFreshSec', 60, 600], ['priceLookbackSec', 0, 2592000], ['randomnessWaitSec', 120, 600], ['overdueDelaySec', 300, 21600], ['proofWindowSec', 3600, 259200], ['stake.withdrawDelaySec', 3600, 604800],
    ['proofClock.sampleGapSec', 15, 120], ['proofClock.sampleFreshSec', 15, 180], ['proofClock.checkpointFreshSec', 30, 300],
    ['stake.suggestBufferBps', 10000, 30000], ['stake.maxUsdPerAddress', '500000', '1000000000000'],
    ['rewards.dailyReset', '0', '100000000000'], ['rewards.activeWeightBps', 10000, 50000],
    ['rewards.payoutMinReset', '1', '10000000000'], ['rewards.payoutIntervalSec', 3600, 2592000] ]) {
    const check = v => { const s = defaultSettings(), bits = path.split('.'); (bits.length === 2 ? s[bits[0]] : s)[bits.at(-1)] = v; return settingsSchema.safeParse(s).success; };
    assert.ok(check(low), path); assert.ok(check(high), path);
    assert.equal(check(typeof low === 'string' ? String(BigInt(low) - 1n) : low - 1), false, path);
    assert.equal(check(typeof high === 'string' ? String(BigInt(high) + 1n) : high + 1), false, path);
  }
  assert.equal(settingsSchema.safeParse({ ...defaultSettings(), rate: 300 }).success, false);
  assert.throws(() => policyId({})); assert.throws(() => publicationBytes('bad', 1));
});

test('proof timing stays bound to original signed economics and legacy hashes are preserved', () => {
  const r = registryPolicy(), terms = { bond: { policyId: r.economics.active.policyId } };
  assert.deepEqual(proofClockSettings(r, terms), { sampleGapSec: 60, sampleFreshSec: 90, checkpointFreshSec: 180 });
  r.economics.pending = policy({ ...defaultSettings(), proofClock: { sampleGapSec: 120, sampleFreshSec: 180, checkpointFreshSec: 300 } }, 4000);
  assert.equal(proofClockSettings(r, terms).sampleGapSec, 60);
  assert.throws(() => proofClockSettings(r, { bond: { policyId: 'f'.repeat(64) } }), /Original/);
  const legacy = defaultSettings(); delete legacy.proofClock; delete legacy.admissionFreshSec;
  r.economics.active = policy(legacy);
  assert.deepEqual(stakeRegistrySchema.parse(r).economics.active.settings, legacy);
  assert.deepEqual(proofClockSettings(r, { bond: { policyId: r.economics.active.policyId } }),
    { sampleGapSec: 15, sampleFreshSec: 15, checkpointFreshSec: 30 });
});

test('one hour signed publication switches exactly at its boundary', () => {
  const r = registryPolicy(); r.economics.pending = policy({ ...defaultSettings(), penaltyBps: 400 }, 4000);
  assert.equal(effectiveSettings(r, 3699), null);
  assert.equal(effectiveSettings(r, 7599).settings.penaltyBps, 300);
  assert.equal(effectiveSettings(r, 7600).settings.penaltyBps, 400);
  assert.throws(() => effectiveSettings(r, -1));
  for (const mutate of [ r => r.economics.active.effectiveAt--,
    r => r.economics.active.settings.penaltyBps++, r => r.economics.active.receipts[0].sig = '0'.repeat(128),
    r => r.economics.active.receipts[0] = r.economics.active.receipts[1], r => r.epoch.members.pop(),
    r => r.epoch.k = 2, r => r.epoch.members[0] = r.epoch.members[1] ]) {
    const copy = structuredClone(r); mutate(copy); assert.equal(stakeRegistrySchema.safeParse(copy).success, false);
  }
});

test('historical price lookback needs a signed policy and a full hour of notice', () => {
  const legacy = defaultSettings(); delete legacy.priceLookbackSec;
  const r = registryPolicy(); r.economics.active = policy(legacy);
  assert.deepEqual(stakeRegistrySchema.parse(r).economics.active.settings, legacy);
  assert.equal(policyId(legacy), r.economics.active.policyId, 'parsing does not add a default to historical signed content');
  r.economics.pending = policy(defaultSettings(), 4000);
  assert.equal(effectiveSettings(r, 7599).settings.priceLookbackSec, undefined);
  assert.equal(effectiveSettings(r, 7600).settings.priceLookbackSec, 604800);
  const changed = structuredClone(r); changed.economics.pending.settings.priceLookbackSec++;
  assert.throws(() => effectiveSettings(changed, 7600), /digest/);
  changed.economics.pending.policyId = policyId(changed.economics.pending.settings);
  assert.throws(() => effectiveSettings(changed, 7600), /receipt/);
});

test('publication receipts bind the venue, network and epoch and cannot be transplanted', async () => {
  const r = registryPolicy();
  for (const replacement of [{ ...r, networkId: 2 }, { ...r, venueKey: '9'.repeat(64) },
    { ...r, epoch: { ...r.epoch, id: 'b'.repeat(64) } }]) {
    assert.equal(stakeRegistrySchema.safeParse(replacement).success, false);
  }
  assert.throws(() => publicationBytes(r.economics.active.policyId, 100), /Invalid input/);
  const differentNetwork = registryPolicy({ networkId: 2, venueKey: r.venueKey, epochId: r.epoch.id });
  assert.throws(() => validatePolicyTransition(r, differentNetwork, 4000), /scope/);
  const { checkProfileRegistry } = await import('../../../src/net/profile-core.js');
  assert.doesNotThrow(() => checkProfileRegistry({ sellerBond: r }, { peer: { msbNetworkId: 1 } }));
  assert.throws(() => checkProfileRegistry({ sellerBond: r }, { peer: { msbNetworkId: 2 } }), /network profile/);
});

test('cannot remove pending policy, rewrite active policy or roll back enforcement', () => {
  const r = registryPolicy(), n = structuredClone(r);
  n.economics.pending = policy({ ...defaultSettings(), penaltyBps: 400 }, 4000);
  assert.deepEqual(validatePolicyTransition(r, n, 4000), n);
  assert.throws(() => validatePolicyTransition(r, n, 3999), /Future/);
  assert.throws(() => validatePolicyTransition(n, r, 5000), /cancelled/);
  const promoted = { ...n, economics: { active: n.economics.pending } };
  assert.throws(() => validatePolicyTransition(n, promoted, 5000), /not effective/);
  assert.deepEqual(validatePolicyTransition(n, promoted, 7600), promoted);
  assert.throws(() => validatePolicyTransition(r, promoted, 7600), /pending/);
  const earlier = { ...r, enforceAfter: 5920 };
  assert.deepEqual(validatePolicyTransition(r, earlier, 4000), earlier, 'activation may move earlier');
  assert.deepEqual(validatePolicyTransition(r, earlier, 100500), earlier, 'a receiver that learns of it after the old activation still accepts it');
  assert.throws(() => earlierActivationNotice(r, { ...r, enforceAfter: 5000 }, 4000, 1800), /notice/);
  assert.doesNotThrow(() => earlierActivationNotice(r, earlier, 4000, 1800));
  assert.doesNotThrow(() => earlierActivationNotice(r, { ...r, enforceAfter: 5000 }, 100500, 1800), 'already active: nothing to announce');
  assert.throws(() => validatePolicyTransition(r, { ...r, enforceAfter: 100001 }, 100000));
  const stopped = { ...r, epoch: { ...r.epoch, stopNewAt: 5000 } };
  assert.deepEqual(validatePolicyTransition(r, stopped, 4000), stopped);
  assert.throws(() => validatePolicyTransition(r, stopped, 5001), /backdated/);
  assert.throws(() => validatePolicyTransition(stopped, r, 4000), /stop/);
  assert.throws(() => validatePolicyTransition(stopped, { ...stopped, epoch: { ...stopped.epoch, stopNewAt: 6000 } }, 4000), /stop/);
});

test('a draining epoch replacement reattests unchanged economics only after the announced stop', () => {
  const r = registryPolicy(), stopped = { ...r, acceptNew: false, epoch: { ...r.epoch, stopNewAt: 5000 } };
  const next = registryPolicy({ networkId: r.networkId, venueKey: r.venueKey, epochId: 'b'.repeat(64) });
  next.acceptNew = false; next.epoch.startAt = 5000;
  assert.deepEqual(validatePolicyTransition(stopped, next, 5000), next);
  for (const before of [r, { ...stopped, acceptNew: true }]) assert.throws(() => validatePolicyTransition(before, next, 5000), /quiesced/);
  assert.throws(() => validatePolicyTransition(stopped, next, 4999), /announced stop/);
  assert.throws(() => validatePolicyTransition(stopped, { ...next, acceptNew: true }, 5000), /quiesced/);
  const changed = structuredClone(next);
  changed.economics.active = policy({ ...defaultSettings(), penaltyBps: 400 }, 100,
    { networkId: next.networkId, venueKey: next.venueKey, epochId: next.epoch.id });
  assert.throws(() => validatePolicyTransition(stopped, changed, 5000), /unchanged/);
  const scheduled = structuredClone(stopped); scheduled.economics.pending = policy({ ...defaultSettings(), penaltyBps: 400 }, 4000);
  assert.throws(() => validatePolicyTransition(scheduled, next, 5000), /pending schedule/);
});

test('stake settings are covered by venue signatures and checked at registry admission', async () => {
  const { buildRegistry, signRegistry, verifyRegistry } = await import('../../../src/core/registry.js');
  const { RegistryView } = await import('../../../src/roles/common.js');
  const { fixture } = await import('../core/helpers.mjs');
  const { bytesToHex } = await import('../../../src/core/canonical.js');
  const f = fixture({ n: 4 }), stake = registryPolicy({ networkId: 1, venueKey: bytesToHex(f.service.publicKey), epochId: 'a'.repeat(64) });
  const r = buildRegistry({ ...f.registry, sellerBond: stake,
    signers: f.registry.signers.map((s, i) => ({ ...s, ...stake.epoch.members[i] })) });
  const signed = signRegistry(r, f.service.secretKey), service = bytesToHex(f.service.publicKey);
  assert.equal(verifyRegistry(signed, service, { now: 1000 }), true);
  assert.equal(verifyRegistry({ ...signed, registry: { ...r, sellerBond: { ...stake, acceptNew: false } } }, service, { now: 1000 }), false);
  const view = new RegistryView(service);
  assert.equal(view.offer({ kind: 'registry', from: service, body: r }, 1000), true);
  assert.throws(() => view.offer({ kind: 'registry', from: service, body: { ...f.registry, version: 2 } }, 1000), /remove stake/);
  assert.throws(() => buildRegistry({ ...r, params: { ...r.params, n: 5 } }), /4\/3/);
  const otherVenue = registryPolicy({ networkId: 1, venueKey: '9'.repeat(64), epochId: stake.epoch.id });
  const foreign = { ...r, sellerBond: otherVenue };
  assert.throws(() => signRegistry(foreign, f.service.secretKey), /another venue/);
  assert.equal(new RegistryView(service).offer({ kind: 'registry', from: service, body: foreign }, 1000), false);
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { stableJSON, utf8 } = await import('../../../src/core/canonical.js');
  const forgedScope = { from: service, registry: foreign,
    sig: bytesToHex(ed25519.sign(utf8('intercom-dex/v1/registry\n' + stableJSON(foreign)), f.service.secretKey)) };
  assert.equal(verifyRegistry(forgedScope, service, { now: 1000 }), false);
  const { Service } = await import('../../../src/roles/service.js');
  assert.throws(() => new Service({ firstLaunch: true, bridge: {}, store: memoryStore(), registryInput: foreign,
    identity: { publicKey: service, secretKey: bytesToHex(f.service.secretKey) }, log: () => {} }), /another venue/);
});
