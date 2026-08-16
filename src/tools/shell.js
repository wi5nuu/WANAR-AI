import { execSync, spawn } from 'child_process';
import path from 'path';

const ALLOWED_BASE = path.resolve(process.cwd());
const MAX_OUTPUT = 100 * 1024;
const TIMEOUT_MS = 30000;

export const shellTools = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command in the project directory. Output truncated to 100KB.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
          workdir: { type: 'string', description: 'Working directory (default: project root)' },
          timeout: { type: 'number', description: 'Timeout in ms (default: 30000, max: 120000)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'npm',
      description: 'Run an npm command (install, run script, etc.) in the project.',
      parameters: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'npm arguments (e.g. "install", "run build", "test")' },
        },
        required: ['args'],
      },
    },
  },
];

export async function executeShellTool(name, args) {
  switch (name) {
    case 'bash': {
      const workdir = path.resolve(args.workdir || ALLOWED_BASE);
      const timeout = Math.min(args.timeout || TIMEOUT_MS, 120000);

      try {
        const output = execSync(args.command, {
          cwd: workdir,
          encoding: 'utf8',
          maxBuffer: MAX_OUTPUT,
          timeout,
          windowsHide: true,
        });
        const truncated = output.length > MAX_OUTPUT;
        const content = truncated ? output.slice(0, MAX_OUTPUT) + `\n\n... (truncated, ${output.length} total bytes)` : output;
        return {
          exitCode: 0,
          stdout: content,
          truncated,
        };
      } catch (err) {
        const stderr = err.stderr?.toString().slice(0, MAX_OUTPUT) || '';
        const stdout = err.stdout?.toString().slice(0, MAX_OUTPUT) || '';
        return {
          exitCode: err.status || 1,
          stdout,
          stderr,
          error: err.message.slice(0, 500),
        };
      }
    }

    case 'npm': {
      return executeShellTool('bash', { command: `npm ${args.args}`, workdir: args.workdir, timeout: args.timeout });
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
