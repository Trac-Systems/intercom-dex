const pending = () => ({ winner: null, outcome: null });
const end = (winner, outcome) => ({ winner, outcome });
export const termsOf = p => (p.post ?? p).terms;
export const assetOf = p => termsOf(p).asset ?? 'RESET';
export const deadlineOf = p => (p.post ?? p).product === 'loan' ? p.dueBlock ?? (Number.isSafeInteger(p.takeAnchor) ? p.takeAnchor + termsOf(p).termBlocks : null) : termsOf(p).expiryBlock;

// ok is supplied only by the chain verifier after checking identity, memo, mint and finality.
export function fullPayment(payment, amount) {
  if (payment?.ok !== true) return false;
  if (payment.amount === undefined) return true;
  return typeof payment.amount === 'string' && /^(0|[1-9][0-9]*)$/.test(payment.amount) && BigInt(payment.amount) >= BigInt(amount);
}

export function deadlineTime(facts, height) {
  const time = typeof facts.T === 'function' ? facts.T(height) : typeof facts.T === 'object' && facts.T !== null ? facts.T[height] : facts.T;
  return Number.isSafeInteger(time) && time >= 0 ? time : null;
}

export function beforeOpening(position, facts) {
  if (position.opened === true || position.state === 'running' || position.dueBlock != null) return null;
  // A proposed taker is not an opening payment. An accepted live reservation prevents cancellation.
  if (facts.reservation && facts.reservation.live !== false) return pending();
  if (facts.cancelAccepted === true) return end('maker', 'cancelled');
  if (Number.isSafeInteger(facts.counted) && facts.counted >= termsOf(position).offerUntilBlock) {
    return end('maker', facts.funded === false ? 'unfunded' : 'expired');
  }
  return pending();
}

export function solanaDecision(position, facts, step, amount, paidWinner, unpaidWinner, paidOutcome, unpaidOutcome) {
  const unopened = beforeOpening(position, facts);
  if (unopened) return unopened;
  const height = deadlineOf(position), time = deadlineTime(facts, height);
  if (!Number.isSafeInteger(height) || !Number.isSafeInteger(facts.counted)) return pending();
  const median = typeof facts.M === 'function' ? facts.M(facts.counted) : facts.M;
  const inTime = payment => facts.counted >= height ? time !== null && payment.blockTime < time
    : Number.isSafeInteger(median) && median >= 0 && payment.blockTime <= median;
  if ((facts.payments ?? []).some(p => p.step === step && fullPayment(p, amount) && Number.isSafeInteger(p.blockTime) && p.blockTime >= 0 && inTime(p))) {
    return end(paidWinner, paidOutcome);
  }
  // The verifier must finish its history scan before presenting deadline facts.
  if (facts.counted >= height && time !== null && facts.scanned !== false) return end(unpaidWinner, unpaidOutcome);
  return pending();
}

export function decide(position, facts) {
  return solanaDecision(position, facts, 'repay', termsOf(position).repay, 'maker', 'taker', 'repaid', 'defaulted');
}

export default Object.freeze({ decide });
