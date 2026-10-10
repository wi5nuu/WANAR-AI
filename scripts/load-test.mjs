#!/usr/bin/env node
/**
 * scripts/load-test.mjs
 *
 * CLI for bounded load & resilience testing against servers YOU OWN.
 *
 * Usage:
 *   node scripts/load-test.mjs --target http://localhost:3000 --duration 10 --rps 20
 *   node scripts/load-test.mjs --target http://localhost:3000 --rate-limit --path /api/auth/api-key
 *   node scripts/load-test.mjs --target https://your-host --path /api/health --json
 *
 * Safety: duration, RPS and concurrency are hard-capped (see .env), the test
 * auto-stops when the error rate or p95 latency crosses a threshold, and the
 * target must be listed in SCAN_ALLOWED_TARGETS.
 */

import { runLoadTest, validateRateLimit, LIMITS } from '../src/security/load-test.js';

function parseArgs(argv) {
  const args = { json: false, rateLimit: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--rate-limit') args.rateLimit = true;
    else if (a === '--target') args.target = argv[++i];
    else if (a === '--path') args.path = argv[++i];
    else if (a === '--method') args.method = argv[++i];
    else if (a === '--duration') args.duration = parseInt(argv[++i], 10);
    else if (a === '--rps') args.rps = parseInt(argv[++i], 10);
    else if (a === '--concurrency') args.concurrency = parseInt(argv[++i], 10);
    else if (a === '--requests') args.requests = parseInt(argv[++i], 10);
    else if (a === '--max-error-rate') args.maxErrorRate = parseFloat(argv[++i]);
    else if (a === '--max-latency') args.maxLatencyMs = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Wanar AI — Bounded Load Test

Usage:
  node scripts/load-test.mjs --target <url> [options]

Options:
  --target <url>          Base URL (required, must be in SCAN_ALLOWED_TARGETS)
  --path <path>           Request path (default /api/health)
  --method <method>       HTTP method (default GET)
  --duration <ms>         Duration, capped at ${LIMITS.maxDurationMs}ms (default 10000)
  --rps <n>               Target requests/sec, capped at ${LIMITS.maxRps} (default 10)
  --concurrency <n>       Parallel workers, capped at ${LIMITS.maxConcurrency} (default 8)
  --max-error-rate <0-1>  Auto-abort threshold (default ${LIMITS.maxErrorRate})
  --max-latency <ms>      Auto-abort p95 threshold (default ${LIMITS.maxLatencyMs}ms)
  --rate-limit            Run the rate-limit validation instead of a load test
  --requests <n>          Rate-limit burst size, capped at 100 (default 20)
  --json                  Emit JSON only

This tool is bounded by design: it never runs indefinitely and stops itself
when the target begins to degrade. It is not a DoS tool.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.target) {
    usage();
    process.exit(args.help ? 0 : 2);
  }

  if (args.rateLimit) {
    const result = await validateRateLimit(args);
    if (args.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); }
    else {
      const s = result.summary;
      console.log(`\nRate-limit validation: ${s.url}`);
      console.log(`Requests sent: ${s.requestsSent}`);
      console.log(`Rate limited:  ${s.rateLimited}${s.first429AtRequest !== null ? ` (first 429 at #${s.first429AtRequest})` : ''}`);
      if (s.retryAfter) console.log(`Retry-After:   ${s.retryAfter}`);
      if (s.rateLimitHeaders) console.log(`Limit headers: ${JSON.stringify(s.rateLimitHeaders)}`);
      console.log(`Verdict:       ${s.verdict}\n`);
    }
    process.exit(result.success ? 0 : 1);
  }

  console.log(`\nRunning bounded load test (max ${LIMITS.maxDurationMs}ms / ${LIMITS.maxRps} rps)...\n`);
  const result = await runLoadTest(args);
  if (args.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exit(result.success ? 0 : 1); }

  if (!result.success) {
    console.error(`Rejected: ${result.error}`);
    process.exit(1);
  }
  const s = result.summary;
  console.log(`Target:      ${s.url}`);
  console.log(`Duration:    ${s.elapsedMs}ms (requested ${s.durationRequestedMs}ms)`);
  console.log(`Requests:    ${s.totalRequests}  success ${s.success}  errors ${s.errors}  rate-limited ${s.rateLimited ?? 0}  (${(s.errorRate * 100).toFixed(1)}% errors)`);
  console.log(`Achieved:    ${s.achievedRps} req/s`);
  console.log(`Latency:     avg ${s.latencyMs.avg}ms  p50 ${s.latencyMs.p50}ms  p95 ${s.latencyMs.p95}ms  p99 ${s.latencyMs.p99}ms  max ${s.latencyMs.max}ms`);
  console.log(`Statuses:    ${JSON.stringify(s.statusCounts)}`);
  if (s.aborted) console.log(`ABORTED:     ${s.abortReason}`);
  console.log(`Verdict:     ${s.verdict}\n`);
  process.exit(0);
}

main().catch((err) => { console.error(`load-test error: ${err.message}`); process.exit(2); });
