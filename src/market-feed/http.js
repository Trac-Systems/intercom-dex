import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { readPrivateFile } from '../roles/keyring.js';

export async function startMarketFeedHttp({ feed, port, viewerKeyFile }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid marketFeed.port');
  if (!isAbsolute(viewerKeyFile ?? '')) throw new Error('marketFeed.viewerKeyFile must be absolute');
  const token = readPrivateFile(viewerKeyFile, 512).trim();
  if (!/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error('Invalid viewer key');
  const digest = value => createHash('sha256').update(value).digest(), expected = digest(token);
  const server = createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/market/view' && !url.search) {
        const { json, etag } = feed.view();
        const headers = { etag, 'cache-control': 'max-age=10' };
        if (req.headers['if-none-match']?.split(',').some(v => v.trim() === '*' || v.trim().replace(/^W\//, '') === etag)) return send(304, undefined, headers);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(json); return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/market/chat') {
        const after = url.searchParams.getAll('after');
        if ([...url.searchParams.keys()].some(k => k !== 'after') || after.length > 1 || after.length &&
            (!/^(0|[1-9][0-9]{0,15})$/.test(after[0]) || !Number.isSafeInteger(Number(after[0])))) return send(400, { ok: false, error: 'after' });
        return send(200, feed.readChat(after.length ? Number(after[0]) : null));
      }
      if (req.method === 'POST' && url.pathname === '/v1/market/chat/viewer' && !url.search) {
        const match = /^Bearer ([\x21-\x7e]{32,256})$/.exec(req.headers.authorization ?? '');
        const authorized = timingSafeEqual(expected, digest(match?.[1] ?? ''));
        if (!match || !authorized) return send(401, { ok: false, error: 'unauthorized' });
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return send(415, { ok: false, error: 'content_type' });
        let size = 0; const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) { send(413, { ok: false, error: 'body_too_large' }); return; }
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return send(400, { ok: false, error: 'format' }); }
        let result;
        try { result = await feed.postViewer(body); }
        catch (error) { return send(error.name === 'ZodError' ? 400 : 500, { ok: false, error: error.name === 'ZodError' ? 'format' : 'unavailable' }); }
        const status = result.ok ? 200 : ({ slow_down: 429, capacity: 503, relay_not_configured: 503, transport: 502, id_conflict: 409 }[result.error] ?? 400);
        return send(status, result);
      }
      send(404, { ok: false, error: 'not_found' });
    } catch { if (!res.headersSent) send(500, { ok: false, error: 'unavailable' }); else res.end(); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.setTimeout(10000, socket => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
