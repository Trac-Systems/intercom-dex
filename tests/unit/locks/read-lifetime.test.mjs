import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Corestore from '../../../peer/node_modules/corestore/index.js';
import Hyperbee from '../../../peer/node_modules/hyperbee/index.js';
import PeerWallet from '../../../peer/node_modules/trac-wallet/index.js';
import { makeLocksHandlers, LOCKS_MAX_READS } from '../../../peer/features/locks-bridge.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const bootstrap = 'ab'.repeat(32), config = { trac: { reset: { bootstrap } } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { missing = true, bus = {}, readTimeoutMs = 20 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-h2-locks-'));
  const writer = new Corestore(path.join(directory, 'writer')), reader = new Corestore(path.join(directory, 'reader'));
  const encoding = { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false };
  const original = new Hyperbee(writer.get({ name: 'view' }), encoding), streams = [];
  let view;
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    await view?.close(); await original.close(); await reader.close(); await writer.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await original.put('beacon/state', { counted: 42 });
  await original.put('msgl', 0);
  const core = reader.get(original.core.key); await core.ready();
  const replicate = async () => {
    const a = writer.replicate(true), b = reader.replicate(false);
    streams.push(a, b); a.on('error', () => {}); b.on('error', () => {});
    a.pipe(b).pipe(a);
    for (let i = 0; i < original.core.length; i++) await core.get(i, { timeout: 1000 });
  };
  await replicate();
  for (const stream of streams) stream.destroy();
  await turn(); await turn();
  if (missing) await core.clear(1, core.length);
  view = new Hyperbee(core, encoding); await view.ready();
  const base = Object.assign(new EventEmitter(), { key: Buffer.from(bootstrap, 'hex'), view });
  const peer = { base };
  // Isolate these interactive requests; the index's distinct lifecycle is
  // covered below without leaving a 30-second background block read pending.
  const handlers = makeLocksHandlers({ bus, config, resetPeer: { base: { key: base.key, view } }, readTimeoutMs });
  return { handlers, core, peer, replicate };
}

test('repeated timed-out locks reads release real Hypercore sessions and recover after replication', async t => {
  const { handlers, core, replicate } = await fixture(t);
  const initial = core.sessions.length;
  for (let round = 0; round < 10; round++) {
    await Promise.all(Array.from({ length: 8 }, () => assert.rejects(handlers.locks_clock(), /Locks read timed out/)));
    await turn(); await turn();
    assert.equal(core.sessions.length, initial);
    assert.equal(core.activeRequests.length, 0);
  }
  await replicate();
  assert.deepEqual(await handlers.locks_clock(), { counted: 42, signedLength: core.signedLength });
  assert.equal(core.sessions.length, initial);
});

test('an uncancellable MSB read keeps its slot after the RESET checkout is closed', async t => {
  const gate = deferred();
  const bus = { state: { getNodeEntry: () => gate.promise, getFee: () => Buffer.alloc(16) } };
  const { handlers, core } = await fixture(t, { missing: false, bus });
  t.after(() => gate.resolve(null));
  const initial = core.sessions.length;
  const address = PeerWallet.encodeBech32mSafe('trac', Buffer.alloc(32, 2));
  await Promise.all(Array.from({ length: LOCKS_MAX_READS }, () =>
    assert.rejects(handlers.locks_balances({ address }), /Locks read timed out/)));
  await turn(); await turn();
  assert.equal(core.sessions.length, initial, 'all timed-out RESET checkouts close');
  for (let i = 0; i < 100; i++) await assert.rejects(handlers.locks_clock(), /Locks reader busy/);
  assert.equal(core.sessions.length, initial, 'retries allocate no new checkout');
  gate.resolve(null);
  await turn(); await turn();
  assert.equal((await handlers.locks_clock()).counted, 42);
  assert.equal(core.sessions.length, initial);
});

test('requests that time out before RESET opens cannot create late checkouts', async t => {
  const { peer, core } = await fixture(t, { missing: false });
  const gate = deferred();
  const handlers = makeLocksHandlers({ bus: {}, config, resetPeer: gate.promise, readTimeoutMs: 10 });
  const initial = core.sessions.length;
  await Promise.all(Array.from({ length: LOCKS_MAX_READS }, () => assert.rejects(handlers.locks_clock(), /timed out/)));
  assert.equal(core.sessions.length, initial);
  await assert.rejects(handlers.locks_clock(), /reader busy/);
  gate.resolve(peer);
  for (let i = 0; i < 10; i++) await turn();
  assert.equal((await handlers.locks_clock()).counted, 42);
  assert.equal(peer.base.listenerCount('update'), 1);
  assert.equal(core.sessions.length, initial);
});

test('a stalled close holds admission slots while callers still receive the deadline', async () => {
  const gate = deferred(); let opens = 0;
  const view = { core: { signedLength: 2 }, checkout() {
    opens++;
    return { version: 2, get: async () => ({ value: { counted: 42 } }), close: () => gate.promise };
  } };
  const handlers = makeLocksHandlers({ bus: {}, config, resetPeer: { base: { key: Buffer.from(bootstrap, 'hex'), view } }, readTimeoutMs: 10 });
  try {
    await Promise.all(Array.from({ length: LOCKS_MAX_READS }, () => assert.rejects(handlers.locks_clock(), /timed out/)));
    await assert.rejects(handlers.locks_clock(), /reader busy/);
    assert.equal(opens, LOCKS_MAX_READS);
  } finally { gate.resolve(); }
  await turn();
  assert.equal((await handlers.locks_clock()).counted, 42);
});

test('background indexing stays serialized and can outlive an interactive deadline', async () => {
  const gate = deferred(); let opens = 0, closes = 0;
  const view = { core: { signedLength: 2 }, checkout() {
    opens++;
    return { get: () => gate.promise, close: async () => { closes++; } };
  } };
  const base = Object.assign(new EventEmitter(), { key: Buffer.from(bootstrap, 'hex'), view });
  makeLocksHandlers({ bus: {}, config, resetPeer: { base }, readTimeoutMs: 10 });
  await new Promise(resolve => setTimeout(resolve, 30));
  for (let i = 0; i < 100; i++) base.emit('update');
  assert.equal(opens, 1); assert.equal(closes, 0); assert.equal(base.listenerCount('update'), 1);
  gate.resolve({ value: 0 });
  await turn(); await turn();
  assert.equal(opens, 2); assert.equal(closes, 2);
});
