import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import path from 'path';

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rs', '.rb', '.php',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.swift', '.kt', '.scala', '.dart',
  '.sh', '.bash', '.ps1', '.sql', '.html', '.css', '.scss', '.sass', '.less',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.md', '.vue', '.svelte', '.astro',
  '.graphql', '.proto', '.prisma',
]);

const LARGE_FILE_THRESHOLD = 1024 * 1024;

const IMPORT_PATTERNS = {
  javascript: [
    /import\s+(?:\*\s+as\s+)?(?:\w+\s*,\s*)?(?:\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s+['"]([^'"]+)['"]/g,
    /export\s+(?:\{[^}]*\}|default\s+\w+|\*\s+from\s+['"]([^'"]+)['"])/g,
  ],
  python: [/import\s+(\w+(?:\.\w+)*)/g, /from\s+(\w+(?:\.\w+)*)\s+import/g],
  java: [/import\s+([\w.]+);/g],
  go: [/import\s+\(([^)]*)\)/gs, /import\s+['"]([^'"]+)['"]/g],
  rust: [/use\s+([\w:]+)/g],
};

const FUNC_PATTERNS = {
  javascript: [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
    /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
    /(?:export\s+)?class\s+(\w+)/g,
    /(?:export\s+)?interface\s+(\w+)/g,
  ],
  python: [/def\s+(\w+)/g, /class\s+(\w+)/g],
  java: [/(?:public|private|protected)\s+(?:static\s+)?(?:\w+\s+)*(\w+)\s*\(/g, /class\s+(\w+)/g],
  go: [/func\s+(\w+)/g, /type\s+(\w+)\s+struct/g],
  rust: [/fn\s+(\w+)/g, /struct\s+(\w+)/g, /enum\s+(\w+)/g],
};

function getLang(fp) {
  const e = path.extname(fp).toLowerCase();
  const m = {
    '.js':'javascript','.jsx':'javascript','.ts':'javascript','.tsx':'javascript','.mjs':'javascript','.cjs':'javascript',
    '.py':'python','.java':'java','.go':'go','.rs':'rust','.rb':'ruby','.php':'php','.cs':'csharp','.swift':'swift','.kt':'kotlin',
  };
  return m[e] || 'text';
}

function splitLines(t) { return t.split(/\r?\n/); }

function extractKeywords(content, lang) {
  const stopWords = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','as','is','was','are','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','shall','can','need','this','that','these','those','it','its','if','then','else','when','where','why','how','all','each','every','both','few','more','most','some','any','no','not','only','own','same','so','than','too','very','just','because','about','into','over','such','here','there','which','what','who','whom','const','let','var','function','return','import','export','default','from','async','await','true','false','null','undefined','new','throw','try','catch','finally','typeof','instanceof','void','delete','class','extends','super']);
  const words = content.replace(/[^a-zA-Z0-9_$]/g,' ').split(/\s+/).filter(w=>w.length>2&&!stopWords.has(w.toLowerCase())).map(w=>w.toLowerCase());
  const freq = {};
  for (const w of words) freq[w] = (freq[w]||0)+1;
  const codePatterns = content.match(/\b([A-Z][a-zA-Z0-9_]+)\b/g)||[];
  for (const p of codePatterns) { const l=p.toLowerCase(); if(!stopWords.has(l)) freq[l]=(freq[l]||0)+2; }
  return Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,30).map(([w])=>w);
}

function extractImports(content, lang, fp) {
  const patterns = IMPORT_PATTERNS[lang] || IMPORT_PATTERNS.javascript;
  const imports = [];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(content)) !== null) {
      const imp = m[1].trim();
      if (imp && !imp.startsWith('.') && !imp.includes(':')) imports.push(imp);
      else if (imp.startsWith('.')) {
        const baseDir = path.dirname(fp);
        const exts = ['.js','.jsx','.ts','.tsx','.mjs','.cjs','.py','.java','.go','.rs','.json','.vue','.svelte'];
        const base = path.resolve(baseDir, imp);
        if (fs.existsSync(base)) {
          const s = fs.statSync(base);
          if (s.isDirectory()) {
            for (const ext of exts) { const f = path.join(base, `index${ext}`); if (fs.existsSync(f)) { imports.push(f); break; } }
          } else { imports.push(base); }
        } else {
          for (const ext of exts) { const f = base + ext; if (fs.existsSync(f)) { imports.push(f); break; } }
        }
      }
    }
  }
  return [...new Set(imports)];
}

function extractFunctions(content, lang) {
  const patterns = FUNC_PATTERNS[lang] || FUNC_PATTERNS.javascript;
  const funcs = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of patterns) {
      let m;
      while ((m = pattern.exec(lines[i])) !== null) {
        const n = m[1];
        if (n && !['if','for','while','switch','catch'].includes(n)) funcs.push({ name: n, line: i+1 });
      }
    }
  }
  return funcs;
}

function processFile(filePath, options) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > LARGE_FILE_THRESHOLD && !options.forceLarge) return null;

    const content = fs.readFileSync(filePath, 'utf8');
    const lang = getLang(filePath);
    const lines = splitLines(content);
    const chunkSize = options.chunkSize || 1000;
    const chunkOverlap = options.chunkOverlap || 100;

    const chunks = [];
    let current = [];
    let currentSize = 0;
    let overlap = [];

    for (let i = 0; i < lines.length; i++) {
      const lineSize = lines[i].length;
      if (currentSize + lineSize > chunkSize && current.length > 0) {
        const chunkContent = current.join('\n');
        const firstLine = current[0] || '';
        chunks.push({
          filePath, language: lang,
          startLine: i - current.length + 1, endLine: i,
          content: chunkContent, size: chunkContent.length,
          functionName: null,
        });

        overlap = [];
        let overlapSize = 0;
        for (let j = current.length - 1; j >= 0 && overlapSize < chunkOverlap; j--) {
          overlap.unshift(current[j]);
          overlapSize += current[j].length;
        }
        current = [...overlap];
        currentSize = overlapSize;
      }
      current.push(lines[i]);
      currentSize += lineSize;
    }
    if (current.length > 0) {
      const chunkContent = current.join('\n');
      chunks.push({
        filePath, language: lang,
        startLine: lines.length - current.length + 1, endLine: lines.length,
        content: chunkContent, size: chunkContent.length,
        functionName: null,
      });
    }

    for (const c of chunks) {
      c.keywords = extractKeywords(c.content, lang);
    }

    const imports = extractImports(content, lang, filePath);
    const funcs = extractFunctions(content, lang);

    return { filePath, language: lang, size: stat.size, lines: lines.length, chunks, imports, functions: funcs };
  } catch {
    return null;
  }
}

parentPort.on('message', (msg) => {
  if (msg.type === 'process') {
    const results = [];
    for (const fp of msg.files) {
      const result = processFile(fp, msg.options || {});
      if (result) results.push(result);
    }
    parentPort.postMessage({ type: 'result', id: msg.id, results });
  } else if (msg.type === 'exit') {
    process.exit(0);
  }
});

parentPort.postMessage({ type: 'ready' });
