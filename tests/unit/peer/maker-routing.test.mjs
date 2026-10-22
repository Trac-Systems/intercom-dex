import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import Hyperswarm from '../../../peer/node_modules/hyperswarm/index.js';
import BlindRelay from '../../../peer/features/blind-relay/index.js';
const loader = registerHooks({ resolve: (name, context, next) => next(name === 'bare-ws' ? 'ws' : name, context) });
const { default: DexBridge } = await import('../../../peer/features/dex-bridge.js');
loader.deregister();

const key = n => Buffer.alloc(32, n).toString('hex'), channel = n => 'intercom-dex:t:' + key(n);
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, swarm) {
  const joined = [], left = [], replies = [];
  swarm ??= { peers: new Map(), joinPeer: k => joined.push(k.toString('hex')), leavePeer: k => left.push(k.toString('hex')),
    _attemptClientConnections() {} };
  const bridge = new DexBridge({ swarm }, { requireAuth: true });
  const sidechannel = { openChannels: new Set(), addChannel: async () => true, removeChannel: async () => true };
  bridge.attachSidechannel(sidechannel);
  bridge._broadcastToClient = (client, message) => replies.push({ client, message });
  const client = () => ({ authed: true, socket: new EventEmitter() });
  const owner = client();
  const send = async (body, who = owner) => {
    bridge._handleClientMessage(who, { id: replies.length, ...body }); await turn();
    return replies.at(-1)?.message;
  };
  const join = (ch, makerPeer, who = owner) => send({ type: 'dex_join', channel: ch, ...(makerPeer !== undefined ? { makerPeer } : {}) }, who);
  t.after(() => bridge.stop());
  return { bridge, sidechannel, swarm, joined, left, replies, owner, client, send, join };
}

test('maker pins count channels and clients; duplicates are idempotent and null releases only that route', async t => {
  const f = fixture(t), other = f.client();
  assert.equal((await f.join(channel(1), key(7))).type, 'joined');
  await f.join(channel(1), key(7)); await f.join(channel(2), key(7)); await f.join(channel(1), key(7), other);
  assert.deepEqual(f.joined, [key(7)]); assert.equal(f.bridge.makerPins.get(key(7)).refs, 3);
  await f.join(channel(1)); assert.equal(f.bridge.makerPins.get(key(7)).refs, 3, 'old clients omit the hint');
  await f.join(channel(1), null); await f.join(channel(1), null);
  assert.equal(f.bridge.makerPins.get(key(7)).refs, 2); assert.deepEqual(f.left, []);
  await f.join(channel(2), null); other.socket.emit('close');
  assert.deepEqual(f.left, [key(7)]); assert.equal(f.bridge.makerPins.size, 0); assert.equal(f.bridge.makerRoutes.size, 0);
});

test('pins are capped at sixteen distinct keys; invalid and unauthenticated requests acquire nothing', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 16; i++) assert.equal((await f.join(channel(i), key(i))).type, 'joined');
  assert.match((await f.join(channel(17), key(17))).error, /limit/);
  assert.equal((await f.join(channel(18), key(1))).type, 'joined', 'an existing key needs no extra slot');
  for (const invalid of ['', 'a', key(1).toUpperCase().replace('01', 'GG'), 1, {}]) {
    assert.match((await f.join(channel(1), invalid)).error, /Invalid/);
  }
  assert.match((await f.join('intercom-dex', key(17))).error, /trade channel/);
  assert.match((await f.join(channel(17), key(17), { authed: false })).error, /Unauthorized/);
  assert.equal(f.bridge.makerPins.size, 16); assert.equal(f.joined.length, 16);
  assert.equal(f.bridge.makerPins.get(key(1)).refs, 2, 'bad replacements leave the existing pin intact');
  await f.join(channel(2), null);
  assert.equal((await f.join(channel(17), key(17))).type, 'joined');
});

test('join rejection, denial and scheduler failure release new pins; duplicate failure preserves a joined route', async t => {
  const f = fixture(t);
  for (const result of [false, new Error('announce failed')]) {
    f.sidechannel.addChannel = async () => { if (result instanceof Error) throw result; return result; };
    assert.equal((await f.join(channel(1), key(7))).type, 'error');
    assert.equal(f.bridge.makerPins.size, 0);
  }
  f.sidechannel.addChannel = async () => true;
  await f.join(channel(1), key(7));
  f.sidechannel.addChannel = async () => false;
  await f.join(channel(1), key(7));
  assert.equal(f.bridge.makerPins.size, 1);
  f.swarm._attemptClientConnections = () => { throw new Error('scheduler failed'); };
  assert.match((await f.join(channel(2), key(8))).error, /scheduler failed/);
  assert.ok(f.left.includes(key(8))); assert.equal(f.bridge.makerPins.size, 1);
});

