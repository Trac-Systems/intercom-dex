import { makeLockCertificate, verifyLock } from '../proof/lockproof.js';
import { lockStatement } from '../core/dealing.js';
import { bytesToHex, fromLe32, hexToBytes, sha256Hex } from '../core/canonical.js';
import { polynomialCommitments, SCALAR_ORDER } from '../core/vss.js';

// Each process owns its encrypted role store. A reserved entry cannot be handed to another live trade;
// after a crash the durable assignment in the trade record excludes it even if deletion did not finish.
export class CertificatePool {
  constructor({ store, proof, log = () => {}, make = makeLockCertificate, verify = verifyLock }) {
    const target = proof.pool ?? 2;
    if (!Number.isSafeInteger(target) || target < 0) throw new Error('proof.pool must be a nonnegative integer');
    Object.assign(this, { store, proof, target, log, make, verify });
    this.reserved = new Set();
    for (const name of store.list('trade-')) {
      const H = store.get(name)?.state?.certificate?.H;
      if (!H) continue;
      this.reserved.add(H);
      // A crash after the assignment was persisted but before deletion leaves the entry behind; finish that here.
      this.consumed(H);
    }
  }

  available() { return this.store.list('certpool-').filter(name => !this.reserved.has(name.slice(9))); }

  take() {
    const name = this.available()[0];
    if (!name) { this.log('certificate pool empty; proving on demand'); return null; }
    const entry = this.store.get(name);
    this.reserved.add(entry.H);
    return entry;
  }

  // Called only after the trade state containing the full assignment has been persisted.
  consumed(H) { if (H) this.store.delete('certpool-' + H); }

  start() { this.stopped = false; this.timer = setInterval(() => this.refill(), 1000); this.refill(); }
  stop() { this.stopped = true; clearInterval(this.timer); }

  async refill() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      if (this.available().length >= this.target) return;
      const entry = await this.make({ zkeyPath: this.proof.zkey });
      if (!entry || this.stopped) return;
      const bytes = hexToBytes(entry.secretHex, 32), scalar = fromLe32(bytes);
      if (!scalar || scalar >= SCALAR_ORDER || sha256Hex(bytes) !== entry.H ||
          polynomialCommitments([scalar])[0] !== entry.C0 || bytesToHex(bytes) !== entry.secretHex ||
          !await this.verify(lockStatement({ H: entry.H, commitments: [entry.C0] }), entry.proof)) {
        throw new Error('Invalid generated certificate');
      }
      if (this.stopped || this.reserved.has(entry.H) || this.store.get('certpool-' + entry.H)) return;
      this.store.put('certpool-' + entry.H, entry);
    } catch { this.log('certificate pool refill failed'); }
    finally { this.busy = false; }
  }
}
