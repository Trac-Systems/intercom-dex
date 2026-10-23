import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLocksRoutes, locksControlHandler, dashboardHandler } from '../../../src/dashboard/server.js';
import { createLockActions, createConfirmations } from '../../../src/dashboard/actions.js';
import { createLocksModel } from '../../../src/dashboard/model.js';
import { fixture } from '../locks-products/helpers.mjs';

function invoke(handler, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise(resolve => {
    const req = new EventEmitter(); Object.assign(req, { method, url: path, headers, destroy() {} });
    let status, responseHeaders;
    const res = { writeHead(code, h) { status = code; responseHeaders = h; }, end(data) {
      let value; try { value = JSON.parse(data); } catch { value = data; }
      resolve({ status, headers: responseHeaders, value });
    } };
    handler(req, res);
    if (body) req.emit('data', JSON.stringify(body)); req.emit('end');
  });
}
function model() {
  const calls = [], f = fixture(), client = f.client;
  client.take = async id => { calls.push(id); return { positionId: id }; };
  client.preview = input => ({ now: 'Review this position.', ifMissed: 'It expires.', ...input });
  return { client, calls, model: createLocksModel(client), actions: createLockActions(client) };
}

test('locks routes validate pages, filters, duplicate parameters and unknown actions without effects', async () => {
  const f = model(), routes = createLocksRoutes(f);
  assert.equal((await routes['GET /api/locks'](new URL('http://127.0.0.1/api/locks?page=0'))).page, 0);
  for (const query of ['page=1&page=2', 'page=-1', 'unknown=1', 'minTerm=x', 'product=other']) {
    assert.equal((await routes['GET /api/locks'](new URL('http://127.0.0.1/api/locks?' + query))).reason, 'invalid_input');
  }
  assert.equal((await routes['POST /api/locks/act']({ action: 'withdraw', input: {} })).reason, 'invalid_input');
  assert.equal((await routes['POST /api/locks/settings']({ autoSweep: false })).reason, 'settings_invalid');
  assert.equal(f.calls.length, 0);
});

test('dashboard lock actions require exact one-use preview confirmation and existing auth', async () => {
  const f = model(), confirmations = createConfirmations(), token = 'a'.repeat(64), port = 1234;
  const handler = dashboardHandler({ token, port, model: { locks: f.model }, actions: { locks: f.actions }, confirmations, staticFiles: new Map() });
  const headers = { host: `127.0.0.1:${port}`, cookie: `dexdash${port}=${token}`, 'content-type': 'application/json' };
  assert.equal((await invoke(handler, '/api/locks', { headers: { host: headers.host } })).status, 401);
  const input = { positionId: 'a'.repeat(64) };
  const preview = await invoke(handler, '/api/locks/preview', { method: 'POST', headers, body: { action: 'take', input } });
  assert.equal(preview.status, 200); assert.ok(preview.value.confirm);
  const mismatch = await invoke(handler, '/api/locks/act', { method: 'POST', headers, body: { action: 'take', input: { positionId: 'b'.repeat(64) }, confirm: preview.value.confirm } });
  assert.equal(mismatch.value.ok, false); assert.equal(f.calls.length, 0);
  const body = { action: 'take', input, confirm: preview.value.confirm };
  assert.equal((await invoke(handler, '/api/locks/act', { method: 'POST', headers, body })).value.ok, true);
  assert.equal((await invoke(handler, '/api/locks/act', { method: 'POST', headers, body })).value.ok, false);
  assert.equal(f.calls.length, 1);
  assert.equal((await invoke(handler, '/api/locks/act', { method: 'POST', headers: { ...headers, origin: 'https://bad.example' }, body })).status, 403);
});

test('control wrapper checks bearer auth and delegates spot routes unchanged', async () => {
  const f = model(), handler = locksControlHandler({ token: 'secret', client: f.client,
    fallback: (_req, res) => { res.writeHead(202); res.end('spot'); } });
  assert.equal((await invoke(handler, '/api/locks')).status, 401);
  assert.equal((await invoke(handler, '/api/locks', { headers: { authorization: 'Bearer secret' } })).value.page, 0);
  assert.equal((await invoke(handler, '/status')).value, 'spot');
  const disabled = locksControlHandler({ token: 'secret', client: null });
  assert.equal((await invoke(disabled, '/api/locks', { headers: { authorization: 'Bearer secret' } })).value.reason, 'locks_disabled');
});

