import test from 'node:test';
import assert from 'node:assert/strict';
import { solanaSettings } from '../../../src/solana/settings.js';
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
