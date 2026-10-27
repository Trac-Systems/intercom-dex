export const GATEWAY_TIMEOUT_MS = 30000;
export const GATEWAY_CACHE_MS = 15000;

export function resetGatewayOrigin(value) {
  if (value === null) return null;
  const origin = new URL(value);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('Expected a RESET gateway origin');
  }
  return origin;
}

// One reader per adapter, shared by admission, display and sending. Unknown is never healthy.
export function createGatewayHealth({ resetGatewayUrl = null, request = (...args) => fetch(...args), now = Date.now } = {}) {
  const origin = resetGatewayOrigin(resetGatewayUrl);
  let last = null, pending = null;
  const result = (ok, eligible, reason) => Object.freeze({ ok, eligible, checkedAt: now(), reason });
  const fresh = () => last && now() >= last.checkedAt && now() - last.checkedAt < GATEWAY_CACHE_MS;
  async function sample() {
    if (!origin) return result(false, null, 'No RESET gateway is configured.');
    try {
      const response = await request(new URL('/v1/state', origin), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
      if (!response.ok) {
        await response.body?.cancel();
        return result(false, null, `The RESET gateway returned HTTP ${response.status}.`);
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 65536) return result(false, null, 'The RESET gateway returned an invalid state.');
        chunks.push(chunk);
      }
      let state;
      try { state = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return result(false, null, 'The RESET gateway returned an invalid state.'); }
      if (!state || !Object.hasOwn(state, 'validators')) return result(false, null, 'The RESET gateway did not report validator health.');
      if (state.validators === null) return result(false, null, 'The RESET gateway has not sampled its validators yet.');
      const eligible = state.validators?.eligible;
      if (eligible === null) return result(false, null, 'The RESET gateway cannot tell how many validators are eligible.');
      if (!Number.isSafeInteger(eligible) || eligible < 0) return result(false, null, 'The RESET gateway did not report a valid eligible validator count.');
      return result(eligible >= 3, eligible, eligible >= 3 ? null : `The RESET gateway can reach ${eligible} eligible validators; it needs at least 3.`);
    } catch (error) {
      return result(false, null, error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'The RESET gateway health check timed out.' : 'The RESET gateway health check failed.');
    }
  }
  return {
    read({ fresh: force = false } = {}) {
      if (pending) return pending;
      if (!force && fresh()) return Promise.resolve(last);
      pending = sample().then(value => (last = value)).finally(() => { pending = null; });
      return pending;
    },
    peek() { return fresh() ? last : { ok: false, eligible: null, checkedAt: last?.checkedAt ?? null, reason: 'RESET gateway health has not been checked recently.' }; }
  };
}
