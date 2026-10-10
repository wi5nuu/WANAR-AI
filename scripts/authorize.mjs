#!/usr/bin/env node
/**
 * scripts/authorize.mjs
 *
 * Operator command for managing two distinct things:
 *
 *   scope   — which hosts you have declared as yours (persisted, auditable)
 *   approve — grant a one-time approval for a specific tool+target
 *
 * These are deliberately separate operations with separate meanings:
 *
 *   scope   answers "am I allowed to ever test this host?"  — a standing,
 *           persisted declaration of ownership, recorded with a timestamp.
 *   approve answers "may this specific action run right now?" — a short-lived,
 *           single-use permission bound to one tool and one target.
 *
 * Usage:
 *   node scripts/authorize.mjs list
 *   node scripts/authorize.mjs add <host> [--reason "..."]
 *   node scripts/authorize.mjs remove <host>
 *   node scripts/authorize.mjs approve <tool> <target>
 *   node scripts/authorize.mjs approvals
 */

import readline from 'node:readline/promises';
import process from 'node:process';
import {
  getAuthorizedHosts,
  authorizeHost,
  revokeHost,
  loadScope,
  config as scopeConfig,
} from '../src/security/scan-scope.js';
import { GATED_TOOLS, config as gateConfig } from '../src/security/action-gate.js';

const SERVER = process.env.WANAR_SERVER_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

const c = {
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', gray: '\x1b[90m', bold: '\x1b[1m', reset: '\x1b[0m',
};

function die(msg, code = 1) {
  console.error(`${c.red}${msg}${c.reset}`);
  process.exit(code);
}

function usage() {
  console.log(`
${c.bold}wanar authorize${c.reset} — manage security testing scope and approvals

${c.bold}SCOPE${c.reset} (which hosts you have declared as yours)
  list                            show authorized hosts
  add <host> [--reason "why"]     authorize a host you own or are permitted to test
  remove <host>                   revoke authorization

${c.bold}APPROVAL${c.reset} (per-action consent; requires the server to be running)
  approve <tool> <target>         approve one specific action, single-use
  approvals                       list pending approvals

${c.bold}Examples${c.reset}
  node scripts/authorize.mjs add app.example.com --reason "my own staging server"
  node scripts/authorize.mjs approve security_scan https://app.example.com/

${c.gray}Scope file : ${scopeConfig.scopePath}
Server     : ${SERVER}
Approval TTL: ${Math.round(gateConfig.approvalTtlMs / 60000)} minutes${c.reset}
`);
}

/** Asks the operator to re-type the host, so a host is never added by accident. */
async function confirm(host) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`
${c.yellow}${c.bold}You are declaring authorization for:${c.reset} ${c.bold}${host}${c.reset}

By continuing you confirm ONE of the following is true:
  ${c.green}1.${c.reset} You own or operate this system, OR
  ${c.green}2.${c.reset} You hold explicit written permission from its owner
     (a signed scope / rules-of-engagement document).

Active security testing of a system you do not control is unlawful in most
jurisdictions (in Indonesia: UU ITE Pasal 30 & 46). This declaration is
recorded with your username and a timestamp.
`);
    const answer = await rl.question(`Type the host to confirm (or "no" to cancel): `);
    return answer.trim().toLowerCase() === host.toLowerCase();
  } finally {
    rl.close();
  }
}

async function cmdAdd(host, reason) {
  if (!host) die('Missing <host>. Run with no arguments for usage.');
  const ok = await confirm(host);
  if (!ok) {
    console.log(`${c.gray}Cancelled. Nothing was changed.${c.reset}`);
    return;
  }
  const res = authorizeHost(host, { reason });
  if (!res.success) die(res.error);
  console.log(`
${c.green}Authorized:${c.reset} ${c.bold}${res.entry.host}${c.reset}
  reason    : ${res.entry.reason || '(none given)'}
  added by  : ${res.entry.addedBy}
  added at  : ${res.entry.addedAt}

${c.gray}Effective immediately — no server restart needed.${c.reset}`);
}

