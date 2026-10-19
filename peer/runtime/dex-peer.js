import fs from 'fs';
import path from 'path';
import process from 'process';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import { Peer, Wallet, createConfig, ENV } from 'trac-peer';
import { ensureTextCodecs } from 'trac-peer/src/textCodec.js';
import { MainSettlementBus } from 'trac-msb/src/index.js';
import { createConfig as msbConfig, ENV as MSB_ENV } from 'trac-msb/src/config/env.js';
import DexProtocol from '../contract/protocol.js';
import DexContract from '../contract/contract.js';
import { dexTransport } from '../features/dex-transport.js';
import Sidechannel from '../features/sidechannel/index.js';
import BlindRelay from '../features/blind-relay/index.js';
import DexBridge, { DEX_CHANNELS } from '../features/dex-bridge.js';
import { openResetReader } from '../src/trac/reset-reader.js';
import { verifyResetSource } from '../src/trac/source.js';
import { subnetChannel } from './subnet-channel.js';
import { resolveProfile } from '../../src/net/profile-core.js';

const hex32 = /^[0-9a-f]{64}$/;
const FIELDS = new Set(['environment', 'msbBootstrap', 'msbChannel', 'msbDhtBootstrap', 'peerDhtBootstrap',
  'chatRelays', 'role', 'servicePeerKey', 'storeDirectory', 'subnetChannel', 'validatorKey', 'relayKeys', 'serveRelay', 'bridge', 'trac', 'msbNetworkId']);

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected a peer configuration object');
  for (const key of Object.keys(config)) if (!FIELDS.has(key)) throw new Error(`Unknown peer config field: ${key}`);
  if (!['development', 'testnet1', 'mainnet'].includes(config.environment)) throw new Error('Set an explicit environment');
  if (!hex32.test(config.msbBootstrap ?? '')) throw new Error('Explicit MSB bootstrap required');
  for (const key of ['msbChannel', 'subnetChannel'])
    if (typeof config[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(config[key])) throw new Error(`Explicit ${key} required`);
  for (const key of ['msbDhtBootstrap', 'peerDhtBootstrap'])
    if (!Array.isArray(config[key]) || !config[key].length || config[key].some(x => typeof x !== 'string' || !/^[a-zA-Z0-9.\[\]:-]+:\d+$/.test(x)))
      throw new Error(`Explicit ${key} required`);
  if (typeof config.storeDirectory !== 'string' || !path.isAbsolute(config.storeDirectory)) throw new Error('Absolute storeDirectory required');
  const b = config.bridge;
  if (!b || !Number.isInteger(b.port) || b.port < 1024 || b.port > 65535 || typeof b.tokenFile !== 'string' || !path.isAbsolute(b.tokenFile))
    throw new Error('bridge needs {port, tokenFile (absolute)}');
  if (config.relayKeys !== undefined && (!Array.isArray(config.relayKeys) || config.relayKeys.some(x => !hex32.test(x)))) throw new Error('Invalid relay keys');
  if (config.validatorKey !== undefined && !hex32.test(config.validatorKey)) throw new Error('Invalid validatorKey');
}

async function walletAt(filename, WalletClass, options) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const wallet = new WalletClass(options); await wallet.ready;
  if (fs.existsSync(filename)) wallet.importFromFile(filename, b4a.alloc(0));
  else {
    await wallet.generateKeyPair(null, options.derivationPath);
    wallet.exportToFile(filename, b4a.alloc(0));
    fs.chmodSync(filename, 0o600);
  }
  return wallet;
}

