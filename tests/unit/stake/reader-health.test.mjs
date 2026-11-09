import test from 'node:test';
import assert from 'node:assert/strict';
import { readerHealth, READER_STALL_MS } from '../../../peer/src/trac/reader-health.js';
import { SignerReaderHealth } from '../../../src/stake/reader-health.js';
import { Signer } from '../../../src/roles/signer.js';

test('reader health detects a stalled RESET view while MSB advances, then clears on signed progress', () => {
  let now = 1000;
  const MSB = { signedLength: 10, length: 11 }, RESET = { signedLength: 20, length: 21 };
  const read = readerHealth({ sources: () => ({ MSB, RESET }), now: () => now });
  assert.equal(read().readers.RESET.status, 'observing');
  now += READER_STALL_MS - 1; MSB.signedLength++;
  assert.equal(read().readers.RESET.status, 'observing');
  now++; MSB.signedLength++;
  const stalled = read();
  assert.equal(stalled.readers.RESET.status, 'stalled');
  assert.equal(stalled.readers.RESET.unchangedMs, READER_STALL_MS);
  assert.equal(stalled.readers.MSB.status, 'advancing');
  RESET.length++;
  assert.equal(read().readers.RESET.status, 'stalled', 'an unsigned tail does not prove progress');
  RESET.signedLength++;
  assert.equal(read().readers.RESET.status, 'advancing');
  assert.equal(RESET.signedLength, 21, 'the observer never mutates the core');
});

test('unavailable readers and missing/old bridge methods stay visible; status reads perform no I/O', async () => {
  let now = 1000, calls = 0, fail = false;
  const poller = new SignerReaderHealth({ now: () => now, bridge: { call: async method => {
    calls++; assert.equal(method, 'dex_reader_health');
    if (fail) throw Error('Unsupported request');
    return readerHealth({ sources: () => ({ MSB: { signedLength: 10 }, RESET: null }) })();
  } } });
  assert.equal(poller.status().status, 'unavailable');
  await poller.poll();
  assert.equal(poller.status().status, 'degraded');
  assert.match(poller.status().message, /RESET/);
  const role = { registry: {}, strikes: { enabled: false }, identity: { publicKey: '1'.repeat(64) }, host: { trades: new Map() },
    stakeRuntime: { readerHealth: poller } };
  assert.match(Signer.prototype.status.call(role).message, /RESET/);
  assert.equal(calls, 1);
  now += 120001;
  assert.equal(poller.status().status, 'unavailable');
  fail = true; await poller.poll();
  assert.equal(poller.status().status, 'unavailable');
  assert.equal(poller.status().readers, null);
});

test('overlapping reader polls share a single bridge request', async () => {
  let done, calls = 0;
  const poller = new SignerReaderHealth({ bridge: { call: () => { calls++; return new Promise(resolve => { done = resolve; }); } } });
  const pending = poller.poll(); await poller.poll(); assert.equal(calls, 1);
  done({ readers: { MSB: { status: 'advancing' }, RESET: { status: 'advancing' } } });
  await pending; assert.equal(poller.status().status, 'online');
});
