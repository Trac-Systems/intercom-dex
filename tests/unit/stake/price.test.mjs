import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletionLog } from '../../../src/stake/price.js';
import { signFact, verifyFact } from '../../../src/stake/certificates.js';
import { registryPolicy, memoryStore, secrets, members } from './helpers.mjs';
const h = n => n.toString(16).padStart(64, '0');
const context = { networkId: 1, venueKey: members[0].dexKey, epoch: registryPolicy().epoch };
function signed(kind, body) {
  const fact = { v: 1, networkId: 1, venueKey: context.venueKey, epochId: context.epoch.id, kind, body };
  return { venue: signFact(fact, secrets[0]), certificate: secrets.slice(0, 3).map(s => signFact(fact, s)) };
}
const make = (store = memoryStore()) => new CompletionLog({ store, context });
const entry = (log, n, amount, at = 86400 + n) => signed('completion', { logPosition: n, prevHash: log.read().hash,
  tradeId: h(n), escrowId: h(n + 100), nonce: h(n + 200), pair: 'RESET/USDC', baseAmount: '100000000', quoteAmount: amount,
  completedAt: at, termsDigest: h(400 + n), escrowDigest: h(500 + n), deliveryDigest: h(600 + n) });
const head = (log, at) => signed('price-head', { headPosition: log.read().position, headHash: log.read().hash, cutoffAt: at });

test('exact midnight and empty days reuse the latest certified trading day without redating it', () => {
  const store = memoryStore(), log = make(store), midnight = 172800, lookback = 604800;
  for (const [i, amount] of ['10', '20', '90'].entries()) log.append(entry(log, i + 1, amount, midnight - 3 + i), midnight);
  const before = log.entry(3), priorHead = head(log, midnight - 1), priorRef = log.reference(priorHead, midnight - 1, 180, lookback);
  assert.deepEqual(log.verifyReference(priorRef, priorHead, midnight, 180, lookback), { numerator: '20', denominator: '1' });
  for (const now of [midnight, midnight + 3600, midnight + 3 * 86400]) {
    const checkpoint = head(log, now), ref = make(store).reference(checkpoint, now, 180, lookback);
    assert.equal(ref.utcDay, '1970-01-02'); assert.equal(ref.dayCount, 3);
    assert.equal(ref.lastTradeId, h(3)); assert.equal(ref.lastLogPosition, 3);
    assert.deepEqual(ref.q, priorRef.q); assert.deepEqual(ref.median, priorRef.median);
    assert.deepEqual(log.entry(3), before, 'fallback never changes certified entry time or hash');
  }
  // The first new-day trade takes precedence over every historical quote.
  log.append(entry(log, 4, '7', midnight), midnight);
  const ref = log.reference(head(log, midnight), midnight, 180, lookback);
  assert.equal(ref.utcDay, '1970-01-03'); assert.equal(ref.dayCount, 1);
  assert.deepEqual(ref.q, { numerator: '7', denominator: '1' });
  assert.throws(() => log.verifyReference(priorRef, head(log, midnight), midnight, 180, lookback), /differs/);
});

test('lookback is inclusive by last completion age, keeps its full-day median and never bootstraps empty history', () => {
  const log = make(), at = 172799, lookback = 604800;
  log.append(entry(log, 1, '10', 86400), at);
  log.append(entry(log, 2, '90', at), at);
  const boundary = at + lookback, checkpoint = head(log, boundary);
  assert.deepEqual(log.reference(checkpoint, boundary, 180, lookback).q, { numerator: '50', denominator: '1' });
  // Past the lookback the latest certified day stays the price: staking never waits for a new trade.
  assert.deepEqual(log.reference(head(log, boundary + 1), boundary + 1, 180, lookback).q, { numerator: '50', denominator: '1' });
  assert.deepEqual(log.reference(head(log, boundary + 86400 * 60), boundary + 86400 * 60, 180, lookback).q, { numerator: '50', denominator: '1' });
  assert.throws(() => log.reference(head(log, 172800), 172800, 180, 0), /unavailable/);
  for (const invalid of [-1, 1.5, 2592001, '604800']) assert.throws(() => log.reference(checkpoint, boundary, 180, invalid));
  const empty = make(); assert.throws(() => empty.reference(head(empty, boundary), boundary, 180, lookback));
  // An older day's large price cannot replace a low last print on the latest day.
  const last = make(); last.append(entry(last, 1, '900', 86399), 172800);
  last.append(entry(last, 2, '20', 86401), 172800); last.append(entry(last, 3, '5', 86402), 172800);
  assert.deepEqual(last.reference(head(last, 172800), 172800, 180, lookback).q, { numerator: '5', denominator: '1' });
});

test('historical fallback still requires a fresh complete head and matching venue and original quorum', () => {
  const store = memoryStore(), log = make(store), now = 172800, lookback = 604800;
  log.append(entry(log, 1, '10'), now); const checkpoint = head(log, now);
  assert.throws(() => log.reference(checkpoint, now - 1, 180, lookback), /unavailable/);
  assert.throws(() => log.reference(checkpoint, now + 181, 180, lookback), /unavailable/);
  assert.throws(() => log.reference({ ...checkpoint, certificate: checkpoint.certificate.slice(0, 2) }, now, 180, lookback));
  const other = signed('price-head', { ...checkpoint.venue.fact.body, cutoffAt: now - 1 });
  assert.throws(() => log.reference({ ...checkpoint, venue: other.venue }, now, 180, lookback), /differ/);
  const foreign = signFact({ ...checkpoint.venue.fact, epochId: h(999) }, secrets[0]);
  assert.throws(() => log.reference({ ...checkpoint, venue: foreign }, now, 180, lookback));
  log.append(entry(log, 2, '5', 172799), now);
  assert.throws(() => log.reference(checkpoint, now, 180, lookback), /omits/);
  store.put(`${log.name}-entry-1`, null);
  assert.throws(() => log.reference(head(log, now), now, 180, lookback), /prefix/);
});

