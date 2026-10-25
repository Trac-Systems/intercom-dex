import test from 'node:test';
import assert from 'node:assert/strict';
import { bodySchemas, amount, price, hexKey, tracAddress as trac, solanaAddress, parseBody,
  feesSchema, termsSchema, registrySchema, sealedBoxSchema, dealSchema } from '../../../src/core/schemas.js';
import { isTracAddress, isSolanaAddress } from '../../../src/core/addresses.js';
import { fixture, hex, SOL, SIG, proofStub } from './helpers.mjs';

test('address validation checks bech32m checksum, padding, case and exact Solana length', () => {
  const f = fixture(), address = f.terms.buyer.tracAddr;
  assert.ok(isTracAddress(address)); assert.ok(isTracAddress(address.toUpperCase()));
  for (const bad of [address.slice(0, -1) + (address.at(-1) === 'q' ? 'p' : 'q'), 'Trac' + address.slice(4), 'trac1abc', '', null, 'x'.repeat(91)]) {
    assert.equal(isTracAddress(bad), false); assert.equal(trac.safeParse(bad).success, false);
  }
  for (const good of [SOL, f.terms.mint, f.terms.seller.solRecipient]) { assert.ok(isSolanaAddress(good)); solanaAddress.parse(good); }
  for (const bad of ['1'.repeat(31), '1'.repeat(33), '0'.repeat(32), 'z'.repeat(44), null]) assert.equal(isSolanaAddress(bad), false);
});
test('amounts, prices, keys and structural schemas are exact', () => {
  for (const good of ['0', '1', '9'.repeat(31)]) amount.parse(good);
  for (const bad of ['01', '-1', '1.0', '1e5', '', '9'.repeat(32), '1\n', '1\r', '1\u2028', 1]) assert.equal(amount.safeParse(bad).success, false);
  for (const good of ['0', '1.000000000001', '50.0']) price.parse(good);
  for (const bad of ['.1', '01', '1.', '1.1234567890123', '-1', '1.5\n', 2]) assert.equal(price.safeParse(bad).success, false);
  hexKey.parse('ab'.repeat(32)); assert.equal(hexKey.safeParse('AB'.repeat(32)).success, false);
  assert.equal(hexKey.safeParse('ab'.repeat(32) + '\n').success, false);
  const f = fixture();
  assert.equal(registrySchema.safeParse({ ...f.registry, params: { ...f.registry.params, m: 64 } }).success, false);
  for (const [schema, good] of [[termsSchema, f.terms], [feesSchema, f.terms.fees], [registrySchema, f.registry]]) {
    schema.parse(good); assert.equal(schema.safeParse({ ...good, extra: 1 }).success, false);
  }
});
test('every message kind has a strict top-level and nested body schema', () => {
  const f = fixture(), id = hex(), key = hex(), box = { ephemeralKey: hex(), nonce: 'ab'.repeat(24), ciphertext: 'ab'.repeat(48) };
  const offer = { peerKey: key, offerId: id, registryVersion: 1, software: '0.1.0', pair: 'TNK/USDC', side: 'sell', baseAmount: '1', price: '1.25',
    maker: { dexKey: key, tracAddr: f.terms.seller.tracAddr, solAddr: SOL }, expiresAt: 500 };
  const deal = { tradeId: id, k: 1, committeeBoxKeys: [key], H: hex(), commitments: [key], sealedShares: [box], proof: proofStub() };
  const samples = { chat: { text: 'Market opinion', name: 'Trader', ts: 1 },
    offer, cancel: { offerId: id }, take: { offerId: id, pair: 'TNK/USDC', registryVersion: 1, software: '0.1.0', baseAmount: '1', taker: offer.maker, commitment: key, sendBy: 5, refundAfter: 9 },
    settled: { offerId: id, tradeId: id, terms: f.terms, hashHex: key, claimSignature: SIG, txHash: key },
    accept: { offerId: id, takeCommitment: key, commitment: key, slot: 7 }, commit: { offerId: id, commitment: key }, reveal: { offerId: id, takeCommitment: key, nonce: key },
    decline: { offerId: id, takeNonce: key, reason: 'busy' }, working: { tradeId: id, step: 'certificate' },
    present: { ref: id }, summon: { tradeId: id, terms: f.terms, sigs: [{ v: 1 }, { v: 1 }] },
    terms: { tradeId: id, terms: f.terms }, termsSig: { tradeId: id }, deal,
    ack: { tradeId: id, H: key, holdUntil: 100 }, refused: { tradeId: id, reason: 'seller-funds' }, transferSent: { tradeId: id, txHash: key },
    sharePublish: { tradeId: id, H: key, signerIndex: 1, share: key, commitments: [key] },
    claimed: { tradeId: id, claimSignature: SIG }, refunded: { tradeId: id, refundSignature: SIG }, abort: { tradeId: id, reason: 'test' },
    registry: f.registry, book: { registryVersion: 1, pair: 'TNK/USDC', ts: 1, seq: 1, levels: [] },
    bookDelta: { pair: 'TNK/USDC', seq: 1, upserts: [], removes: [] }, shareRequest: { tradeId: id },
    ticker: { registryVersion: 1, pair: 'TNK/USDC', ts: 1, last: '1', volume24h: '3', high24h: '2', low24h: '0.1', trades24h: 3 },
    tradeLog: { price: '2', seller: { tracAddr: f.terms.seller.tracAddr, solAddr: SOL }, buyer: { tracAddr: f.terms.buyer.tracAddr, solAddr: SOL }, registryVersion: 1, tradeId: id, pair: 'TNK/USDC', baseAmount: '1', quoteAmount: '2', ts: 1, termsHash: id, escrowAddress: SOL, claimSignature: SIG, tracTxHash: key },
    heartbeat: { registryVersion: 1, software: '0.1.0', status: 'online', holdCount: 0 }, status: { software: '0.1.0', status: 'online', ts: 1, message: '' } };
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(bodySchemas).sort());
  for (const [kind, body] of Object.entries(samples)) {
    assert.doesNotThrow(() => parseBody(kind, body), kind);
    assert.throws(() => parseBody(kind, { ...body, extra: true }), kind);
    assert.throws(() => parseBody(kind, {}), kind);
  }
  sealedBoxSchema.parse(box); dealSchema.parse(deal);
  assert.throws(() => sealedBoxSchema.parse({ ...box, extra: 1 }));
  assert.throws(() => dealSchema.parse({ ...deal, k: 2 }));
  assert.throws(() => dealSchema.parse({ ...deal, proof: { ...deal.proof, extra: 1 } }));
  assert.throws(() => parseBody('offer', { ...offer, maker: { ...offer.maker, extra: 1 } }));
  assert.throws(() => parseBody('toString', {}));
  for (const kind of ['dealCommit', 'challenge', 'dealOpen', 'sealedShares']) assert.throws(() => parseBody(kind, {}));
});

