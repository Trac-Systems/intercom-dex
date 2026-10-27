import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Hyperswarm from '../../../peer/node_modules/hyperswarm/index.js';
import { createReadRecovery, READER_REPAIR_MS } from '../../../peer/runtime/read-recovery.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const topic = Buffer.alloc(32, 42);

// Real pinned Hyperswarm retry/queue code, with entirely local fake DHT sockets.
function fixture(t, { limit = 3, refresh = async () => false, rotate = false } = {}) {
  const dht = new EventEmitter(), dialed = [], logs = [];
  dht.createServer = () => ({ close: async () => {} });
  dht.destroy = async () => { for (const connection of dialed) connection.destroy(); };
  dht.connect = remotePublicKey => {
    const connection = Object.assign(new EventEmitter(), { remotePublicKey, destroy() {
      if (this.destroyed) return;
      this.destroyed = true; this.emit('close');
    } });
    dialed.push(connection); return connection;
  };
  const swarm = new Hyperswarm({ dht, keyPair: { publicKey: Buffer.alloc(32, 99) }, maxPeers: limit, maxClientConnections: limit });
  t.after(() => swarm.destroy());
  const base = { view: { core: { signedLength: 123 } } };
  let time = 100000, refreshes = 0;
  const recover = createReadRecovery({ base, swarm, topic, label: 'MSB', rotate,
    discovery: { refresh() { refreshes++; return refresh(); } }, now: () => time, log: line => logs.push(line) });
  const peer = byte => {
    const p = swarm._upsertPeer(Buffer.alloc(32, byte));
    p._topic(topic); p.attempts = 4; p.client = true;
    return p;
  };
  return { swarm, base, peer, recover, dialed, logs, next: () => { time += READER_REPAIR_MS; }, refreshes: () => refreshes };
}

test('exhausted known peers really dial again despite failed discovery; bans and existing pins survive', async t => {
  const f = fixture(t), stuck = f.peer(1), banned = f.peer(2), pinned = f.peer(3);
  banned.ban(true); pinned.explicit = true; f.swarm.explicitPeers.add(pinned);
  // Keep the unrelated pin backed off, to isolate this repair's dial.
  pinned.attempts = 5;
  f.swarm._requeue([stuck]);
  assert.equal(f.dialed.length, 0, 'ordinary retry gives up with the known peer still in the map');
  assert.equal(f.recover({ code: 'REQUEST_TIMEOUT' }), true);
  assert.equal(f.dialed.length, 1);
  assert.deepEqual(f.dialed[0].remotePublicKey, stuck.publicKey);
  assert.equal(stuck.explicit, false, 'no permanent new pin');
  assert.equal(pinned.explicit, true);
  assert.equal(banned.banned, true);
  assert.equal(f.recover(), false, 'cooldown');
  await turn();
  assert.equal(f.refreshes(), 1);
  assert.ok(f.logs.some(line => line.includes('discovery_failed')));
});

test('a hung discovery does not suppress retries or accumulate refresh promises; offline candidates rotate', async t => {
  const f = fixture(t, { refresh: () => new Promise(() => {}) });
  f.peer(1); f.peer(2); f.peer(3);
  for (let i = 0; i < 3; i++) {
    f.recover(); await turn();
    assert.equal(f.dialed.length, i + 1);
    assert.equal(f.dialed[i].remotePublicKey[0], i + 1);
    f.dialed[i].destroy(); f.next();
  }
  assert.equal(f.refreshes(), 1);
  assert.equal(f.swarm.explicitPeers.size, 0);
  assert.ok(f.logs.some(line => line.includes('"discoveryPending":true')));
});

test('MSB read recovery preserves connected legacy sessions and respects occupied/connecting slots', async t => {
  const f = fixture(t, { limit: 1 }); f.peer(1);
  const legacy = { protocolSession: { preferredProtocol: 'legacy' }, remotePublicKey: Buffer.alloc(32, 2),
    destroy() { assert.fail('a read must not retire a validator'); } };
  f.swarm.connections.add(legacy);
  f.recover(); assert.equal(f.dialed.length, 0);
  f.swarm.connections.delete(legacy); f.swarm.connecting = 1; f.next();
  f.recover(); assert.equal(f.dialed.length, 0);
  f.swarm.connecting = 0;
});

test('RESET waits for one retired socket to close, then dials a different known replica', async t => {
  const f = fixture(t, { limit: 1, rotate: true }); f.peer(1); f.peer(2);
  let destroys = 0;
  const old = Object.assign(new EventEmitter(), { remotePublicKey: Buffer.alloc(32, 1), destroy() { destroys++; this.destroying = true; } });
  f.swarm.connections.add(old);
  f.recover(); await turn();
  assert.equal(destroys, 1); assert.equal(f.dialed.length, 0);
  f.next(); assert.equal(f.recover(), false, 'one pending retirement, even after cooldown');
  f.swarm.connections.delete(old); old.emit('close'); await turn();
  assert.equal(f.dialed.length, 1); assert.equal(f.dialed[0].remotePublicKey[0], 2);
  assert.equal(old.listenerCount('close'), 0);
  assert.equal(f.swarm.explicitPeers.size, 0);
});

test('late close/refresh completions do no recovery work after shutdown', async t => {
  let resolveRefresh;
  const f = fixture(t, { limit: 1, rotate: true, refresh: () => new Promise(resolve => { resolveRefresh = resolve; }) });
  f.peer(1);
  const old = Object.assign(new EventEmitter(), { destroy() {} }); f.swarm.connections.add(old);
  f.recover(); await turn();
  f.base.closing = true; f.swarm.connections.delete(old); old.emit('close'); resolveRefresh(false);
  await turn();
  assert.equal(f.dialed.length, 0); assert.equal(f.recover(), false);
  assert.equal(f.logs.length, 1);
});

test('refresh exceptions are visible and a suspended swarm is left alone', async t => {
  const f = fixture(t, { refresh: async () => { throw new Error('lookup failed'); } });
  f.peer(1); f.recover(); await turn();
  assert.ok(f.logs.some(line => line.includes('lookup failed')));
  f.next(); f.swarm.suspended = true;
  assert.equal(f.recover(), false);
});
