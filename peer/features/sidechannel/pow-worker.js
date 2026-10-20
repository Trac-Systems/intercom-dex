import { parentPort } from 'worker_threads';
import { PowSearch } from './pow-search.js';

const jobs = new Map();
parentPort.on('message', ({ id, prepare, release }) => {
  if (release) { jobs.delete(id); return; }
  try {
    let job = jobs.get(id);
    if (prepare) {
      const { prefix, suffix, difficulty } = prepare;
      if (job) { job.search.prepare(prefix, suffix); job.difficulty = difficulty; }
      else { job = { search: new PowSearch(prefix, suffix), difficulty }; jobs.set(id, job); }
    }
    if (!job) throw new Error('Unknown PoW job');
    const nonce = job.search.run(job.difficulty);
    parentPort.postMessage({ id, nonce, nextNonce: job.search.nonce });
  } catch (error) {
    jobs.delete(id);
    parentPort.postMessage({ id, error: error.message });
  }
});
