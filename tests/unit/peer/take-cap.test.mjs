import test from 'node:test';
import assert from 'node:assert/strict';
import { takeCapFixture, until, sleep } from './take-cap-fixture.mjs';

test('trade-topic discovery answers a take after eight unrelated inbound connections', { timeout: 30000 }, async t => {
  const f = await takeCapFixture(); t.after(f.close);
  assert.equal(f.stats().inbound, 8); assert.equal(f.stats().outbound, 0);
  await f.join();
  await until('maker discovered', () => f.stats().makerDiscovered);
  await until('maker connected above eight', () => f.stats().makerConnected);
  assert.equal(f.stats().makerExplicit, false);
  await f.send('take');
  await until('reply', () => f.stats().repliesAtTaker > 0);
  assert.equal(f.stats().takesAtMaker, 1); assert.deepEqual(f.errors, []);
  t.diagnostic(JSON.stringify(f.stats()));
});

test('the released cap leaves discovered trade peers undialed; dex_join pins recover without warm', { timeout: 30000 }, async t => {
  const f = await takeCapFixture({ connections: { maxPeers: 8, maxClientConnections: 8 } }); t.after(f.close);
  await f.join();
  await until('maker discovered behind cap', () => f.stats().makerDiscovered);
  await f.send('present');
  for (let i = 0; i < 3; i++) { await f.send('take'); await sleep(100); }
  assert.equal(f.stats().makerConnected, false);
  assert.equal(f.stats().directAttempts, 0);
  assert.equal(f.stats().takesAtMaker, 0); assert.equal(f.stats().repliesAtTaker, 0);
  assert.equal(f.stats().relay.relay_attempts, 0);
  t.diagnostic('capped: ' + JSON.stringify(f.stats()));
  await f.join(true);
  await until('pinned maker connected', () => f.stats().makerConnected);
  await f.send('take'); await until('pinned reply', () => f.stats().repliesAtTaker > 0);
  assert.equal(f.stats().makerExplicit, true); assert.deepEqual(f.errors, []);
});
