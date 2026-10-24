import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PublicSend } from '../../../peer/features/sidechannel/public-send.js';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
import { dexTransport } from '../../../peer/features/dex-transport.js';
import { generateIdentity, encodeKey } from '../../../src/core/keys.js';
import { ed25519 } from '@noble/curves/ed25519.js';

const publicChannel = 'intercom-dex:offers', privateChannel = 'intercom-dex:t:' + 'b'.repeat(64);
const frame = (id, kind = 'book', body = {}) => ({ id, from: 'maker', message: { kind, body } });
function fixture(t, send) {
  let now = 0; const sent = [], connection = new EventEmitter();
  const record = { connection, channel: { opened: true } };
  const queue = new PublicSend({ rate: 100, burst: 200, maxQueue: 300, now: () => now,
    send: item => { sent.push(item.payload.id); return send?.(item); } });
  t.after(() => queue.close());
  return { queue, sent, record, connection, advance(ms) { now += ms; for (const state of queue.states.values()) queue.flush(state); },
    push: (payload, bytes = 100, other = record, authenticated = true) => queue.push(other, publicChannel, payload, 'relayed', bytes, authenticated) };
}

test('venue public channels share a per-connection burst and sustained rate; other connections have independent budgets', t => {
  const f = fixture(t);
  f.push(frame('one')); f.push(frame('two')); f.push(frame('three'));
  f.push(frame('other'), 100, { connection: new EventEmitter(), channel: { opened: true } });
  assert.deepEqual(f.sent, ['one', 'two', 'other']);
  assert.equal(f.queue.stats().queuedBytes, 100);
  f.advance(999); assert.equal(f.sent.length, 3);
  f.advance(1); assert.deepEqual(f.sent, ['one', 'two', 'other', 'three']);
  assert.equal(f.queue.stats().queuedBytes, 0);
  assert.equal(f.push(frame('too-large'), 201), false);
});

test('repeated offers coalesce without starving other offers, and cancellation replaces a queued announcement', t => {
  const f = fixture(t), offerId = 'a'.repeat(64);
  f.push(frame('one')); f.push(frame('two'));
  f.push(frame('offer', 'offer', { offerId })); f.push(frame('another'));
  f.push(frame('updated', 'offer', { offerId }));
  assert.equal(f.queue.stats().queuedBytes, 200);
  f.push(frame('cancelled', 'cancel', { offerId }));
  assert.equal(f.queue.stats().coalesced, 2);
  f.push(frame('delayed-reannouncement', 'offer', { offerId }));
  assert.equal(f.queue.stats().coalesced, 3);
  f.advance(1000); assert.deepEqual(f.sent, ['one', 'two', 'cancelled']);
  f.advance(1000); assert.equal(f.sent.at(-1), 'another');
});

test('queue overflow is bounded; a blocked stream waits for drain and closure releases all state', t => {
  let blocked = true; const f = fixture(t, () => { if (blocked) return false; });
  f.push(frame('one'));
  for (const id of ['two', 'three', 'four']) assert.equal(f.push(frame(id)), true);
  assert.equal(f.push(frame('five')), false); assert.equal(f.queue.stats().dropped, 1);
  f.advance(5000); assert.deepEqual(f.sent, ['one']);
  blocked = false; f.connection.emit('drain');
  assert.deepEqual(f.sent, ['one', 'two', 'three']);
  f.connection.emit('close'); assert.equal(f.queue.stats().queuedBytes, 0); assert.equal(f.queue.stats().peers, 0);
  f.advance(1000); assert.equal(f.sent.length, 3);
});

test('an unauthenticated sender cannot coalesce away an authenticated maker announcement', t => {
  const f = fixture(t), offerId = 'a'.repeat(64);
  f.push(frame('one')); f.push(frame('two'));
  f.push(frame('genuine', 'offer', { offerId }));
  f.push(frame('spoof', 'cancel', { offerId }), 100, f.record, false);
  assert.equal(f.queue.stats().coalesced, 0);
  f.advance(1000); assert.equal(f.sent.at(-1), 'genuine');
});

