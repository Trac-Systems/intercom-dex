import Sidechannel from '../../../peer/features/sidechannel/index.js';
import { PowSearch } from '../../../peer/features/sidechannel/pow-search.js';
import { powWorker } from '../../../peer/features/sidechannel/pow-client.js';
import c from '../../../peer/node_modules/compact-encoding/index.js';
import b4a from '../../../peer/node_modules/b4a/index.js';
import { fixture, oldAttachPow } from './pow-reference.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
for (let n = 0; n < 48; n++) {
  const difficulty = n < 45 ? [1, 4, 9, 12][n % 4] : 20;
  const sc = new Sidechannel({}, { powEnabled: true, powDifficulty: difficulty });
  sc._now = () => 100000;
  const expected = fixture(n), actual = fixture(n);
  await oldAttachPow.call(sc, expected);
  const search = new PowSearch(...sc._powParts(actual));
  check(search.run(difficulty, Infinity) === expected.pow.nonce, `search nonce ${n}`);
  await sc._attachPow(actual);
  check(b4a.equals(c.encode(c.json, actual), c.encode(c.json, expected)), `wire bytes ${n}`);
  check(sc._checkPow(actual, actual.channel), `verification ${n}`);
}

const suspended = await powWorker.open('{"nonce":', '}', 256), old = powWorker.worker;
await powWorker.slice(suspended);
const exited = new Promise(resolve => old.once('exit', resolve));
old.ref(); old.terminate(); await exited;
let rejected = false;
try { await powWorker.slice(suspended); } catch { rejected = true; }
check(rejected, 'dead worker rejects its old jobs');
const replacement = await powWorker.open('{"nonce":', '}', 0);
check(powWorker.worker !== old, 'worker replaced');
check((await powWorker.slice(replacement)).nonce === 0, 'replacement works');
powWorker.release(replacement);

const sc = new Sidechannel({}, { powEnabled: true, powDifficulty: 9, powClasses: [['urgent']] });
let now = 100000, held = true;
sc._now = () => now;
const slice = powWorker.slice.bind(powWorker);
let started;
const running = new Promise(resolve => { started = resolve; });
powWorker.slice = job => { started(); return held ? Promise.resolve({ nonce: -1 }) : slice(job); };
const order = [];
const background = sc._stampedPayload('test', { kind: 'background' }).then(p => { order.push('background'); return p; });
await running;
const urgent = sc._stampedPayload('test', { kind: 'urgent' }).then(p => { order.push('urgent'); return p; });
now += 30000; held = false;
const payloads = await Promise.all([background, urgent]);
powWorker.slice = slice;
check(order.join(',') === 'urgent,background', 'priority order');
for (const payload of payloads) {
  check(payload.ts === now, 'timestamp refreshed');
  const expected = { ...payload }; delete expected.pow;
  await oldAttachPow.call(sc, expected);
  check(expected.pow.nonce === payload.pow.nonce, 'refreshed nonce');
}
await powWorker.close();
console.log(JSON.stringify({ runtime: 'Bare', equivalent: 48, restart: true, priorities: true }));
Bare.exit();
