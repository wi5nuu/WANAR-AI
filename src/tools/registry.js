import { filesystemTools, executeFileTool } from './filesystem.js';
import { searchTools, executeSearchTool } from './search.js';
import { shellTools, executeShellTool } from './shell.js';
import { systemTools, executeSystemTool } from './system.js';
import { securityTools, executeSecurityTool } from './security.js';
import { taskManagementTools, executeTaskManagementTool } from './task-management.js';
import { webFetchTools, executeWebFetchTool } from './web-fetch.js';
import { agentDelegationTools, executeAgentDelegationTool } from './agent-delegation.js';
import { codeIntelligenceTools, executeCodeIntelligenceTool } from './code-intelligence.js';
import { browserTools, executeBrowserTool } from './browser.js';
import { browserApplyTools, executeBrowserApplyTool } from './browser-apply.js';

export const allTools = [
  ...filesystemTools,
  ...searchTools,
  ...shellTools,
  ...systemTools,
  ...securityTools,
  ...taskManagementTools,
  ...webFetchTools,
  ...agentDelegationTools,
  ...codeIntelligenceTools,
  ...browserTools,
  ...browserApplyTools,
];

const toolExecutors = {
  // Filesystem
  read_file: executeFileTool,
  write_file: executeFileTool,
  edit_file: executeFileTool,
  list_directory: executeFileTool,
  // Search
  glob: executeSearchTool,
  grep: executeSearchTool,
  file_info: executeSearchTool,
  // Shell
  bash: executeShellTool,
  npm: executeShellTool,
  // System
  token_usage: executeSystemTool,
  system_info: executeSystemTool,
  database_stats: executeSystemTool,
  // Security
  security_scan: executeSecurityTool,
  auth_test: executeSecurityTool,
  api_fuzzing: executeSecurityTool,
  code_audit: executeSecurityTool,
  dependency_scan: executeSecurityTool,
  network_scan: executeSecurityTool,
  exploit_db_search: executeSecurityTool,
  generate_report: executeSecurityTool,
  // Task Management
  todo_write: executeTaskManagementTool,
  todo_read: executeTaskManagementTool,
  todo_complete: executeTaskManagementTool,
  todo_clear: executeTaskManagementTool,
  // Web Fetch
  web_fetch: executeWebFetchTool,
  // Browser Agent
  browser_open: executeBrowserTool,
  browser_search_page: executeBrowserTool,
  browser_extract_links: executeBrowserTool,
  browser_crawl: executeBrowserTool,
  // Browser Apply Agent
  browser_apply: executeBrowserApplyTool,
  browser_job_scan: executeBrowserApplyTool,
  // Agent Delegation
  agent_explore: executeAgentDelegationTool,
  agent_security: executeAgentDelegationTool,
  agent_refactor: executeAgentDelegationTool,
  agent_test: executeAgentDelegationTool,
  agent_document: executeAgentDelegationTool,
  // Code Intelligence
  code_analysis: executeCodeIntelligenceTool,
  dependency_graph: executeCodeIntelligenceTool,
  code_metrics: executeCodeIntelligenceTool,
  find_duplicates: executeCodeIntelligenceTool,
};

export async function executeTool(name, args) {
  const executor = toolExecutors[name];
  if (!executor) {
    return { error: `Unknown tool: ${name}` };
  }
  try {
    return await executor(name, args);
  } catch (err) {
    return { error: err.message };
  }
}

export function getToolDefinitions() {
  return allTools;
}
