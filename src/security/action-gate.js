/**
 * src/security/action-gate.js
 *
 * Human-in-the-loop authorization gate for tools that can cause real-world
 * side effects (shell execution, filesystem writes, outbound scanning, browser
 * automation, desktop control).
 *
 * Threat model
 * ------------
 * The agent's tool arguments are *model-generated*. They are therefore
 * untrusted: a prompt-injection payload hidden in a fetched web page or an
 * uploaded document can attempt to steer the agent into running a destructive
 * or offensive tool. This module makes that impossible to do silently.
 *
 * Design
 * ------
 * A side-effecting tool call is refused unless it carries a matching approval
 * token. Tokens are:
 *
 *   - Bound  : to (toolName, target). An approval for one target is worthless
 *              on another.
 *   - Single-use : consumed on first execution, so a repeated call re-prompts.
 *   - Short-lived: expire after APPROVAL_TTL_MS (default 10 minutes).
 *   - Out-of-band: minted only through a human-facing channel. The agent cannot
 *              create one, because minting requires either an explicit operator
 *              CLI action or a user-confirmed HTTP request.
 *
 * The allowlist (SCAN_ALLOWED_TARGETS) is enforced as a HARD block that runs
 * *before* approval is even considered. No approval can authorize a target the
 * operator has not declared as owned. This preserves the property that the
 * scanner can never be pointed at a third party.
 *
 * This gate is defense-in-depth, not a replacement for authentication. It
 * assumes an untrusted caller may reach the HTTP layer.
 */

import crypto from 'node:crypto';

const APPROVAL_TTL_MS = parseInt(process.env.TOOL_APPROVAL_TTL_MS || '600000', 10);

/**
 * Tools that require explicit human approval before running.
 *
 * Grouped by blast radius so the policy is reviewable at a glance.
 */
export const GATED_TOOLS = Object.freeze({
  // Arbitrary code execution on the host.
  bash: 'shell_execution',
  npm: 'shell_execution',

  // Host filesystem mutation. Today these have no path confinement, so an
  // approval here is an approval for any path the process can reach.
  write_file: 'filesystem_write',
  edit_file: 'filesystem_write',

  // Outbound security testing. These send attack traffic to a remote host.
  security_scan: 'offensive_scan',
  auth_test: 'offensive_scan',
  api_fuzzing: 'offensive_scan',
  network_scan: 'offensive_scan',
  exploit_db_search: 'offensive_recon',

  // Local browser automation (can navigate off-network, submit forms).
  browser_open: 'browser_automation',
  browser_interact: 'browser_automation',
  browser_crawl: 'browser_automation',
  browser_search_page: 'browser_automation',
  browser_extract_links: 'browser_automation',
  browser_apply: 'browser_automation',
  browser_job_scan: 'browser_automation',

  // OS-level input injection and screen capture.
  mouse_control: 'desktop_control',
  screen_capture: 'desktop_control',
});

/** Tools whose "target" argument should be validated against the scan allowlist. */
const ALLOWLIST_ENFORCED_TOOLS = new Set([
  'security_scan',
  'auth_test',
  'api_fuzzing',
  'network_scan',
  'browser_open',
  'browser_crawl',
  'browser_search_page',
  'browser_extract_links',
]);

/**
 * In-memory approval store. Process-local by design: an approval is a
 * short-lived, single-use human decision, not durable state worth persisting
 * across restarts. A restart invalidating pending approvals is a safe default.
 */
const approvals = new Map(); // id -> { id, tool, target, category, createdAt, expiresAt, reason, approvedBy }

function nowMs() {
  return Date.now();
}

function pruneExpired() {
  const t = nowMs();
  for (const [id, entry] of approvals) {
    if (entry.expiresAt <= t) approvals.delete(id);
  }
}

/**
 * Extracts the most security-relevant "target" from a tool's arguments so the
 * approval can be bound to it. Falls back to a stable hash of the full argument
 * set when there is no obvious target, so an approval can never be replayed
 * against different arguments.
 */
export function extractTarget(toolName, args = {}) {
  const candidate =
    args.target ??
    args.url ??
    args.host ??
    args.path ??
    args.command ??
    args.cwd;

  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();

  // No obvious target: bind to a digest of the arguments instead.
  return `args:${crypto
    .createHash('sha256')
    .update(stableStringify(args))
    .digest('hex')
    .slice(0, 16)}`;
}

/** Deterministic JSON so argument ordering cannot be used to dodge binding. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Resolves the hostname to check against the allowlist, when the tool targets a
 * URL. Returns null when the target is not URL-shaped.
 */
