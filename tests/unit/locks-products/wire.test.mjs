import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { generateBox, encodeKey } from '../../../src/core/keys.js';
import { le32 } from '../../../src/core/canonical.js';
import * as vss from '../../../src/locks/crypto/edvss.js';
import * as dkg from '../../../src/locks/dkg.js';
import * as wire from '../../../src/locks/transport.js';
import { address } from '../../../src/locks/trac-lock.js';
import { selectCommittee, positionId } from '../../../src/locks/position.js';
import { lockChannel } from '../../../src/locks/client.js';
import { fixture, identity, position, party } from './helpers.mjs';

function committee(f) {
  const signers = Array.from({ length: 5 }, identity);
  f.reg.signers = signers.map(s => ({ lockKey: s.publicKey, boxKey: identity().publicKey, software: '0.2.0', status: 'active' }));
  return new Map(signers.map(s => [s.publicKey, s]));
}

test('real signed venue rows authenticate the post and commitments without detached signatures', async () => {
  const f = fixture(), signers = committee(f), maker = identity(), venue = identity(); f.client.venueKey = venue.publicKey;
  f.client.transport.open = (_ch, m, { historical = false } = {}) => wire.open(m, { now: f.time.now, ...(historical ? { maxAgeSec: Number.MAX_SAFE_INTEGER } : {}) });
  const p = position('call', party(maker), f.reg), A = vss.publicOf(7n), C = vss.split(7n, 3, [1, 2, 3, 4, 5]).commitments;
  const lock = { A, C, chain: 'trac', address: address(A), ...(wire.bodySchemas.posted.shape.Q ? { Q: [1, 2, 3, 4, 5] } : {}) };
  const attestations = p.committee.slice(0, 3).map((member, i) => wire.seal({ kind: 'posted', ch: wire.MAIN,
    body: { positionId: p.positionId, post: p.post, registryVersion: f.reg.version, j: i + 1, ...lock } }, signers.get(member.lockKey).secretKey, { ts: 1 }));
  const raw = wire.seal({ kind: 'book', ch: wire.MAIN, body: { positions: [{ positionId: p.positionId, post: p.post, lock, attestations }], page: 0, pageSize: 50, total: 1, requester: f.me.lockKey } }, venue.secretKey, { ts: f.time.now });
  await f.client.receive(wire.MAIN, raw);
  assert.equal(f.client.list().rows[0].positionId, p.positionId);
  assert.equal(f.client.book.get(p.positionId).lock.A, A);
  const forged = structuredClone(raw); forged.body.positions[0].post.terms.premium = '1';
  await assert.rejects(f.client.receive(wire.MAIN, forged), /signature/);
});

test('real sealed releases use recipient context, verify Feldman shares and bind scalar sweep wallet', async () => {
  const f = fixture(), signers = committee(f), generated = generateBox();
  f.me.boxKey = encodeKey(generated.publicKey); f.client.me.boxKey = f.me.boxKey;
  f.client.box = { publicKey: f.me.boxKey, secretKey: generated.secretKey };
  f.client.adapters.edvss = vss; delete f.client.adapters.openRelease;
  f.client.transport.open = (_ch, m) => wire.open(m, { now: f.time.now, maxAgeSec: Number.MAX_SAFE_INTEGER });
  const p = position('loan', f.me, f.reg), split = vss.split(7n, 3, [1, 2, 3, 4, 5]);
  p.lock = { A: vss.publicOf(7n), C: split.commitments, chain: 'trac', address: address(vss.publicOf(7n)) }; f.put(p);
  let sweeps = 0, bound;
  f.client.adapters.tracFor = wallet => { bound = wallet; return { scalar: true }; };
  f.client.adapters.tracLock = { address, sweep: async input => {
    sweeps++; assert.equal(input.a, 7n); assert.equal(input.journal, f.store); assert.equal(input.positionId, p.positionId);
    assert.equal(input.adapter.scalar, true); assert.equal(input.asset, 'RESET'); return { ok: true };
  } };
  const originals = new Map();
  const send = async (j, context = { positionId: p.positionId, from: j, to: f.me.lockKey }) => {
    const body = { positionId: p.positionId, j, winner: 'maker', outcome: 'repaid', A: p.lock.A, C: p.lock.C,
      sealed: dkg.sealShare(le32(split.shares[j - 1].share), f.me.boxKey, context, 'release') };
    const raw = originals.get(j) ?? wire.seal({ kind: 'release', ch: lockChannel(p.positionId), body }, signers.get(p.committee[j - 1].lockKey).secretKey, { ts: 1 });
    if (context.to === f.me.lockKey) originals.set(j, raw);
    return f.client.receive(lockChannel(p.positionId), raw);
  };
  await assert.rejects(send(1, { positionId: p.positionId, from: 1, to: p.taker.lockKey }));
  await send(1); await send(2); assert.equal(sweeps, 0);
  assert.equal(f.sent.some(s => s[1] === 'releaseReceipt'), false, 'fee proof must not expose the key before collection');
  await send(3); assert.equal(sweeps, 1); assert.equal(p.state, 'released');
  assert.equal(bound.publicKey, p.lock.A); assert.equal(bound.address, p.lock.address);
  const message = Buffer.from('sweep'); assert.ok(ed25519.verify(Buffer.from(bound.sign(message), 'hex'), message, Buffer.from(p.lock.A, 'hex')));
  if (wire.bodySchemas.releaseReceipt) assert.equal(f.sent.filter(s => s[1] === 'releaseReceipt').length, 3);
  await send(3); assert.equal(sweeps, 1);
});

