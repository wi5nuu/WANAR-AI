import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

// ============================================
// WANAR AI - CODE INTELLIGENCE
// by Wisnu Alfian Nur Ashar
// ============================================
// AST analysis, dependency graph, code metrics

export const codeIntelligenceTools = [
  {
    type: 'function',
    function: {
      name: 'code_analysis',
      description: 'Perform deep code analysis including complexity metrics, code smells, and maintainability index.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to file or directory to analyze' },
          analysis_type: { type: 'string', enum: ['complexity', 'maintainability', 'dependencies', 'full'], description: 'Type of analysis to perform', default: 'full' }
        },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dependency_graph',
      description: 'Generate dependency graph for the project.',
      parameters: {
        type: 'object',
        properties: {
          root_path: { type: 'string', description: 'Root directory of the project' },
          output_format: { type: 'string', enum: ['json', 'text', 'mermaid'], description: 'Format for dependency graph output', default: 'text' },
          max_depth: { type: 'number', description: 'Maximum depth to traverse (default: unlimited)', minimum: 1 }
        },
        required: ['root_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'code_metrics',
      description: 'Calculate code metrics like lines of code, comment ratio, cyclomatic complexity.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to analyze' },
          language: { type: 'string', enum: ['javascript', 'typescript', 'python', 'java', 'auto'], description: 'Programming language (auto-detect)', default: 'auto' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_duplicates',
      description: 'Find duplicate or similar code blocks across the codebase.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to scan for duplicates' },
          similarity_threshold: { type: 'number', description: 'Similarity threshold (0-100, default: 80)', minimum: 0, maximum: 100, default: 80 }
        },
        required: ['path']
      }
    }
  }
];

export async function executeCodeIntelligenceTool(toolName, args) {
  switch (toolName) {
    case 'code_analysis':
      return await codeAnalysis(args);
    case 'dependency_graph':
      return await dependencyGraph(args);
    case 'code_metrics':
      return await codeMetrics(args);
    case 'find_duplicates':
      return await findDuplicates(args);
    default:
      return { error: `Unknown code intelligence tool: ${toolName}` };
  }
}

// ── Code Analysis ──
async function codeAnalysis(args) {
  const { file_path, analysis_type = 'full' } = args;

  if (!fs.existsSync(file_path)) {
    return { error: `Path not found: ${file_path}` };
  }

  const results = {
    path: file_path,
    analysis_type,
    timestamp: new Date().toISOString(),
    findings: []
  };

  try {
    const stats = fs.statSync(file_path);
    
    if (stats.isFile()) {
      const content = fs.readFileSync(file_path, 'utf8');
      const lines = content.split('\n');
      
      // Complexity analysis
      if (analysis_type === 'complexity' || analysis_type === 'full') {
        const complexity = analyzeComplexity(content);
        results.complexity = complexity;
      }

      // Maintainability analysis
      if (analysis_type === 'maintainability' || analysis_type === 'full') {
        const maintainability = analyzeMaintainability(content, lines);
        results.maintainability = maintainability;
      }

      // Dependencies analysis
      if (analysis_type === 'dependencies' || analysis_type === 'full') {
        const dependencies = analyzeDependencies(content);
        results.dependencies = dependencies;
      }

    } else if (stats.isDirectory()) {
      results.message = 'Directory analysis - scanning all files';
      // TODO: Implement directory scanning
    }

    return results;

  } catch (error) {
    return {
      error: 'Code analysis failed',
      details: error.message
    };
  }
}

