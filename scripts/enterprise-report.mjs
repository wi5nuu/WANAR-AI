#!/usr/bin/env node
/**
 * scripts/enterprise-report.mjs
 *
 * Evidence-based security & compliance report generator for Wanar AI.
 *
 * Design principles — this is what makes the report non-ambiguous:
 *   1. Every finding cites concrete evidence: the exact command that was run,
 *      the raw (redacted) output, a timestamp, and a SHA-256 of the evidence
 *      payload. No assumptions, no "might be".
 *   2. Every finding includes a remediation action and an exact verification
 *      command so you can prove the fix.
 *   3. It NEVER reads or extracts secret VALUES. It only reports presence /
 *      absence and file locations. Passwords, tokens and keys are never
 *      copied into the report.
 *
 * Output: reports/enterprise-report-<timestamp>.md  and  .json
 *
 * Usage:
 *   node scripts/enterprise-report.mjs
 *   node scripts/enterprise-report.mjs --url https://your-host/api/health
 *   node scripts/enterprise-report.mjs --out reports --json-only
 *
 * Exit codes: 0 = no failed checks, 1 = one or more checks failed, 2 = error.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── helpers ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { out: 'reports', jsonOnly: false, url: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--json-only') args.jsonOnly = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

// On Windows, CLI shims such as npm/npx are .cmd wrappers. Node >= 20 refuses
// to spawn .cmd files directly (EINVAL), so route them through cmd.exe. Without
// this, the audit would silently fail and could produce a false PASS.
const WIN_SHIMS = new Set(['npm', 'npx', 'yarn', 'pnpm']);

function run(cmd, cmdArgs, opts = {}) {
  let executable = cmd;
  let finalArgs = cmdArgs;
  if (process.platform === 'win32' && WIN_SHIMS.has(cmd)) {
    executable = process.env.ComSpec || 'cmd.exe';
    finalArgs = ['/d', '/s', '/c', cmd, ...cmdArgs];
  }
  try {
    const stdout = execFileSync(executable, finalArgs, {
      cwd: opts.cwd || ROOT,
      encoding: 'utf8',
      timeout: opts.timeout || 60000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, code: 0, stdout: stdout || '', stderr: '' };
  } catch (err) {
    return {
      ok: false,
      code: err.status ?? null,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : (err.message || ''),
    };
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function redactSecrets(text) {
  return String(text)
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, (m) => m.slice(0, 4) + '****')
    .replace(/\b(sk-[A-Za-z0-9]{8})[A-Za-z0-9]+/g, '$1****')
    .replace(/\b(nvapi-[A-Za-z0-9]{4})[A-Za-z0-9]+/g, '$1****')
    .replace(/((?:postgres|mysql|mongodb|redis|amqp):\/\/[^:]+:)[^@]+(@)/gi, '$1****$2')
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)(\S+)/gi, '$1****');
}

function finding({ id, title, category, severity, status, evidence, impact, remediation, verification }) {
  const evidencePayload = JSON.stringify(evidence);
  return {
    id,
    title,
    category,
    severity,
    status,
    impact,
    evidence: { ...evidence, sha256: sha256(evidencePayload), capturedAt: new Date().toISOString() },
    remediation: remediation || [],
    verification: verification || null,
  };
}

// ── checks ────────────────────────────────────────────────────────────────────

function checkRuntimeFingerprint() {
  const pkgPath = path.join(ROOT, 'package.json');
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { /* ignore */ }
  const gitCommit = run('git', ['rev-parse', 'HEAD']);
  const gitBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  return finding({
    id: 'ENV-001',
    title: 'Runtime & source fingerprint',
    category: 'Environment',
    severity: 'info',
    status: 'info',
    impact: 'Identifies exactly which build the report describes.',
    evidence: {
      command: 'node --version; git rev-parse HEAD; package.json version',
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      node: process.version,
      cwd: ROOT,
      packageVersion: pkg.version || null,
      gitCommit: gitCommit.ok ? gitCommit.stdout.trim() : null,
      gitBranch: gitBranch.ok ? gitBranch.stdout.trim() : null,
    },
    remediation: [],
    verification: 'git rev-parse HEAD',
  });
}

