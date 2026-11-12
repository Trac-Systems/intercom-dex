import assert from 'node:assert/strict';
import Sidechannel from '../../peer/features/sidechannel/index.js';

// Hold the application's own queue at an unresolved predecessor to model
// stamping that is slower than admission. No worker or network is started.
let release, expired = false;
const channel = 'memory-stamps';
const sc = new Sidechannel({}, { powEnabled: true, powDifficulty: 1,
  powRequiredChannels: [channel], powExpired: () => expired });
sc.powQueues[sc.powBackground] = new Promise(resolve => { release = resolve; });
const promises = [];
try {
  for (const target of [100, 1000, 6000]) {
    while (promises.length < target) promises.push(sc._stampedPayload(channel,
      { index: promises.length, text: 'x'.repeat(4096) }).catch(() => {}));
    console.log(JSON.stringify({ queued: promises.length, cacheEntries: sc.stamped.size,
      serializedBytes: sc.stampedBytes, pending: sc.powPending }));
  }
  assert.ok(sc.stamped.size > 5000 && sc.stampedBytes > 16000000);
} finally {
  expired = true; release();
  await Promise.all(promises);
  console.log(JSON.stringify({ afterExpiry: true, cacheEntries: sc.stamped.size,
    serializedBytes: sc.stampedBytes, pending: sc.powPending }));
  await sc.stop();
}
