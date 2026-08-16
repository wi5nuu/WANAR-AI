import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const DB_PATH = path.join(process.cwd(), 'data', 'rag-store.db');

const VECTOR_DIM = 256;

class NGramVectorizer {
  static compute(text) {
    const vec = new Float64Array(VECTOR_DIM);
    const normalized = text.toLowerCase().replace(/\s+/g, ' ');

    const bigrams = new Set();
    const trigrams = new Set();
    const fourgrams = new Set();

    for (let i = 0; i < normalized.length - 1; i++) {
      bigrams.add(normalized.slice(i, i + 2));
    }
    for (let i = 0; i < normalized.length - 2; i++) {
      trigrams.add(normalized.slice(i, i + 3));
    }
    for (let i = 0; i < normalized.length - 3; i++) {
      fourgrams.add(normalized.slice(i, i + 4));
    }

    const codeTerms = new Set();
    const codeMatches = normalized.matchAll(/\b([a-z_][a-z0-9_]*)\b/g);
    for (const m of codeMatches) {
      if (m[1].length > 2) codeTerms.add(m[1]);
    }

    for (const bg of bigrams) {
      const idx = this._hash(bg) % VECTOR_DIM;
      vec[idx] += 0.4;
    }
    for (const tg of trigrams) {
      const idx = this._hash(tg) % VECTOR_DIM;
      vec[idx] += 0.6;
    }
    for (const fg of fourgrams) {
      const idx = this._hash(fg) % VECTOR_DIM;
      vec[idx] += 0.8;
    }
    for (const term of codeTerms) {
      const idx = this._hash(term) % VECTOR_DIM;
      vec[idx] += 1.0;
    }

    let norm = 0;
    for (let i = 0; i < VECTOR_DIM; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < VECTOR_DIM; i++) vec[i] /= norm;
    }

    return Buffer.from(vec.buffer);
  }

  static cosineSimilarity(a, b) {
    const va = new Float64Array(a.buffer, a.byteOffset, VECTOR_DIM);
    const vb = new Float64Array(b.buffer, b.byteOffset, VECTOR_DIM);
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < VECTOR_DIM; i++) {
      dot += va[i] * vb[i];
      na += va[i] * va[i];
      nb += vb[i] * vb[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom > 0 ? dot / denom : 0;
  }

  static _hash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }
}

