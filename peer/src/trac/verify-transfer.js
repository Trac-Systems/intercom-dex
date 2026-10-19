import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import { unsafeDecodeApplyOperation } from 'trac-msb/src/utils/protobuf/operationHelpers.js';
import { bufferToBigInt } from 'trac-msb/src/utils/amountSerialization.js';
import { createHash } from 'trac-peer/src/utils/types.js';

const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const hex = value => b4a.isBuffer(value) ? value.toString('hex') : null;
const result = (reason, final = false, amount = null) => ({ ok: reason === null, reason, amount, final });
const positive = value => typeof value === 'string' && value.length <= 78 && /^[1-9][0-9]*$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function keyFor(address, prefix) {
  if (typeof address !== 'string' || !address.startsWith(`${prefix}1`)) return null;
  const key = PeerWallet.decodeBech32mSafe(address);
  return key?.length === 32 && PeerWallet.encodeBech32mSafe(prefix, key) === address ? key.toString('hex') : null;
}

export function createTransferVerifier({ msb, resetPeer = null, resetBootstrap = null }) {
  if (typeof msb?.state?.getSigned !== 'function' || typeof msb?.config?.addressPrefix !== 'string' || !b4a.isBuffer(msb?.config?.bootstrap) || msb.config.bootstrap.length !== 32) throw new Error('Expected local MSB signed state and configuration');
  if (resetPeer && (!isHash(resetBootstrap) || hex(resetPeer.base?.key) !== resetBootstrap || typeof resetPeer.base?.view?.checkout !== 'function')) throw new Error('RESET peer does not match trusted bootstrap');

  return async function verifyTransfer({ asset, txHash, from, to, minAmount, nonce } = {}) {
    if (!['TNK', 'RESET'].includes(asset)) return result('wrong_asset');
    if (!isHash(txHash) || !isHash(nonce) || !positive(minAmount) || (asset === 'TNK' ? !keyFor(from, msb.config.addressPrefix) || !keyFor(to, msb.config.addressPrefix) : !isHash(from) || !isHash(to))) return result('invalid_request');
    let raw;
    try { raw = await msb.state.getSigned(txHash); }
    catch { return result('read_failed'); }
    // A signed-only reader cannot distinguish unknown from present-but-unsigned.
    if (raw === null) return result('unknown_or_not_final');
    let op;
    try { op = unsafeDecodeApplyOperation(raw); }
    catch { return result('invalid_msb_record'); }
    const tx = asset === 'TNK' ? op?.tro : op?.txo;
    if (op?.type !== (asset === 'TNK' ? 13 : 12)) return result('wrong_asset', true);
    if (!tx || hex(tx.tx) !== txHash || tx.in?.length !== 32 || !b4a.isBuffer(op.address)) return result('invalid_msb_record');
    const sender = keyFor(op.address.toString('ascii'), msb.config.addressPrefix);
    if (!sender) return result('invalid_msb_record');
    if (asset === 'TNK') {
      let amount;
      try { amount = bufferToBigInt(tx.am).toString(); }
      catch { return result('invalid_msb_record'); }
      if (!positive(amount) || !keyFor(tx.to?.toString('ascii'), msb.config.addressPrefix)) return result('invalid_msb_record');
      if (op.address.toString('ascii') !== from) return result('wrong_from', true, amount);
      if (tx.to.toString('ascii') !== to) return result('wrong_to', true, amount);
      if (hex(tx.in) !== nonce) return result('wrong_nonce', true, amount);
      if (BigInt(amount) < BigInt(minAmount)) return result('wrong_amount', true, amount);
      return result(null, true, amount);
    }
    if (!resetPeer) return result('reset_reader_required');
    if (hex(tx.bs) !== resetBootstrap || hex(tx.mbs) !== hex(msb.config.bootstrap)) return result('wrong_contract', true);
    let row;
    try {
      const view = resetPeer.base.view.checkout(resetPeer.base.view.core.signedLength);
      try {
        const index = await view.get(`tx/${txHash}`);
        if (index === null) return result('reset_not_final');
        if (!Number.isSafeInteger(index.value) || index.value < 0) return result('invalid_reset_record');
        row = (await view.get(`txi/${index.value}`))?.value;
      } finally { await view.close(); }
    } catch { return result('read_failed'); }
    if (!row || row.tx !== txHash || row.ipk !== sender || !Object.hasOwn(row, 'err') || !exact(row.val, ['type', 'value']) || row.val.type !== 'transfer' || !exact(row.val.value, ['to', 'amount']) || !isHash(row.val.value.to) || !positive(row.val.value.amount)) return result('invalid_reset_record');
    let contentHash;
    try { contentHash = await createHash(JSON.stringify(row.val)); }
    catch { return result('invalid_reset_record'); }
    if (contentHash !== hex(tx.ch)) return result('wrong_content', true);
    const amount = row.val.value.amount;
    if (row.err !== null) return result('contract_rejected', true, amount);
    if (sender !== from) return result('wrong_from', true, amount);
    if (row.val.value.to !== to) return result('wrong_to', true, amount);
    if (hex(tx.in) !== nonce) return result('wrong_nonce', true, amount);
    if (BigInt(amount) < BigInt(minAmount)) return result('wrong_amount', true, amount);
    return result(null, true, amount);
  };
}
