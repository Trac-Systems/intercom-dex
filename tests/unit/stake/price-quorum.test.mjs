import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { StakePriceService } from '../../../src/stake/price-service.js';
import { signFact } from '../../../src/stake/certificates.js';

const key = n => { const secretKey = new Uint8Array(32).fill(n); return { secretKey, dexKey: Buffer.from(ed25519.getPublicKey(secretKey)).toString('hex') }; };
const members = [key(11), key(12), key(13), key(14)], venueKey = key(10).dexKey;
const context = { networkId: 7, venueKey, epoch: { id: 'e'.repeat(64), n: 4, k: 3, maxFaulty: 1, members: members.map(m => ({ dexKey: m.dexKey })) } };
const fact = body => ({ v: 1, networkId: 7, venueKey, epochId: context.epoch.id, kind: 'price-head', body });

function service(answer) {
  const s = Object.create(StakePriceService.prototype);
  s.context = () => context; s.request = (to, method, body) => answer(members.findIndex(m => m.dexKey === to), body);
  return s;
}

test('a price head certificate completes on three matching votes while the fourth member never answers', async () => {
  const head = fact({ cutoffAt: 1, headPosition: 1, headHash: 'a'.repeat(64) });
  const s = service(i => i === 3 ? new Promise(() => {}) : Promise.resolve(signFact(head, members[i].secretKey)));
  const certificate = await s.quorum('priceHeadVote', {});
  assert.equal(certificate.length, 3);
  assert.deepEqual(certificate.map(v => v.from).sort(), members.slice(0, 3).map(m => m.dexKey).sort());
});

test('refusals are named in member order and mismatched votes never form a certificate', async () => {
  const head = fact({ cutoffAt: 1, headPosition: 1, headHash: 'a'.repeat(64) });
  const late = service(i => i < 2 ? Promise.resolve(signFact(head, members[i].secretKey)) :
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out ${i}`)), 5 - i)));
  await assert.rejects(late.quorum('priceHeadVote', {}), err => {
    assert.match(err.message, /^Three stake signers are required \(priceHeadVote; /);
    assert.ok(err.message.indexOf(members[2].dexKey.slice(0, 8)) < err.message.indexOf(members[3].dexKey.slice(0, 8)));
    return true;
  });
  const split = service(i => Promise.resolve(signFact(fact({ cutoffAt: 1, headPosition: 1, headHash: (i % 2 ? 'b' : 'c').repeat(64) }), members[i].secretKey)));
  await assert.rejects(split.quorum('priceHeadVote', {}), /Three matching stake votes are required/);
  const wrong = service(i => Promise.resolve(signFact(head, members[(i + 1) % 4].secretKey)));
  await assert.rejects(wrong.quorum('priceHeadVote', {}), /wrong signer/);
});
