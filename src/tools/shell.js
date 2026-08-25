import { execSync, spawn } from 'child_process';
import path from 'path';

const DEFAULT_WORKDIR = process.cwd();
const ALLOWED_BASE = process.cwd(); // Only allow commands within project directory
const MAX_OUTPUT = 100 * 1024;
const EXEC_MAX_BUFFER = 8 * 1024 * 1024; // hard cap for execSync before truncation
const TIMEOUT_MS = 30000;

// Dangerous commands that should be blocked
const DANGEROUS_COMMANDS = [
  'rm -rf /',
  'rm -rf /*',
  'format',
  'del /f /s /q',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init 0',
  'init 6',
  ':(){ :|:& };:',  // Fork bomb
  'dd if=',
  'mkfs',
  'fdisk',
  'parted',
  'chmod 777 /',
  'chown -R',
  '> /dev/sda',
  '> /dev/hda',
];

// Blocked command patterns (regex)
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,  // rm -rf /
  /rm\s+-rf\s+\*\s*/,  // rm -rf *
  /sudo\s+rm/,
  /chmod\s+777\s+\//,
  /chown\s+-R\s+/,
  /mkfs\./,
  /dd\s+if=/,
  /:\(\)\s*\{/,  // Fork bomb pattern
];

function sanitizeCommand(command) {
  if (!command || typeof command !== 'string') {
    throw new Error('Command must be a non-empty string');
  }

  const trimmed = command.trim();
  
  // Check for dangerous commands
  const lowerCmd = trimmed.toLowerCase();
  for (const dangerous of DANGEROUS_COMMANDS) {
    if (lowerCmd.includes(dangerous.toLowerCase())) {
      throw new Error(`Command blocked: dangerous operation detected (${dangerous})`);
    }
  }

  // Check blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new Error(`Command blocked: matches dangerous pattern`);
    }
  }

  // Prevent directory traversal in workdir
  return trimmed;
}

function validateWorkdir(workdir) {
  const resolved = path.resolve(workdir);
  const allowed = path.resolve(ALLOWED_BASE);

  // Segment-based check: a plain startsWith() would accept sibling
  // directories like <base>-evil because their path merely begins
  // with the base path as a substring.
  const rel = path.relative(allowed, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Workdir must be within project directory: ${allowed}`);
  }

  return resolved;
}

export const shellTools = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command. Supports any working directory on the system. Output truncated to 100KB.',
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
      let command;
      try {
        command = sanitizeCommand(args.command);
      } catch (error) {
        return {
          exitCode: -1,
          stdout: '',
          stderr: '',
          error: error.message,
        };
      }
      
      let workdir;
      try {
        workdir = validateWorkdir(args.workdir || ALLOWED_BASE);
      } catch (error) {
        return {
          exitCode: -1,
          stdout: '',
          stderr: '',
          error: error.message,
        };
      }
      
      const timeout = Math.min(args.timeout || TIMEOUT_MS, 120000);

      try {
        const output = execSync(command, {
          cwd: workdir,
          encoding: 'utf8',
          // Allow large outputs; we truncate to MAX_OUTPUT ourselves below.
          // With maxBuffer == MAX_OUTPUT execSync KILLS the child when the
          // output exceeds it, so successful commands were reported as failed.
          maxBuffer: EXEC_MAX_BUFFER,
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
        // Command succeeded but produced more than EXEC_MAX_BUFFER
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          const stdout = (err.stdout?.toString() || '').slice(0, MAX_OUTPUT);
          return {
            exitCode: 0,
            stdout: stdout + '\n\n... (truncated)',
            stderr: '',
            truncated: true,
          };
        }
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
      let npmArgs;
      try {
        npmArgs = sanitizeCommand(args.args);
      } catch (error) {
        return {
          exitCode: -1,
          stdout: '',
          stderr: '',
          error: error.message,
        };
      }
      return executeShellTool('bash', { command: `npm ${npmArgs}`, workdir: args.workdir, timeout: args.timeout });
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
