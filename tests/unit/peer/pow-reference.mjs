import b4a from '../../../peer/node_modules/b4a/index.js';
import sodium from '../../../peer/node_modules/sodium-universal/index.js';

export const fixture = (n, ts = 100000) => ({
  id: `stamp-${n}`, channel: ['test', 'intercom-dex:offers', '私信:é🦊'][n % 3],
  from: n % 2 ? 'a'.repeat(64) : null, origin: n % 3 ? '來源🦊' : null, ts,
  message: { text: 'é🦊\\"\n'.repeat([0, 1, 55, 56, 63, 64, 65, 1000, 15000][n % 9]), nested: { z: [null, false, n], a: '𐀀' } }
});

const countLeadingZeroBits = bytes => {
  let bits = 0;
  for (const byte of bytes) {
    if (byte) return bits + Math.clz32(byte) - 24;
    bits += 8;
  }
  return bits;
};

// The old allocating loop, retained only as an independent test/benchmark oracle.
export class OldPowSearch {
  constructor(prefix, suffix, nonce = 0) {
    this.base = b4a.alloc(sodium.crypto_hash_sha256_STATEBYTES);
    this.state = b4a.alloc(this.base.length);
    this.hash = b4a.alloc(32);
    this.prepare(prefix, suffix, nonce);
  }

  prepare(prefix, suffix, nonce = 0) {
    this.suffix = suffix;
    this.nonce = nonce;
    sodium.crypto_hash_sha256_init(this.base);
    sodium.crypto_hash_sha256_update(this.base, b4a.from(prefix));
  }

  run(difficulty, until = Date.now() + 8, end = Infinity) {
    const { base, state, hash, suffix } = this;
    let nonce = this.nonce;
    do {
      if (nonce >= end) { this.nonce = nonce; return -1; }
      b4a.copy(base, state);
      sodium.crypto_hash_sha256_update(state, b4a.from(nonce + suffix));
      sodium.crypto_hash_sha256_final(state, hash);
      if (countLeadingZeroBits(hash) >= difficulty) { this.nonce = nonce; return nonce; }
      nonce++;
    } while (nonce % 256 !== 0 || Date.now() < until);
    this.nonce = nonce;
    return -1;
  }
}

export async function oldAttachPow(payload) {
  if (!this._powRequired(payload?.channel ?? '')) return;
  const difficulty = this.powDifficulty, level = this._powClass(payload.message);
  const urgent = () => this.powPending.findIndex((n, i) => i < level && n > 0);
  const search = new OldPowSearch(...this._powParts(payload));
  for (;;) {
    for (let i = urgent(); i >= 0; i = urgent()) await this.powQueues[i];
    if (this._now() - payload.ts >= 30000) { payload.ts = this._now(); search.prepare(...this._powParts(payload)); }
    const nonce = search.run(difficulty);
    if (nonce >= 0) { payload.pow = { nonce, difficulty }; return; }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