test('leave, disconnect and stop clean pins, without removing a preexisting explicit peer', async t => {
  const f = fixture(t), other = f.client();
  f.swarm.peers.set(key(9), { explicit: true });
  await f.join(channel(1), key(7)); await f.join(channel(1), key(7), other);
  assert.equal((await f.send({ type: 'leave', channel: channel(1) })).type, 'left');
  assert.equal(f.bridge.makerPins.size, 0);
  await f.join(channel(2), key(8)); f.owner.socket.emit('end'); f.owner.socket.emit('close');
  assert.equal(f.bridge.makerPins.size, 0);
  await f.join(channel(3), key(9), other); await f.join(channel(4), key(10), other);
  f.bridge.stop(); f.bridge.stop(); other.socket.emit('close');
  assert.deepEqual(f.left, [key(7), key(8), key(10)]);
  assert.equal(f.bridge.makerPins.size, 0); assert.equal(f.bridge.makerRoutes.size, 0);
});

test('an old pending join cannot release or resurrect a newer route after release or stop', async t => {
  const f = fixture(t); let resolve;
  f.sidechannel.addChannel = () => new Promise(yes => { resolve = yes; });
  f.bridge._handleClientMessage(f.owner, { type: 'dex_join', channel: channel(1), makerPeer: key(7) });
  const old = resolve;
  f.sidechannel.addChannel = async () => true;
  await f.join(channel(1), null); await f.join(channel(1), key(7));
  const route = f.bridge.makerRoutes.get(f.owner).get(channel(1));
  old(false); await turn();
  assert.equal(f.bridge.makerRoutes.get(f.owner).get(channel(1)), route);
  f.sidechannel.addChannel = () => new Promise(yes => { resolve = yes; });
  f.bridge._handleClientMessage(f.owner, { type: 'dex_join', channel: channel(2), makerPeer: key(8) });
  f.bridge.stop(); resolve(true); await turn();
  assert.equal(f.bridge.makerPins.size, 0);
});

function realSwarm(t) {
  const dht = new EventEmitter(), connections = [], calls = [];
  dht.createServer = () => ({ close: async () => {}, firewall: () => false, _relayConnection() {} });
  dht.connect = (remotePublicKey, options) => {
    const conn = new EventEmitter();
    Object.assign(conn, { remotePublicKey, destroyed: false, destroy(error) {
      if (this.destroyed) return;
      this.destroyed = true;
      if (error) this.emit('error', error);
      this.emit('close');
    } });
    connections.push(conn); calls.push({ remotePublicKey, options }); return conn;
  };
  dht.destroy = async () => { for (const conn of connections) conn.destroy(); };
  const swarm = new Hyperswarm({ dht, keyPair: { publicKey: Buffer.from(key(99), 'hex') }, maxPeers: 0, maxParallel: 1 });
  t.after(() => swarm.destroy());
  return { swarm, calls, connections };
}

test('real Hyperswarm dials an already queued maker at the peer cap, preserving native parallel limits', async t => {
  const { swarm, calls, connections } = realSwarm(t), f = fixture(t, swarm);
  const maker = Buffer.from(key(7), 'hex');
  swarm._handlePeer({ publicKey: maker }, Buffer.alloc(32, 1));
  assert.equal(swarm.peers.get(key(7)).queued, true); assert.equal(calls.length, 0);
  await f.join(channel(1), key(7));
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].remotePublicKey, maker);
  await f.join(channel(1), key(7)); await f.join(channel(2), key(8));
  assert.equal(calls.length, 1, 'maxParallel remains in force');
  connections[0].emit('open');
  assert.equal(calls.length, 2); assert.equal(calls[1].remotePublicKey.toString('hex'), key(8));
  await f.join(channel(1), null); await f.join(channel(2), null);
  assert.equal(swarm.explicitPeers.size, 0);
});

test('a pinned maker keeps the existing direct-failure and blind-relay retry path', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const { swarm, calls, connections } = realSwarm(t);
  const relay = new BlindRelay({ swarm }, { serve: false, relays: [key(20)] });
  await relay.start(); t.after(() => relay.stop());
  const f = fixture(t, swarm);
  await f.join(channel(1), key(7));
  assert.equal(calls[0].options.relayThrough, null);
  connections[0].destroy(new Error('direct failed'));
  const info = swarm.peers.get(key(7));
  assert.equal(info.explicit, true); assert.equal(info.forceRelaying, true);
  now += 1001;
  swarm._requeue([info]);
  assert.equal(calls.length, 2); assert.equal(calls[1].options.relayThrough.toString('hex'), key(20));
  assert.equal(relay.stats().direct_failures, 1);
  await f.join(channel(1), null);
  assert.equal(info.explicit, false);
  connections[1].destroy(new Error('relay failed'));
  assert.equal(swarm.explicitPeers.size, 0);
});

