import { SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { readAccount } from '../solana/rpc.js';

// Finalized chain time, using the lower agreeing observation. Missing readers
// or a disagreement never advance custody or proof deadlines.
// Readers within this many seconds of each other agree. Two members reading the clock moments apart can also be this far
// apart, so a member checking another member's reading allows the same window before calling it from the future.
export const CLOCK_SKEW_SEC = 5;

export async function finalizedStakeClock({ endpoints, need = 2, timeoutMs = 3000, read = readAccount }) {
  if (!Array.isArray(endpoints) || !Number.isSafeInteger(need) || need < 2 || endpoints.length < need || new Set(endpoints).size !== endpoints.length) throw new Error('Two distinct finalized readers required');
  const results = await Promise.allSettled(endpoints.map(endpoint => read(endpoint, SYSVAR_CLOCK_PUBKEY, { timeoutMs, commitment: 'finalized' })));
  // A malformed answer counts like a missing one.
  const clocks = results.filter(r => r.status === 'fulfilled').flatMap(r => {
    const c = r.value;
    if (!c?.value || c.value.owner !== 'Sysvar1111111111111111111111111111111111111' || c.value.data?.length !== 40 ||
        !Number.isSafeInteger(c.slot) || c.slot < 0) return [];
    const at = Number(c.value.data.readBigInt64LE(32));
    return Number.isSafeInteger(at) && at >= 0 ? [{ at, slot: c.slot }] : [];
  });
  // The oldest group of readers within five seconds of each other wins, so time never runs ahead of the agreeing
  // readers; one lone reader that lags or runs ahead is left out instead of blocking all others.
  const sorted = clocks.sort((a, b) => a.at - b.at);
  for (const low of sorted) {
    const group = sorted.filter(c => c.at >= low.at && c.at - low.at <= CLOCK_SKEW_SEC);
    if (group.length >= need) return { at: low.at, slot: Math.min(...group.map(c => c.slot)) };
  }
  throw new Error('Finalized clocks unavailable or disagree');
}
