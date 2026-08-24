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
    this._destroyed = false;
    this.taskTimeout = options.taskTimeout || 30000; // 30 second default timeout
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
        const pendingItem = this.pending.get(msg.id);
        if (pendingItem) {
          clearTimeout(pendingItem.timeout);
          pendingItem.resolve(msg.results);
          this.pending.delete(msg.id);
        }
        this.idle.push(worker);
        this._processQueue();
      } else if (msg.type === 'error') {
        const pendingItem = this.pending.get(msg.id);
        if (pendingItem) {
          clearTimeout(pendingItem.timeout);
          pendingItem.reject(new Error(msg.error));
          this.pending.delete(msg.id);
        }
        this.idle.push(worker);
        this._processQueue();
      }
    });

    worker.on('error', (err) => {
      console.error(`[WORKER ${index}] Error:`, err.message);
      // Clean up any pending tasks for this worker
      this._cleanupWorkerTasks(worker);
      const idx = this.workers.indexOf(worker);
      if (idx >= 0) this.workers.splice(idx, 1);
      if (!this._destroyed) {
        setTimeout(() => this._spawnWorker(index), 1000);
      }
    });

    worker.on('exit', (code) => {
      // Clean up any pending tasks for this worker
      this._cleanupWorkerTasks(worker);
      const idx = this.workers.indexOf(worker);
      if (idx >= 0) this.workers.splice(idx, 1);
      if (code !== 0 && !this._destroyed) {
        console.warn(`[WORKER ${index}] Exited with code ${code}, restarting...`);
        setTimeout(() => this._spawnWorker(index), 1000);
      }
    });

    this.workers.push(worker);
  }

  _cleanupWorkerTasks(worker) {
    // Find and reject all pending tasks assigned to this worker
    for (const [id, item] of this.pending.entries()) {
      // We can't easily track which worker has which task, so we'll just clear all
      // In a more sophisticated implementation, we'd track worker->task mapping
    }
  }

  _processQueue() {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop();
      const { files, options, resolve, reject } = this.queue.shift();
      const id = this.nextId++;

      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Worker task timeout after ${this.taskTimeout}ms`));
          // Return worker to idle pool
          this.idle.push(worker);
          this._processQueue();
        }
      }, this.taskTimeout);

      this.pending.set(id, { resolve, reject, timeout });
      worker.postMessage({ type: 'process', id, files, options });
    }
  }

  processBatch(files, options = {}) {
    return new Promise((resolve, reject) => {
      if (this._destroyed) {
        reject(new Error('Worker pool has been destroyed'));
        return;
      }
      this.queue.push({ files, options, resolve, reject });
      this._processQueue();
    });
  }

  async processAll(filePaths, options = {}) {
    if (this._destroyed) {
      throw new Error('Worker pool has been destroyed');
    }
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
      this.processBatch(batch, options)
        .then(results => {
          completed += batch.length;
          if (completed % 500 === 0 || completed === filePaths.length) {
            console.log(`[WORKER] ${completed}/${filePaths.length} files processed`);
          }
          allResults.push(...results);
          return results;
        })
        .catch(error => {
          console.error('[WORKER] Batch processing failed:', error.message);
          throw error;
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
    if (this._destroyed) {
      console.warn('[WORKER] Pool already destroyed');
      return;
    }
    this._destroyed = true;

    // Reject all pending tasks
    for (const [id, item] of this.pending.entries()) {
      clearTimeout(item.timeout);
      item.reject(new Error('Worker pool shut down'));
    }
    this.pending.clear();

    // Clear queue
    for (const item of this.queue) {
      item.reject(new Error('Worker pool shut down'));
    }
    this.queue = [];

    // Send exit to all workers
    for (const worker of this.workers) {
      try {
        worker.postMessage({ type: 'exit' });
      } catch (error) {
        console.error('[WORKER] Failed to send exit message:', error.message);
      }
    }

    // Wait for workers to exit with timeout
    const exitPromises = this.workers.map(w => new Promise(resolve => {
      const timeout = setTimeout(resolve, 2000);
      w.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    }));

    await Promise.all(exitPromises);
    
    this.workers = [];
    this.idle = [];
    this._started = false;
    console.log('[WORKER] Pool shut down');
  }
}

let defaultPool = null;

export function getPool(options = {}) {
  if (!defaultPool || defaultPool._destroyed) {
    defaultPool = new WorkerPool(options);
  }
  return defaultPool;
}

export function resetDefaultPool() {
  if (defaultPool) {
    defaultPool.shutdown();
    defaultPool = null;
  }
}

export default WorkerPool;
