import test from 'node:test';
import assert from 'node:assert/strict';
import { startIsolatedValidator } from './harness.mjs';
import { finalizedStakeClock } from '../../../src/stake/chain.js';

test('isolated validator refuses invalid optional epoch lengths before starting a process', async () => {
  for (const slotsPerEpoch of [0, 31, 2000001, 1.5])
    await assert.rejects(startIsolatedValidator({ slotsPerEpoch }), /epoch/);
});

test('long local epoch supports a finalized day-long stake clock advance', { timeout: 110000 }, async () => {
  let validator = await startIsolatedValidator({ maxLifetimeMs: 100000, slotsPerEpoch: 2000000 });
  try {
    const endpoints = [validator.rpc, validator.rpc.replace('127.0.0.1', 'localhost')];
    const before = await finalizedStakeClock({ endpoints });
    assert.ok(Math.abs(before.at - Math.floor(Date.now() / 1000)) < 60);
    validator = await validator.warp(60000);
    const after = await finalizedStakeClock({ endpoints });
    assert.ok(after.at >= before.at + 86400);
    assert.ok(after.slot > before.slot);
  } finally { await validator.stop(); }
});
