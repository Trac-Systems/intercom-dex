import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTerms, validateTerms, tradeId, transferNonce, tradeRandomness } from '../../../src/core/terms.js';
import { concatBytes, hexToBytes, sha256Hex, utf8 } from '../../../src/core/canonical.js';
import { fixture, hex } from './helpers.mjs';

test('terms hashing, domain-bound transfer nonce and finalized randomness match byte vectors', () => {
  const { terms } = fixture(), id = tradeId(terms);
  assert.deepEqual(buildTerms(terms), validateTerms(terms));
  assert.equal(tradeId(Object.fromEntries(Object.entries(terms).reverse())), id);
  assert.notEqual(tradeId({ ...terms, baseAmount: '2' }), id);
  assert.equal(transferNonce(id), sha256Hex(concatBytes(utf8('intercom-dex/v1/transfer'), hexToBytes(id))));
  assert.notEqual(transferNonce(id), transferNonce(hex()));
  const input = { makerNonce: hex(), takerNonce: hex(), blockhash: hex(), acceptSlot: 10, slot: 106, finalized: true };
  assert.equal(tradeRandomness(input), sha256Hex(concatBytes(hexToBytes(input.makerNonce), hexToBytes(input.takerNonce), hexToBytes(input.blockhash))));
  assert.throws(() => tradeRandomness({ ...input, slot: 105 })); assert.throws(() => tradeRandomness({ ...input, finalized: false }));
  assert.throws(() => transferNonce('aa'));
});
test('terms enforce deadlines, fee caps, thresholds, participants, canonical amounts and exact shape', () => {
  const { terms } = fixture();
  const invalid = [
    { ...terms, sendBy: terms.refundAfter - terms.graceSec }, { ...terms, graceSec: -1 },
    { ...terms, k: 6 }, { ...terms, m: 1 }, { ...terms, baseAmount: '0' }, { ...terms, quoteAmount: '01' },
    { ...terms, fees: { ...terms.fees, tradeFeeBps: 1001 } }, { ...terms, fees: { ...terms.fees, platformFeeBps: 501 } },
    { ...terms, committee: [terms.committee[0], terms.committee[0], terms.committee[2]] },
    { ...terms, committee: [{ ...terms.committee[0], dexKey: terms.buyer.dexKey }, ...terms.committee.slice(1)] },
    { ...terms, buyer: { ...terms.buyer, dexKey: terms.seller.dexKey } }, { ...terms, extra: 1 }, { ...terms, tradeId: hex() },
  ];
  for (const bad of invalid) { assert.throws(() => validateTerms(bad)); assert.throws(() => buildTerms(bad)); assert.throws(() => tradeId(bad)); }
  assert.doesNotThrow(() => buildTerms({ ...terms, fees: { ...terms.fees, tradeFeeBps: 1000 } }));
});
