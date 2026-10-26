import { bufferToBigInt } from 'trac-msb/src/utils/amountSerialization.js';
import { broadcastTnkTransfer } from './broadcast.js';
import { createTransferVerifier } from './verify-transfer.js';
import PeerWallet from 'trac-wallet';
import { readBalances } from './balances.js';

// resetPeer may still be opening (a promise): until it is open, RESET balances and context fail as not ready, and a
// RESET transfer check answers reset_reader_required (not final), which every caller retries.
export function makeHandlers({ bus, config, resetPeer = null }) {
  const resetBootstrap = config?.trac?.reset?.bootstrap ?? null;
  let reader, failure = null, verify = null;
  // The reader is checked against the pinned RESET bootstrap as soon as it is known.
  const pin = r => { verify = createTransferVerifier({ msb: bus, resetPeer: r, resetBootstrap }); return r; };
  if (typeof resetPeer?.then === 'function') resetPeer.then(r => { reader = pin(r); }).catch(e => { failure = e; });
  else reader = pin(resetPeer);
  const tnkOnly = createTransferVerifier({ msb: bus, resetPeer: null, resetBootstrap });
  const opened = () => {
    if (reader === undefined) throw new Error(failure ? `RESET reader failed: ${failure.message}` : 'RESET reader is not ready yet');
    if (!reader) throw new Error('RESET reader is not configured');
    return reader;
  };
  const balances = new Map();
  async function info() {
    return { networkId: bus.config.networkId, txv: (await bus.state.getIndexerSequenceState()).toString('hex'),
      addressPrefix: bus.config.addressPrefix, msbBootstrap: bus.config.bootstrap.toString('hex'),
      feeTnk: bufferToBigInt(bus.state.getFee()).toString() };
  }
  return {
    async dex_balances({ address } = {}) {
      const key = typeof address === 'string' && PeerWallet.decodeBech32mSafe(address);
      if (!key || key.length !== 32 || PeerWallet.encodeBech32mSafe(bus.config.addressPrefix, key) !== address) throw new Error('Invalid Trac address');
      const resetPeer = opened();
      // Dashboard, funds checks and agents may ask together. Share only the in-flight read; a later
      // trading/withdrawal request always captures new signed views and never receives a stale balance.
      if (!balances.has(address)) {
        if (balances.size >= 64) throw new Error('Too many balance reads in progress; retry shortly');
        const pending = readBalances({ bus, resetPeer, address, key }).finally(() => balances.delete(address));
        balances.set(address, pending);
      }
      return balances.get(address);
    },
    dex_msb_info: info,
    async dex_tnk_broadcast({ payload } = {}) {
      const { txHash } = await broadcastTnkTransfer(bus, payload);
      return { txHash };
    },
    async dex_reset_context() {
      opened();
      const context = await info();
      return { networkId: context.networkId, txv: context.txv, addressPrefix: context.addressPrefix,
        subnet: resetBootstrap, msb: context.msbBootstrap };
    },
    dex_verify: args => (reader === undefined ? tnkOnly : verify)(args)
  };
}
