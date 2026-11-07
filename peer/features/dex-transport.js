import { ensureTextCodecs } from 'trac-peer/src/textCodec.js';

// Noble's verifier needs the peer's text codecs during module initialization under Bare.
await ensureTextCodecs();
const { CHAT_CHANNEL, MarketChat } = await import('../../src/market/chat.js');

const DEX_CHANNELS = ['intercom-dex', 'intercom-dex:offers', 'intercom-dex:signers', CHAT_CHANNEL, 'intercom-dex:bonds'];

export const DEX_POW_BITS = 20;
// Stamping order: heartbeats and post-lock safety messages, then negotiation with a trade's counterparty, then
// dealings, then everything else. Repeated dealings must yield to accept/reveal's short freshness window.
// A signer whose heartbeat waited behind its trade messages looked offline to traders (90 s), and
// every trade needs the whole committee. Declines answer strangers: stamped last, and dropped while one is waiting.
export const DEX_POW_CLASSES = [['heartbeat', 'transferSent', 'ack', 'sharePublish', 'shareRequest', 'claimed', 'refunded', 'summon'],
  ['take', 'accept', 'reveal', 'terms', 'termsSig', 'working', 'abort'], ['deal', 'stakeReply', 'stakeRequest', 'stakeManifest', 'stakePage']];
export const DEX_POW_LOW = ['decline'];
// Per-connection inbound limit. A signer or venue receives the whole network's traffic over a few connections (offers,
// the venue's book, chat and every trade); at 64 kB/s those connections were blocked for 30 s at a time and the
// buyers' dealings on them were dropped, so most trades never reached the whole committee.
export const SERVER_ROLES = ['service', 'signer'];
// Venue, signers and payout stamp every stake request and reply; eight threads keep replies inside the stake timeout.
export const SERVER_POW_WORKERS = 8;
// Stake requests and replies are independent, so peers stamp them side by side, one lane per worker. A stake message carries its signed
// time `at` (seconds) and its method; its requester gives up after 30 s (rewardBlock 60 s, src/stake/runtime.js), so
// one still unstamped 15 s after that is dropped (same rule as src/stake/transport.js stakeMessageExpired).
export const STAKE_POW_CHANNEL = 'intercom-dex:bonds';
export function stakeMessageExpired(channel, message, now = Date.now()) {
  return channel === STAKE_POW_CHANNEL && Number.isSafeInteger(message?.at) &&
    now / 1000 - message.at > (message.method === 'rewardBlock' ? 75 : 45);
}
export const SERVER_RATE = { rateBytesPerSecond: 2_000_000, rateBurstBytes: 8_000_000 };
export const TRADER_RATE = { rateBytesPerSecond: 64_000, rateBurstBytes: 256_000 };

export function dexTransport(config) {
  if (!['service', 'signer', 'trader', 'market-feed', 'payout'].includes(config.role)) throw new Error('Explicit peer role required');
  if (!/^[0-9a-f]{64}$/.test(config.servicePeerKey ?? '')) throw new Error('servicePeerKey required');
  if (config.serveRelay !== undefined && typeof config.serveRelay !== 'boolean') throw new Error('Invalid serveRelay');
  if (['trader', 'market-feed', 'payout'].includes(config.role) && config.serveRelay === true) throw new Error('Traders do not serve relays');
  const chat = new MarketChat({ chatRelays: config.chatRelays ?? [] });
  return {
    relay: { serve: !['trader', 'market-feed', 'payout'].includes(config.role) && config.serveRelay !== false, relays: config.relayKeys ?? [] },
    sidechannel: { stakeRouting: ['service', 'signer', 'payout'].includes(config.role), channels: DEX_CHANNELS, openChannels: DEX_CHANNELS, welcomeRequired: false,
      ...(config.role === 'service' ? { publicSend: { rate: 32000, burst: 224000, maxQueue: 512000 } } : {}),
      // Public leaf protocols use only the pinned venue, including when their other connections run old releases.
      // Servers retain forwarding to legacy neighbors; private trade relays are unaffected.
      publicDelivery: { channels: DEX_CHANNELS, venueKey: config.servicePeerKey,
        leaf: ['trader', 'market-feed', 'payout'].includes(config.role), venueOnly: ['trader', 'market-feed', 'payout'].includes(config.role),
        forwarder: config.role === 'service' },
      ...(['trader', 'market-feed', 'payout'].includes(config.role) ? {
        noRelayChannels: DEX_CHANNELS, discovery: { server: false, client: true },
      } : {}),
      acceptMessage: (channel, payload) => channel !== CHAT_CHANNEL || chat.receive(payload?.message) !== null,
      ownerWriteChannels: ['intercom-dex'], ownerKeys: { 'intercom-dex': config.servicePeerKey },
      // Every peer stamps stake messages in their own lanes, apart from trade messages, and drops expired ones; a trader's
      // single worker otherwise queued hours of stake polls in front of its own answers. Servers get eight workers.
      powEnabled: true, powDifficulty: DEX_POW_BITS, powParallelChannels: [STAKE_POW_CHANNEL], powExpired: stakeMessageExpired,
      ...(['service', 'signer', 'payout'].includes(config.role) ? { powWorkers: SERVER_POW_WORKERS } : {}),
      powClasses: DEX_POW_CLASSES, powLowKinds: DEX_POW_LOW,
      powRequiredChannels: ['intercom-dex:offers', 'intercom-dex:signers', CHAT_CHANNEL, 'intercom-dex:bonds'], powRequiredPrefixes: ['intercom-dex:t:'],
      maxMessageBytes: 200_000, ...(SERVER_ROLES.includes(config.role) ? SERVER_RATE : TRADER_RATE) },
  };
}
