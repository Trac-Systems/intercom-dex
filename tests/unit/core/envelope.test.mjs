import test from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, createReplayCache, EnvelopeError } from '../../../src/core/envelope.js';
import { generateIdentity } from '../../../src/core/keys.js';
import { hex } from './helpers.mjs';

const message = () => seal({ kind: 'heartbeat', ch: 'intercom-dex:signers', body: { registryVersion: 1, software: '0.1.0', status: 'online', holdCount: 0 } },
  generateIdentity().secretKey, { ts: 1000, nonce: hex() });
test('signed envelope verifies and replay is sender/nonce scoped across channels', () => {
  const m = message(), seen = createReplayCache();
  assert.deepEqual(open(m, { now: 1000, seen }), m);
  assert.throws(() => open(m, { now: 1001, seen }), e => e instanceof EnvelopeError && e.code === 'replay');
  assert.equal(seen.size, 1);
  assert.doesNotThrow(() => open(m, { now: 880, seen: createReplayCache() }));
  assert.doesNotThrow(() => open(m, { now: 1120, seen: createReplayCache() }));
});
test('stale, replayed, bad signature, unknown kind and extra-key envelopes fail with typed errors', () => {
  const m = message();
  const check = (value, code, now = 1000) => assert.throws(() => open(value, { now, seen: createReplayCache() }), e => e.code === code);
  check(m, 'stale', 879); check(m, 'stale', 1121);
  check({ ...m, sig: '0'.repeat(128) }, 'bad-signature');
  check({ ...m, ch: 'another-channel' }, 'bad-signature');
  check({ ...m, from: 'ff'.repeat(32) }, 'bad-signature');
  check({ ...m, kind: 'unknown' }, 'unknown-kind');
  check({ ...m, extra: true }, 'schema');
  check({ ...m, body: { ...m.body, extra: true } }, 'schema');
  check({ ...m, ts: 1.5 }, 'schema');
  assert.throws(() => open(m, { now: 1000 }));
  assert.throws(() => seal({ kind: 'unknown', ch: 'x', body: {} }, generateIdentity().secretKey, { ts: 1, nonce: hex() }));
});
test('bounded replay cache expires only after final valid second and fails closed at capacity', () => {
  const seen = createReplayCache({ maxEntries: 1 });
  seen.consume('a', 10, 1);
  assert.throws(() => seen.consume('b', 12, 10), e => e.code === 'capacity');
  assert.throws(() => seen.consume('a', 10, 10), e => e.code === 'replay');
  seen.consume('b', 12, 11); assert.equal(seen.size, 1);
  assert.throws(() => seen.consume('c', 1, 2)); assert.throws(() => createReplayCache({ maxEntries: 0 }));
  assert.throws(() => seen.consume('a', 10, 9));
});
