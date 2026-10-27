export const RESET_PAUSED_MESSAGE = "RESET transfers are paused: the RESET gateway can't reach enough validators right now. Try again in a few minutes.";
export const RESET_READY_MESSAGE = 'RESET transfers are available.';
export const GATEWAY_STATUS_SEC = 15;

// Use the existing signed status text: older apps can still read the warning.
export function venueGatewayHealth(status, now) {
  return { ok: !!status && status.ts <= now && now - status.ts < GATEWAY_STATUS_SEC &&
    status.message.includes(RESET_READY_MESSAGE) && !status.message.includes(RESET_PAUSED_MESSAGE) };
}

export const gatewayAvailability = (pair, health) => pair === 'RESET/USDC' && health?.ok !== true
  ? { paused: true, reason: RESET_PAUSED_MESSAGE } : { paused: false, reason: null };

export async function requireResetGateway(base, trac) {
  if (base.id !== 'RESET') return;
  let health;
  try { health = await trac?.gatewayHealth(); } catch {}
  if (health?.ok !== true) throw new Error(RESET_PAUSED_MESSAGE);
}
