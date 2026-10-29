import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Hypercore from '../../../peer/node_modules/hypercore/index.js';
import Hyperbee from '../../../peer/node_modules/hyperbee/index.js';
import { signedBalanceRead, readBalances } from '../../../peer/src/trac/balances.js';
import { createReadRecovery } from '../../../peer/runtime/read-recovery.js';

const turn = () => new Promise(resolve => setImmediate(resolve));

test('many sellers at a frozen 1.75M signed root recover within the original deadline, with one transport repair', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const waiting = new Set(), lengths = [], samples = [], stalls = [];
  let closes = 0, joins = 0, served = false, refreshes = 0;
  const base = { view: { core: { signedLength: 1746752 }, checkout(length) {
    lengths.push(length);
    return { get(_key, { onseq, onwait, update }) {
      assert.equal(update, false);
      onseq(length - 1);
      if (served) return Promise.resolve({ value: '123' });
      onwait(length - 1);
      return new Promise(resolve => waiting.add(resolve));
    }, close: async () => { closes++; } };
  } } };
  // Repeated cross-seller timeouts share one signed root.
  for (let round = 0; round < 2; round++) {
    const failed = Promise.all(Array.from({ length: 16 }, (_, i) =>
      assert.rejects(signedBalanceRead(base, `bal/${i}`, 'RESET'), error => {
        assert.equal(error.code, 'BALANCE_READ_TIMEOUT'); assert.equal(error.waitingSeq, 1746751); return true;
      })));
    await turn(); t.mock.timers.tick(5000); await failed;
  }
  const topic = Buffer.alloc(32, 1), peer = { publicKey: Buffer.alloc(32, 2), topics: [topic] };
  const recover = createReadRecovery({ base, topic, label: 'RESET', log() {},
    discovery: { refresh() { refreshes++; return new Promise(() => {}); } },
    swarm: { connections: new Set(), peers: new Map([['peer', peer]]),
      joinPeer() { joins++; served = true; for (const resolve of waiting) resolve({ value: '123' }); waiting.clear(); }, leavePeer() {} } });
  const reads = Array.from({ length: 16 }, (_, i) => signedBalanceRead(base, `bal/${i}`, 'RESET', 5000,
    { onStall: event => { stalls.push(event); recover(event); }, onRead: sample => samples.push(sample) }));
  await turn(); t.mock.timers.tick(999); assert.equal(joins, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(await Promise.all(reads), Array(16).fill({ value: '123' }));
  assert.equal(joins, 1); assert.equal(refreshes, 1, 'a hung discovery must not prevent the known-peer retry');
  assert.equal(closes, 48); assert.equal(lengths.length, 48, 'no restart or moving-tip retry');
  assert.ok(stalls.every(s => s.waitingSeq === 1746751 && s.elapsedMs === 1000));
  assert.ok(samples.every(s => s.code === null && s.elapsedMs === 1000 && s.blockReads === 1));
  base.view.core.signedLength++;
  await signedBalanceRead(base, 'bal/0', 'RESET');
  assert.equal(lengths.at(-1), 1746753, 'subsequent financial reads take a new signed snapshot');
});

test('ordinary block progress, local I/O and snapshot cleanup do not trigger early transport repair', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let options, resolveRead, resolveClose, repairs = 0;
  const base = { view: { core: { signedLength: 1746752 }, checkout: () => ({
    get(_key, o) { options = o; return new Promise(resolve => { resolveRead = resolve; }); },
    close: () => new Promise(resolve => { resolveClose = resolve; }),
  }) } };
  const read = signedBalanceRead(base, 'bal/a', 'RESET', 5000, { onStall: () => { repairs++; } });
  await turn();
  t.mock.timers.tick(1000); assert.equal(repairs, 0, 'no missing-block evidence');
  options.onseq(1746751); options.onwait(1746751);
  t.mock.timers.tick(900); options.onseq(400); options.onwait(400);
  t.mock.timers.tick(900); resolveRead(null); await turn();
  t.mock.timers.tick(1000); assert.equal(repairs, 0, 'progress and then cleanup cancel the stall alarm');
  resolveClose(); assert.equal(await read, null);
  t.mock.timers.tick(5000); assert.equal(repairs, 0, 'no late repair after read completion');
});

test('failed early repair cannot extend the deadline, replace the error, leak a checkout or hide telemetry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let options, closes = 0, repairs = 0;
  const samples = [];
  const base = { view: { core: { signedLength: 9 }, checkout: () => ({
    get(_key, o) { options = o; o.onseq(8); o.onwait(8); return new Promise(() => {}); },
    close: async () => { closes++; },
  }) } };
  const failed = assert.rejects(signedBalanceRead(base, 'bal/a', 'RESET', 5000, {
    onStall: async () => { repairs++; throw new Error('repair unavailable'); },
    onRead: sample => { samples.push(sample); throw new Error('logger unavailable'); },
  }), error => error.code === 'BALANCE_READ_TIMEOUT' && error.stage === 'read' && error.waitingSeq === 8);
  await turn(); t.mock.timers.tick(1000); await turn(); assert.equal(repairs, 1);
  t.mock.timers.tick(4000); await failed; await turn();
  assert.equal(closes, 1); assert.equal(samples[0].elapsedMs, 5000);
  options.onwait(8); t.mock.timers.tick(5000); assert.equal(repairs, 1);
});

