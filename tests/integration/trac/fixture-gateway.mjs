import { resetSourceURL } from '../../reset-source.mjs';
import { fixtureValidatorHealth } from './fixture-validators.mjs';

const { default: Gateway } = await import(resetSourceURL('features/gateway/index.js'));

// The reference gateway predates /v1/state validator metadata. Keep its real
// transaction implementation and report the actual shared MSB client's health.
export default class FixtureGateway extends Gateway {
  async handle(req, res) {
    if (req.method !== 'GET' || req.url !== '/v1/state') return super.handle(req, res);
    try {
      const [state, validators] = await Promise.all([this.api.coinState(), fixtureValidatorHealth(this.options.msb)]);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...state, validators }));
    } catch {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ validators: null }));
    }
  }
}
