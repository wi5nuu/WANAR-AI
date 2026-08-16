import fs from 'fs';
import path from 'path';

const DEBOUNCE_MS = 2000;

export class FileWatcher {
  constructor(indexer) {
    this.indexer = indexer;
    this.watchers = [];
    this.debounceTimer = null;
    this.watching = false;
    this.changeQueue = new Set();
    this.onChange = null;
  }

  start(workspaceDir, options = {}) {
    if (this.watching) return;
    this.workspaceDir = workspaceDir;
    this.watching = true;

    const ignored = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.cache']);

    try {
      const rootWatcher = fs.watch(workspaceDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const parts = filename.split(/[\\/]/);

        for (const part of parts) {
          if (ignored.has(part)) return;
          if (part.startsWith('.')) return;
        }

        const fullPath = path.resolve(workspaceDir, filename);
        if (!fs.existsSync(fullPath)) return;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) return;

        const ext = path.extname(fullPath).toLowerCase();
        const codeExts = new Set(['.js','.jsx','.ts','.tsx','.py','.java','.go','.rs','.rb','.php','.cs','.swift','.kt','.dart','.sh','.bash','.sql','.html','.css','.scss','.json','.yaml','.yml','.xml','.md','.vue','.svelte']);
        if (!codeExts.has(ext)) return;

        this.changeQueue.add(fullPath);
        this._debounce();
      });

      this.watchers.push(rootWatcher);
      if (!options.silent) {
        console.log(`[WATCHER] Watching ${workspaceDir} for changes`);
      }
    } catch (error) {
      if (!options.silent) {
        console.error(`[WATCHER] Failed to start: ${error.message}`);
      }
    }

    return this;
  }

  _debounce() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this._processChanges(), DEBOUNCE_MS);
  }

  async _processChanges() {
    if (this.changeQueue.size === 0) return;

    const changedFiles = [...this.changeQueue];
    this.changeQueue.clear();

    console.log(`[WATCHER] ${changedFiles.length} files changed, updating index...`);

    try {
      if (this.onChange) {
        await this.onChange(changedFiles);
      }
    } catch (error) {
      console.error(`[WATCHER] Update failed: ${error.message}`);
    }
  }

  onFilesChanged(callback) {
    this.onChange = callback;
  }

  stop() {
    for (const w of this.watchers) {
      try { w.close(); } catch { }
    }
    this.watchers = [];
    this.watching = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    console.log('[WATCHER] Stopped');
  }
}

export default FileWatcher;
