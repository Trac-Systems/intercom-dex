import test from 'node:test';
import assert from 'node:assert/strict';
import { solanaSettings, stakeClockSettings } from '../../../src/solana/settings.js';
import { DEFAULT_ENDPOINTS } from '../../../src/solana/constants.js';

test('mainnet roles without RPC settings use the public endpoints; configured values always win', () => {
  const mainnet = { network: 'mainnet' }, local = { network: 'local' };
  assert.deepEqual(solanaSettings({}, mainnet), { endpoints: [...DEFAULT_ENDPOINTS], sendEndpoint: DEFAULT_ENDPOINTS[0], need: 2 });
  assert.ok(DEFAULT_ENDPOINTS.length >= 2);
  const own = { solana: { endpoints: ['https://a.example', 'https://b.example'], sendEndpoint: 'https://b.example', need: 1 } };
  assert.deepEqual(solanaSettings(own, mainnet), own.solana);
  assert.deepEqual(solanaSettings({ solana: { endpoints: ['https://a.example', 'https://b.example'] } }, mainnet).sendEndpoint, 'https://a.example');
  assert.equal(solanaSettings({}, local), null);
  assert.deepEqual(solanaSettings(own, local), own.solana);
});

test('stake clock readers can differ from the trade readers and always need two that agree', () => {
  const own = { solana: { endpoints: ['https://own.example'], need: 1 } }, rpc = solanaSettings(own, { network: 'mainnet' });
  assert.equal(stakeClockSettings(own, rpc), rpc);
  const clock = { solana: { ...own.solana, clockEndpoints: ['https://own.example', 'https://public.example'] } };
  assert.deepEqual(stakeClockSettings(clock, rpc), { endpoints: ['https://own.example', 'https://public.example'], need: 2 });
  assert.deepEqual(solanaSettings(clock, { network: 'mainnet' }), rpc);
  for (const bad of [['https://own.example'], ['https://a.example', 'https://a.example'], ['https://a.example', 'http://b.example'], 'https://a.example'])
    assert.throws(() => stakeClockSettings({ solana: { clockEndpoints: bad } }, rpc), /clockEndpoints/);
});
