import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, readFileSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDashboard, writeToken } from '../../../src/dashboard/server.js';
import { traderFixture, startFor, httpCall as call } from './fixtures.mjs';

async function start(t) {
  const fx = traderFixture(), s = await startFor(t, fx);
  return { ...s, fx };
}

test('binds 127.0.0.1 only, writes a fresh 0600 token file per start and returns it once as a local URL', async t => {
  const s = await start(t);
  assert.equal(s.dash.address, '127.0.0.1');
  assert.match(s.dash.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}$/);
  assert.equal(readFileSync(join(s.dir, 'dashboard.token'), 'utf8').trim(), s.token);
  assert.equal(statSync(join(s.dir, 'dashboard.token')).mode & 0o777, 0o600);
  const again = writeToken(s.dir);
  assert.notEqual(again.token, s.token);
  assert.equal(readFileSync(again.file, 'utf8').trim(), again.token);
  assert.ok(!readdirSync(s.dir).some(f => f.endsWith('.tmp')));
  chmodSync(again.file, 0o644); writeFileSync(again.file, 'old');
  assert.equal(statSync(writeToken(s.dir).file).mode & 0o777, 0o600, 'an earlier file is replaced, never reused with its mode');
  await assert.rejects(startDashboard({ config: { ...s.fx.config, dataDir: s.dir, dashboard: { port: 70000 } }, role: s.fx.role, bridge: s.fx.bridge }), /dashboard.port/);
  await assert.rejects(startDashboard({ config: { ...s.fx.config, dataDir: s.dir, dashboard: { port: '8080' } }, role: s.fx.role, bridge: s.fx.bridge }), /dashboard.port/);
});

test('the token in the URL becomes an HttpOnly same-site cookie and is removed from the address', async t => {
  const s = await start(t);
  const r = await call(s.port, { path: `/?t=${s.token}` });
  assert.equal(r.status, 303); assert.equal(r.headers.location, '/');
  assert.equal(r.headers['set-cookie'][0], `${s.cookie}; Path=/; HttpOnly; SameSite=Strict`);
  const page = await call(s.port, { cookie: r.headers['set-cookie'][0].split(';')[0] });
  assert.equal(page.status, 200); assert.match(page.headers['content-type'], /text\/html/); assert.ok(!page.body.includes(s.token));
  for (const path of ['/app.js', '/style.css', '/api/state']) assert.equal((await call(s.port, { path, cookie: s.cookie })).status, 200);
});

test('every request needs the token: missing, wrong or short tokens and other ports’ cookies are refused', async t => {
  const s = await start(t);
  for (const opts of [{}, { path: '/api/state' }, { path: '/app.js' }, { path: `/?t=${'0'.repeat(64)}` }, { path: '/?t=abc' }, { path: '/?t=' },
    { path: '/api/state', cookie: `dexdash${s.port}=${'0'.repeat(64)}` }, { path: '/api/state', cookie: `dexdash1=${s.token}` },
    { path: `/api/state?t=${s.token}` }, { path: '/api/preview', method: 'POST', body: { action: 'cancel', input: {} } }]) {
    const r = await call(s.port, opts);
    assert.equal(r.status, 401, JSON.stringify(opts));
    assert.ok(!r.body.includes(s.token));
  }
});

test('Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding), even with a valid token', async t => {
  const s = await start(t);
  assert.equal((await call(s.port, { path: '/api/state', cookie: s.cookie, host: `localhost:${s.port}` })).status, 200);
  for (const host of ['evil.example', `evil.example:${s.port}`, '127.0.0.1', `127.0.0.1:${s.port + 1}`, `0.0.0.0:${s.port}`, `[::1]:${s.port}`, `127.0.0.1:${s.port}.evil.example`]) {
    const r = await call(s.port, { path: '/api/state', cookie: s.cookie, host });
    assert.equal(r.status, 421, host);
    const login = await call(s.port, { path: `/?t=${s.token}`, host });
    assert.equal(login.status, 421); assert.equal(login.headers['set-cookie'], undefined);
  }
});

test('no CORS, strict content policy, no caching; posts need JSON and the dashboard origin', async t => {
  const s = await start(t);
  const r = await call(s.port, { path: '/api/state', cookie: s.cookie, origin: 'http://evil.example' });
  assert.equal(r.status, 200);
  assert.ok(!Object.keys(r.headers).some(h => h.startsWith('access-control-')));
  assert.match(r.headers['content-security-policy'], /default-src 'none'; script-src 'self'/);
  assert.ok(!/unsafe|https?:/.test(r.headers['content-security-policy']));
  assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['x-frame-options'], 'DENY');
  const preview = { action: 'cancel', input: { offerId: s.fx.mine.offerId } };
  assert.equal((await call(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, origin: 'http://evil.example', body: preview })).status, 403);
  assert.equal((await call(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, origin: `http://localhost:${s.port + 1}`, body: preview })).status, 403);
  assert.equal((await call(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: JSON.stringify(preview), type: 'text/plain' })).status, 403);
  const ok = await call(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, origin: `http://127.0.0.1:${s.port}`, body: preview });
  assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.body).title, 'Cancel offer');
  assert.equal((await call(s.port, { path: '/api/nothing', cookie: s.cookie })).status, 404);
  assert.equal((await call(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: '{bad' })).status, 400);
  assert.equal(JSON.parse((await call(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: { action: 'export', input: {} } })).body).error, 'Unknown action');
});

test('state and traffic never contain secrets; traffic rows carry labels for known keys', async t => {
  const s = await start(t), f = s.fx.f;
  const reg = f.registry.signers[2];
  s.fx.bridge.emit('traffic', 'intercom-dex:signers', { v: 1, kind: 'heartbeat', ch: 'intercom-dex:signers', from: reg.dexKey, ts: 1, nonce: 'aa', body: {}, sig: 'bb' }, 250);
  s.fx.bridge.emit('traffic', 'intercom-dex:signers', { v: 1, kind: 'heartbeat', ch: 'intercom-dex:signers', from: reg.dexKey, ts: 1, nonce: 'aa', body: {}, sig: 'bb' }, 250);
  const traffic = JSON.parse((await call(s.port, { path: '/api/traffic?kind=heartbeat', cookie: s.cookie })).body);
  assert.equal(traffic.total, 1); assert.equal(traffic.rows[0].count, 2); assert.equal(traffic.rows[0].label, reg.label);
  assert.equal(traffic.rates['intercom-dex:signers'], 100);
  const state = (await call(s.port, { path: '/api/state', cookie: s.cookie })).body;
  for (const secret of ['e1'.repeat(32), 'a7'.repeat(32), '5e'.repeat(32), '4f'.repeat(32), s.token]) assert.ok(!state.includes(secret));
  assert.ok(!/mnemonic|secretKey|privateState|entropy/i.test(state));
});