test('warm makers share pins with trade routes, are replaced as a set, capped at four and released with the client', async t => {
  const f = fixture(t);
  const warm = (peerKeys, who) => f.send({ type: 'dex_warm', peerKeys }, who);
  assert.deepEqual((await warm([key(1), key(2)])).peerKeys, [key(1), key(2)]);
  assert.deepEqual(f.joined, [key(1), key(2)]);
  assert.equal((await f.join(channel(9), key(1))).type, 'joined');
  assert.deepEqual(f.joined, [key(1), key(2)], 'a take on a warm maker reuses its pin');
  assert.equal(f.bridge.makerPins.get(key(1)).refs, 2);
  assert.deepEqual((await warm([key(2), key(3)])).peerKeys, [key(2), key(3)]);
  assert.deepEqual(f.left, [], 'key 1 stays pinned by the trade route');
  assert.equal(f.bridge.makerPins.get(key(1)).refs, 1);
  await f.join(channel(9), null);
  assert.deepEqual(f.left, [key(1)]);
  for (const bad of [[key(1), key(2), key(3), key(4), key(5)], [key(1), key(1)], ['x'], 'nope']) {
    assert.match((await warm(bad)).error, /Invalid/);
  }
  assert.match((await f.send({ type: 'dex_warm', peerKeys: [], extra: 1 })).error, /Invalid/);
  assert.match((await warm([key(6)], { authed: false, socket: new EventEmitter() })).error, /Unauthorized/);
  assert.deepEqual([...f.bridge.makerPins.keys()].sort(), [key(2), key(3)]);
  f.owner.socket.emit('close');
  assert.equal(f.bridge.makerPins.size, 0); assert.equal(f.bridge.warmRoutes.size, 0);
  assert.deepEqual(f.left.sort(), [key(1), key(2), key(3)]);
});

test('warm makers skip keys beyond the pin limit instead of failing', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 15; i++) await f.join(channel(i), key(i));
  assert.deepEqual((await f.send({ type: 'dex_warm', peerKeys: [key(20), key(21)] })).peerKeys, [key(20)]);
  assert.equal(f.bridge.makerPins.size, 16);
});

test('registry relay peers (signers, venue) are pinned with a direct connection, removed ones released, maker pins kept', async t => {
  const f = fixture(t);
  f.bridge.peer.blindRelay = { setRelays: keys => keys };
  f.swarm.keyPair = { publicKey: Buffer.from(key(9), 'hex') };
  const relays = keys => f.send({ type: 'relays.set', keys });
  assert.equal((await relays([key(1), key(2), key(9)])).type, 'relays.set');
  assert.deepEqual(f.joined.sort(), [key(1), key(2)], 'own key is never pinned');
  await relays([key(1), key(2)]); assert.equal(f.joined.length, 2, 'repeating the registry pins nothing new');
  await f.join(channel(3), key(2));                         // a maker that is also a registry peer
  await relays([key(1), key(3)]);
  assert.deepEqual([...new Set(f.joined)].sort(), [key(1), key(2), key(3)]);   // joinPeer is idempotent
  assert.deepEqual(f.left, [], 'a peer still used as a maker stays joined');
  await f.join(channel(3), null);
  assert.deepEqual(f.left, [key(2)], 'released once neither the registry nor a maker route needs it');
});

test('a restarted trader authenticates with all channels subscribed and rejoins existing trade routes', async t => {
  const f = fixture(t), old = f.owner;
  f.bridge.token = 'unit-test-token';
  old.ready = true; old.channels = new Set(['intercom-dex:offers']);
  f.bridge.clients.add(old);
  await f.join(channel(1), key(7));
  old.socket.emit('close'); f.bridge.clients.delete(old);
  const fresh = { socket: new EventEmitter(), authed: false, ready: false, channels: null, filter: [] };
  f.bridge.clients.add(fresh);
  assert.equal((await f.send({ type: 'auth', token: 'unit-test-token' }, fresh)).type, 'auth_ok');
  for (const ch of ['intercom-dex', 'intercom-dex:offers', 'intercom-dex:signers']) {
    assert.equal((await f.send({ type: 'join', channel: ch }, fresh)).type, 'joined');
  }
  await f.join(channel(1), key(7), fresh);
  for (const ch of ['intercom-dex:offers', 'intercom-dex:signers', channel(1)]) {
    f.bridge.handleSidechannelMessage(ch, { message: { kind: 'fixture' } });
    assert.equal(f.replies.at(-1).client, fresh);
    assert.equal(f.replies.at(-1).message.type, 'sidechannel_message');
    assert.equal(f.replies.at(-1).message.channel, ch);
  }
  assert.equal(f.bridge.makerPins.get(key(7)).refs, 1);
});
