import { sha256 } from '@noble/hashes/sha2.js';

export function stableJSON(value) {
  const active = new Set();
  function encode(v) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== 'object' || v === null) throw new TypeError('Not a JSON value');
    if (active.has(v)) throw new TypeError('Cyclic JSON');
    if (Array.isArray(v) && Object.getPrototypeOf(v) !== Array.prototype) throw new TypeError('Expected plain array');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
      throw new TypeError('Expected plain object');
    }
    if (Object.getOwnPropertySymbols(v).length) throw new TypeError('Symbol keys are not JSON');
    active.add(v);
    const keys = Object.keys(v);
    for (const key of Object.getOwnPropertyNames(v)) {
      if (Array.isArray(v) && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d.enumerable || !('value' in d)) throw new TypeError('Expected enumerable data properties');
    }
    let out;
    if (Array.isArray(v)) {
      if (keys.length !== v.length || keys.some((key, i) => key !== String(i))) throw new TypeError('Sparse or decorated array');
      out = '[' + v.map(encode).join(',') + ']';
    } else {
      out = '{' + keys.sort().map(key => JSON.stringify(key) + ':' + encode(v[key])).join(',') + '}';
    }
    active.delete(v);
    return out;
  }
  return encode(value);
}

export function bytesToHex(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected bytes');
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex, length) {
  if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-f]/.test(hex)) throw new TypeError('Expected lowercase hex');
  const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  if (length !== undefined && bytes.length !== length) throw new RangeError('Wrong byte length');
  return bytes;
}

export function utf8(text) {
  if (typeof text !== 'string') throw new TypeError('Expected text');
  return new TextEncoder().encode(text);
}

export function concatBytes(...parts) {
  if (parts.some(p => !(p instanceof Uint8Array))) throw new TypeError('Expected bytes');
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export function le32(scalar) {
  if (typeof scalar !== 'bigint' || scalar < 0n || scalar >= (1n << 256n)) throw new RangeError('Expected uint256 bigint');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { out[i] = Number(scalar & 255n); scalar >>= 8n; }
  return out;
}

export function fromLe32(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new RangeError('Expected 32 bytes');
  let scalar = 0n;
  for (let i = 31; i >= 0; i--) scalar = (scalar << 8n) | BigInt(bytes[i]);
  return scalar;
}

export function sha256Hex(value) {
  const bytes = typeof value === 'string' ? utf8(value) : value;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected bytes or text');
  return bytesToHex(sha256(bytes));
}
