// Test-only delayed finality observation: the real transfer is independently read on the local Trac devnet after
// the normal window. Its real observation journal is then accepted by the existing operator rescue path.
import { readFileSync } from 'node:fs';
import { Signer } from '../../src/roles/signer.js';
const start = Signer.prototype.start;
Signer.prototype.start = function() {
  const verify = this.host.trac.verifyTransfer.bind(this.host.trac);
  this.host.trac.verifyTransfer = async input => {
    const selected = JSON.parse(readFileSync(process.env.DEX_E2E_ATTACK_FILE, 'utf8'));
    if (selected.kind === 'late-rescue' && input.from === selected.sellerAddr && Math.floor(Date.now() / 1000) < input.finalBefore && !selected.release) {
      return { ok: false, final: false, reason: 'test reader has not observed finality yet' };
    }
    return verify(input);
  };
  return start.call(this);
};
