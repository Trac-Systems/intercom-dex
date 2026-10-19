import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hiddenInput } from '../../../src/wallets/input.js';
import { controlCall } from '../../../src/wallets/control.js';

function terminal() {
  const input = new EventEmitter(), modes = [], output = [];
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode: value => modes.push(value), resume() {}, pause() {} });
  return { input, modes, output, settings: { input, output: { isTTY: true, write: s => output.push(s) } } };
}

test('hidden terminal input never echoes and restores terminal mode on success, cancel and errors', async () => {
  const t = terminal(), pending = hiddenInput('Password: ', t.settings);
  t.input.emit('data', Buffer.from('synx\u007fthetic\r'));
  assert.ok(await pending === 'synthetic'); assert.deepEqual(t.modes, [true, false]); assert.deepEqual(t.output, ['Password: ', '\n']);
  for (const event of ['cancel', 'end', 'error']) {
    const t = terminal(), p = hiddenInput('Secret: ', t.settings);
    if (event === 'cancel') t.input.emit('data', Buffer.from('\u0003'));
    else if (event === 'error') t.input.emit('error', Error('test'));
    else t.input.emit('end');
    await assert.rejects(p); assert.deepEqual(t.modes, [true, false]); assert.equal(t.input.listenerCount('data'), 0);
  }
  await assert.rejects(hiddenInput('Password: ', { input: { isTTY: false }, output: { isTTY: true } }), /terminal/);
});

test('CLI control uses loopback, private bearer token and exact shared wallet routes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'control-')), tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, 'test-control-token', { mode: 0o600 });
  const config = { control: { port: 12345, tokenFile } };
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(new URL(url).hostname, '127.0.0.1'); assert.equal(request.headers.authorization, 'Bearer test-control-token');
    if (request.method === 'POST') assert.deepEqual(JSON.parse(request.body), { asset: 'SOL', amount: 'all' });
    return new Response(JSON.stringify(fail ? { error: 'refused' } : { ok: true }), { status: fail ? 400 : 200 });
  });
  assert.deepEqual(await controlCall(config, 'GET', '/wallets'), { ok: true });
  assert.deepEqual(await controlCall(config, 'POST', '/withdraw', { asset: 'SOL', amount: 'all' }), { ok: true });
  fail = true; await assert.rejects(controlCall(config, 'GET', '/wallets'), /refused/);
  await assert.rejects(controlCall({}, 'GET', '/wallets'), /control port/);
});
