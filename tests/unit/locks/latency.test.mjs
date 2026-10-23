import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { LockVenue } from '../../../src/roles/lock-venue.js';
import { MAIN, seal, receiver } from '../../../src/locks/transport.js';
import { identity, box, registry, memoryStore } from './helpers.mjs';
import { fixture, position, terms } from '../locks-products/helpers.mjs';
import { stack } from '../../integration/locks/harness.mjs';
import { LocksClient } from '../../../src/locks/client.js';

test('venue book reads finish while a settlement send is waiting', async () => {
  const key = identity(), requester = identity(), sent = [];
  const venue = new LockVenue({ identity: key, registryInput: registry(Array.from({ length: 5 }, () => ({ identity: identity(), box: box() }))),
    store: memoryStore(), now: () => 1000, bridge: { send: async (_ch, raw) => { sent.push(raw); } } });
  let unblock;
  const pending = venue.enqueue(() => new Promise(resolve => { unblock = resolve; }));
  await turn();
  const read = venue.handle(MAIN, seal({ ch: MAIN, kind: 'bookRequest', body: { page: 0, limit: 100 } }, requester.secretKey, { ts: 1000 }));
  const ready = await Promise.race([read.then(() => true), turn().then(() => false)]);
  unblock(); await pending; await read;
  assert.equal(ready, true, 'read-only book must not wait for queued network work');
  assert.equal(sent.at(-1).kind, 'book');
});

test('trader book reads finish while a wallet operation is waiting', async () => {
  const f = fixture(); let unblock;
  f.client.queue = new Promise(resolve => { unblock = resolve; });
  f.options.transport.requestBook = async () => ({ auth: true, ch: MAIN, from: f.options.venueKey, kind: 'book',
    body: { page: 0, pageSize: 100, total: 0, positions: [], requester: f.me.lockKey } });
  const read = f.client.refreshBook();
  const ready = await Promise.race([read.then(() => true), turn().then(() => false)]);
  unblock(); await read;
  assert.equal(ready, true, 'book evidence must not wait for the wallet queue');
});

test('saved release pickup does not wait behind unrelated venue network work', async t => {
  const s = await stack(); t.after(s.stop);
  const id = await s.post(); await s.emit(s.clients[0], 'cancel', { positionId: id }); await s.drain();
  let unblock;
  const pending = s.venue.enqueue(() => new Promise(resolve => { unblock = resolve; }));
  await turn();
  const read = s.venue.handle(MAIN, seal({ ch: MAIN, kind: 'releaseRequest', body: { positionId: id } }, s.clients[0].identity.secretKey, { ts: s.time.now }));
  const ready = await Promise.race([read.then(() => true), turn().then(() => false)]);
  unblock(); await pending; await read;
  assert.equal(ready, true, 'pickup must begin before the client leaves its temporary channel');
});

test('pickup of a confirmed take omits the opening proofs already held by the requester', async t => {
  const s = await stack(); t.after(s.stop);
  const id = await s.post(), takeId = await s.take(id); await s.pay(id, 'open:' + takeId); await s.pay(id, 'repay');
  s.chain.counted = 106;
  for (const signer of s.signers) await signer.reconcile(); await s.drain();
  const start = s.sent.length;
  await s.venue.handle(MAIN, seal({ ch: MAIN, kind: 'releaseRequest', body: { positionId: id, takeId, pickup: 'release' } }, s.clients[0].identity.secretKey, { ts: s.time.now }));
  assert.equal(s.sent.slice(start).filter(row => row.raw.kind === 'opened').length, 0);
  assert.equal(s.sent.slice(start).filter(row => row.raw.kind === 'release').length, 5);
});

