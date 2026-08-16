import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'data', 'rag-graph.db');

export class GraphStore {
  constructor() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('cache_size = -128000');
    this.db.pragma('synchronous = OFF');
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE,
        rel_path TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'text',
        size INTEGER DEFAULT 0,
        lines INTEGER DEFAULT 0,
        hash TEXT,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS graph_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'imports',
        weight REAL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source_id, target_id, type)
      );

      CREATE TABLE IF NOT EXISTS graph_symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'function',
        line INTEGER DEFAULT 0,
        UNIQUE(node_id, name, type)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_source_type ON graph_edges(source_id, type);
      CREATE INDEX IF NOT EXISTS idx_edges_target_type ON graph_edges(target_id, type);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON graph_symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_node ON graph_symbols(node_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_type ON graph_symbols(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_rel ON graph_nodes(rel_path);
      CREATE INDEX IF NOT EXISTS idx_nodes_lang ON graph_nodes(language);
    `);

    this._prepared = {
      upsertNode: this.db.prepare(`
        INSERT INTO graph_nodes (id, file_path, rel_path, language, size, lines, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
          size = excluded.size, lines = excluded.lines,
          hash = excluded.hash, indexed_at = datetime('now')
      `),
      deleteNode: this.db.prepare('DELETE FROM graph_nodes WHERE file_path = ?'),
      getNode: this.db.prepare('SELECT * FROM graph_nodes WHERE file_path = ?'),
      getNodeById: this.db.prepare('SELECT * FROM graph_nodes WHERE id = ?'),
      getNodeByPath: this.db.prepare('SELECT * FROM graph_nodes WHERE rel_path LIKE ?'),
      addEdge: this.db.prepare(`
        INSERT OR IGNORE INTO graph_edges (source_id, target_id, type, weight)
        VALUES (?, ?, ?, ?)
      `),
      deleteEdgesFrom: this.db.prepare('DELETE FROM graph_edges WHERE source_id = ?'),
      deleteEdgesTo: this.db.prepare('DELETE FROM graph_edges WHERE target_id = ?'),
      getDependencies: this.db.prepare(`
        SELECT n.*, e.type, e.weight
        FROM graph_edges e
        JOIN graph_nodes n ON n.id = e.target_id
        WHERE e.source_id = ?
        ORDER BY e.weight DESC
      `),
      getDependents: this.db.prepare(`
        SELECT n.*, e.type, e.weight
        FROM graph_edges e
        JOIN graph_nodes n ON n.id = e.source_id
        WHERE e.target_id = ?
        ORDER BY e.weight DESC
      `),
      addSymbol: this.db.prepare(`
        INSERT OR IGNORE INTO graph_symbols (node_id, name, type, line)
        VALUES (?, ?, ?, ?)
      `),
      deleteSymbols: this.db.prepare('DELETE FROM graph_symbols WHERE node_id = ?'),
      findSymbol: this.db.prepare(`
        SELECT s.*, n.file_path, n.rel_path, n.language
        FROM graph_symbols s
        JOIN graph_nodes n ON n.id = s.node_id
        WHERE s.name = ?
        ORDER BY s.type, n.rel_path
      `),
      searchSymbols: this.db.prepare(`
        SELECT s.*, n.file_path, n.rel_path, n.language
        FROM graph_symbols s
        JOIN graph_nodes n ON n.id = s.node_id
        WHERE s.name LIKE ?
        ORDER BY s.type, n.rel_path
        LIMIT ?
      `),
      getNodeSymbols: this.db.prepare('SELECT * FROM graph_symbols WHERE node_id = ? ORDER BY type, line'),
      getNodeCount: this.db.prepare('SELECT COUNT(*) as count FROM graph_nodes'),
      getEdgeCount: this.db.prepare('SELECT COUNT(*) as count FROM graph_edges'),
      getSymbolCount: this.db.prepare('SELECT COUNT(*) as count FROM graph_symbols'),
      getAllNodes: this.db.prepare('SELECT file_path, rel_path, language, size, lines FROM graph_nodes ORDER BY rel_path'),
      clearNodes: this.db.prepare('DELETE FROM graph_nodes'),
      clearEdges: this.db.prepare('DELETE FROM graph_edges'),
      clearSymbols: this.db.prepare('DELETE FROM graph_symbols'),
    };
  }

  addNode(filePath, data = {}) {
    const id = filePath.replace(/\\/g, '/');
    const relPath = filePath.replace(process.cwd(), '').replace(/\\/g, '/');
    const hash = data.hash || `${data.size || 0}_${data.lines || 0}`;
    this._prepared.upsertNode.run(
      id, filePath, relPath, data.language || 'text',
      data.size || 0, data.lines || 0, hash
    );
    return id;
  }

  removeNode(filePath) {
    const node = this._prepared.getNode.get(filePath);
    if (node) {
      this._prepared.deleteEdgesFrom.run(node.id);
      this._prepared.deleteEdgesTo.run(node.id);
      this._prepared.deleteSymbols.run(node.id);
    }
    this._prepared.deleteNode.run(filePath);
  }

  addEdge(sourcePath, targetPath, type = 'imports', weight = 1.0) {
    const sourceId = sourcePath.replace(/\\/g, '/');
    const targetId = targetPath.replace(/\\/g, '/');
    this._prepared.addEdge.run(sourceId, targetId, type, weight);
  }

  addSymbol(filePath, name, type = 'function', line = 0) {
    const nodeId = filePath.replace(/\\/g, '/');
    this._prepared.addSymbol.run(nodeId, name, type, line);
  }

  getDependencies(filePath) {
    const node = this._prepared.getNode.get(filePath);
    if (!node) return [];
    return this._prepared.getDependencies.all(node.id);
  }

  getDependents(filePath) {
    const node = this._prepared.getNode.get(filePath);
    if (!node) return [];
    return this._prepared.getDependents.all(node.id);
  }

  getRelatedFiles(filePath, depth = 1) {
    const allRelated = new Set();
    const visited = new Set();

    const traverse = (fp, d) => {
      if (d > depth || visited.has(fp)) return;
      visited.add(fp);

      const deps = this.getDependencies(fp);
      const depBy = this.getDependents(fp);

      for (const dep of deps) {
        if (dep.file_path !== fp) {
          allRelated.add(dep.file_path);
          traverse(dep.file_path, d + 1);
        }
      }
      for (const dep of depBy) {
        if (dep.file_path !== fp) {
          allRelated.add(dep.file_path);
          traverse(dep.file_path, d + 1);
        }
      }
    };

    traverse(filePath, 0);
    return [...allRelated];
  }

  findSymbol(name) {
    return this._prepared.findSymbol.all(name);
  }

  searchSymbols(pattern, limit = 20) {
    return this._prepared.searchSymbols.run(`%${pattern}%`, limit);
  }

  getNodeSymbols(filePath) {
    const nodeId = filePath.replace(/\\/g, '/');
    return this._prepared.getNodeSymbols.all(nodeId);
  }

  findConnectedComponents() {
    const allNodes = this._prepared.getAllNodes.all();
    const visited = new Set();
    const components = [];

    const bfs = (start) => {
      const component = [];
      const queue = [start];
      visited.add(start.file_path);

      while (queue.length > 0) {
        const node = queue.shift();
        component.push(node);

        const deps = this.getDependencies(node.file_path);
        const depBy = this.getDependents(node.file_path);

        for (const neighbor of [...deps, ...depBy]) {
          if (!visited.has(neighbor.file_path)) {
            visited.add(neighbor.file_path);
            queue.push(neighbor);
          }
        }
      }
      return component;
    };

    for (const node of allNodes) {
      if (!visited.has(node.file_path)) {
        const component = bfs(node);
        if (component.length > 0) components.push(component);
      }
    }

    return components;
  }

  shortestPath(fromPath, toPath) {
    const startNode = this._prepared.getNode.get(fromPath);
    const endNode = this._prepared.getNode.get(toPath);
    if (!startNode || !endNode) return null;

    const visited = new Set();
    const queue = [{ node: startNode, path: [startNode.file_path] }];
    visited.add(startNode.file_path);

    while (queue.length > 0) {
      const { node, path } = queue.shift();

      if (node.file_path === toPath) return path;

      const deps = this.getDependencies(node.file_path);
      const depBy = this.getDependents(node.file_path);

      for (const neighbor of [...deps, ...depBy]) {
        if (!visited.has(neighbor.file_path)) {
          visited.add(neighbor.file_path);
          queue.push({ node: neighbor, path: [...path, neighbor.file_path] });
        }
      }
    }

    return null;
  }

  buildFromCodeGraph(codeGraph) {
    const insertBatch = this.db.transaction(() => {
      this._prepared.clearEdges.run();
      this._prepared.clearSymbols.run();

      for (const [fp, nodeData] of codeGraph.nodes) {
        this.addNode(fp, nodeData);
      }

      for (const [fp, edgeData] of codeGraph.edges) {
        for (const imp of edgeData.imports) {
          this.addEdge(fp, imp, 'imports');
        }
      }

      for (const [fp, funcs] of codeGraph.functions) {
        for (const f of funcs) {
          this.addSymbol(fp, f.name, 'function', f.line);
        }
      }

      for (const [fp, classes] of codeGraph.classes) {
        for (const c of classes) {
          this.addSymbol(fp, c.name, 'class', c.line);
        }
      }
    });

    insertBatch();
  }

  getStats() {
    const nodes = this._prepared.getNodeCount.get();
    const edges = this._prepared.getEdgeCount.get();
    const symbols = this._prepared.getSymbolCount.get();
    const allNodes = this._prepared.getAllNodes.all();

    let totalSize = 0;
    let totalLines = 0;
    const languages = {};
    for (const n of allNodes) {
      totalSize += n.size || 0;
      totalLines += n.lines || 0;
      languages[n.language] = (languages[n.language] || 0) + 1;
    }

    const components = this.findConnectedComponents();

    return {
      totalFiles: nodes.count,
      totalEdges: edges.count,
      totalSymbols: symbols.count,
      totalSizeBytes: totalSize,
      totalLines,
      languages,
      components: components.length,
      avgComponentSize: components.length > 0
        ? Math.round((nodes.count / components.length) * 10) / 10
        : 0,
      largestComponent: components.length > 0
        ? Math.max(...components.map(c => c.length))
        : 0,
    };
  }

  clear() {
    this._prepared.clearSymbols.run();
    this._prepared.clearEdges.run();
    this._prepared.clearNodes.run();
  }

  close() {
    this.db.close();
  }
}

const defaultGraphStore = new GraphStore();
export default defaultGraphStore;
