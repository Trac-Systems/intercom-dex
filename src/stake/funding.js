import { tracPublicKey } from '../core/addresses.js';
import { unitId } from './ledger.js';
import { fundingNonce } from '../locks/trac-lock.js';

// The spot adapter deliberately accepts only transferNonce(tradeId). Stake
// funding has its own lock-domain nonce; verify it directly on the same pinned,
// signed-only peer reader without broadening spot transfer authorization.
export async function verifyStakeFunding({ bridge, descriptor, unitId: id, address, funding }) {
  if (unitId(descriptor) !== id) throw new Error('Funding descriptor differs');
  const from = descriptor.owner.tracAddr;
  const fromKey = Buffer.from(tracPublicKey(from)).toString('hex'), toKey = Buffer.from(tracPublicKey(address)).toString('hex');
  for (const asset of ['TNK', 'RESET']) {
    const txHash = funding?.[asset];
    if (typeof txHash !== 'string' || !/^[0-9a-f]{64}$/.test(txHash)) throw new Error('Invalid funding transaction');
    const amount = asset === 'RESET' ? descriptor.principalReset : descriptor.tnkReserve;
    const proof = await bridge.call('dex_verify', { asset, txHash, from: asset === 'RESET' ? fromKey : from,
      to: asset === 'RESET' ? toKey : address, minAmount: amount, nonce: fundingNonce(id, asset) });
    if (proof?.ok !== true || proof.final !== true || proof.amount !== amount)
      throw new Error(`Stake ${asset} funding is not exactly finalized (${proof?.reason ?? 'unconfirmed'})`);
  }
  return true;
}
