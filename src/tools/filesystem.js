import fs from 'fs';
import path from 'path';

const MAX_FILE_SIZE = 5 * 1024 * 1024;

// Tidak ada path restriction — agent bisa akses folder manapun di sistem

export const filesystemTools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read contents of any file on the system. Max 5MB. Supports absolute paths anywhere.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to file' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates directories if needed. Overwrites existing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to file' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file by replacing exact text. Use for targeted changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to file' },
          old_string: { type: 'string', description: 'Exact text to find and replace' },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and subdirectories in a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative directory path' },
        },
        required: ['path'],
      },
    },
  },
];

export async function executeFileTool(name, args) {
  switch (name) {
    case 'read_file': {
      const stat = fs.statSync(args.path);
      if (stat.size > MAX_FILE_SIZE) {
        return { error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 5MB.` };
      }
      const content = fs.readFileSync(args.path, 'utf8');
      const lines = content.split('\n');
      return {
        content,
        lineCount: lines.length,
        size: stat.size,
        path: path.resolve(args.path),
      };
    }

    case 'write_file': {
      const dir = path.dirname(path.resolve(args.path));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(args.path, args.content, 'utf8');
      return { success: true, path: path.resolve(args.path), bytes: args.content.length };
    }

    case 'edit_file': {
      const current = fs.readFileSync(args.path, 'utf8');
      if (!current.includes(args.old_string)) {
        return { error: `old_string not found in file. Provide more surrounding context.` };
      }
      const updated = current.replace(args.old_string, args.new_string);
      fs.writeFileSync(args.path, updated, 'utf8');
      return { success: true, path: path.resolve(args.path), replaced: 1 };
    }

    case 'list_directory': {
      const entries = fs.readdirSync(args.path, { withFileTypes: true });
      return {
        path: path.resolve(args.path),
        items: entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          size: e.isFile() ? (fs.statSync(path.join(args.path, e.name)).size) : null,
        })),
        total: entries.length,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