function hostOf(target) {
  if (typeof target !== 'string') return null;
  try {
    const url = new URL(target);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Enforces the operator's declared scope. Returns `{allowed:true}` when the
 * target is authorized (or the tool is not scope-bound), otherwise a refusal
 * describing why. This check is deliberately independent of approval: it is the
 * one control that must never be overridable at runtime.
 */
export function checkTargetScope(toolName, target) {
  if (!ALLOWLIST_ENFORCED_TOOLS.has(toolName)) return { allowed: true };

  const host = hostOf(target) || (toolName === 'network_scan' ? String(target).toLowerCase() : null);
  if (!host) return { allowed: true };

  const { isHostInScope, getScope } = scanGuardModule;
  if (isHostInScope(host)) return { allowed: true };

  const scope = getScope();
  return {
    allowed: false,
    code: 'out_of_scope',
    target,
    reason: `Host "${host}" is not in the operator's authorized scope.`,
    prompt:
      `BLOCKED: "${host}" is not an authorized target. This is a hard limit that cannot ` +
      `be overridden by approval. Authorized targets: ` +
      `${scope.entries.length ? scope.entries.join(', ') : '(none configured)'}` +
      `${scope.allowLocalhost ? ', localhost' : ''}. ` +
      `Tell the user the target is out of scope and stop — do not retry.`,
  };
}

/**
 * Mints an approval for (tool, target). Call this ONLY from a human-facing
 * surface: the CLI `approve` command, or an HTTP route that requires an
 * interactive confirmation from the operator.
 *
 * @returns {object} the approval record
 */
export function mintApproval({ tool, target, approvedBy = 'operator', reason = '' }) {
  const category = GATED_TOOLS[tool] || 'unknown';
  const id = crypto.randomBytes(24).toString('base64url');
  const entry = {
    id,
    tool,
    target,
    category,
    reason,
    approvedBy,
    createdAt: new Date().toISOString(),
    expiresAt: nowMs() + APPROVAL_TTL_MS,
  };
  pruneExpired();
  approvals.set(id, entry);
  return entry;
}

/**
 * Checks whether a tool call is authorized.
 *
 * @returns {{allowed: boolean, code?: string, reason?: string, prompt?: string, approvalId?: string}}
 *   When `allowed` is false and `code === 'approval_required'`, `prompt` is a
 *   message intended to be surfaced to the human operator.
 */
export function authorizeToolCall(toolName, args = {}) {
  const category = GATED_TOOLS[toolName];
  if (!category) return { allowed: true }; // Not a gated tool.

  const target = extractTarget(toolName, args);

  // 1. HARD BLOCK — the allowlist wins over any approval. An operator cannot
  //    approve a target they have not declared as owned.
  const scope = checkTargetScope(toolName, target);
  if (!scope.allowed) return scope;

  // 2. APPROVAL — require a single-use authorization bound to this exact call.
  pruneExpired();
  const provided = args.__approvalId || args.approvalId;

  let entry = provided ? approvals.get(provided) : undefined;

  if (provided && !entry) {
    return {
      allowed: false,
      code: 'invalid_or_expired_approval',
      target,
      prompt:
        `BLOCKED: approval token is missing, expired, or already used. Approvals are ` +
        `single-use and expire after ${Math.round(APPROVAL_TTL_MS / 60000)} minutes. ` +
        `Ask the user to approve "${toolName}" for target "${target}" again.`,
    };
  }

  // No token supplied: accept a live approval a human minted out-of-band for
  // this exact (tool, target). The human's approval action IS the consent, so
  // the agent simply retrying the same call is the intended flow.
  if (!entry) {
    entry = findMatchingApproval(toolName, target);
  }

  if (!entry) {
    return {
      allowed: false,
      code: 'approval_required',
      target,
      prompt:
        `APPROVAL REQUIRED: the "${toolName}" tool (category: ${category}) performs an ` +
        `action with real-world side effects and has NOT been run.\n` +
        `Target: ${target}\n\n` +
        `You must ask the user for permission before doing this. Present the tool name and ` +
        `the exact target, then stop and wait for their explicit "yes". Do not retry this ` +
        `call on your own initiative, and do not attempt to bypass, rephrase, or work around ` +
        `this gate using another tool. Once the user approves out-of-band, retrying this ` +
        `identical call will succeed.`,
    };
  }

  // Bind the approval to both tool and target.
  if (entry.tool !== toolName || entry.target !== target) {
    return {
      allowed: false,
      code: 'approval_mismatch',
      target,
      prompt:
        `BLOCKED: the approval token was issued for "${entry.tool}" on "${entry.target}", ` +
        `but this call is "${toolName}" on "${target}". Approvals cannot be transferred. ` +
        `Ask the user to approve this specific target.`,
    };
  }

  // Consume: single-use.
  approvals.delete(entry.id);
  return { allowed: true, category, target, approvalId: entry.id };
}

/**
 * Finds a live approval matching (tool, target). Used when the agent retries a
 * call after the operator approved it out-of-band.
 */
function findMatchingApproval(toolName, target) {
  for (const entry of approvals.values()) {
    if (entry.tool === toolName && entry.target === target) return entry;
  }
  return undefined;
}

/** Lists pending approvals (for the operator UI/CLI). */
export function listApprovals() {
  pruneExpired();
  return [...approvals.values()];
}

/** Revokes a specific approval. */
export function revokeApproval(id) {
  return approvals.delete(id);
}

/** Revokes everything. Useful on shutdown or when a session ends. */
export function revokeAll() {
  const n = approvals.size;
  approvals.clear();
  return n;
}

/**
 * The result shape returned to the agent when a call is refused. Kept in one
 * place so every refusal is consistent and obviously non-retryable.
 */
export function refusalResult(decision) {
  return {
    error: 'action_gate_blocked',
    code: decision.code,
    blocked: true,
    retryable: false,
    target: decision.target,
    message: decision.prompt,
  };
}

// Injected by registry.js at import time to avoid a static circular import
// between registry -> action-gate -> scan-guard. Fails closed until wired: the
// placeholder denies every scoped host rather than allowing it.
let scanGuardModule = {
  isHostInScope: () => false,
  getScope: () => ({ entries: [], allowLocalhost: false }),
};
export function _setScanGuard(mod) {
  scanGuardModule = mod;
}

export const config = {
  approvalTtlMs: APPROVAL_TTL_MS,
  gatedToolCount: Object.keys(GATED_TOOLS).length,
};

export default {
  GATED_TOOLS,
  authorizeToolCall,
  mintApproval,
  listApprovals,
  revokeApproval,
  revokeAll,
  extractTarget,
  refusalResult,
  config,
};
