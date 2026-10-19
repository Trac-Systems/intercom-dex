// Role objects with realistic in-memory state for the dashboard read model, actions and page rendering.
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard } from '../../../src/dashboard/server.js';
import { Keypair } from '@solana/web3.js';
import { fixture, hex, tracAddress } from '../core/helpers.mjs';
import { encodeKey } from '../../../src/core/keys.js';
import { accountBalances } from '../../../src/wallets/accounting.js';
import { offerIdOf } from '../../../src/roles/common.js';

export const SECRETS = { entropy: 'e1'.repeat(32), nonce: 'a7'.repeat(32), secretHex: '5e'.repeat(32), share: '4f'.repeat(32) };
export const nowSec = () => Math.floor(Date.now() / 1000);

export function memoryStore(records = {}) {
  const map = new Map(Object.entries(records));
  return { get: k => map.get(k) ?? null, put: (k, v) => map.set(k, structuredClone(v)), delete: k => map.delete(k), list: (p = '') => [...map.keys()].filter(k => k.startsWith(p)), map };
}

export class FakeBridge extends EventEmitter {
  constructor() { super(); this.ws = { readyState: 1 }; this.readers = { dex_msb_info: true, dex_reset_context: true }; this.calls = []; }
  async stats() { return { channels: ['intercom-dex', 'intercom-dex:offers', 'intercom-dex:signers', 'intercom-dex:t:' + 'ab'.repeat(32)], connectionCount: 6 }; }
  async call(type) { this.calls.push(type); if (!this.readers[type]) throw new Error('reader down'); return {}; }
}

const tradeState = (f, { role, phase, now, peer, ...extra }) => {
  const terms = { ...f.terms, baseAmount: '1500000000000000000', quoteAmount: '630000', sendBy: now + 600, refundAfter: now + 86400, ...(extra.terms ?? {}) };
  return { role, mode: 'taker', offerId: terms.offerId, draft: terms, terms, tradeId: hex(), phase, now, peer, self: hex(), acks: [], shares: [], locked: false,
    entropy: SECRETS.entropy, nonce: SECRETS.nonce, privateState: { secretHex: SECRETS.secretHex, coefficients: [SECRETS.share] }, ...extra, };
};

export function walletInfo({ role = 'trader', balances, payout = {}, trac = true, withdrawals = [], offers = [], trades = [], registry } = {}) {
  const addresses = { solana: Keypair.generate().publicKey.toBase58(), trac: trac ? tracAddress(hex()) : null };
  return { addresses, payout, withdrawals,
    balances: accountBalances({ balances, offers, trades, registry: () => registry, trader: role === 'trader' }),
    minimumFees: { SOL: '10000000', TNK: '60000000000000000', units: 'base units' },
    storage: { dataDir: '/example/dex/data', keyringFile: '/example/dex/data/keyring.json', tracWalletFile: trac ? '/example/dex/data/trac-wallet.json' : null,
      passwordEnv: 'DEX_KEY_PASSWORD', tracPasswordEnv: trac ? 'DEX_KEY_PASSWORD' : null, encryption: 'scrypt-131072-8-1 and XChaCha20-Poly1305' },
    backup: { instruction: 'Back up the encrypted data folder; keep its password separately.', exportCommand: "node '/opt/dex/bin/dex.mjs' export --config '/example/dex/role.json' --out '/example/dex/data/wallet-export'",
      exportInstruction: 'Run this once in your own terminal.' } };
}

export function fakeWallets(info) {
  return { calls: [], info: async () => info,
    async withdraw(input) { this.calls.push(input); return { id: hex(), asset: input.asset, amount: '1250000', to: input.to, status: 'confirmed', signature: '5'.repeat(88) }; } };
}

