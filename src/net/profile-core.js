import { stableJSON } from '../core/canonical.js';
import { isSolanaAddress } from '../core/addresses.js';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const required = x => typeof x === 'string' && x.startsWith('REQUIRED:');

function merge(pins, input, network, prefix = '') {
  const result = JSON.parse(stableJSON(pins));
  for (const [key, value] of Object.entries(input ?? {})) {
    const field = prefix + key;
    if (!Object.hasOwn(pins, key)) throw new Error(`Unknown network field: ${field}`);
    if (object(pins[key]) && object(value)) result[key] = merge(pins[key], value, network, field + '.');
    else {
      if (network === 'mainnet' && stableJSON(value) !== stableJSON(pins[key])) throw new Error(`Mainnet pins ${field}; config overrides are refused`);
      result[key] = JSON.parse(stableJSON(value));
    }
  }
  return result;
}

function complete(value, prefix = '') {
  for (const [key, field] of Object.entries(value)) {
    if (required(field) || (Array.isArray(field) && field.some(required))) throw new Error(`Network profile requires ${prefix + key}; fill the source profile before starting`);
    if (object(field)) complete(field, prefix + key + '.');
  }
}

// Both processes resolve the same source profile. Only local accepts deployment overrides.
export function resolveProfile(config, pins, isAbsolute) {
  if (!['mainnet', 'local'].includes(config?.network)) throw new Error('Choose network: mainnet or local');
  const input = {};
  for (const key of ['mint', 'programId', 'platformCollector', 'peer', 'trade', 'chatRelays']) if (config[key] !== undefined) input[key] = config[key];
  if (config.solana?.mint !== undefined) input.mint = config.solana.mint;
  if (config.solana?.programId !== undefined) input.programId = config.solana.programId;
  if (config.solana?.platformCollector !== undefined) input.platformCollector = config.solana.platformCollector;
  // Check aliases independently: a second spelling must not mask a forbidden override.
  if (config.peer !== undefined) merge(pins, { peer: config.peer }, config.network);
  for (const key of ['mint', 'programId', 'platformCollector']) {
    if (config[key] !== undefined) merge(pins, { [key]: config[key] }, config.network);
    if (config.solana?.[key] !== undefined) merge(pins, { [key]: config.solana[key] }, config.network);
  }
  for (const key of ['environment', 'msbBootstrap', 'msbChannel', 'msbNetworkId', 'msbDhtBootstrap', 'peerDhtBootstrap', 'trac']) {
    if (config[key] === undefined) continue;
    if (config.network === 'mainnet') merge(pins, { peer: key === 'trac' ? { trac: { ...(config.trac.reset ? { reset: config.trac.reset } : {}) } } : { [key]: config[key] } }, config.network);
    if (key === 'trac') {
      if (config.trac.reset !== undefined) input.peer = { ...input.peer, trac: { reset: config.trac.reset } };
    } else input.peer = { ...input.peer, [key]: config[key] };
  }
  const profile = merge(pins, input, config.network);
  complete(profile);
  if (!Array.isArray(profile.chatRelays) || profile.chatRelays.length > 128 ||
      new Set(profile.chatRelays).size !== profile.chatRelays.length ||
      profile.chatRelays.some(key => typeof key !== 'string' || key.length !== 64 || !/^[0-9a-f]{64}$/.test(key))) throw new Error('Invalid chatRelays');
  for (const key of ['mint', 'programId', 'platformCollector']) if (!isSolanaAddress(profile[key])) throw new Error(`Invalid network ${key}`);
  const peer = profile.peer, reset = peer.trac.reset;
  if (!['mainnet', 'development', 'testnet1'].includes(peer.environment) || !Number.isSafeInteger(peer.msbNetworkId) || peer.msbNetworkId < 0) throw new Error('Invalid MSB network identity');
  for (const [key, value] of Object.entries({ msbBootstrap: peer.msbBootstrap, resetBootstrap: reset.bootstrap,
    manifestSha256: reset.source?.manifestSha256 })) if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`Invalid network ${key}`);
  for (const channel of [peer.msbChannel, reset.channel]) if (!/^[a-zA-Z0-9_-]{1,32}$/.test(channel)) throw new Error('Invalid network channel');
  for (const bootstrap of [peer.msbDhtBootstrap, peer.peerDhtBootstrap, reset.dhtBootstrap]) {
    if (!Array.isArray(bootstrap) || !bootstrap.length || bootstrap.some(x => typeof x !== 'string' || !/^[a-zA-Z0-9.\[\]:-]+:\d+$/.test(x))) throw new Error('Invalid DHT bootstrap');
  }
  if (!/^[0-9a-f]{40}$/.test(reset.source?.commit)) throw new Error('Invalid RESET commit');
  if (reset.source.directory != null && (config.network !== 'local' || typeof reset.source.directory !== 'string' || !isAbsolute(reset.source.directory))) throw new Error('RESET source directory override requires local tests');
  return { network: config.network, ...profile };
}

export function checkProfileRegistry(registry, profile) {
  if (!profile.trade) return;
  for (const key of ['sendWindowSec', 'refundSec', 'graceSec']) {
    if (registry.params[key] !== profile.trade[key]) throw new Error(`Registry ${key} differs from the network profile`);
  }
  if (!(registry.params.k >= profile.trade.minK)) throw new Error('Registry k is below the network profile minimum');
}

export function checkProfileTerms(terms, profile) {
  if (terms.mint !== profile.mint || terms.fees.platformCollector !== profile.platformCollector) throw new Error('Terms differ from the network profile');
  if (!profile.trade) return;
  const { sendWindowSec, refundSec, graceSec, minK } = profile.trade;
  if (terms.graceSec !== graceSec) throw new Error('Terms graceSec differs from the network profile');
  if (terms.refundAfter - terms.sendBy !== refundSec - sendWindowSec) throw new Error('Terms deadlines differ from the network profile');
  if (!(terms.k >= minK)) throw new Error('Terms k is below the network profile minimum');
}

export function checkPeerProfile(info, profile) {
  if (!info?.networkProfile || stableJSON(info.networkProfile) !== stableJSON(profile)) throw new Error('Peer network profile differs from the role profile');
}
