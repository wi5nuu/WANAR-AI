#!/usr/bin/env node
/**
 * scripts/auth-report.mjs
 *
 * Reads the auth audit log produced by src/security/auth-monitor.js and prints
 * a security summary: event counts, top failing IPs/accounts, and alerts.
 *
 * Usage:
 *   node scripts/auth-report.mjs
 *   node scripts/auth-report.mjs --file logs/auth-audit.log --json
 *   node scripts/auth-report.mjs --since 24h
 *
 * This script only reads the local log file. It never contacts the network.
 */

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { file: process.env.AUTH_AUDIT_LOG || path.join(process.cwd(), 'logs', 'auth-audit.log'), json: false, since: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--since') args.since = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function parseSince(since) {
  if (!since) return 0;
  const m = /^(\d+)([smhd])$/.exec(since);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return Date.now() - n * unit;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/auth-report.mjs [--file <path>] [--since 24h] [--json]');
    return;
  }
  if (!fs.existsSync(args.file)) {
    console.error(`Log file not found: ${args.file}`);
    console.error('It is created on the first auth event once the server runs.');
    process.exit(2);
  }

  const cutoff = parseSince(args.since);
  const lines = fs.readFileSync(args.file, 'utf8').split(/\r?\n/).filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (!cutoff || new Date(e.timestamp).getTime() >= cutoff) events.push(e);
    } catch { /* skip malformed */ }
  }

  const byType = {};
  const failuresByIp = {};
  const failuresByAccount = {};
  const alerts = [];

  for (const e of events) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    if (e.type === 'login_failure') {
      if (e.ip) failuresByIp[e.ip] = (failuresByIp[e.ip] || 0) + 1;
      if (e.account) failuresByAccount[e.account] = (failuresByAccount[e.account] || 0) + 1;
    }
    if (e.type === 'security_alert') alerts.push(e);
  }

  const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ key: k, count: v }));

  const report = {
    file: args.file,
    generatedAt: new Date().toISOString(),
    since: args.since || 'all',
    totalEvents: events.length,
    byType,
    topFailingIps: top(failuresByIp),
    topFailingAccounts: top(failuresByAccount),
    alerts,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  console.log(`\nWanar AI — Auth Audit Report`);
  console.log(`File: ${args.file}`);
  console.log(`Events: ${events.length}  (window: ${args.since || 'all'})\n`);

  console.log('By type:');
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(20)} ${n}`);

  if (report.topFailingIps.length) {
    console.log('\nTop failing IPs:');
    for (const x of report.topFailingIps) console.log(`  ${x.key.padEnd(24)} ${x.count}`);
  }
  if (report.topFailingAccounts.length) {
    console.log('\nTop failing accounts:');
    for (const x of report.topFailingAccounts) console.log(`  ${x.key.padEnd(24)} ${x.count}`);
  }
  if (alerts.length) {
    console.log('\nAlerts:');
    for (const a of alerts.slice(-10)) console.log(`  [${a.severity}] ${a.timestamp}  ${a.message}`);
  }
  console.log();
}

main();
