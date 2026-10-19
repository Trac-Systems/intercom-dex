import test from 'node:test';
import assert from 'node:assert/strict';
import { edwards } from '@noble/curves/abstract/edwards.js';
import { FIELD_ORDER, SCALAR_ORDER, commitmentAffine, randomScalar, evaluatePolynomial, polynomialCommitments, split, validateCommitments, verifyShare, reconstruct } from '../../../src/core/vss.js';
import { bytesToHex, le32 } from '../../../src/core/canonical.js';
import { rng } from './helpers.mjs';

test('Feldman shares verify and every 3-of-5 subset reconstructs', () => {
  const d = split(123n, 3, [1, 2, 3, 4, 5], rng());
  for (const p of d.shares) assert.equal(verifyShare(p.id, p.share, d.commitments), true);
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 4; b++) for (let c = b + 1; c < 5; c++) {
    assert.ok(reconstruct([d.shares[a], d.shares[b], d.shares[c]], 3) === 123n);
  }
  assert.ok(reconstruct(d.shares, 3) === 123n);
  assert.ok(evaluatePolynomial([1n, 2n, 3n], 2) === 17n);
  assert.deepEqual(commitmentAffine(polynomialCommitments([1n])[0]), { x: 5299619240641551281634865583518297030282874472190772894086521144482721001553n, y: 16950150798460657717958625567821834550301663161624707787222815936182638968203n });
  assert.throws(() => split(0n, 1, [1], rng()));
  assert.equal(reconstruct(split(1n, 1, [1], rng()).shares, 1), 1n);
  assert.equal(verifyShare(1, 0n, polynomialCommitments([0n])), false);
  assert.equal(verifyShare(1, 0n, polynomialCommitments([1n, SCALAR_ORDER - 1n])), true);
  assert.ok(randomScalar(rng()) < SCALAR_ORDER);
  assert.ok(randomScalar() < SCALAR_ORDER);
  assert.ok(validateCommitments(d.commitments));
});
test('VSS rejects malformed scalars, duplicates, thresholds, torsion, corrupt and inconsistent shares', () => {
  const d = split(123n, 3, [1, 2, 3, 4, 5], rng());
  assert.equal(verifyShare(1, d.shares[0].share + 1n, d.commitments), false);
  for (const id of [0, -1, SCALAR_ORDER, 1.5]) assert.equal(verifyShare(id, 1n, d.commitments), false);
  for (const share of [-1n, SCALAR_ORDER, 1]) assert.equal(verifyShare(1, share, d.commitments), false);
  for (const commitments of [[], ['ff'.repeat(32)], ['00'.repeat(32)]]) assert.equal(verifyShare(1, 1n, commitments), false);
  for (const args of [[1n, 0, [1]], [1n, 2, [1]], [1n, 2, [1, 1n]], [SCALAR_ORDER, 1, [1]], [1n, 1, [0]]]) assert.throws(() => split(...args));
  assert.throws(() => split(1n, 2, [1, 2], () => le32(0n)));
  assert.throws(() => reconstruct(d.shares.slice(0, 2), 3));
  assert.throws(() => reconstruct([d.shares[0], d.shares[0]], 2));
  assert.throws(() => reconstruct([...d.shares.slice(0, 3), { id: 4, share: 0n }], 3));
  assert.throws(() => evaluatePolynomial([], 1)); assert.throws(() => polynomialCommitments([-1n]));
  assert.throws(() => randomScalar(() => new Uint8Array(1)));
  assert.throws(() => randomScalar(() => new Uint8Array(32).fill(255)));
  for (const commitments of [[], ['ff'.repeat(32)], ['00'.repeat(32)], polynomialCommitments([1n, 0n])]) assert.equal(validateCommitments(commitments), false);
});

test('Baby Jubjub encodings round-trip and reject noncanonical, off-curve and non-subgroup points', () => {
  const Point = edwards({ p: FIELD_ORDER, a: 168700n, d: 168696n, h: 8n, n: SCALAR_ORDER,
    Gx: 5299619240641551281634865583518297030282874472190772894086521144482721001553n,
    Gy: 16950150798460657717958625567821834550301663161624707787222815936182638968203n });
  for (const s of [1n, 2n, 123n, SCALAR_ORDER - 1n]) {
    const encoded = polynomialCommitments([s])[0];
    const decoded = commitmentAffine(encoded);
    assert.equal(Point.fromAffine(decoded).toHex(), encoded);
  }
  const torsion = Point.fromAffine({ x: 0n, y: FIELD_ORDER - 1n });
  const mixed = Point.BASE.add(torsion);
  assert.equal(mixed.isSmallOrder(), false); assert.equal(mixed.isTorsionFree(), false);
  const negativeZero = le32(1n); negativeZero[31] |= 128;
  let offCurve;
  for (let y = 2n; y < 100n; y++) {
    const encoded = bytesToHex(le32(y));
    try { Point.fromHex(encoded); } catch { offCurve = encoded; break; }
  }
  assert.ok(offCurve);
  for (const encoded of [bytesToHex(le32(FIELD_ORDER)), bytesToHex(negativeZero), offCurve, torsion.toHex(), mixed.toHex(), 'ff'.repeat(32)]) {
    assert.throws(() => commitmentAffine(encoded));
    assert.equal(validateCommitments([encoded]), false);
  }
  const identity = Point.ZERO.toHex(), base = Point.BASE.toHex();
  for (const c of [[identity], [identity, base], [base, identity]]) assert.equal(validateCommitments(c), false);
  assert.equal(validateCommitments([base, identity, base]), true);
  for (let i = 0; i < 10; i++) { const s = randomScalar(rng('scalar-' + i)); assert.ok(s > 0n && s < SCALAR_ORDER); }
});
