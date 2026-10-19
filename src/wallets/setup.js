import { existsSync, lstatSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import PeerWallet from '../../peer/node_modules/trac-wallet/index.js';
import { createKeyring, openKeyring, readPrivateFile } from '../roles/keyring.js';
import { createWallet, openWallet, walletMnemonic, walletOptions } from '../trac/wallet.js';
import { MIN_SOL, MIN_TNK, validatePayout } from './accounting.js';
import { hiddenInput } from './input.js';
import { exportVenue, venueRecords } from './venue-backup.js';
import { openStore } from '../roles/store.js';

const absolute = value => { if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Absolute path required'); return value; };
export const walletFile = config => absolute(config.trac?.walletFile ?? join(config.dataDir, 'trac-wallet.json'));

// Startups are idempotent, including a previous startup interrupted between the two file writes.
export async function ensureWallets(config, profile, env = process.env) {
  absolute(config.dataDir); validatePayout(config.payout);
  if (!['trader', 'service', 'signer'].includes(config.role)) throw new Error('Invalid role');
  const password = env[config.keyPasswordEnv ?? 'DEX_KEY_PASSWORD'];
  const tracPassword = env[config.trac?.passwordEnv ?? config.keyPasswordEnv ?? 'DEX_KEY_PASSWORD'];
  for (const name of ['identity.key', 'box.key', 'store.key']) if (existsSync(join(config.dataDir, name))) throw new Error('Legacy plaintext keys require an empty data folder');
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const keyFile = join(config.dataDir, 'keyring.json');
  if (config.role === 'trader' && walletFile(config) === keyFile) throw new Error('Trac wallet and keyring must be separate files');
  if (!existsSync(keyFile)) {
    let imported;
    try {
      if (config.solana?.importKeypairFile) imported = solanaImport(config.solana.importKeypairFile);
      await createKeyring(keyFile, password, { solanaSecret: imported, withSolana: config.role !== 'signer' });
    } finally { imported?.fill(0); }
  }
  const keys = await openKeyring(keyFile, password);
  try {
    if (config.role !== 'trader') return { keys, wallet: null };
    const file = walletFile(config);
    const wallet = existsSync(file) ? await openWallet(file, tracPassword) : await createWallet(file, tracPassword, { profile });
    return { keys, wallet };
  } catch (error) { keys.storeKey.fill(0); keys.solanaSecret?.fill(0); throw error; }
}

function solanaImport(file) {
  const data = JSON.parse(readPrivateFile(absolute(file)));
  if (!Array.isArray(data) || data.length !== 64 || data.some(x => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error('Invalid Solana keypair');
  return Keypair.fromSecretKey(Uint8Array.from(data)).secretKey;
}

export async function importResetKeystore(directory, password, profile) {
  absolute(directory);
  const st = lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o700 || st.uid !== process.getuid()) throw new Error('Keystore directory must be private 0700');
  const packet = JSON.parse(readPrivateFile(join(directory, 'keystore.json'), 16384));
  if (Object.keys(packet).sort().join() !== 'address,cipher,ciphertext,iv,kdf,salt,tag,v' || packet.v !== 1 || packet.kdf !== 'scrypt-32768-8-1' || packet.cipher !== 'aes-256-gcm' ||
      !/^[0-9a-f]{64}$/.test(packet.address) || !/^[0-9a-f]{32}$/.test(packet.salt) || !/^[0-9a-f]{24}$/.test(packet.iv) ||
      !/^[0-9a-f]{32}$/.test(packet.tag) || !/^(?:[0-9a-f]{2}){1,4096}$/.test(packet.ciphertext)) throw new Error('Invalid RESET keystore');
  if (typeof password !== 'string' || password.length < 12) throw new Error('Keystore password of at least 12 characters required');
  const key = await scryptAsync(password, Buffer.from(packet.salt, 'hex'), { N: 32768, r: 8, p: 1, dkLen: 32, maxmem: 64 * 1024 * 1024 });
  let plaintext, peer;
  try {
    const { ciphertext, tag, ...header } = packet;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(packet.iv, 'hex'));
    decipher.setAAD(Buffer.from(JSON.stringify(header))); decipher.setAuthTag(Buffer.from(tag, 'hex'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]);
    const backup = JSON.parse(plaintext.toString()), options = walletOptions(profile);
    if (Object.keys(backup).sort().join() !== 'derivationPath,mnemonic' || backup.derivationPath !== options.derivationPath || typeof backup.mnemonic !== 'string' || !backup.mnemonic.trim()) throw new Error('Derivation mismatch');
    peer = new PeerWallet({ ...options, mnemonic: backup.mnemonic }); await peer.ready;
    if (peer.publicKey.toString('hex') !== packet.address) throw new Error('Address mismatch');
    return backup.mnemonic;
  } catch { throw new Error('RESET keystore password, derivation or file is invalid'); }
  finally { key.fill(0); plaintext?.fill(0); peer?.secretKey?.fill(0); }
}

// Without a payout lock a withdrawal can go to any address, also one that a misled agent was given.
function payoutAdvice(config) {
  const missing = (config.role === 'trader' ? ['solana', 'trac'] : config.role === 'service' ? ['solana'] : []).filter(chain => !config.payout?.[chain]);
  return missing.length ? { payoutLock: `Recommended: set ${missing.map(chain => `payout.${chain}`).join(' and ')} in the config to your own wallet ${missing.length > 1 ? 'addresses' : 'address'}. Withdrawals can then only go there, whoever asks. Agents: propose this to the user and let them choose the addresses.` } : {};
}

// The built-in public Solana servers suit occasional trading; they rate-limit busy clients.
export function rpcAdvice(config) {
  if (!['trader', 'service'].includes(config.role) || config.solana?.endpoints?.length) return {};
  return { solanaRpc: 'This program uses the built-in public Solana servers. That is fine for occasional trading. They limit requests per user; for frequent trading, an own Solana RPC URL can be added to the config as "solana": {"endpoints": ["<URL>"]}.' };
}

export async function setupWallets(config, profile, { password, tracPassword = password, importSolana, mnemonic, resetKeystore, resetPassword, onMnemonic = () => {} } = {}) {
  absolute(config.dataDir); validatePayout(config.payout);
  if (!['trader', 'service', 'signer'].includes(config.role)) throw new Error('Invalid role');
  if (typeof password !== 'string' || password.length < 12) throw new Error('Keyring password of at least 12 characters required');
  if (mnemonic !== undefined && resetKeystore) throw new Error('Choose one Trac import method');
  if (config.role !== 'trader' && (mnemonic !== undefined || resetKeystore)) throw new Error('Trac wallet is for traders');
  if (config.role === 'signer' && importSolana) throw new Error('Signer has no Solana wallet');
  const keyFile = join(config.dataDir, 'keyring.json'), tracFile = absolute(walletFile(config));
  if (tracFile === keyFile) throw new Error('Trac wallet and keyring must be separate files');
  for (const file of [keyFile, tracFile, ...['identity.key', 'box.key', 'store.key'].map(n => join(config.dataDir, n))]) {
    try { lstatSync(file); throw new Error('Refusing to overwrite existing wallets'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  let imported;
  if (importSolana) imported = solanaImport(importSolana);
  // Exclusive creation of both files also protects against simultaneous setup processes.
  let wallet;
  try {
    if (resetKeystore) mnemonic = await importResetKeystore(resetKeystore, resetPassword, profile);
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    if (config.role === 'trader') wallet = await createWallet(tracFile, tracPassword, { profile, mnemonic, onMnemonic });
    const pub = await createKeyring(keyFile, password, { solanaSecret: imported, withSolana: config.role !== 'signer' });
    return { dexKey: pub.dexKey, addresses: { solana: pub.solana ? new PublicKey(Buffer.from(pub.solana, 'hex')).toBase58() : null,
      trac: wallet?.address ?? null }, minimumFees: { SOL: MIN_SOL, TNK: config.role === 'trader' ? MIN_TNK : '0' }, ...payoutAdvice(config), ...rpcAdvice(config) };
  } finally { wallet?.close(); imported?.fill(0); }
}

export async function exportWallets(config, { out, readPassword = hiddenInput } = {}) {
  absolute(out); absolute(config.dataDir);
  if (!['trader', 'service'].includes(config.role)) throw new Error('This role has no trading wallets to export');
  if (existsSync(out)) throw new Error('Export directory already exists');
  // The caller supplies hidden terminal input, never an environment password.
  const password = await readPassword('Keyring password: ');
  const keys = await openKeyring(join(config.dataDir, 'keyring.json'), password);
  try {
    if (config.role === 'service') return exportVenue(keys, out, venueRecords(openStore(config.dataDir, keys.storeKey, { readOnly: true })));
    const separate = config.trac?.passwordEnv && config.trac.passwordEnv !== (config.keyPasswordEnv ?? 'DEX_KEY_PASSWORD');
    const backup = config.role === 'trader' ? await walletMnemonic(walletFile(config), separate ? await readPassword('Trac wallet password: ') : password) : null;
    if (!keys.solanaSecret) throw new Error('Solana wallet missing');
    mkdirSync(out, { mode: 0o700 });
    const files = [['solana-keypair.json', JSON.stringify([...keys.solanaSecret]) + '\n'], ...(backup ? [['trac-mnemonic.txt', backup.mnemonic + '\n']] : [])];
    for (const [name, data] of files) {
      const fd = openSync(join(out, name), 'wx', 0o600);
      try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    }
    const dir = openSync(out, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    return files.map(([name]) => name);
  } finally { keys.solanaSecret?.fill(0); keys.storeKey.fill(0); }
}
