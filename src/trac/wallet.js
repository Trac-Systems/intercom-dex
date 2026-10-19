import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import PeerWallet from '../../peer/node_modules/trac-wallet/index.js';
import { createConfig } from '../../peer/node_modules/trac-msb/src/config/env.js';

const KDF = { N: 2 ** 17, r: 8, p: 1, dkLen: 32, maxmem: 256 * 1024 * 1024 };
const isHex = (value, length) => typeof value === 'string' && value.length === length * 2 && /^[0-9a-f]+$/.test(value);

function input(file, password) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Wallet file must be absolute');
  if (typeof password !== 'string' || !password.length) throw new Error('Wallet password is required');
}

function header(publicKey, salt, nonce) {
  return { v: 1, kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, cipher: 'xchacha20poly1305', publicKey, salt, nonce };
}

function exposed(secret) {
  const publicKey = Buffer.from(ed25519.getPublicKey(secret)).toString('hex');
  const address = PeerWallet.encodeBech32m('trac', Buffer.from(publicKey, 'hex'));
  let closed = false;
  return Object.freeze({
    publicKey, address,
    sign(hashBytes) {
      if (closed) throw new Error('Wallet is closed');
      if (!(hashBytes instanceof Uint8Array) || hashBytes.length !== 32) throw new Error('Expected a 32-byte transaction hash');
      return Buffer.from(ed25519.sign(hashBytes, secret)).toString('hex');
    },
    close() { secret.fill(0); closed = true; }
  });
}

export function walletOptions(profile) {
  const config = createConfig(profile.peer.environment, {});
  if (config.networkId !== profile.peer.msbNetworkId || config.addressPrefix !== 'trac') throw new Error('Wallet MSB profile mismatch');
  return { networkPrefix: config.addressPrefix, derivationPath: config.derivationPath };
}

export async function createWallet(file, password, { profile, mnemonic, onMnemonic = () => {} } = {}) {
  input(file, password);
  try { await fs.lstat(file); throw new Error('Wallet file already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let peer, backup;
  if (profile) {
    const options = walletOptions(profile);
    peer = new PeerWallet(options); await peer.ready;
    if (mnemonic !== undefined && (typeof mnemonic !== 'string' || !peer.sanitizeMnemonic(mnemonic))) throw new Error('Invalid mnemonic');
    await peer.generateKeyPair(mnemonic ?? null, options.derivationPath);
    backup = { mnemonic: peer.mnemonic, derivationPath: peer.derivationPath, networkPrefix: options.networkPrefix };
  } else if (mnemonic !== undefined) throw new Error('Mnemonic requires a network profile');
  const secret = peer ? Buffer.from(peer.secretKey.subarray(0, 32)) : randomBytes(32);
  peer?.secretKey.fill(0);
  let key, output, handle, plaintext;
  try {
    const publicKey = Buffer.from(ed25519.getPublicKey(secret)).toString('hex');
    const salt = randomBytes(16), nonce = randomBytes(24);
    const meta = { ...header(publicKey, salt.toString('hex'), nonce.toString('hex')), ...(backup ? { v: 2 } : {}) };
    key = await scryptAsync(password, salt, KDF);
    plaintext = backup ? Buffer.from(JSON.stringify(backup)) : secret;
    const ciphertext = xchacha20poly1305(key, nonce, Buffer.from(JSON.stringify(meta))).encrypt(plaintext);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    handle = await fs.open(file, 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify({ ...meta, ciphertext: Buffer.from(ciphertext).toString('hex') }) + '\n');
    await handle.sync();
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    output = exposed(secret);
    if (backup && mnemonic === undefined) onMnemonic(backup.mnemonic);
    return output;
  } finally {
    key?.fill(0);
    if (backup) plaintext?.fill(0);
    await handle?.close();
    if (!output) secret.fill(0);
  }
}

async function unlockWallet(file, password, wantMnemonic = false) {
  input(file, password);
  let handle, key, secret, output;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid() || stat.size > 4096) throw new Error('Wallet must be a private 0600 regular file');
    let packet;
    try { packet = JSON.parse(await handle.readFile('utf8')); } catch { throw new Error('Invalid wallet file'); }
    if (!packet || Object.keys(packet).length !== 10 || ![1, 2].includes(packet.v) || packet.kdf !== 'scrypt' || packet.N !== KDF.N || packet.r !== 8 || packet.p !== 1 || packet.cipher !== 'xchacha20poly1305' || !isHex(packet.publicKey, 32) || !isHex(packet.salt, 16) || !isHex(packet.nonce, 24) || (packet.v === 1 ? !isHex(packet.ciphertext, 48) : typeof packet.ciphertext !== 'string' || !/^(?:[0-9a-f]{2}){17,2048}$/.test(packet.ciphertext))) throw new Error('Invalid wallet file');
    const meta = { ...header(packet.publicKey, packet.salt, packet.nonce), v: packet.v };
    key = await scryptAsync(password, Buffer.from(packet.salt, 'hex'), KDF);
    try { secret = xchacha20poly1305(key, Buffer.from(packet.nonce, 'hex'), Buffer.from(JSON.stringify(meta))).decrypt(Buffer.from(packet.ciphertext, 'hex')); }
    catch { throw new Error('Wallet password or authentication is invalid'); }
    let backup;
    if (packet.v === 2) {
      const plaintext = secret;
      try { backup = JSON.parse(Buffer.from(plaintext).toString()); } finally { plaintext.fill(0); }
      if (typeof backup.mnemonic !== 'string' || typeof backup.derivationPath !== 'string' || backup.networkPrefix !== 'trac') throw new Error('Invalid wallet backup');
      const peer = new PeerWallet(backup); await peer.ready;
      secret = Buffer.from(peer.secretKey.subarray(0, 32)); peer.secretKey.fill(0);
    }
    if (Buffer.from(ed25519.getPublicKey(secret)).toString('hex') !== packet.publicKey) throw new Error('Wallet identity mismatch');
    if (wantMnemonic) {
      if (!backup) throw new Error('This legacy wallet has no mnemonic to export');
      secret.fill(0); return backup;
    }
    output = exposed(secret);
    return output;
  } finally {
    key?.fill(0);
    await handle?.close();
    if (!output) secret?.fill(0);
  }
}

export async function openWallet(file, password) { return unlockWallet(file, password); }

// Only the human export command calls this; signing adapters never receive the mnemonic.
export async function walletMnemonic(file, password) { return unlockWallet(file, password, true); }
