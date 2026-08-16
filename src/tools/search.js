import fs from 'fs';
import path from 'path';
import { glob as fastGlob } from 'glob';

const ALLOWED_BASE = path.resolve(process.cwd());

export const searchTools = [
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern. E.g. "src/**/*.js" or "*.json"',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match' },
          path: { type: 'string', description: 'Base directory (default: project root)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents for a regex pattern. Shows file:line matches.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search' },
          include: { type: 'string', description: 'File glob to filter (e.g. "*.js", "*.{ts,tsx}")' },
          path: { type: 'string', description: 'Directory to search (default: project root)' },
          maxResults: { type: 'number', description: 'Max results to return (default: 50)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_info',
      description: 'Get metadata about a file or directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path' },
        },
        required: ['path'],
      },
    },
  },
];

export async function executeSearchTool(name, args) {
  const searchPath = args.path || ALLOWED_BASE;
  const resolved = path.resolve(searchPath);

  switch (name) {
    case 'glob': {
      const matches = await fastGlob(args.pattern, {
        cwd: resolved,
        nodir: true,
        dot: true,
        ignore: ['node_modules/**', '.git/**'],
      });
      return { pattern: args.pattern, matches: matches.slice(0, 200), total: matches.length };
    }

    case 'grep': {
      const include = args.include || '*';
      const maxResults = args.maxResults || 50;
      const isGlob = p => {
        return p.includes('*') || p.includes('?') || p.includes('[');
      };

      let files;
      if (isGlob(include)) {
        files = await fastGlob(include, { cwd: resolved, nodir: true, dot: true, ignore: ['node_modules/**', '.git/**'] });
      } else {
        files = await fastGlob('**/*', { cwd: resolved, nodir: true, dot: true, ignore: ['node_modules/**', '.git/**'] });
        if (include !== '*') {
          files = files.filter(f => f.endsWith(include.replace('*.', '.')));
        }
      }

      const regex = new RegExp(args.pattern, 'gi');
      const matches = [];
      for (const file of files) {
        if (matches.length >= maxResults) break;
        try {
          const content = fs.readFileSync(path.join(resolved, file), 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 150)}`);
              if (matches.length >= maxResults) break;
            }
          }
        } catch { /* skip unreadable files */ }
      }
      return { pattern: args.pattern, matches, total: matches.length };
    }

    case 'file_info': {
      const stat = fs.statSync(args.path);
      return {
        path: path.resolve(args.path),
        type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
        size: stat.size,
        created: stat.birthtime,
        modified: stat.mtime,
        permissions: stat.mode.toString(8),
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
