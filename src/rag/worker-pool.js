import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POOL_SIZE = Math.max(2, os.cpus().length - 1);
const WORKER_SCRIPT = path.join(__dirname, 'chunk-worker.js');

export class WorkerPool {
  constructor(options = {}) {
    this.poolSize = options.poolSize || DEFAULT_POOL_SIZE;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 0;
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;

    for (let i = 0; i < this.poolSize; i++) {
      this._spawnWorker(i);
    }

    console.log(`[WORKER] Pool started with ${this.poolSize} workers`);
  }

  _spawnWorker(index) {
    const worker = new Worker(WORKER_SCRIPT, { workerData: { index } });

    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        this.idle.push(worker);
        this._processQueue();
      } else if (msg.type === 'result') {
        const { resolve } = this.pending.get(msg.id) || {};
        if (resolve) {
          resolve(msg.results);
          this.pending.delete(msg.id);
        }
        this.idle.push(worker);
        this._processQueue();
      }
    });

    worker.on('error', (err) => {
      console.error(`[WORKER ${index}] Error:`, err.message);
      const idx = this.workers.indexOf(worker);
      if (idx >= 0) this.workers.splice(idx, 1);
      setTimeout(() => this._spawnWorker(index), 1000);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        const idx = this.workers.indexOf(worker);
        if (idx >= 0) this.workers.splice(idx, 1);
        setTimeout(() => this._spawnWorker(index), 1000);
      }
    });

    this.workers.push(worker);
  }

  _processQueue() {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop();
      const { files, options, resolve } = this.queue.shift();
      const id = this.nextId++;

      this.pending.set(id, { resolve });
      worker.postMessage({ type: 'process', id, files, options });
    }
  }

  processBatch(files, options = {}) {
    return new Promise((resolve) => {
      this.queue.push({ files, options, resolve });
      this._processQueue();
    });
  }

  async processAll(filePaths, options = {}) {
    this.start();

    const batchSize = Math.max(1, Math.ceil(filePaths.length / (this.poolSize * 3)));
    const batches = [];
    for (let i = 0; i < filePaths.length; i += batchSize) {
      batches.push(filePaths.slice(i, i + batchSize));
    }

    console.log(`[WORKER] Processing ${filePaths.length} files in ${batches.length} batches (${batchSize}/batch)`);

    const allResults = [];
    let completed = 0;

    const promises = batches.map(batch =>
      this.processBatch(batch, options).then(results => {
        completed += batch.length;
        if (completed % 500 === 0 || completed === filePaths.length) {
          console.log(`[WORKER] ${completed}/${filePaths.length} files processed`);
        }
        allResults.push(...results);
      })
    );

    await Promise.all(promises);
    return allResults;
  }

  getStats() {
    return {
      poolSize: this.poolSize,
      activeWorkers: this.poolSize - this.idle.length,
      idleWorkers: this.idle.length,
      pending: this.pending.size,
      queued: this.queue.length,
      started: this._started,
    };
  }

  async shutdown() {
    for (const worker of this.workers) {
      worker.postMessage({ type: 'exit' });
    }
    await Promise.all(
      this.workers.map(w => new Promise(resolve => {
        w.on('exit', resolve);
        setTimeout(resolve, 1000);
      }))
    );
    this.workers = [];
    this.idle = [];
    this._started = false;
    console.log('[WORKER] Pool shut down');
  }
}

let defaultPool = null;

export function getPool(options = {}) {
  if (!defaultPool) {
    defaultPool = new WorkerPool(options);
  }
  return defaultPool;
}

export default WorkerPool;