// Helper: Analyze code complexity
function analyzeComplexity(content) {
  const complexity = {
    cyclomatic: 1, // Base complexity
    cognitive: 0,
    issues: []
  };

  // Count decision points
  const decisionPatterns = [
    /if\s*\(/g,
    /else\s+if/g,
    /while\s*\(/g,
    /for\s*\(/g,
    /case\s+/g,
    /catch\s*\(/g,
    /\?\s*.*\s*:/g, // Ternary
    /&&/g,
    /\|\|/g
  ];

  decisionPatterns.forEach(pattern => {
    const matches = content.match(pattern);
    if (matches) {
      complexity.cyclomatic += matches.length;
      complexity.cognitive += matches.length;
    }
  });

  // Check for deeply nested code
  const maxNesting = findMaxNesting(content);
  if (maxNesting > 4) {
    complexity.issues.push(`High nesting level: ${maxNesting} (recommended: <= 4)`);
  }

  // Check for long functions
  const functionLengths = findFunctionLengths(content);
  functionLengths.forEach(({ name, length }) => {
    if (length > 50) {
      complexity.issues.push(`Long function '${name}': ${length} lines (recommended: <= 50)`);
    }
  });

  if (complexity.cyclomatic > 10) {
    complexity.rating = 'high';
    complexity.recommendation = 'Consider refactoring to reduce complexity';
  } else if (complexity.cyclomatic > 5) {
    complexity.rating = 'moderate';
  } else {
    complexity.rating = 'low';
  }

  return complexity;
}

// Helper: Analyze maintainability
function analyzeMaintainability(content, lines) {
  const totalLines = lines.length;
  const codeLines = lines.filter(l => l.trim() && !l.trim().startsWith('//')).length;
  const commentLines = lines.filter(l => l.trim().startsWith('//')).length;
  const blankLines = totalLines - codeLines - commentLines;

  const commentRatio = (commentLines / codeLines) * 100;

  return {
    total_lines: totalLines,
    code_lines: codeLines,
    comment_lines: commentLines,
    blank_lines: blankLines,
    comment_ratio: commentRatio.toFixed(2) + '%',
    rating: commentRatio > 10 ? 'good' : commentRatio > 5 ? 'moderate' : 'low',
    recommendation: commentRatio < 10 ? 'Consider adding more documentation' : 'Good documentation coverage'
  };
}

// Helper: Analyze dependencies
function analyzeDependencies(content) {
  const imports = [];
  
  // ES6 imports
  const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // CommonJS requires
  const requireRegex = /require\s*\(['"]([^'"]+)['"]\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  return {
    total: imports.length,
    external: imports.filter(i => !i.startsWith('.') && !i.startsWith('/')).length,
    internal: imports.filter(i => i.startsWith('.') || i.startsWith('/')).length,
    list: [...new Set(imports)]
  };
}

// Helper functions
function findMaxNesting(content) {
  let maxDepth = 0;
  let currentDepth = 0;
  
  for (const char of content) {
    if (char === '{') {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    } else if (char === '}') {
      currentDepth--;
    }
  }
  
  return maxDepth;
}

function findFunctionLengths(content) {
  const functions = [];
  const functionRegex = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>))\s*\{/g;
  
  let match;
  while ((match = functionRegex.exec(content)) !== null) {
    const name = match[1] || match[2] || 'anonymous';
    const startPos = match.index;
    
    // Find end of function (simplified)
    let depth = 1;
    let endPos = startPos;
    for (let i = match.index + match[0].length; i < content.length; i++) {
      if (content[i] === '{') depth++;
      if (content[i] === '}') {
        depth--;
        if (depth === 0) {
          endPos = i;
          break;
        }
      }
    }
    
    const functionContent = content.substring(startPos, endPos);
    const lines = functionContent.split('\n').length;
    functions.push({ name, length: lines });
  }
  
  return functions;
}

// ── Dependency Graph ──
async function dependencyGraph(args) {
  const { root_path, output_format = 'text', max_depth } = args;

  if (!fs.existsSync(root_path)) {
    return { error: `Path not found: ${root_path}` };
  }

  const graph = {
    root: root_path,
    format: output_format,
    nodes: [],
    edges: [],
    timestamp: new Date().toISOString()
  };

  try {
    // Scan for JavaScript/TypeScript files
    const files = scanDirectory(root_path, ['.js', '.ts', '.jsx', '.tsx'], max_depth);
    
    files.forEach(file => {
      const content = fs.readFileSync(file, 'utf8');
      const imports = extractImports(content);
      
      graph.nodes.push(file);
      
      imports.forEach(imp => {
        const resolvedPath = resolveImportPath(file, imp, root_path);
        if (resolvedPath) {
          graph.edges.push({ from: file, to: resolvedPath, import: imp });
        }
      });
    });

    // Format output
    if (output_format === 'mermaid') {
      graph.visualization = generateMermaidDiagram(graph);
    } else if (output_format === 'text') {
      graph.visualization = generateTextGraph(graph);
    }

    return graph;

  } catch (error) {
    return {
      error: 'Dependency graph generation failed',
      details: error.message
    };
  }
}

// Helper: Scan directory recursively
function scanDirectory(dir, extensions, maxDepth, currentDepth = 0) {
  const files = [];
  
  if (maxDepth && currentDepth >= maxDepth) {
    return files;
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        files.push(...scanDirectory(fullPath, extensions, maxDepth, currentDepth + 1));
      } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    // Skip directories we can't read
  }
  
  return files;
}

// Helper: Extract imports from code
function extractImports(content) {
  const imports = [];
  
  const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  
  return imports;
}

// Helper: Resolve import path
function resolveImportPath(fromFile, importPath, rootPath) {
  if (!importPath.startsWith('.')) {
    return null; // External module
  }
  
  const fromDir = path.dirname(fromFile);
  const resolved = path.resolve(fromDir, importPath);
  
  // Try common extensions
  const extensions = ['', '.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts'];
  for (const ext of extensions) {
    const fullPath = resolved + ext;
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  
  return resolved;
}

// Helper: Generate Mermaid diagram
function generateMermaidDiagram(graph) {
  let mermaid = 'graph TD\n';
  
  const nodeIds = new Map();
  graph.nodes.forEach((node, idx) => {
    const id = `N${idx}`;
    const label = path.basename(node);
    nodeIds.set(node, id);
    mermaid += `  ${id}["${label}"]\n`;
  });
  
  graph.edges.forEach(edge => {
    const fromId = nodeIds.get(edge.from);
    const toId = nodeIds.get(edge.to);
    if (fromId && toId) {
      mermaid += `  ${fromId} --> ${toId}\n`;
    }
  });
  
  return mermaid;
}

// Helper: Generate text graph
function generateTextGraph(graph) {
  let text = 'Dependency Graph:\n\n';
  
  graph.nodes.forEach(node => {
    const deps = graph.edges.filter(e => e.from === node);
    text += `${path.basename(node)}\n`;
    deps.forEach(dep => {
      text += `  └─> ${path.basename(dep.to)}\n`;
    });
    text += '\n';
  });
  
  return text;
}

// ── Code Metrics ──
async function codeMetrics(args) {
  const { path: targetPath, language = 'auto' } = args;

  if (!fs.existsSync(targetPath)) {
    return { error: `Path not found: ${targetPath}` };
  }

  // Use existing code analysis functionality
  return await codeAnalysis({ file_path: targetPath, analysis_type: 'full' });
}

// ── Find Duplicates ──
async function findDuplicates(args) {
  const { path: targetPath, similarity_threshold = 80 } = args;

  return {
    path: targetPath,
    similarity_threshold,
    message: 'Duplicate detection requires AST comparison',
    note: 'Full implementation would use token-based comparison or AST diffing',
    suggestion: 'Use tools like jscpd or PMD for production-grade duplicate detection'
  };
}

export default {
  codeIntelligenceTools,
  executeCodeIntelligenceTool
};
