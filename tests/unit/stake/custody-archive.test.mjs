import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveCustodyTransition } from '../../../src/stake/custody-archive.js';
import { admissionFixture } from './admission-helpers.mjs';

const hex = n => n.toString(16).padStart(64, '0');

test('venue archive imports an original certified withdrawal after unobserved delivery generations and retires once', () => {
  const f = admissionFixture(), settings = f.policy.economics.active.settings;
  const pieces = [{ unitId: f.id, generation: 1 }];
  const freeze = f.cert('freeze', { operationId: hex(99), pieces, acceptedAt: 4000, withdrawDelaySec: settings.stake.withdrawDelaySec });
  assert.throws(() => f.ledger.freeze(freeze, settings), /bond_reserved/, 'ordinary ledgers still require the exact local generation');
  const before = f.ledger.read();
  assert.throws(() => archiveCustodyTransition(f.ledger, 'freeze', freeze.slice(0, 2), settings), /three/);
  assert.deepEqual(f.ledger.read(), before);
  const frozen = archiveCustodyTransition(f.ledger, 'freeze', freeze, settings);
  const once = f.ledger.read(); archiveCustodyTransition(f.ledger, 'freeze', freeze, settings);
  assert.deepEqual(f.ledger.read(), once);
  const decision = f.cert('decision', { decisionId: hex(98), outcome: 'seller-withdraw', pieces, at: frozen.availableAt,
    winnerAddress: f.terms.seller.tracAddr, winnerBoxKey: f.terms.seller.boxKey, evidenceDigest: hex(97) });
  archiveCustodyTransition(f.ledger, 'decision', decision, settings);
  const collection = f.cert('collected', { unitId: f.id, generation: 1, decisionId: hex(98), txHash: hex(96) });
  archiveCustodyTransition(f.ledger, 'collected', collection, settings);
  const retired = f.ledger.read(); archiveCustodyTransition(f.ledger, 'collected', collection, settings);
  assert.deepEqual(f.ledger.read(), retired); assert.equal(retired.pieces[f.id].state, 'retired');
  const conflict = f.cert('freeze', { ...freeze[0].fact.body, operationId: hex(95), pieces: [{ unitId: f.id, generation: 2 }] });
  assert.throws(() => archiveCustodyTransition(f.ledger, 'freeze', conflict, settings), /Conflicting/);
  assert.deepEqual(f.ledger.read(), retired);
});

test('archive expiry generation catch-up remains atomic and cannot change owner, epoch, cooldown or decision', () => {
  const f = admissionFixture(), settings = f.policy.economics.active.settings, before = f.ledger.read();
  const body = { decisionId: hex(98), outcome: 'seller-expiry', pieces: [{ unitId: f.id, generation: 3 }], at: 200000,
    winnerAddress: f.terms.seller.tracAddr, winnerBoxKey: f.terms.seller.boxKey, evidenceDigest: hex(97) };
  for (const change of [{ winnerBoxKey: hex(90) }, { at: 199999 }, { outcome: 'seller-withdraw' }, { pieces: [{ unitId: f.id, generation: 1.5 }] }]) {
    assert.throws(() => archiveCustodyTransition(f.ledger, 'decision', f.cert('decision', { ...body, ...change }), settings));
    assert.deepEqual(f.ledger.read(), before);
  }
  assert.throws(() => archiveCustodyTransition(f.ledger, 'funded', [], settings), /Invalid/);
  const changed = structuredClone(before); changed.pieces[f.id].descriptor.epochId = hex(89); f.store.put(f.ledger.name, changed);
  assert.throws(() => archiveCustodyTransition(f.ledger, 'decision', f.cert('decision', body), settings), /Original/);
  assert.deepEqual(f.ledger.read(), changed); f.store.put(f.ledger.name, before);
  const put = f.store.put; f.store.put = () => { throw Error('disk failed'); };
  assert.throws(() => archiveCustodyTransition(f.ledger, 'decision', f.cert('decision', body), settings), /disk/);
  assert.deepEqual(f.ledger.read(), before); f.store.put = put;
  archiveCustodyTransition(f.ledger, 'decision', f.cert('decision', body), settings);
  assert.equal(f.ledger.read().pieces[f.id].generation, 3);
  assert.equal(f.ledger.read().pieces[f.id].state, 'decided-seller');
});
