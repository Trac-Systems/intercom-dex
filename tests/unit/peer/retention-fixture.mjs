import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { duplexPair } from 'node:stream';
import Protomux from '../../../peer/node_modules/protomux/index.js';
import SecretStream from '../../../peer/node_modules/@hyperswarm/secret-stream/index.js';
import Sidechannel from '../../../peer/features/sidechannel/index.js';

export const turn = () => new Promise(resolve => setImmediate(resolve));
const topic = 'memory-retention-test';

// Only in-memory streams and ephemeral test identities; no DHT, sockets or persistent stores.
export async function retentionFixture({ encrypted = false } = {}) {
  let delivered = 0;
  const nodes = [0, 1].map(() => {
    const swarm = new EventEmitter();
    Object.assign(swarm, { connections: new Set(), join() {}, flush: async () => {} });
    return new Sidechannel({ swarm }, { channels: [topic], welcomeRequired: false,
      onMessage: () => { delivered++; } });
  });
  await Promise.all(nodes.map(node => node.start()));
  const refs = [];
  async function cycle() {
    const raw = duplexPair();
    const streams = encrypted ? raw.map((stream, i) => new SecretStream(i === 0, stream)) : raw;
    if (encrypted) assert.deepEqual(await Promise.all(streams.map(stream => stream.opened)), [true, true]);
    for (let i = 0; i < streams.length; i++) {
      const connection = streams[i];
      connection.userData = new Protomux(connection);
      nodes[i].peer.swarm.connections.add(connection);
      nodes[i].peer.swarm.emit('connection', connection);
      refs.push(new WeakRef(connection));
    }
    const records = nodes.map((node, i) => node.connections.get(streams[i]).get(topic));
    await Promise.all(records.map(record => record.channel.fullyOpened()));
    const before = delivered;
    // Fresh IDs keep the test focused on connection lifetime rather than stamp reuse.
    for (let i = 0; i < nodes.length; i++) {
      records[i].message.send(await nodes[i]._buildPayload(topic, { text: 'x'.repeat(16384) }));
    }
    await turn();
    assert.equal(delivered - before, 2);
    for (let i = 0; i < streams.length; i++) {
      assert.ok(nodes[i].rateLimits.has(streams[i]), 'each real frame was rate checked');
      nodes[i].peer.swarm.connections.delete(streams[i]);
      streams[i].destroy();
    }
    await turn();
    assert.ok(nodes.every(node => node.connections.size === 0));
  }
  return { nodes, refs, cycle, delivered: () => delivered,
    close: () => Promise.all(nodes.map(node => node.stop())) };
}

export async function collect() {
  // WeakRef targets stay alive until the end of the current JS job. Never
  // dereference a target in the same job as the collection intended to free it.
  for (let i = 0; i < 4; i++) { await turn(); globalThis.gc(); }
  await turn();
}
