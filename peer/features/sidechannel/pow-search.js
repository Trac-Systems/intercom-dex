import b4a from 'b4a';
import sodium from 'sodium-universal';

export class PowSearch {
  constructor(prefix, suffix, nonce = 0) {
    this.base = b4a.alloc(sodium.crypto_hash_sha256_STATEBYTES);
    this.state = b4a.alloc(this.base.length);
    this.hash = b4a.alloc(32);
    this.prepare(prefix, suffix, nonce);
  }

  prepare(prefix, suffix, nonce = 0) {
    sodium.crypto_hash_sha256_init(this.base);
    sodium.crypto_hash_sha256_update(this.base, b4a.from(prefix));
    this.suffix = b4a.from(suffix);
    this.nonce = nonce;
    this.digits = String(nonce).length;
    this.resize();
  }

  resize() {
    this.tail = b4a.allocUnsafe(this.digits + this.suffix.length);
    b4a.copy(this.suffix, this.tail, this.digits);
    let value = this.nonce;
    for (let i = this.digits - 1; i >= 0; i--) {
      this.tail[i] = 48 + value % 10;
      value = Math.floor(value / 10);
    }
  }

  // The deadline is checked at the original 256-nonce boundaries.
  run(difficulty, until = Date.now() + 8, end = Infinity) {
    const { base, state, hash } = this;
    do {
      if (this.nonce >= end) return -1;
      b4a.copy(base, state);
      sodium.crypto_hash_sha256_update(state, this.tail);
      sodium.crypto_hash_sha256_final(state, hash);
      let bits = 0;
      for (let i = 0; i < hash.length; i++) {
        if (hash[i]) { bits += Math.clz32(hash[i]) - 24; break; }
        bits += 8;
      }
      if (bits >= difficulty) return this.nonce;
      this.nonce++;
      let digit = this.digits - 1;
      while (digit >= 0 && this.tail[digit] === 57) this.tail[digit--] = 48;
      if (digit >= 0) this.tail[digit]++;
      else { this.digits++; this.resize(); }
    } while (this.nonce % 256 !== 0 || Date.now() < until);
    return -1;
  }
}
