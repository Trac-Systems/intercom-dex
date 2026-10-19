import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Bridge } from '../../../src/net/bridge.js';
import { Signer } from '../../../src/roles/signer.js';
import { Service } from '../../../src/roles/service.js';
import { openStore } from '../../../src/roles/store.js';
import { encodeKey } from '../../../src/core/keys.js';
import { fixture } from '../core/helpers.mjs';
import { memoryStore, nowSec } from './fixtures.mjs';

test('the bridge taps every received channel message with its frame size before the roles see it; stats() asks the peer', async t => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(r => wss.once('listening', r));
  t.after(() => { for (const c of wss.clients) c.terminate(); return new Promise(r => wss.close(r)); });
  const frames = [];
  wss.on('connection', ws => ws.on('message', data => {
    const msg = JSON.parse(String(data));
    if (msg.type === 'auth') return ws.send(JSON.stringify({ id: msg.id, type: 'auth_ok' }));
    if (msg.type === 'stats') {
      ws.send(JSON.stringify({ id: msg.id, type: 'stats', channels: ['intercom-dex'], connectionCount: 2 }));
      const frame = JSON.stringify({ type: 'sidechannel_message', channel: 'intercom-dex', message: { kind: 'book', body: { ü: 'x' } } });
      frames.push(Buffer.byteLength(frame)); ws.send(frame);
    }
  }));
  const bridge = await new Bridge({ url: `ws://127.0.0.1:${wss.address().port}`, token: 't' }).connect();
  t.after(() => bridge.close());
  const order = [];
  bridge.on('traffic', (ch, m, bytes) => order.push(['traffic', ch, m.kind, bytes]));
  bridge.on('message', (ch, m) => order.push(['message', ch, m.kind]));
  assert.deepEqual(await bridge.stats(), { id: 2, type: 'stats', channels: ['intercom-dex'], connectionCount: 2 });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(order, [['traffic', 'intercom-dex', 'book', frames[0]], ['message', 'intercom-dex', 'book']]);
});

class FakeBridge extends EventEmitter {
  constructor() { super(); this.sent = []; }
  async setRelays() {}
  async join() {}
  async send(ch, envelope) { this.sent.push({ ch, envelope }); }
}

test('a signer records when it last sent a heartbeat', async t => {
  const f = fixture(), timers = [];
  t.mock.method(globalThis, 'setInterval', fn => { timers.push(fn); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const bridge = new FakeBridge(), s = f.signers[0];
  const signer = new Signer({ bridge, identity: { secretKey: encodeKey(s.identity.secretKey), publicKey: encodeKey(s.identity.publicKey) },
    box: { secretKey: encodeKey(s.box.secretKey), publicKey: encodeKey(s.box.publicKey) }, store: memoryStore({ 'registry-current': f.registry }),
    trac: null, serviceKey: encodeKey(f.service.publicKey), log: () => {} });
  await signer.start(); t.after(() => signer.stop());
  assert.equal(signer.lastHeartbeatAt, undefined);
  const before = nowSec();
  await timers.at(-1)();
  assert.equal(bridge.sent.at(-1).envelope.kind, 'heartbeat');
  assert.ok(signer.lastHeartbeatAt >= before && signer.lastHeartbeatAt <= nowSec());
  bridge.send = async () => { throw new Error('peer gone'); };
  const last = signer.lastHeartbeatAt;
  await timers.at(-1)().catch(() => {});
  assert.equal(signer.lastHeartbeatAt, last, 'a failed send is not a heartbeat');
});

test('the venue records when it last published its signer list', async t => {
  const f = fixture(), clock = { t: 5_000_000 };
  t.mock.method(globalThis, 'setInterval', () => 1);
  t.mock.method(globalThis, 'clearInterval', () => {});
  const bridge = new FakeBridge(), { version: _v, issuedAt: _i, ...input } = f.registry;
  const service = new Service({ firstLaunch: true, bridge, identity: { secretKey: encodeKey(f.service.secretKey), publicKey: encodeKey(f.service.publicKey) },
    store: openStore(mkdtempSync(join(tmpdir(), 'dash-venue-')), randomBytes(32)), solana: { assertFeeConfig: async () => {} }, trac: null, log: () => {}, now: () => clock.t, registryInput: input });
  assert.equal(service.registryPublishedAt, undefined);
  await service.start(); t.after(() => service.stop());
  assert.equal(service.registryPublishedAt, clock.t);
  assert.ok(bridge.sent.some(x => x.envelope.kind === 'registry'));
});
