import test from 'node:test';
import assert from 'node:assert/strict';
import { SOFTWARE, meetsVersion, softwareSchema } from '../../../src/core/software.js';
import pkg from '../../../package.json' with { type: 'json' };
import { registrySchema, parseBody } from '../../../src/core/schemas.js';
import { selectCommittee } from '../../../src/core/committee.js';
import { STEP_BUDGET_MS } from '../../../src/core/terms.js';
import { supportedBase, registryPair, pairStatus, ASSET_KINDS } from '../../../src/market/assets.js';
import { step as buyerStep } from '../../../src/core/trade-buyer.js';
import { step as sellerStep } from '../../../src/core/trade-seller.js';
import { step as signerStep } from '../../../src/core/trade-signer.js';
import { simulation } from './simulation.mjs';
import { fixture, hex } from './helpers.mjs';

const sim = simulation({ capturePhases: true });
const snap = (name, phase) => structuredClone(sim.snapshots.get(name + ':' + phase));
const step = (s, extra = {}) => ({ buyer: buyerStep, seller: sellerStep, signer: signerStep })[s.role](s, { type: 'tick', now: s.now, ...extra });
const message = (s, kind, body, extra = {}) => step(s, { type: 'message', message: {
  v: 1, kind, body, from: s.peer ?? s.terms.buyer.dexKey, ch: 'intercom-dex:t:' + (body.tradeId ?? s.offerId),
}, ...extra });
const fresh = { observedSlot: 100, finalizedAgeMs: 0, tipSlot: 132, tipAgeMs: 0 };

test('semver precedence, prereleases and metadata gate software from package.json', () => {
  assert.equal(SOFTWARE, pkg.version);
  for (const [version, minimum, ok] of [['0.1.0', '0.1.0', true], ['0.1.0', '0.2.0', false], ['1.0.0', '0.99.0', true],
    ['1.0.0-alpha', '1.0.0', false], ['1.0.0', '1.0.0-alpha', true], ['1.0.0-beta.10', '1.0.0-beta.2', true],
    ['1.0.0-alpha.1', '1.0.0-alpha', true], ['1.0.0-2', '1.0.0-a', false], ['1.0.0-z', '1.0.0-a', true],
    ['1.0.0+a', '1.0.0+b', true]]) assert.equal(meetsVersion(version, minimum), ok, version + ' / ' + minimum);
  for (const bad of ['v1.0.0', '1.0', '01.0.0', '1.0.0-01', '1.0.0\n', '1.0.0-']) {
    assert.equal(softwareSchema.safeParse(bad).success, false); assert.throws(() => meetsVersion(bad, SOFTWARE));
  }
});

test('registry pairs and signer assets have strict ASCII, dimensions, uniqueness and aggregate size bounds', () => {
  const f = fixture(), p = f.registry.pairs[0];
  const bad = change => assert.equal(registrySchema.safeParse({ ...f.registry, ...change }).success, false);
  for (const pairs of [[], Array(65).fill(p), [p, p], [{ ...p, extra: true }], [{ ...p, pair: 'TＮK/USDC' }],
    [{ ...p, base: { ...p.base, id: 'TNK\n' } }], [{ ...p, base: { ...p.base, decimals: 31 } }], [{ ...p, minBaseAmount: '0' }]]) bad({ pairs });
  bad({ minSoftware: 'bad' });
  bad({ signers: [{ ...f.registry.signers[0], assets: ['TNK', 'TNK'] }] });
  bad({ signers: [{ ...f.registry.signers[0], assets: Array.from({ length: 65 }, (_, i) => 'a' + i) }] });
  const signers = Array.from({ length: 4096 }, () => ({ ...f.registry.signers[0], dexKey: hex(), boxKey: hex(), assets: Array.from({ length: 64 }, (_, i) => ('asset' + i).padEnd(64, 'x')) }));
  bad({ signers });
  assert.equal(registrySchema.parse({ ...f.registry, pairs: [{ ...p, pair: 'NATIVE/USDC' }] }).pairs[0].pair, 'NATIVE/USDC');
});

