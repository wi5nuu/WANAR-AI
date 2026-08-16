import fs from 'fs';
import path from 'path';
import graphStore from './graph-store.js';

const IMPORT_PATTERNS = {
  javascript: [
    /import\s+(?:\*\s+as\s+)?(?:\w+\s*,\s*)?(?:\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s+['"]([^'"]+)['"]/g,
    /export\s+(?:\{[^}]*\}|default\s+\w+|\*\s+from\s+['"]([^'"]+)['"])/g,
  ],
  python: [
    /import\s+(\w+(?:\.\w+)*)/g,
    /from\s+(\w+(?:\.\w+)*)\s+import/g,
  ],
  java: [
    /import\s+([\w.]+);/g,
    /package\s+([\w.]+);/g,
  ],
  go: [
    /import\s+\(([^)]*)\)/gs,
    /import\s+['"]([^'"]+)['"]/g,
  ],
  rust: [
    /use\s+([\w:]+)/g,
    /extern\s+crate\s+(\w+)/g,
  ],
};

const FUNCTION_PATTERNS = {
  javascript: [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
    /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
    /(?:export\s+)?class\s+(\w+)/g,
    /(?:export\s+)?interface\s+(\w+)/g,
    /(?:export\s+)?type\s+(\w+)/g,
  ],
  python: [/def\s+(\w+)/g, /class\s+(\w+)/g],
  java: [/(?:public|private|protected)\s+(?:static\s+)?(?:\w+\s+)*(\w+)\s*\(/g, /class\s+(\w+)/g, /interface\s+(\w+)/g],
  go: [/func\s+(\w+)/g, /type\s+(\w+)\s+struct/g, /type\s+(\w+)\s+interface/g],
  rust: [/fn\s+(\w+)/g, /struct\s+(\w+)/g, /enum\s+(\w+)/g, /trait\s+(\w+)/g, /impl\s+(\w+)/g],
};

function getLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.js':'javascript','.jsx':'javascript','.ts':'javascript','.tsx':'javascript','.mjs':'javascript','.cjs':'javascript',
    '.py':'python','.java':'java','.go':'go','.rs':'rust','.rb':'ruby','.php':'php','.cs':'csharp','.swift':'swift','.kt':'kotlin',
  };
  return map[ext] || 'javascript';
}

