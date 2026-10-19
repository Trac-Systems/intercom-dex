import { createHash, randomBytes } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { openSync, closeSync, fstatSync, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tryLock } from '../../peer/node_modules/fs-native-extensions/index.js';

// Use the same native advisory lock as the Trac journals. Process death releases it automatically.
export async function withPlatformLock(dataDir, work) {
  if (!isAbsolute(dataDir)) throw new Error('Absolute data directory required');
  const fd = openSync(join(dataDir, 'platform-withdraw.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) throw new Error('Platform withdrawal lock must be a private regular file');
    if (!tryLock(fd)) throw new Error('Another platform withdrawal command is active');
    return await work();
  } finally { closeSync(fd); }
}

function amountUnits(value, decimals) {
  if (typeof value !== 'string' || value.length > 300 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) throw new Error('Invalid decimal amount');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error('Too many decimal places for mint');
  const n = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (!n || n > (1n << 64n) - 1n) throw new Error('Amount out of range');
  return n;
}

// One outstanding command per authority/mint. Public request + exact amount survive a crash before signing.
export async function withdrawPlatform({ store, solana, reader, authority, mint, to, amount = 'all' }) {
  try {
    const owner = authority.publicKey.toBase58();
    mint = new PublicKey(mint).toBase58(); to = new PublicKey(to).toBase58();
    const request = { authority: owner, mint, to, amount };
    const recordKey = 'platform-withdraw-' + createHash('sha256').update(owner + ':' + mint).digest('hex');
    let record = store.get(recordKey);
    if (record?.phase === 'complete' && JSON.stringify(request) === JSON.stringify(record.request)) {
      // Also cover a crash after saving completion but before stdout reaches the owner. Fresh fees or a
      // different request allow another withdrawal; an unchanged vault replays the completed result.
      const balance = await reader.platformBalance(mint, { minContextSlot: record.slot });
      if (balance === record.vaultAfter) return amount === 'all' && balance === '0'
        ? { ok: true, empty: true, message: 'Platform fee vault is empty' }
        : { ok: true, signature: record.signature, slot: record.slot, vaultAfter: balance, existing: true };
    }
    if (record && record.phase !== 'complete') {
      if (JSON.stringify(request) !== JSON.stringify(record.request)) throw new Error('A platform withdrawal is pending; repeat its destination, mint and amount first');
    } else {
      const state = await reader.platform();
      if (state.authority !== owner || state.collector !== owner) throw new Error('Platform authority does not match config');
      const decimals = await reader.decimals(mint), balance = BigInt(await reader.platformBalance(mint));
      const n = amount === 'all' ? balance : amountUnits(amount, decimals);
      if (n === 0n) return { ok: true, empty: true, message: 'Platform fee vault is empty' };
      if (n > balance) throw new Error('Withdrawal exceeds platform fee vault balance');
      record = { id: randomBytes(32).toString('hex'), request, amount: n.toString(), decimals, phase: 'requested' };
      store.put(recordKey, record);
    }
    const result = await solana.withdrawPlatformFees({ id: record.id, mint, to, amount: record.amount, decimals: record.decimals,
      afterSign: () => authority.secretKey.fill(0) });
    if (!result.ok) throw new Error(result.reason);
    record.phase = 'complete'; record.signature = result.signature; record.slot = result.slot; record.vaultAfter = result.vaultAfter;
    store.put(recordKey, record);
    return result;
  } finally { authority.secretKey.fill(0); }
}