test('book pages and credit status do not read terminal records or decrypt registry snapshots', async () => {
  const key = identity(), requester = identity(), sent = [], store = memoryStore();
  const venue = new LockVenue({ identity: key, registryInput: registry(Array.from({ length: 5 }, () => ({ identity: identity(), box: box() }))),
    store, now: () => 1000, bridge: { send: async (_ch, raw) => { sent.push(raw); } } });
  for (let i = 1; i <= 1000; i++) venue.save({ positionId: i.toString(16).padStart(64, '0'),
    post: { product: 'loan', registryVersion: 1, terms: { asset: 'RESET' } }, state: 'ended:repaid', releases: {}, creditsFinal: true,
    endedAt: 900, fee: '10', credits: { [key.publicKey]: '4' }, venueCredit: '6' });
  const id = 'ff'.repeat(32);
  venue.save({ positionId: id, post: { product: 'call', terms: { asset: 'TNK' } }, state: 'posted', lock: {}, posted: {}, releases: {} });
  store.get = () => { throw Error('request decrypted a record'); };
  assert.equal(venue.status().signerCredits[key.publicKey].length, 1000);
  venue.positions.values = () => { throw Error('book scanned history'); };
  await venue.handle(MAIN, seal({ ch: MAIN, kind: 'bookRequest', body: { page: 0, asset: 'TNK' } }, requester.secretKey, { ts: 1000 }));
  assert.deepEqual(sent.at(-1).body.positions.map(p => p.positionId), [id]);
});

test('clock reconciliation excludes terminal client and signer history', async t => {
  const f = fixture(), p = position('loan', f.me, f.reg); p.state = 'released'; f.put(p);
  f.client.positions.values = () => { throw Error('client scanned terminal history'); };
  await f.client.onClock();
  const s = await stack(); t.after(s.stop);
  const id = await s.post(); await s.emit(s.clients[0], 'cancel', { positionId: id }); await s.drain();
  for (const signer of s.signers) {
    signer.positions.values = () => { throw Error('signer scanned terminal history'); };
    await signer.reconcile();
  }
});

test('completed receipt recovery forwards saved proofs without requesting a whole quorum or blocking new posts', async () => {
  const f = fixture(), p = position('loan', f.me, f.reg), forwarded = [];
  p.state = 'released'; p.winner = 'maker'; p.outcome = 'repaid'; p.collectedAt = f.time.now;
  p.lock = { Q: [1, 2, 3, 4, 5] }; p.operations.sweep = { status: 'confirmed' }; p.receipts = {}; p.releaseProofs = {};
  for (const j of p.lock.Q) {
    p.receipts[`:${j}`] = { positionId: p.positionId, j, releaseHash: String(j) };
    p.releaseProofs[`:${j}`] = { from: p.committee[j - 1].lockKey, kind: 'release', body: { j } };
  }
  f.put(p); await f.client.requestRelease(p.positionId); f.sent.length = 0; f.time.now += 61;
  f.client.registry.offer = () => false;
  f.options.transport.forward = async (_ch, raw) => { forwarded.push(raw); };
  let unblock, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const send = f.options.transport.send;
  f.options.transport.send = async (...args) => {
    if (args[1] === 'releaseReceipt' && !unblock) { started(); await new Promise(resolve => { unblock = resolve; }); }
    return send(...args);
  };
  const replay = f.client.receive(MAIN, { auth: true, ch: MAIN, from: f.client.venueKey, kind: 'registry', body: {} });
  await waiting;
  const post = f.client.post({ product: 'loan', terms: terms('loan') });
  const ready = await Promise.race([post.then(() => true), turn().then(() => false)]);
  unblock(); await replay; await post; await f.client.stop();
  assert.equal(ready, true);
  assert.equal(forwarded.length, 5);
  assert.equal(f.sent.filter(([, kind, body]) => kind === 'releaseRequest' && body.pickup !== 'receipts').length, 0);
  assert.equal(f.sent.filter(([, kind, body]) => kind === 'releaseRequest' && body.pickup === 'receipts').length, 1);
  assert.equal(f.sent.filter(([, kind]) => kind === 'releaseReceipt').length, 5);
});

test('saved release evidence can recover a venue after envelope expiry without weakening replay or signature checks', async t => {
  const s = await stack(); t.after(s.stop);
  const id = await s.post(); await s.emit(s.clients[0], 'cancel', { positionId: id }); await s.drain();
  const raw = s.sent.find(row => row.raw.kind === 'release').raw;
  s.time.now += 121;
  assert.equal(receiver(() => s.time.now)(raw), null);
  const receive = receiver(() => s.time.now, { historical: ['release'] });
  assert.equal(receive(raw).from, raw.from); assert.equal(receive(raw), null);
  assert.equal(receive({ ...raw, body: { ...raw.body, winner: 'taker' } }), null);
  const signer = s.signers.find(signer => signer.identity.publicKey === raw.from);
  assert.equal(receive(seal({ ch: raw.ch, kind: raw.kind, body: raw.body }, signer.identity.secretKey, { ts: s.time.now + 121 })), null);
  s.time.now += 121;
  assert.equal(receive(raw).from, raw.from, 'historical replay entries expire rather than filling a permanent cache');
});

