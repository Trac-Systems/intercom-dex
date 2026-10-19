import { setTimeout as sleep } from 'node:timers/promises';

// The role marker can precede the control listener's asynchronous bind.
export async function waitForControl(read, { timeoutMs = 5000 } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try { return await read(); }
    catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED' || performance.now() >= deadline) throw error;
      await sleep(20);
    }
  }
}
