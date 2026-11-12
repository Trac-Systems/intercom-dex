import Corestore from '../../../peer/node_modules/corestore/index.js';
import Hyperbee from '../../../peer/node_modules/hyperbee/index.js';
import fs from '../../../peer/node_modules/fs/index.js';
import os from '../../../peer/node_modules/bare-os/index.js';
import b4a from '../../../peer/node_modules/b4a/index.js';
import { makeLocksHandlers } from '../../../peer/features/locks-bridge.js';

const check = (value, message) => { if (!value) throw new Error(message); };
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const directory = `${os.tmpdir()}/dex-h2-bare-${Date.now()}-${Math.random().toString(16).slice(2)}`;
fs.mkdirSync(directory);
const writer = new Corestore(directory + '/writer'), reader = new Corestore(directory + '/reader');
const encoding = { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false };
const source = new Hyperbee(writer.get({ name: 'test' }), encoding), streams = [];
let view;
try {
  await source.put('beacon/state', { counted: 42 });
  const core = reader.get(source.core.key); await core.ready();
  const replicate = async () => {
    const a = writer.replicate(true), b = reader.replicate(false);
    streams.push(a, b); a.on('error', () => {}); b.on('error', () => {}); a.pipe(b).pipe(a);
    for (let i = 0; i < source.core.length; i++) await core.get(i, { timeout: 1000 });
  };
  await replicate();
  for (const stream of streams) stream.destroy();
  await turn(); await turn();
  await core.clear(1, core.length);
  view = new Hyperbee(core, encoding); await view.ready();
  const bootstrap = 'ab'.repeat(32), base = { key: b4a.from(bootstrap, 'hex'), view };
  const handlers = makeLocksHandlers({ bus: {}, config: { trac: { reset: { bootstrap } } }, resetPeer: { base }, readTimeoutMs: 20 });
  const initial = core.sessions.length;
  for (let round = 0; round < 10; round++) {
    await Promise.all(Array.from({ length: 8 }, async () => {
      let error;
      try { await handlers.locks_clock(); } catch (e) { error = e; }
      check(error?.message === 'Locks read timed out', 'Missing signed data must time out');
    }));
    await turn(); await turn();
    check(core.sessions.length === initial, 'Timed-out sessions retained');
  }
  await replicate();
  const result = await handlers.locks_clock();
  check(result.counted === 42 && result.signedLength === core.signedLength, 'Recovery changed the signed result');
  check(core.sessions.length === initial, 'Recovered read retained a session');
  console.log(JSON.stringify({ runtime: 'Bare', timedOutReads: 80, initialSessions: initial,
    finalSessions: core.sessions.length, recoveredCounted: result.counted }));
} finally {
  for (const stream of streams) stream.destroy();
  await view?.close(); await source.close(); await reader.close(); await writer.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
Bare.exit();
