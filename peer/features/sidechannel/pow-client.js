import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';

export class PowWorker {
  constructor() {
    this.worker = null;
    this.stopping = null;
    this.jobs = new Map();
    this.nextId = 0;
  }

  async open(prefix, suffix, difficulty) {
    if (this.stopping) await this.stopping;
    if (!this.worker) this.start();
    const job = { id: ++this.nextId, worker: this.worker, prepare: { prefix, suffix, difficulty }, pending: null, error: null };
    this.jobs.set(job.id, job);
    return job;
  }

  start() {
    const worker = new Worker(fileURLToPath(new URL('./pow-worker.js', import.meta.url)));
    this.worker = worker;
    let exited;
    this.exited = new Promise(resolve => { exited = resolve; });
    worker.on('message', result => {
      const job = this.jobs.get(result.id);
      if (!job || job.worker !== worker || !job.pending) return;
      const { resolve, reject } = job.pending;
      job.pending = null;
      if (result.error) { job.error = new Error(result.error); reject(job.error); }
      else resolve(result);
      if (![...this.jobs.values()].some(job => job.pending)) worker.unref();
    });
    worker.on('error', error => this.fail(worker, error));
    worker.on('exit', code => {
      this.fail(worker, new Error(`PoW worker exited (${code})`));
      if (this.worker === worker) { this.worker = null; this.stopping = null; }
      exited();
    });
    worker.unref();
  }

  fail(worker, error) {
    if (this.worker !== worker) return;
    this.stopping = this.exited;
    for (const job of this.jobs.values()) {
      job.error = error;
      job.pending?.reject(error);
      job.pending = null;
    }
    this.jobs.clear();
  }

  prepare(job, prefix, suffix, difficulty) {
    job.prepare = { prefix, suffix, difficulty };
  }

  slice(job) {
    if (job.error) return Promise.reject(job.error);
    if (!this.jobs.has(job.id)) return Promise.reject(new Error('PoW job is closed'));
    if (job.pending) return Promise.reject(new Error('PoW slice already pending'));
    return new Promise((resolve, reject) => {
      job.pending = { resolve, reject };
      job.worker.ref();
      try {
        job.worker.postMessage({ id: job.id, prepare: job.prepare });
        job.prepare = null;
      } catch (error) {
        this.fail(job.worker, error);
        job.worker.terminate();
      }
    });
  }

  release(job) {
    if (!this.jobs.delete(job.id)) return;
    job.error = new Error('PoW job is closed');
    job.pending?.reject(job.error);
    job.pending = null;
    job.worker.postMessage({ id: job.id, release: true });
    if (![...this.jobs.values()].some(job => job.pending)) job.worker.unref();
  }

  async close() {
    if (!this.worker) return;
    this.worker.ref();
    this.fail(this.worker, new Error('PoW worker closed'));
    this.worker.terminate();
    await this.exited;
  }
}

// Several lazily started workers behind the PowWorker interface. A job stays on the worker it opened on; a new job
// goes to the worker with the fewest open jobs. Servers stamp every stake request and reply, so one worker thread
// queued their replies past the 30 s stake timeout on machines with dozens of idle cores.
export class PowPool {
  constructor(size = 1) { this.workers = []; this.owner = new Map(); this.resize(size); }
  resize(size) {
    if (!Number.isSafeInteger(size) || size < 1 || size > 64) throw new Error('Invalid PoW worker count');
    while (this.workers.length < size) this.workers.push(new PowWorker());
    this.size = size;
  }
  async open(prefix, suffix, difficulty) {
    const active = this.workers.slice(0, this.size);
    const worker = active.reduce((best, w) => (w.jobs.size < best.jobs.size ? w : best), active[0]);
    const job = await worker.open(prefix, suffix, difficulty);
    this.owner.set(job, worker); return job;
  }
  prepare(job, prefix, suffix, difficulty) { (this.owner.get(job) ?? this.workers[0]).prepare(job, prefix, suffix, difficulty); }
  slice(job) { return (this.owner.get(job) ?? this.workers[0]).slice(job); }
  release(job) { const worker = this.owner.get(job); this.owner.delete(job); (worker ?? this.workers[0]).release(job); }
  async close() { await Promise.all(this.workers.map(w => w.close())); }
}

// All sidechannels in a peer process share one pool; it starts with one worker and server roles widen it.
export const powWorker = new PowPool(1);
