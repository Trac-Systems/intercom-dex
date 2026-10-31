import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import MessageOrchestrator from '../../../peer/node_modules/trac-msb/src/core/network/services/MessageOrchestrator.js';
import PendingRequestService from '../../../peer/node_modules/trac-msb/src/core/network/services/PendingRequestService.js';
import { createConfig, ENV } from '../../../peer/node_modules/trac-msb/src/config/env.js';
import { publicKeyToAddress } from '../../../peer/node_modules/trac-msb/src/utils/helpers.js';
import { ResultCode } from '../../../peer/node_modules/trac-msb/src/utils/constants.js';
import { fanOutValidatorSends } from '../../../peer/runtime/fanout.js';

function fixture(t) {
  const config = createConfig(ENV.DEVELOPMENT, { maxRetries: 1 });
  const pending = new PendingRequestService(config), sent = [], removed = [];
  const validators = ['11', '22', '33', '44', '55'].map(byte => byte.repeat(32));
  const manager = {
    connectedValidators: () => validators.filter(key => !removed.includes(key)),
    pickRandomValidator: pool => pool[0],
    pickRandomConnectedValidator() { return this.pickRandomValidator(this.connectedValidators()); },
    getConnection: () => ({ protocolSession: { preferredProtocol: 'v1', supportedProtocols: { LEGACY: 'legacy', V1: 'v1' } } }),
    sendSingleMessage(message, validator) {
      sent.push({ message, validator });
      return pending.registerPendingRequest(validator, message);
    },
    incrementSentCount() {}, getSentCount: () => 0,
    remove(key) { removed.push(key); }
  };
  const orchestrator = new MessageOrchestrator(manager, { waitForUnsigned: async () => true }, config);
  // No sockets or signing keys: transport authentication is outside this scheduling test.
  orchestrator.setWallet({ address: publicKeyToAddress('aa'.repeat(32), config), sign: () => Buffer.alloc(64) });
  fanOutValidatorSends({ validatorMessageOrchestrator: orchestrator, validatorConnectionManager: manager });
  const message = { type: 13, address: publicKeyToAddress('aa'.repeat(32), config), tro: {
    tx: 'bb'.repeat(32), txv: 'cc'.repeat(32), in: 'dd'.repeat(32),
    to: publicKeyToAddress('ee'.repeat(32), config), am: '00'.repeat(15) + '01', is: '00'.repeat(64)
  } };
  t.after(() => pending.close());
  return { config, pending, sent, removed, send: () => orchestrator.send(message) };
}

async function sentCount(sent, count) {
  const deadline = performance.now() + 1000;
  while (sent.length < count && performance.now() < deadline) await setImmediate();
  assert.equal(sent.length, count);
}

test('V1 fan-out accepts a response after three seconds without waiting for the other validators', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(t);
  assert.equal(f.config.pendingRequestTimeout, 10000);
  assert.equal(f.config.txCommitTimeout, 5000);
  let settled = false;
  const result = f.send().then(value => { settled = true; return value; });
  await sentCount(f.sent, 3);
  assert.equal(new Set(f.sent.map(row => row.validator)).size, 3);
  assert.equal(new Set(f.sent.map(row => row.message.id)).size, 3);
  t.mock.timers.tick(5001);
  await setImmediate();
  assert.equal(settled, false);
  assert.ok(f.sent.every(row => f.pending.has(row.message.id)));
  assert.deepEqual(f.removed, []);
  f.pending.resolvePendingRequest(f.sent[1].message.id, ResultCode.OK);
  assert.equal(await result, true);
  assert.ok(f.pending.has(f.sent[0].message.id));
  assert.ok(f.pending.has(f.sent[2].message.id));
  for (const row of f.sent) f.pending.resolvePendingRequest(row.message.id, ResultCode.OK);
});

test('V1 fan-out timeouts retry once per attempt and settle false when validators stay silent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = fixture(t);
  let settled = false;
  const result = f.send().then(value => { settled = true; return value; });
  await sentCount(f.sent, 3);
  t.mock.timers.tick(9999);
  await setImmediate();
  assert.equal(f.sent.length, 3);
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await sentCount(f.sent, 6);
  assert.ok(f.sent.slice(0, 3).every(row => !f.pending.has(row.message.id)));
  assert.ok(f.sent.slice(3).every(row => f.pending.has(row.message.id)));
  t.mock.timers.tick(10000);
  assert.equal(await result, false);
  assert.equal(f.sent.length, 6, 'retries do not create another three-way fan-out');
  assert.ok(f.sent.every(row => !f.pending.has(row.message.id)));
  assert.ok(f.sent.every(row => row.message.broadcast_transaction_request.data.equals(f.sent[0].message.broadcast_transaction_request.data)));
});
