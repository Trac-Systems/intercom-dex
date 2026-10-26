import test from 'node:test';
import assert from 'node:assert/strict';
import { signedBalanceRead, readBalances } from '../../../peer/src/trac/balances.js';
import { makeHandlers } from '../../../peer/src/trac/handlers.js';
import PeerWallet from '../../../peer/node_modules/trac-wallet/index.js';
import nodeEntry from '../../../peer/node_modules/trac-msb/src/core/state/utils/nodeEntry.js';
import Hypercore from '../../../peer/node_modules/hypercore/index.js';
import Hyperbee from '../../../peer/node_modules/hyperbee/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { Bridge } from '../../../src/net/bridge.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
function base(read = async () => null) {
  const f = { reads: 0, closes: 0, key: Buffer.alloc(32, 3) };
  f.view = { core: { signedLength: 8 }, checkout(length) {
    assert.equal(length, 8);
    return { get: (...args) => { f.reads++; return read(...args); }, close: async () => { f.closes++; } };
  } };
  return f;
}

test('each signed balance stage is bounded, closes its checkout and names the failed chain', async () => {
  for (const label of ['MSB', 'RESET']) {
    const f = base(() => new Promise(() => {}));
    await assert.rejects(signedBalanceRead(f, 'account', label, 10), new RegExp(`${label} balance unavailable: read timed out`));
    await turn(); assert.equal(f.closes, 1);
    const ok = base(async (_key, options) => {
      assert.deepEqual(options, { timeout: 10, update: false }); return { value: '9' };
    });
    assert.deepEqual(await signedBalanceRead(ok, 'account', label, 10), { value: '9' });
    await turn(); assert.equal(ok.closes, 1);
    const stuckClose = base();
    stuckClose.view.checkout = () => ({ get: async () => ({ value: '9' }), close: () => new Promise(() => {}) });
    await assert.rejects(signedBalanceRead(stuckClose, 'account', label, 10), /snapshot close timed out/);
  }
});

test('missing signed blocks and uninitialized views never report zero; a sparse read can recover', async () => {
  let missing = true;
  const f = base(async () => {
    if (missing) throw Object.assign(new Error('block absent'), { code: 'BLOCK_NOT_AVAILABLE' });
    return null;
  });
  await assert.rejects(signedBalanceRead(f, 'account', 'RESET'), /still syncing/);
  missing = false;
  assert.equal(await signedBalanceRead(f, 'account', 'RESET'), null, 'a proven absent key is distinct from an unavailable block');
  f.view.core.signedLength = 0;
  await assert.rejects(signedBalanceRead(f, 'account', 'RESET'), /not ready/);
});

function fixture() {
  const key = Buffer.alloc(32, 7), address = PeerWallet.encodeBech32m('trac', key);
  const msb = base(), reset = base();
  const bus = { config: { addressPrefix: 'trac', bootstrap: Buffer.alloc(32, 1) }, state: { base: msb, getSigned: async () => null, getFee: () => Buffer.alloc(16) } };
  const resetPeer = { base: reset }, config = { trac: { reset: { bootstrap: '03'.repeat(32) } } };
  return { key, address, msb, reset, bus, resetPeer, config };
}

test('concurrent balances share in-flight reads; subsequent financial reads capture new signed snapshots', async () => {
  const f = fixture(); let release;
  f.msb.view.checkout = () => ({ get: () => { f.msb.reads++; return new Promise(resolve => { release = resolve; }); }, close: async () => {} });
  const handlers = makeHandlers(f), first = handlers.dex_balances({ address: f.address }), second = handlers.dex_balances({ address: f.address });
  await turn(); assert.equal(f.msb.reads, 1); assert.equal(f.reset.reads, 1);
  release(null);
  assert.deepEqual(await first, { TNK: '0', RESET: '0', feeTnk: '0' });
  assert.deepEqual(await second, await first);
  const next = handlers.dex_balances({ address: f.address }); await turn();
  assert.equal(f.msb.reads, 2);
  release({ value: nodeEntry.init(Buffer.alloc(32), 0, Buffer.from('00000000000000000000000000000009', 'hex')) });
  assert.equal((await next).TNK, '9');
});

test('a stalled RESET read requests replica recovery but never falls back to stale or zero balances', async () => {
  const f = fixture(); let repairs = 0;
  f.resetPeer.recoverRead = () => { repairs++; };
  f.reset.view.checkout = () => ({ get: async () => { throw Object.assign(new Error('not served'), { code: 'REQUEST_TIMEOUT' }); }, close: async () => {} });
  await assert.rejects(readBalances(f), /RESET balance unavailable/);
  assert.equal(repairs, 1);
  f.reset.view.checkout = () => ({ get: async () => ({ value: '12' }), close: async () => {} });
  assert.equal((await readBalances(f)).RESET, '12');
  f.reset.view.checkout = () => ({ get: async () => ({ value: 'broken' }), close: async () => {} });
  await assert.rejects(readBalances(f), /Invalid RESET balance/); assert.equal(repairs, 1);
});

test('a real sparse signed Hyperbee times out, cancels snapshots, and reads again when a serving replica returns', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-balance-'));
  const writer = new Hypercore(path.join(directory, 'writer'));
  await writer.ready();
  const original = new Hyperbee(writer, { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false });
  await original.put('bal/account', '123');
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
  connect();
  await reader.get(0, { timeout: 1000 });
  await reader.get(writer.length - 1, { timeout: 1000 });
  for (const stream of streams) stream.destroy();
  await turn(); await turn();
  await reader.clear(1, reader.length);
  replica = new Hyperbee(reader, { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false });
  await replica.ready();
  const sessions = reader.sessions.length;
  await assert.rejects(signedBalanceRead({ view: replica }, 'bal/account', 'RESET', 20), /RESET balance unavailable/);
  await turn(); await turn();
  assert.equal(reader.sessions.length, sessions, 'timed-out checkout and its snapshot are closed');
  connect();
  assert.equal((await signedBalanceRead({ view: replica }, 'bal/account', 'RESET', 1000)).value, '123');
});

test('a slow peer balance read reports its stage over the real bridge while unrelated requests remain responsive', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let stalled = true;
  const f = base(() => stalled ? new Promise(() => {}) : Promise.resolve({ value: '42' }));
  server.on('connection', socket => socket.on('message', async bytes => {
    const request = JSON.parse(String(bytes)), reply = value => socket.send(JSON.stringify({ id: request.id, ...value }));
    if (request.type === 'auth') return reply({ type: 'auth_ok' });
    if (request.type === 'info') return reply({ type: 'info', info: { ready: true } });
    try { reply({ type: 'dex_balances_result', result: await signedBalanceRead(f, 'account', 'RESET', 30) }); }
    catch (error) { reply({ type: 'error', error: error.message }); }
  }));
  const bridge = new Bridge({ url: `ws://127.0.0.1:${server.address().port}`, token: 'local-test', timeoutMs: 1000 });
  t.after(async () => { bridge.ws?.terminate(); for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); });
  await bridge.connect();
  const failed = assert.rejects(bridge.call('dex_balances', {}), /RESET balance unavailable: read timed out/);
  assert.deepEqual((await bridge.info()).info, { ready: true });
  await failed; stalled = false;
  assert.deepEqual(await bridge.call('dex_balances', {}), { value: '42' });
  assert.equal(bridge.pending.size, 0);
});
