import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { openStore } from '../../../src/roles/store.js';
import { CapacityLedger } from '../../../src/stake/capacity.js';
import { StakeDkg } from '../../../src/stake/dkg.js';
import { StakeLedger, unitId } from '../../../src/stake/ledger.js';
import { RewardLedger } from '../../../src/stake/rewards.js';
import { signFact, factDigest } from '../../../src/stake/certificates.js';
import { defaultSettings } from '../../../src/stake/settings.js';
import { openShare } from '../../../src/locks/dkg.js';
import { reconstruct, publicOf } from '../../../src/locks/crypto/edvss.js';
import { fromLe32 } from '../../../src/core/canonical.js';
import { registryPolicy, secrets, members } from './helpers.mjs';
import { tracAddress } from '../core/helpers.mjs';

const h = n => n.toString(16).padStart(64, '0');
const boxPublic = key => Buffer.from(x25519.getPublicKey(key)).toString('hex');

// Chain finality/terminal facts are synthetic inputs here. Actual encrypted journals, DKG, certificates,
// reservations, reward accounting and threshold reconstruction run together; this is not a chain-stack test.
test('encrypted stake lifecycle reuses delivered pieces, awards only to the buyer, forfeits rewards and returns buyer stake', t => {
  const root = process.env.TMPDIR ?? path.resolve('.test-tmp/sb4a'); fs.mkdirSync(root, { recursive: true });
  const folder = fs.mkdtempSync(path.join(root, 'stake-lifecycle-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const keys = Array.from({ length: 5 }, () => randomBytes(32)), boxes = members.map(() => randomBytes(32));
  const sellerBox = randomBytes(32), buyerBox = randomBytes(32), seller = tracAddress(h(91)), buyer = tracAddress(h(92));
  const context = { networkId: 1, venueKey: h(90), epoch: { ...registryPolicy().epoch,
    members: members.map((m, i) => ({ ...m, boxKey: boxPublic(boxes[i]) })) } };
  const settings = defaultSettings(), price = { numerator: '20000000', denominator: '1' };
  let now = 100;
  const store = i => openStore(path.join(folder, `member-${i}`), keys[i]);
  const identity = i => ({ publicKey: members[i].dexKey, secretKey: secrets[i] });
  const certify = (kind, body) => secrets.slice(0, 3).map(secret => signFact({ v: 1, networkId: context.networkId,
    venueKey: context.venueKey, epochId: context.epoch.id, kind, body }, secret));
  const capacity = i => new CapacityLedger({ store: store(i), context, identity: identity(i) });
  const dkg = i => new StakeDkg({ store: store(i), context, identity: identity(i), box: { secretKey: boxes[i] }, now: () => now });
  const ledger = (i, address) => new StakeLedger({ store: store(i), context, address });
  function createPiece(purpose, address, boxKey, n) {
    const descriptor = { networkId: 1, venueKey: context.venueKey, epochId: context.epoch.id, batchId: h(n), nonce: h(n + 1),
      owner: { dexKey: h(n + 2), tracAddr: address, boxKey }, purpose, principalReset: '2500000',
      tnkReserve: '90000000000000000', createdAt: now, expiresAt: now + 2592000 };
    const id = unitId(descriptor), options = { settings, price, now };
    const grant = capacity(0).propose([descriptor], options);
    const certificate = members.map((_, i) => capacity(i).vote(grant, [descriptor], options)).slice(0, 3);
    const deals = members.map((_, i) => dkg(i).start(descriptor, certificate)[0]), ready = [];
    for (let i = 0; i < 4; i++) for (const deal of deals) ready.push(...dkg(i).receive(deal).filter(v => v.fact.kind === 'dkg-ready'));
    const lock = dkg(0).readiness(id, ready);
    const funded = certify('funded', { descriptor, unitId: id, address: lock.address, fundingDigest: h(n + 3) });
    for (let i = 0; i < 4; i++) ledger(i, address).admitFunded(funded, options);
    return { id, descriptor, lock, certificate };
  }
  const sell = createPiece('seller', seller, boxPublic(sellerBox), 10);
  const buy = createPiece('buyer', buyer, boxPublic(buyerBox), 20);
  const reservation = { tradeId: h(30), H: h(31), sellerDexKey: sell.descriptor.owner.dexKey, buyerAddress: buyer,
    buyerBoxKey: boxPublic(buyerBox), policyId: h(32), targetReset: sell.descriptor.principalReset,
    payoutReset: sell.descriptor.principalReset, pieces: [{ unitId: sell.id, generation: 0 }], expiresNotBefore: 200000 };
  let reserved;
  for (let i = 0; i < 4; i++) reserved = ledger(i, seller).reserve(reservation);
  assert.throws(() => ledger(0, buyer).reserve({ ...reservation, sellerDexKey: buy.descriptor.owner.dexKey,
    pieces: [{ unitId: buy.id, generation: 0 }] }), /not_reserved/);
  const delivered = certify('resolved', { reservationId: reserved.reservationId, outcome: 'delivered', evidenceDigest: h(33), pieces: reservation.pieces });
  for (let i = 0; i < 4; i++) {
    ledger(i, seller).resolve(delivered);
    assert.equal(ledger(i, seller).read().pieces[sell.id].generation, 1);
    assert.equal(dkg(i).read(sell.id).release, undefined);
  }
  const next = { ...reservation, tradeId: h(34), H: h(35), pieces: [{ unitId: sell.id, generation: 1 }] };
  for (let i = 0; i < 4; i++) reserved = ledger(i, seller).reserve(next);
  function inventory(height) {
    return { height, blockHash: h(100 + height), accounts: [seller, buyer].map(address => ({ address,
      pieces: Object.values(ledger(0, address).read().pieces).map(p => ({ unitId: p.unitId, generation: p.generation,
        principalReset: p.descriptor.principalReset, purpose: p.descriptor.purpose, state: p.state })) })) };
  }
  const rewards = () => new RewardLedger({ store: store(4), context, identity: { secretKey: new Uint8Array(32).fill(9) } });
  const firstInventory = certify('inventory', inventory(1));
  const first = rewards().accrue({ height: 1, blockHash: h(101), previousHash: h(100), at: now, settings, poolBalance: '500000000',
    inventoryCertificate: firstInventory,
    bookCertificate: certify('book', { height: 1, blockHash: h(101), backing: [{ address: seller, unitId: sell.id, amount: sell.descriptor.principalReset }] }),
    priceCertificate: certify('price', { height: 1, blockHash: h(101), price }) });
  assert.equal(BigInt(first.body.weights.find(w => w.address === seller).weight), 2n * BigInt(first.body.weights.find(w => w.address === buyer).weight));
  now = 200000;
  const award = certify('decision', { decisionId: h(40), outcome: 'buyer-no-show', at: now, pieces: next.pieces,
    reservationId: reserved.reservationId, winnerAddress: buyer, winnerBoxKey: boxPublic(buyerBox), evidenceDigest: h(41) });
  const unpaid = rewards().status(seller, settings).unpaid;
  rewards().forfeit({ address: seller, decisionCertificate: award, inventoryCertificate: firstInventory, now });
  assert.equal(rewards().status(seller, settings).unpaid, '0'); assert.equal(rewards().status(seller, settings).forfeited, unpaid);
  assert.notEqual(rewards().status(buyer, settings).unpaid, '0');
  const releases = [0, 1, 2].map(i => dkg(i).release(sell.id, award, ledger(i, seller)));
  function reconstructFor(releases, secret, decision) {
    return reconstruct(releases.map(v => {
      const b = v.fact.body, scope = { positionId: b.positionId, decisionDigest: factDigest(decision[0].fact), winnerAddress: b.winnerAddress, j: b.j };
      return { id: b.j, share: fromLe32(openShare(b.sealed, secret, scope, 'release')) };
    }), 3, releases[0].fact.body.C);
  }
  assert.equal(publicOf(reconstructFor(releases, buyerBox, award)), sell.lock.A);
  assert.throws(() => reconstructFor(releases, sellerBox, award));
  assert.deepEqual(dkg(0).release(sell.id, award, ledger(0, seller)), releases[0]);
  const collected = certify('collected', { unitId: sell.id, generation: 1, decisionId: h(40), txHash: h(42) });
  for (let i = 0; i < 3; i++) { ledger(i, seller).collected(collected); capacity(i).retire(collected); }
  assert.equal(ledger(0, seller).read().pieces[sell.id].state, 'retired');
  assert.throws(() => dkg(0).start(sell.descriptor, sell.certificate), /retired/);
  const freeze = certify('freeze', { operationId: h(50), pieces: [{ unitId: buy.id, generation: 0 }], acceptedAt: now,
    withdrawDelaySec: settings.stake.withdrawDelaySec });
  for (let i = 0; i < 4; i++) ledger(i, buyer).freeze(freeze, settings);
  const second = rewards().accrue({ height: 2, blockHash: h(102), previousHash: h(101), at: now, settings, poolBalance: '500000000',
    inventoryCertificate: certify('inventory', inventory(2)),
    bookCertificate: certify('book', { height: 2, blockHash: h(102), backing: [] }), priceCertificate: certify('price', { height: 2, blockHash: h(102), price }) });
  assert.equal(second.body.state, 'no_weight'); assert.equal(second.body.accrued, '0');
  const returned = { decisionId: h(51), outcome: 'seller-withdraw', pieces: freeze[0].fact.body.pieces,
    winnerAddress: buyer, winnerBoxKey: boxPublic(buyerBox), evidenceDigest: h(52), at: now + settings.stake.withdrawDelaySec };
  assert.throws(() => ledger(0, buyer).decide(certify('decision', { ...returned, at: returned.at - 1 })), /cooldown/);
  now = returned.at;
  const returnCertificate = certify('decision', returned), returns = [0, 2, 3].map(i => dkg(i).release(buy.id, returnCertificate, ledger(i, buyer)));
  assert.equal(publicOf(reconstructFor(returns, buyerBox, returnCertificate)), buy.lock.A);
});
