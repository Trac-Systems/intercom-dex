import { ensureTextCodecs } from 'trac-peer/src/textCodec.js';

// Noble's verifier needs the peer's text codecs during module initialization under Bare.
await ensureTextCodecs();
const { CHAT_CHANNEL, MarketChat } = await import('../../src/market/chat.js');

const DEX_CHANNELS = ['intercom-dex', 'intercom-dex:offers', 'intercom-dex:signers', CHAT_CHANNEL];

export const DEX_POW_BITS = 20;
// Stamping order: heartbeats and post-lock safety messages, then negotiation with a trade's counterparty, then
// everything else. A signer whose heartbeat waited behind its trade messages looked offline to traders (90 s), and
// every trade needs the whole committee. Declines answer strangers: stamped last, and dropped while one is waiting.
export const DEX_POW_CLASSES = [['heartbeat', 'transferSent', 'ack', 'sharePublish', 'shareRequest', 'deal', 'claimed', 'refunded', 'summon'],
  ['take', 'accept', 'reveal', 'terms', 'termsSig', 'working', 'abort']];
export const DEX_POW_LOW = ['decline'];
// Per-connection inbound limit. A signer or venue receives the whole network's traffic over a few connections (offers,
// the venue's book, chat and every trade); at 64 kB/s those connections were blocked for 30 s at a time and the
// buyers' dealings on them were dropped, so most trades never reached the whole committee.
export const SERVER_ROLES = ['service', 'signer'];
export const SERVER_RATE = { rateBytesPerSecond: 2_000_000, rateBurstBytes: 8_000_000 };
export const TRADER_RATE = { rateBytesPerSecond: 64_000, rateBurstBytes: 256_000 };
export const TRADER_DISCOVERY_PEERS = 8;

export function dexTransport(config) {
  if (!['service', 'signer', 'trader', 'market-feed'].includes(config.role)) throw new Error('Explicit peer role required');
  if (!/^[0-9a-f]{64}$/.test(config.servicePeerKey ?? '')) throw new Error('servicePeerKey required');
  if (config.serveRelay !== undefined && typeof config.serveRelay !== 'boolean') throw new Error('Invalid serveRelay');
  if (['trader', 'market-feed'].includes(config.role) && config.serveRelay === true) throw new Error('Traders do not serve relays');
  const chat = new MarketChat({ chatRelays: config.chatRelays ?? [] });
  return {
    ...(['trader', 'market-feed'].includes(config.role) ? { connections: {
      maxPeers: TRADER_DISCOVERY_PEERS, maxClientConnections: TRADER_DISCOVERY_PEERS,
    } } : {}),
    relay: { serve: !['trader', 'market-feed'].includes(config.role) && config.serveRelay !== false, relays: config.relayKeys ?? [] },
    sidechannel: { channels: DEX_CHANNELS, openChannels: DEX_CHANNELS, welcomeRequired: false,
      ...(config.role === 'service' ? { publicSend: { rate: 32000, burst: 224000, maxQueue: 512000 } } : {}),
      // Public leaf protocols use only the pinned venue, including when their other connections run old releases.
      // Servers retain forwarding to legacy neighbors; private trade relays are unaffected.
      publicDelivery: { channels: DEX_CHANNELS, venueKey: config.servicePeerKey,
        leaf: ['trader', 'market-feed'].includes(config.role), venueOnly: ['trader', 'market-feed'].includes(config.role),
        forwarder: config.role === 'service' },
      ...(['trader', 'market-feed'].includes(config.role) ? {
        noRelayChannels: DEX_CHANNELS, discovery: { server: false, client: true },
      } : {}),
      acceptMessage: (channel, payload) => channel !== CHAT_CHANNEL || chat.receive(payload?.message) !== null,
      ownerWriteChannels: ['intercom-dex'], ownerKeys: { 'intercom-dex': config.servicePeerKey },
      powEnabled: true, powDifficulty: DEX_POW_BITS,
      powClasses: DEX_POW_CLASSES, powLowKinds: DEX_POW_LOW,
      powRequiredChannels: ['intercom-dex:offers', 'intercom-dex:signers', CHAT_CHANNEL], powRequiredPrefixes: ['intercom-dex:t:'],
      maxMessageBytes: 200_000, ...(SERVER_ROLES.includes(config.role) ? SERVER_RATE : TRADER_RATE) },
  };
}
