const HEALTHY_MS = 10 * 60 * 1000;

export function restartPolicy({ now = Date.now } = {}) {
  let failures = [], backoff = 2000, healthySince = null;
  return {
    healthy() { healthySince = now(); },
    failed() {
      const at = now();
      if (healthySince !== null && at - healthySince >= HEALTHY_MS) backoff = 2000;
      healthySince = null;
      failures = failures.filter(time => at - time < HEALTHY_MS);
      failures.push(at);
      const delayMs = backoff;
      backoff = Math.min(backoff * 2, 60000);
      return { at, delayMs, exhausted: failures.length >= 5 };
    },
  };
}
