import { randomBytes } from 'node:crypto';
import { bytesToHex, fromLe32, le32, sha256Hex, stableJSON } from './canonical.js';
import { dealSchema, hexKey } from './schemas.js';
import { commitmentAffine, randomScalar, split, validateCommitments, verifyShare } from './vss.js';
import { openSealed, sealTo } from './seal.js';
import { boxPublic } from './keys.js';
import { tradeId as termsTradeId } from './terms.js';

export function prepareDeal({ k, committeeBoxKeys, tradeId, secretHex, rng = randomBytes }) {
  hexKey.parse(tradeId);
  if (!Number.isSafeInteger(k) || k < 1 || !Array.isArray(committeeBoxKeys) ||
      k > committeeBoxKeys.length || committeeBoxKeys.length > 16 ||
      new Set(committeeBoxKeys).size !== committeeBoxKeys.length) throw new RangeError('Invalid dealing parameters');
  committeeBoxKeys.forEach(key => hexKey.parse(key));
  const secret = secretHex === undefined ? randomScalar(rng) : fromLe32(Buffer.from(hexKey.parse(secretHex), 'hex'));
  const { coefficients, commitments, shares } = split(secret, k, committeeBoxKeys.map((_, i) => i + 1), rng);
  const sealedShares = shares.map(({ share }, i) => sealTo(le32(share), committeeBoxKeys[i], { tradeId, signerIndex: i + 1 }, rng));
  return { privateState: { secretHex: bytesToHex(le32(secret)), coefficients: coefficients.map(c => bytesToHex(le32(c))) },
    deal: { tradeId, k, committeeBoxKeys: [...committeeBoxKeys], H: sha256Hex(le32(secret)), commitments, sealedShares, proof: null } };
}

export function lockStatement(deal) {
  hexKey.parse(deal.H);
  if (!validateCommitments(deal.commitments)) throw new Error('Invalid commitments');
  const { x, y } = commitmentAffine(deal.commitments[0]);
  return [BigInt('0x' + deal.H.slice(0, 32)), BigInt('0x' + deal.H.slice(32)), x, y].map(String);
}

export function checkDealShape(deal, terms) {
  try {
    const d = dealSchema.parse(deal);
    return d.tradeId === termsTradeId(terms) && d.k === terms.k &&
      stableJSON(d.committeeBoxKeys) === stableJSON(terms.committee.map(s => s.boxKey)) && validateCommitments(d.commitments);
  } catch { return false; }
}

export function signerShareCheck(deal, mySignerIndex, myBoxSecret) {
  try {
    const d = dealSchema.parse(deal);
    if (!Number.isSafeInteger(mySignerIndex) || mySignerIndex < 1 || mySignerIndex > d.committeeBoxKeys.length ||
        bytesToHex(boxPublic(myBoxSecret)) !== d.committeeBoxKeys[mySignerIndex - 1]) return { ok: false };
    const share = fromLe32(openSealed(d.sealedShares[mySignerIndex - 1], myBoxSecret, { tradeId: d.tradeId, signerIndex: mySignerIndex }));
    return verifyShare(mySignerIndex, share, d.commitments) ? { ok: true, share } : { ok: false };
  } catch { return { ok: false }; }
}
