import { LocksHeaders } from './locks-headers.js';
import path from 'path';
import PeerWallet from 'trac-wallet';
import { bufferToBigInt } from 'trac-msb/src/utils/amountSerialization.js';
import { dexTransport } from './dex-transport.js';

export const LOCKS_CHANNEL = 'intercom-locks';
export const isLocksChannel = ch => ch === LOCKS_CHANNEL || /^intercom-locks:p:[0-9a-f]{64}$/.test(ch);
export const isLocksRole = role => ['lock-signer', 'lock-venue'].includes(role);
export const hasLocks = config => isLocksRole(config.role) || config.role === 'trader' && config.locks === true;
// The public market feed only reads the main locks channel (the venue's summary): no header index, no signing.
export const joinsLocks = config => hasLocks(config) || config.role === 'market-feed' && config.locks === true;
export function peerTransport(config) {
  if (isLocksRole(config.role)) return locksTransport(config);
  const dex = dexTransport(config);
  if (!joinsLocks(config)) return dex;
  const locks = locksTransport({ ...config, role: 'lock-signer' }).sidechannel;
  const sidechannel = { ...dex.sidechannel };
  if (sidechannel.noRelayChannels) sidechannel.noRelayChannels = [...sidechannel.noRelayChannels, LOCKS_CHANNEL];
  for (const key of ['channels', 'openChannels', 'powRequiredChannels', 'powRequiredPrefixes']) sidechannel[key] = [...sidechannel[key], ...locks[key]];
  sidechannel.powClasses = sidechannel.powClasses.map((group, i) => [...new Set([...group, ...(locks.powClasses[i] ?? [])])]);
  return { ...dex, sidechannel };
}
export function locksTransport(config) {
  if (!isLocksRole(config.role) || !/^[0-9a-f]{64}$/.test(config.servicePeerKey ?? '')) throw new Error('Invalid locks peer configuration');
  return { relay: { serve: config.serveRelay !== false, relays: config.relayKeys ?? [] }, sidechannel: {
    channels: [LOCKS_CHANNEL], openChannels: [LOCKS_CHANNEL], welcomeRequired: false,
    powEnabled: true, powDifficulty: 20, powRequiredChannels: [LOCKS_CHANNEL], powRequiredPrefixes: ['intercom-locks:p:'],
    powClasses: [['heartbeat', 'registry', 'book', 'bookRequest', 'release', 'releaseRequest', 'dkgFail', 'lockReady', 'paid', 'opened'], ['dkgDeal', 'funded', 'take', 'reserve', 'cancel']],
    maxMessageBytes: 200000, rateBytesPerSecond: 2000000, rateBurstBytes: 8000000,
  } };
}

const number = n => { if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid height or cursor'); return n; };
export function makeLocksHandlers({ bus, config, resetPeer }) {
  const index = new LocksHeaders(config.storeDirectory ? path.join(config.storeDirectory, 'locks-headers') : null);
  async function read(fn) {
    const peer = await resetPeer;
    if (!peer || peer.base.key.toString('hex') !== config.trac.reset.bootstrap) throw new Error('Untrusted RESET reader');
    const view = peer.base.view.checkout(peer.base.view.core.signedLength);
    try { return await fn(view, peer); } finally { await view.close(); }
  }
  let indexing = false, dirty = false;
  const update = async () => {
    dirty = true; if (indexing) return; indexing = true;
    try { while (dirty) { dirty = false; await read(view => index.update(view)); } }
    catch {} finally { indexing = false; }
  };
  Promise.resolve(resetPeer).then(peer => {
    if (typeof peer?.base?.on === 'function') { peer.base.on('update', update); void update(); }
  }).catch(() => {});
  const headers = async (view, cursor = 0, limit = 100) => {
    number(cursor); number(limit); if (!limit || limit > 1000) throw new Error('Invalid page size');
    const total = number((await view.get('msgl'))?.value ?? 0), rows = [];
    const end = Math.min(cursor + limit, total);
    for (let i = cursor; i < end; i++) {
      const entry = await view.get(`msg/${i}`); let p;
      try { p = JSON.parse(entry?.value.msg); } catch { continue; }
      if (p?.t === 'header' && Array.isArray(p.p?.hx)) rows.push({ index: i, seq: entry.seq, headers: p.p.hx });
    }
    return { rows, next: end, total };
  };
  return {
    locks_clock: ({ height } = {}) => read(async view => {
      const beacon = (await view.get('beacon/state'))?.value;
      const counted = number(beacon?.counted ?? config.trac.reset.beaconOptions?.checkpoint?.height);
      const hash = height === undefined ? undefined : (await view.get(`hash/${number(height)}`))?.value ?? null;
      return { counted, ...(height === undefined ? {} : { hash }), signedLength: view.version };
    }),
    locks_headers: ({ cursor = 0, limit = 100 } = {}) => read(view => headers(view, cursor, limit)),
    locks_header: ({ height, hash }) => read(async view => {
      number(height);
      if (!/^[0-9a-f]{64}$/.test(hash) || (await view.get(`hash/${height}`))?.value !== hash) throw new Error('Unknown counted hash');
      return index.get(view, hash);
    }),
    locks_balances: ({ address }) => read(async view => {
      const key = PeerWallet.decodeBech32mSafe(address);
      if (!key || key.length !== 32 || PeerWallet.encodeBech32mSafe('trac', key) !== address) throw new Error('Invalid lock address');
      const entry = await bus.state.getNodeEntry(address);
      const RESET = (await view.get(`bal/${key.toString('hex')}`))?.value ?? '0';
      if (!/^(0|[1-9][0-9]*)$/.test(RESET)) throw new Error('Invalid RESET balance');
      return { final: true, RESET, TNK: entry ? bufferToBigInt(entry.balance).toString() : '0', feeTnk: bufferToBigInt(bus.state.getFee()).toString() };
    }),
  };
}

// Called before the DEX bridge handler; existing DEX commands retain their path.
export function handleLocksJoin(bridge, client, message) {
  if (message?.type !== 'locks_join') return false;
  const reply = payload => bridge._broadcastToClient(client, { ...(Number.isInteger(message.id) ? { id: message.id } : {}), ...payload });
  if (bridge.requireAuth && !client.authed) { reply({ type: 'error', error: 'Unauthorized.' }); return true; }
  if (!joinsLocks(bridge.info ?? {})) { reply({ type: 'error', error: 'A dedicated locks peer or trader locks switch is required' }); return true; }
  const feed = bridge.info?.role === 'market-feed';
  if (!isLocksChannel(message.channel) || feed && message.channel !== LOCKS_CHANNEL || !bridge.sidechannel) { reply({ type: 'error', error: 'Invalid locks channel' }); return true; }
  bridge.sidechannel.openChannels.add(message.channel);
  Promise.resolve(bridge.sidechannel.addChannel(message.channel)).then(ok => reply(ok ? { type: 'joined', channel: message.channel } : { type: 'error', error: 'Join denied' }),
    error => reply({ type: 'error', error: error.message }));
  return true;
}
