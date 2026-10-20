import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function runBare(entry, { stream = false } = {}) {
  const binary = fileURLToPath(new URL(`../../../peer/node_modules/bare-sidecar/prebuilds/${process.platform}-${process.arch}/bare${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
  return new Promise((resolve, reject) => {
    // bare-sidecar requires its host IPC pipe on fd 3, even for a local test.
    const child = spawn(binary, [entry], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Bare PoW test timed out')); }, 120000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stream) process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stream) process.stderr.write(chunk); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Bare exited (${code ?? signal}): ${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBare(path.resolve(process.argv[2]), { stream: true });
}
