import { concatBytes, hexToBytes, sha256Hex, stableJSON, utf8 } from './canonical.js';
import { termsSchema } from './schemas.js';

// `terms` is a signer's wait for both traders' signatures; `termsExchange` is a trader's wait for the other trader's
// terms and signature, which come only after that trader has read the deciding block from its own Solana nodes.
export const STEP_BUDGET_MS = Object.freeze({ accept: 40000, connect: 80000, randomness: 120000,
  terms: 30000, termsExchange: 60000, deal: 60000, certificate: 150000, working: 10000, acks: 60000 });

export function validateTerms(terms) {
  stableJSON(terms);
  return termsSchema.parse(terms);
}

export function buildTerms(input) { return validateTerms(input); }

export function tradeId(terms) { return sha256Hex(stableJSON(validateTerms(terms))); }

export function transferNonce(id) {
  return sha256Hex(concatBytes(utf8('intercom-dex/v1/transfer'), hexToBytes(id, 32)));
}

// Randomness timing (slots). The block deciding R is the first finalized block at or after acceptSlot + TARGET. A
// reveal is accepted only while the receiver's fresh view of the chain tip (highest processed slot any of its RPCs
// reports, read less than TIP_MAX_AGE_MS milliseconds ago on a monotonic clock, dated at request start) is below
// acceptSlot + REVEAL_CUTOFF. Assumption
// (stated in DESIGN §4): at least one of those RPCs trails the newest produced block by less than 25 slots and the
// chain advances at most ~2.5 slots per second; then the target block does not exist yet when the reveal is accepted.
export const RANDOMNESS = Object.freeze({ TARGET: 96, REVEAL_CUTOFF: 56, TIP_MAX_AGE_MS: 6000, FINALIZED_MAX_AGE_MS: 15000 });
// How far a maker's accept slot may trail the taker's finalized slot (about 15 s): makers sign their own tip, and
// public Solana nodes run seconds apart. The reveal cutoff still bounds how old an accept can be.
export const ACCEPT_SLOT_BEHIND = 36;

export function tradeRandomness({ makerNonce, takerNonce, blockhash, slot, acceptSlot, finalized }) {
  if (finalized !== true || !Number.isSafeInteger(slot) || !Number.isSafeInteger(acceptSlot) || acceptSlot < 0 ||
      acceptSlot > Number.MAX_SAFE_INTEGER - RANDOMNESS.TARGET || slot < acceptSlot + RANDOMNESS.TARGET) throw new RangeError('Expected finalized slot at least acceptSlot + ' + RANDOMNESS.TARGET);
  return sha256Hex(concatBytes(hexToBytes(makerNonce, 32), hexToBytes(takerNonce, 32), hexToBytes(blockhash, 32)));
}
