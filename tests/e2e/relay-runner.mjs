import PearRuntime from '../../peer/node_modules/pear-runtime/index.js';
import { fileURLToPath } from 'node:url';
const worker = PearRuntime.run(fileURLToPath(new URL('./relay-peer.js', import.meta.url)), process.argv.slice(2));
worker.stdout.pipe(process.stdout); worker.stderr.pipe(process.stderr);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => worker._process.kill(signal));
worker.on('close', () => { process.exitCode = worker._process?.exitCode ?? 0; });
worker.on('error', error => { console.error(error.message); process.exitCode = 1; });