test('a bounded admission age preserves exact certified prices, signatures and the UTC-day rule', () => {
  const log = make(); log.append(entry(log, 1, '100'), 86500);
  const checkpoint = head(log, 86401), reference = log.reference(checkpoint, 86401);
  assert.deepEqual(log.verifyReference(reference, checkpoint, 86581, 180), reference.q);
  assert.throws(() => log.verifyReference(reference, checkpoint, 86582, 180), /unavailable/);
  assert.throws(() => log.reference(checkpoint, 86464), /unavailable/);
  assert.throws(() => log.reference(checkpoint, 86400, 180), /unavailable/);
  assert.throws(() => log.reference(checkpoint, 86401, 601));
  assert.throws(() => log.reference({ ...checkpoint, certificate: [] }, 86464, 180));
  const midnight = head(log, 172799);
  assert.throws(() => log.reference(midnight, 172800, 180), /unavailable/);
});

test('exact unweighted median caps the latest completion and even medians retain fractions', () => {
  const log = make();
  for (const [i, amount] of ['20000000', '10000000', '90000000'].entries()) log.append(entry(log, i + 1, amount), 86500);
  const ref = log.reference(head(log, 86403), 86403);
  assert.deepEqual(ref.q, { numerator: '20000000', denominator: '1' }); assert.equal(ref.dayCount, 3);
  assert.equal(ref.lastTradeId, h(3)); assert.equal(ref.lastLogPosition, 3);
  log.append(entry(log, 4, '1'), 86500);
  const checkpoint = head(log, 86404), even = log.reference(checkpoint, 86404);
  assert.deepEqual(even.median, { numerator: '15000000', denominator: '1' });
  assert.deepEqual(even.q, { numerator: '1', denominator: '1' });
  assert.deepEqual(log.verifyReference(even, checkpoint, 86404), even.q);
  assert.throws(() => log.verifyReference({ ...even, dayCount: 3 }, checkpoint, 86404), /differs/);
  const fractional = make();
  fractional.append(entry(fractional, 1, '1'), 86500); fractional.append(entry(fractional, 2, '2'), 86500);
  assert.deepEqual(fractional.reference(head(fractional, 86402), 86402).q, { numerator: '3', denominator: '2' });
});

test('price refuses stale/future checkpoints, previous UTC day, omitted completions and unsigned venue facts', () => {
  const log = make(); log.append(entry(log, 1, '1'), 86500); const checkpoint = head(log, 86401);
  assert.doesNotThrow(() => log.reference(checkpoint, 86461));
  assert.throws(() => log.reference(checkpoint, 86462), /unavailable/);
  assert.throws(() => log.reference(checkpoint, 86400), /unavailable/);
  log.append(entry(log, 2, '2', 86401), 86500);
  assert.throws(() => log.reference(checkpoint, 86401), /omits/);
  const nextDay = head(log, 172800); assert.throws(() => log.reference(nextDay, 172800), /unavailable/);
  const bad = head(log, 86401); bad.venue = signFact(bad.venue.fact, secrets[3]);
  assert.throws(() => log.reference(bad, 86401), /signed/);
  assert.throws(() => verifyFact(bad.venue, context, 'completion', context.venueKey), /signed/);
});

test('completion replay cannot change time, repeat trade/escrow/nonce, fork, skip or replace its finality digests', () => {
  const log = make(), first = entry(log, 1, '100'); log.append(first, 86500);
  assert.deepEqual(log.append(first, 86500), log.entry(1));
  for (const field of ['tradeId', 'escrowId', 'nonce']) {
    const next = entry(log, 2, '100'); next.venue.fact.body[field] = first.venue.fact.body[field];
    assert.throws(() => log.append(signed('completion', next.venue.fact.body), 86500), /Duplicate/);
  }
  assert.throws(() => log.append(entry(log, 3, '100'), 86500), /gap/);
  const changed = { ...first.venue.fact.body, completedAt: 86402 };
  assert.throws(() => log.append(signed('completion', changed), 86500), /replay/);
  assert.throws(() => log.append(entry(log, 2, '100', 86501), 86500), /Future/);
  assert.throws(() => log.append(entry(log, 2, '100', 86399), 86500), /time/);
  const mismatch = entry(log, 2, '100'); mismatch.certificate[0].fact.body.deliveryDigest = h(999);
  assert.throws(() => log.append(mismatch, 86500));
  assert.throws(() => log.append({ ...first, certificate: first.certificate.slice(0, 2) }, 86500));
});

test('completion write-ahead recovery preserves original time and day; missing prefix refuses readiness', () => {
  const store = memoryStore(), log = make(store), first = entry(log, 1, '100'), put = store.put; let fail = true;
  store.put = (key, value) => { if (key === log.name && fail) throw Error('disk'); put(key, value); };
  assert.throws(() => log.append(first, 86500), /disk/); assert.equal(log.read().position, 0);
  fail = false; const restarted = make(store); restarted.append(first, 172800);
  assert.equal(restarted.read().completedAt, 86401);
  assert.throws(() => restarted.reference(head(restarted, 172800), 172800), /unavailable/);
  restarted.append(entry(restarted, 2, '200', 172800), 172800);
  assert.equal(restarted.reference(head(restarted, 172800), 172800).dayCount, 1);
  store.put(`${log.name}-entry-1`, null);
  assert.throws(() => restarted.reference(head(restarted, 172800), 172800), /prefix/);
});
