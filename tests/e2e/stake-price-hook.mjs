import { readFileSync } from 'node:fs';
import { isMainThread } from 'node:worker_threads';
import { StakePriceService } from '../../src/stake/price-service.js';

// Read-only public price diagnostics for the exact-withdrawal midnight fixture.
// Production completion, quorum, history and price validation run unchanged.
if (isMainThread) {
  const index = process.argv.indexOf('--config');
  const config = index >= 0 && JSON.parse(readFileSync(process.argv[index + 1], 'utf8'));
  if (!process.env.DEX_E2E_ATTACK_FILE || config?.network !== 'local' || config.role !== 'service' ||
      !config.solana?.endpoints?.length || config.solana.endpoints.some(e => !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(e).hostname)))
    throw Error('Price diagnostics require the local venue fixture');
  const apply = StakePriceService.prototype.apply;
  StakePriceService.prototype.apply = async function(method, ...args) {
    const result = await apply.call(this, method, ...args);
    if (method === 'priceSnapshot') {
      const { entry, hash } = this.log().entry(result.reference.lastLogPosition);
      console.log('DEX_E2E_PRICE_CERTIFIED', JSON.stringify({ entry, hash }));
      console.log('DEX_E2E_PRICE_REFERENCE', JSON.stringify(result.reference));
    }
    return result;
  };
}