export class RagStore {
  constructor() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('cache_size = -64000');
    this.db.pragma('synchronous = OFF');
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'text',
        start_line INTEGER NOT NULL DEFAULT 0,
        end_line INTEGER NOT NULL DEFAULT 0,
        function_name TEXT,
        content TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        keywords TEXT DEFAULT '[]',
        vector BLOB,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content,
        file_path,
        function_name,
        tokenize='unicode61'
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_rel ON chunks(rel_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_lang ON chunks(language);
      CREATE INDEX IF NOT EXISTS idx_chunks_func ON chunks(function_name);
    `);

    this._prepared = {
      insertChunk: this.db.prepare(`
        INSERT INTO chunks (file_path, rel_path, language, start_line, end_line, function_name, content, size, keywords, vector)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertFTS: this.db.prepare(`
        INSERT INTO chunks_fts (rowid, content, file_path, function_name)
        VALUES (?, ?, ?, ?)
      `),
      deleteFile: this.db.prepare('DELETE FROM chunks WHERE file_path = ?'),
      deleteFileFTS: this.db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)'),
      getChunk: this.db.prepare('SELECT * FROM chunks WHERE id = ?'),
      getChunksByFile: this.db.prepare('SELECT * FROM chunks WHERE file_path = ? ORDER BY start_line'),
      getChunkCount: this.db.prepare('SELECT COUNT(*) as count FROM chunks'),
      getFileCount: this.db.prepare('SELECT COUNT(DISTINCT file_path) as count FROM chunks'),
      getAllVectors: this.db.prepare('SELECT id, vector FROM chunks WHERE vector IS NOT NULL'),
      searchByFunction: this.db.prepare("SELECT * FROM chunks WHERE function_name = ? ORDER BY size DESC LIMIT 20"),
      searchByFile: this.db.prepare("SELECT * FROM chunks WHERE file_path LIKE ? ORDER BY start_line LIMIT 50"),
      clearChunks: this.db.prepare('DELETE FROM chunks'),
      clearFTS: this.db.prepare('DELETE FROM chunks_fts'),
    };
  }

  addChunk(chunk) {
    const relPath = chunk.filePath.replace(process.cwd(), '').replace(/\\/g, '/');
    const vector = NGramVectorizer.compute(chunk.content + ' ' + (chunk.functionName || ''));
    const keywordsJson = JSON.stringify(chunk.keywords || []);

    const result = this._prepared.insertChunk.run(
      chunk.filePath, relPath, chunk.language || 'text',
      chunk.startLine, chunk.endLine,
      chunk.functionName || null, chunk.content, chunk.content.length,
      keywordsJson, vector
    );

    const rowId = result.lastInsertRowid;
    this._prepared.insertFTS.run(
      rowId, chunk.content, chunk.filePath, chunk.functionName || ''
    );

    return rowId;
  }

  addChunks(chunks) {
    const insert = this.db.transaction((chunksArray) => {
      const ids = [];
      for (const chunk of chunksArray) {
        ids.push(this.addChunk(chunk));
      }
      return ids;
    });
    return insert(chunks);
  }

  removeFile(filePath) {
    this._prepared.deleteFileFTS.run(filePath);
    this._prepared.deleteFile.run(filePath);
  }

  searchFTS(query, options = {}) {
    const limit = options.limit || 10;
    const terms = query
      .toLowerCase()
      .replace(/[^a-zA-Z0-9_$\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2)
      .map(t => `"${t}"`)
      .join(' OR ');

    if (!terms) return [];

    try {
      const rows = this.db.prepare(`
        SELECT c.*, rank
        FROM chunks_fts f
        JOIN chunks c ON c.id = f.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(terms, limit);

      return rows.map(r => ({
        filePath: r.file_path,
        relPath: r.rel_path,
        language: r.language,
        startLine: r.start_line,
        endLine: r.end_line,
        functionName: r.function_name,
        content: r.content,
        size: r.size,
        keywords: JSON.parse(r.keywords || '[]'),
        score: Math.max(0, 100 + r.rank) / 100,
        method: 'fts',
      }));
    } catch {
      return [];
    }
  }

  searchVector(query, options = {}) {
    const limit = options.limit || 10;
    const minScore = options.minScore || 0.1;
    const queryVec = NGramVectorizer.compute(query);

    const allVectors = this._prepared.getAllVectors.all();
    const scored = [];

    for (const row of allVectors) {
      if (!row.vector) continue;
      const sim = NGramVectorizer.cosineSimilarity(queryVec, row.vector);
      if (sim >= minScore) {
        scored.push({ id: row.id, score: sim });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    return top.map(s => {
      const chunk = this._prepared.getChunk.get(s.id);
      if (!chunk) return null;
      return {
        filePath: chunk.file_path,
        relPath: chunk.rel_path,
        language: chunk.language,
        startLine: chunk.start_line,
        endLine: chunk.end_line,
        functionName: chunk.function_name,
        content: chunk.content,
        size: chunk.size,
        keywords: JSON.parse(chunk.keywords || '[]'),
        score: Math.round(s.score * 100) / 100,
        method: 'vector',
      };
    }).filter(Boolean);
  }

  hybridSearch(query, options = {}) {
    const limit = options.limit || 10;
    const ftsResults = this.searchFTS(query, { limit: limit * 2 });
    const vecResults = this.searchVector(query, { limit: limit * 2, minScore: 0.15 });

    const merged = new Map();

    for (const r of ftsResults) {
      const key = `${r.filePath}:${r.startLine}`;
      r.ftsScore = r.score;
      r.vecScore = 0;
      merged.set(key, r);
    }

    for (const r of vecResults) {
      const key = `${r.filePath}:${r.startLine}`;
      if (merged.has(key)) {
        merged.get(key).vecScore = r.score;
        merged.get(key).score = Math.max(merged.get(key).score, r.score);
        merged.get(key).method = 'hybrid';
      } else {
        r.ftsScore = 0;
        r.vecScore = r.score;
        merged.set(key, r);
      }
    }

    for (const [, r] of merged) {
      r.score = r.ftsScore * 0.6 + r.vecScore * 0.4;
    }

    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  queryByFunction(name) {
    return this._prepared.searchByFunction.all(name).map(this._rowToResult);
  }

  queryByFile(filePath) {
    return this._prepared.searchByFile.all(`%${filePath}%`).map(this._rowToResult);
  }

  getChunksForFile(filePath) {
    return this._prepared.getChunksByFile.all(filePath).map(this._rowToResult);
  }

  _rowToResult(r) {
    return {
      filePath: r.file_path,
      relPath: r.rel_path,
      language: r.language,
      startLine: r.start_line,
      endLine: r.end_line,
      functionName: r.function_name,
      content: r.content,
      size: r.size,
      keywords: JSON.parse(r.keywords || '[]'),
    };
  }

  clear() {
    this._prepared.clearFTS.run();
    this._prepared.clearChunks.run();
  }

  getStats() {
    const chunkCount = this._prepared.getChunkCount.get();
    const fileCount = this._prepared.getFileCount.get();
    const vectorCount = this._prepared.getAllVectors.all().length;
    return {
      totalChunks: chunkCount.count,
      totalFiles: fileCount.count,
      vectorsIndexed: vectorCount,
    };
  }

  close() {
    this.db.close();
  }
}

export { NGramVectorizer };
const defaultStore = new RagStore();
export default defaultStore;
