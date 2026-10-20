import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import b4a from '../../../peer/node_modules/b4a/index.js';
import sodium from '../../../peer/node_modules/sodium-universal/index.js';
import c from '../../../peer/node_modules/compact-encoding/index.js';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
import { PowSearch } from '../../../peer/features/sidechannel/pow-search.js';
import { PowWorker, powWorker } from '../../../peer/features/sidechannel/pow-client.js';
import { OldPowSearch, oldAttachPow, fixture } from './pow-reference.mjs';
import { runBare } from './pow-bare.mjs';

test('old, allocation-free and worker stamping produce the same first nonce and exact wire bytes', async () => {
  for (let n = 0; n < 48; n++) {
    const difficulty = n < 45 ? [1, 4, 9, 12][n % 4] : 20;
    const sc = new Sidechannel({}, { powEnabled: true, powDifficulty: difficulty });
    sc._now = () => 100000;
    const expected = fixture(n), actual = structuredClone(expected);
    await oldAttachPow.call(sc, expected);
    await sc._attachPow(actual);
    const search = new PowSearch(...sc._powParts(actual));
    assert.equal(search.run(difficulty, Infinity), expected.pow.nonce);
    assert.deepEqual(actual, expected);
    assert.deepEqual(c.encode(c.json, actual), c.encode(c.json, expected));
    assert.equal(sc._checkPow(actual, actual.channel), true);
  }
});

test('all sidechannels share one worker and never hash on the main thread', async t => {
  t.mock.method(sodium, 'crypto_hash_sha256_final', () => { throw Error('main-thread hashing'); });
  const channels = [new Sidechannel({}, { powEnabled: true, powDifficulty: 9 }), new Sidechannel({}, { powEnabled: true, powDifficulty: 9 })];
  for (const sc of channels) sc._now = () => 100000;
  const payloads = [fixture(0), fixture(1)];
  await Promise.all(channels.map((sc, i) => sc._attachPow(payloads[i])));
  const worker = powWorker.worker;
  await channels[0]._attachPow(fixture(2));
  assert.equal(powWorker.worker, worker);
  assert.equal(powWorker.jobs.size, 0);
  for (let i = 0; i < channels.length; i++) assert.equal(channels[i]._checkPow(payloads[i], payloads[i].channel), true);
});

test('an urgent stamp overtakes a real sliced search and the background keeps its original first nonce', async t => {
  const sc = new Sidechannel({}, { powEnabled: true, powDifficulty: 20, powClasses: [['urgent']] });
  sc._now = () => 100000;
  t.mock.method(sc, '_buildPayload', async (channel, message) => {
    const payload = { channel, from: 'a'.repeat(64), id: 'benchmark-0', message, origin: 'a'.repeat(64), ts: 100000 };
    await sc._attachPow(payload); return payload;
  });
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const slice = powWorker.slice.bind(powWorker);
  t.mock.method(powWorker, 'slice', async job => {
    const result = await slice(job);
    if (result.nonce === -1) started();
    return result;
  });
  const order = [];
  const background = sc._stampedPayload('intercom-dex:signers', { kind: 'heartbeat', text: 'é🦊' }).then(p => { order.push('background'); return p; });
  await running;
  // The running stamp captured difficulty 20; keep the overtaking job short.
  sc.powDifficulty = 4;
  const urgent = sc._stampedPayload('intercom-dex:signers', { kind: 'urgent' }).then(p => { order.push('urgent'); return p; });
  const [stamped] = await Promise.all([background, urgent]);
  assert.deepEqual(order, ['urgent', 'background']);
  assert.equal(stamped.pow.nonce, 876233);
  assert.equal(stamped.pow.difficulty, 20);
  assert.deepEqual(sc.powPending, [0, 0, 0]);
});

test('worker slices preserve their cursor, reset on refresh and release completed jobs', async t => {
  const client = new PowWorker(); t.after(() => client.close());
  const job = await client.open('{"nonce":', ',"ts":100000}', 256);
  const first = await client.slice(job), second = await client.slice(job);
  assert.equal(first.nonce, -1); assert.equal(second.nonce, -1);
  assert.ok(first.nextNonce >= 256); assert.ok(second.nextNonce > first.nextNonce);
  assert.equal(first.nextNonce % 256, 0); assert.equal(second.nextNonce % 256, 0);
  client.prepare(job, '{"nonce":', ',"ts":130000}', 0);
  assert.equal((await client.slice(job)).nonce, 0);
  client.release(job);
  assert.equal(client.jobs.size, 0);
  await assert.rejects(client.slice(job), /closed/);
});

test('worker job errors reject clearly without poisoning the next search', async t => {
  const client = new PowWorker(); t.after(() => client.close());
  const job = await client.open('{"nonce":', '}', 9);
  job.prepare = null;
  await assert.rejects(client.slice(job), /Unknown PoW job/);
  await assert.rejects(client.slice(job), /Unknown PoW job/);
  client.release(job);
  const next = await client.open('{"nonce":', '}', 0);
  assert.equal((await client.slice(next)).nonce, 0);
  client.release(next);
});