test('missing receipt evidence takes priority over replaying completed position history', async t => {
  const f = fixture(); f.options.transport.forward = async () => {};
  f.options.registry.offer = () => false;
  const add = (count, lastReceiptReplay) => {
    const p = position('loan', f.me, f.reg);
    Object.assign(p, { state: 'released', winner: 'maker', outcome: 'repaid', collectedAt: 1000, lastReceiptReplay,
      lock: { Q: [1, 2, 3, 4, 5] }, receipts: {}, releaseProofs: {}, operations: { sweep: { status: 'confirmed' } } });
    for (let j = 1; j <= count; j++) {
      p.receipts[`:${j}`] = { positionId: p.positionId, j, releaseHash: String(j) };
      p.releaseProofs[`:${j}`] = { kind: 'release', body: { j } };
    }
    f.put(p); return p;
  };
  for (let i = 0; i < 100; i++) add(5, 999);
  const pending = add(3, 1000); f.time.now = 1061;
  const client = new LocksClient(f.options); t.after(() => client.stop());
  await client.receive(MAIN, { auth: true, ch: MAIN, from: client.venueKey, kind: 'registry', body: {} });
  assert.deepEqual(f.sent.filter(([, kind]) => kind === 'releaseRequest').map(([, , body]) => body.positionId), [pending.positionId]);
});

test('failed DKG positions without a lock stay out of reconciliation', async t => {
  const f = fixture(); t.after(() => f.client.stop());
  f.put({ ...position('loan', f.me, f.reg), state: 'ended:unfunded', opened: false, funded: false });
  await f.client.onClock();
  assert.equal(f.sent.length, 0, 'there is no funded lock or decision left to recover');
  assert.equal(f.client.positions.active.size, 0);
});

test('receipt replay wakes a returning venue before forwarding saved evidence', async t => {
  const f = fixture(); t.after(() => f.client.stop());
  const p = position('loan', f.me, f.reg);
  Object.assign(p, { state: 'released', winner: 'maker', outcome: 'repaid', collectedAt: 1000,
    lock: { Q: [1, 2, 3, 4, 5] }, receipts: {}, releaseProofs: {}, operations: { sweep: { status: 'confirmed' } } });
  for (const j of p.lock.Q) {
    p.receipts[`:${j}`] = { positionId: p.positionId, j, releaseHash: String(j) };
    p.releaseProofs[`:${j}`] = { kind: 'release', body: { j } };
  }
  f.put(p); await f.client.requestRelease(p.positionId); f.sent.length = 0; f.time.now += 61;
  let watching = false; const delivered = [], send = f.options.transport.send;
  f.options.transport.send = async (...args) => {
    if (args[0] === MAIN && args[1] === 'releaseRequest' && args[2].pickup === 'receipts') watching = true;
    return send(...args);
  };
  f.options.transport.forward = async (_ch, proof) => { if (watching) delivered.push(proof); };
  f.client.registry.offer = () => false;
  await f.client.receive(MAIN, { auth: true, ch: MAIN, from: f.client.venueKey, kind: 'registry', body: {} });
  assert.equal(delivered.length, 5, 'a restarted venue is not subscribed to historical position channels');
  assert.equal(f.sent.filter(([, kind, body]) => kind === 'releaseRequest' && body.pickup !== 'receipts').length, 0);
});

test('a slow chain check on one position does not hold up a new lock request', async t => {
  const s = await stack(); t.after(s.stop);
  const first = await s.post(), signer = s.signers[0];
  let release; const stuck = new Promise(resolve => { release = resolve; });
  signer.evaluate = () => stuck;
  // The periodic round runs from the signer's heartbeat work, as in production.
  const round = signer.enqueue(() => signer.reconcile());
  const second = await Promise.race([s.post(), new Promise(resolve => setTimeout(() => resolve(null), 3000))]);
  assert.ok(second, 'the new position was handled while the first one was still being checked');
  assert.ok(signer.positions.get(second), 'the signer joined the new position');
  release(); await round;
  assert.ok(signer.positions.get(first));
});
