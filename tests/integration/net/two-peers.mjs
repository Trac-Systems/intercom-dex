// Two running dex peers: a message on intercom-dex:offers and on a trade channel reaches the other agent.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Bridge } from '../../../src/net/bridge.js';

const D = process.argv[2];
const open = (n, port) => new Bridge({ url: `ws://127.0.0.1:${port}`, token: readFileSync(`${D}/token-${n}`, 'utf8').trim() }).connect();
const [a, b] = await Promise.all([open('a', 47101), open('b', 47102)]);
const wait = (bridge, channel, match, ms = 60000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no message on ${channel}`)), ms);
  bridge.on('message', (ch, msg) => { if (ch === channel && match(msg)) { clearTimeout(t); resolve(msg); } });
});
const t0 = Date.now();
const got = wait(b, 'intercom-dex:offers', (m) => m?.hello === 'public');
// Keep sending until the peers have found each other on the topic.
const tick = setInterval(() => a.send('intercom-dex:offers', { hello: 'public' }).catch(() => {}), 1000);
await got; clearInterval(tick);
console.log('public channel ok after', Date.now() - t0, 'ms');
const trade = `intercom-dex:t:${randomBytes(32).toString('hex')}`;
await Promise.all([a.join(trade), b.join(trade)]);
const t1 = Date.now();
const got2 = wait(a, trade, (m) => m?.hello === 'trade');
const tick2 = setInterval(() => b.send(trade, { hello: 'trade' }).catch(() => {}), 1000);
await got2; clearInterval(tick2);
console.log('trade channel ok after', Date.now() - t1, 'ms', trade);
a.close(); b.close();
