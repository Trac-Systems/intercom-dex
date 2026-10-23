import test from 'node:test';
import assert from 'node:assert/strict';
import { registerLocksTools } from '../../../src/mcp/locks-tools.js';

test('all seven locks tools forward exact control routes and preserve actionable failures', async () => {
  const tools = new Map(), calls = [];
  registerLocksTools({ registerTool: (name, spec, run) => tools.set(name, { spec, run }) }, async (...args) => {
    calls.push(args); return args[1].includes('settings') ? { autoSweep: true } : { ok: false, reason: 'already_taken', whatToDo: 'Choose another offer.' };
  });
  assert.equal(tools.size, 7);
  const result = await tools.get('dex_lock_take').run({ positionId: 'a'.repeat(64) });
  assert.equal(result.isError, true); assert.equal(JSON.parse(result.content[0].text).reason, 'already_taken');
  assert.deepEqual(calls[0], ['POST', '/api/locks/act', { action: 'take', input: { positionId: 'a'.repeat(64) } }]);
  await tools.get('dex_lock_pay').run({ positionId: 'b'.repeat(64), step: 'exercise' });
  assert.equal(calls.at(-1)[2].action, 'exercise');
  await tools.get('dex_locks').run({ product: 'loan', page: 1, minSize: '100' });
  assert.equal(calls.at(-1)[1], '/api/locks?product=loan&page=1&minSize=100');
  await tools.get('dex_lock_events').run({ since: 9 }); assert.equal(calls.at(-1)[1], '/api/locks/events?since=9');
  const before = calls.length;
  const invalid = await tools.get('dex_lock_status').run({ settings: { autoSweep: false } });
  assert.equal(JSON.parse(invalid.content[0].text).reason, 'settings_invalid'); assert.equal(calls.length, before);
});
