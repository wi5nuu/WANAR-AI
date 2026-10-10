/**
 * src/security/load-test.js
 *
 * Bounded load & resilience testing for servers YOU OWN.
 *
 * This is deliberately NOT a DoS/DDoS tool:
 *   - Hard duration cap (never runs forever).
 *   - Hard RPS / concurrency cap.
 *   - Automatic abort when the error rate or latency crosses a threshold, so
 *     the target is never driven to the point of outage.
 *   - Scope-guarded: only hosts in SCAN_ALLOWED_TARGETS may be targeted.
 *
 * Its purpose is capacity measurement and rate-limit verification, producing
 * evidence-backed numbers (percentiles, error rate, threshold at which the
 * server degrades) so you can size and harden your own infrastructure.
 */

import crypto from 'node:crypto';
import { authorizeTarget, mapLimit, withTimeout, DEFAULT_CONCURRENCY } from './scan-guard.js';

export const LIMITS = {
  maxDurationMs: parseInt(process.env.LOADTEST_MAX_DURATION_MS || '60000', 10),
  maxRps: parseInt(process.env.LOADTEST_MAX_RPS || '50', 10),
  maxConcurrency: parseInt(process.env.LOADTEST_MAX_CONCURRENCY || '16', 10),
  maxErrorRate: parseFloat(process.env.LOADTEST_MAX_ERROR_RATE || '0.05'),
  maxLatencyMs: parseInt(process.env.LOADTEST_MAX_LATENCY_MS || '2000', 10),
};

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Runs a bounded load test against a single endpoint.
 *
 * options:
 *   target        base URL (required, must be in scope)
 *   path          request path (default '/api/health')
 *   method        HTTP method (default 'GET')
 *   durationMs    test duration, clamped to LOADTEST_MAX_DURATION_MS
 *   rps           target requests/second, clamped to LOADTEST_MAX_RPS
 *   concurrency   parallel workers, clamped to LOADTEST_MAX_CONCURRENCY
 *   maxErrorRate  abort threshold (fraction, e.g. 0.05 = 5%)
 *   maxLatencyMs  abort threshold for p95 latency
 */
