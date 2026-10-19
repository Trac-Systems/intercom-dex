// Standalone unit check: bare tests/unit/chat/bare-check.mjs. No peers, sockets or files are opened.
import { randomBytes } from '../../../peer/node_modules/crypto/index.js';
import { dexTransport } from '../../../peer/features/dex-transport.js';

const { seal } = await import('../../../src/core/envelope.js');
const { CHAT_CHANNEL } = await import('../../../src/market/chat.js');
const policy = dexTransport({ role: 'service', servicePeerKey: 'a'.repeat(64) }).sidechannel;
const secret = randomBytes(32), ts = Math.floor(Date.now() / 1000);
const sign = text => seal({ kind: 'chat', ch: CHAT_CHANNEL, body: { text, ts } }, secret,
  { ts, nonce: randomBytes(32).toString('hex') });
const raw = sign('Hello market 🌎');
const check = (message, expected) => {
  if (policy.acceptMessage(CHAT_CHANNEL, { message }) !== expected) throw Error('Unexpected chat admission result');
};
check({}, false);
check({ ...raw, sig: '0'.repeat(128) }, false);
check(raw, true);
check(raw, false);
check(sign('Too soon'), false);
secret.fill(0);
console.log('Bare chat signatures, replay and rate limits passed');
