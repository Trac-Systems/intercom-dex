import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { openKeyring } from '../roles/keyring.js';
import { openStore } from '../roles/store.js';
import { readAuthorityKeypair } from './input.js';
import { createFeeReader } from '../solana/fee-reader.js';
import { solanaSettings } from '../solana/settings.js';
import { hiddenInput } from '../wallets/input.js';

export async function checkKeys(config, profile, { authorityKeypair, readPassword = hiddenInput, reader } = {}) {
  if (config.role !== 'service') throw new Error('Key check is service only');
  const lines = [];
  const check = async (label, work) => {
    try { lines.push({ ok: true, label, message: await work() }); }
    catch (error) { lines.push({ ok: false, label, message: error.message }); }
  };
  let keys;
  await check('keyring', async () => {
    keys = await openKeyring(join(config.dataDir, 'keyring.json'), await readPassword('Keyring password: '));
    return 'opens with password';
  });
  if (!keys) return { ok: false, lines };
  const collectors = keys.collectors;
  try {
    reader ??= createFeeReader({ ...solanaSettings(config, profile), programId: profile.programId, mint: profile.mint });
    await check(`identity ${keys.identity.publicKey}`, () => {
      if (!config.serviceKey) throw new Error('Configure serviceKey with the identity pinned by traders');
      if (config.serviceKey !== keys.identity.publicKey) throw new Error('Identity differs from configured serviceKey');
      return 'matches pinned serviceKey';
    });
    await check('main Solana', async () => {
      if (!keys.solanaSecret) throw new Error('Main Solana key is missing');
      const address = new PublicKey(keys.solanaSecret.subarray(32)).toBase58(), state = await reader.main(address);
      const detail = `${address}: ${state.balance} lamports; collector config rent ${state.rent}`;
      if (BigInt(state.balance) < BigInt(state.rent)) throw new Error(`${detail}; insufficient rent`);
      return detail + '; covers rent';
    });
    if (!collectors.length) lines.push({ ok: false, label: 'collectors', message: 'No collector keys recorded' });
    for (const c of collectors) await check(`collector ${c.collector}`, async () => {
      const state = await reader.collector(c.collector);
      if (state.feeBps !== c.feeBps) throw new Error(`Config bps ${state.feeBps} differs from keyring ${c.feeBps}; vault ${state.balance} base units`);
      return `finalized config, ${c.feeBps} bps; vault ${state.balance} base units`;
    });
    await check('registry collector', () => {
      const store = openStore(config.dataDir, keys.storeKey, { readOnly: true });
      const registry = store.get('service-registry-published');
      if (!registry) throw new Error('No saved published registry; start the venue to publish one');
      if (!collectors.some(c => c.collector === registry.fee?.collector)) throw new Error(`Registry v${registry.version} collector ${registry.fee?.collector} is absent from keyring`);
      return `v${registry.version} ${registry.fee.collector} is in keyring`;
    });
    if (authorityKeypair !== undefined) {
      let authority;
      await check('authority file', () => {
        const signer = readAuthorityKeypair(authorityKeypair);
        try { authority = signer.publicKey.toBase58(); return authority; } finally { signer.secretKey.fill(0); }
      });
      if (authority) {
        for (const [label, field] of [['platform authority', 'authority'], ['platform collector', 'collector']]) await check(label, async () => {
          const state = await reader.platform();
          if (state[field] !== authority) throw new Error(`${state[field]} differs from supplied authority ${authority}`);
          return authority;
        });
        await check('upgrade authority', async () => {
          const actual = await reader.upgradeAuthority();
          if (actual !== authority) throw new Error(`${actual} differs from supplied authority ${authority}`);
          return authority;
        });
        await check('platform vault', async () => `${profile.mint}: ${await reader.platformBalance()} base units`);
      }
    }
    return { ok: lines.every(line => line.ok), lines };
  } finally { keys.solanaSecret?.fill(0); keys.storeKey.fill(0); for (const c of collectors) c.secretKey.fill(0); }
}
