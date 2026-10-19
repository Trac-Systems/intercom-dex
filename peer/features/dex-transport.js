import { ensureTextCodecs } from 'trac-peer/src/textCodec.js';

// Noble's verifier needs the peer's text codecs during module initialization under Bare.
await ensureTextCodecs();
const { CHAT_CHANNEL, MarketChat } = await import('../../src/market/chat.js');

const DEX_CHANNELS = ['intercom-dex', 'intercom-dex:offers', 'intercom-dex:signers', CHAT_CHANNEL];

export const DEX_POW_BITS = 20;
// Stamping order: post-lock safety messages, then negotiation with a trade's counterparty, then everything else.
// Declines answer strangers: stamped last, and dropped instead of queued while one is waiting.
export const DEX_POW_CLASSES = [['transferSent', 'ack', 'sharePublish', 'shareRequest', 'deal', 'claimed', 'refunded', 'summon'],
  ['take', 'accept', 'reveal', 'terms', 'termsSig', 'working', 'abort']];
export const DEX_POW_LOW = ['decline'];

export function dexTransport(config) {
  if (!['service', 'signer', 'trader', 'market-feed'].includes(config.role)) throw new Error('Explicit peer role required');
  if (!/^[0-9a-f]{64}$/.test(config.servicePeerKey ?? '')) throw new Error('servicePeerKey required');
  if (config.serveRelay !== undefined && typeof config.serveRelay !== 'boolean') throw new Error('Invalid serveRelay');
  if (['trader', 'market-feed'].includes(config.role) && config.serveRelay === true) throw new Error('Traders do not serve relays');
  const chat = new MarketChat({ chatRelays: config.chatRelays ?? [] });
  return {
    relay: { serve: !['trader', 'market-feed'].includes(config.role) && config.serveRelay !== false, relays: config.relayKeys ?? [] },
    sidechannel: { channels: DEX_CHANNELS, openChannels: DEX_CHANNELS, welcomeRequired: false,
      acceptMessage: (channel, payload) => channel !== CHAT_CHANNEL || chat.receive(payload?.message) !== null,
      ownerWriteChannels: ['intercom-dex'], ownerKeys: { 'intercom-dex': config.servicePeerKey },
      powEnabled: true, powDifficulty: DEX_POW_BITS,
      powClasses: DEX_POW_CLASSES, powLowKinds: DEX_POW_LOW,
      powRequiredChannels: ['intercom-dex:offers', 'intercom-dex:signers', CHAT_CHANNEL], powRequiredPrefixes: ['intercom-dex:t:'],
      maxMessageBytes: 200_000, rateBytesPerSecond: 64_000, rateBurstBytes: 256_000 },
  };
}