export class CodeGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.functions = new Map();
    this.classes = new Map();
  }

  addFile(filePath) {
    if (this.nodes.has(filePath)) return;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lang = getLanguage(filePath);
      const relPath = filePath.replace(process.cwd(), '').replace(/\\/g, '/');
      
      this.nodes.set(filePath, {
        path: filePath,
        relPath,
        language: lang,
        size: content.length,
        lines: content.split('\n').length,
      });

      const imports = this._extractImports(content, lang, filePath);
      const funcs = this._extractFunctions(content, lang, filePath);
      const classes = this._extractClasses(content, lang, filePath);

      this.edges.set(filePath, { imports, importedBy: [] });
      this.functions.set(filePath, funcs);
      this.classes.set(filePath, classes);

      return { imports, functions: funcs, classes };
    } catch {
      return null;
    }
  }

  _extractImports(content, lang, filePath) {
    const patterns = IMPORT_PATTERNS[lang] || IMPORT_PATTERNS.javascript;
    const imports = new Set();

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const imp = match[1].trim();
        if (imp && !imp.startsWith('.') && !imp.includes(':')) {
          imports.add(imp);
        } else if (imp.startsWith('.')) {
          const baseDir = path.dirname(filePath);
          const resolved = this._resolveRelativePath(imp, baseDir);
          if (resolved) imports.add(resolved);
        }
      }
    }
    return [...imports];
  }

  _resolveRelativePath(relativePath, baseDir) {
    const exts = ['.js','.jsx','.ts','.tsx','.mjs','.cjs','.py','.java','.go','.rs','.json','.vue','.svelte'];
    const base = path.resolve(baseDir, relativePath);
    
    if (fs.existsSync(base)) {
      const stat = fs.statSync(base);
      if (stat.isDirectory()) {
        for (const ext of exts) {
          const indexFile = path.join(base, `index${ext}`);
          if (fs.existsSync(indexFile)) return indexFile;
        }
        return null;
      }
      return base;
    }

    for (const ext of exts) {
      const withExt = base + ext;
      if (fs.existsSync(withExt)) return withExt;
    }
    return null;
  }

  _extractFunctions(content, lang) {
    const patterns = FUNCTION_PATTERNS[lang] || FUNCTION_PATTERNS.javascript;
    const funcs = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(line)) !== null) {
          const name = match[1];
          if (name && name !== 'if' && name !== 'for' && name !== 'while' && name !== 'switch' && name !== 'catch') {
            funcs.push({ name, line: i + 1 });
          }
        }
      }
    }
    return funcs;
  }

  _extractClasses(content, lang) {
    const patterns = lang === 'python' ? [/class\s+(\w+)/g] : [/class\s+(\w+)/g, /interface\s+(\w+)/g];
    const classes = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(lines[i])) !== null) {
          classes.push({ name: match[1], line: i + 1 });
        }
      }
    }
    return classes;
  }

  buildIndex(filePaths) {
    for (const fp of filePaths) {
      const result = this.addFile(fp);
      if (result) {
        for (const imp of result.imports) {
          if (this.nodes.has(imp)) {
            const existing = this.edges.get(imp);
            if (existing && !existing.importedBy.includes(fp)) {
              existing.importedBy.push(fp);
            }
          }
        }
      }
    }

    for (const [fp, edge] of this.edges) {
      const resolved = edge.imports
        .map(i => this.nodes.has(i) ? i : null)
        .filter(Boolean);
      edge.imports = resolved;
      
      for (const resolvedImport of resolved) {
        if (this.edges.has(resolvedImport)) {
          const dep = this.edges.get(resolvedImport);
          if (!dep.importedBy.includes(fp)) {
            dep.importedBy.push(fp);
          }
        }
      }
    }

    graphStore.buildFromCodeGraph(this);
  }

  getDependencies(filePath) {
    return this.edges.get(filePath)?.imports || [];
  }

  getDependents(filePath) {
    return this.edges.get(filePath)?.importedBy || [];
  }

  getRelatedFiles(filePath, depth = 1) {
    if (depth > 1 || this.nodes.size > 500) {
      return graphStore.getRelatedFiles(filePath, depth);
    }

    const related = new Set();
    const visited = new Set();

    const traverse = (fp, d) => {
      if (d > depth || visited.has(fp)) return;
      visited.add(fp);

      const deps = this.getDependencies(fp);
      const dependents = this.getDependents(fp);

      for (const dep of deps) { related.add(dep); traverse(dep, d + 1); }
      for (const dep of dependents) { related.add(dep); traverse(dep, d + 1); }
    };

    traverse(filePath, 0);
    return [...related].filter(f => f !== filePath);
  }

  getFunctions(filePath) {
    return this.functions.get(filePath) || [];
  }

  getClasses(filePath) {
    return this.classes.get(filePath) || [];
  }

  findFunction(name) {
    const results = [];
    for (const [fp, funcs] of this.functions) {
      for (const f of funcs) {
        if (f.name.toLowerCase() === name.toLowerCase()) {
          results.push({ file: fp, ...f });
        }
      }
    }
    return results;
  }

  findClass(name) {
    const results = [];
    for (const [fp, classes] of this.classes) {
      for (const c of classes) {
        if (c.name.toLowerCase() === name.toLowerCase()) {
          results.push({ file: fp, ...c });
        }
      }
    }
    return results;
  }

  getStats() {
    const graphStats = graphStore.getStats();
    return {
      files: this.nodes.size,
      totalImports: graphStats.totalEdges,
      totalFunctions: graphStats.totalSymbols,
      totalClasses: graphStats.languages,
      graph: graphStats,
    };
  }

  clear() {
    this.nodes = new Map();
    this.edges = new Map();
    this.functions = new Map();
    this.classes = new Map();
    graphStore.clear();
  }
}

const defaultCodeGraph = new CodeGraph();
export default defaultCodeGraph;
