import { allocatePieces, penaltyTarget } from './amounts.js';
import { settingsSchema } from './settings.js';

export const PAUSE_CODES = Object.freeze(['stake_short', 'stake_stale', 'coin_short', 'tnk_short', 'offline', 'price_unavailable']);
const pause = (code, message) => ({ code, message });
const amount = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,30})$(?![\s\S])/.test(x);

// Call for the full remaining offer at listing and each fresh book projection. Inputs are verified snapshots.
export function listingPause({ online, balances, base, baseAmount, quoteAmount, fees, settings, price, pieces = [], now }) {
  if (online !== true) return pause('offline', 'Your app is offline. Keep it running to list this offer.');
  if (!amount(baseAmount) || BigInt(baseAmount) === 0n || !base?.id || !amount(balances?.[base.id]))
    return pause('coin_short', 'The sold coin balance is unavailable. The offer is paused until it can be checked.');
  if (BigInt(balances[base.id]) < BigInt(baseAmount)) return pause('coin_short', 'The wallet does not hold the full amount of coin offered.');
  if (!amount(balances.TNK) || !amount(balances.feeTnk) || BigInt(balances.TNK) < BigInt(balances.feeTnk) + (base.id === 'TNK' ? BigInt(baseAmount) : 0n))
    return pause('tnk_short', 'Add TNK for the transfer fee before this offer can go live.');
  if (!price || !settings) return pause('price_unavailable', 'A certified RESET price and effective stake policy are needed to check coverage.');
  let target;
  try { settingsSchema.parse(settings); target = penaltyTarget({ base, baseAmount, quoteAmount, fees }, price, settings).targetReset; }
  catch { return pause('price_unavailable', 'A usable certified RESET price is unavailable.'); }
  try {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Unknown clock');
    const free = pieces.filter(p => p.state === 'free' && !p.withdrawal && p.descriptor.purpose === 'seller' && p.descriptor.expiresAt > now)
      .map(p => ({ unitId: p.unitId, principalReset: p.descriptor.principalReset, expiresAt: p.descriptor.expiresAt }));
    if (allocatePieces(free, target)) return null;
  } catch {}
  return pause('stake_short', 'Not enough free seller stake covers this offer. Add RESET stake or wait for reserved stake to become free.');
}

// Stop legacy admission early enough that an unbonded send window cannot cross activation.
export function stakeAdmissionRequired(registry, now) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid admission clock');
  return !!registry?.sellerBond && (!registry.sellerBond.acceptNew ||
    now + registry.params.sendWindowSec + 120 >= registry.sellerBond.enforceAfter ||
    registry.sellerBond.epoch?.stopNewAt !== undefined && now + registry.params.sendWindowSec + 120 >= registry.sellerBond.epoch.stopNewAt);
}

// Buyer capability is independent of registry.minSoftware, which also gates signers.
export function buyerCapabilityReason(registry, buyer, now) {
  return stakeAdmissionRequired(registry, now) && (buyer?.stakeVersion !== 1 || !/^[0-9a-f]{64}$/.test(buyer?.boxKey ?? '')) ? 'update the app' : null;
}
