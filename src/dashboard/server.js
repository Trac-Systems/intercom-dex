import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createModel } from './model.js';
import { createNextOffer } from './next-offer.js';
import { createActions, createConfirmations } from './actions.js';
import { TrafficLog } from './traffic.js';
import { decimalAmount } from './format.js';
import { priceUnits } from '../market/assets.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
export function readStatic(root = new URL('./static/', import.meta.url)) {
  const files = new Map();
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = new URL(encodeURIComponent(entry.name), dir), path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(new URL(file.href + '/'), path);
      else if (entry.isFile() && TYPES[extname(entry.name)]) files.set(path, { body: readFileSync(file), type: TYPES[extname(entry.name)] });
    }
  };
  walk(root, '');
  if (files.has('/index.html')) files.set('/', files.get('/index.html'));
  return files;
}
const HEADERS = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const MAX_BODY = 16384;
export const MARKET_CACHE_MS = 5000, MARKET_TIMEOUT_MS = 8000;
// Chart history comes from the public market feed; it is display data only, so it is not part of the network profile.
export const MARKET_FEED_URLS = Object.freeze({ mainnet: 'https://reset.much.fun' });
const INTERVALS = new Set('1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 2d 3d 1w 1mo 1y'.split(' '));
const MAX_TIME = Number.MAX_SAFE_INTEGER;
// Feed cursors are canonical base64url [pair, timestamp, id], bound to one pair.
function cursor(value, pair) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) return null;
  try {
    const row = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(row) || row.length !== 3 || row[0] !== pair || !Number.isSafeInteger(row[1]) || row[1] < 0 ||
        typeof row[2] !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(row[2]) || Buffer.from(JSON.stringify(row)).toString('base64url') !== value) return null;
    return { t: row[1], id: row[2] };
  } catch { return null; }
}
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
function query(url, allowed) {
  const out = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(out, key)) throw failure('Invalid query parameter');
    out[key] = value;
  }
  return out;
}
function integer(value, name, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!(min < 0 ? /^(0|-?[1-9][0-9]*)$(?![\s\S])/ : /^(0|[1-9][0-9]*)$(?![\s\S])/).test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw failure(`Invalid ${name}`);
  return Number(value);
}
function marketQuery(url, kind, model) {
  const q = query(url, kind === 'candles' ? ['pair', 'interval', 'limit', 'before'] : ['pair', 'limit', 'before']);
  const pair = model.pair(q.pair);
  if (kind === 'candles' && !INTERVALS.has(q.interval)) throw failure('Invalid interval');
  const limit = integer(q.limit, 'limit', kind === 'candles' ? 500 : 100, 1, kind === 'candles' ? 500 : 200);
  const params = { pair: pair.pair, ...(kind === 'candles' ? { interval: q.interval } : {}), limit: String(limit) };
  if (q.before !== undefined) {
    if (kind === 'candles') params.before = String(integer(q.before, 'before', undefined, -MAX_TIME, MAX_TIME));
    else { if (!cursor(q.before, pair.pair)) throw failure('Invalid before'); params.before = q.before; }
  }
  return { pair, params, limit };
}

