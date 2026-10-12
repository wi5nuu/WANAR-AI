/**
 * tests/tools-registry.test.js
 * Unit tests for tools/registry.js and individual tool modules
 *
 * Key facts:
 * - filesystem.js and search.js throw on missing/bad paths (no try/catch in source)
 *   so executeTool catches and returns {error:...}, but executeFileTool/executeSearchTool throw
 * - list_directory returns { path, items: [...] }
 * - executeTool wraps throws into {error: ...}
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

import { allTools, executeTool, getToolDefinitions } from '../src/tools/registry.js';
import { filesystemTools, executeFileTool } from '../src/tools/filesystem.js';
import { searchTools, executeSearchTool } from '../src/tools/search.js';
import { shellTools, executeShellTool } from '../src/tools/shell.js';
import { systemTools, executeSystemTool } from '../src/tools/system.js';
import { taskManagementTools } from '../src/tools/task-management.js';
import { webFetchTools } from '../src/tools/web-fetch.js';
import { agentDelegationTools } from '../src/tools/agent-delegation.js';
import { codeIntelligenceTools } from '../src/tools/code-intelligence.js';
import { browserTools } from '../src/tools/browser.js';
import { browserApplyTools } from '../src/tools/browser-apply.js';
import { desktopTools } from '../src/tools/desktop.js';
import { automationTools } from '../src/tools/automation.js';
import { securityTools } from '../src/tools/security.js';

// ─────────────────────────────────────────────────────────────────────────────
// Registry: allTools & getToolDefinitions
// ─────────────────────────────────────────────────────────────────────────────
describe('tools/registry: allTools & getToolDefinitions', () => {
  it('allTools is a non-empty array', () => {
    expect(Array.isArray(allTools)).toBe(true);
    expect(allTools.length).toBeGreaterThan(0);
  });

  it('getToolDefinitions returns same array as allTools', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBe(allTools.length);
  });

  it('every tool definition has type === "function"', () => {
    for (const tool of allTools) expect(tool.type).toBe('function');
  });

  it('every tool has function.name string', () => {
    for (const tool of allTools) {
      expect(typeof tool.function.name).toBe('string');
      expect(tool.function.name.length).toBeGreaterThan(0);
    }
  });

  it('every tool has function.description string', () => {
    for (const tool of allTools) {
      expect(typeof tool.function.description).toBe('string');
      expect(tool.function.description.length).toBeGreaterThan(0);
    }
  });

  it('every tool has function.parameters object', () => {
    for (const tool of allTools) {
      expect(typeof tool.function.parameters).toBe('object');
      expect(tool.function.parameters).not.toBeNull();
    }
  });

  it('tool names are unique', () => {
    const names = allTools.map(t => t.function.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('includes tools from all modules', () => {
    const names = new Set(allTools.map(t => t.function.name));
    for (const n of ['read_file','write_file','edit_file','list_directory',
      'glob','grep','file_info','bash','npm','token_usage','system_info',
      'database_stats','security_scan','code_audit','todo_write','todo_read',
      'todo_complete','todo_clear','web_fetch','browser_open','browser_apply',
      'agent_explore','code_analysis']) {
      expect(names.has(n)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry: executeTool dispatcher
// ─────────────────────────────────────────────────────────────────────────────
describe('tools/registry: executeTool dispatcher', () => {
  it('returns error for unknown tool name', async () => {
    const result = await executeTool('nonexistent_tool_xyz', {});
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('Unknown tool');
  });

  it('dispatches read_file (bad path → error returned, not thrown)', async () => {
    const result = await executeTool('read_file', { path: '/nonexistent/xyz.txt' });
    expect(result).toHaveProperty('error');
  });

  it('dispatches list_directory for real path without throwing', async () => {
    const result = await executeTool('list_directory', { path: process.cwd() });
    // Must not be "Unknown tool" error
    expect(result.error ?? '').not.toMatch(/Unknown tool/);
  });

  it('dispatches token_usage without throwing', async () => {
    const result = await executeTool('token_usage', {});
    expect(result).toBeDefined();
  });

  it('dispatches system_info without throwing', async () => {
    const result = await executeTool('system_info', {});
    expect(result).toBeDefined();
  });

  it('dispatches glob with valid pattern', async () => {
    const result = await executeTool('glob', { pattern: '*.json', path: process.cwd() });
    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('dispatches todo_read without throwing', async () => {
    const result = await executeTool('todo_read', { filter: 'all' });
    expect(result).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem tool definitions
// ─────────────────────────────────────────────────────────────────────────────
describe('filesystemTools definitions', () => {
  it('has 4 tools', () => expect(filesystemTools.length).toBe(4));

  it('read_file requires path', () => {
    const t = filesystemTools.find(t => t.function.name === 'read_file');
    expect(t.function.parameters.required).toContain('path');
  });

  it('write_file requires path and content', () => {
    const t = filesystemTools.find(t => t.function.name === 'write_file');
    expect(t.function.parameters.required).toContain('path');
    expect(t.function.parameters.required).toContain('content');
  });

  it('edit_file requires path, old_string, new_string', () => {
    const t = filesystemTools.find(t => t.function.name === 'edit_file');
    expect(t.function.parameters.required).toContain('path');
    expect(t.function.parameters.required).toContain('old_string');
    expect(t.function.parameters.required).toContain('new_string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeFileTool: read_file
// ─────────────────────────────────────────────────────────────────────────────
describe('executeFileTool: read_file', () => {
  let tmpDir, tmpFile;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanar-fs-'));
    tmpFile = path.join(tmpDir, 'hello.txt');
    fs.writeFileSync(tmpFile, 'Hello, World!', 'utf8');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('reads existing file successfully', async () => {
    const result = await executeFileTool('read_file', { path: tmpFile });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain('Hello, World!');
  });

  it('throws for nonexistent file (source has no try/catch)', async () => {
    await expect(executeFileTool('read_file', { path: path.join(tmpDir, 'nope.txt') }))
      .rejects.toThrow();
  });

  it('includes path in result', async () => {
    const result = await executeFileTool('read_file', { path: tmpFile });
    expect(result.path).toBe(tmpFile);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeFileTool: write_file
// ─────────────────────────────────────────────────────────────────────────────
describe('executeFileTool: write_file', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanar-write-')); });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('writes new file', async () => {
    const fp = path.join(tmpDir, 'out.txt');
    await executeFileTool('write_file', { path: fp, content: 'test content' });
    expect(fs.readFileSync(fp, 'utf8')).toBe('test content');
  });

  it('creates nested directories if needed', async () => {
    const fp = path.join(tmpDir, 'a', 'b', 'c.txt');
    await executeFileTool('write_file', { path: fp, content: 'nested' });
    expect(fs.existsSync(fp)).toBe(true);
  });

  it('overwrites existing file', async () => {
    const fp = path.join(tmpDir, 'over.txt');
    fs.writeFileSync(fp, 'old', 'utf8');
    await executeFileTool('write_file', { path: fp, content: 'new content' });
    expect(fs.readFileSync(fp, 'utf8')).toBe('new content');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeFileTool: edit_file
// ─────────────────────────────────────────────────────────────────────────────
describe('executeFileTool: edit_file', () => {
  let tmpDir, tmpFile;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanar-edit-'));
    tmpFile = path.join(tmpDir, 'edit.txt');
    fs.writeFileSync(tmpFile, 'foo bar baz', 'utf8');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('replaces exact string', async () => {
    await executeFileTool('edit_file', { path: tmpFile, old_string: 'bar', new_string: 'qux' });
    expect(fs.readFileSync(tmpFile, 'utf8')).toBe('foo qux baz');
  });

  it('returns error when old_string not found', async () => {
    const result = await executeFileTool('edit_file', { path: tmpFile, old_string: 'notexist', new_string: 'x' });
    expect(result.error).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeFileTool: list_directory
// ─────────────────────────────────────────────────────────────────────────────
describe('executeFileTool: list_directory', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanar-ls-'));
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), '');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), '');
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('lists directory contents', async () => {
    const result = await executeFileTool('list_directory', { path: tmpDir });
    expect(result.error).toBeUndefined();
    // items is the actual key in filesystem.js
    const entries = result.items ?? result.entries ?? result.files ?? result.contents;
    expect(entries).toBeDefined();
  });

  it('throws for nonexistent directory (source has no try/catch)', async () => {
    await expect(executeFileTool('list_directory', { path: path.join(tmpDir, 'nonexistent') }))
      .rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Search tool definitions
// ─────────────────────────────────────────────────────────────────────────────
describe('searchTools definitions', () => {
  it('has glob, grep, file_info', () => {
    const names = searchTools.map(t => t.function.name);
    expect(names).toContain('glob');
    expect(names).toContain('grep');
    expect(names).toContain('file_info');
  });
});

describe('executeSearchTool: glob', () => {
  it('finds json files in project root', async () => {
    const result = await executeSearchTool('glob', { pattern: '*.json', path: process.cwd() });
    expect(result.error).toBeUndefined();
    const list = result.files ?? result.matches ?? result.results ?? [];
    expect(Array.isArray(list)).toBe(true);
  });

  it('returns empty list for unmatched pattern', async () => {
    const result = await executeSearchTool('glob', { pattern: '*.xyznonexistent', path: process.cwd() });
    const list = result.files ?? result.matches ?? result.results ?? [];
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(0);
  });
});

describe('executeSearchTool: grep', () => {
  it('finds matches in src files', async () => {
    const result = await executeSearchTool('grep', {
      pattern: 'import',
      include: '*.js',
      path: path.join(process.cwd(), 'src'),
    });
    expect(result.error).toBeUndefined();
    const matches = result.matches ?? result.results ?? [];
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('returns empty for pattern that matches nothing', async () => {
    const result = await executeSearchTool('grep', {
      pattern: 'XYZNONEXISTENTPATTERN12345',
      path: process.cwd(),
    });
    const matches = result.matches ?? result.results ?? [];
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.length).toBe(0);
  });
});

describe('executeSearchTool: file_info', () => {
  it('returns metadata for existing file', async () => {
    const result = await executeSearchTool('file_info', { path: path.join(process.cwd(), 'package.json') });
    expect(result.error).toBeUndefined();
    expect(result).toHaveProperty('size');
  });

  it('throws for nonexistent path (source has no try/catch)', async () => {
    await expect(executeSearchTool('file_info', { path: path.join(process.cwd(), '_nonexistent_xyz_.txt') }))
      .rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shell tools
// ─────────────────────────────────────────────────────────────────────────────
describe('shellTools definitions', () => {
  it('has bash and npm', () => {
    const names = shellTools.map(t => t.function.name);
    expect(names).toContain('bash');
    expect(names).toContain('npm');
  });
  it('bash requires command', () => {
    const t = shellTools.find(t => t.function.name === 'bash');
    expect(t.function.parameters.required).toContain('command');
  });
});

describe('executeShellTool: bash security', () => {
  it('blocks rm -rf / command', async () => {
    const result = await executeShellTool('bash', { command: 'rm -rf /' });
    expect(result.error).toBeTruthy();
    expect(result.error.toLowerCase()).toMatch(/block|danger/i);
  });

  it('blocks fork bomb', async () => {
    const result = await executeShellTool('bash', { command: ':(){ :|:& };:' });
    expect(result.error).toBeTruthy();
  });

  it('blocks mkfs command', async () => {
    const result = await executeShellTool('bash', { command: 'mkfs.ext4 /dev/sda' });
    expect(result.error).toBeTruthy();
  });

  it('blocks workdir outside project root', async () => {
    const result = await executeShellTool('bash', {
      command: 'echo hello',
      workdir: 'C:\\Windows\\System32',
    });
    expect(result.error).toBeTruthy();
  });

  it('allows safe echo command', async () => {
    const result = await executeShellTool('bash', {
      command: 'echo hello_world',
      workdir: process.cwd(),
    });
    expect(result.error).toBeUndefined();
    const out = result.output ?? result.stdout ?? '';
    expect(out).toContain('hello_world');
  }, 10000);

  it('captures stdout output', async () => {
    const result = await executeShellTool('bash', {
      command: 'node -e "console.log(42)"',
      workdir: process.cwd(),
    });
    expect(result.error).toBeUndefined();
    const out = result.output ?? result.stdout ?? '';
    expect(out).toContain('42');
  }, 10000);

  it('returns error for missing command param', async () => {
    const result = await executeShellTool('bash', {});
    expect(result.error).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// System tools
// ─────────────────────────────────────────────────────────────────────────────
describe('systemTools definitions', () => {
  it('has token_usage, system_info, database_stats', () => {
    const names = systemTools.map(t => t.function.name);
    expect(names).toContain('token_usage');
    expect(names).toContain('system_info');
    expect(names).toContain('database_stats');
  });
});

describe('executeSystemTool', () => {
  it('token_usage returns object', async () => {
    const result = await executeSystemTool('token_usage', {});
    expect(typeof result).toBe('object');
  });

  it('system_info returns object without error', async () => {
    const result = await executeSystemTool('system_info', {});
    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('database_stats returns object', async () => {
    const result = await executeSystemTool('database_stats', {});
    expect(result).toBeDefined();
  });

  it('unknown system tool returns error', async () => {
    const result = await executeSystemTool('unknown_system_xyz', {});
    expect(result.error).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security tools definitions
// ─────────────────────────────────────────────────────────────────────────────
describe('securityTools definitions', () => {
  it('has expected security tools', () => {
    const names = securityTools.map(t => t.function.name);
    expect(names).toContain('security_scan');
    expect(names).toContain('auth_test');
    expect(names).toContain('code_audit');
    expect(names).toContain('dependency_scan');
    expect(names).toContain('network_scan');
    expect(names).toContain('generate_report');
  });

  it('security_scan has target and scanType params', () => {
    const t = securityTools.find(t => t.function.name === 'security_scan');
    const props = t.function.parameters.properties;
    expect(props).toHaveProperty('target');
    expect(props).toHaveProperty('scanType');
  });

  it('all security tools have required params defined', () => {
    for (const t of securityTools) {
      expect(Array.isArray(t.function.parameters.required)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Other tool module definitions
// ─────────────────────────────────────────────────────────────────────────────
describe('webFetchTools definitions', () => {
  it('has web_fetch', () => expect(webFetchTools.map(t => t.function.name)).toContain('web_fetch'));
  it('web_fetch requires url', () => {
    const t = webFetchTools.find(t => t.function.name === 'web_fetch');
    expect(t.function.parameters.required).toContain('url');
  });
});

describe('agentDelegationTools definitions', () => {
  it('has all 5 agent tools', () => {
    const names = agentDelegationTools.map(t => t.function.name);
    for (const n of ['agent_explore','agent_security','agent_refactor','agent_test','agent_document']) {
      expect(names).toContain(n);
    }
  });
  it('agent_explore has thoroughness param', () => {
    const t = agentDelegationTools.find(t => t.function.name === 'agent_explore');
    expect(t.function.parameters.properties).toHaveProperty('thoroughness');
  });
});

describe('codeIntelligenceTools definitions', () => {
  it('has code_analysis, dependency_graph, code_metrics, find_duplicates', () => {
    const names = codeIntelligenceTools.map(t => t.function.name);
    for (const n of ['code_analysis','dependency_graph','code_metrics','find_duplicates']) {
      expect(names).toContain(n);
    }
  });
  it('dependency_graph has output_format param', () => {
    const t = codeIntelligenceTools.find(t => t.function.name === 'dependency_graph');
    expect(t.function.parameters.properties).toHaveProperty('output_format');
  });
});

describe('browserTools definitions', () => {
  it('has 4 browser tools', () => {
    const names = browserTools.map(t => t.function.name);
    for (const n of ['browser_open','browser_search_page','browser_extract_links','browser_crawl']) {
      expect(names).toContain(n);
    }
  });
  it('browser_open requires url', () => {
    const t = browserTools.find(t => t.function.name === 'browser_open');
    expect(t.function.parameters.required).toContain('url');
  });
});

describe('browserApplyTools definitions', () => {
  it('has browser_apply and browser_job_scan', () => {
    const names = browserApplyTools.map(t => t.function.name);
    expect(names).toContain('browser_apply');
    expect(names).toContain('browser_job_scan');
  });
  it('browser_apply has action param', () => {
    const t = browserApplyTools.find(t => t.function.name === 'browser_apply');
    expect(t.function.parameters.properties).toHaveProperty('action');
  });
  it('browser_job_scan has filter_type param', () => {
    const t = browserApplyTools.find(t => t.function.name === 'browser_job_scan');
    expect(t.function.parameters.properties).toHaveProperty('filter_type');
  });
});

describe('taskManagementTools definitions', () => {
  it('has 4 tools', () => expect(taskManagementTools.length).toBe(4));
  it('all have type function', () => {
    for (const t of taskManagementTools) expect(t.type).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Total count
// ─────────────────────────────────────────────────────────────────────────────
describe('total tool count', () => {
  it('allTools has at least 30 tools', () => expect(allTools.length).toBeGreaterThanOrEqual(30));

  it('allTools count matches sum of all module arrays', () => {
    const expected =
      filesystemTools.length + searchTools.length + shellTools.length +
      systemTools.length + securityTools.length + taskManagementTools.length +
      webFetchTools.length + agentDelegationTools.length + codeIntelligenceTools.length +
      browserTools.length + browserApplyTools.length + desktopTools.length +
      automationTools.length;
    expect(allTools.length).toBe(expected);
  });
});
