import { SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { readAccount } from '../solana/rpc.js';

// Finalized chain time, using the lower agreeing observation. Missing readers
// or a disagreement never advance custody or proof deadlines.
export async function finalizedStakeClock({ endpoints, need = 2, timeoutMs = 3000, read = readAccount }) {
  if (!Array.isArray(endpoints) || !Number.isSafeInteger(need) || need < 2 || endpoints.length < need || new Set(endpoints).size !== endpoints.length) throw new Error('Two distinct finalized readers required');
  const results = await Promise.allSettled(endpoints.map(endpoint => read(endpoint, SYSVAR_CLOCK_PUBKEY, { timeoutMs, commitment: 'finalized' })));
  const clocks = results.filter(r => r.status === 'fulfilled').map(r => {
    const c = r.value;
    if (!c.value || c.value.owner !== 'Sysvar1111111111111111111111111111111111111' || c.value.data.length !== 40 ||
        !Number.isSafeInteger(c.slot) || c.slot < 0) throw new Error('Invalid finalized clock');
    const at = Number(c.value.data.readBigInt64LE(32));
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('Invalid finalized time');
    return { at, slot: c.slot };
  });
  if (clocks.length < need || Math.max(...clocks.map(c => c.at)) - Math.min(...clocks.map(c => c.at)) > 5)
    throw new Error('Finalized clocks unavailable or disagree');
  return { at: Math.min(...clocks.map(c => c.at)), slot: Math.min(...clocks.map(c => c.slot)) };
}
