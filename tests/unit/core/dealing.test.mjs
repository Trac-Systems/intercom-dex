import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDeal, lockStatement, checkDealShape, signerShareCheck } from '../../../src/core/dealing.js';
import { sealTo } from '../../../src/core/seal.js';
import { bytesToHex, fromLe32, le32, sha256Hex } from '../../../src/core/canonical.js';
import { commitmentAffine, polynomialCommitments, reconstruct } from '../../../src/core/vss.js';
import { tradeId } from '../../../src/core/terms.js';
import { fixture, hex, rng, proofStub } from './helpers.mjs';

function setup() {
  const f = fixture(), params = { k: f.terms.k, committeeBoxKeys: f.terms.committee.map(s => s.boxKey), tradeId: tradeId(f.terms) };
  const prepared = prepareDeal({ ...params, rng: rng() });
  return { f, params, ...prepared, deal: { ...prepared.deal, proof: proofStub() } };
}
test('dealing is deterministic and every signer holds a share of the lock preimage', () => {
  const { f, params, privateState, deal } = setup();
  const rebuilt = prepareDeal({ ...params, rng: rng() });
  assert.equal(rebuilt.deal.proof, null);
  assert.deepEqual(rebuilt.privateState, privateState);
  assert.deepEqual({ ...rebuilt.deal, proof: proofStub() }, deal);
  assert.equal(checkDealShape(deal, f.terms), true);
  const shares = f.signers.map((s, i) => {
    const checked = signerShareCheck(deal, i + 1, s.box.secretKey);
    assert.equal(checked.ok, true);
    return { id: i + 1, share: checked.share };
  });
  const secret = reconstruct(shares, f.terms.k);
  assert.equal(bytesToHex(le32(secret)), privateState.secretHex);
  assert.equal(sha256Hex(le32(secret)), deal.H);
  const { x, y } = commitmentAffine(deal.commitments[0]);
  assert.deepEqual(lockStatement(deal), [BigInt('0x' + deal.H.slice(0, 32)), BigInt('0x' + deal.H.slice(32)), x, y].map(String));
  assert.equal(fromLe32(Buffer.from(privateState.coefficients[0], 'hex')), secret);
});
test('shape checks reject every malformed field, wrong dimensions, committee order and invalid commitments', () => {
  const { f, params, deal } = setup();
  for (const patch of [
    { tradeId: hex() }, { tradeId: 'bad' }, { k: 2 }, { k: 6 }, { H: 'ff' }, { H: deal.H.toUpperCase() },
    { committeeBoxKeys: [...deal.committeeBoxKeys].reverse() }, { committeeBoxKeys: Array(5).fill(deal.committeeBoxKeys[0]) },
    { commitments: deal.commitments.slice(1) }, { commitments: ['ff'.repeat(32), ...deal.commitments.slice(1)] },
    { commitments: polynomialCommitments([0n, 1n, 1n]) }, { commitments: polynomialCommitments([1n, 1n, 0n]) },
    { sealedShares: deal.sealedShares.slice(1) }, { sealedShares: [{ ...deal.sealedShares[0], nonce: 'bad' }, ...deal.sealedShares.slice(1)] },
    { proof: null }, { proof: {} }, { proof: { ...proofStub(), eval_a: '00' } }, { extra: true },
  ]) assert.equal(checkDealShape({ ...deal, ...patch }, f.terms), false, Object.keys(patch).join());
  for (const key of Object.keys(deal)) { const d = { ...deal }; delete d[key]; assert.equal(checkDealShape(d, f.terms), false, key); }
  for (const patch of [{ k: 0 }, { k: 6 }, { k: 1.5 }, { committeeBoxKeys: [] },
    { committeeBoxKeys: Array(17).fill(hex()) }, { committeeBoxKeys: Array(5).fill(hex()) }, { committeeBoxKeys: ['bad'] }]) {
    assert.throws(() => prepareDeal({ ...params, ...patch }));
  }
  assert.throws(() => lockStatement({ ...deal, H: 'bad' }));
  assert.throws(() => lockStatement({ ...deal, commitments: ['ff'.repeat(32)] }));
});
test('signer checks reject wrong keys and indices, tampered boxes and correctly sealed wrong scalars', () => {
  const { f, deal } = setup(), key = f.signers[0].box.secretKey;
  for (const i of [0, -1, 1.5, 6]) assert.equal(signerShareCheck(deal, i, key).ok, false);
  assert.equal(signerShareCheck(deal, 1, f.signers[1].box.secretKey).ok, false);
  assert.equal(signerShareCheck({ ...deal, tradeId: hex() }, 1, key).ok, false);
  for (const box of [
    { ...deal.sealedShares[0], ciphertext: '00'.repeat(48) },
    { ...deal.sealedShares[0], nonce: '00'.repeat(24) },
    { ...deal.sealedShares[0], ephemeralKey: hex() },
    sealTo(le32(1n), deal.committeeBoxKeys[0], { tradeId: deal.tradeId, signerIndex: 1 }),
    sealTo(new Uint8Array(32).fill(255), deal.committeeBoxKeys[0], { tradeId: deal.tradeId, signerIndex: 1 }),
    sealTo(le32(1n), deal.committeeBoxKeys[0], { tradeId: deal.tradeId, signerIndex: 2 }),
  ]) {
    const d = { ...deal, sealedShares: [box, ...deal.sealedShares.slice(1)] };
    assert.equal(checkDealShape(d, f.terms), true);
    assert.equal(signerShareCheck(d, 1, key).ok, false);
    assert.equal(signerShareCheck(d, 2, f.signers[1].box.secretKey).ok, true);
  }
  const changed = { ...deal, commitments: polynomialCommitments([1n, 1n, 1n]) };
  assert.equal(signerShareCheck(changed, 1, key).ok, false);
});
