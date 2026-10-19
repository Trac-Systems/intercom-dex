import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registrySchema } from '../../../src/core/schemas.js';
import { dexTransport } from '../../../peer/features/dex-transport.js';
import { RegistryRelays } from '../../../src/net/relays.js';
import { Bridge } from '../../../src/net/bridge.js';
import BlindRelay from '../../../peer/features/blind-relay/index.js';
import { registerHooks } from 'node:module';
const loader = registerHooks({ resolve(specifier, context, next) {
  return next(specifier === 'bare-ws' ? 'ws' : specifier, context);
} });
const { default: DexBridge } = await import('../../../peer/features/dex-bridge.js');
loader.deregister();
import { fixture } from '../core/helpers.mjs';

const key = n => n.toString(16).padStart(64, '0');
test('relay keys are optional strict registry data and retain text restrictions', () => {
  const r = fixture().registry; registrySchema.parse(r);
  r.serviceRelayKey = key(1); r.signers[0].relayKey = key(2); registrySchema.parse(r);
  for (const bad of ['ab', 'g'.repeat(64), 'a'.repeat(64) + '\n']) {
    assert.equal(registrySchema.safeParse({ ...r, serviceRelayKey: bad }).success, false);
    assert.equal(registrySchema.safeParse({ ...r, signers: [{ ...r.signers[0], relayKey: bad }] }).success, false);
  }
  assert.equal(registrySchema.safeParse({ ...r, relayKeys: [] }).success, false);
  assert.equal(registrySchema.safeParse({ ...r, signers: [{ ...r.signers[0], label: 'bad\nlabel' }] }).success, false);
});

test('agent pushes on startup and every registry version, drops inactive/removed keys and retries bridge failure', async () => {
  const calls = [], bridge = { setRelays: async keys => calls.push(keys) }, sync = new RegistryRelays(bridge);
  await sync.update(null); assert.deepEqual(calls, [[]]);
  const r = fixture().registry; r.serviceRelayKey = key(1); r.signers[0].relayKey = key(2); r.signers[1].relayKey = key(3);
  await sync.update(r); await sync.update(r); assert.equal(calls.length, 2);
  assert.deepEqual(calls.at(-1), [key(1), key(2), key(3)]);
  const next = structuredClone(r); next.version++; next.signers[1].status = 'inactive';
  next.removed = [{ dexKey: next.signers[0].dexKey }];
  await sync.update(next); assert.deepEqual(calls.at(-1), [key(1)]);
  next.version++; await sync.update(next); assert.equal(calls.length, 4);
  next.version++; bridge.setRelays = async () => { throw Error('bridge'); };
  await assert.rejects(sync.update(next), /bridge/);
  bridge.setRelays = async keys => calls.push(keys); await sync.update(next); assert.equal(calls.length, 5);
});

function peer() {
  const swarm = new EventEmitter();
  Object.assign(swarm, { keyPair: { publicKey: Buffer.from(key(99), 'hex') }, connections: new Set(), peers: new Map(),
    dht: { connect() {} }, server: { firewall: async () => false, _relayConnection() {} }, relayThrough: () => null });
  return { swarm };
}

test('live relay updates merge static keys, keep sessions, support an empty initial list and affect new dials', async () => {
  const p = peer(), f = new BlindRelay(p, { relays: [key(1)] }); await f.start();
  try {
    f.sessions.set('existing', { marker: true, session: { _links: new Map() } });
    assert.deepEqual(f.setRelays([key(2), key(2), key(99)]), [key(1), key(2)]);
    assert.deepEqual(f.sessions.get('existing'), { marker: true, session: { _links: new Map() } });
    assert.equal(await p.swarm.server.firewall(null, { relayThrough: { publicKey: Buffer.from(key(2), 'hex') } }), false);
    f.setRelays([]); assert.deepEqual(f.stats().configured_relays, [key(1)]);
    assert.equal(await p.swarm.server.firewall(null, { relayThrough: { publicKey: Buffer.from(key(2), 'hex') } }), true);
    assert.throws(() => f.setRelays(['invalid']), /Invalid/); assert.deepEqual(f.options.relays, [key(1)]);
  } finally { f.sessions.clear(); await f.stop(); }
  const empty = new BlindRelay(peer()); await empty.start();
  try {
    assert.equal(empty.peer.swarm.relayThrough(true), null);
    empty.setRelays([key(3)]); assert.equal(empty.peer.swarm.relayThrough(true).toString('hex'), key(3));
    empty.setRelays([]); assert.equal(empty.peer.swarm.relayThrough(true), null);
  } finally { await empty.stop(); }
});

test('bridge relay updates require authentication and strict bounded keys; client commands match', async () => {
  const f = new BlindRelay(peer()), bridge = new DexBridge({ blindRelay: f }, { token: 'unit', requireAuth: true });
  const replies = []; bridge._broadcastToClient = (_, reply) => replies.push(reply);
  bridge._handleClientMessage({ authed: false }, { type: 'relays.set', id: 1, keys: [key(1)] });
  assert.equal(replies.at(-1).type, 'error'); assert.deepEqual(f.options.relays, []);
  for (const keys of ['bad', ['bad'], Array(4098).fill(key(1))]) {
    bridge._handleClientMessage({ authed: true }, { type: 'relays.set', keys }); assert.equal(replies.at(-1).type, 'error');
  }
  bridge._handleClientMessage({ authed: true }, { type: 'relays.set', keys: [key(1)] });
  assert.deepEqual(replies.at(-1).keys, [key(1)]);
  bridge._handleClientMessage({ authed: true }, { type: 'relays.stats' }); assert.deepEqual(replies.at(-1).stats.configured_relays, [key(1)]);
  const client = new Bridge({ url: '', token: '' }); client.request = async body => body;
  assert.deepEqual(await client.setRelays([key(2)]), { type: 'relays.set', keys: [key(2)] });
  assert.deepEqual(await client.relayStats(), { type: 'relays.stats' });
});

test('the largest registry the schema accepts fits one dex transport message', () => {
  const t = dexTransport({ role: 'trader', servicePeerKey: 'ab'.repeat(32) }).sidechannel;
  assert.ok(t.maxMessageBytes <= t.rateBurstBytes);
  const r = fixture().registry, base = r.signers[0];
  r.signers = Array.from({ length: 128 }, (_, i) => ({ ...base, dexKey: i.toString(16).padStart(64, '0'), boxKey: (i + 1000).toString(16).padStart(64, '0'), relayKey: 'cd'.repeat(32) }));
  registrySchema.parse(r);
  assert.ok(JSON.stringify(r).length + 2000 < t.maxMessageBytes);
  r.signers.push({ ...base, dexKey: 'ef'.repeat(32) });
  assert.equal(registrySchema.safeParse(r).success, false);
});
