import PeerWallet from '../../peer/node_modules/trac-wallet/index.js';
import { hexToBytes, sha256Hex, concatBytes, utf8 } from '../core/canonical.js';
import { scalarSigner } from './crypto/scalar-sign.js';

export function address(A) { return PeerWallet.encodeBech32mSafe('trac', Buffer.from(hexToBytes(A, 32))); }
export function fundingNonce(positionId, asset, takeId) {
  if (!['RESET', 'TNK'].includes(asset)) throw new Error('Invalid funding asset');
  return sha256Hex(concatBytes(utf8('intercom-locks/v1/fund'), hexToBytes(positionId, 32), utf8(asset), ...(takeId ? [hexToBytes(takeId, 32)] : [])));
}
export async function balances({ A, bridge, adapter }) {
  const value = bridge ? await bridge.call('locks_balances', { address: address(A) }) : await adapter.balances(address(A));
  if (value?.final !== true || ['RESET', 'TNK', 'feeTnk'].some(k => !/^(0|[1-9][0-9]*)$/.test(value[k] ?? ''))) throw new Error('Final lock balances unavailable');
  return value;
}

export function required({ asset, amount, tnkReserve }) {
  if (!['RESET', 'TNK'].includes(asset) || [amount, tnkReserve].some(x => !/^(0|[1-9][0-9]*)$/.test(x))) throw new Error('Invalid lock funding');
  return { RESET: asset === 'RESET' ? amount : '0', TNK: (BigInt(tnkReserve) + (asset === 'TNK' ? BigInt(amount) : 0n)).toString() };
}
export function funded(balance, input) {
  const need = required(input);
  return balance.final === true && ['RESET', 'TNK'].every(asset => BigInt(balance[asset]) >= BigInt(need[asset]));
}

// adapter must be bound to this scalar wallet and journal sends before broadcasting. A caller retries using the
// same positionId and durable journal; RESET must finalize before the TNK balance is read for the second send.
export async function sweep({ a, to, adapter, positionId, journal, asset: baseAsset = 'RESET', now = () => Math.floor(Date.now() / 1000) }) {
  hexToBytes(positionId, 32);
  if (!journal?.get || !journal?.put) throw new Error('Durable sweep journal required');
  const wallet = scalarSigner(a), from = address(wallet.publicKey);
  if (from === to || !PeerWallet.decodeBech32mSafe(to)) throw new Error('Invalid sweep destination');
  if (!['RESET', 'TNK'].includes(baseAsset)) throw new Error('Invalid sweep asset');
  const key = `locks-sweep-${positionId}-${wallet.publicKey}`, old = journal.get(key);
  if (old && (old.from !== from || old.to !== to || old.asset !== baseAsset)) throw new Error('Sweep intent mismatch');
  const state = old ?? { from, to, asset: baseAsset, steps: {} };
  for (const asset of baseAsset === 'TNK' ? ['TNK'] : ['RESET', 'TNK']) {
    let intent = state.steps[asset];
    if (intent?.done) continue;
    if (!intent) {
      const b = await adapter.balances(from);
      const amount = BigInt(b[asset]) - (asset === 'TNK' ? BigInt(b.feeTnk) : 0n);
      if (amount <= 0n) { state.steps[asset] = { done: true }; journal.put(key, state); continue; }
      const id = sha256Hex(`intercom-locks/v1/sweep:${positionId}:${wallet.publicKey}:${asset}`);
      intent = { id, amount: amount.toString(), sendBy: now() + 600, done: false };
      state.steps[asset] = intent; journal.put(key, state);
    }
    const terms = { base: { id: asset, kind: asset === 'TNK' ? 'trac-native' : 'trac-contract-token', decimals: asset === 'TNK' ? 18 : 8 },
      baseAmount: intent.amount, sendBy: intent.sendBy, seller: { tracAddr: from }, buyer: { tracAddr: to } };
    const sent = await adapter.sendTransfer({ tradeId: intent.id, terms, resume: !!old });
    if (!sent.ok) return { ok: false, asset, ...sent };
    const final = await adapter.withdrawalStatus({ id: intent.id, asset, to, amount: intent.amount });
    if (!final.ok) return { ok: false, pending: true, asset, ...final };
    intent.done = true; intent.txHash = final.txHash; journal.put(key, state);
  }
  return { ok: true, from, to, steps: state.steps };
}
