import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Trader } from '../../../src/roles/trader.js';
import { controlHandler } from '../../../src/roles/control.js';
import { outcome } from '../../../src/dashboard/model.js';
import { encodeKey, generateIdentity } from '../../../src/core/keys.js';
import { seal } from '../../../src/core/envelope.js';
import { simulation } from '../core/simulation.mjs';
import { hex } from '../core/helpers.mjs';

test('authenticated refusal reaches dashboard, control/MCP status and CLI log; a forged one has no effect', async t => {
  const sim = simulation({ holdSellerFunds: true }), node = sim.nodes.get('buyer'), state = structuredClone(node.state);
  const bridge = new EventEmitter(), records = new Map(), logs = [];
  bridge.join = bridge.leave = bridge.send = async () => {};
  const role = new Trader({ bridge, store: { put: (k, v) => records.set(k, structuredClone(v)), get: k => records.get(k),
    list: p => [...records.keys()].filter(k => k.startsWith(p)) }, identity: { publicKey: encodeKey(node.identity.publicKey), secretKey: node.identity.secretKey },
    me: { dexKey: state.self, tracAddr: state.terms.buyer.tracAddr, solAddr: state.terms.buyer.solPayer },
    mint: state.terms.mint, platformCollector: state.terms.fees.platformCollector, proof: { zkey: '/unused-test.zkey', pool: 0 },
    serviceKey: hex(), log: (...args) => logs.push(args.join(' ')) });
  role.host.now = () => state.now; role.host.tickMs = 1000000;
  await role.host.start(); t.after(() => role.host.stop());
  await role.host.addTrade({ key: 'refused-trade', role: 'buyer', state, lifetimeSec: 90000 });
  const trade = role.host.trades.get('refused-trade'), ch = 'intercom-dex:t:' + state.tradeId;
  const send = async secret => {
    bridge.emit('message', ch, seal({ kind: 'refused', ch, body: { tradeId: state.tradeId, reason: 'seller-funds' } }, secret,
      { ts: state.now, nonce: hex() }));
    for (let i = 0; i < 5; i++) { await new Promise(r => setImmediate(r)); await trade.queue; }
  };
  await send(generateIdentity().secretKey); assert.equal(trade.state.phase, 'awaitAcks');
  await send(sim.nodes.get('signer1').identity.secretKey);
  const reason = 'The seller cannot deliver this trade right now';
  assert.equal(trade.state.phase, 'aborted'); assert.equal(trade.state.reason, reason);
  assert.ok(outcome(trade).text.includes(reason)); assert.ok(logs.some(line => line.includes('abort buyer') && line.includes(reason)));
  assert.equal(role.status().trades[0].reason, reason);

  const dir = mkdtempSync(join(tmpdir(), 'dex-refusal-interface-')), tokenFile = join(dir, 'control.token');
  writeFileSync(tokenFile, 'synthetic-refusal-test-token', { mode: 0o600 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const server = createServer(controlHandler({ role, token: 'synthetic-refusal-test-token' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../../src/mcp/server.mjs', import.meta.url))],
    env: { ...process.env, DEX_CONFIG: '', DEX_CONTROL_URL: `http://127.0.0.1:${server.address().port}`, DEX_CONTROL_TOKEN_FILE: tokenFile }, stderr: 'pipe' });
  const client = new Client({ name: 'refusal-test', version: '1.0.0' });
  t.after(() => client.close()); await client.connect(transport);
  const result = await client.callTool({ name: 'dex_status', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).trades[0].reason, reason);
});
