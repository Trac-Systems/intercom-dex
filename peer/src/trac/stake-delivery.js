import b4a from 'b4a';
import { createTransferVerifier } from './verify-transfer.js';
import { signedPosition, readAtPosition } from './stake-position.js';

const pending = new WeakSet();

export function createStakeDeliveryVerifier({ msb, resetPeer, resetBootstrap }) {
  return async ({ position, ...expected }) => {
    if (pending.has(msb)) return { state: 'unknown', reason: 'delivery_reader_busy' };
    pending.add(msb);
    let timer;
    const work = (async () => {
    try {
      const current = await signedPosition(msb);
      const raw = await readAtPosition(msb, expected.txHash, current);
      if (raw === null) return { state: 'unknown', reason: 'unknown_or_not_final' };
      const pinned = { config: msb.config, state: { getSigned: async key => key === expected.txHash ? raw : null } };
      const historical = await readAtPosition(msb, expected.txHash, position);
      if (historical !== null && !b4a.equals(raw, historical)) return { state: 'unknown', reason: 'conflicting_msb_record' };
      const proof = await createTransferVerifier({ msb: pinned, resetPeer, resetBootstrap, exactAmount: true })(expected);
      // The signed content hash already binds every exact RESET field here. A
      // command first included after L cannot become timely by staying pending.
      if (!proof.final && proof.reason === 'reset_not_final' && historical === null)
        return { state: 'late', reason: 'late_operation_pending', txHash: expected.txHash, position, current };
      if (!proof.ok || !proof.final || proof.amount !== expected.minAmount)
        return { state: proof.final ? 'invalid' : 'unknown', reason: proof.reason ?? 'wrong_amount' };
      return { state: historical === null ? 'late' : 'in-time', txHash: expected.txHash, amount: proof.amount, position, current };
    } catch { return { state: 'unknown', reason: 'position_unavailable' }; }
    })().finally(() => pending.delete(msb));
    try { return await Promise.race([work, new Promise(resolve => {
      timer = setTimeout(() => resolve({ state: 'unknown', reason: 'delivery_read_timeout' }), 5000);
    })]); } finally { clearTimeout(timer); }
  };
}
