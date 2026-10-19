import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Duplex } from '../../../peer/node_modules/streamx/index.js';
import { setImmediate } from 'node:timers/promises';
import { relayFaults } from '../../integration/net/relay-faults.mjs';

const key = n => Buffer.alloc(32, n);
function fixture(self = 1) {
  const swarm = new EventEmitter(), calls = [], writes = [];
  let next = 0;
  Object.assign(swarm, { keyPair: { publicKey: key(self) },
    server: { firewall: remote => remote.equals(key(9)) },
    dht: { connect(remote, options) { calls.push({ remote, options }); },
      createRawStream() {
        const stream = new Duplex({ read(done) { done(null); }, write(chunk, done) { writes.push(Buffer.from(chunk)); done(null); } });
        Object.assign(stream, { id: ++next, connected: false, relayTo() {},
          connect() { Object.assign(this, { connected: true, remoteId: 10, remotePort: 1234,
            remoteHost: '127.0.0.1', localPort: 5678, localHost: '127.0.0.1' }); this.emit('connect'); } });
        stream.on('error', () => {}); return stream;
      } } });
  return { peer: { swarm }, calls, writes };
}

test('isolation blocks ordinary handshakes and disables every direct dial shortcut for the isolated pair', () => {
  const { peer, calls } = fixture(), audit = relayFaults(peer, key(2).toString('hex'));
  assert.equal(peer.swarm.server.firewall(key(2), null), true);
  assert.equal(peer.swarm.server.firewall(key(2), { relayThrough: {} }), false);
  assert.equal(peer.swarm.server.firewall(key(3), null), false);
  assert.equal(peer.swarm.server.firewall(key(9), { relayThrough: {} }), true);
  const options = { keyPair: peer.swarm.keyPair };
  peer.swarm.dht.connect(key(2), options);
  assert.equal(calls[0].options.localConnection, false); assert.equal(calls[0].options.fastOpen, false);
  assert.equal(calls[0].options.holepunch(), false); assert.deepEqual(options, { keyPair: peer.swarm.keyPair });
  peer.swarm.dht.connect(key(3), options); assert.equal(calls[1].options, options);
  peer.swarm.dht.connect(key(2)); assert.deepEqual(calls[2].options, {});
  assert.equal(audit().blocked, 1);
  const isolated = fixture(2).peer;
  relayFaults(isolated, key(2).toString('hex'));
  assert.equal(isolated.swarm.dht.remoteAddress(), null);
  assert.equal(isolated.swarm.server._shareLocalAddress, false); assert.equal(isolated.swarm.server._neverPunch, true);
  assert.equal(isolated.swarm.server.firewall(key(3), null), true);
});

test('physical path history records a direct migration even when the requested route says relay', () => {
  const { peer } = fixture(), audit = relayFaults(peer, key(2).toString('hex'));
  const stream = peer.swarm.dht.createRawStream(); stream.connect();
  const connection = { rawStream: stream, remotePublicKey: key(2) };
  peer.blindRelay = { routes: new WeakMap([[connection, key(3).toString('hex')]]), stats: () => ({}) };
  peer.swarm.emit('connection', connection);
  stream.remoteId = 99; stream.remotePort = 9999; stream.emit('remote-changed');
  assert.equal(audit().relayed.length, 1); assert.deepEqual(audit().paths.map(path => path.remotePort), [1234, 9999]);
  assert.equal(audit().paths[1].remoteId, 99); stream.destroy();
});

test('capture buffers until connected, forwards exact bytes, and detects plaintext split across chunks', async t => {
  const { peer, writes } = fixture(), audit = relayFaults(peer, key(2).toString('hex'), { capture: true });
  const source = peer.swarm.dht.createRawStream(), destination = peer.swarm.dht.createRawStream();
  t.after(() => { source.destroy(); destination.destroy(); });
  source.relayTo(destination); source.connect();
  source.push(Buffer.from('intercom-')); await setImmediate();
  assert.deepEqual(writes, []); assert.equal(audit().ciphertextBytes, 0);
  assert.equal(destination.listenerCount('connect'), 1);
  destination.connect(); await setImmediate();
  assert.equal(audit().plaintextMatches, 0);
  source.push(Buffer.from('dex')); await setImmediate();
  assert.equal(Buffer.concat(writes).toString(), 'intercom-dex');
  assert.ok(audit().plaintextMatches > 0); assert.equal(audit().ciphertextBytes, 12);
  assert.equal(audit().forwarding[0].bytes, 12); assert.equal(audit().forwarding[0].remotePort, 1234);
  const closed = new Promise(resolve => destination.once('close', resolve)); source.destroy(new Error('source lost')); await closed;
});

test('capture ignores non-forwarding streams and releases a destination listener on early close', async () => {
  const { peer } = fixture(), audit = relayFaults(peer, key(2).toString('hex'), { capture: true });
  const source = peer.swarm.dht.createRawStream(), destination = peer.swarm.dht.createRawStream();
  source.push(Buffer.from('"termsSig"')); await setImmediate();
  assert.equal(audit().ciphertextBytes, 0); assert.equal(audit().plaintextMatches, 0);
  source.relayTo(destination);
  const closed = once(source, 'close'); source.destroy(); await closed;
  assert.equal(destination.listenerCount('connect'), 0); destination.destroy();
});
