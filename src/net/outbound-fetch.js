import https from 'node:https';
import { Readable } from 'node:stream';

// Node 26 bundles undici 8, whose fetch offers HTTP/2 to every HTTPS server (ALPN h2 + http/1.1). A stalled HTTP/2
// session in that client was seen to keep the app's main thread busy: the control port stopped answering, the log
// froze and the stake timers never ran. Outbound HTTPS requests of this app (Solana RPC, RESET gateway, explorer,
// market feed) therefore use HTTP/1.1 through node:https, which never negotiates HTTP/2, and return a standard
// Response. Plain-HTTP (local) requests, and a fetch replaced by a test or an embedder, go through globalThis.fetch.
const nativeFetch = globalThis.fetch;
const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const MAX_REDIRECTS = 20;

function abortError(signal) {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

function headerObject(headers) {
  const out = {};
  if (!headers) return out;
  for (const [name, value] of headers instanceof Headers ? headers.entries() : Array.isArray(headers) ? headers : Object.entries(headers)) out[name.toLowerCase()] = String(value);
  return out;
}

export function createOutboundFetch({ request = https.request, fallback = (...args) => globalThis.fetch(...args), useFallback = () => globalThis.fetch !== nativeFetch } = {}) {
  return async function outboundFetch(input, init = {}) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'https:' || useFallback()) return fallback(input, init);
    let method = (init.method ?? 'GET').toUpperCase(), body = init.body ?? null, headers = headerObject(init.headers);
    const { signal, redirect = 'follow' } = init;
    if (body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) throw new TypeError('Unsupported request body');
    for (let current = url, hops = 0; ; hops++) {
      const res = await send(request, current, { method, headers, body, signal });
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location && redirect !== 'manual') {
        res.resume();
        if (redirect === 'error') throw new TypeError('fetch failed', { cause: new Error('Redirect refused') });
        if (hops >= MAX_REDIRECTS) throw new TypeError('fetch failed', { cause: new Error('Too many redirects') });
        const next = new URL(location, current);
        if (next.protocol !== 'https:') throw new TypeError('fetch failed', { cause: new Error('Redirect left HTTPS') });
        if (res.statusCode === 303 || ([301, 302].includes(res.statusCode) && method === 'POST')) {
          method = 'GET'; body = null; delete headers['content-type']; delete headers['content-length'];
        }
        if (next.origin !== current.origin) delete headers.authorization;
        current = next;
        continue;
      }
      return toResponse(res, method, signal);
    }
  };
}

function send(request, url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    const req = request(url, { method, headers: body === null ? headers : { ...headers, 'content-length': String(Buffer.byteLength(body)) }, agent });
    const onAbort = () => { const error = abortError(signal); req.destroy(error); reject(error); };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', error => {
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.aborted ? abortError(signal) : new TypeError('fetch failed', { cause: error }));
    });
    req.on('response', res => {
      // Abort keeps working while the body is read: it destroys the response stream, which errors the body.
      const onBodyAbort = () => res.destroy(abortError(signal));
      signal?.removeEventListener('abort', onAbort);
      if (signal) {
        signal.addEventListener('abort', onBodyAbort, { once: true });
        res.once('close', () => signal.removeEventListener('abort', onBodyAbort));
      }
      resolve(res);
    });
    req.end(body ?? undefined);
  });
}

function toResponse(res, method, signal) {
  const headers = new Headers();
  for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
  const empty = method === 'HEAD' || NULL_BODY.has(res.statusCode);
  if (empty) res.resume();
  if (signal?.aborted) res.destroy(abortError(signal));
  return new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage ?? '', headers });
}

export const outboundFetch = createOutboundFetch();