export function traderFixture({ now = nowSec() } = {}) {
  const f = fixture(), me = { dexKey: encodeKey(f.buyer.publicKey), tracAddr: f.terms.buyer.tracAddr, solAddr: f.terms.buyer.solPayer };
  const other = encodeKey(f.seller.publicKey), maker = { dexKey: other, tracAddr: f.terms.seller.tracAddr, solAddr: f.terms.seller.solRecipient };
  const offer = (side, baseAmount, price, by = maker, expiresAt = now + 3000) => {
    const o = { registryVersion: 1, software: '0.1.0', pair: 'TNK/USDC', side, baseAmount, price, maker: by, peerKey: hex(), expiresAt };
    return { ...o, offerId: offerIdOf(o) };
  };
  const theirs = [offer('sell', '5000000000000000000', '0.42'), offer('sell', '2000000000000000000', '0.45'), offer('buy', '8000000000000000000', '0.39')];
  const mine = offer('sell', '10000000000000000000', '0.44', me);
  const expired = offer('buy', '4000000000000000000', '0.30', me, now - 3600);
  const trades = new Map([
    ['t-locked', { key: 't-locked', role: 'buyer', state: tradeState(f, { role: 'buyer', phase: 'locked', now: now - 120, peer: other, locked: true, acks: [hex(), hex(), hex()] }) }],
    ['t-acks', { key: 't-acks', role: 'buyer', state: tradeState(f, { role: 'buyer', phase: 'awaitAcks', now: now - 20, peer: other, acks: [hex()] }) }],
    ['t-sell', { key: 't-sell', role: 'seller', state: { ...tradeState(f, { role: 'seller', phase: 'awaitShares', now: now - 300, peer: other, shares: [{}] }), mode: 'maker', offerId: mine.offerId } }],
    ['t-done', { key: 't-done', role: 'buyer', state: tradeState(f, { role: 'buyer', phase: 'complete', now: now - 7200, peer: other, locked: true }) }],
    ['t-off', { key: 't-off', role: 'seller', state: tradeState(f, { role: 'seller', phase: 'aborted', reason: 'Timed out: deal', now: now - 600, peer: other }) }],
  ]);
  const store = memoryStore({ [`offer-${mine.offerId}`]: { offer: mine, cancelled: false }, [`offer-${expired.offerId}`]: { offer: expired, cancelled: false } });
  const calls = [];
  const role = {
    me, identity: { publicKey: me.dexKey }, serviceKey: encodeKey(f.service.publicKey), store,
    offers: new Map([...theirs, mine].map(o => [o.offerId, { offer: o, from: o.maker.dexKey }])), mine: new Map([[mine.offerId, mine]]),
    host: { trades }, registry: { usable: f.registry, current: f.registry, conflict: null, snapshot: () => f.registry },
    book: new Map([['TNK/USDC', { pair: 'TNK/USDC', registryVersion: 1, seq: 4, ts: now - 3, levels: [
      { side: 'sell', price: '0.42', baseAmount: '5000000000000000000', offers: 1 }, { side: 'sell', price: '0.44', baseAmount: '10000000000000000000', offers: 1 },
      { side: 'sell', price: '0.45', baseAmount: '2000000000000000000', offers: 1 }, { side: 'buy', price: '0.39', baseAmount: '8000000000000000000', offers: 1 }] }]]),
    tickers: new Map([['TNK/USDC', { pair: 'TNK/USDC', last: '0.41', volume24h: '123450000', ts: now }]]),
    status() {
      return { software: '0.1.0', updateRequired: false, registryConflict: null, registryVersion: 1, signersOnline: f.registry.signers.slice(0, 4).map(s => s.dexKey),
        mine: [...this.mine.values()].map(o => ({ ...o, available: '9000000000000000000', reserved: '1000000000000000000', filled: '0' })) };
    },
    calls,
    async makeOffer(input) { calls.push(['offer', input]); return input; },
    async takeOffer(...args) { calls.push(['take', args]); return { key: 'k' }; },
    async cancelOffer(offerId) { calls.push(['cancel', offerId]); return { offerId, cancelled: true }; },
  };
  const info = walletInfo({ balances: { USDC: '25000000', SOL: '4000000', TNK: '12000000000000000000', RESET: '350000000', feeTnk: '30000000000000000' },
    offers: [mine], trades: [...trades.values()], registry: f.registry });
  const config = { role: 'trader', network: 'local', dataDir: '/tmp', proof: { zkey: '/nonexistent/lockkey.zkey' }, payout: {} };
  return { f, role, config, info, wallets: fakeWallets(info), bridge: new FakeBridge(), theirs, mine, expired, now };
}

