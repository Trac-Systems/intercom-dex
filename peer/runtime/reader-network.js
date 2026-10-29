import Hyperswarm from 'hyperswarm';
import { createReadRecovery } from './read-recovery.js';
import { createReadMetrics } from './read-metrics.js';
export { READER_REPAIR_MS } from './read-recovery.js';

export const RESET_CONNECTIONS = 3;

// Readers discover serving replicas without advertising themselves as another full-network seed.
// Use Autobase's replication entry point so writer wakeups and verified fast-forward remain unchanged.
export async function replicateReader(reader, bandwidth, { Swarm = Hyperswarm, timeoutMs = 10000, now = () => Date.now(), log = console.log } = {}) {
  const swarm = reader.swarm = new Swarm({ bootstrap: reader.config.dhtBootstrap,
    maxPeers: RESET_CONNECTIONS, maxClientConnections: RESET_CONNECTIONS,
    firewall: (_key, payload) => payload !== null });
  bandwidth?.trackSwarm(swarm, 'reset');
  swarm.on('connection', connection => {
    if (reader.base.closing) return connection.destroy();
    const stream = reader.base.replicate(connection);
    stream.on('error', () => {});
    connection.on('error', () => {});
  });
  const discovery = swarm.join(reader.config.channel, { server: false, client: true });
  reader.recoverRead = createReadRecovery({ base: reader.base, swarm, topic: reader.config.channel,
    discovery, label: 'RESET', rotate: true, now, log });
  reader.observeRead = createReadMetrics({ base: reader.base, swarm, label: 'RESET', now, log });
  let timer;
  try { await Promise.race([swarm.flush(), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
