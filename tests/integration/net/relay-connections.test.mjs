import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import DHT from '../../../peer/node_modules/hyperdht/index.js';
import createTestnet from '../../../peer/node_modules/hyperdht/testnet.js';
import BlindRelay from '../../../peer/features/blind-relay/index.js';
import { relayFaults } from './relay-faults.mjs';

const require = createRequire(new URL('../../../peer/node_modules/trac-peer/package.json', import.meta.url));
const Hyperswarm = require('hyperswarm');
async function until(check) {
  const end = Date.now() + 15000;
  while (!check()) { assert.ok(Date.now() < end, 'native relay did not settle'); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('native relay keeps simultaneous pairs alive through one pair closing and a control reconnect', { timeout: 60000 }, async t => {
  const net = await createTestnet(3, { host: '127.0.0.1' }), peers = [], isolated = DHT.keyPair();
  t.after(async () => {
    for (const p of peers) { await p.blindRelay.stop(); await p.swarm.destroy(); }
    await net.destroy();
  });
  for (let i = 0; i < 4; i++) {
    const dht = net.createNode({ quickFirewall: false }); await dht.fullyBootstrapped();
    const swarm = new Hyperswarm({ dht, keyPair: i === 3 ? isolated : DHT.keyPair(), backoffs: [50, 100, 200], jitter: 0 });
    const p = { swarm, received: '', errors: [] }; peers.push(p); await swarm.listen();
    swarm.on('connection', connection => {
      connection.on('error', error => p.errors.push(error.message));
      if (i !== 0) connection.on('data', bytes => { p.received += bytes.toString(); });
    });
    relayFaults(p, isolated.publicKey.toString('hex'));
    p.blindRelay = new BlindRelay(p, { serve: i === 0, directTimeoutMs: 250, relayTimeoutMs: 10000 });
    await p.blindRelay.start();
  }
  const [relay, first, second, source] = peers;
  for (const p of peers) p.blindRelay.setRelays([relay.swarm.keyPair.publicKey.toString('hex')]);
  const connectionTo = target => [...source.swarm.connections].find(c => c.remotePublicKey.equals(target.swarm.keyPair.publicKey));
  source.swarm.joinPeer(first.swarm.keyPair.publicKey); source.swarm.joinPeer(second.swarm.keyPair.publicKey);
  await until(() => connectionTo(first) && connectionTo(second) && relay.blindRelay.stats().active_pairs === 2);
  const a = connectionTo(first), b = connectionTo(second);
  a.write('first'); b.write('second');
  await until(() => first.received === 'first' && second.received === 'second');
  assert.ok(peers.every(p => p.errors.length === 0));
  assert.equal(source.blindRelay.controls.size, 1);
  assert.equal(relay.blindRelay.stats().sessions, 3);
  const incoming = [...relay.blindRelay.streams.keys()].find(stream => stream.id === b.rawStream.remoteId);
  assert.ok(incoming); assert.equal(incoming.localPort, b.rawStream.remotePort);
  assert.ok(incoming.bytesReceived > 0);

  source.swarm.leavePeer(first.swarm.keyPair.publicKey); a.destroy();
  await until(() => relay.blindRelay.stats().active_pairs === 1);
  assert.equal(connectionTo(second), b); assert.equal(b.destroyed, false);
  b.write('-survived'); await until(() => second.received === 'second-survived');
  assert.deepEqual(second.errors, []);

  source.blindRelay.controls.values().next().value.connection.destroy();
  await until(() => connectionTo(second) && connectionTo(second) !== b);
  connectionTo(second).write('-reconnected');
  await until(() => second.received === 'second-survived-reconnected');
  assert.equal(connectionTo(first), undefined);
  assert.equal(relay.blindRelay.stats().active_pairs, 1);
});
