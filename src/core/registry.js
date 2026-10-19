import { ed25519 } from '@noble/curves/ed25519.js';
import { z } from 'zod';
import { bytesToHex, hexToBytes, stableJSON, utf8 } from './canonical.js';
import { identityPublic } from './keys.js';
import { hexKey, registrySchema } from './schemas.js';

const PREFIX = 'intercom-dex/v1/registry\n';
const signedSchema = z.object({ registry: registrySchema, from: hexKey, sig: z.string().length(128).regex(/^[0-9a-f]{128}$/) }).strict();

export function buildRegistry(input) {
  stableJSON(input);
  return registrySchema.parse(input);
}

export function signRegistry(registry, identitySecret) {
  const body = buildRegistry(registry);
  const secret = typeof identitySecret === 'string' ? hexToBytes(identitySecret, 32) : identitySecret;
  return { registry: body, from: bytesToHex(identityPublic(secret)),
    sig: bytesToHex(ed25519.sign(utf8(PREFIX + stableJSON(body)), secret)) };
}

export function verifyRegistry(signed, serviceKey, { now }) {
  try {
    if (!Number.isSafeInteger(now) || now < 0) return false;
    stableJSON(signed);
    const parsed = signedSchema.parse(signed);
    return parsed.from === serviceKey && parsed.registry.issuedAt <= now &&
      ed25519.verify(hexToBytes(parsed.sig, 64), utf8(PREFIX + stableJSON(parsed.registry)), hexToBytes(serviceKey, 32), { zip215: false });
  } catch { return false; }
}

export function newestRegistry(versions, serviceKey, { now, minVersion = 1 }) {
  if (!Array.isArray(versions) || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(minVersion) || minVersion < 1) {
    throw new TypeError('Invalid registry selection');
  }
  hexKey.parse(serviceKey);
  const valid = versions.filter(v => verifyRegistry(v, serviceKey, { now }) && v.registry.version >= minVersion)
    .sort((a, b) => b.registry.version - a.registry.version);
  if (!valid.length) throw new Error('No valid registry version');
  const latest = valid[0];
  if (valid.some(v => v.registry.version === latest.registry.version && stableJSON(v.registry) !== stableJSON(latest.registry))) {
    throw new Error('Registry version equivocation');
  }
  return structuredClone(latest);
}

export function removeSigner(registry, dexKey, { now, reason }) {
  const next = buildRegistry(registry);
  hexKey.parse(dexKey);
  if (!Number.isSafeInteger(now) || now < next.issuedAt || !next.signers.some(s => s.dexKey === dexKey)) throw new Error('Invalid signer removal');
  next.version++;
  next.issuedAt = now;
  next.signers = next.signers.filter(s => s.dexKey !== dexKey);
  next.removed.push({ dexKey, removedAt: now, reason });
  return buildRegistry(next);
}
