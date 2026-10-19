import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createModel } from './model.js';
import { createActions, createConfirmations } from './actions.js';
import { TrafficLog } from './traffic.js';

const STATIC = Object.fromEntries([['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css']]
  .map(([path, file, type]) => [path, { body: readFileSync(new URL(`./static/${file}`, import.meta.url)), type: `${type}; charset=utf-8` }]));
const HEADERS = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const MAX_BODY = 16384;

// Writes a fresh access token to a private 0600 file, replacing any earlier one atomically.
export function writeToken(dataDir) {
  const token = randomBytes(32).toString('hex'), file = join(dataDir, 'dashboard.token'), tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, token + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  return { token, file };
}

const same = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookies = header => Object.fromEntries(String(header ?? '').split(';').map(p => p.trim().split('=')).filter(p => p.length === 2));

// The request handler on its own, so tests can drive it without a socket. `port` is the bound port.
export function dashboardHandler({ token, port, model, actions, confirmations, traffic, log = () => {} }) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map(h => `http://${h}`));
  const cookie = `dexdash${port}`;
  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, { ...HEADERS, 'content-type': type, ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const routes = {
    'GET /api/state': () => model.state(),
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
    const url = new URL(req.url, `http://${req.headers.host}`);
    const given = url.searchParams.get('t');
    if (req.method === 'GET' && url.pathname === '/' && given !== null) {
      if (!same(given, token)) return send(res, 401, { error: 'unauthorized' });
      return send(res, 303, '', 'text/plain', { location: '/', 'set-cookie': `${cookie}=${token}; Path=/; HttpOnly; SameSite=Strict` });
    }
    if (!same(cookies(req.headers.cookie)[cookie], token)) {
      return send(res, 401, 'Open the address printed when this role started (it contains the access token).', 'text/plain; charset=utf-8');
    }
    if (req.method === 'GET' && STATIC[url.pathname]) return send(res, 200, STATIC[url.pathname].body, STATIC[url.pathname].type);
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
        send(res, 400, { error: error.message });
      }
    });
  };
}

// Starts the dashboard for the role in this process: 127.0.0.1 only, a new token per start (written to
// <dataDir>/dashboard.token and returned once as a URL). `traffic` is fed from the bridge's receive path.
export async function startDashboard({ config, role, wallets = null, bridge, traffic = new TrafficLog(), log = () => {} }) {
  const port = config.dashboard?.port;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('dashboard.port must be a port number');
  const model = createModel({ config, role, wallets, bridge });
  const actions = createActions({ config, role, wallets, balances: model.balances });
  bridge.on('traffic', (channel, message, bytes) => { traffic.record(channel, message, bytes); model.note(channel, message); });
  const { token, file } = writeToken(config.dataDir);
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const bound = server.address().port;
  server.on('request', dashboardHandler({ token, port: bound, model, actions, confirmations: createConfirmations(), traffic, log }));
  return { url: `http://127.0.0.1:${bound}/?t=${token}`, port: bound, address: server.address().address, tokenFile: file, close: () => new Promise(r => server.close(r)) };
}
