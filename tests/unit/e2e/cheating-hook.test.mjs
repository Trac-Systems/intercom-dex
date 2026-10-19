import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TradeHost } from '../../../src/roles/host.js';
import { Bridge } from '../../../src/net/bridge.js';

test('fee rotation gates signed terms with the prepared certificate intact and refuses an empty pool', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dex-fee-gate-')), file = join(dir, 'attack.json');
  const saved = { deliver: TradeHost.prototype.deliver, add: TradeHost.prototype.addTrade, send: Bridge.prototype.send,
    attackFile: process.env.DEX_E2E_ATTACK_FILE };
  t.after(() => {
    TradeHost.prototype.deliver = saved.deliver; TradeHost.prototype.addTrade = saved.add; Bridge.prototype.send = saved.send;
    if (saved.attackFile === undefined) delete process.env.DEX_E2E_ATTACK_FILE; else process.env.DEX_E2E_ATTACK_FILE = saved.attackFile;
    rmSync(dir, { recursive: true });
  });
  const delivered = [], markers = [];
  TradeHost.prototype.deliver = function(key, event) { delivered.push({ key, event }); return Promise.resolve(); };
  t.mock.method(console, 'log', line => markers.push(line));
  process.env.DEX_E2E_ATTACK_FILE = file;
  const selected = { kind: 'fee-change', buyerKey: 'buyer', release: false };
  const select = value => writeFileSync(file, JSON.stringify(value));
  select(selected);
  await import('../../e2e/cheating-hook.mjs');
  const state = { self: 'buyer', phase: 'awaitCertificate', tradeId: 'trade', terms: { committee: [{ dexKey: 'signer' }], fees: { tradeFeeBps: 50 } } };
  const host = { trades: new Map([['trade', { state }]]) };
  const certificate = { H: 'cached-certificate' }, event = { type: 'certificateAssigned', certificate };
  const pending = TradeHost.prototype.deliver.call(host, 'trade', event);
  try {
    assert.equal(delivered.length, 0, 'hold before dealing or lock can start');
    assert.ok(markers[0].startsWith('DEX_E2E_FEE_TERMS_SIGNED '));
    assert.equal(JSON.parse(markers[0].split(' ').slice(1).join(' ')).fees.tradeFeeBps, 50);
  } finally { select({ ...selected, release: true }); await pending; }
  assert.equal(delivered[0].event, event);
  assert.equal(delivered[0].event.certificate, certificate, 'do not force a second proof inside the lock deadline');
  select(selected);
  assert.throws(() => TradeHost.prototype.deliver.call(host, 'trade', { ...event, certificate: null }), /ready certificate/);
  assert.equal(delivered.length, 1);
  select({ ...selected, kind: 'cheating-dealer' });
  await TradeHost.prototype.deliver.call(host, 'trade', event);
  assert.equal(delivered[1].event.certificate, null, 'the malicious dealer scenario still forces its own dealing');
});