test('only full books accept compact remaining amounts, capped at 200 unique integer rows', () => {
  const book = { pair: 'TNK/USDC', registryVersion: 1, ts: 1, seq: 1, levels: [] };
  const remaining = Array.from({ length: 200 }, (_, i) => ({ offerId: i.toString(16).padStart(64, '0'), amount: '9'.repeat(31) }));
  assert.deepEqual(parseBody('book', { ...book, remaining }).remaining, remaining);
  assert.deepEqual(parseBody('book', { ...book, remaining: [] }).remaining, []);
  assert.doesNotThrow(() => parseBody('book', { ...book, remaining: [{ ...remaining[0], amount: '0' }] }));
  for (const rows of [[...remaining, { offerId: hex(), amount: '1' }], [remaining[0], remaining[0]],
    [{ ...remaining[0], extra: true }], [{ offerId: 'bad', amount: '1' }],
    ...['-1', '01', '1.2', '1e3', '9'.repeat(32), '1\n', 1].map(amount => [{ ...remaining[0], amount }])]) {
    assert.throws(() => parseBody('book', { ...book, remaining: rows }));
  }
  assert.throws(() => parseBody('book', { ...book, offers: [] }));
  const delta = { pair: book.pair, seq: 1, upserts: [], removes: [] };
  for (const extra of [{ remaining }, { offers: [] }]) assert.throws(() => parseBody('bookDelta', { ...delta, ...extra }));
});
