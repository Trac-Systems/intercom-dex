import b4a from 'b4a';

export const READER_REPAIR_MS = 30000;

// Repair the replication transport, not validator membership or protocol selection.
// Discovery can keep returning the same replicas (or remain in flight). A known
// peer can also exhaust Hyperswarm's implicit retries without leaving its map.
export function createReadRecovery({ base, swarm, topic, discovery = swarm?.status?.(topic), label,
  rotate = false, now = Date.now, log = console.log }) {
  let repairedAt = -Infinity, cursor = '', refreshing = null, retiring = null;
  const stopped = () => base.closing || base.closed || !swarm || swarm.destroyed || swarm.suspended;
  const connections = () => [...(swarm.connections ?? [])].filter(c => !c.destroyed && !c.destroying);
  const emit = (event, extra = {}) => log(`[trac-read] ${JSON.stringify({ chain: label, event,
    signedLength: base.view?.core?.signedLength ?? null, connected: connections().length,
    known: swarm.peers?.size ?? 0, ...extra })}`);
  const retry = excluded => {
    if (stopped()) return;
    const live = connections();
    // Explicit joins bypass Hyperswarm's normal connection limits. Do not borrow
    // a join unless there is a free slot, including already connecting sockets.
    const limit = Math.min(swarm.maxPeers ?? Infinity, swarm.maxClientConnections ?? Infinity);
    if (live.length + (swarm.connecting ?? 0) >= limit) return;
    const connected = new Set(live.map(c => c.remotePublicKey && b4a.toString(c.remotePublicKey, 'hex')));
    const candidates = [...(swarm.peers?.values() ?? [])].filter(peer => {
      const key = peer.publicKey && b4a.toString(peer.publicKey, 'hex');
      return key && key !== excluded && !connected.has(key) && !peer.banned && !peer.queued && !peer.explicit &&
        (peer.proven || peer.topics?.some(t => b4a.equals(t, topic))) &&
        (!swarm.keyPair?.publicKey || !b4a.equals(peer.publicKey, swarm.keyPair.publicKey));
    });
    if (!candidates.length) return;
    candidates.sort((a, b) => b4a.compare(a.publicKey, b.publicKey));
    const peer = candidates.find(p => b4a.toString(p.publicKey, 'hex') > cursor) ?? candidates[0];
    cursor = b4a.toString(peer.publicKey, 'hex');
    // joinPeer re-arms exhausted retries through the public API. Release our
    // temporary pin immediately: the queued/current attempt remains, but we do
    // not accumulate permanent explicit peers or change existing owners' pins.
    try {
      swarm.joinPeer(peer.publicKey);
      emit('retry', { peer: cursor });
    } finally { swarm.leavePeer(peer.publicKey); }
  };
  return error => {
    if (stopped() || retiring || now() - repairedAt < READER_REPAIR_MS) return false;
    repairedAt = now();
    emit('stalled', { reason: error?.code ?? 'read unavailable', discoveryPending: refreshing !== null });
    if (!refreshing && discovery) {
      refreshing = Promise.resolve().then(() => stopped() ? undefined : discovery.refresh()).then(ok => {
        if (ok === false && !stopped()) emit('discovery_failed');
      }).catch(error => { if (!stopped()) emit('discovery_failed', { error: error.message }); })
        .finally(() => { refreshing = null; });
    }
    const live = connections();
    const limit = Math.min(swarm.maxPeers ?? Infinity, swarm.maxClientConnections ?? Infinity);
    // Only the dedicated RESET reader rotates a full set of replicas. MSB
    // validators may be carrying submissions; a failed read never retires them.
    const connection = rotate && live.length >= limit ? live[0] : null;
    if (connection) {
      retiring = connection;
      const excluded = connection.remotePublicKey && b4a.toString(connection.remotePublicKey, 'hex');
      connection.once('close', () => {
        retiring = null;
        // Run after all transport close handlers have freed their slots.
        Promise.resolve().then(() => retry(excluded)).catch(error => {
          if (!stopped()) emit('retry_failed', { error: error.message });
        });
      });
      connection.destroy();
    } else retry();
    return true;
  };
}
