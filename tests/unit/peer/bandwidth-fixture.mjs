import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Corestore from '../../../peer/node_modules/corestore/index.js';
import Autobase from '../../../peer/node_modules/autobase/index.js';
import Hyperbee from '../../../peer/node_modules/hyperbee/index.js';
import c from '../../../peer/node_modules/compact-encoding/index.js';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
import { dexTransport } from '../../../peer/features/dex-transport.js';
import { Bandwidth } from '../../../peer/runtime/bandwidth.js';
import { BookFeed } from '../../../src/market/book-feed.js';
import { generateIdentity, encodeKey } from '../../../src/core/keys.js';
import { ed25519 } from '@noble/curves/ed25519.js';

export const difference = (before, after) => after.rows.map(row => {
  const old = before.rows.find(old => ['layer', 'subsystem', 'detail', 'direction'].every(key => old[key] === row[key]));
  return { ...row, bytes: row.bytes - (old?.bytes ?? 0),
    ...(row.events === undefined ? {} : { events: row.events - (old?.events ?? 0) }) };
}).filter(row => row.bytes > 0);

// A closed local mesh using the real sidechannel encoder, admission, dedupe and relay code. No network or clocks.
export async function measurePublic({ legacy = false, legacyNodes = [], traders = 24, seconds = 60, books = false } = {}) {
  let now = 1000000;
  const queue = [], nodes = [];
  const channels = ['intercom-dex:offers', 'intercom-dex:signers', 'intercom-dex'];
  const identity = generateIdentity(), publicKey = encodeKey(identity.publicKey);
  const wallet = { publicKey, sign: bytes => Buffer.from(ed25519.sign(bytes, identity.secretKey)) };
  const old = index => legacy || legacyNodes.includes(index);
  for (let i = 0; i < traders + 6; i++) {
    const role = i === 0 ? 'service' : i < 6 ? 'signer' : 'trader';
    const config = dexTransport({ role, servicePeerKey: publicKey }).sidechannel;
    if (old(i)) { delete config.noRelayChannels; delete config.publicDelivery; }
    const bandwidth = new Bandwidth({ now: () => now });
    const delivered = [];
    const sc = new Sidechannel(i === 0 ? { wallet } : {}, { ...config, powEnabled: false, bandwidth,
      rateBytesPerSecond: 0, onMessage: (ch, p) => delivered.push({ ch, p }) });
    sc._now = () => now;
    for (const channel of channels) sc._registerChannel(channel);
    nodes.push({ sc, bandwidth, delivered });
  }
  for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
    if (!old(a) && !old(b) && a >= 6 && b >= 6) continue;
    const handlers = [new Map(), new Map()], delivery = [];
    for (const [from, to, side] of [[a, b, 0], [b, a, 1]]) {
      const connection = { remotePublicKey: to === 0 ? Buffer.from(publicKey, 'hex') : Buffer.alloc(32, to), userData: { createChannel(options) {
        const { protocol } = options;
        if (protocol === 'intercom-dex-delivery-v1') return {
          opened: true,
          addMessage(handler) {
            delivery[side] = { handler };
            return { send(flag) { queue.push(() => delivery[1 - side]?.handler.onmessage(flag)); } };
          },
          open(flag) {
            Object.assign(delivery[side], { flag, open: options.onopen });
            queue.push(() => { if (delivery[1 - side]) options.onopen(delivery[1 - side].flag); });
          },
          close: options.onclose,
        };
        const session = { opened: true, open() {}, fullyOpened: () => Promise.resolve(true), addMessage(handler) {
          handlers[side].set(protocol, handler);
          return { send(payload) { queue.push(() => {
            const target = handlers[1 - side].get(protocol), bytes = c.encode(c.json, payload);
            if (!target) return; // A venue-only leaf never opens public protocols to this neighbor.
            const decoded = target.encoding.decode({ start: 0, end: bytes.length, buffer: bytes });
            target.onmessage(decoded);
          }); return true; } };
        } };
        return session;
      } } };
      for (const entry of nodes[from].sc.channels.values()) nodes[from].sc._openChannelForConnection(connection, entry);
    }
  }
  const drain = () => { for (let i = 0; i < queue.length; i++) queue[i](); queue.length = 0; };
  drain();
  const feed = new BookFeed(); let sequence = 0;
  const offers = Array.from({ length: traders - 1 }, (_, i) => ({ offerId: i.toString(16).padStart(64, '0'),
    side: 'sell', price: `${i + 1}`, baseAmount: '1000000000000000000' }));
  // An idle observer (last node), one standing offer per other trader, and five signer heartbeats. Bodies have
  // representative wire sizes; this is a controlled traffic fixture, not a replay of the owner's live market.
  for (let second = 0; second < seconds; second += 15) {
    now = 1000000 + second * 1000;
    if (books) {
      if (second === 30) offers[0].baseAmount = '500000000000000000';
      const message = feed.next('TNK/USDC', 1, offers, now / 1000, () => ++sequence);
      if (message) { await nodes[0].sc.broadcast('intercom-dex', message); drain(); }
    }
    for (let i = 1; i < nodes.length - 1; i++) {
      const kind = i < 6 ? 'heartbeat' : 'offer', channel = i < 6 ? channels[1] : channels[0];
      await nodes[i].sc.broadcast(channel, { kind, body: { fixture: 'x'.repeat(kind === 'offer' ? 1800 : 700), index: i, second } });
      drain();
    }
  }
  const observer = nodes.at(-1), snapshot = observer.bandwidth.snapshot();
  const reachedVenue = nodes[0].delivered.filter(x => x.p.message.kind === 'offer').length;
  const heard = observer.delivered.length;
  for (const node of nodes) { await node.sc.stop(); await node.bandwidth.close(); }
  return { seconds, traders, reachedVenue, heard, rows: snapshot.rows };
}

