import test from 'node:test';
import assert from 'node:assert/strict';
import { MAIN, seal, receiver } from '../../../src/locks/transport.js';
import { stack } from '../../integration/locks/harness.mjs';

const summaries = s => s.sent.map(row => row.raw).filter(raw => raw.kind === 'summary');

test('the venue summary shows an offer, then the running loan, then the repaid loan with the releasing keys', async t => {
  const s = await stack(); t.after(s.stop);
  s.venue.clock = { counted: async () => s.chain.counted, T: async () => 1792760000 };
  const id = await s.post(); await s.drain();
  assert.equal(await s.venue.publishSummary(), true);
  let body = summaries(s).at(-1).body;
  assert.deepEqual(body.offers.map(o => o.id), [id]);
  assert.equal(body.offers[0].product, 'loan');
  assert.match(body.offers[0].amount, /^\d+(\.\d+)?$/);
  assert.equal(body.counted, s.chain.counted); assert.equal(body.blockAt, 1792760000);
  assert.equal(await s.venue.publishSummary(), false, 'an unchanged summary is not sent again within the keepalive');
  const takeId = await s.take(id); await s.pay(id, 'open:' + takeId); await s.drain();
  await s.venue.publishSummary(); body = summaries(s).at(-1).body;
  assert.deepEqual([body.offers.length, body.running.map(r => r.id)], [0, [id]]);
  assert.ok(Number.isSafeInteger(body.running[0].dueBlock));
  await s.pay(id, 'repay'); s.chain.counted = 106;
  for (const signer of s.signers) await signer.reconcile(); await s.drain();
  await s.venue.publishSummary(); body = summaries(s).at(-1).body;
  assert.equal(body.running.length, 0);
  assert.equal(body.ended[0].id, id); assert.equal(body.ended[0].outcome, 'repaid'); assert.equal(body.ended[0].winner, 'maker');
  assert.ok(body.ended[0].keys.length >= 3);
  assert.ok(receiver(() => s.time.now)(summaries(s).at(-1)), 'the summary passes the public locks schema');
});

test('signers count as online from their heartbeats', async t => {
  const s = await stack(); t.after(s.stop);
  const signer = s.signers[1];
  await s.venue.handle(MAIN, seal({ ch: MAIN, kind: 'heartbeat', body: { registryVersion: 1, software: '0.2.0', status: 'online', holdCount: 0 } }, signer.identity.secretKey, { ts: s.time.now }));
  await s.venue.queue;
  await s.venue.publishSummary();
  const n = s.venue.registry.signers.findIndex(x => x.lockKey === signer.identity.publicKey) + 1;
  assert.deepEqual(summaries(s).at(-1).body.signers.filter(x => x.online).map(x => x.n), [n]);
});

test('a lock whose setup never finished ends as unfunded at the venue after the setup time', async t => {
  const s = await stack(); t.after(s.stop);
  const id = await s.post('loan', 'RESET', {}, false);
  for (const signer of s.signers) signer.stop();
  const p = s.venue.positions.get(id); p.state = 'creating'; s.venue.save(structuredClone(p));
  s.venue.expireSetups(); assert.equal(s.venue.positions.get(id).state, 'creating', 'still within the setup time');
  s.time.now += s.venue.registry.params.dkgTimeoutSec + 301;
  s.venue.expireSetups();
  assert.equal(s.venue.positions.get(id).state, 'ended:unfunded');
  assert.equal(s.venue.positions.active.has(id), false, 'no longer counts against the limits');
});