export async function runLoadTest(options = {}) {
  const {
    target,
    path = '/api/health',
    method = 'GET',
    headers = {},
  } = options;

  const auth = authorizeTarget(target);
  if (!auth.allowed) {
    return { success: false, error: `out_of_scope: ${auth.reason}`, scope: auth, abortReason: 'out_of_scope' };
  }

  const durationMs = clamp(options.durationMs, 1000, LIMITS.maxDurationMs, 10000);
  const rps = clamp(options.rps, 1, LIMITS.maxRps, 10);
  const concurrency = clamp(options.concurrency, 1, LIMITS.maxConcurrency, Math.min(8, rps));
  const maxErrorRate = clamp(options.maxErrorRate, 0, 1, LIMITS.maxErrorRate);
  const maxLatencyMs = clamp(options.maxLatencyMs, 50, 60000, LIMITS.maxLatencyMs);

  const url = new URL(path, target).toString();
  const deadline = Date.now() + durationMs;

  const latencies = [];
  const statusCounts = {};
  let total = 0;
  let errors = 0;       // real failures: 5xx or network errors
  let rateLimited = 0;  // 429 — the target's limiter working as intended
  let aborted = false;
  let abortReason = null;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const requestOnce = async () => {
    const reqStart = Date.now();
    try {
      const res = await withTimeout(
        fetch(url, { method, headers, redirect: 'manual' }),
        10000,
        'request timeout'
      );
      const ms = Date.now() - reqStart;
      latencies.push(ms);
      statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
      // 429 = the target's own rate limiter engaged (healthy, expected).
      // 5xx / network failures = real errors that trigger the abort threshold.
      if (res.status === 429) rateLimited++;
      else if (res.status >= 500) errors++;
      try { await res.arrayBuffer(); } catch { /* drain */ }
    } catch {
      latencies.push(Date.now() - reqStart);
      statusCounts['network_error'] = (statusCounts['network_error'] || 0) + 1;
      errors++;
    } finally {
      total++;
    }
  };

  const intervalMs = Math.max(1, Math.floor(1000 / rps));
  let stopped = false;

  const worker = async () => {
    while (!stopped && Date.now() < deadline) {
      await requestOnce();
      if (total > 0 && total % 25 === 0) {
        const sorted = [...latencies].sort((a, b) => a - b);
        const errorRate = errors / total;
        const p95 = percentile(sorted, 95);
        if (errorRate > maxErrorRate) {
          aborted = true; abortReason = `error_rate ${(errorRate * 100).toFixed(1)}% > ${(maxErrorRate * 100).toFixed(1)}%`; stopped = true;
        } else if (p95 > maxLatencyMs) {
          aborted = true; abortReason = `p95 ${p95}ms > ${maxLatencyMs}ms`; stopped = true;
        }
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  const elapsedMs = Date.now() - t0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const successCount = total - errors - rateLimited;
  const summary = {
    url,
    method,
    startedAt,
    elapsedMs,
    durationRequestedMs: durationMs,
    rpsRequested: rps,
    concurrency,
    totalRequests: total,
    success: successCount,
    errors,
    rateLimited,
    errorRate: total ? +(errors / total).toFixed(4) : 0,
    achievedRps: elapsedMs ? +(total / (elapsedMs / 1000)).toFixed(2) : 0,
    latencyMs: {
      min: sorted[0] || 0,
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1] || 0,
      avg: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
    },
    statusCounts,
    thresholds: { maxErrorRate, maxLatencyMs },
    aborted,
    abortReason,
    verdict: aborted
      ? 'degraded — real errors/latency crossed the safety threshold; test auto-stopped'
      : (errors === 0
        ? (rateLimited > 0
          ? 'stable; target rate limiter engaged (429) without real errors'
          : 'stable within the tested envelope')
        : 'completed with some real errors (below the abort threshold)'),
  };

  return {
    success: true,
    summary,
    evidence: {
      generatedAt: new Date().toISOString(),
      requestSample: { method, url },
      summarySha256: sha256(JSON.stringify(summary)),
      note: 'Bounded test: hard duration/RPS caps and automatic abort on degradation.',
    },
  };
}

/**
 * Verifies that a target's rate limiting actually engages.
 * Sends a bounded burst and looks for 429 + Retry-After / X-RateLimit headers.
 */
export async function validateRateLimit(options = {}) {
  const {
    target,
    path = '/api/auth/api-key',
    method = 'POST',
    body = {},
    requests = 20,
    intervalMs = 50,
  } = options;

  const auth = authorizeTarget(target);
  if (!auth.allowed) {
    return { success: false, error: `out_of_scope: ${auth.reason}`, scope: auth };
  }

  const count = clamp(requests, 1, 100, 20);
  const url = new URL(path, target).toString();
  const observations = [];
  let first429Index = null;
  let retryAfter = null;
  let rateLimitHeaders = null;

  for (let i = 0; i < count; i++) {
    const reqStart = Date.now();
    let status = null;
    let headersSeen = {};
    try {
      const res = await withTimeout(
        fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method === 'GET' ? undefined : JSON.stringify(body),
          redirect: 'manual',
        }),
        8000,
        'request timeout'
      );
      status = res.status;
      headersSeen = {
        'retry-after': res.headers.get('retry-after'),
        'x-ratelimit-limit': res.headers.get('x-ratelimit-limit'),
        'x-ratelimit-remaining': res.headers.get('x-ratelimit-remaining'),
        'x-ratelimit-reset': res.headers.get('x-ratelimit-reset'),
      };
      if (res.headers.get('x-ratelimit-limit')) rateLimitHeaders = headersSeen;
      if (status === 429 && first429Index === null) {
        first429Index = i;
        retryAfter = res.headers.get('retry-after');
      }
      try { await res.arrayBuffer(); } catch { /* drain */ }
    } catch (err) {
      status = 'network_error';
    }
    observations.push({ i, status, ms: Date.now() - reqStart });
    if (first429Index !== null) break;
    if (intervalMs) await new Promise((r) => setTimeout(r, intervalMs));
  }

  const limited = first429Index !== null;
  const summary = {
    url,
    method,
    requestsSent: observations.length,
    rateLimited: limited,
    first429AtRequest: first429Index,
    retryAfter,
    rateLimitHeaders,
    statusCounts: observations.reduce((acc, o) => {
      acc[o.status] = (acc[o.status] || 0) + 1; return acc;
    }, {}),
    verdict: limited
      ? 'rate limiting is active and enforced'
      : 'no 429 observed within the burst — verify the limiter or increase requests',
  };

  return {
    success: true,
    summary,
    observations,
    evidence: {
      generatedAt: new Date().toISOString(),
      summarySha256: sha256(JSON.stringify(summary)),
      note: 'Bounded burst: at most 100 requests, stops at the first 429.',
    },
  };
}

export default { runLoadTest, validateRateLimit, LIMITS };
