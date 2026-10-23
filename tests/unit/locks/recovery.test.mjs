import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, position } from '../locks-products/helpers.mjs';
import { stack } from '../../integration/locks/harness.mjs';
import { MAIN, channel, seal } from '../../../src/locks/transport.js';
import { setImmediate as turn } from 'node:timers/promises';

test('an unanswered pickup retries even if the position channel is still joined', async t => {
  const f = fixture(); t.after(() => f.client.stop());
  const p = f.put({ ...position('loan', f.me, f.reg), state: 'posted', opened: false });
  f.client.joined.add(channel(p.positionId));
  await f.client.onClock();
  assert.equal(f.sent.filter(([, kind]) => kind === 'lockRequest').length, 1);
  assert.equal(f.sent.filter(([, kind]) => kind === 'releaseRequest').length, 1);
  f.time.now += 59; await f.client.onClock();
  assert.equal(f.sent.filter(([, kind]) => kind === 'releaseRequest').length, 1);
  f.time.now += 1; await f.client.onClock();
  assert.equal(f.sent.filter(([, kind]) => kind === 'releaseRequest').length, 2);
});

test('a returned DKG member gets the funding notice after recovering the same lock', async t => {
  const f = fixture(); t.after(() => f.client.stop());
  const p = f.put({ ...position('loan', f.me, f.reg), state: 'posted', opened: false, funded: true });
  p.lock = { A: f.A, C: [f.A, f.A, f.A], address: f.options.adapters.tracLock.address(f.A), chain: 'trac', Q: [1, 2, 3, 4] };
  await f.receive(p, 'lockReady', 4, { j: 5, ...p.lock });
  assert.equal(f.sent.filter(([, kind]) => kind === 'funded').length, 1);
  assert.equal(p.state, 'posted');
  assert.equal(f.calls.length, 0, 'does not transfer funds again');
  await assert.rejects(f.receive(p, 'lockReady', 4, { j: 5, ...p.lock, Q: [1, 2, 3, 5] }), /lock_mismatch/);
});

test('running signers recover a missed opening without the venue and rate limit replies', async t => {
  const s = await stack(); t.after(s.stop);
  const id = await s.post('call'), takeId = await s.take(id); await s.pay(id, 'open:' + takeId);
  s.venue.bridge.active = false;
  const start = s.sent.length;
  const request = () => s.emit(s.clients[0], 'releaseRequest', { positionId: id });
  await request(); await s.drain();
  assert.equal(s.sent.slice(start).filter(x => x.raw.kind === 'opened').length, 5);
  await request(); await s.drain();
  assert.equal(s.sent.slice(start).filter(x => x.raw.kind === 'opened').length, 5);
  s.time.now += 60; await request(); await s.drain();
  assert.equal(s.sent.slice(start).filter(x => x.raw.kind === 'opened').length, 10);
  const confirmed = seal({ ch: MAIN, kind: 'releaseRequest', body: { positionId: id, takeId, pickup: 'release' } }, s.clients[0].identity.secretKey, { ts: s.time.now + 60 });
  s.time.now += 60; await s.signers[0].handle(MAIN, confirmed);
  assert.equal(s.sent.slice(start).filter(x => x.raw.kind === 'opened').length, 10, 'confirmed opening need not be resent');
});

for (const role of ['signer', 'venue']) test(`a pickup with no evidence does not consume the ${role} reply allowance`, async t => {
  const s = await stack(); t.after(s.stop);
  const id = await s.post('call');
  await s.emit(s.clients[0], 'releaseRequest', { positionId: id }); await s.drain();
  const takeId = await s.take(id); await s.pay(id, 'open:' + takeId);
  const request = () => seal({ ch: MAIN, kind: 'releaseRequest', body: { positionId: id } }, s.clients[0].identity.secretKey, { ts: s.time.now });
  const target = role === 'venue' ? s.venue : s.signers[0]; let start = s.sent.length;
  await Promise.all([target.handle(MAIN, request()), target.handle(MAIN, request())]);
  assert.equal(s.sent.slice(start).filter(x => x.raw.kind === 'opened').length, role === 'venue' ? 5 : 1, 'first actual reply must not wait for an empty earlier pickup; concurrent requests share the allowance');
  start = s.sent.length;
  await target.handle(MAIN, request());
  assert.equal(s.sent.length, start, 'actual replies still consume the allowance');
});

test('a pending pickup receives opening evidence before its next permitted retry', async t => {
  const f = fixture(); t.after(() => f.client.stop()); t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = f.put({ ...position('loan', f.me, f.reg), state: 'posted', opened: false }), taker = p.taker;
  delete p.taker;
  await f.client.requestRelease(p.positionId);
  t.mock.timers.tick(11000); await turn();
  if (f.client.joined.has(channel(p.positionId))) for (let j = 0; j < 3; j++) await f.receive(p, 'opened', j,
    { takeId: 'aa'.repeat(32), taker, takeAnchor: 100, dueBlock: 244 });
  assert.equal(p.state, 'running', 'do not abandon the pickup while a reply can still arrive and another request is rate limited');
  assert.equal(f.sent.filter(([, kind]) => kind === 'releaseRequest').length, 1);
  t.mock.timers.tick(49000); await turn();
  assert.equal(f.client.joined.has(channel(p.positionId)), false, 'an unanswered settlement pickup still has a bounded lifetime');
});

test('a pickup leaves immediately when collection evidence is complete', async t => {
  const f = fixture(); t.after(() => f.client.stop());
  f.options.transport.forward = async () => {};
  const p = f.put(position('loan', f.me, f.reg));
  p.lock = { A: f.A, C: [f.A, f.A, f.A], Q: [1, 2, 3, 4, 5], chain: 'trac' };
  await f.client.requestRelease(p.positionId);
  for (let j = 0; j < 3; j++) await f.receive(p, 'release', j, { winner: 'taker', outcome: 'defaulted', sealed: {} });
  assert.equal(p.state, 'released');
  assert.equal(f.client.joined.has(channel(p.positionId)), false, 'a finished pickup should not retain a channel until its timer expires');
  assert.equal(f.client.pickupTimers.size, 0);
});

test('a receipt wake joins the venue without asking signers for another quorum', async t => {
  const s = await stack(); t.after(s.stop);
  const id = await s.post(); await s.emit(s.clients[0], 'cancel', { positionId: id }); await s.drain();
  await s.venue.unwatch(s.venue.positions.get(id));
  const start = s.sent.length;
  await s.emit(s.clients[0], 'releaseRequest', { positionId: id, pickup: 'receipts' }); await s.drain();
  assert.equal(s.venue.joined.has(channel(id)), true);
  assert.equal(s.sent.slice(start).filter(x => x.raw.kind === 'release').length, 0);
});