async function until(fn, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

// One dex peer: MSB client, a private subnet (identity + swarm only), the dex sidechannels and the local bridge
// its agent uses. `makeHandlers({bus, peer, config})` adds the Trac commands (send/verify) to the bridge.
export async function runDexPeer(flags, { makeHandlers, configurePeer } = {}) {
  if (!globalThis.Bare) throw new Error('The dex peer requires the Pear runner');
  const input = JSON.parse(fs.readFileSync(flags.config, 'utf8'));
  if (!['mainnet', 'local'].includes(input.network)) throw new Error('Choose network: mainnet or local');
  const pins = JSON.parse(fs.readFileSync(new URL(`../../networks/${input.network}.json`, import.meta.url).pathname, 'utf8'));
  const profile = resolveProfile(input, pins, path.isAbsolute);
  verifyResetSource(profile.peer.trac.reset.source, { local: input.network === 'local' });
  const { network, mint, programId, platformCollector, peer: _peer, trade: _trade, ...operational } = input;
  if (network === 'mainnet' && operational.validatorKey !== undefined) throw new Error('Mainnet refuses validatorKey override');
  const config = { ...operational, ...profile.peer, chatRelays: profile.chatRelays };
  config.subnetChannel = subnetChannel(config.storeDirectory, config.subnetChannel);
  validateConfig(config);
  const transport = dexTransport(config);
  const token = fs.readFileSync(config.bridge.tokenFile, 'utf8').trim();
  if (token.length < 32) throw new Error('Bridge token too short');
  let bus, peer, resetPeer, relay, sidechannel, bridge, closing, finish;
  const lifetime = new Promise(resolve => { finish = resolve; });
  const close = () => closing ??= (async () => {
    let failure;
    for (const stop of [() => bridge?.stop(), () => sidechannel?.stop(), () => relay?.stop(), () => peer?.close(),
      () => peer?.store.close(), () => resetPeer?.close(), () => resetPeer?.store.close(), () => bus?.close()]) {
      try { await stop(); } catch (error) { failure ??= error; }
    }
    finish();
    if (failure) throw failure;
  })();
  const shutdown = () => void close().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, shutdown);
  globalThis.Pear?.teardown?.(shutdown);
  try {
    await ensureTextCodecs();
    const devnet = config.validatorKey !== undefined;
    const mc = msbConfig(MSB_ENV[config.environment.toUpperCase()], {
      bootstrap: config.msbBootstrap, channel: config.msbChannel, dhtBootstrap: config.msbDhtBootstrap,
      storesDirectory: config.storeDirectory, storeName: 'msb', enableInteractiveMode: false,
      enableWallet: true, enableRoleRequester: false, enableValidatorObserver: !devnet, enableTxApplyLogs: false });
    if (mc.networkId !== config.msbNetworkId) throw new Error('MSB networkId differs from the network profile');
    const options = { networkPrefix: mc.addressPrefix, derivationPath: mc.derivationPath };
    bus = new MainSettlementBus(mc, await walletAt(mc.keyPairPath, PeerWallet, options)); await bus.ready();
    if (devnet) {
      await bus.network.tryConnect(config.validatorKey, 'validator');
      await until(() => bus.state.getAdminEntry(), 'local MSB synchronized');
    }
    const pc = createConfig(ENV[config.environment.toUpperCase()], {
      storesDirectory: config.storeDirectory, storeName: 'peer', bootstrap: null, channel: config.subnetChannel,
      dhtBootstrap: config.peerDhtBootstrap, txContentHash: 'utf8-strict', enableInteractiveMode: false,
      replicate: true, enableUpdater: true, enableBackgroundTasks: true, enableTxlogs: false,
      apiMsgExposed: false, apiTxExposed: false });
    peer = new Peer({ config: pc, msb: bus, wallet: await walletAt(pc.keyPairPath, Wallet, options),
      protocol: DexProtocol, contract: DexContract }); await peer.ready();
    if (configurePeer) await configurePeer(peer);
    relay = new BlindRelay(peer, transport.relay);
    await relay.start(); peer.blindRelay = relay;
    resetPeer = await openResetReader({ bus, config, walletAt });
    const handlers = makeHandlers ? await makeHandlers({ bus, peer, config, resetPeer }) : {};
    bridge = new DexBridge(peer, { host: '127.0.0.1', port: config.bridge.port, token, requireAuth: true, handlers,
      info: { peerPubkey: peer.wallet.publicKey, swarmPublicKey: peer.swarm.keyPair.publicKey.toString('hex'),
        msbAddress: bus.wallet?.address ?? null, environment: config.environment, networkProfile: profile, servicePeerKey: config.servicePeerKey, role: config.role } });
    sidechannel = new Sidechannel(peer, { ...transport.sidechannel,
      onMessage: (channel, payload, connection) => bridge.handleSidechannelMessage(channel, payload, connection) });
    peer.sidechannel = sidechannel;
    bridge.attachSidechannel(sidechannel);
    bridge.start();
    await sidechannel.start();
    console.log('DEX_PEER_READY ' + JSON.stringify({ pid: process.pid, peerPubkey: peer.wallet.publicKey,
      msbAddress: bus.wallet?.address ?? null, bridge: `ws://127.0.0.1:${config.bridge.port}`,
      swarmPublicKey: peer.swarm.keyPair.publicKey.toString('hex') }));
    await lifetime;
  } catch (error) {
    await close(); throw error;
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, shutdown);
  }
}
