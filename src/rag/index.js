import config from '../../config/config.js';
import indexer from './indexer.js';
import codeGraph from './code-graph.js';
import FileWatcher from './watcher.js';
import GitAnalyzer from './git.js';

class RAGEngine {
  constructor() {
    this.indexer = indexer;
    this.enabled = config.rag?.enabled || false;
    this.workspaceDir = config.rag?.workspaceDir || process.cwd();
    this.initialized = false;
    this.watcher = new FileWatcher(indexer);
    this.git = new GitAnalyzer(this.workspaceDir);
  }

  async initialize() {
    if (!this.enabled) {
      console.log('[RAG] Disabled (set RAG_ENABLED=true to enable)');
      return { enabled: false };
    }

    const loaded = this.indexer.loadIndex();
    if (loaded) {
      this.initialized = true;
      const stats = this.indexer.getStats();
      this._startWatcher();
      console.log(`[RAG] Loaded index: ${stats.totalChunks} chunks, ${stats.keywords} keywords`);
      return stats;
    }

    return await this.reindex();
  }

  async reindex(workspaceDir = null) {
    const dir = workspaceDir || this.workspaceDir;
    try {
      const result = await this.indexer.buildIndex(dir, {
        maxDepth: config.rag?.maxDepth || 10,
        maxFiles: config.rag?.maxFiles || 100000,
        chunkSize: config.rag?.chunkSize || 1000,
        chunkOverlap: config.rag?.chunkOverlap || 100,
      });
      this.initialized = true;
      this._startWatcher();

      if (!result.error && this.git.isRepo()) {
        try { console.log(`[RAG] Git repo detected: ${this.git.getCurrentBranch()}`); } catch {}
      }

      return result;
    } catch (error) {
      console.error('[RAG] Indexing failed:', error.message);
      return { error: error.message };
    }
  }

  _startWatcher() {
    if (!this.enabled || this.watcher.watching) return;
    this.watcher.start(this.workspaceDir);
    this.watcher.onFilesChanged(async (changedFiles) => {
      console.log(`[RAG] ${changedFiles.length} files changed, updating store & code graph...`);
      try {
        for (const fp of changedFiles) {
          this.indexer.store.removeFile(fp);
          codeGraph.addFile(fp);
        }
        const { chunkFile } = await import('./chunker.js');
        for (const fp of changedFiles) {
          try {
            const chunks = chunkFile(fp, { chunkSize: config.rag?.chunkSize || 1000, chunkOverlap: config.rag?.chunkOverlap || 100 });
            if (chunks.length > 0) this.indexer.store.addChunks(chunks);
          } catch { }
        }
        console.log(`[RAG] Updated ${changedFiles.length} files`);
      } catch (e) {
        console.error(`[RAG] Update error: ${e.message}`);
      }
    });
  }

  retrieve(query, options = {}) {
    if (!this.initialized || !this.enabled) return [];
    return this.indexer.retrieve(query, {
      maxResults: options.maxResults || config.rag?.maxResults || 5,
      minScore: options.minScore || 0.05,
    });
  }

  buildRAGContext(query, maxResults = 5) {
    const results = this.retrieve(query, { maxResults });
    if (results.length === 0) return '';

    let context = '\n[Kode yang relevan dari workspace]:\n\n';

    for (const r of results) {
      const filePath = r.filePath.replace(this.workspaceDir, '').replace(/\\/g, '/');
      const funcInfo = r.functionName ? ` (function: ${r.functionName})` : '';
      const related = r.related ? ' [related by dependency]' : '';
      context += `File: ${filePath}:${r.startLine}-${r.endLine}${funcInfo}${related}\n`;
      context += '```' + r.language + '\n';
      context += r.content + '\n';
      context += '```\n\n';
    }

    return context;
  }

  getStats() {
    return {
      enabled: this.enabled,
      initialized: this.initialized,
      ...this.indexer.getStats(),
      codeGraph: codeGraph.getStats(),
      git: this.git.isRepo() ? {
        isRepo: true,
        branch: this.git.getCurrentBranch(),
        hasUncommitted: this.git.getDiff({ base: 'HEAD' }).totalFiles > 0,
      } : { isRepo: false },
      watcher: { active: this.watcher.watching },
    };
  }

  getGitInfo() {
    return this.git.getRepoInfo();
  }

  getCodeGraph() {
    return codeGraph.getStats();
  }
}

const ragEngine = new RAGEngine();
export default ragEngine;
