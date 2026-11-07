import test from 'node:test';
import assert from 'node:assert/strict';
import { paced, STAKE_IDLE_POLL_MS } from '../../../src/stake/runtime.js';

test('paced work runs once per interval, never twice at once, and every time while urgent', async () => {
  let t = 0, runs = 0, urgent = false, release;
  const work = paced(STAKE_IDLE_POLL_MS, async n => { runs += n; if (release === null) await new Promise(r => { release = r; }); },
    { urgent: () => urgent, now: () => t });
  assert.equal(await work(1), true);
  t = 15000; assert.equal(await work(1), false);
  t = 60000; assert.equal(await work(1), true);
  assert.equal(runs, 2);
  urgent = true; t = 61000; assert.equal(await work(1), true); assert.equal(runs, 3);
  release = null; const slow = work(1);
  await new Promise(r => setImmediate(r));
  assert.equal(await work(1), false, 'an urgent run still never overlaps the one in progress');
  release(); assert.equal(await slow, true); assert.equal(runs, 4);
});
