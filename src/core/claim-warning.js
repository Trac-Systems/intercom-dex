export function recordClaimFailure(state, reason) {
  const text = String(reason || 'No reason returned by Solana').replace(/[\r\n]/g, ' ');
  state.claimFailure = { reason: text, at: state.now };
  state.claimFailureReasons ??= [];
  if (!state.claimFailureReasons.includes(text)) state.claimFailureReasons.push(text);
}

export function claimWarning(state) {
  if (!state.claimFailure || state.phase === 'complete') return null;
  const reason = state.claimFailure.reason, address = (state.terms ?? state.draft).seller.solRecipient;
  if (state.phase === 'lost') return `USDC claim failed: ${reason}. The buyer has refunded the USDC; this claim cannot be retried.`;
  return `USDC claim failed: ${reason}. Check that ${address} has SOL for the claim fee and USDC account rent; ` +
    'if it does, check the Solana connection and reported error. Keep the app online: the claim retries automatically. Resolve this before the buyer can refund.';
}
