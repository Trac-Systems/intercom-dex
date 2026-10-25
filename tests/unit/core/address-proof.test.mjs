import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { addressProofHash, addressProofRequired, createAddressProof, validAddressProof, validTermsAddressProofs } from '../../../src/core/address-proof.js';
import { tracPublicKey } from '../../../src/core/addresses.js';
import { parseBody, termsSchema } from '../../../src/core/schemas.js';
import { createSigner } from '../../../src/core/trade-signer.js';
import { seal, open, createReplayCache } from '../../../src/core/envelope.js';
import { buildDraft, offerIdOf, validOffer } from '../../../src/roles/common.js';
import { fixture, hex, SOL } from './helpers.mjs';
import { proveParty, proofWallet, networkId } from './address-proof-fixture.mjs';
import { simulation } from './simulation.mjs';

const policy = { networkId, now: 100 };
test('Trac proof uses the address key, distinct from the DEX identity, and a domain-separated 32-byte hash', () => {
  const f = fixture(), wallet = proofWallet(), party = proveParty(f.terms.seller, { wallet });
  assert.notEqual(wallet.publicKey, party.dexKey);
  assert.equal(Buffer.from(tracPublicKey(party.tracAddr)).toString('hex'), wallet.publicKey);
  assert.equal(validAddressProof(party, policy), true);
  const hash = addressProofHash({ ...party, networkId, expiresAt: party.tracProof.expiresAt });
  assert.equal(hash.length, 32);
  assert.equal(ed25519.verify(Buffer.from(party.tracProof.signature, 'hex'), hash, Buffer.from(party.dexKey, 'hex')), false);
  assert.throws(() => createAddressProof({ ...wallet, sign: () => '00'.repeat(64) }, { networkId, dexKey: party.dexKey, expiresAt: 1000 }));
});

test('network, identity, address, expiry, signature, encoding and domain substitutions fail closed', () => {
  const party = proveParty(fixture().terms.seller), proof = party.tracProof;
  for (const p of [{ ...party, dexKey: hex() }, { ...party, tracAddr: proofWallet().address },
    { ...party, tracAddr: party.tracAddr.toUpperCase() }, { ...party, tracProof: { ...proof, expiresAt: proof.expiresAt + 1 } },
    { ...party, tracProof: { ...proof, signature: '00'.repeat(64) } },
    { ...party, tracProof: { ...proof, signature: proof.signature + '\n' } },
    { ...party, tracProof: { ...proof, extra: true } }, { ...party, tracProof: null }, { ...party, tracProof: {} }]) {
    assert.equal(validAddressProof(p, policy), false);
    assert.equal(validAddressProof(p, { ...policy, required: false }), false, 'present invalid proof never downgrades');
  }
  for (const p of [{ networkId: 8 }, { networkId: undefined }, { networkId: -1 }, { now: proof.expiresAt },
    { now: NaN }, { validUntil: proof.expiresAt + 1 }]) assert.equal(validAddressProof(party, { ...policy, ...p }), false);
  assert.equal(validAddressProof(party, { ...policy, now: proof.expiresAt - 1, validUntil: proof.expiresAt }), true);
  const fakeWallet = { address: party.tracAddr, sign: () => seal({ kind: 'cancel', ch: 'intercom-dex:offers', body: { offerId: hex() } },
    fixture().seller.secretKey, { ts: 100, nonce: hex() }).sig };
  assert.throws(() => createAddressProof(fakeWallet, { networkId, dexKey: party.dexKey, expiresAt: 2000 }));
});

test('only the trusted registry minimum activates proofs; absent legacy proof is allowed solely before activation', () => {
  for (const version of ['0.1.0', '0.1.32', '0.1.33', '0.1.34-rc.1']) assert.equal(addressProofRequired({ minSoftware: version }), false);
  for (const version of ['0.1.34', '0.1.34+build', '0.2.0']) assert.equal(addressProofRequired({ minSoftware: version }), true);
  const party = fixture().terms.seller;
  assert.equal(validAddressProof(party, { ...policy, required: false }), true);
  assert.equal(validAddressProof(party, policy), false);
});

test('proofs survive strict offer/take/terms envelopes and enter offer and trade commitments', () => {
  const f = fixture(), maker = proveParty({ ...f.terms.seller, solAddr: SOL });
  delete maker.solRecipient;
  const taker = proveParty({ dexKey: f.terms.buyer.dexKey, tracAddr: f.terms.buyer.tracAddr, solAddr: SOL });
  const offer = { pair: 'TNK/USDC', side: 'sell', baseAmount: '1000000000000000000', price: '1', maker,
    expiresAt: 2000, peerKey: hex(), registryVersion: 1, software: '0.1.34' };
  offer.offerId = offerIdOf(offer);
  const envelope = seal({ kind: 'offer', ch: 'intercom-dex:offers', body: offer }, f.seller.secretKey, { ts: 100, nonce: hex() });
  assert.equal(validOffer(open(envelope, { now: 100, seen: createReplayCache() }).body, maker.dexKey, policy), true);
  const draft = buildDraft({ offer, maker, taker, baseAmount: offer.baseAmount, registry: f.registry,
    sendBy: 1000, refundAfter: 86500, mint: f.terms.mint, platformCollector: SOL });
  assert.deepEqual(termsSchema.parse(draft).seller.tracProof, maker.tracProof);
  assert.equal(validTermsAddressProofs(draft, policy), true);
  assert.notEqual(offerIdOf({ ...offer, maker: { ...maker, tracProof: { ...maker.tracProof, expiresAt: 3000 } } }), offer.offerId);
  assert.throws(() => parseBody('offer', { ...offer, maker: { ...maker, tracProof: { ...maker.tracProof, signature: 'bad' } } }));
});

test('both sides complete with independent wallet proofs for sell-maker and buy-maker trades', () => {
  for (const buyerMaker of [false, true]) {
    const f = fixture();
    f.registry.minSoftware = '0.1.34'; f.registry.signers.forEach(s => { s.software = '0.1.34'; });
    for (const role of ['buyer', 'seller']) f.terms[role] = proveParty(f.terms[role]);
    const run = simulation({ fixture: f, networkId, buyerMaker });
    assert.equal(run.state('buyer').phase, 'complete');
    assert.equal(run.state('seller').phase, 'complete');
    assert.ok(run.count('lockEscrow') > 0);
    for (const role of ['buyer', 'seller']) {
      const bad = structuredClone(f.terms); delete bad[role].tracProof;
      assert.throws(() => createSigner({ terms: bad, now: 100, signerIndex: 1, boxSecret: f.signers[0].box.secretKey,
        networkId, requireAddressProof: true }), /Trac address proof/);
    }
  }
});