export function signerFixture({ now = nowSec() } = {}) {
  const f = fixture(), me = f.registry.signers[0], trades = new Map();
  const add = (phase, extra = {}) => {
    const key = `sign-${trades.size}`;
    trades.set(key, { key, role: 'signer', state: { role: 'signer', phase, terms: { ...f.terms, baseAmount: '1500000000000000000', sendBy: now + 400, refundAfter: now + 86400, ...extra.terms }, tradeId: hex(), signerIndex: 1,
      share: SECRETS.share, now: extra.now ?? now - 60, reason: extra.reason } });
  };
  add('holding'); add('holding', { terms: { sendBy: now + 100 } }); add('verifyingTransfer');
  add('published', { now: now - 3600 }); add('published', { terms: { refundAfter: now - 8 * 86400 }, now: now - 9 * 86400 }); add('expired', { now: now - 7200 });
  const role = { identity: { publicKey: me.dexKey }, serviceKey: encodeKey(f.service.publicKey), host: { trades }, lastHeartbeatAt: now - 12,
    registry: { usable: f.registry, current: f.registry, conflict: null }, status: () => ({ updateRequired: false }) };
  return { f, role, config: { role: 'signer', network: 'local', dataDir: '/tmp', serviceKey: role.serviceKey }, bridge: new FakeBridge(), now };
}

export function serviceFixture({ now = nowSec() } = {}) {
  const f = fixture(), [a, b, c] = f.registry.signers, settlements = new Map(), calls = [];
  const logged = (ts, credits, extra = {}) => {
    const tradeId = hex();
    settlements.set(tradeId, { tradeId, status: 'logged', loggedAt: ts, reportedAt: ts, creditsFinal: extra.final ?? false, credits, paid: extra.paid,
      entry: { tradeId, pair: 'TNK/USDC', ts, baseAmount: '1000000000000000000', quoteAmount: '5000000', escrowAddress: hex() },
      report: { terms: { ...f.terms, quoteAmount: '5000000' } } });
    return tradeId;
  };
  const old = now - 10 * 86400;
  const owedA = [logged(old, { [a.dexKey]: '4166', [b.dexKey]: '4166' }, { final: true }), logged(old, { [a.dexKey]: '4166' }, { final: true, paid: {} })];
  logged(old, { [b.dexKey]: '4166' }, { final: true, paid: { [b.dexKey]: true } });
  logged(now - 60, { [a.dexKey]: '4166', [c.dexKey]: '4166' });
  settlements.set('p1', { tradeId: 'p1', status: 'pending', reportedAt: now - 900, report: { terms: f.terms } });
  const role = {
    identity: { publicKey: encodeKey(f.service.publicKey) }, registry: f.registry, settlements, registryPublishedAt: now - 15, calls,
    get payouts() {
      const out = {};
      for (const r of settlements.values()) if (r.status === 'logged' && r.credits) for (const [k, amount] of Object.entries(r.credits)) {
        (out[k] ??= []).push({ tradeId: r.tradeId, amount, final: r.creditsFinal, payableAfter: r.loggedAt + 7 * 86400, paid: r.paid?.[k] ?? false, forfeited: false });
      }
      return out;
    },
    status() { return { signersOnline: [a.dexKey, b.dexKey], book: { 'TNK/USDC': 3, 'RESET/USDC': 1 } }; },
    async markPaid(dexKey, tradeIds) { calls.push(['markPaid', dexKey, tradeIds]); return { dexKey, trades: tradeIds.length, amount: '8332' }; },
  };
  const info = walletInfo({ role: 'service', trac: false, payout: { solana: Keypair.generate().publicKey.toBase58() },
    balances: { USDC: '91000000', SOL: '50000000', TNK: '0', RESET: '0' }, registry: f.registry });
  const config = { role: 'service', network: 'local', dataDir: '/tmp', payout: info.payout };
  return { f, role, config, info, wallets: fakeWallets(info), bridge: new FakeBridge(), owedA, now };
}

// A running dashboard for a fixture on an ephemeral 127.0.0.1 port, closed after the test.
export async function startFor(t, fx) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-'));
  const dash = await startDashboard({ config: { ...fx.config, dataDir: dir, dashboard: { port: 0 } }, role: fx.role, wallets: fx.wallets ?? null, bridge: fx.bridge });
  t.after(() => dash.close());
  const token = new URL(dash.url).searchParams.get('t');
  return { dir, dash, token, port: dash.port, cookie: `dexdash${dash.port}=${token}` };
}

export function httpCall(port, { path = '/', method = 'GET', host = `127.0.0.1:${port}`, cookie, origin, body, type = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(body !== undefined ? { 'content-type': type } : {}) };
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}
