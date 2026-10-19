/** @typedef {import('pear-interface')} */
import fs from 'fs';
import { getPearRuntime, toArgMap } from 'trac-peer/src/runnerArgs.js';
import { runDexPeer } from './runtime/dex-peer.js';

const runtime = getPearRuntime();
const argv = runtime.argv?.length ? runtime.argv : (globalThis.Bare?.argv ?? []).slice(2);
const flags = runtime.flags && Object.keys(runtime.flags).length ? runtime.flags : toArgMap(argv);
if (!flags.config) throw new Error('Usage: npm start -- --config <absolute path to peer config JSON>');

// Trac commands are optional: a peer without them only relays messages.
const handlersFile = new URL('./src/trac/handlers.js', import.meta.url);
const makeHandlers = fs.existsSync(handlersFile.pathname) ? (await import(handlersFile.href)).makeHandlers : undefined;
await runDexPeer(flags, { makeHandlers });
