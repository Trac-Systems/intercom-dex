import fs from '../../peer/node_modules/fs/index.js';
import { getPearRuntime, toArgMap } from '../../peer/node_modules/trac-peer/src/runnerArgs.js';
import { runDexPeer } from '../../peer/runtime/dex-peer.js';
import { makeHandlers } from '../../peer/src/trac/handlers.js';
import { relayFaults } from '../integration/net/relay-faults.mjs';

const runtime = getPearRuntime();
const flags = toArgMap(runtime.argv?.length ? runtime.argv : (globalThis.Bare?.argv ?? []).slice(2));
const fault = JSON.parse(fs.readFileSync(flags.faults, 'utf8'));
let audit;
await runDexPeer(flags, { configurePeer(peer) { audit = relayFaults(peer, fault.isolatedKey, { capture: fault.capture }); },
  makeHandlers(context) { return { ...makeHandlers(context), relay_audit: () => audit() }; } });
