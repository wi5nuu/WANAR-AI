import fs from 'fs';
import path from 'path';

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rs', '.rb', '.php',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.swift', '.kt', '.scala', '.dart',
  '.sh', '.bash', '.zsh', '.ps1', '.sql',
  '.html', '.css', '.scss', '.sass', '.less',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.md',
  '.vue', '.svelte', '.astro', '.ejs', '.hbs',
  '.graphql', '.proto', '.prisma',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '__pycache__', '.next', '.nuxt',
  'dist', 'build', '.cache', '.turbo', 'coverage',
  '.venv', 'venv', 'env', '.env',
  'target', 'bin', 'obj', 'out',
  'vendor', '.bundle',
  'public', 'static', 'assets', 'images', 'fonts',
  '*.log', '*.lock',
]);

const LARGE_FILE_THRESHOLD = 1024 * 1024;

function isCodeFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

function shouldIgnore(dirName) {
  if (IGNORE_DIRS.has(dirName)) return true;
  if (dirName.startsWith('.')) return true;
  return false;
}

function getLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const langMap = {
    '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.py': 'python', '.java': 'java', '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
    '.php': 'php', '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
    '.cs': 'csharp', '.swift': 'swift', '.kt': 'kotlin', '.scala': 'scala',
    '.dart': 'dart', '.sh': 'bash', '.bash': 'bash', '.ps1': 'powershell',
    '.html': 'html', '.css': 'css', '.scss': 'scss', '.sql': 'sql',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
    '.xml': 'xml', '.md': 'markdown', '.vue': 'vue', '.svelte': 'svelte',
    '.graphql': 'graphql', '.proto': 'protobuf', '.prisma': 'prisma',
  };
  return langMap[ext] || 'text';
}

function splitIntoLines(text) {
  return text.split(/\r?\n/);
}

function extractFunctionName(line, language) {
  const patterns = {
    javascript: /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|(?:export\s+)?(?:default\s+)?(?:class|interface|type)\s+(\w+))/,
    python: /(?:def\s+(\w+)|class\s+(\w+))/,
    java: /(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:\w+\s+)?(\w+)\s*\(/,
    go: /(?:func\s+(\w+)|type\s+(\w+)\s+struct)/,
    rust: /(?:fn\s+(\w+)|struct\s+(\w+)|enum\s+(\w+)|impl\s+(\w+))/,
  };
  const pattern = patterns[language] || patterns['javascript'];
  const match = line.match(pattern);
  return match ? match.find(m => m !== undefined && m !== null) || null : null;
}

export function chunkFile(filePath, options = {}) {
  const chunkSize = options.chunkSize || 1000;
  const chunkOverlap = options.chunkOverlap || 100;

  const stat = fs.statSync(filePath);
  if (stat.size > LARGE_FILE_THRESHOLD && !options.forceLarge) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = splitIntoLines(content);
  const language = getLanguage(filePath);
  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;
  let overlap = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineSize = line.length;

    if (currentSize + lineSize > chunkSize && currentChunk.length > 0) {
      const chunkContent = currentChunk.join('\n');
      const firstLine = currentChunk[0] || '';
      const funcName = extractFunctionName(firstLine, language);

      chunks.push({
        filePath,
        language,
        startLine: i - currentChunk.length + 1,
        endLine: i,
        content: chunkContent,
        size: chunkContent.length,
        functionName: funcName || null,
        keywords: extractKeywords(chunkContent, language),
      });

      overlap = [];
      let overlapSize = 0;
      for (let j = currentChunk.length - 1; j >= 0 && overlapSize < chunkOverlap; j--) {
        overlap.unshift(currentChunk[j]);
        overlapSize += currentChunk[j].length;
      }
      currentChunk = [...overlap];
      currentSize = overlapSize;
    }

    currentChunk.push(line);
    currentSize += lineSize;
  }

  if (currentChunk.length > 0) {
    const chunkContent = currentChunk.join('\n');
    const firstLine = currentChunk[0] || '';
    const funcName = extractFunctionName(firstLine, language);

    chunks.push({
      filePath,
      language,
      startLine: lines.length - currentChunk.length + 1,
      endLine: lines.length,
      content: chunkContent,
      size: chunkContent.length,
      functionName: funcName || null,
      keywords: extractKeywords(chunkContent, language),
    });
  }

  return chunks;
}

function extractKeywords(content, language) {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
    'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'need',
    'this', 'that', 'these', 'those', 'it', 'its', 'if', 'then', 'else',
    'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
    'more', 'most', 'some', 'any', 'no', 'not', 'only', 'own', 'same',
    'so', 'than', 'too', 'very', 'just', 'because', 'about', 'into',
    'over', 'such', 'here', 'there', 'which', 'what', 'who', 'whom',
    'const', 'let', 'var', 'function', 'return', 'import', 'export',
    'default', 'from', 'async', 'await', 'true', 'false', 'null',
    'undefined', 'new', 'throw', 'try', 'catch', 'finally', 'typeof',
    'instanceof', 'void', 'delete', 'class', 'extends', 'super',
  ]);

  const words = content
    .replace(/[^a-zA-Z0-9_$]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()))
    .map(w => w.toLowerCase());

  const freq = {};
  for (const word of words) {
    freq[word] = (freq[word] || 0) + 1;
  }

  const codePatterns = content.match(/\b([A-Z][a-zA-Z0-9_]+)\b/g) || [];
  for (const p of codePatterns) {
    const lower = p.toLowerCase();
    if (!stopWords.has(lower)) {
      freq[lower] = (freq[lower] || 0) + 2;
    }
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([word]) => word);
}

export function walkDirectory(dirPath, options = {}) {
  const maxDepth = options.maxDepth || 10;
  const maxFiles = options.maxFiles || 10000;
  let files = [];
  let count = 0;

  function walk(currentPath, depth) {
    if (depth > maxDepth || count >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (count >= maxFiles) return;
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        if (!shouldIgnore(entry.name)) {
          walk(fullPath, depth + 1);
        }
      } else if (entry.isFile() && isCodeFile(fullPath)) {
        files.push(fullPath);
        count++;
      }
    }
  }

  walk(dirPath, 0);
  return files;
}

export function chunkDirectory(dirPath, options = {}) {
  const files = walkDirectory(dirPath, options);
  const allChunks = [];

  for (const filePath of files) {
    try {
      const chunks = chunkFile(filePath, options);
      allChunks.push(...chunks);
    } catch {
      // skip unreadable files
    }
  }

  return allChunks;
}

export default { chunkFile, chunkDirectory, walkDirectory, extractKeywords, getLanguage };
