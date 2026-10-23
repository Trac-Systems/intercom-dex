import { transferNonce } from '../core/terms.js';

const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// A trade's broadcast receipt is not payment evidence. The existing send path resumes only journaled bytes and
// refuses broadcasts at sendBy; keep checking finality after that deadline without preparing a replacement.
export async function sendFinalTransfer(adapter, { terms, tradeId, resume = false }) {
  const sent = await adapter.sendTransfer({ terms, tradeId, resume });
  if (!isHash(sent?.txHash)) return sent;
  let proof;
  try {
    proof = await adapter.verifyTransfer({ asset: terms.base.id, txHash: sent.txHash, from: terms.seller.tracAddr,
      to: terms.buyer.tracAddr, minAmount: terms.baseAmount, nonce: transferNonce(tradeId), tradeId,
      finalBefore: Number.MAX_SAFE_INTEGER });
  } catch {}
  const final = proof?.ok === true && proof.final === true && proof.amount === terms.baseAmount;
  return { ...sent, ok: final, final, unknown: !final, finalizedAt: final ? proof.finalizedAt : undefined,
    reason: final ? undefined : proof?.reason ?? sent.reason ?? 'not_final' };
}