test('flat dashboard forms normalize exact TNK amounts, fees, settings and card rows', async () => {
  const f = fixture(); f.client.counted = 100;
  f.reg.assets = { RESET: 'open', TNK: 'open' };
  f.reg.limits.TNK = { min: '1', max: '9000000000000000000000' }; f.reg.limits.totalLocked.TNK = '9000000000000000000000';
  f.reg.fee = { ...f.reg.fee, loanBps: 50, optionBps: 1000, optionMin: '50000' };
  const actions = createLockActions(f.client), routes = createLocksRoutes({ model: createLocksModel(f.client), actions });
  const input = { action: 'post', product: 'loan', asset: 'TNK', principal: '100', collateral: '2000.000000000000000001', fee: '3', repay: '103', termBlocks: 144 };
  const preview = await routes['POST /api/locks/preview'](input);
  assert.equal(preview.input.terms.collateral, '2000000000000000000001');
  assert.equal(preview.amounts.makerReceives, '99500000');
  assert.match(preview.sentence, /99.5 USDC/); assert.match(preview.sentence, /0.5 USDC/); assert.match(preview.sentence, /TNK/);
  assert.equal((await routes['POST /api/locks/settings']({ autoRepayBlocks: 12 })).autoRepayBlocks, 12);
  assert.equal(f.client.settings.repayBlocksBefore, 12);
  f.client.status = () => [{ positionId: 'a'.repeat(64), product: 'loan', asset: 'TNK', role: 'maker', state: 'running', nextAction: 'repay',
    terms: preview.input.terms, amounts: preview.amounts, now: 'Pay back.', ifMissed: 'The lender keeps your TNK.' }];
  const mine = await routes['GET /api/locks/mine'](new URL('http://127.0.0.1/api/locks/mine?asset=TNK'));
  assert.equal(mine.rows[0].collateral.units, '2000000000000000000001'); assert.equal(mine.rows[0].collateral.unit, 'TNK');
  assert.equal(mine.rows[0].openingTotal.units, '100000000'); assert.equal(mine.rows[0].makerReceives.units, '99500000');
  assert.equal(mine.rows[0].needsAction, true); assert.equal(mine.counted, 100);
  const status = f.client.status;
  f.client.status = () => status().map(row => ({ ...row, paid: true }));
  assert.equal((await routes['GET /api/locks/mine'](new URL('http://127.0.0.1/api/locks/mine?asset=TNK'))).rows[0].needsAction, false, 'a paid loan only waits for its release');
  f.client.status = status;
  assert.equal((await routes['GET /api/locks/mine'](new URL('http://127.0.0.1/api/locks/mine?asset=RESET'))).rows.length, 0);
  f.client.setSettings({ autoRepay: false });
  const events = await routes['GET /api/locks/events'](new URL('http://127.0.0.1/api/locks/events'));
  assert.equal(typeof events.rows.at(-1).text, 'string'); assert.equal(events.rows.at(-1).at, f.time.now * 1000);
});

test('stock control router composes authenticated locks only for configured traders', async () => {
  const { controlHandler } = await import('../../../src/roles/control.js');
  const f = model(), role = { locks: f.client, status: () => ({ role: 'trader', spot: true }) };
  const configured = controlHandler({ token: 'secret', role });
  assert.equal((await invoke(configured, '/api/locks/mine')).status, 401);
  assert.ok(Array.isArray((await invoke(configured, '/api/locks/mine', { headers: { authorization: 'Bearer secret' } })).value.rows));
  assert.equal((await invoke(configured, '/status', { headers: { authorization: 'Bearer secret' } })).value.spot, true);
  delete role.locks;
  const plain = controlHandler({ token: 'secret', role });
  assert.equal((await invoke(plain, '/api/locks/mine', { headers: { authorization: 'Bearer secret' } })).status, 404);
  assert.equal((await invoke(plain, '/status', { headers: { authorization: 'Bearer secret' } })).value.spot, true);
});