function cmdList() {
  const store = loadScope();
  console.log(`\n${c.bold}Authorized hosts${c.reset} ${c.gray}(${scopeConfig.scopePath})${c.reset}\n`);
  if (!store.hosts.length) {
    console.log(`  ${c.gray}(none — only localhost is permitted)${c.reset}`);
  } else {
    for (const h of store.hosts) {
      console.log(`  ${c.green}•${c.reset} ${c.bold}${h.host}${c.reset}`);
      console.log(`      ${c.gray}${h.reason || 'no reason recorded'} — ${h.addedBy}, ${h.addedAt}${c.reset}`);
    }
  }
  const envOnly = (process.env.SCAN_ALLOWED_TARGETS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (envOnly.length) {
    console.log(`\n  ${c.gray}also from SCAN_ALLOWED_TARGETS: ${envOnly.join(', ')}${c.reset}`);
  }
  console.log();
}

function cmdRemove(host) {
  if (!host) die('Missing <host>.');
  const res = revokeHost(host);
  if (!res.success) die(res.error);
  console.log(`${c.green}Revoked:${c.reset} ${res.removed.host} ${c.gray}(was added ${res.removed.addedAt})${c.reset}`);
}

async function serverFetch(pathname, options = {}) {
  try {
    const res = await fetch(`${SERVER}${pathname}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch (err) {
    die(
      `Could not reach the Wanar server at ${SERVER}.\n` +
      `Approvals live in the server process, so the server must be running.\n` +
      `Start it with: npm run web\n\n(${err.message})`
    );
  }
}

async function cmdApprove(tool, target) {
  if (!tool || !target) die('Usage: approve <tool> <target>\nRun with no arguments for usage.');
  if (!GATED_TOOLS[tool]) {
    die(
      `"${tool}" is not a gated tool, so it needs no approval.\n` +
      `Gated tools: ${Object.keys(GATED_TOOLS).join(', ')}`
    );
  }

  const { status, body } = await serverFetch('/api/tool-approvals', {
    method: 'POST',
    body: JSON.stringify({ tool, target, reason: 'operator CLI approval' }),
  });

  if (status === 403) {
    die(
      `${c.red}Refused:${c.reset} ${body.error}\n\n` +
      `The scope allowlist is a hard limit that approval cannot override.\n` +
      `If you own this target, authorize it first:\n` +
      `  node scripts/authorize.mjs add ${(target || '').replace(/^https?:\/\//, '').split('/')[0]}`
    );
  }
  if (status !== 201 || !body.success) {
    die(`Failed (HTTP ${status}): ${body.error || JSON.stringify(body)}`);
  }

  const a = body.approval;
  console.log(`
${c.green}Approved${c.reset} (single-use, expires ${Math.round(gateConfig.approvalTtlMs / 60000)}m)

  tool   : ${c.bold}${a.tool}${c.reset}
  target : ${c.bold}${a.target}${c.reset}
  id     : ${c.gray}${a.id}${c.reset}

${c.gray}The agent's next identical call will now run.${c.reset}`);
}

async function cmdApprovals() {
  const { status, body } = await serverFetch('/api/tool-approvals');
  if (status !== 200 || !body.success) die(`Failed (HTTP ${status}).`);
  console.log(`\n${c.bold}Pending approvals${c.reset}\n`);
  if (!body.pending?.length) console.log(`  ${c.gray}(none)${c.reset}`);
  else for (const p of body.pending) {
    console.log(`  ${c.green}•${c.reset} ${p.tool} → ${p.target} ${c.gray}(by ${p.approvedBy})${c.reset}`);
  }
  console.log(`\n${c.gray}Gated tools: ${body.gatedTools.join(', ')}${c.reset}\n`);
}

// ── dispatch ──
const [cmd, ...rest] = process.argv.slice(2);
const positional = rest.filter((a) => !a.startsWith('--'));
const reasonIdx = rest.indexOf('--reason');
const reason = reasonIdx !== -1 ? rest[reasonIdx + 1] : undefined;

const commands = {
  list: cmdList,
  add: () => cmdAdd(positional[0], reason),
  remove: () => cmdRemove(positional[0]),
  approve: () => cmdApprove(positional[0], positional[1]),
  approvals: cmdApprovals,
};

if (!cmd || !commands[cmd]) {
  usage();
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
