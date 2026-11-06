import test from 'node:test';
import assert from 'node:assert/strict';
import { stakePenaltyCases } from '../../e2e/stake-penalty-cases.mjs';

test('named acceptance failures retain their stage and do not prevent subsequent cases', async () => {
  let offers = 0; const snapshots = [];
  const results = await stakePenaltyCases({ cases: ['inside-grace', 'after-grace'],
    wallets: { alice: { address: 'local fixture' } }, log: () => {}, setAttack: async () => {},
    saveResults: async rows => snapshots.push(structuredClone(rows)),
    api: async (name, method, route) => {
      if (route === '/stake') return { stake: { free: '25000', operationPending: false } };
      assert.equal(route, '/offer'); offers++; throw Error('test offer unavailable');
    },
    until: async (label, fn) => { if (!await fn()) throw Error('Timed out: ' + label); },
  });
  assert.equal(offers, 2); assert.equal(results.length, 2);
  assert.deepEqual(results.map(r => [r.name, r.ok, r.stage]), [['inside-grace', false, 'covered offer'], ['after-grace', false, 'covered offer']]);
  assert.equal(snapshots[0].length, 1); assert.deepEqual(snapshots.at(-1), results);
});

test('unknown acceptance rows fail before an offer or any fixture funding', async () => {
  await assert.rejects(stakePenaltyCases({ cases: ['typo'], api: () => assert.fail('no action') }), /Unknown stake acceptance case/);
});

test('inventory waits for a prior reservation and recovers a lost deposit response without depositing twice', async () => {
  let reads = 0, deposits = 0;
  const result = await stakePenaltyCases({ cases: ['after-grace'], log: () => {}, setAttack: async () => {}, saveResults: async () => {},
    wallets: { alice: { address: 'local fixture' } },
    api: async (name, method, route) => {
      if (route === '/stake') {
        reads++;
        return { stake: { free: reads >= 4 ? '25000' : '0', reserved: reads === 1 ? '25000' : '0', operationPending: reads === 3 } };
      }
      if (route === '/stake/deposit') { deposits++; throw Error('alice /stake/deposit: Stake response timed out'); }
      if (route === '/offer') throw Error('stop after recovered inventory');
      assert.fail(route);
    },
    until: async (label, fn) => {
      for (let i = 0; i < 4; i++) if (await fn()) return true;
      throw Error('Timed out: ' + label);
    } });
  assert.equal(deposits, 1); assert.equal(result[0].stage, 'covered offer');
});
