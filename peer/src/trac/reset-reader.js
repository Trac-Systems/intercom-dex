import { verifyResetSource } from './source.js';
import { Peer, Wallet, createConfig, ENV } from 'trac-peer';

export async function openResetReader({ bus, config, walletAt }) {
  if (config.trac === undefined) return null;
  const reset = config.trac?.reset;
  const fields = ['bootstrap', 'channel', 'dhtBootstrap', 'source', 'beaconOptions'];
  if (!config.trac || Object.keys(config.trac).length !== 1 || !reset || typeof reset !== 'object' || Array.isArray(reset) || Object.keys(reset).some(key => !fields.includes(key)) || !/^[0-9a-f]{64}$/.test(reset.bootstrap ?? '') || typeof reset.channel !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(reset.channel) || !Array.isArray(reset.dhtBootstrap) || !reset.dhtBootstrap.length || reset.dhtBootstrap.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9.\[\]:-]+:\d+$/.test(value)) || !reset.source) throw new Error('Invalid trac.reset configuration');
  if (reset.beaconOptions != null && config.environment !== 'development') throw new Error('Test RESET beacon options require development environment');
  const source = verifyResetSource(reset.source, { local: config.environment === 'development' });
  const { default: Protocol } = await import(source.protocolFile);
  const { default: Contract } = await import(source.contractFile);
  const pc = createConfig(ENV[config.environment.toUpperCase()], {
    storesDirectory: config.storeDirectory, storeName: 'reset-reader', bootstrap: reset.bootstrap,
    channel: reset.channel, dhtBootstrap: reset.dhtBootstrap, txContentHash: 'utf8-strict',
    enableInteractiveMode: false, replicate: true, enableUpdater: true, enableBackgroundTasks: false,
    enableTxlogs: false, apiMsgExposed: false, apiTxExposed: false
  });
  if (reset.beaconOptions != null) pc.beaconOptions = reset.beaconOptions;
  const wallet = await walletAt(pc.keyPairPath, Wallet, { networkPrefix: bus.config.addressPrefix, derivationPath: bus.config.derivationPath });
  const reader = new Peer({ config: pc, msb: bus, wallet, protocol: Protocol, contract: Contract });
  try {
    await reader.ready();
    if (reader.base.writable) throw new Error('RESET reader must not be an admitted writer');
    return reader;
  } catch (error) {
    try { await reader.close(); } finally { await reader.store.close(); }
    throw error;
  }
}
