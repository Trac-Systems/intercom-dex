// One virtual list for every list on the page: rows have a fixed height and only the rows in view plus a few on
// either side are in the DOM. A row the reader expands may be taller; its real height is measured once drawn.
import { h } from './dom.js';

export const OVERSCAN = 6;

// First index whose offset is above y.
function above(offsets, y) {
  let lo = 0, hi = offsets.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (offsets[m] <= y) lo = m + 1; else hi = m; }
  return lo;
}

// Each row's top (count + 1 entries) when some rows are taller than `rowHeight`. `tall` maps index -> height.
export function offsetsFor(count, rowHeight, tall) {
  const o = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) o[i + 1] = o[i] + (tall.get(i) ?? rowHeight);
  return o;
}

// The rows to draw for a scroll position: from (inclusive) to (exclusive), with `overscan` rows either side.
export function windowRange({ scrollTop, viewport, rowHeight, count, offsets = null, overscan = OVERSCAN }) {
  if (count <= 0) return { from: 0, to: 0 };
  const at = y => Math.min(count - 1, offsets ? Math.max(0, above(offsets, y) - 1) : Math.floor(Math.max(0, y) / rowHeight));
  return { from: Math.max(0, at(scrollTop) - overscan), to: Math.min(count, at(scrollTop + viewport) + 1 + overscan) };
}

// `row(item, { index, open, toggle })` builds one row element. Rows are rebuilt only when their data changed.
// anchor 'end' keeps the distance to the last row when rows come and go (the sell side of the book).
export function virtualList({ rowHeight, row, key = (r, i) => i, anchor = 'start', onRange = () => {}, className = '', label, emptyText = 'Nothing here yet.' }) {
  const win = h('div', { class: 'vl-win' }), space = h('div', { class: 'vl-space' }, win);
  const note = h('p', { class: 'vl-empty', hidden: true }, emptyText);
  const el = h('div', { class: `vl ${className}`, role: 'list', 'aria-label': label }, space, note);
  const open = new Set(), measured = new Map();
  let count = 0, get = () => null, loaded = false, placed = anchor !== 'end', frame = 0, cache = new Map(), last = { from: -1, to: -1 };

  function render() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    let offsets = null;
    if (open.size) {
      const tall = new Map();
      for (let i = 0; i < count; i++) {
        const r = get(i), k = r && key(r, i);
        if (r && open.has(k)) tall.set(i, measured.get(k) ?? rowHeight * 3);
      }
      if (tall.size) offsets = offsetsFor(count, rowHeight, tall);
    }
    space.style.height = `${offsets ? offsets[count] : count * rowHeight}px`;
    const { from, to } = windowRange({ scrollTop: el.scrollTop, viewport: el.clientHeight || 400, rowHeight, count, offsets });
    win.style.transform = `translateY(${offsets ? offsets[from] : from * rowHeight}px)`;
    const next = new Map(), kids = [];
    for (let i = from; i < to; i++) {
      const r = get(i), k = r ? key(r, i) : `…${i}`, isOpen = !!r && open.has(k);
      const sig = r ? JSON.stringify(r) + isOpen : '';
      let item = cache.get(k);
      if (!item || item.sig !== sig) {
        item = { sig, node: r ? row(r, { index: i, open: isOpen, toggle: () => toggle(k) }) : h('div', { class: 'vl-row vl-wait', role: 'listitem' }, '…') };
      }
      item.node.style.height = isOpen ? '' : `${rowHeight}px`;
      next.set(k, item); kids.push(item.node);
    }
    cache = next;
    if (kids.length !== win.children.length || kids.some((n, i) => win.children[i] !== n)) win.replaceChildren(...kids);
    note.hidden = !(loaded && count === 0);
    let grew = false;
    for (const [k, item] of next) {
      if (!open.has(k)) continue;
      const height = item.node.offsetHeight;
      if (height && height !== measured.get(k)) { measured.set(k, height); grew = true; }
    }
    if (grew) schedule();
    if (from !== last.from || to !== last.to || !loaded) { last = { from, to }; onRange(from, to); }
  }
  const schedule = () => { frame ||= requestAnimationFrame(render); };
  function toggle(k) { open.has(k) ? open.delete(k) : open.add(k); render(); }
  function toEnd() { if (el.clientHeight) { el.scrollTop = el.scrollHeight; placed = true; render(); } }

  el.addEventListener('scroll', schedule, { passive: true });
  new ResizeObserver(() => { if (!placed && loaded) toEnd(); else schedule(); }).observe(el);

  return {
    el, open,
    // New contents. `prepended` rows were added before the first one (newest first lists): what is on screen stays.
    set(n, getter = get, { prepended = 0 } = {}) {
      const fromEnd = el.scrollHeight - el.scrollTop;
      count = n; get = getter; loaded = true;
      render();
      if (anchor === 'end') { if (!placed) toEnd(); else { el.scrollTop = el.scrollHeight - fromEnd; render(); } }
      else if (prepended && el.scrollTop > 0) { el.scrollTop += prepended * rowHeight; render(); }
    },
    clear() { count = 0; loaded = false; placed = anchor !== 'end'; open.clear(); el.scrollTop = 0; render(); },
    refresh: schedule,
    emptyText(text) { note.textContent = text; },
  };
}

