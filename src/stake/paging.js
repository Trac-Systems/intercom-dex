import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { sha256Hex, stableJSON } from '../core/canonical.js';

export const STAKE_MESSAGE_BYTES = 180000;
export const STAKE_PAGE_BYTES = 90000;
export const STAKE_BODY_BYTES = 8 * 1024 * 1024;
export const STAKE_BUFFER_BYTES = 32 * 1024 * 1024;
export const STAKE_TRANSFERS = 16;
export const STAKE_TRANSFER_MS = 30000;
// Public venue traffic can use 32 kB/s; leave 8 kB/s of the payout's existing
// 64 kB/s inbound budget for framing/control traffic.
export const STAKE_PAYOUT_RATE = 24000;
const hex = value => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);

export function packStakeBody(body) {
  const raw = Buffer.from(stableJSON(body));
  if (raw.length > STAKE_BODY_BYTES) throw new Error('Stake body exceeds paging limit');
  const compressed = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
  const data = compressed.length < raw.length ? compressed : raw;
  return { data, bytes: data.length, rawBytes: raw.length, pages: Math.ceil(data.length / STAKE_PAGE_BYTES),
    digest: sha256Hex(raw), encoding: data === raw ? 'json' : 'br' };
}

export function validStakeManifest(m) {
  return m && Object.keys(m).sort().join(',') === 'bytes,digest,encoding,kind,pages,rawBytes,transfer' &&
    hex(m.transfer) && hex(m.digest) && ['stakeRequest', 'stakeReply'].includes(m.kind) && ['json', 'br'].includes(m.encoding) &&
    Number.isSafeInteger(m.bytes) && m.bytes > 0 && m.bytes <= STAKE_BODY_BYTES &&
    Number.isSafeInteger(m.rawBytes) && m.rawBytes > 0 && m.rawBytes <= STAKE_BODY_BYTES &&
    m.pages === Math.ceil(m.bytes / STAKE_PAGE_BYTES) &&
    (m.encoding !== 'json' || m.rawBytes === m.bytes);
}

export function unpackStakeBody(manifest, pages) {
  const data = Buffer.concat(pages, manifest.bytes);
  const raw = manifest.encoding === 'br' ? brotliDecompressSync(data, { maxOutputLength: manifest.rawBytes }) : data;
  if (raw.length !== manifest.rawBytes || sha256Hex(raw) !== manifest.digest) throw new Error('Stake body digest differs');
  const body = JSON.parse(raw.toString('utf8'));
  if (!body || Array.isArray(body) || typeof body !== 'object' || !Buffer.from(stableJSON(body)).equals(raw))
    throw new Error('Noncanonical stake body');
  return body;
}
