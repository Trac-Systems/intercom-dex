import { cooperativeApply, summarizeApplyLogs } from '../../../peer/runtime/reader-scheduling.js';
import { signedBalanceRead } from '../../../peer/src/trac/balances.js';
import { createReadRecovery } from '../../../peer/runtime/read-recovery.js';
import { createReadMetrics } from '../../../peer/runtime/read-metrics.js';
import b4a from '../../../peer/node_modules/b4a/index.js';

let responsive = false;
setTimeout(() => { responsive = true; }, 0);
const values = [];
const apply = cooperativeApply(async (_nodes, view) => {
  const batch = view.batch();
  await batch.put('a', '1'); await batch.put('b', '2'); await batch.flush(); await batch.close();
}, { sliceMs: 0 });
await apply([], { batch: () => ({ put: async (...args) => values.push(args), flush: async () => {}, close: async () => {} }) });
if (!responsive || JSON.stringify(values) !== '[["a","1"],["b","2"]]') throw new Error('Reader scheduling mismatch');
let closed = 0;
const base = { view: { core: { signedLength: 2 }, checkout: () => ({
  get: async (_key, options) => { if (options.timeout !== 20 || options.update !== false) throw new Error('Read options mismatch'); return { value: '12' }; },
  close: async () => { closed++; },
}) } };
if ((await signedBalanceRead(base, 'balance', 'RESET', 20)).value !== '12') throw new Error('Read mismatch');
await new Promise(resolve => setTimeout(resolve, 0));
if (closed !== 1) throw new Error('Snapshot not closed');
let serve;
const sparse = { view: { core: { signedLength: 1746752 }, checkout: () => ({
  get(_key, { onseq, onwait }) { onseq(1746751); onwait(1746751); return new Promise(resolve => { serve = resolve; }); },
  close: async () => {},
}) } };
const metrics = [];
const observe = createReadMetrics({ base: sparse, label: 'RESET', log: line => metrics.push(line) });
const recovered = await signedBalanceRead(sparse, 'bal/a', 'RESET', 500, { stallMs: 10, onRead: observe,
  onStall: event => { if (event.waitingSeq !== 1746751) throw new Error('Missing block mismatch'); serve({ value: '15' }); } });
if (recovered.value !== '15' || !metrics[0]?.includes('"event":"balance_read"')) throw new Error('Early recovery/metrics mismatch');
const lines = [], logger = { log: value => lines.push(value) }, restore = summarizeApplyLogs(logger);
logger.log('#1 | ' + 'a'.repeat(64) + ': {}'); restore();
if (lines.length !== 1 || lines[0] !== 'RESET reader applied 1 messages') throw new Error('Log summary mismatch');
const topic = b4a.alloc(32, 1), replicaKey = b4a.alloc(32, 2);
let retries = 0, releases = 0;
const recover = createReadRecovery({ base, topic, label: 'RESET', log() {},
  swarm: { connections: new Set(), peers: new Map([['replica', { publicKey: replicaKey, topics: [topic] }]]),
    joinPeer() { retries++; }, leavePeer() { releases++; } }, discovery: { refresh: async () => false } });
if (!recover() || recover() || retries !== 1 || releases !== 1) throw new Error('Read recovery mismatch');
await new Promise(resolve => setTimeout(resolve, 0));
console.log('Bare reader scheduling, signed reads and log summary passed');
Bare.exit();