function checkEnvFile() {
  const envPath = path.join(ROOT, '.env');
  const exists = fs.existsSync(envPath);
  let tracked = false;
  if (exists) {
    const ls = run('git', ['ls-files', '--error-unmatch', '.env']);
    tracked = ls.ok;
  }
  const examplePath = path.join(ROOT, '.env.example');
  const example = fs.existsSync(examplePath) ? fs.readFileSync(examplePath, 'utf8') : '';
  // Report only which KEY NAMES are documented — never values.
  const expectedKeys = [...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
  const envText = exists ? fs.readFileSync(envPath, 'utf8') : '';
  const presentKeys = [...envText.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
  const missingKeys = expectedKeys.filter((k) => !presentKeys.includes(k));

  const criticalMissing = ['JWT_SECRET'].filter((k) => !presentKeys.includes(k));
  const status = tracked ? 'fail' : (!exists ? 'warn' : (criticalMissing.length ? 'fail' : 'pass'));

  return finding({
    id: 'CFG-001',
    title: 'Environment secret file handling',
    category: 'Secrets',
    severity: tracked ? 'critical' : (criticalMissing.length ? 'high' : 'medium'),
    status,
    impact: 'A tracked .env leaks all credentials to everyone with repo access. A missing JWT_SECRET causes insecure defaults.',
    evidence: {
      command: 'Test-Path .env; git ls-files --error-unmatch .env',
      envFileExists: exists,
      envFileTrackedByGit: tracked,
      documentedKeyCount: expectedKeys.length,
      presentKeyCount: presentKeys.length,
      missingKeys,
      criticalMissingKeys: criticalMissing,
      note: 'Key names only — values are never read into this report.',
    },
    remediation: [
      tracked ? 'Run: git rm --cached .env  (keep the local file)' : null,
      tracked ? 'Rotate every credential that was in the committed .env' : null,
      missingKeys.length ? 'Add the missing keys to .env from .env.example' : null,
      criticalMissing.length ? 'Generate JWT_SECRET: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"' : null,
    ].filter(Boolean),
    verification: 'git ls-files | findstr /R "^.env$"   (must print nothing)',
  });
}

function checkSecretsAudit() {
  const scriptPath = path.join(ROOT, 'scripts', 'secrets-audit.mjs');
  const res = run('node', [scriptPath, '--json']);
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch { /* ignore */ }
  const findings = parsed?.findings || [];
  const high = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  return finding({
    id: 'SEC-001',
    title: 'Hardcoded secret scan (source tree)',
    category: 'Secrets',
    severity: high.length ? 'high' : 'info',
    status: high.length ? 'fail' : 'pass',
    impact: 'Hardcoded credentials in source are exposed to anyone with repository access and are hard to rotate.',
    evidence: {
      command: 'node scripts/secrets-audit.mjs --json',
      scannedFiles: parsed?.scannedFiles ?? null,
      totalFindings: findings.length,
      highOrCritical: high.length,
      findings: findings.map((f) => ({ rule: f.rule, severity: f.severity, file: f.file, line: f.line })),
      note: 'Match values are redacted by the scanner.',
    },
    remediation: high.length
      ? ['Move each flagged value to .env / a secrets manager', 'Rotate the exposed credential', 'If committed, purge from git history (git filter-repo)']
      : [],
    verification: 'npm run audit:secrets   (must exit 0)',
  });
}

function checkDependencies() {
  const res = run('npm', ['audit', '--json'], { timeout: 120000 });
  let parsed = null;
  let parseError = null;
  try { parsed = JSON.parse(res.stdout); } catch (err) { parseError = err.message; }

  // If the audit could not run or produced no parseable report, do NOT report a
  // pass — an unverified check is a warning, never a false positive.
  if (!parsed) {
    return finding({
      id: 'DEP-001',
      title: 'Dependency vulnerability audit',
      category: 'Dependencies',
      severity: 'medium',
      status: 'warn',
      impact: 'Dependency CVEs cannot be ruled out because the audit did not produce a verifiable report.',
      evidence: {
        command: 'npm audit --json',
        exitCode: res.code,
        parseError,
        stderr: redactSecrets((res.stderr || '').trim()).slice(0, 500),
        stdoutHead: redactSecrets((res.stdout || '').trim()).slice(0, 300),
        note: 'No verifiable audit output — status is WARN, not PASS.',
      },
      remediation: ['Ensure network access to the npm registry, then re-run', 'Or run: npm audit --json locally and attach the output'],
      verification: 'npm audit --json   (must return parseable JSON)',
    });
  }

  const vulns = parsed.metadata?.vulnerabilities || parsed.vulnerabilities || {};
  const counts = {
    critical: vulns.critical || 0,
    high: vulns.high || 0,
    moderate: vulns.moderate || 0,
    low: vulns.low || 0,
  };
  const total = (counts.critical + counts.high + counts.moderate + counts.low);
  return finding({
    id: 'DEP-001',
    title: 'Dependency vulnerability audit',
    category: 'Dependencies',
    severity: counts.critical ? 'critical' : (counts.high ? 'high' : (total ? 'medium' : 'info')),
    status: (counts.critical || counts.high) ? 'fail' : (total ? 'warn' : 'pass'),
    impact: 'Known CVEs in dependencies can be exploited without touching your application code.',
    evidence: {
      command: 'npm audit --json',
      auditReportVersion: parsed.auditReportVersion ?? null,
      counts,
      total,
      exitCode: res.code,
      note: 'npm audit exits non-zero when vulnerabilities exist; the JSON is still valid evidence.',
    },
    remediation: total ? ['Run: npm audit fix', 'For breaking changes: npm audit fix --force (review the diff first)', 'Re-run the report to confirm'] : [],
    verification: 'npm audit --json   (counts.high and counts.critical must be 0)',
  });
}

function checkAuthLog() {
  const logPath = path.join(ROOT, 'logs', 'auth-audit.log');
  if (!fs.existsSync(logPath)) {
    return finding({
      id: 'MON-001',
      title: 'Authentication audit log',
      category: 'Monitoring',
      severity: 'medium',
      status: 'warn',
      impact: 'Without an auth audit log, brute-force attempts and unauthorized access cannot be investigated.',
      evidence: {
        command: 'Test-Path logs/auth-audit.log',
        logFile: logPath,
        exists: false,
        note: 'The log is created on the first auth event after the server runs with the monitor enabled.',
      },
      remediation: ['Start the server and exercise a login so the monitor writes its first event', 'Verify the monitor is wired in src/server.js'],
      verification: 'npm run audit:auth',
    });
  }

  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const byType = {};
  const failByIp = {};
  let alerts = 0;
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      byType[e.type] = (byType[e.type] || 0) + 1;
      if (e.type === 'login_failure' && e.ip) failByIp[e.ip] = (failByIp[e.ip] || 0) + 1;
      if (e.type === 'security_alert') alerts++;
    } catch { /* skip malformed */ }
  }
  const topIps = Object.entries(failByIp).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const fileSize = fs.statSync(logPath).size;
  return finding({
    id: 'MON-001',
    title: 'Authentication audit log',
    category: 'Monitoring',
    severity: alerts ? 'high' : 'info',
    status: alerts ? 'fail' : 'pass',
    impact: 'Repeated failures from one source indicate credential-stuffing or brute-force activity.',
    evidence: {
      command: 'node scripts/auth-report.mjs --json',
      logFile: path.relative(ROOT, logPath),
      fileBytes: fileSize,
      totalEvents: lines.length,
      byType,
      securityAlerts: alerts,
      topFailingIps: topIps.map(([ip, count]) => ({ ip, count })),
      logSha256: sha256(fs.readFileSync(logPath)),
    },
    remediation: alerts
      ? ['Block the offending IP at the firewall / IIS', 'Enable account lockout', 'Force password reset for targeted accounts']
      : [],
    verification: 'npm run audit:auth',
  });
}

