import { StakeLedger } from './ledger.js';

// The venue archives custody certificates, but does not witness every ordinary
// reservation/closure. A later original-quorum freeze or expiry can advance its
// current projection. Signer/client ledgers keep their strict generation checks;
// this projection does not reconstruct historical reward inventory.
export function archiveCustodyTransition(ledger, kind, certificate, settings) {
  if (!['freeze', 'decision', 'collected'].includes(kind)) throw new Error('Invalid custody archive transition');
  const fact = ledger.fact(certificate, kind);
  let record = ledger.read();
  for (const ref of kind === 'collected' ? [fact.body] : fact.body.pieces) {
    const piece = record.pieces[ref.unitId];
    if (!piece || piece.descriptor.epochId !== fact.epochId) throw new Error('Original archived custody piece required');
    if (ref.generation > piece.generation) {
      if (piece.state !== 'free' || piece.withdrawal || piece.decisionVote || piece.decisionId ||
          !(kind === 'freeze' || kind === 'decision' && fact.body.outcome === 'seller-expiry'))
        throw new Error('Conflicting custody archive generation');
      piece.generation = ref.generation;
    }
  }
  // Validate the entire certificate/state transition before one atomic write.
  const staged = new StakeLedger({ context: ledger.context, address: ledger.address,
    store: { get: () => structuredClone(record), put: (_name, value) => { record = value; } } });
  const result = kind === 'freeze' ? staged.freeze(certificate, settings)
    : kind === 'decision' ? staged.decide(certificate) : staged.collected(certificate);
  ledger.store.put(ledger.name, record);
  return result;
}
