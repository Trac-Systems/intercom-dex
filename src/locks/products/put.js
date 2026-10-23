import { solanaDecision } from './loan.js';

export function decide(position, facts) {
  // ok for exercise is a finalized memo signed by the holder, with no asset transfer.
  const decision = solanaDecision(position, facts, 'exercise', '0', 'taker', 'maker', 'exercised', 'expired');
  if (!decision.winner) return decision;
  const holderWinner = decision.outcome === 'exercised' ? facts.escrowStatus === 'claimed' ? 'maker' : facts.escrowStatus === 'refunded' ? 'taker' : null : 'taker';
  return { ...decision, winners: { E: decision.winner, H: holderWinner } };
}

export default Object.freeze({ decide });