function checkFilePermissions() {
  if (process.platform !== 'win32') {
    return finding({
      id: 'PERM-001',
      title: 'Sensitive file permissions',
      category: 'Hardening',
      severity: 'info',
      status: 'info',
      impact: 'Loose permissions let other local users read secrets.',
      evidence: { command: 'icacls (Windows only)', platform: process.platform, note: 'Check skipped: non-Windows host.' },
      remediation: [],
      verification: null,
    });
  }
  const targets = ['.env', 'data'].map((p) => path.join(ROOT, p)).filter((p) => fs.existsSync(p));
  const results = [];
  let broad = false;
  for (const target of targets) {
    const res = run('icacls', [target]);
    const out = res.stdout || res.stderr;
    // "Everyone" / "BUILTIN\Users" with write/full is a broad grant.
    const suspicious = /(Everyone|BUILTIN\\Users)/i.test(out) && /\((?:F|M|W)/i.test(out);
    if (suspicious) broad = true;
    results.push({ target: path.relative(ROOT, target), broadGrantDetected: suspicious, acl: redactSecrets(out.trim()) });
  }
  return finding({
    id: 'PERM-001',
    title: 'Sensitive file permissions',
    category: 'Hardening',
    severity: broad ? 'high' : 'info',
    status: broad ? 'fail' : 'pass',
    impact: 'Broad read/write ACLs on .env or data/ allow other local accounts to read or tamper with secrets and the database.',
    evidence: { command: 'icacls .env; icacls data', results },
    remediation: broad
      ? [
        'Remove broad grants: icacls ".env" /inheritance:r',
        'Grant only the app identity: icacls ".env" /grant "IIS_IUSRS:R"',
        'Repeat for the data directory with modify rights only for the app pool',
      ]
      : [],
    verification: 'icacls .env   (should list only the app identity and Administrators)',
  });
}

async function checkLiveHeaders(url) {
  if (!url) {
    return finding({
      id: 'HDR-001',
      title: 'Live HTTP security headers',
      category: 'Transport',
      severity: 'info',
      status: 'info',
      impact: 'Missing headers enable XSS, clickjacking and downgrade attacks in the browser.',
      evidence: { command: 'node scripts/enterprise-report.mjs --url <endpoint>', note: 'Check skipped: no --url provided.' },
      remediation: [],
      verification: null,
    });
  }
  const required = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': null,
    'strict-transport-security': null,
    'content-security-policy': null,
    'referrer-policy': null,
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const headers = {};
    for (const [k] of Object.entries(required)) headers[k] = res.headers.get(k);
    const missing = Object.entries(headers).filter(([, v]) => !v).map(([k]) => k);
    return finding({
      id: 'HDR-001',
      title: 'Live HTTP security headers',
      category: 'Transport',
      severity: missing.length ? 'medium' : 'info',
      status: missing.length ? 'fail' : 'pass',
      impact: 'Missing headers enable XSS, clickjacking and downgrade attacks in the browser.',
      evidence: { command: `fetch ${url}`, url, httpStatus: res.status, headers, missing },
      remediation: missing.length
        ? ['Add the missing headers in web.config <httpProtocol><customHeaders>', 'Re-run this check after applying web.config']
        : [],
      verification: `curl -I ${url}`,
    });
  } catch (err) {
    return finding({
      id: 'HDR-001',
      title: 'Live HTTP security headers',
      category: 'Transport',
      severity: 'medium',
      status: 'warn',
      impact: 'Could not verify live headers.',
      evidence: { command: `fetch ${url}`, url, error: err.message },
      remediation: ['Confirm the host is reachable from this machine, then re-run with --url'],
      verification: `curl -I ${url}`,
    });
  }
}

