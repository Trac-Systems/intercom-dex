import test from 'node:test';
import assert from 'node:assert/strict';
import { bookPanel } from '../../../src/dashboard/static/book.js';
import { NETWORK_RECONNECTING } from '../../../src/net/network-watchdog.js';
import { createModel } from '../../../src/dashboard/model.js';
import { traderFixture } from './fixtures.mjs';

test('dashboard exposes the network warning independently of empty books and clears it on recovery', async () => {
  const f = traderFixture(), status = f.role.status.bind(f.role);
  let reconnecting = true;
  f.role.status = () => ({ ...status(), network: { reconnecting, message: reconnecting ? NETWORK_RECONNECTING : '' } });
  const model = createModel(f);
  assert.equal((await model.state()).trader.network.message, NETWORK_RECONNECTING);
  assert.ok((await model.list('trader.attention')).rows.some(a => a.kind === 'network' && a.text === NETWORK_RECONNECTING));
  reconnecting = false;
  assert.equal((await model.state()).trader.network.message, '');
  assert.ok(!(await model.list('trader.attention')).rows.some(a => a.kind === 'network'));
});

test('empty book explains network recovery and restores its normal wording after traffic returns', t => {
  class Element {
    constructor() { this.children = []; this.style = {}; this.scrollTop = 0; this.clientHeight = 400; this.scrollHeight = 400; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this[key] = key === 'hidden' ? true : value; }
    addEventListener() {}
  }
  for (const [key, value] of Object.entries({ document: { createElement: () => new Element() }, Node: Element,
    ResizeObserver: class { observe() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} })) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (before) Object.defineProperty(globalThis, key, before); else delete globalThis[key]; });
  }
  const panel = bookPanel({ onTake() {} }), find = (node, cls) =>
    [node, ...node.children.flatMap(child => child instanceof Element ? find(child, cls) : [])].filter(el => el.className === cls);
  panel.set({ base: 'TNK', asks: [], bids: [], spread: null }, 2);
  const notes = find(panel.el, 'vl-empty');
  assert.equal(notes.length, 2); assert.ok(notes.every(n => !n.hidden));
  panel.network(NETWORK_RECONNECTING);
  assert.deepEqual(notes.map(n => n.textContent), [NETWORK_RECONNECTING, NETWORK_RECONNECTING]);
  panel.network('');
  assert.deepEqual(notes.map(n => n.textContent), ['No sell offers', 'No buy offers']);
});
