export const READER_STALL_MS = 300000;

// This is a local progress alarm, not proof of a newer network head. It also
// reports a quiet chain as stalled after five minutes without signed progress.
// Reading public core counters neither updates nor repairs dependency state.
export function readerHealth({ sources, stallfix = () => ({}), now = Date.now, stallMs = READER_STALL_MS }) {
  const previous = new Map();
  return () => {
    const at = now(), readers = {}, fixes = stallfix();
    for (const [chain, core] of Object.entries(sources())) {
      if (!core || !Number.isSafeInteger(core.signedLength) || core.signedLength < 1) {
        readers[chain] = { status: 'unavailable', signedLength: null, unchangedMs: null, hypercoreStallfix: fixes[chain] ?? null }; continue;
      }
      let sample = previous.get(chain);
      if (!sample || sample.core !== core) sample = { core, length: core.signedLength, since: at, progressed: false };
      else if (sample.length !== core.signedLength) sample = { core, length: core.signedLength, since: at, progressed: true };
      previous.set(chain, sample);
      const unchangedMs = Math.max(0, at - sample.since);
      readers[chain] = { status: unchangedMs >= stallMs ? 'stalled' : sample.progressed ? 'advancing' : 'observing',
        signedLength: core.signedLength, viewLength: Number.isSafeInteger(core.length) ? core.length : null, unchangedMs,
        hypercoreStallfix: fixes[chain] ?? null };
    }
    return { at, readers };
  };
}