function feedResponse(kind, value, { pair, params, limit }) {
  const check = ok => { if (!ok) throw new Error('Invalid market feed response'); };
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const time = t => Number.isSafeInteger(t) && t >= 0 && t <= MAX_TIME;
  const price = p => { check(typeof p === 'string' && p.length <= 44 && p === p.trim()); priceUnits(p); return p; };
  check(object(value));
  // The public market view: only each pair's 24-hour change is taken from it.
  if (kind === 'view') {
    check(Array.isArray(value.pairs) && value.pairs.length <= 64);
    return new Map(value.pairs.filter(row => object(row) && typeof row.pair === 'string' && typeof row.change24h === 'string' &&
      /^-?(0|[1-9][0-9]{0,15})(\.[0-9]{1,18})?$/.test(row.change24h)).map(row => [row.pair, row.change24h]));
  }
  if (kind === 'candles') {
    check(value.pair === pair.pair && value.interval === params.interval && Array.isArray(value.candles) && value.candles.length <= limit);
    let previous = -Infinity;
    const candles = value.candles.map(row => {
      check(object(row) && Number.isSafeInteger(row.t) && row.t > previous && (params.before === undefined || row.t < Number(params.before)));
      previous = row.t;
      const { t } = row, o = price(row.o), h = price(row.h), l = price(row.l), c = price(row.c);
      check(priceUnits(l) <= priceUnits(o) && priceUnits(l) <= priceUnits(c) && priceUnits(h) >= priceUnits(o) && priceUnits(h) >= priceUnits(c));
      return { t, o, h, l, c, v: decimalAmount(row.v, 'USDC') };
    });
    return { pair: pair.pair, interval: params.interval, candles };
  }
  check(Array.isArray(value.rows) && value.rows.length <= limit && (value.next === null || cursor(value.next, pair.pair)));
  let previous = params.before === undefined ? null : cursor(params.before, pair.pair);
  const ids = new Set();
  const rows = value.rows.map(row => {
    check(object(row) && typeof row.id === 'string' && /^[0-9a-f]{64}$(?![\s\S])/.test(row.id) && !ids.has(row.id) &&
      time(row.t) && (!previous || row.t < previous.t || row.t === previous.t && row.id < previous.id) && [null, 'buy', 'sell'].includes(row.side));
    previous = row; ids.add(row.id);
    const amount = decimalAmount(row.amount, pair.base.id), usdc = decimalAmount(row.usdc, 'USDC');
    check(BigInt(amount.units) > 0n && BigInt(usdc.units) > 0n);
    return { id: row.id, t: row.t, side: row.side, price: price(row.price), amount, usdc };
  });
  const next = value.next === null ? null : cursor(value.next, pair.pair);
  check(next === null || rows.length > 0 && next.t === rows.at(-1).t && next.id === rows.at(-1).id);
  return { rows, next: value.next };
}

// One cache per dashboard. Duplicate concurrent reads share a request; failed reads are never cached.
export function createMarketFeed({ url, clock = () => Date.now() }) {
  const cache = new Map(), pending = new Map();
  let active = 0;
  return async (kind, q) => {
    if (!url) throw failure('No market feed for this network');
    const search = String(new URLSearchParams(q.params)), key = search ? `${kind}?${search}` : kind, at = clock();
    for (const [k, v] of cache) if (v.until <= at) cache.delete(k);
    if (cache.has(key)) return cache.get(key).value;
    if (pending.has(key)) return pending.get(key);
    if (active >= 4) throw failure('Market feed is busy; try again shortly', 503);
    active++;
    const request = (async () => {
      const controller = new AbortController();
      let response, reader;
      const timeout = setTimeout(() => {
        controller.abort();
        reader?.cancel().catch(() => {});
      }, MARKET_TIMEOUT_MS);
      try {
        response = await fetch(new URL(`/v1/market/${key}`, url), { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } });
        if (!response.ok || !/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) throw new Error('bad response');
        let size = 0; const chunks = [];
        reader = response.body.getReader();
        for (;;) {
          const { done, value: chunk } = await reader.read();
          controller.signal.throwIfAborted();
          if (done) break;
          size += chunk.length;
          if (size > 2 * 1024 * 1024) throw new Error('response too large');
          chunks.push(chunk);
        }
        let value;
        try { value = feedResponse(kind, JSON.parse(Buffer.concat(chunks).toString('utf8')), q); }
        catch { throw failure('Invalid market feed response', 502); }
        if (cache.size >= 256) cache.delete(cache.keys().next().value);
        cache.set(key, { value, until: clock() + MARKET_CACHE_MS });
        return value;
      } catch (error) {
        if (error.status) throw error;
        throw failure(controller.signal.aborted ? 'Market feed timed out' : 'Market feed unavailable', controller.signal.aborted ? 504 : 502);
      } finally {
        clearTimeout(timeout);
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
        active--; pending.delete(key);
      }
    })();
    pending.set(key, request);
    return request;
  };
}

// Writes a fresh access token to a private 0600 file, replacing any earlier one atomically.
export function writeToken(dataDir) {
  const token = randomBytes(32).toString('hex'), file = join(dataDir, 'dashboard.token'), tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, token + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  return { token, file };
}

const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookies = header => Object.fromEntries(String(header ?? '').split(';').map(p => p.trim().split('=')).filter(p => p.length === 2));

