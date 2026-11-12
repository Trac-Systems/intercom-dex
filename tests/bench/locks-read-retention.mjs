import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Corestore from '../../peer/node_modules/corestore/index.js';
import Hyperbee from '../../peer/node_modules/hyperbee/index.js';
import { makeLocksHandlers } from '../../peer/features/locks-bridge.js';
import { Bridge } from '../../src/net/bridge.js';

// No network. Two temporary stores replicate through in-memory streams, then
// the reader loses a signed tree block. Real host deadlines keep expiring
// while the peer-side handler still owns the corresponding checkout.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-h2-locks-read-'));
const writer = new Corestore(path.join(directory, 'writer'));
const reader = new Corestore(path.join(directory, 'reader'));
const options = { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false };
const source = new Hyperbee(writer.get({ name: 'test' }), options);
let view, core, streams = [], completed = 0;
const work = [], turn = () => new Promise(resolve => setImmediate(resolve));
const bridge = new Bridge({ url: 'unused', token: 'synthetic-test-token', timeoutMs: 10 });
try {
  await source.put('beacon/state', { counted: 42 });
  core = reader.get(source.core.key);
  await core.ready();
  streams = [writer.replicate(true), reader.replicate(false)];
  for (const stream of streams) stream.on('error', () => {});
  streams[0].pipe(streams[1]).pipe(streams[0]);
  await core.get(source.core.length - 1, { timeout: 1000 });
  for (const stream of streams) stream.destroy();
  await turn(); await turn();
  await core.clear(1, core.length);
  view = new Hyperbee(core, options); await view.ready();
  const bootstrap = 'ab'.repeat(32);
  // Isolate RPC reads from the separately serialized background header index.
  const base = { key: Buffer.from(bootstrap, 'hex'), view };
  const handlers = makeLocksHandlers({ bus: {}, config: { trac: { reset: { bootstrap } } }, resetPeer: { base } });
  // Only transport delivery is a stub; Bridge.request and locks_clock are real.
  bridge.ws = { readyState: 1, send(text) {
    const { type, params } = JSON.parse(text);
    work.push(handlers[type](params).then(() => { completed++; }, () => { completed++; }));
  } };
  const sample = calls => console.log(JSON.stringify({ runtime: process.version, calls, completed,
    clientPending: bridge.pending.size, coreSessions: core.sessions.length,
    coreRequests: core.sessions.reduce((n, session) => n + session.activeRequests.length, 0), cores: reader.cores.size }));
  sample(0);
  for (const target of [10, 100, 1000]) {
    const calls = [];
    while (work.length < target) calls.push(assert.rejects(bridge.call('locks_clock', {}), /Bridge timeout/));
    await Promise.all(calls);
    await turn();
    sample(target);
  }
  await new Promise(resolve => setTimeout(resolve, 30020));
  sample('after-peer-deadline');
} finally {
  bridge.close({ force: true });
  if (core) await Promise.all(core.sessions.filter(session => session !== core).map(session => session.close()));
  await Promise.all(work);
  if (core) console.log(JSON.stringify({ afterExplicitPeerCleanup: true, completed, coreSessions: core.sessions.length }));
  for (const stream of streams) stream.destroy();
  await view?.close(); await source.close(); await reader.close(); await writer.close();
  await fs.rm(directory, { recursive: true, force: true });
}
