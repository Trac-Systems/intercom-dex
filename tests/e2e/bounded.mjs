// Run a local test in its own process group, with a deadline including cleanup.
import { spawn } from 'node:child_process';

const [minutes, command, ...args] = process.argv.slice(2), limit = Number(minutes) * 60000;
if (!command || !Number.isFinite(limit) || limit <= 1000 || limit > 75 * 60000) throw Error('Usage: bounded.mjs <minutes <= 75> <command> [args]');
const child = spawn(command, args, { detached: true, stdio: 'inherit', env: process.env });
let timedOut = false;
const signal = name => { if (child.pid) { try { process.kill(-child.pid, name); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
const stop = () => { timedOut = true; signal('SIGTERM'); };
const timer = setTimeout(() => { console.error(`COMMAND_DEADLINE: ${command} must finish within ${minutes} minutes; stopping for cleanup`); stop(); }, Math.max(0, limit - 60000));
const hard = setTimeout(() => { signal('SIGKILL'); process.exit(124); }, limit);
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, stop);
child.once('error', error => { console.error(error); clearTimeout(timer); clearTimeout(hard); process.exitCode = 1; });
child.once('exit', (code, sig) => {
  clearTimeout(timer); clearTimeout(hard); signal('SIGKILL');
  console.log(`COMMAND_EXIT: code=${code} signal=${sig} timedOut=${timedOut}`);
  process.exitCode = timedOut ? 124 : code ?? 1;
});
