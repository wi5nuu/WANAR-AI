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
import { desktopTools, executeDesktopTool } from './desktop.js';
import { automationTools, executeAutomationTool } from './automation.js';
import { worklogTools, executeWorklogTool } from './worklog.js';
import { locationTools, executeLocationTool } from './location.js';
import {
  authorizeToolCall,
  refusalResult,
  GATED_TOOLS,
  _setScanGuard,
} from '../security/action-gate.js';
import * as scanGuard from '../security/scan-guard.js';

// Wire the allowlist checker into the gate. Done here (rather than as a static
// import inside action-gate.js) to keep the dependency direction one-way and
// avoid a circular import between registry and the security modules.
_setScanGuard(scanGuard);

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
  ...desktopTools,
  ...automationTools,
  ...worklogTools,
  ...locationTools,
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
  browser_interact: executeBrowserTool,
  // Browser Apply Agent
  browser_apply: executeBrowserApplyTool,
  browser_job_scan: executeBrowserApplyTool,
  // Desktop control (local machine, opt-in)
  mouse_control: executeDesktopTool,
  screen_capture: executeDesktopTool,
  // Automation (scheduling + email) — proposals only; sending is gated
  automation_status: executeAutomationTool,
  automation_list_channels: executeAutomationTool,
  automation_list_jobs: executeAutomationTool,
  automation_create_job: executeAutomationTool,
  automation_draft_email: executeAutomationTool,
  automation_send_campaign: executeAutomationTool,
  // Work journal (own data only)
  worklog_today: executeWorklogTool,
  worklog_summary: executeWorklogTool,
  worklog_log: executeWorklogTool,
  worklog_clock: executeWorklogTool,
  // Location / vehicle / personal memory (own data only; no emergency trigger)
  location_status: executeLocationTool,
  location_history: executeLocationTool,
  location_name_place: executeLocationTool,
  vehicle_status: executeLocationTool,
  fuel_log: executeLocationTool,
  odometer_read: executeLocationTool,
  maintenance_status: executeLocationTool,
  maintenance_log: executeLocationTool,
  memory_remember: executeLocationTool,
  memory_search: executeLocationTool,
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

/**
 * Executes a tool by name.
 *
 * Every tool call in the application funnels through here, which makes this the
 * single chokepoint for policy enforcement. Tools with real-world side effects
 * (shell, filesystem writes, outbound scanning, browser/desktop control) are
 * refused unless the call carries a valid, single-use, human-issued approval
 * bound to that exact tool and target. See security/action-gate.js.
 *
 * @param {string} name
 * @param {object} args
 * @param {object} [ctx] - optional execution context, e.g. { actor: 'http'|'chat'|'cli' }
 */
export async function executeTool(name, args = {}, ctx = {}) {
  const executor = toolExecutors[name];
  if (!executor) {
    return { error: `Unknown tool: ${name}` };
  }

  // Policy gate — runs before the executor for every call path.
  const decision = authorizeToolCall(name, args);
  if (!decision.allowed) {
    console.warn(
      `[ACTION-GATE] Blocked tool="${name}" code=${decision.code} actor=${ctx.actor || 'unknown'}`
    );
    return refusalResult(decision);
  }

  // Strip the approval token so it never reaches tool implementations or logs.
  const { __approvalId, ...cleanArgs } = args;

  try {
    return await executor(name, cleanArgs);
  } catch (err) {
    return { error: err.message };
  }
}

export function getToolDefinitions() {
  return allTools;
}