test('readBalances wires missing-block recovery to both owners without waiting for failure', async () => {
  const samples = [], repairs = [], owners = ['MSB', 'RESET'].map(label => {
    let resolveRead;
    return { base: { view: { core: { signedLength: 2 }, checkout: () => ({
      get(_key, { onseq, onwait }) { onseq(1); onwait(1); return new Promise(resolve => { resolveRead = resolve; }); },
      close: async () => {},
    }) } }, recoverRead(event) { repairs.push([label, event.code]); resolveRead(null); },
    observeRead(sample) { samples.push([label, sample.code]); } };
  });
  const [msb, resetPeer] = owners, bus = { ...msb, state: { base: msb.base, getFee: () => Buffer.alloc(16) } };
  assert.deepEqual(await readBalances({ bus, resetPeer, address: 'account', key: Buffer.alloc(32) }), { TNK: '0', RESET: '0', feeTnk: '0' });
  assert.deepEqual(repairs, [['MSB', 'BALANCE_READ_STALLED'], ['RESET', 'BALANCE_READ_STALLED']]);
  assert.deepEqual(samples, [['MSB', null], ['RESET', null]]);
});

test('a real sparse multi-level signed tree reads during replica rotation, fetching only its lookup path', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-balance-stall-'));
  const writer = new Hypercore(path.join(directory, 'writer'));
  await writer.ready();
  const original = new Hyperbee(writer, { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false });
  const batch = original.batch();
  for (let i = 0; i < 2048; i++) await batch.put(`bal/${String(i).padStart(4, '0')}`, String(i + 1));
  await batch.flush(); await batch.close();
  const reader = new Hypercore(path.join(directory, 'reader'), writer.key);
  await reader.ready();
  const streams = [];
  const connect = () => {
    const a = writer.replicate(true), b = reader.replicate(false);
    for (const stream of [a, b]) { stream.on('error', () => {}); streams.push(stream); }
    a.pipe(b).pipe(a);
  };
  let replica;
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    await replica?.close(); await original.close(); await reader.close(); await writer.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  connect(); await reader.get(0, { timeout: 1000 }); await reader.get(writer.length - 1, { timeout: 1000 });
  for (const stream of streams) stream.destroy();
  await turn(); await turn(); await reader.clear(1, reader.length);
  replica = new Hyperbee(reader, { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false });
  await replica.ready();
  const base = { view: replica }, sessions = reader.sessions.length, samples = [], downloads = [];
  reader.on('download', index => downloads.push(index));
  const topic = Buffer.alloc(32, 1), known = Buffer.alloc(32, 2);
  let retired = 0, joins = 0, snapshotLength;
  const connections = new Set();
  // Three sockets can exist without any of them serving this view's missing block.
  for (let i = 3; i < 6; i++) {
    const socket = Object.assign(new EventEmitter(), { remotePublicKey: Buffer.alloc(32, i), destroy() {
      retired++; this.destroyed = true; connections.delete(this); this.emit('close');
    } });
    connections.add(socket);
  }
  const recover = createReadRecovery({ base, topic, label: 'RESET', rotate: true, log() {},
    discovery: { refresh: () => new Promise(() => {}) }, swarm: { connections, maxPeers: 3, maxClientConnections: 3,
      peers: new Map([['serving', { publicKey: known, topics: [topic] }]]),
      joinPeer() { joins++; connect(); }, leavePeer() {} } });
  const result = await signedBalanceRead(base, 'bal/1234', 'RESET', 2000, { stallMs: 20,
    onStall: event => { snapshotLength = event.signedLength; recover(event); }, onRead: sample => samples.push(sample) });
  assert.equal(result.value, '1235'); assert.equal(retired, 1); assert.equal(joins, 1);
  assert.equal(snapshotLength, writer.signedLength); assert.equal(samples[0].signedLength, snapshotLength);
  assert.ok(samples[0].blockReads < 100); assert.ok(samples[0].blockWaits > 0);
  assert.ok(downloads.length > 0 && downloads.length < 100, `bounded lookup downloaded ${downloads.length} of ${writer.length} blocks`);
  assert.equal(downloads[0], writer.length - 1, 'start at the signed root, not block zero');
  await turn(); await turn(); assert.equal(reader.sessions.length, sessions);
  assert.equal((await signedBalanceRead(base, 'bal/1234', 'RESET')).value, '1235');
  assert.equal(joins, 1, 'local reads do not rotate serving replicas');
});
