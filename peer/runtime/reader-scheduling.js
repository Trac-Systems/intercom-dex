// Keep the upstream apply callback and its single atomic batch intact. Cached Hyperbee operations can
// otherwise run thousands of promise continuations without letting socket callbacks or timers run.
// This adapter only schedules storage calls; it never changes operations, values or their order.
export function cooperativeApply(apply, { sliceMs = 8, now = () => Date.now(),
  yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  return async function (nodes, view, base) {
    let last = now();
    const pause = async () => {
      const elapsed = now() - last;
      if (elapsed >= 0 && elapsed < sliceMs) return;
      await yieldTask();
      last = now();
    };
    const scheduled = batch => new Proxy(batch, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (['get', 'put', 'del', 'flush'].includes(key)) return async (...args) => { await pause(); return value.apply(target, args); };
      return value.bind(target);
    } });
    const adapted = new Proxy(view, { get(target, key) {
      if (key === 'batch') return (...args) => scheduled(target.batch(...args));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return apply.call(this, nodes, adapted, base);
  };
}

// trac-peer's message apply prints every accepted RESET message even with enableTxlogs:false.
// Filter just that known line format at the application boundary, preserving warnings and all other logs.
export function summarizeApplyLogs(logger = console, intervalMs = 30000) {
  const original = logger.log;
  let count = 0;
  const flush = () => {
    if (!count) return;
    const applied = count; count = 0;
    original.call(logger, `RESET reader applied ${applied} messages`);
  };
  const filtered = function (...args) {
    if (args.length === 1 && typeof args[0] === 'string' && /^#\d+ \| [^:\n]{1,256}: /.test(args[0])) { count++; return; }
    original.apply(this, args);
  };
  logger.log = filtered;
  const timer = setInterval(flush, intervalMs); timer.unref?.();
  return () => { clearInterval(timer); if (logger.log === filtered) logger.log = original; flush(); };
}
