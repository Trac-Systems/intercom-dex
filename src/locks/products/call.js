import { solanaDecision, termsOf } from './loan.js';

export function decide(position, facts) {
  return solanaDecision(position, facts, 'exercise', termsOf(position).strikeTotal, 'taker', 'maker', 'exercised', 'expired');
}

export default Object.freeze({ decide });