test('invalid rates or memory bounds are rejected before a timer can be scheduled', () => {
  for (const config of [{ rate: 0 }, { burst: -1 }, { maxQueue: 1 }, { rate: Infinity }])
    assert.throws(() => new PublicSend({ ...config, send() {} }), /Invalid public send limits/);
});

test('a throwing transport cannot crash an asynchronous queue flush', t => {
  const f = fixture(t, () => { throw new Error('closed transport'); });
  assert.doesNotThrow(() => f.push(frame('one')));
  assert.equal(f.queue.stats().dropped, 1); assert.equal(f.queue.stats().peers, 0);
});

test('only venue public sends are paced; private trade traffic bypasses a full public queue', async t => {
  const config = dexTransport({ role: 'service', servicePeerKey: 'a'.repeat(64) }).sidechannel;
  const sc = new Sidechannel({}, { ...config, powEnabled: false, publicSend: { rate: 1, burst: 100, maxQueue: 300 } });
  t.after(() => sc.stop());
  const sent = [], record = { connection: new EventEmitter(), channel: { opened: true }, message: { send: p => sent.push(p.id) } };
  sc._send(record, publicChannel, frame('first'));
  sc._send(record, publicChannel, frame('second'));
  assert.deepEqual(sent, ['first']); assert.ok(sc.publicSend.stats().queuedBytes > 0);
  sc._send(record, privateChannel, frame('terms'));
  assert.deepEqual(sent, ['first', 'terms']);
  for (const role of ['trader', 'signer', 'market-feed']) assert.equal(dexTransport({ role, servicePeerKey: 'a'.repeat(64) }).sidechannel.publicSend, undefined);
});

test('sidechannel fanout authenticates coalescing: a forged transport signature cannot replace a signed offer', async t => {
  const identity = generateIdentity(), key = encodeKey(identity.publicKey);
  const config = dexTransport({ role: 'service', servicePeerKey: key }).sidechannel;
  const sc = new Sidechannel({ wallet: { publicKey: key, sign: bytes => Buffer.from(ed25519.sign(bytes, identity.secretKey)) } }, { ...config, powEnabled: false });
  t.after(() => sc.stop()); sc._now = () => 1000;
  const record = { connection: new EventEmitter(), channel: { opened: true }, message: { send() {} } };
  const message = price => ({ kind: 'offer', body: { offerId: 'a'.repeat(64), price } });
  sc._send(record, publicChannel, await sc._buildPayload(publicChannel, message('0')));
  const state = sc.publicSend.states.get(record.connection); state.tokens = 0;
  const real = await sc._buildPayload(publicChannel, message('1'));
  sc._send(record, publicChannel, real);
  sc._send(record, publicChannel, { ...real, id: 'forged', message: message('999') });
  assert.equal(state.queue.size, 2); assert.equal(sc.publicSend.stats().coalesced, 0);
  sc._send(record, publicChannel, await sc._buildPayload(publicChannel, message('2')));
  assert.equal(state.queue.size, 2); assert.equal(sc.publicSend.stats().coalesced, 1);
});

test('queued public PoW frames expire before send while fresh frames continue', async t => {
  let now = 1000;
  const sc = new Sidechannel({}, dexTransport({ role: 'service', servicePeerKey: 'a'.repeat(64) }).sidechannel);
  t.after(() => sc.stop()); sc._now = () => now;
  const sent = [], record = { connection: new EventEmitter(), channel: { opened: true }, message: { send: p => sent.push(p.id) } };
  sc._send(record, publicChannel, { ...frame('initial'), ts: now });
  const state = sc.publicSend.states.get(record.connection); state.tokens = 0;
  sc._send(record, publicChannel, { ...frame('expired'), ts: now });
  sc._send(record, publicChannel, { ...frame('fresh'), ts: 70000 });
  now = 70000; sc.publicSend.flush(state);
  assert.deepEqual(sent, ['initial', 'fresh']);
  assert.equal(sc.publicSend.stats().dropped, 1); assert.equal(state.bytes, 0);
});