test('closing a worker rejects in-flight work and duplicate slices; a new stamp restarts it', async t => {
  const client = new PowWorker(); t.after(() => client.close());
  const job = await client.open('{"nonce":', '}', 256), old = client.worker;
  const pending = client.slice(job);
  const rejected = assert.rejects(pending, /worker closed/);
  await assert.rejects(client.slice(job), /already pending/);
  const closing = client.close();
  const next = await client.open('{"nonce":', '}', 0);
  await closing; await rejected;
  assert.notEqual(client.worker, old);
  assert.equal((await client.slice(next)).nonce, 0);
  client.release(next);
});

test('unexpected worker exit invalidates suspended stamps and the next stamp creates one replacement', async t => {
  const client = new PowWorker(); t.after(() => client.close());
  const job = await client.open('{"nonce":', '}', 256), old = client.worker;
  await client.slice(job);
  const exited = new Promise(resolve => old.once('exit', resolve));
  old.ref(); old.terminate(); await exited;
  await assert.rejects(client.slice(job), /worker exited/);
  const next = await client.open('{"nonce":', '}', 0);
  assert.notEqual(client.worker, old);
  assert.equal((await client.slice(next)).nonce, 0);
  client.release(next);
});

test('worker failure clears the stamp cache and queue so identical messages can retry', async t => {
  const sc = new Sidechannel({}, { powEnabled: true, powDifficulty: 9 });
  const slice = powWorker.slice.bind(powWorker);
  const fail = t.mock.method(powWorker, 'slice', async job => {
    const pending = slice(job);
    const closing = powWorker.close();
    try { return await pending; } finally { await closing; }
  });
  await assert.rejects(sc._stampedPayload('test', { kind: 'heartbeat' }), /worker closed/);
  assert.equal(sc.stamped.size, 0); assert.equal(sc.stampedBytes, 0);
  assert.deepEqual(sc.powPending, [0, 0]);
  fail.mock.restore();
  const payload = await sc._stampedPayload('test', { kind: 'heartbeat' });
  assert.equal(sc._checkPow(payload, 'test'), true);
});

test('Bare runs the same equivalence fixtures, worker interruption, refresh and restart checks', async () => {
  const entry = fileURLToPath(new URL('./pow-runtime.mjs', import.meta.url));
  const { stdout } = await runBare(entry);
  assert.deepEqual(JSON.parse(stdout.trim()), { runtime: 'Bare', equivalent: 48, restart: true, priorities: true });
});

test('decimal carries keep canonical UTF-8 bytes and first nonce across digit boundaries', () => {
  const sc = new Sidechannel({});
  for (const boundary of [10, 100, 1000, 10000, 100000, 1000000, 10000000]) {
    const payload = fixture(boundary % 48), parts = sc._powParts(payload);
    const search = new PowSearch(...parts, boundary - 2);
    const old = new OldPowSearch(...parts, boundary - 2);
    assert.equal(search.run(256, Infinity, boundary + 2), -1);
    assert.equal(old.run(256, Infinity, boundary + 2), -1);
    assert.equal(search.nonce, boundary + 2);
    assert.equal(b4a.toString(search.tail), search.nonce + parts[1]);
    assert.deepEqual(search.hash, old.hash);
    assert.deepEqual(search.hash, crypto.createHash('sha256').update(sc._powBase(payload, boundary + 1)).digest());
    assert.equal(search.run(9, Infinity), old.run(9, Infinity));
  }
});

test('the nonce loop reuses buffers and allocates only when decimal width grows', t => {
  const search = new PowSearch('{"nonce":', ',"ts":100000}', 1000);
  const tail = search.tail, base = search.base, state = search.state, hash = search.hash;
  const from = t.mock.method(b4a, 'from'), alloc = t.mock.method(b4a, 'allocUnsafe');
  search.run(256, Infinity, 9999);
  assert.equal(search.tail, tail);
  assert.equal(from.mock.callCount(), 0); assert.equal(alloc.mock.callCount(), 0);
  search.run(256, Infinity, 10001);
  assert.equal(from.mock.callCount(), 0); assert.equal(alloc.mock.callCount(), 1);
  assert.equal(search.base, base); assert.equal(search.state, state); assert.equal(search.hash, hash);
});

test('an exhausted eight-millisecond slice stops at the next 256-nonce boundary and resumes in order', t => {
  t.mock.method(sodium, 'crypto_hash_sha256_final', (_state, hash) => hash.fill(255));
  const search = new PowSearch('{"nonce":', '}', 999);
  assert.equal(search.run(20, 0), -1); assert.equal(search.nonce, 1024);
  assert.equal(search.run(20, 0), -1); assert.equal(search.nonce, 1280);
});

test('timestamp refresh resets the nonce and retains old wire bytes at exactly thirty seconds', async () => {
  for (const age of [29999, 30000, 60000]) {
    const sc = new Sidechannel({}, { powEnabled: true, powDifficulty: 9 });
    sc._now = () => 100000 + age;
    const expected = fixture(1), actual = structuredClone(expected);
    await oldAttachPow.call(sc, expected); await sc._attachPow(actual);
    assert.deepEqual(c.encode(c.json, actual), c.encode(c.json, expected));
    assert.equal(actual.ts, age < 30000 ? 100000 : 100000 + age);
  }
});