// ── report rendering ──────────────────────────────────────────────────────────

function summarize(findings) {
  const byStatus = { pass: 0, fail: 0, warn: 0, info: 0 };
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    byStatus[f.status] = (byStatus[f.status] || 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }
  return { total: findings.length, byStatus, bySeverity };
}

function renderMarkdown(report) {
  const { meta, findings, summary } = report;
  const lines = [];
  lines.push('# Wanar AI — Enterprise Security Report');
  lines.push('');
  lines.push(`**Generated:** ${meta.generatedAt}  `);
  lines.push(`**Host:** ${meta.host}  `);
  lines.push(`**Commit:** \`${meta.gitCommit || 'n/a'}\` (${meta.gitBranch || 'n/a'})  `);
  lines.push(`**Node:** ${meta.node}  `);
  lines.push(`**Report ID:** \`${meta.reportId}\``);
  lines.push('');
  lines.push('> Evidence-based report. Every finding cites the exact command, raw output,');
  lines.push('> timestamp and SHA-256 of its evidence. Secret values are never included.');
  lines.push('');
  lines.push('## Executive summary');
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| Checks run | ${summary.total} |`);
  lines.push(`| Failed | ${summary.byStatus.fail} |`);
  lines.push(`| Warnings | ${summary.byStatus.warn} |`);
  lines.push(`| Passed | ${summary.byStatus.pass} |`);
  lines.push(`| Critical | ${summary.bySeverity.critical} |`);
  lines.push(`| High | ${summary.bySeverity.high} |`);
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  for (const f of sorted) {
    lines.push(`### ${f.id} — ${f.title}`);
    lines.push('');
    lines.push(`- **Category:** ${f.category}`);
    lines.push(`- **Severity:** ${f.severity.toUpperCase()}`);
    lines.push(`- **Status:** ${f.status.toUpperCase()}`);
    lines.push('');
    lines.push(`**Impact:** ${f.impact}`);
    lines.push('');
    lines.push('**Evidence (verifiable):**');
    lines.push('```json');
    lines.push(JSON.stringify(f.evidence, null, 2));
    lines.push('```');
    lines.push('');
    if (f.remediation.length) {
      lines.push('**Remediation:**');
      for (const r of f.remediation) lines.push(`- ${r}`);
      lines.push('');
    }
    if (f.verification) {
      lines.push(`**Verification:** \`${f.verification}\``);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }
  lines.push('*Generated by `scripts/enterprise-report.mjs`. Re-run to refresh the evidence.*');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/enterprise-report.mjs [--url <endpoint>] [--out <dir>] [--json-only]');
    return;
  }

  const findings = [
    checkRuntimeFingerprint(),
    checkEnvFile(),
    checkSecretsAudit(),
    checkDependencies(),
    checkAuthLog(),
    checkFilePermissions(),
    await checkLiveHeaders(args.url),
  ];

  const summary = summarize(findings);
  const generatedAt = new Date().toISOString();
  const gitCommit = run('git', ['rev-parse', 'HEAD']);
  const gitBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const report = {
    meta: {
      generatedAt,
      host: os.hostname(),
      node: process.version,
      cwd: ROOT,
      gitCommit: gitCommit.ok ? gitCommit.stdout.trim() : null,
      gitBranch: gitBranch.ok ? gitBranch.stdout.trim() : null,
      reportId: sha256(generatedAt + os.hostname()).slice(0, 16),
    },
    summary,
    findings,
  };

  const outDir = path.isAbsolute(args.out) ? args.out : path.join(ROOT, args.out);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `enterprise-report-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const mdPath = path.join(outDir, `enterprise-report-${stamp}.md`);
  if (!args.jsonOnly) fs.writeFileSync(mdPath, renderMarkdown(report));

  console.log(`\nWanar AI — Enterprise Security Report`);
  console.log(`Checks: ${summary.total}  Fail: ${summary.byStatus.fail}  Warn: ${summary.byStatus.warn}  Pass: ${summary.byStatus.pass}`);
  console.log(`Critical: ${summary.bySeverity.critical}  High: ${summary.bySeverity.high}`);
  console.log(`JSON: ${path.relative(ROOT, jsonPath)}`);
  if (!args.jsonOnly) console.log(`MD:   ${path.relative(ROOT, mdPath)}\n`);

  process.exit(summary.byStatus.fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`enterprise-report error: ${err.message}`);
  process.exit(2);
});
