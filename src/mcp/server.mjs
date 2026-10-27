#!/usr/bin/env node
// MCP tools for a running trader (stdio). It talks only to the trader's local control API:
// DEX_CONTROL_URL (e.g. http://127.0.0.1:47201) and DEX_CONTROL_TOKEN_FILE.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { readPrivateFile } from '../roles/keyring.js';
import { ensureTrader } from '../lifecycle/manager.js';
import { registerWalletTools } from './wallet-tools.js';
import { registerChatTools } from './chat-tools.js';
import { registerLocksTools } from './locks-tools.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SOFTWARE } from '../core/software.js';
import { pairSchema } from '../core/schemas.js';

let config;
if (process.env.DEX_CONFIG) {
  if (!isAbsolute(process.env.DEX_CONFIG)) throw new Error('DEX_CONFIG must be absolute');
  config = JSON.parse(readFileSync(process.env.DEX_CONFIG, 'utf8'));
  await ensureTrader(process.env.DEX_CONFIG, { peerConfig: process.env.DEX_PEER_CONFIG });
}
const url = config ? `http://127.0.0.1:${config.control.port}` : process.env.DEX_CONTROL_URL;
if (new URL(url).hostname !== '127.0.0.1' || new URL(url).protocol !== 'http:') throw new Error('MCP requires the local control API');
const token = readPrivateFile(config?.control.tokenFile ?? process.env.DEX_CONTROL_TOKEN_FILE, 256).trim();
async function call(method, path, body) {
  const res = await fetch(url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error ?? `HTTP ${res.status}`);
  return value;
}
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const pair = pairSchema.describe('An open pair from dex_status.pairs');
const units = z.string().regex(/^[1-9][0-9]*$/).describe('Integer base units: TNK 18 decimals, RESET 8 decimals');

const server = new McpServer({ name: 'intercom-dex', version: SOFTWARE });
registerWalletTools(server, call);
registerChatTools(server, call);
registerLocksTools(server, call);
server.registerTool('dex_status', { description: 'This trader: addresses, own offers, trades, registry pairs and update required status' },
  async () => text(await call('GET', '/status')));
server.registerTool('dex_book', { description: 'Reconstructed best 50 price levels per side, 24 h ticker, and fresh other-maker offers with venue remaining sizes for a pair', inputSchema: { pair } },
  async ({ pair: p }) => { const s = await call('GET', '/status'); return text({ pair: s.pairs.find(pair => pair.pair === p) ?? null,
    book: s.book[p] ?? null, ticker: s.tickers[p] ?? null, offers: s.offers.filter(o => o.pair === p) }); });
server.registerTool('dex_offer', { description: 'Post an offer. side sell = sell the base asset for USDC; price = USDC per whole base token',
  inputSchema: { pair, side: z.enum(['buy', 'sell']), baseAmount: units, price: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/), ttlSec: z.number().int().min(60).max(86400).optional() } },
  async args => text(await call('POST', '/offer', args)));
server.registerTool('dex_cancel', { description: 'Cancel an own offer', inputSchema: { offerId: z.string().regex(/^[0-9a-f]{64}$/) } },
  async args => text(await call('POST', '/cancel', args)));
server.registerTool('dex_take', { description: 'Take an offer (all of it, or baseAmount units of it) at its maker-signed price in dex_book offers. The take is refused if the offer does not have exactly that price. The trade then runs by itself.',
  inputSchema: { offerId: z.string().regex(/^[0-9a-f]{64}$/), price: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/), baseAmount: units.optional() } },
  async args => text(await call('POST', '/take', args)));
await server.connect(new StdioServerTransport());
