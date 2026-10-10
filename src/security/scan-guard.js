/**
 * src/security/scan-guard.js
 *
 * Safety + stability primitives shared by the security scanner.
 *
 * Three concerns, all defensive:
 *   1. Concurrency control — never fire hundreds of requests at once, which
 *      starves the Node event loop / libuv DNS threadpool and freezes the
 *      server (this actually happened: a deep scan made /api/health time out).
 *   2. Deadlines — every scan has a hard wall-clock budget so it always ends.
 *   3. Scope authorization — only hosts the operator explicitly owns may be
 *      scanned. This turns the scanner from an open mass-scanning tool into a
 *      professional, auditable, self-scoped assessment tool.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import { getAuthorizedHosts } from './scan-scope.js';

export const DEFAULT_CONCURRENCY = parseInt(process.env.SCAN_CONCURRENCY || '8', 10);
export const DEFAULT_DEADLINE_MS = parseInt(process.env.SCAN_DEADLINE_MS || '120000', 10);
export const DEFAULT_REQUEST_TIMEOUT_MS = parseInt(process.env.SCAN_REQUEST_TIMEOUT_MS || '4000', 10);

/**
 * Runs `fn` over `items` with at most `limit` concurrent executions.
 * Preserves input order in the result array. Never rejects: failures become
 * `{ status: 'rejected', reason }` entries, mirroring Promise.allSettled.
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/**
 * Rejects after `ms`. Always clears its timer.
 */
export function withTimeout(promise, ms, message = 'operation timed out') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A wall-clock budget shared across a scan. `expired()` flips to true once the
 * deadline passes so loops can bail out instead of running forever.
 */
export function createDeadline(budgetMs = DEFAULT_DEADLINE_MS) {
  const start = Date.now();
  return {
    budgetMs,
    elapsed: () => Date.now() - start,
    remaining: () => Math.max(0, budgetMs - (Date.now() - start)),
    expired: () => Date.now() - start >= budgetMs,
  };
}

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Parses the operator's owned scope.
 *
 * Two sources are merged:
 *   1. SCAN_ALLOWED_TARGETS  — comma-separated env var (legacy, needs restart)
 *   2. config/scan-scope.json — file-backed, auditable, live (no restart)
 *
 * The file source is what `scripts/authorize.mjs` writes to. When neither is
 * set, the scanner is limited to localhost only (safe default).
 */
export function getScope() {
  const raw = process.env.SCAN_ALLOWED_TARGETS || '';
  const envEntries = raw.split(',').map(normalizeHost).filter(Boolean);

  let fileEntries = [];
  try {
    fileEntries = getAuthorizedHosts().map(normalizeHost).filter(Boolean);
  } catch {
    // A broken scope file must never widen access; ignoring it fails closed.
    fileEntries = [];
  }

  const entries = [...new Set([...envEntries, ...fileEntries])];
  const allowLocalhost = process.env.SCAN_ALLOW_LOCALHOST !== 'false';
  return { entries, allowLocalhost, envEntries, fileEntries };
}

/**
 * Returns true if `hostname` is inside the operator's declared scope.
 * A scope entry matches the exact host or any subdomain of it.
 */
export function isHostInScope(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  const { entries, allowLocalhost } = getScope();

  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (isLocal) return allowLocalhost;

  return entries.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Validates a scan target URL and returns a decision object. Never throws.
 *   { allowed, host, reason }
 */
export function authorizeTarget(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return { allowed: false, host: null, reason: 'invalid_url' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { allowed: false, host: url.hostname, reason: 'unsupported_protocol' };
  }
  const host = normalizeHost(url.hostname);
  if (!isHostInScope(host)) {
    return {
      allowed: false,
      host,
      reason: 'out_of_scope',
      hint: 'Add the host to SCAN_ALLOWED_TARGETS to authorize scanning it.',
    };
  }
  return { allowed: true, host, reason: 'in_scope' };
}

/**
 * Classifies an IP address. Used to flag cloud-metadata endpoints and private
 * ranges so the report can explain *why* a target is sensitive. This is
 * informational — authorization is enforced by authorizeTarget().
 */
export function classifyIp(ip) {
  if (!net.isIP(ip)) return 'unknown';
  if (ip === '169.254.169.254') return 'cloud-metadata';
  if (ip.startsWith('169.254.')) return 'link-local';
  if (ip === '127.0.0.1' || ip === '::1') return 'loopback';
  if (ip.startsWith('10.')) return 'private';
  if (ip.startsWith('192.168.')) return 'private';
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 'private';
  if (ip.startsWith('fc') || ip.startsWith('fd')) return 'private';
  return 'public';
}

/**
 * Best-effort DNS resolution used for the report's target fingerprint.
 */
export async function resolveTarget(hostname) {
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    return addresses.map((a) => ({ address: a.address, family: a.family, scope: classifyIp(a.address) }));
  } catch {
    return [];
  }
}

export default {
  mapLimit,
  withTimeout,
  createDeadline,
  getScope,
  isHostInScope,
  authorizeTarget,
  classifyIp,
  resolveTarget,
  DEFAULT_CONCURRENCY,
  DEFAULT_DEADLINE_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
};
