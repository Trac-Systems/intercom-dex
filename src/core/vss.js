import { randomBytes } from 'node:crypto';
import { edwards } from '@noble/curves/abstract/edwards.js';
import { bytesToHex, fromLe32, hexToBytes } from './canonical.js';

export const FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const SCALAR_ORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
const Point = edwards({ p: FIELD_ORDER, a: 168700n, d: 168696n, h: 8n, n: SCALAR_ORDER,
  Gx: 5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  Gy: 16950150798460657717958625567821834550301663161624707787222815936182638968203n });
const mod = x => ((x % SCALAR_ORDER) + SCALAR_ORDER) % SCALAR_ORDER;
const scalar = x => {
  if (typeof x !== 'bigint' || x < 0n || x >= SCALAR_ORDER) throw new RangeError('Noncanonical scalar');
  return x;
};
const shareId = id => {
  if (typeof id === 'number' && Number.isSafeInteger(id)) id = BigInt(id);
  if (typeof id !== 'bigint' || id < 1n || id >= SCALAR_ORDER) throw new RangeError('Invalid share id');
  return id;
};
const point = value => value === 0n ? Point.ZERO : Point.BASE.multiply(value);
function decode(encoded) {
  const p = Point.fromBytes(hexToBytes(encoded, 32), false);
  if (!p.isTorsionFree() || bytesToHex(p.toBytes()) !== encoded) throw new Error('Invalid commitment');
  return p;
}

export function commitmentAffine(encoded) { return decode(encoded).toAffine(); }

export function randomScalar(rng = randomBytes) {
  for (let attempt = 0; attempt < 1024; attempt++) {
    const raw = rng(32);
    if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new TypeError('RNG must return requested bytes');
    const bytes = Uint8Array.from(raw);
    bytes[31] &= 7;
    const value = fromLe32(bytes);
    if (value > 0n && value < SCALAR_ORDER) return value;
  }
  throw new Error('RNG rejection limit');
}

export function evaluatePolynomial(coefficients, id) {
  const x = shareId(id);
  if (!Array.isArray(coefficients) || !coefficients.length) throw new RangeError('Empty polynomial');
  return coefficients.reduceRight((sum, c) => mod(sum * x + scalar(c)), 0n);
}

export function polynomialCommitments(coefficients) {
  if (!Array.isArray(coefficients) || !coefficients.length) throw new RangeError('Empty polynomial');
  return coefficients.map(c => bytesToHex(point(scalar(c)).toBytes()));
}

export function validateCommitments(commitments) {
  try {
    if (!Array.isArray(commitments) || !commitments.length) return false;
    const points = commitments.map(decode);
    return !points[0].is0() && !points.at(-1).is0();
  } catch { return false; }
}

export function split(secret, k, ids, rng = randomBytes) {
  scalar(secret);
  if (secret === 0n) throw new RangeError('Secret must be nonzero');
  if (!Array.isArray(ids) || !Number.isSafeInteger(k) || k < 1 || k > ids.length) throw new RangeError('Invalid threshold');
  const xs = ids.map(shareId);
  if (new Set(xs.map(String)).size !== xs.length) throw new RangeError('Duplicate share ids');
  const coefficients = [secret];
  for (let i = 1; i < k; i++) coefficients.push(randomScalar(rng));
  return { coefficients, commitments: polynomialCommitments(coefficients),
    shares: ids.map(id => ({ id, share: evaluatePolynomial(coefficients, id) })) };
}

export function verifyShare(id, share, commitments) {
  try {
    const x = shareId(id);
    scalar(share);
    if (!validateCommitments(commitments)) return false;
    let expected = Point.ZERO, power = 1n;
    for (const encoded of commitments) {
      const p = decode(encoded);
      expected = expected.add(p.multiplyUnsafe(power));
      power = mod(power * x);
    }
    return point(share).equals(expected);
  } catch { return false; }
}

function interpolate(points, at) {
  let out = 0n;
  for (const p of points) {
    let numerator = 1n, denominator = 1n;
    for (const q of points) if (p.id !== q.id) {
      numerator = mod(numerator * (at - q.id));
      denominator = mod(denominator * (p.id - q.id));
    }
    out = mod(out + p.share * numerator * Point.Fn.inv(denominator));
  }
  return out;
}

export function reconstruct(shares, k) {
  if (!Array.isArray(shares) || !Number.isSafeInteger(k) || k < 1 || shares.length < k) throw new RangeError('Too few shares or invalid threshold');
  const points = shares.map(p => ({ id: shareId(p.id), share: scalar(p.share) }));
  if (new Set(points.map(p => String(p.id))).size !== points.length) throw new RangeError('Duplicate share ids');
  const basis = points.slice(0, k);
  for (const p of points.slice(k)) if (interpolate(basis, p.id) !== p.share) throw new Error('Inconsistent extra share');
  return interpolate(basis, 0n);
}
