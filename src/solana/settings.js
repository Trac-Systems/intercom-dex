import { DEFAULT_ENDPOINTS } from './constants.js';

// Solana RPC settings for a role. Configured values always win. On mainnet a role without any configures the
// built-in keyless public endpoints (two must agree; transactions go out through the first). Other networks have no
// public default, so they need explicit endpoints or run without Solana.
export function solanaSettings(config, profile) {
  const endpoints = config.solana?.endpoints ?? (profile.network === 'mainnet' ? [...DEFAULT_ENDPOINTS] : null);
  if (!endpoints) return null;
  // One own endpoint is trusted on its own answer; several need two that agree.
  return { endpoints, sendEndpoint: config.solana?.sendEndpoint ?? endpoints[0], need: config.solana?.need ?? Math.min(2, endpoints.length) };
}

// The stake clock needs two independent finalized readers that agree. A role whose trade reads trust one own
// endpoint can name separate clock readers; without them the clock uses the trade readers.
export function stakeClockSettings(config, rpc) {
  const endpoints = config.solana?.clockEndpoints;
  if (endpoints === undefined) return rpc;
  if (!Array.isArray(endpoints) || endpoints.length < 2 || new Set(endpoints).size !== endpoints.length ||
      endpoints.some(e => typeof e !== 'string' || !/^https:\/\//.test(e))) throw new Error('solana.clockEndpoints needs two or more distinct https endpoints');
  return { endpoints: [...endpoints], need: 2 };
}
