import test from 'node:test';
import assert from 'node:assert/strict';
import { stableJSON, bytesToHex, hexToBytes, utf8, concatBytes, le32, fromLe32, sha256Hex } from '../../../src/core/canonical.js';

test('stable JSON sorts nested and integer-looking keys lexically', () => {
  assert.equal(stableJSON({ z: [{ b: 2, a: 1 }], a: null, '2': true, '10': false }), '{"10":false,"2":true,"a":null,"z":[{"a":1,"b":2}]}');
  assert.equal(stableJSON(Object.assign(Object.create(null), { b: 2, a: 1 })), '{"a":1,"b":2}');
  assert.equal(stableJSON([-0, 'ü', false]), '[0,"ü",false]');
  const shared = { x: 1 }; assert.equal(stableJSON([shared, shared]), '[{"x":1},{"x":1}]');
});
test('canonical JSON rejects all non-JSON and ambiguous structures', () => {
  const cycle = {}; cycle.self = cycle;
  const getter = Object.defineProperty({}, 'a', { get() { throw new Error('getter invoked'); }, enumerable: true });
  const decorated = [1]; decorated.extra = 1;
  class CustomArray extends Array {}
  for (const bad of [undefined, NaN, Infinity, -Infinity, 1n, () => {}, new Date(), new Uint8Array(1), /x/,
    { a: undefined }, [undefined], Array(1), cycle, getter, decorated, new CustomArray(), { [Symbol()]: 1 }, Object.defineProperty({}, 'x', { value: 1 })]) {
    assert.throws(() => stableJSON(bad));
  }
});
test('bytes helpers, uint256 little endian, SHA-256 vector and rejection', () => {
  assert.equal(bytesToHex(concatBytes(utf8('a'), utf8('bc'))), '616263');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(utf8('abc')), sha256Hex('abc'));
  assert.equal(bytesToHex(hexToBytes('00ff', 2)), '00ff');
  for (const x of [0n, 1n, 256n, (1n << 256n) - 1n]) assert.equal(fromLe32(le32(x)), x);
  assert.equal(bytesToHex(le32(256n)).slice(0, 4), '0001');
  for (const x of ['A0', '0', 'gg', 'aa\n', 'aa\n\n', 'aa\r', 4]) assert.throws(() => hexToBytes(x));
  assert.throws(() => hexToBytes('aa', 2));
  for (const x of [-1n, 1n << 256n, 1]) assert.throws(() => le32(x));
  assert.throws(() => fromLe32(new Uint8Array(31)));
  assert.throws(() => bytesToHex([])); assert.throws(() => utf8(1));
  assert.throws(() => concatBytes([])); assert.throws(() => sha256Hex(1));
});
