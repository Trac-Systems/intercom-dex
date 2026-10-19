import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { resolveProfile } from './profile-core.js';
import { verifyResetSource } from '../../peer/src/trac/source.js';
export { checkProfileRegistry, checkProfileTerms, checkPeerProfile } from './profile-core.js';

export function resolveNetwork(config) {
  if (!['mainnet', 'local'].includes(config?.network)) throw new Error('Choose network: mainnet or local');
  const pins = JSON.parse(readFileSync(new URL(`../../networks/${config.network}.json`, import.meta.url), 'utf8'));
  return resolveProfile(config, pins, isAbsolute);
}

export function checkContractFiles(profile) {
  return verifyResetSource(profile.peer.trac.reset.source, { local: profile.network === 'local' });
}
