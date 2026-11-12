import { retentionFixture, collect } from '../unit/peer/retention-fixture.mjs';

if (typeof globalThis.gc !== 'function') throw new Error('Run with node --expose-gc');
const encrypted = process.argv.includes('--noise'), baseline = process.argv.includes('--baseline-limiter');
const fixture = await retentionFixture({ encrypted });
// Recreate only the application's pre-fix limiter to compare identical traffic.
if (baseline) for (const node of fixture.nodes) node.rateLimits = new Map();
try {
  for (const target of [0, 100, 500, 1000]) {
    while (fixture.refs.length < target * 2) await fixture.cycle();
    await collect();
    const memory = process.memoryUsage();
    console.log(JSON.stringify({ runtime: process.version, encrypted, baseline, pairs: target, closedConnections: fixture.refs.length,
      retainedConnections: fixture.refs.filter(ref => ref.deref() !== undefined).length,
      delivered: fixture.delivered(), ...memory }));
  }
} finally { await fixture.close(); }
