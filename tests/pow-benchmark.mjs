import { PowSearch } from '../peer/features/sidechannel/pow-search.js';
import { OldPowSearch } from './unit/peer/pow-reference.mjs';
import { powWorker } from '../peer/features/sidechannel/pow-client.js';

const prefix = '{"channel":"intercom-dex:signers","from":"' + 'a'.repeat(64) + '","id":"benchmark","message":{"kind":"heartbeat","text":"é🦊"},"nonce":';
const suffix = ',"origin":"' + 'a'.repeat(64) + '","ts":100000}';
const count = 1000000, rounds = 3;

for (const [name, Search] of [['old', OldPowSearch], ['allocation-free', PowSearch]]) {
  new Search(prefix, suffix).run(256, Infinity, 100000);
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    const search = new Search(prefix, suffix), start = Date.now();
    search.run(256, Infinity, count);
    samples.push(Math.round(count * 1000 / (Date.now() - start)));
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ runtime: typeof Bare === 'undefined' ? 'Node' : 'Bare', mode: name, hashes: count, hashesPerSecond: samples[1], samples }));
}

const sleep = () => new Promise(resolve => setTimeout(resolve, 0));
const started = Date.now();
const warmup = await powWorker.open(prefix, suffix, 0);
await powWorker.slice(warmup); powWorker.release(warmup);
console.log(JSON.stringify({ workerStartupMs: Date.now() - started }));

let expected;
for (const mode of ['old-main', 'allocation-free-main', 'worker']) {
  const delays = [], nonces = [], sliceMs = [];
  let previous = Date.now(), hashes = 0, slices = 0;
  const timer = setInterval(() => { const now = Date.now(); delays.push(Math.max(0, now - previous - 1)); previous = now; }, 1);
  await sleep();
  const start = Date.now();
  for (let i = 0; i < 3; i++) {
    const input = prefix.replace('benchmark', `benchmark-${i}`);
    const search = mode === 'worker' ? null : new (mode === 'old-main' ? OldPowSearch : PowSearch)(input, suffix);
    const job = mode === 'worker' ? await powWorker.open(input, suffix, 20) : null;
    try {
      for (;;) {
        const sliceStarted = Date.now();
        const nonce = job ? (await powWorker.slice(job)).nonce : search.run(20);
        sliceMs.push(Date.now() - sliceStarted);
        slices++;
        if (nonce >= 0) { nonces.push(nonce); hashes += nonce + 1; break; }
        await sleep();
      }
    } finally { if (job) powWorker.release(job); }
    await sleep();
  }
  const elapsedMs = Date.now() - start;
  clearInterval(timer);
  if (expected && JSON.stringify(nonces) !== JSON.stringify(expected)) throw new Error('Benchmark nonce mismatch');
  expected = nonces;
  delays.sort((a, b) => a - b);
  sliceMs.sort((a, b) => a - b);
  console.log(JSON.stringify({ runtime: typeof Bare === 'undefined' ? 'Node' : 'Bare', mode, difficulty: 20,
    nonces, hashes, slices, elapsedMs, hashesPerSecond: Math.round(hashes * 1000 / elapsedMs),
    timerSamples: delays.length, delayMs: { median: delays[Math.floor(delays.length / 2)], p95: delays[Math.floor(delays.length * 0.95)], max: delays.at(-1) },
    sliceMs: { p95: sliceMs[Math.floor(sliceMs.length * 0.95)], max: sliceMs.at(-1) } }));
}
await powWorker.close();
if (typeof Bare !== 'undefined') Bare.exit();
