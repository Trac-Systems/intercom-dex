import test from 'node:test';
import assert from 'node:assert/strict';
import { stack } from '../../integration/locks/harness.mjs';
import { address } from '../../../src/locks/trac-lock.js';
import { scalarSigner } from '../../../src/locks/crypto/scalar-sign.js';

const foreign = address(scalarSigner(999n).publicKey);
function balances(reads) {
  return ({ address: target }) => {
    reads.push(target);
    return { final: true, RESET: target === foreign ? '1000000000' : '0',
      TNK: target === foreign ? '1000000000000000000' : '0', feeTnk: '30' };
  };
}

for (const product of ['loan', 'call']) for (const asset of ['RESET', 'TNK']) {
  test(`${product}/${asset}: a wealthy declared address cannot fund a committee lock or enter the venue book`, async t => {
    const reads = [], s = await stack({ balanceRead: balances(reads) }); t.after(s.stop);
    s.clients[0].trac = foreign;
    const id = await s.post(product, asset), lock = s.signers[0].positions.get(id).lock;
    assert.ok(reads.length >= 5);
    assert.ok(reads.every(target => target === address(lock.A) && target !== foreign));
    assert.ok(s.signers.every(signer => signer.positions.get(id).state === 'funding'));
    assert.equal(s.venue.positions.get(id).state, 'creating');
    await s.take(id);
    assert.equal(s.sent.filter(x => ['posted', 'reserve', 'opened'].includes(x.raw.kind)).length, 0);
  });
}

for (const asset of ['RESET', 'TNK']) {
  test(`put/${asset}: a wealthy holder address cannot substitute for the funded holder lock`, async t => {
    const reads = [], s = await stack({ balanceRead: balances(reads) }); t.after(s.stop);
    s.clients[1].trac = foreign;
    const id = await s.post('put', asset), takeId = await s.take(id);
    const holder = s.signers[0].positions.get(id).holders[takeId];
    assert.ok(reads.length >= 5);
    assert.ok(reads.every(target => target === address(holder.lock.A) && target !== foreign));
    await s.pay(id, 'open:' + takeId);
    assert.ok(s.signers.every(signer => signer.positions.get(id).state === 'posted'));
    assert.equal(s.venue.positions.get(id).state, 'posted');
    assert.equal(s.sent.filter(x => x.raw.kind === 'opened').length, 0);
  });
}
