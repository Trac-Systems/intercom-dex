import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { controlHandler } from '../../../src/roles/control.js';
import { RESET_PAUSED_MESSAGE } from '../../../src/market/gateway-status.js';

test('HTTP agent status and MCP book keep paused offers and their reason, and MCP propagates take/post refusals', async t => {
  const offerId = 'ab'.repeat(32), pair = 'RESET/USDC';
  const status = { pairs: [{ pair, status: 'paused', availability: 'paused', reason: RESET_PAUSED_MESSAGE }],
    offers: [{ offerId, pair, paused: true, reason: RESET_PAUSED_MESSAGE }], book: { [pair]: { levels: [] } }, tickers: {} };
  const refuse = () => { throw Error(RESET_PAUSED_MESSAGE); };
  const role = { status: () => status, takeOffer: refuse, makeOffer: refuse };
  const dir = mkdtempSync(join(tmpdir(), 'dex-gateway-mcp-')), tokenFile = join(dir, 'control.token'), token = 'synthetic-gateway-test-token';
  writeFileSync(tokenFile, token, { mode: 0o600 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const server = createServer(controlHandler({ role, token }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(url + '/status', { headers: { authorization: `Bearer ${token}` } })).json(), status);
  const client = new Client({ name: 'gateway-health-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../../src/mcp/server.mjs', import.meta.url))],
    env: { ...process.env, DEX_CONFIG: '', DEX_CONTROL_URL: url, DEX_CONTROL_TOKEN_FILE: tokenFile }, stderr: 'pipe' });
  t.after(() => client.close()); await client.connect(transport);
  const result = await client.callTool({ name: 'dex_book', arguments: { pair } });
  assert.equal(result.isError, undefined);
  const book = JSON.parse(result.content[0].text);
  assert.deepEqual(book.pair, status.pairs[0]); assert.deepEqual(book.offers, status.offers);
  for (const [name, args] of [['dex_take', { offerId, price: '1' }], ['dex_offer', { pair, side: 'sell', baseAmount: '100000000', price: '1' }]]) {
    const refused = await client.callTool({ name, arguments: args });
    assert.equal(refused.isError, true); assert.ok(refused.content[0].text.includes(RESET_PAUSED_MESSAGE));
  }
});
