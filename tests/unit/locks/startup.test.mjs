import test from 'node:test';
import assert from 'node:assert/strict';
import { MAIN } from '../../../src/locks/transport.js';
import { lockError } from '../../../src/locks/position.js';
import { fixture } from '../locks-products/helpers.mjs';

test('client starts while the venue does not answer yet and reads the book later', async () => {
  const f = fixture(); let up = false;
  f.options.transport.subscribe ??= () => () => {};
  f.options.transport.join ??= async () => {};
  f.options.transport.requestBook = async () => {
    if (!up) throw lockError('venue_unavailable');
    return { auth: true, ch: MAIN, from: f.options.venueKey, kind: 'book', body: { page: 0, pageSize: 100, total: 0, positions: [], requester: f.me.lockKey } };
  };
  await f.client.start();
  up = true; f.client.bookRead = null;
  assert.equal((await f.client.refreshBook()).total, 0);
  await f.client.stop();
});

test('client starts while the clock does not answer yet, keeps listening to ticks and shows no made-up countdowns', async () => {
  const f = fixture(); let up = false, tick = null;
  f.options.transport.subscribe ??= () => () => {};
  f.options.transport.join ??= async () => {};
  f.options.transport.requestBook = async () => ({ auth: true, ch: MAIN, from: f.options.venueKey, kind: 'book', body: { page: 0, pageSize: 100, total: 0, positions: [], requester: f.me.lockKey } });
  f.client.clock = { read: async () => { if (!up) throw new Error('Bridge timeout: locks_clock'); return { counted: f.time.counted }; } };
  f.client.adapters.subscribeClock = listener => { tick = listener; return () => {}; };
  await f.client.start();
  assert.equal(f.client.counted, null);
  assert.equal(typeof tick, 'function', 'the clock subscription is set up even without a first height');
  up = true; await tick();
  assert.equal(f.client.counted, f.time.counted);
  await f.client.stop();
});
