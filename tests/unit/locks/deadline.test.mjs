import test from 'node:test';
import assert from 'node:assert/strict';
import { within } from '../../e2e/deadline.mjs';

test('poll deadline rejects even when the read itself never returns', async () => {
  await assert.rejects(within('offline case: both running', 20, () => new Promise(() => {})), /Timed out: offline case: both running/);
});
test('completed work clears its deadline', async () => {
  assert.equal(await within('read', 1000, async () => 7), 7);
});