// A read-only Autobase replays deterministic contract writes. Large view files alone do not imply large downloads.
export async function measureReplication({ readers = 3, rounds = 2, viewBytes = 1_400_000 } = {}) {
  const directory = await fs.mkdtemp(fileURLToPath(new URL('.bandwidth-', import.meta.url)));
  const stores = [], bases = [], streams = [], meters = [];
  const open = store => new Hyperbee(store.get('view'), { extension: false, keyEncoding: 'utf-8', valueEncoding: 'json' });
  const apply = async (nodes, view) => {
    const batch = view.batch();
    for (const { value } of nodes) if (value) await batch.put('beacon/state', { header: value.header, data: 'x'.repeat(viewBytes) });
    await batch.flush(); await batch.close();
  };
  const sync = async header => {
    const deadline = Date.now() + 15000;
    for (const base of bases.slice(1)) {
      while (true) {
        await base.update();
        const view = base.view.checkout(base.view.core.signedLength);
        let value;
        try { value = (await view.get('beacon/state', { wait: false }))?.value; } finally { await view.close(); }
        if (value?.header === header) break;
        if (Date.now() > deadline) throw new Error('Local replication did not synchronize');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
  };
  try {
    for (let i = 0; i <= readers; i++) {
      const store = new Corestore(`${directory}/${i}`), meter = new Bandwidth();
      stores.push(store); meters.push(meter); meter.trackStore(store, 'reset');
      const base = new Autobase(store, i ? bases[0].key : null, { open, apply, valueEncoding: 'json' });
      bases.push(base); await base.ready();
      if (i) {
        const left = bases[0].replicate(true), right = base.replicate(false);
        left.on('error', () => {}); right.on('error', () => {});
        streams.push(left, right); left.pipe(right).pipe(left);
      }
    }
    await bases[0].append({ header: 0 }); await sync(0);
    const before = meters.map(meter => meter.snapshot());
    for (let header = 1; header <= rounds; header++) { await bases[0].append({ header }); await sync(header); }
    await new Promise(resolve => setTimeout(resolve, 20));
    return { rounds, readers, viewBytes, writer: difference(before[0], meters[0].snapshot()),
      reader: difference(before[1], meters[1].snapshot()), signedLength: bases[1].view.core.signedLength };
  } finally {
    for (const stream of streams) stream.destroy();
    for (const base of bases) await base.close();
    for (const meter of meters) await meter.close();
    for (const store of stores) await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
