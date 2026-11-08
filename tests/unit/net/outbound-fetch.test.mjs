import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createOutboundFetch } from '../../../src/net/outbound-fetch.js';

// A stand-in for https.request: records each call and answers with the next scripted response.
function fakeRequest(responses) {
  const calls = [];
  const request = (url, options) => {
    const req = new EventEmitter(), call = { url: String(url), options, body: null, destroyed: null };
    calls.push(call);
    req.destroy = error => { call.destroyed = error; queueMicrotask(() => req.emit('error', error)); };
    req.end = body => {
      call.body = body === undefined ? null : String(body);
      const next = responses.shift();
      if (!next) return;
      if (next.error) { queueMicrotask(() => req.emit('error', next.error)); return; }
      const res = new PassThrough();
      Object.assign(res, { statusCode: next.status ?? 200, statusMessage: 'OK', rawHeaders: Object.entries(next.headers ?? {}).flat(),
        headers: Object.fromEntries(Object.entries(next.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) });
      queueMicrotask(() => { req.emit('response', res); if (!next.hang) res.end(next.body ?? ''); });
    };
    return req;
  };
  return { request, calls };
}

test('HTTPS requests go over node:https (HTTP/1.1 only) and return a standard Response', async () => {
  const { request, calls } = fakeRequest([{ body: '{"jsonrpc":"2.0","id":1,"result":7}', headers: { 'Content-Type': 'application/json' } }]);
  const fetch = createOutboundFetch({ request, useFallback: () => false, fallback: () => assert.fail('global fetch used') });
  const response = await fetch('https://rpc.example/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 1, result: 7 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['content-length'], '7');
  assert.equal(calls[0].body, '{"x":1}');
});

test('plain HTTP and a replaced global fetch use the fallback', async () => {
  const { request, calls } = fakeRequest([]);
  const seen = [];
  const fallback = async url => { seen.push(String(url)); return new Response('ok'); };
  assert.equal(await (await createOutboundFetch({ request, fallback, useFallback: () => false })('http://127.0.0.1:47201/x')).text(), 'ok');
  assert.equal(await (await createOutboundFetch({ request, fallback, useFallback: () => true })('https://rpc.example/')).text(), 'ok');
  assert.deepEqual(seen, ['http://127.0.0.1:47201/x', 'https://rpc.example/']);
  assert.equal(calls.length, 0);
});

test('abort before and during the response rejects and destroys the request or body', async () => {
  const { request, calls } = fakeRequest([{ hang: true }]);
  const fetch = createOutboundFetch({ request, useFallback: () => false });
  const early = new AbortController(); early.abort();
  await assert.rejects(fetch('https://rpc.example/', { signal: early.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
  const late = new AbortController();
  const response = await fetch('https://rpc.example/', { signal: late.signal });
  const reading = response.text();
  late.abort();
  await assert.rejects(reading, { name: 'AbortError' });
});

test('transport errors become fetch-style TypeErrors; redirects follow, refuse or stay on HTTPS', async () => {
  const failing = fakeRequest([{ error: new Error('ECONNRESET') }]);
  await assert.rejects(createOutboundFetch({ request: failing.request, useFallback: () => false })('https://rpc.example/'),
    error => error instanceof TypeError && error.cause?.message === 'ECONNRESET');
  const moved = fakeRequest([{ status: 307, headers: { Location: '/v2' } }, { body: 'moved' }]);
  const follow = createOutboundFetch({ request: moved.request, useFallback: () => false });
  assert.equal(await (await follow('https://rpc.example/v1', { method: 'POST', body: 'b' })).text(), 'moved');
  assert.deepEqual(moved.calls.map(c => [c.url, c.options.method, c.body]), [['https://rpc.example/v1', 'POST', 'b'], ['https://rpc.example/v2', 'POST', 'b']]);
  const refused = fakeRequest([{ status: 302, headers: { Location: 'https://other.example/' } }]);
  await assert.rejects(createOutboundFetch({ request: refused.request, useFallback: () => false })('https://rpc.example/', { redirect: 'error' }), TypeError);
  const downgrade = fakeRequest([{ status: 302, headers: { Location: 'http://rpc.example/' } }]);
  await assert.rejects(createOutboundFetch({ request: downgrade.request, useFallback: () => false })('https://rpc.example/'), TypeError);
});
