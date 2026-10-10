/**
 * src/security/auth-monitor.js
 *
 * Defensive authentication monitoring for Wanar AI.
 *
 * Records authentication / authorization events as structured JSON lines and
 * detects brute-force patterns (many failures from one IP or against one
 * account in a sliding window). On threshold crossing it raises an alert to
 * the console and, if configured, to a webhook.
 *
 * Privacy: this module NEVER stores credentials, tokens, API keys, or request
 * bodies. It records only non-sensitive metadata (IP, user-agent, route,
 * status, reason, userId/email when a login succeeded).
 */

import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = process.env.AUTH_AUDIT_LOG_DIR || path.join(process.cwd(), 'logs');
const LOG_FILE = process.env.AUTH_AUDIT_LOG || path.join(LOG_DIR, 'auth-audit.log');
const FAIL_THRESHOLD = parseInt(process.env.AUTH_FAIL_THRESHOLD || '5', 10);
const FAIL_WINDOW_MS = parseInt(process.env.AUTH_FAIL_WINDOW_MS || '600000', 10);
const ALERT_COOLDOWN_MS = parseInt(process.env.AUTH_ALERT_COOLDOWN_MS || '300000', 10);
const ALERT_WEBHOOK = process.env.SECURITY_ALERT_WEBHOOK || '';
const MAX_EVENTS = parseInt(process.env.AUTH_AUDIT_MAX_EVENTS || '2000', 10);

const events = [];
const failures = new Map();
const lastAlertAt = new Map();

function ensureLogDir() {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  } catch {
    /* non-fatal */
  }
}

function clientIp(req) {
  const fwd = req?.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req?.ip || req?.socket?.remoteAddress || 'unknown';
}

function truncate(value, max = 200) {
  if (value === undefined || value === null) return undefined;
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function writeEvent(event) {
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, JSON.stringify(event) + '\n');
  } catch {
    /* logging must never break a request */
  }
}

function emitAlert(alert) {
  const now = Date.now();
  const key = alert.key;
  const last = lastAlertAt.get(key) || 0;
  if (now - last < ALERT_COOLDOWN_MS) return;
  lastAlertAt.set(key, now);

  const record = { ...alert, type: 'security_alert', timestamp: new Date().toISOString() };
  writeEvent(record);
  console.warn(`[SECURITY ALERT] ${alert.message}`);

  if (ALERT_WEBHOOK && typeof fetch === 'function') {
    fetch(ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    }).catch(() => { /* alert delivery is best-effort */ });
  }
}

function pruneFailures(now) {
  for (const [key, list] of failures) {
    const kept = list.filter((t) => now - t < FAIL_WINDOW_MS);
    if (kept.length === 0) failures.delete(key);
    else failures.set(key, kept);
  }
}

function trackFailure(ip, account) {
  const now = Date.now();
  pruneFailures(now);

  const keys = [`ip:${ip}`];
  if (account) keys.push(`account:${account}`);

  for (const key of keys) {
    const list = failures.get(key) || [];
    list.push(now);
    failures.set(key, list);
    if (list.length >= FAIL_THRESHOLD) {
      emitAlert({
        key,
        severity: 'high',
        kind: 'brute_force_suspected',
        message: `${list.length} failed auth attempts in ${Math.round(FAIL_WINDOW_MS / 60000)}m for ${key}`,
        ip,
        account: account ? truncate(account) : undefined,
        count: list.length,
      });
    }
  }
}

/**
 * Records a successful authentication.
 */
export function recordLoginSuccess(req, user = {}, method = 'password') {
  writeEvent({
    type: 'login_success',
    timestamp: new Date().toISOString(),
    method,
    ip: clientIp(req),
    userAgent: truncate(req?.headers?.['user-agent'], 160),
    userId: user.id,
    email: user.email ? truncate(user.email) : undefined,
    role: user.role,
  });
}

/**
 * Records a failed authentication. `account` should be an email/username, not a secret.
 */
export function recordLoginFailure(req, reason = 'invalid_credentials', account = undefined, method = 'password') {
  const ip = clientIp(req);
  writeEvent({
    type: 'login_failure',
    timestamp: new Date().toISOString(),
    method,
    ip,
    userAgent: truncate(req?.headers?.['user-agent'], 160),
    account: account ? truncate(account) : undefined,
    reason: truncate(reason),
  });
  trackFailure(ip, account);
}

/**
 * Records an authorization denial (authenticated but not permitted).
 */
export function recordAuthzDenied(req, reason = 'forbidden') {
  writeEvent({
    type: 'authz_denied',
    timestamp: new Date().toISOString(),
    ip: clientIp(req),
    userId: req?.user?.id,
    role: req?.user?.role,
    path: truncate(req?.originalUrl || req?.url, 160),
    reason: truncate(reason),
  });
}

/**
 * Records an administrative action for audit purposes.
 */
export function recordAdminAction(req, action, target = {}) {
  writeEvent({
    type: 'admin_action',
    timestamp: new Date().toISOString(),
    ip: clientIp(req),
    actorId: req?.user?.id,
    actorRole: req?.user?.role,
    action: truncate(action),
    target: target && Object.keys(target).length ? target : undefined,
  });
}

/**
 * Express middleware: logs 401/403 responses on auth routes with no extra
 * request handling. Never inspects or stores credentials.
 */
export function requestAudit(req, res, next) {
  res.on('finish', () => {
    const status = res.statusCode;
    if (status !== 401 && status !== 403) return;
    const url = req.originalUrl || req.url || '';
    if (!url.startsWith('/api/auth') && !url.startsWith('/api/teams')) return;
    writeEvent({
      type: status === 401 ? 'unauthorized' : 'forbidden',
      timestamp: new Date().toISOString(),
      method: req.method,
      path: truncate(url, 160),
      ip: clientIp(req),
      userAgent: truncate(req.headers?.['user-agent'], 160),
    });
  });
  next();
}

/**
 * Returns a snapshot of current failure counters and recent events.
 */
export function getStats() {
  const now = Date.now();
  pruneFailures(now);
  const suspicious = [...failures.entries()]
    .map(([key, list]) => ({ key, failures: list.length }))
    .filter((x) => x.failures >= FAIL_THRESHOLD)
    .sort((a, b) => b.failures - a.failures);
  return {
    logFile: LOG_FILE,
    threshold: FAIL_THRESHOLD,
    windowMs: FAIL_WINDOW_MS,
    trackedKeys: failures.size,
    suspicious,
    bufferedEvents: events.length,
  };
}

/**
 * Returns the most recent buffered events (newest first).
 */
export function getRecentEvents(limit = 50) {
  return events.slice(-limit).reverse();
}

export const config = {
  logFile: LOG_FILE,
  failThreshold: FAIL_THRESHOLD,
  failWindowMs: FAIL_WINDOW_MS,
  alertWebhookConfigured: Boolean(ALERT_WEBHOOK),
};

export default {
  requestAudit,
  recordLoginSuccess,
  recordLoginFailure,
  recordAuthzDenied,
  recordAdminAction,
  getStats,
  getRecentEvents,
  config,
};
