import { verifyCertificate, verifyFact, factDigest, matchingCertificate } from './certificates.js';
import { bondAck } from './admission.js';
import { stakeContext } from './price-service.js';
import { fromLe32, stableJSON } from '../core/canonical.js';
import { openShare } from '../locks/dkg.js';
import { reconstruct, publicOf, verifyShare } from '../locks/crypto/edvss.js';
import { sweep, address as lockAddress } from '../locks/trac-lock.js';

export class StakeAwardClient {
  constructor({ client }) { this.client = client; this.queue = Promise.resolve(); }
  collect(input) {
    const work = this.queue.then(() => this.apply(input)); this.queue = work.catch(() => {}); return work;
  }
  async apply({ terms, H, policy, result }) {
    const c = this.client, context = stakeContext({ sellerBond: policy }), id = bondAck(terms, H).reservationId;
    const decision = verifyCertificate(result.decision, context, 'decision'), body = decision.body;
    if (body.outcome !== 'buyer-no-show' || body.reservationId !== id || body.winnerAddress !== c.me.tracAddr ||
        body.winnerBoxKey !== c.box.publicKey || terms.buyer.dexKey !== c.identity.publicKey || stableJSON(body.pieces) !== stableJSON(terms.bond.pieces)) throw new Error('Award recipient or reservation differs');
    const name = `stake-award-${id}`, op = c.store.get(name) ?? { decision: result.decision, collections: {}, complete: false };
    if (factDigest(op.decision[0].fact) !== factDigest(decision)) throw new Error('Award decision changed');
    const save = () => c.store.put(name, op); save();
    if (op.complete) return op;
    const all = async (method, body) => {
      const results = await Promise.allSettled(context.epoch.members.map(m => c.request(m.dexKey, method, body)));
      return results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
    };
    for (const ref of body.pieces) {
      if (op.collections[ref.unitId]) continue;
      const funded = result.funded.map(cert => verifyCertificate(cert, context, 'funded').body).find(p => p.unitId === ref.unitId);
      if (!funded || funded.descriptor.owner.tracAddr !== terms.seller.tracAddr || funded.descriptor.owner.dexKey !== terms.seller.dexKey) throw new Error('Original funded stake required');
      const replies = await all('release', { unitId: ref.unitId, certificate: op.decision });
      const digest = factDigest(decision), groups = new Map();
      for (const vote of replies) try {
        const b = verifyFact(vote, context, 'release', vote.from).body, j = context.epoch.members.findIndex(m => m.dexKey === vote.from) + 1;
        if (!j || b.j !== j || b.positionId !== ref.unitId || b.decisionDigest !== digest || b.winnerAddress !== c.me.tracAddr || lockAddress(b.A) !== funded.address) continue;
        const share = fromLe32(openShare(b.sealed, c.box.secretKey, { positionId: ref.unitId, decisionDigest: digest, winnerAddress: c.me.tracAddr, j }, 'release'));
        if (!verifyShare(j, share, b.C)) continue;
        const key = stableJSON({ A: b.A, C: b.C }), group = groups.get(key) ?? { A: b.A, C: b.C, shares: [] };
        if (!group.shares.some(s => s.id === j)) group.shares.push({ id: j, share }); groups.set(key, group);
      } catch { /* One malformed response cannot veto the original quorum. */ }
      const group = [...groups.values()].find(g => g.shares.length >= 3);
      if (!group) throw new Error('Three sealed award shares required');
      const scalar = reconstruct(group.shares, 3, group.C);
      if (publicOf(scalar) !== group.A) throw new Error('Award reconstruction differs');
      const collected = await sweep({ a: scalar, to: c.me.tracAddr, adapter: c.collector(scalar), positionId: ref.unitId, journal: c.store });
      if (!collected.ok) return { pending: true };
      const certificate = matchingCertificate(await all('collectedVote', { unitId: ref.unitId, txHash: collected.steps.RESET.txHash, amount: collected.steps.RESET.amount }), context, 'collected');
      await all('collectedCommit', { certificate }); await c.retireCapacity(certificate, context);
      op.collections[ref.unitId] = certificate; save();
    }
    for (const certificate of Object.values(op.collections)) await c.request(context.venueKey, 'penaltyCollection', { reservationId: id, certificate });
    op.complete = true; save(); return op;
  }
}