// The request handler on its own, so tests can drive it without a socket. `port` is the bound port.
export function dashboardHandler({ token, port, model, actions, confirmations, traffic, marketFeed = createMarketFeed({}), staticFiles = readStatic(), log = () => {} }) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map(h => `http://${h}`));
  const cookie = `dexdash${port}`;
  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, { ...HEADERS, 'content-type': type, ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const routes = {
    'GET /api/state': async () => {
      const state = await model.state();
      if (state.trader?.pairs.length) {
        const changes = await marketFeed('view', { params: {} }).catch(() => null);
        for (const p of state.trader.pairs) p.change24h = changes?.get(p.pair) ?? null;
      }
      return state;
    },
    'GET /api/book': url => { const q = query(url, ['pair']); return model.book(q.pair); },
    'GET /api/list': url => {
      const q = query(url, ['name', 'offset', 'limit']);
      return model.list(q.name, integer(q.offset, 'offset', 0, 0, 1000000000), integer(q.limit, 'limit', 100, 1, 200));
    },
    'GET /api/candles': url => marketFeed('candles', marketQuery(url, 'candles', model)),
    'GET /api/trades': url => marketFeed('trades', marketQuery(url, 'trades', model)),
    'GET /api/traffic': url => {
      const q = Object.fromEntries(['channel', 'kind', 'trade', 'page'].map(k => [k, (url.searchParams.get(k) ?? '').slice(0, 100)]));
      const page = traffic.query(q), labels = model.labels();
      return { ...page, rows: page.rows.map(r => ({ ...r, label: labels[r.from] ?? null })) };
    },
    'POST /api/preview': async body => {
      if (!actions.names.includes(body.action)) throw new Error('Unknown action');
      const preview = await actions.preview(body.action, body.input);
      return { ...preview, action: body.action, confirm: confirmations.issue(body.action, preview.input) };
    },
    'POST /api/act': async body => {
      if (!actions.names.includes(body.action)) throw new Error('Unknown action');
      confirmations.consume(body.action, body.input, body.confirm);
      return { ok: true, result: await actions.run(body.action, body.input) };
    },
  };
  return (req, res) => {
    if (!hosts.has(req.headers.host)) return send(res, 421, { error: 'Wrong host' });
    let url, path;
    try {
      path = decodeURIComponent(req.url.split('?')[0]);
      if (!path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(p => p === '.' || p === '..')) throw new Error('Invalid path');
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch { return send(res, 400, { error: 'Invalid path' }); }
    const given = url.searchParams.get('t');
    if (req.method === 'GET' && url.pathname === '/' && given !== null) {
      if (!same(given, token)) return send(res, 401, { error: 'unauthorized' });
      return send(res, 303, '', 'text/plain', { location: '/', 'set-cookie': `${cookie}=${token}; Path=/; HttpOnly; SameSite=Strict` });
    }
    if (!same(cookies(req.headers.cookie)[cookie], token)) {
      return send(res, 401, 'Open the address printed when this role started (it contains the access token).', 'text/plain; charset=utf-8');
    }
    if (req.method === 'GET' && staticFiles.has(path)) return send(res, 200, staticFiles.get(path).body, staticFiles.get(path).type);
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: 'not found' });
    if (req.method === 'POST' && ((req.headers.origin !== undefined && !origins.has(req.headers.origin)) || !/^application\/json\b/.test(req.headers['content-type'] ?? ''))) {
      return send(res, 403, { error: 'forbidden' });
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > MAX_BODY) req.destroy(); });
    req.on('end', async () => {
      try {
        const value = await route(req.method === 'POST' ? JSON.parse(body || '{}') : url);
        send(res, 200, value);
      } catch (error) {
        if (req.method === 'GET') log('dashboard', url.pathname, error.message);
        send(res, error.status ?? 400, { error: error.message });
      }
    });
  };
}

// Starts the dashboard for the role in this process: 127.0.0.1 only, a new token per start (written to
// <dataDir>/dashboard.token and returned once as a URL). `traffic` is fed from the bridge's receive path.
export async function startDashboard({ config, role, wallets = null, bridge, traffic = new TrafficLog(), log = () => {} }) {
  const port = config.dashboard?.port;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('dashboard.port must be a port number');
  const nextOffer = config.role === 'trader' ? createNextOffer({ role, log }) : null;
  const model = createModel({ config, role, wallets, bridge, nextOffer });
  const actions = createActions({ config, role, wallets, balances: model.balances, nextOffer });
  const marketFeed = createMarketFeed({ url: MARKET_FEED_URLS[config.network] });
  const staticFiles = readStatic();
  bridge.on('traffic', (channel, message, bytes) => { traffic.record(channel, message, bytes); model.note(channel, message); });
  const { token, file } = writeToken(config.dataDir);
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const bound = server.address().port;
  server.on('request', dashboardHandler({ token, port: bound, model, actions, confirmations: createConfirmations(), traffic, marketFeed, staticFiles, log }));
  return { url: `http://127.0.0.1:${bound}/?t=${token}`, port: bound, address: server.address().address, tokenFile: file, close: () => new Promise(r => server.close(r)) };
}
