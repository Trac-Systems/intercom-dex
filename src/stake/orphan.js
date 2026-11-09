import { stableJSON, sha256Hex } from '../core/canonical.js';
import { open, createReplayCache } from '../core/envelope.js';
import { validateTerms } from '../core/terms.js';
import { bondReservation } from './admission.js';
import { StakeLedger, reservationId } from './ledger.js';
import { verifyCertificate, verifyFact, signFact } from './certificates.js';
import { stakeContext } from './price-service.js';

export function retainedOrphanPolicy(terms, ...policies) {
  return policies.find(p => p && sha256Hex(stableJSON(p)) === terms?.bond?.policyDigest);
}

// Historical signatures are checked at the signed deadline, not at today's
// envelope freshness window. The policy must already be pinned locally.
export function verifyOrphanReservation(input, policy, id) {
  const a = input?.admission, terms = validateTerms(a?.terms), bond = terms.bond;
  if (!policy || !bond || sha256Hex(stableJSON(policy)) !== bond.policyDigest ||
      stableJSON(a.policy) !== stableJSON(policy) || policy.epoch.id !== bond.epochId ||
      terms.k !== 3 || stableJSON([...terms.committee].sort((a, b) => a.dexKey.localeCompare(b.dexKey))) !==
      stableJSON([...policy.epoch.members].sort((a, b) => a.dexKey.localeCompare(b.dexKey))) ||
      a.fromSlot !== bond.historyFromSlot || a.fromSlot < 1) throw new Error('Pinned orphan admission required');
  const body = bondReservation(terms, input.body?.H);
  if (input.reservationId !== id || reservationId(body) !== id || stableJSON(input.body) !== stableJSON(body))
    throw new Error('Orphan reservation binding differs');
  if (!Array.isArray(a.sigs) || a.sigs.length < 2 || a.sigs.length > 8) throw new Error('Both signed trade terms required');
  const signed = new Set(), seen = createReplayCache();
  for (const raw of a.sigs) {
    const sig = open(raw, { now: terms.sendBy, seen, maxAgeSec: Math.max(120, terms.sendBy), maxFutureSec: 0 });
    if (sig.kind !== 'termsSig' || sig.body.tradeId !== body.tradeId || sig.ch !== `intercom-dex:t:${body.tradeId}`)
      throw new Error('Invalid historical terms signature');
    signed.add(sig.from);
  }
  if (!signed.has(terms.buyer.dexKey) || !signed.has(terms.seller.dexKey)) throw new Error('Both signed trade terms required');
  const context = stakeContext({ sellerBond: policy });
  const inventory = verifyCertificate(bond.inventoryCertificate, context, 'admission-inventory').body;
  if (inventory.address !== terms.seller.tracAddr || inventory.dexKey !== terms.seller.dexKey ||
      body.pieces.some(ref => !inventory.pieces?.some(p => p.unitId === ref.unitId && p.generation === ref.generation &&
        p.state === 'free' && !p.blocked && p.purpose === 'seller'))) throw new Error('Certified orphan inventory differs');
  return { body, admission: a, context, terms };
}

export function orphanReadyBody(reservation) {
  return { reservationId: reservation.reservationId, tradeId: reservation.body.tradeId, pieces: reservation.body.pieces };
}

export function verifyOrphanReady(ready, reservation, context) {
  const fact = verifyFact(ready, context, 'orphan-ready', reservation.admission.terms.seller.dexKey);
  if (stableJSON(fact.body) !== stableJSON(orphanReadyBody(reservation))) throw new Error('Seller orphan preparation differs');
}

export function prepareOrphanClient({ reservation, policy, identity, store, from, now }) {
  const { body, admission, context, terms } = verifyOrphanReservation(reservation, policy, reservation.reservationId);
  if (from !== context.venueKey || identity.publicKey !== terms.seller.dexKey || now <= terms.sendBy + terms.graceSec)
    throw new Error('Expired original seller reservation required');
  const ledger = new StakeLedger({ store, context, address: terms.seller.tracAddr });
  ledger.reserve(body, admission);
  store.put(`stake-orphan-client-${reservation.reservationId}`, { context, address: terms.seller.tracAddr, id: reservation.reservationId });
  return signFact({ v: 1, networkId: context.networkId, venueKey: context.venueKey, epochId: context.epoch.id,
    kind: 'orphan-ready', body: orphanReadyBody(reservation) }, identity.secretKey);
}

// The original spot trade may have left the host's active set. Its prepared
// custody barrier must still learn the certificate after app/venue restarts.
export async function recoverOrphanClients({ store, request }) {
  const names = store.list('stake-orphan-client-').filter(name => !store.get(name).done).sort();
  const after = store.get('stake-orphan-cursor')?.after ?? '', start = names.findIndex(name => name > after);
  const page = (start < 0 ? names : [...names.slice(start), ...names.slice(0, start)]).slice(0, 8);
  if (!page.length) return;
  store.put('stake-orphan-cursor', { after: page.at(-1) });
  await Promise.allSettled(page.map(async name => {
    const op = store.get(name), result = await request(op.context.venueKey, 'penaltyResult', { reservationId: op.id });
    if (!result?.resolved) return;
    const fact = verifyCertificate(result.resolved, op.context, 'resolved');
    if (fact.body.reservationId !== op.id) throw new Error('Orphan result differs');
    new StakeLedger({ store, context: op.context, address: op.address }).resolve(result.resolved);
    store.put(name, { ...op, done: true });
  }));
}