test('asset kinds are pins; unsupported entries are shown without preventing supported pairs', () => {
  const f = fixture();
  const unknown = { pair: 'FUTURE/USDC', base: { kind: 'future', id: 'FUTURE', decimals: 9 }, minBaseAmount: '1', status: 'open' };
  f.registry.pairs.push(unknown);
  registrySchema.parse(f.registry);
  assert.equal(supportedBase(f.terms.base), true); assert.equal(supportedBase(unknown.base), false);
  assert.equal(supportedBase({ ...f.terms.base, decimals: 9 }), false);
  assert.equal(supportedBase({ kind: 'usdc-solana', id: 'USDC', decimals: 6 }), false);
  assert.equal(ASSET_KINDS['usdc-solana'].adapter, 'solana');
  assert.equal(pairStatus(f.registry).at(-1).availability, 'needs a newer version');
  assert.equal(registryPair(f.registry, 'TNK/USDC').base.id, 'TNK');
  assert.throws(() => registryPair(f.registry, unknown.pair), /newer version/);
  assert.throws(() => registryPair(f.registry, 'ABSENT/USDC'), /Unknown/);
  f.registry.pairs[0].status = 'paused';
  assert.throws(() => registryPair(f.registry, 'TNK/USDC'), /paused/);
  assert.equal(registryPair(f.registry, 'TNK/USDC', { open: false }).status, 'paused');
});

test('committee selection filters signed asset capabilities and software deterministically', () => {
  const f = fixture({ n: 8 }), options = { n: 5, k: 3, quoteAmount: '100', pair: 'TNK/USDC' }, R = hex();
  f.registry.signers[0].assets = ['RESET']; f.registry.signers[1].software = '0.0.9';
  const selected = selectCommittee(f.registry, R, options);
  assert.ok(selected.every(s => !f.registry.signers.slice(0, 2).some(x => x.dexKey === s.dexKey)));
  assert.deepEqual(selectCommittee({ ...f.registry, signers: [...f.registry.signers].reverse() }, R, options), selected);
  f.registry.signers[2].software = '0.1.0-alpha'; f.registry.signers[3].assets = ['RESET'];
  assert.throws(() => selectCommittee(f.registry, R, options), /Too few/);
});

test('accept budget is 20 seconds after maker channel presence with a 60 second total cap', () => {
  assert.equal(STEP_BUDGET_MS.accept, 20000); assert.equal(STEP_BUDGET_MS.connect, 60000);
  const s = snap('buyer', 'awaitAccept');
  assert.equal(step(s, { stepElapsedMs: 59999 }).state.phase, 'awaitAccept');
  assert.equal(step(s, { stepElapsedMs: 60000 }).state.phase, 'aborted');
  const connected = step(s, { stepElapsedMs: 35000, makerConnected: true }).state;
  assert.equal(step(connected, { stepElapsedMs: 54999 }).state.phase, 'awaitAccept');
  assert.equal(step(connected, { stepElapsedMs: 55000 }).state.phase, 'aborted');
  const lateConnect = step(s, { stepElapsedMs: 55000, makerConnected: true }).state;
  assert.equal(step(lateConnect, { stepElapsedMs: 60000 }).state.phase, 'aborted');
  const accept = sim.log.find(x => x.name === 'seller' && x.action.kind === 'accept').action.body;
  assert.equal(message(connected, 'accept', accept, { ...fresh, stepElapsedMs: 54999 }).state.phase, 'awaitReveal');
  assert.equal(message(connected, 'accept', accept, { ...fresh, stepElapsedMs: 55000 }).state.phase, 'aborted');
});

test('declines are strict, maker-authenticated and bound to the exact take envelope nonce', () => {
  const s = { ...snap('buyer', 'awaitAccept'), takeNonce: hex() };
  for (const reason of ['busy', 'insufficient', 'expired', 'invalid', 'signers', 'version']) {
    const body = { offerId: s.offerId, takeNonce: s.takeNonce, reason };
    assert.equal(message(s, 'decline', body).state.reason, reason);
    assert.equal(message(s, 'decline', { ...body, takeNonce: hex() }).state, s);
    assert.throws(() => parseBody('decline', { ...body, extra: 1 }));
  }
  assert.throws(() => parseBody('decline', { offerId: s.offerId, takeNonce: s.takeNonce, reason: 'arbitrary' }));
});

test('reveal cutoff expires a silent taker without waiting for the 120 second block budget', () => {
  const s = snap('seller', 'awaitReveal');
  assert.equal(step(s, { ...fresh, tipSlot: s.acceptSlot + 55 }).state.phase, 'awaitReveal');
  assert.equal(step(s, { ...fresh, tipSlot: s.acceptSlot + 56 }).state.reason, 'Reveal arrived too late');
  assert.equal(step(s, { ...fresh, tipSlot: s.acceptSlot + 56, tipAgeMs: 6000 }).state.phase, 'awaitReveal');
});

