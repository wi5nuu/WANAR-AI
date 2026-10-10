import { spawn } from 'child_process';
import path from 'path';

const DEFAULT_WORKDIR = process.cwd();
const ALLOWED_BASE = process.cwd(); // Only allow commands within project directory
const MAX_OUTPUT = 100 * 1024;
const EXEC_MAX_BUFFER = 8 * 1024 * 1024; // stop accumulating output beyond this cap
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

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform === 'win32') {
      // child.kill() only kills cmd.exe, not grandchildren — use taskkill tree
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 1500).unref();
    }
  } catch { /* already dead */ }
}

/**
 * Async shell execution — never blocks the Node event loop.
 * Replaces execSync so the server can keep serving requests while a
 * bash tool call is running.
 */
function execShell(command, { cwd, timeout }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true });
    } catch (err) {
      resolve({ exitCode: 1, stdout: '', stderr: '', error: err.message.slice(0, 500) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutCapped = false;
    let stderrCapped = false;
    let timedOut = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);
    timer.unref?.();

    child.stdout.on('data', (chunk) => {
      if (stdout.length >= EXEC_MAX_BUFFER) { stdoutCapped = true; return; }
      stdout += chunk.toString('utf8');
      if (stdout.length > EXEC_MAX_BUFFER) stdoutCapped = true;
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length >= EXEC_MAX_BUFFER) { stderrCapped = true; return; }
      stderr += chunk.toString('utf8');
      if (stderr.length > EXEC_MAX_BUFFER) stderrCapped = true;
    });

    child.on('error', (err) => {
      finish({ exitCode: 1, stdout, stderr, error: err.message.slice(0, 500) });
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({
          exitCode: 1,
          stdout: stdout.slice(0, MAX_OUTPUT),
          stderr: stderr.slice(0, MAX_OUTPUT),
          error: `Command timed out after ${timeout}ms`,
        });
        return;
      }
      const exitCode = code === null ? (signal ? 1 : 0) : code;
      const slice = (s) =>
        s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n\n... (truncated, ${s.length} total bytes)` : s;
      const result = {
        exitCode,
        stdout: slice(stdout),
        stderr: slice(stderr),
        truncated: stdoutCapped || stderrCapped || stdout.length > MAX_OUTPUT || stderr.length > MAX_OUTPUT,
      };
      if (exitCode !== 0) {
        result.error = `Command failed with exit code ${exitCode}`.slice(0, 500);
      }
      finish(result);
    });
  });
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

      const { exitCode, stdout, stderr, error, truncated: bufTruncated } = await execShell(command, {
        cwd: workdir,
        timeout,
      });
      return { exitCode, stdout, stderr, error, truncated: bufTruncated };
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
