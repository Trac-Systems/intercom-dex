import Hyperswarm from 'hyperswarm';

export const RESET_CONNECTIONS = 3;
export const READER_REPAIR_MS = 30000;

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
  let repairedAt = -Infinity;
  reader.recoverRead = () => {
    if (reader.base.closing || swarm.destroyed || now() - repairedAt < READER_REPAIR_MS) return false;
    repairedAt = now();
    // A connected replica need not have the signed blocks we request. Free one slot for discovery,
    // keeping the other replicas and the reader/store alive; do not churn the whole swarm on every poll.
    const connection = [...(swarm.connections ?? [])].find(c => !c.destroyed);
    connection?.destroy();
    Promise.resolve().then(() => discovery?.refresh?.()).catch(() => {});
    log('RESET balance read stalled; refreshing replica discovery');
    return true;
  };
  let timer;
  try { await Promise.race([swarm.flush(), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