test('progress just before each step deadline succeeds; at the deadline it cannot start a lock', () => {
  const cases = [
    ['buyer', 'awaitRandomness', 120000, s => ({ type: 'tick', chain: { acceptSlot: s.acceptSlot, slot: s.acceptSlot + 96, blockhash: hex(), finalized: true, firstFinalized: true } })],
    ['buyer', 'awaitTerms', 30000, s => ({ type: 'message', message: { v: 1, from: s.peer, kind: 'terms', ch: 'intercom-dex:t:' + s.tradeId, body: { tradeId: s.tradeId, terms: s.terms } } })],
    ['buyer', 'proving', 150000, s => ({ type: 'proved', tradeId: s.tradeId, ok: true, proof: sim.state('buyer').deal.proof })],
  ];
  for (const [role, phase, budget, event] of cases) {
    const s = snap(role, phase);
    assert.notEqual(step(s, { ...event(s), stepElapsedMs: budget - 1 }).state.phase, 'aborted', phase);
    assert.equal(step(s, { ...event(s), stepElapsedMs: budget }).state.phase, 'aborted', phase);
  }
});

test('seller and signer working notes add 60 seconds per note, cap at 150 and cannot revive an expired wait', () => {
  for (const name of ['seller', 'signer1']) {
    const s = snap(name, 'awaitDeal'); assert.ok(s, name);
    const body = { tradeId: s.tradeId, step: 'certificate' };
    assert.equal(step(s, { stepElapsedMs: 60000 }).state.phase, 'aborted');
    let current = message(s, 'working', body, { stepElapsedMs: 10000 }).state;
    assert.equal(current.dealBudgetMs, 120000);
    for (let i = 0; i < 5; i++) current = message(current, 'working', body, { stepElapsedMs: 10001 + i }).state;
    assert.equal(current.dealBudgetMs, 150000);
    assert.equal(step(current, { stepElapsedMs: 149999 }).state.phase, 'awaitDeal');
    assert.equal(step(current, { stepElapsedMs: 150000 }).state.phase, 'aborted');
    assert.equal(message(s, 'working', body, { stepElapsedMs: 60000 }).state.phase, 'aborted');
  }
});

test('resume restarts local clocks and keeps all post-lock obligations', () => {
  for (const phase of ['awaitAccept', 'awaitRandomness', 'awaitTerms', 'proving', 'awaitAcks']) {
    const s = { ...snap('buyer', phase), stepElapsedMs: 999999, connectedAtMs: 0 };
    const resumed = step(s, { type: 'resume' }).state;
    assert.equal(resumed.phase, phase); assert.equal(resumed.stepElapsedMs, 0); assert.equal(resumed.connectedAtMs, null);
  }
  for (const phase of ['locking', 'locked']) {
    const s = snap('buyer', phase);
    assert.notEqual(step(s, { stepElapsedMs: 99999999 }).state.phase, 'aborted');
    assert.notEqual(message(s, 'abort', { tradeId: s.tradeId, reason: 'stop' }, { stepElapsedMs: 99999999 }).state.phase, 'aborted');
  }
});

test('a registry-defined pair name completes through its asset kind, without a hard-coded pair enum', () => {
  const f = fixture();
  f.registry.pairs[0].pair = 'NATIVE/USDC'; f.terms.pair = 'NATIVE/USDC';
  const run = simulation({ fixture: f });
  assert.equal(run.state('buyer').phase, 'complete'); assert.equal(run.state('seller').phase, 'complete');
  assert.ok(run.log.filter(x => x.action.type === 'verifyTransfer').every(x => x.action.asset === 'TNK'));
});

test('signer signatures time out at 30 seconds; restart preserves extensions and restarts their elapsed clock', () => {
  const s = { ...snap('signer1', 'awaitTermsSignatures'), signatures: [] };
  assert.equal(step(s, { stepElapsedMs: 30000 }).state.phase, 'aborted');
  const first = message(s, 'termsSig', { tradeId: s.tradeId }, { stepElapsedMs: 29998 }).state;
  const second = extra => step(first, { type: 'message', stepElapsedMs: extra, message: {
    v: 1, from: s.terms.seller.dexKey, kind: 'termsSig', ch: 'intercom-dex:t:' + s.tradeId, body: { tradeId: s.tradeId },
  } });
  assert.equal(second(29999).state.phase, 'awaitDeal'); assert.equal(second(30000).state.phase, 'aborted');
  const extended = { ...snap('seller', 'awaitDeal'), dealBudgetMs: 150000, stepElapsedMs: 10000 };
  const resumed = step(extended, { type: 'resume' }).state;
  assert.equal(resumed.dealBudgetMs, 150000); assert.equal(resumed.stepElapsedMs, 0);
});
