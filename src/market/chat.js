import { createReplayCache, open } from '../core/envelope.js';
import { chatSinceSchema, hexKey } from '../core/schemas.js';

export const CHAT_CHANNEL = 'intercom-dex:chat';
// Bidirectional controls and zero-width characters can make text read differently from what it says.
const HIDDEN = /[\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

// Receipt times, not sender timestamps, enforce the rolling limits. Live entries are never evicted for capacity.
export class MarketChat {
  #seen;
  #senders = new Map();
  #messages = [];

  constructor({ now = () => Math.floor(Date.now() / 1000), maxSenders = 4096, maxReplayEntries = 65536, chatRelays = [] } = {}) {
    if (!Number.isSafeInteger(maxSenders) || maxSenders < 1) throw new RangeError('Invalid chat sender bound');
    if (!Array.isArray(chatRelays) || chatRelays.length > 128 || new Set(chatRelays).size !== chatRelays.length) throw new TypeError('Invalid chat relays');
    this.relays = new Set(chatRelays.map(key => hexKey.parse(key)));
    this.now = now;
    this.maxSenders = maxSenders;
    this.#seen = createReplayCache({ maxEntries: maxReplayEntries });
  }

  receive(raw) {
    if (raw?.kind !== 'chat' || raw.ch !== CHAT_CHANNEL) return null;
    const now = this.now();
    if (!Number.isSafeInteger(raw.body?.ts) || Math.abs(now - raw.body.ts) > 300 || raw.body.ts !== raw.ts) return null;
    let message;
    try { message = open(raw, { now, seen: this.#seen, maxAgeSec: 300, maxFutureSec: 300 }); }
    catch { return null; }
    const text = message.body.text.replace(HIDDEN, '').trim();
    if (!text) return null;
    for (const [key, entries] of this.#senders) if (entries.at(-1).at <= now - 3600) this.#senders.delete(key);
    const entries = (this.#senders.get(message.from) ?? []).filter(entry => entry.at > now - 3600);
    const viewer = this.relays.has(message.from);
    if ((!entries.length && this.#senders.size >= this.maxSenders) || entries.length >= (viewer ? 600 : 20) ||
        (entries.length && now - entries.at(-1).at < (viewer ? 1 : 10)) ||
        entries.some(entry => entry.text === text && (!viewer || entry.name === message.body.name) && now - entry.at < 600)) return null;
    entries.push({ at: now, text, name: message.body.name });
    this.#senders.set(message.from, entries);
    const record = { from: message.from, nonce: message.nonce, ...message.body, text, ...(viewer ? { viewer: true } : {}) };
    this.#messages.push(record);
    if (this.#messages.length > 100) this.#messages.shift();
    return { ...record };
  }

  read(since) {
    if (since !== undefined) chatSinceSchema.parse(since);
    return this.#messages.filter(message => since === undefined || message.ts > since).map(message => ({ ...message }));
  }
}
