import { createHash } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import PeerWallet from '../../peer/node_modules/trac-wallet/index.js';

const HEX32 = /^[0-9a-f]{64}$/;
const MAX_TNK = (1n << 128n) - 1n;

function hex32(value, name) {
  if (typeof value !== 'string' || !HEX32.test(value)) throw new Error(`Invalid ${name}`);
  return Buffer.from(value, 'hex');
}

function amountBytes(amount, asset) {
  if (typeof amount !== 'string' || !/^[1-9][0-9]*$/.test(amount) || amount.length > 78) throw new Error('Invalid amount');
  if (asset === 'TNK') {
    if (BigInt(amount) > MAX_TNK) throw new Error('TNK amount exceeds uint128');
    return Buffer.from(BigInt(amount).toString(16).padStart(32, '0'), 'hex');
  }
}

function addressKey(address, prefix) {
  if (typeof prefix !== 'string' || !/^[a-z]{1,31}$/.test(prefix) || typeof address !== 'string' || !address.startsWith(`${prefix}1`)) throw new Error('Invalid address');
  const key = PeerWallet.decodeBech32mSafe(address);
  if (key?.length !== 32 || PeerWallet.encodeBech32mSafe(prefix, key) !== address) throw new Error('Invalid address');
  return key;
}

function uint32(value) {
  if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) throw new Error('Invalid networkId');
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

async function signature(hash, publicKey, sign) {
  if (typeof sign !== 'function') throw new Error('Missing sign callback');
  const signed = await sign(Buffer.from(hash));
  if (typeof signed !== 'string' || !/^[0-9a-f]{128}$/.test(signed) || !ed25519.verify(Buffer.from(signed, 'hex'), hash, publicKey)) throw new Error('Invalid signer signature');
  return signed;
}

// The trade ID is decoded to 32 bytes, not hashed as 64 ASCII hex characters.
export function transferNonce(tradeId) {
  return createHash('sha256').update('intercom-dex/v1/transfer', 'utf8').update(hex32(tradeId, 'tradeId')).digest('hex');
}

export async function buildTnkTransfer({ networkId, txv, from, to, amount, tradeId, sign, addressPrefix = 'trac' }) {
  const sender = addressKey(from, addressPrefix);
  addressKey(to, addressPrefix);
  const am = amountBytes(amount, 'TNK');
  const nonce = transferNonce(tradeId);
  const hash = blake3(Buffer.concat([uint32(networkId), hex32(txv, 'txv'), Buffer.from(to, 'ascii'), am, Buffer.from(nonce, 'hex'), uint32(13)]));
  return { type: 13, address: from, tro: { tx: Buffer.from(hash).toString('hex'), txv, to, am: am.toString('hex'), in: nonce, is: await signature(hash, sender, sign) } };
}

export async function buildResetTransfer({ networkId, txv, writer, subnet, msb, from, to, amount, tradeId, sign, addressPrefix = 'trac' }) {
  if (typeof addressPrefix !== 'string' || !/^[a-z]{1,31}$/.test(addressPrefix)) throw new Error('Invalid address prefix');
  const sender = hex32(from, 'from');
  hex32(to, 'to');
  amountBytes(amount, 'RESET');
  const nonce = transferNonce(tradeId);
  const prepared_command = { type: 'transfer', value: { to, amount } };
  const ch = Buffer.from(blake3(Buffer.from(JSON.stringify(prepared_command), 'utf8'))).toString('hex');
  const hash = blake3(Buffer.concat([uint32(networkId), hex32(txv, 'txv'), hex32(writer, 'writer'), Buffer.from(ch, 'hex'), hex32(subnet, 'subnet'), hex32(msb, 'msb'), Buffer.from(nonce, 'hex'), uint32(12)]));
  const tx = Buffer.from(hash).toString('hex');
  const signed = await signature(hash, sender, sign);
  const address = PeerWallet.encodeBech32mSafe(addressPrefix, sender);
  addressKey(address, addressPrefix);
  return {
    payload: { type: 12, address, txo: { tx, txv, iw: writer, ch, bs: subnet, mbs: msb, in: nonce, is: signed } },
    submission: { tx, prepared_command, address: from, signature: signed, nonce }
  };
}
