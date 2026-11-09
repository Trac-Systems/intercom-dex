import { registryPolicy, secrets, memoryStore } from './helpers.mjs';
import { fixture as tradeFixture, tracAddress } from '../core/helpers.mjs';
import { signFact } from '../../../src/stake/certificates.js';
import { StakeLedger, unitId } from '../../../src/stake/ledger.js';
import { admissionInventory, prepareBond, validateBond, bondReservation, bondAck, matchingBondAck } from '../../../src/stake/admission.js';
import { StakeAdmission } from '../../../src/stake/admission-runtime.js';
import { ackRejectionReason } from '../../../src/core/trade-buyer.js';
import { stableJSON } from '../../../src/core/canonical.js';

const hex = n => n.toString(16).padStart(64, '0');
export function admissionFixture() {
  const policy = registryPolicy(), context = { networkId: policy.networkId, venueKey: policy.venueKey, epoch: policy.epoch };
  const store = memoryStore(), parties = tradeFixture({ n: 4, pair: 'RESET/USDC' }), terms = parties.terms;
  terms.seller.boxKey = hex(91); terms.buyer.boxKey = hex(92); terms.committee = policy.epoch.members;
  terms.sendBy = 5000; terms.refundAfter = 10000;
  const q = { numerator: '2000000000', denominator: '1' }, priceReference = { cutoffAt: 4000, q }, priceCheckpoint = { head: hex(23) };
  const priceLog = { verifyReference(reference, checkpoint, now, maxAgeSec = 60) {
    if (stableJSON(reference) !== stableJSON(priceReference) || stableJSON(checkpoint) !== stableJSON(priceCheckpoint) || now - reference.cutoffAt > maxAgeSec) throw new Error('bond_price_unavailable');
    return q;
  } };
  const cert = (kind, body) => secrets.slice(0, 3).map(secret => signFact({ v: 1, networkId: context.networkId, venueKey: context.venueKey, epochId: context.epoch.id, kind, body }, secret));
  const ledger = new StakeLedger({ store, context, address: terms.seller.tracAddr });
  const d = { networkId: context.networkId, venueKey: context.venueKey, epochId: context.epoch.id, batchId: hex(1), nonce: hex(2),
    owner: { dexKey: terms.seller.dexKey, tracAddr: terms.seller.tracAddr, boxKey: terms.seller.boxKey }, purpose: 'seller', principalReset: '25000', tnkReserve: '90000000000000000', createdAt: 0, expiresAt: 200000 };
  const id = unitId(d);
  ledger.admitFunded(cert('funded', { descriptor: d, unitId: id, address: tracAddress(hex(70)), fundingDigest: hex(80) }), { settings: policy.economics.active.settings, price: q, now: 4000 });
  const inventory = admissionInventory(ledger.read(), terms.seller, 4000, context.epoch.id);
  const args = { terms, policy, context, inventoryCertificate: cert('admission-inventory', inventory), priceCheckpoint, priceReference, priceLog, now: 4000, historyFromSlot: 1 };
  return { ...args, args, store, ledger, cert, inventory, id, parties };
}

