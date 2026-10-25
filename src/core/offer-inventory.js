// A refunded buyer releases its offer amount. A seller whose buyer refunded only does so when no transfer
// was recorded or remains uncertain; older stored trades may omit the transfer flags.
export function releasesOfferAmount({ role, state: s }) {
  return ['aborted', 'refunded'].includes(s.phase) ||
    (role === 'seller' && s.phase === 'lost' && !s.txHash && !s.transferUnknown && !s.transferFinal);
}