test('pending Trac sweep resumes its journal instead of requiring a Solana receipt', async () => {
  const f = fixture(), p = position('loan', f.me, f.reg); p.lock = { A: f.A, C: [f.A, f.A, f.A], chain: 'trac' }; f.put(p);
  let calls = 0; f.client.adapters.tracLock.sweep = async input => { calls++; assert.equal(input.journal, f.store); return { ok: calls > 1 }; };
  for (let i = 0; i < 2; i++) await f.receive(p, 'release', i, { winner: 'maker', outcome: 'repaid', sealed: {} });
  await assert.rejects(f.receive(p, 'release', 2, { winner: 'maker', outcome: 'repaid', sealed: {} }), /payment_pending/);
  await f.client.onClock(); assert.equal(p.state, 'released'); assert.equal(calls, 2);
});

test('book pagination follows the venue page size and serves all asset-filtered UI pages', async () => {
  const f = fixture(), signers = committee(f), maker = identity(), venue = identity(); f.client.venueKey = venue.publicKey;
  f.reg.limits.TNK = { ...f.reg.limits.RESET }; f.reg.limits.totalLocked.TNK = f.reg.limits.totalLocked.RESET;
  f.client.transport.open = (_ch, m, { historical = false } = {}) => wire.open(m, { now: f.time.now, ...(historical ? { maxAgeSec: Number.MAX_SAFE_INTEGER } : {}) });
  const A = vss.publicOf(7n), C = vss.split(7n, 3, [1, 2, 3, 4, 5]).commitments;
  const lock = { A, C, chain: 'trac', address: address(A), ...(wire.bodySchemas.posted.shape.Q ? { Q: [1, 2, 3, 4, 5] } : {}) };
  const rows = Array.from({ length: 55 }, () => {
    const p = position('call', party(maker), f.reg); p.post.terms.asset = 'TNK'; p.positionId = positionId(p.post); p.committee = selectCommittee(f.reg, p.positionId);
    const attestations = p.committee.slice(0, 3).map((member, i) => wire.seal({ kind: 'posted', ch: wire.MAIN,
      body: { positionId: p.positionId, post: p.post, registryVersion: f.reg.version, j: i + 1, ...lock } }, signers.get(member.lockKey).secretKey, { ts: 1 }));
    return { positionId: p.positionId, post: p.post, lock, attestations };
  });
  const requests = [];
  f.client.transport.requestBook = async ({ page }) => {
    requests.push(page); return wire.seal({ kind: 'book', ch: wire.MAIN,
      body: { positions: rows.slice(page * 17, (page + 1) * 17), page, pageSize: 17, total: rows.length, requester: f.me.lockKey } }, venue.secretKey, { ts: f.time.now });
  };
  const first = await f.client.refreshBook({ asset: 'TNK' }), second = await f.client.refreshBook({ asset: 'TNK', page: 1 });
  assert.equal(first.rows.length, 50); assert.equal(first.total, 55); assert.equal(first.next, 1);
  assert.equal(second.rows.length, 5); assert.equal(second.next, null);
  assert.deepEqual(requests, [0, 1, 2, 3]); assert.equal(f.client.list({ asset: 'RESET' }).total, 0);
});
