import fs from 'fs';
import path from 'path';
import os from 'os';
import { walkDirectory } from './chunker.js';
import store from './store.js';
import codeGraph from './code-graph.js';
import graphStore from './graph-store.js';
import { getPool } from './worker-pool.js';

export class CodeIndexer {
  constructor() {
    this.store = store;
    this.workspaceDir = process.cwd();
    this.lastIndexed = null;
    this.isIndexed = false;
    this.pool = null;
  }

  async buildIndex(workspaceDir = null, options = {}) {
    this.workspaceDir = workspaceDir || this.workspaceDir;
    const poolSize = options.poolSize || Math.max(2, os.cpus().length - 1);

    console.log(`[RAG] Scanning ${this.workspaceDir}...`);
    const files = walkDirectory(this.workspaceDir, {
      maxDepth: options.maxDepth || 10,
      maxFiles: options.maxFiles || 100000,
    });
    console.log(`[RAG] Found ${files.length} files, starting ${poolSize} workers...`);

    this.store.clear();
    codeGraph.clear();

    this.pool = getPool({ poolSize });
    this.pool.start();

    const allResults = await this.pool.processAll(files, {
      chunkSize: options.chunkSize || 1000,
      chunkOverlap: options.chunkOverlap || 100,
      forceLarge: options.forceLarge || false,
    });

    console.log(`[RAG] Worker pool returned ${allResults.length} file results`);

    const allChunks = [];
    for (const result of allResults) {
      if (!result) continue;
      allChunks.push(...(result.chunks || []));
      codeGraph.nodes.set(result.filePath, {
        path: result.filePath,
        language: result.language,
        size: result.size,
        lines: result.lines,
      });
      codeGraph.edges.set(result.filePath, {
        imports: result.imports || [],
        importedBy: [],
      });
      codeGraph.functions.set(result.filePath, result.functions || []);
    }

    for (const [fp, edge] of codeGraph.edges) {
      const resolved = edge.imports
        .map(i => codeGraph.nodes.has(i) ? i : null)
        .filter(Boolean);
      edge.imports = resolved;
      for (const ri of resolved) {
        const dep = codeGraph.edges.get(ri);
        if (dep && !dep.importedBy.includes(fp)) {
          dep.importedBy.push(fp);
        }
      }
    }

    graphStore.buildFromCodeGraph(codeGraph);
    const graphStats = graphStore.getStats();
    console.log(`[RAG] Graph: ${graphStats.totalFiles} files, ${graphStats.totalEdges} edges, ${graphStats.totalSymbols} symbols`);

    console.log(`[RAG] Storing ${allChunks.length} chunks in SQLite FTS5 + Vector...`);
    this.store.addChunks(allChunks);

    this.isIndexed = true;
    this.lastIndexed = new Date().toISOString();

    const storeStats = this.store.getStats();
    console.log(`[RAG] Done: ${storeStats.totalChunks} chunks, ${storeStats.totalFiles} files`);

    return {
      totalChunks: storeStats.totalChunks,
      totalFiles: storeStats.totalFiles,
      vectorsIndexed: storeStats.vectorsIndexed,
      lastIndexed: this.lastIndexed,
      codeGraph: graphStats,
      workerPool: this.pool.getStats(),
    };
  }

  loadIndex() {
    const stats = this.store.getStats();
    if (stats.totalChunks > 0) {
      this.isIndexed = true;
      this.lastIndexed = new Date().toISOString();
      console.log(`[RAG] Loaded store: ${stats.totalChunks} chunks, ${stats.totalFiles} files`);
      return true;
    }
    return false;
  }

  retrieve(query, options = {}) {
    if (!this.isIndexed) return [];
    const maxResults = options.maxResults || 10;
    const results = this.store.hybridSearch(query, { limit: maxResults * 2 });

    let final = results.slice(0, maxResults * 2);

    if (graphStore.getStats().totalFiles > 0 && final.length > 0) {
      const topFiles = new Set(final.map(r => r.filePath));
      const relatedFiles = new Set();

      for (const fp of topFiles) {
        const related = graphStore.getRelatedFiles(fp, 1);
        for (const r of related) {
          if (!topFiles.has(r)) relatedFiles.add(r);
        }
      }

      if (relatedFiles.size > 0) {
        for (const rfp of relatedFiles) {
          const chunks = this.store.getChunksForFile(rfp);
          const topScore = final.length > 0 ? final[0].score : 1;
          for (const c of chunks.slice(0, 3)) {
            final.push({ ...c, score: topScore * 0.35, method: 'graph', related: true });
          }
        }
      }
    }

    final.sort((a, b) => b.score - a.score);
    return final.slice(0, maxResults);
  }

  getChunksForFile(filePath) {
    return this.store.getChunksForFile(filePath);
  }

  clear() {
    this.store.clear();
    codeGraph.clear();
    this.isIndexed = false;
    this.lastIndexed = null;
  }

  getStats() {
    const ss = this.store.getStats();
    const gs = graphStore.getStats();
    const wp = this.pool ? this.pool.getStats() : null;
    return {
      totalChunks: ss.totalChunks,
      totalFiles: ss.totalFiles,
      vectorsIndexed: ss.vectorsIndexed,
      lastIndexed: this.lastIndexed,
      workspaceDir: this.workspaceDir,
      isIndexed: this.isIndexed,
      codeGraph: {
        files: gs.totalFiles,
        totalImports: gs.totalEdges,
        totalFunctions: gs.totalSymbols,
        totalClasses: Object.keys(gs.languages).length,
        graph: gs,
      },
      workerPool: wp,
    };
  }
}

const defaultIndexer = new CodeIndexer();
export default defaultIndexer;