// Rows the server pages by offset (/api/list, /api/traffic). Blocks of `size` rows load as they come into view;
// refresh() re-reads the blocks in view and keeps the old rows on screen until the new ones are there.
export function serverList({ fetchBlock, size = 100, onPage = () => {}, ...options }) {
  const blocks = new Map(), loading = new Map();
  let total = 0, gen = 0, epoch = 0, view = { from: 0, to: 1 };
  const list = virtualList({ ...options, onRange: (from, to) => { view = { from, to }; ensure(); } });
  const rowAt = i => blocks.get(Math.floor(i / size))?.rows[i % size] ?? null;

  function ensure() {
    const lastRow = Math.max(view.from, Math.min(view.to, total) - 1);
    for (let b = Math.floor(view.from / size); b <= Math.floor(lastRow / size); b++) {
      if ((blocks.get(b)?.gen ?? -1) < gen && loading.get(b) !== gen) load(b);
    }
  }
  async function load(b) {
    const e = epoch, g = gen;
    loading.set(b, g);
    try {
      const page = await fetchBlock(b * size, size);
      if (e !== epoch) return;
      blocks.set(b, { gen: g, rows: page.rows });
      total = page.total;
      for (const k of blocks.keys()) if (k * size >= total) blocks.delete(k);
      onPage(page);
      list.set(total, rowAt);
    } catch { /* the next refresh reads it again */ } finally { if (loading.get(b) === g) loading.delete(b); }
  }
  ensure();
  return {
    el: list.el, list,
    get total() { return total; },
    refresh() { gen++; ensure(); },
    reset() { epoch++; gen++; blocks.clear(); loading.clear(); total = 0; view = { from: 0, to: 1 }; list.clear(); ensure(); },
  };
}

// Rows read newest first with a cursor (/api/trades). Older pages load when the end comes into view; refresh()
// puts newer rows on top without moving what the reader is looking at.
export function cursorList({ fetchPage, key, ...options }) {
  let rows = [], next = null, done = false, busy = false, epoch = 0;
  const list = virtualList({ ...options, key, onRange: (from, to) => { if (to >= rows.length - 20) more(); } });
  const show = prepended => list.set(rows.length, i => rows[i], { prepended });

  async function more() {
    if (busy || done) return;
    const e = epoch;
    busy = true;
    try {
      const page = await fetchPage(rows.length ? next : null);
      if (e !== epoch) return;
      const seen = new Set(rows.map(r => key(r)));
      rows = rows.concat(page.rows.filter(r => !seen.has(key(r))));
      next = page.next; done = !next;
      show(0);
    } catch { /* tried again on the next scroll or refresh */ } finally { if (e === epoch) busy = false; }
  }
  async function refresh() {
    if (!rows.length) return more();
    const e = epoch;
    try {
      const page = await fetchPage(null);
      if (e !== epoch) return;
      const seen = new Set(rows.map(r => key(r))), fresh = [];
      for (const r of page.rows) { if (seen.has(key(r))) break; fresh.push(r); }
      if (!fresh.length) return;
      if (fresh.length === page.rows.length) { rows = page.rows; next = page.next; done = !next; show(0); return; }
      rows = fresh.concat(rows);
      show(fresh.length);
    } catch { /* kept as it is */ }
  }
  more();
  return {
    el: list.el, list, refresh,
    reset() { epoch++; rows = []; next = null; done = false; busy = false; list.clear(); more(); },
  };
}
