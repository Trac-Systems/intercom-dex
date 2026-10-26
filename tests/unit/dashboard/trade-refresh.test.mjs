import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorList } from '../../../src/dashboard/static/vlist.js';
import { api } from '../../../src/dashboard/static/dom.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
function dom(t) {
  class Element {
    constructor() { this.children = []; this.style = {}; this.scrollTop = 0; this.clientHeight = 400; this.scrollHeight = 400; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this[key] = key === 'hidden' ? true : value; }
    addEventListener() {}
  }
  const globals = { document: { createElement: () => new Element() }, Node: Element,
    ResizeObserver: class { observe() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  }
  return Element;
}
function listing(t, fetchPage) {
  const Element = dom(t);
  const list = cursorList({ fetchPage, key: row => row.id, rowHeight: 32, label: 'Market trades', row: row => Object.assign(new Element(), { id: row.id }) });
  const ids = () => list.el.children[0].children[0].children.map(el => el.id);
  return { list, ids };
}

test('an initially empty market trade list continues polling and shows the first new execution', async t => {
  let rows = [], calls = 0;
  const f = listing(t, async () => { calls++; return { rows, next: null }; });
  await turn(); assert.deepEqual(f.ids(), []);
  rows = [{ id: 'first-trade' }];
  await f.list.refresh();
  assert.equal(calls, 2); assert.deepEqual(f.ids(), ['first-trade']);
});

test('a failed trade refresh retains rows with a warning and recovers on the next poll', async t => {
  let fail = false, rows = [{ id: 'old' }];
  const f = listing(t, async () => { if (fail) throw new Error('feed offline'); return { rows, next: null }; });
  await turn(); fail = true;
  await f.list.refresh();
  assert.deepEqual(f.ids(), ['old']); assert.equal(f.list.status.hidden, false);
  assert.match(f.list.status.textContent, /feed offline.*last.*read/i);
  fail = false; rows = [{ id: 'new' }, { id: 'old' }];
  await f.list.refresh();
  assert.deepEqual(f.ids(), ['new', 'old']); assert.equal(f.list.status.hidden, true);
});

test('a late failed refresh from the previous pair cannot overwrite the new pair status', async t => {
  let rejectOld, calls = 0;
  const f = listing(t, () => {
    calls++;
    if (calls === 2) return new Promise((_, reject) => { rejectOld = reject; });
    return Promise.resolve({ rows: [{ id: calls === 1 ? 'old-pair' : 'new-pair' }], next: null });
  });
  await turn();
  const old = f.list.refresh(); f.list.reset(); await turn();
  rejectOld(new Error('old pair offline')); await old;
  assert.deepEqual(f.ids(), ['new-pair']); assert.equal(f.list.status.hidden, true);
});

test('a stuck market HTTP request is aborted so a later poll can recover; ordinary writes keep their existing behavior', async t => {
  let aborted = false;
  t.mock.method(globalThis, 'fetch', (_path, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
  }));
  await assert.rejects(api('/api/trades', undefined, { timeoutMs: 10 }), /Request timed out/);
  assert.equal(aborted, true);
  t.mock.method(globalThis, 'fetch', async (_path, options) => {
    if (options.method === 'POST') assert.equal(options.signal, undefined);
    return { ok: true, json: async () => ({ rows: [{ id: 'recovered' }] }) };
  });
  assert.deepEqual(await api('/api/trades', undefined, { timeoutMs: 10 }), { rows: [{ id: 'recovered' }] });
  await api('/api/action', { action: 'fixture' });
});
