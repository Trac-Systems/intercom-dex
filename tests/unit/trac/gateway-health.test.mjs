import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createGatewayHealth, GATEWAY_CACHE_MS, GATEWAY_TIMEOUT_MS } from '../../../src/trac/gateway-health.js';

test('gateway health requires an integer eligible count of at least three; connected and v1Ready cannot substitute', async () => {
  const cases = [
    [{ validators: { connected: 0, v1Ready: 0, eligible: 3 } }, true, 3, null],
    [{ validators: { eligible: 4 } }, true, 4, null],
    [{ validators: { connected: 8, v1Ready: 8, eligible: 2 } }, false, 2, /needs at least 3/],
    [{ validators: { eligible: 0 } }, false, 0, /needs at least 3/],
    [{}, false, null, /did not report validator health/],
    [{ validators: null }, false, null, /not sampled/],
    [{ validators: { eligible: null } }, false, null, /cannot tell/],
    ...[undefined, '3', 3.5, -1, true, Number.MAX_SAFE_INTEGER + 1].map(eligible => [{ validators: { eligible } }, false, null, /valid eligible/]),
    [null, false, null, /did not report/],
  ];
  for (const [state, ok, eligible, reason] of cases) {
    const reader = createGatewayHealth({ resetGatewayUrl: 'https://reset.example', request: async () => Response.json(state), now: () => 1234 });
    const value = await reader.read();
    assert.deepEqual([value.ok, value.eligible, value.checkedAt], [ok, eligible, 1234]);
    if (reason) assert.match(value.reason, reason); else assert.equal(value.reason, null);
  }
});

test('gateway origin, GET route, redirect policy and timeout match the transfer gateway', async t => {
  for (const resetGatewayUrl of ['file:///tmp', 'https://user:pass@gateway.example', 'https://gateway.example/path', 'https://gateway.example/?x=1', 'https://gateway.example/#x']) {
    assert.throws(() => createGatewayHealth({ resetGatewayUrl }), /gateway origin/);
  }
  const durations = [], timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => { durations.push(ms); return timeout(ms); });
  const reader = createGatewayHealth({ resetGatewayUrl: 'https://reset.example:8443', request: async (url, options) => {
    assert.equal(String(url), 'https://reset.example:8443/v1/state');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ validators: { eligible: 3 } });
  } });
  assert.equal((await reader.read()).ok, true); assert.deepEqual(durations, [30000]);
  const missing = createGatewayHealth({ request: () => { throw Error('must not fetch'); } });
  assert.match((await missing.read()).reason, /No RESET gateway/);
});

test('HTTP, invalid JSON, excessive response and network errors all pause RESET', async () => {
  for (const [request, reason] of [
    [async () => new Response('down', { status: 503 }), /HTTP 503/],
    [async () => new Response('{'), /invalid state/],
    [async () => new Response(' '.repeat(65537)), /invalid state/],
    [async () => { throw Error('offline'); }, /check failed/],
  ]) {
    const reader = createGatewayHealth({ resetGatewayUrl: 'https://reset.example', request });
    const value = await reader.read(); assert.equal(value.ok, false); assert.equal(value.eligible, null); assert.match(value.reason, reason);
  }
});

test('a real stalled HTTP health read times out and fails closed', async t => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, GATEWAY_TIMEOUT_MS); return timeout(25); });
  const reader = createGatewayHealth({ resetGatewayUrl: `http://127.0.0.1:${server.address().port}` });
  assert.deepEqual({ ...(await reader.read()), checkedAt: 0 }, { ok: false, eligible: null, checkedAt: 0, reason: 'The RESET gateway health check timed out.' });
});

test('both health outcomes cache for less than fifteen seconds, share in-flight reads, and fresh bypasses the cache', async () => {
  let clock = 1000, calls = 0, eligible = 3, release;
  const reader = createGatewayHealth({ resetGatewayUrl: 'https://reset.example', now: () => clock,
    request: () => { calls++; return new Promise(resolve => { release = () => resolve(Response.json({ validators: { eligible } })); }); } });
  assert.equal(reader.peek().ok, false);
  const a = reader.read(), b = reader.read({ fresh: true });
  assert.equal(a, b); assert.equal(calls, 1); release();
  const healthy = await a; assert.equal(healthy.ok, true);
  clock += GATEWAY_CACHE_MS - 1;
  assert.equal(await reader.read(), healthy); assert.equal(calls, 1);
  clock++;
  assert.equal(reader.peek().ok, false, 'an expired healthy value is not displayed as healthy');
  eligible = 2;
  const c = reader.read(); assert.equal(calls, 2); release();
  const unhealthy = await c; assert.equal(unhealthy.ok, false);
  assert.equal(await reader.read(), unhealthy); assert.equal(calls, 2);
  eligible = 3;
  const d = reader.read({ fresh: true }); assert.equal(calls, 3); release();
  assert.equal((await d).ok, true);
  clock--;
  assert.equal(reader.peek().ok, false, 'a regressed clock cannot extend health');
});
