import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { controlHandler } from '../../../src/roles/control.js';
import { validateSeller } from '../../../src/roles/signer-strikes.js';

const seller = { tracAddr: 'synthetic-trac-address', dexKey: 'ab'.repeat(32) };

test('signer CLI lists and clears an exact pair over authenticated local control without opening keys', t => {
  const dir = mkdtempSync(join(tmpdir(), 'strike-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'role.json'), tokenFile = join(dir, 'token'), loader = join(dir, 'boundary.mjs');
  const config = { role: 'signer', control: { port: 12345, tokenFile } };
  writeFileSync(configFile, JSON.stringify(config)); writeFileSync(tokenFile, 'synthetic-token', { mode: 0o600 });
  writeFileSync(loader, `globalThis.fetch = async (url, request) => {
    if (new URL(url).hostname !== '127.0.0.1' || request.headers.authorization !== 'Bearer synthetic-token') throw Error('bad authentication');
    return new Response(JSON.stringify({ route: new URL(url).pathname, method: request.method, body: request.body ? JSON.parse(request.body) : null }));
  };`);
  const run = (...args) => spawnSync(process.execPath, ['--import', loader, 'bin/dex.mjs', ...args, '--config', configFile], { encoding: 'utf8', timeout: 15000 });
  const list = run('strikes', 'list'); assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout), { route: '/seller-strikes', method: 'GET', body: null });
  const clear = run('strikes', 'clear', '--seller', seller.tracAddr, '--identity', seller.dexKey);
  assert.equal(clear.status, 0, clear.stderr);
  assert.deepEqual(JSON.parse(clear.stdout), { route: '/seller-strikes/clear', method: 'POST', body: seller });
  const buyerClear = run('strikes', 'clear', '--buyer', seller.tracAddr, '--identity', seller.dexKey);
  assert.equal(buyerClear.status, 0, buyerClear.stderr);
  assert.deepEqual(JSON.parse(buyerClear.stdout), { route: '/buyer-strikes/clear', method: 'POST', body: seller });
  assert.notEqual(run('strikes', 'clear', '--buyer', seller.tracAddr, '--seller', seller.tracAddr, '--identity', seller.dexKey).status, 0);
  for (const args of [['strikes', 'clear'], ['strikes', 'clear', '--seller', seller.tracAddr],
    ['strikes', 'clear', '--seller', seller.tracAddr, '--identity', 'invalid'], ['strikes', 'list', '--seller', seller.tracAddr]]) {
    assert.notEqual(run(...args).status, 0);
  }
  writeFileSync(configFile, JSON.stringify({ ...config, role: 'trader' }));
  const wrong = run('strikes', 'list'); assert.notEqual(wrong.status, 0); assert.match(wrong.stderr, /signer only/);
});

function request(handler, method, url, body, token = 'test-token') {
  return new Promise(resolve => {
    const req = new EventEmitter(); Object.assign(req, { method, url, headers: { authorization: `Bearer ${token}` } });
    let code;
    handler(req, { writeHead: c => { code = c; }, end: text => resolve({ code, body: JSON.parse(text) }) });
    if (body) req.emit('data', JSON.stringify(body)); req.emit('end');
  });
}

test('control requires authentication, validates clear arguments, and exposes no strike commands to other roles', async () => {
  const cleared = [];
  const handler = controlHandler({ token: 'test-token', role: {
    listSellerStrikes: () => ({ strikes: [], refusals: [] }),
    clearSellerStrikes: body => { cleared.push(validateSeller(body)); return { cleared: true }; },
  } });
  assert.equal((await request(handler, 'POST', '/seller-strikes/clear', seller, 'wrong')).code, 401);
  assert.deepEqual(cleared, []);
  assert.deepEqual(await request(handler, 'GET', '/seller-strikes'), { code: 200, body: { strikes: [], refusals: [] } });
  assert.equal((await request(handler, 'POST', '/seller-strikes/clear', { tracAddr: seller.tracAddr })).code, 400);
  assert.equal((await request(handler, 'POST', '/seller-strikes/clear', { ...seller, tracAddr: 'line\nbreak' })).code, 400);
  assert.equal((await request(handler, 'POST', '/seller-strikes/clear', seller)).code, 200);
  assert.deepEqual(cleared, [seller]);
  const trader = controlHandler({ token: 'test-token', role: {} });
  assert.equal((await request(trader, 'GET', '/seller-strikes')).code, 404);
  assert.equal((await request(trader, 'POST', '/seller-strikes/clear', seller)).code, 404);
});

test('signer run validates the strike switch before network, proof or key setup', t => {
  const dir = mkdtempSync(join(tmpdir(), 'strike-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'role.json');
  for (const strikes of [null, 'false', false, { enabled: 'false' }, { enabled: 1 }, { enable: true }]) {
    writeFileSync(configFile, JSON.stringify({ role: 'signer', strikes }));
    const result = spawnSync(process.execPath, ['bin/dex.mjs', '--config', configFile], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ZodError/);
    assert.doesNotMatch(result.stderr, /ENOENT|ECONNREFUSED|keyring|network profile/i);
  }
  writeFileSync(configFile, JSON.stringify({ role: 'trader', strikes: { enabled: false } }));
  const wrong = spawnSync(process.execPath, ['bin/dex.mjs', '--config', configFile], { encoding: 'utf8', timeout: 15000 });
  assert.notEqual(wrong.status, 0); assert.match(wrong.stderr, /signer-only/);
});
