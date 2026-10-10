#!/usr/bin/env node
/**
 * scripts/secrets-audit.mjs
 *
 * Defensive secret scanner for the Wanar AI repository.
 *
 * Purpose: find credentials that were accidentally HARDCODED into source or
 * config so they can be moved into environment variables / a secrets manager
 * and rotated. It only reads files and reports locations — it never contacts
 * any service, never verifies a credential, and never prints full secret
 * values (they are redacted).
 *
 * Usage:
 *   node scripts/secrets-audit.mjs                 # scan whole repo
 *   node scripts/secrets-audit.mjs --json          # machine-readable output
 *   node scripts/secrets-audit.mjs --staged        # only git-staged files (pre-commit)
 *   node scripts/secrets-audit.mjs --path src      # scan a subdirectory
 *
 * Exit codes: 0 = clean, 1 = findings, 2 = usage/runtime error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.vitest', '.cache', 'tmp', 'temp', 'logs', 'data',
]);

const IGNORE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.zip', '.gz', '.tar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.traineddata', '.woff', '.woff2',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Detection rules. `group` is the capture group holding the secret value.
 * Patterns are intentionally conservative to keep false positives low.
 */
const RULES = [
  { id: 'private-key',   severity: 'critical', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, group: 0 },
  { id: 'aws-access-key', severity: 'critical', regex: /\b(AKIA[0-9A-Z]{16})\b/g, group: 1 },
  { id: 'aws-secret',     severity: 'critical', regex: /(?:aws_secret_access_key|aws-secret-access-key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})/gi, group: 1 },
  { id: 'google-api-key', severity: 'high',     regex: /\b(AIza[0-9A-Za-z\-_]{35})\b/g, group: 1 },
  { id: 'openai-key',     severity: 'high',     regex: /\b(sk-[A-Za-z0-9]{20,})\b/g, group: 1 },
  { id: 'anthropic-key',  severity: 'high',     regex: /\b(sk-ant-[A-Za-z0-9\-_]{20,})\b/g, group: 1 },
  { id: 'nvidia-key',     severity: 'high',     regex: /\b(nvapi-[A-Za-z0-9\-_]{20,})\b/g, group: 1 },
  { id: 'groq-key',       severity: 'high',     regex: /\b(gsk_[A-Za-z0-9]{20,})\b/g, group: 1 },
  { id: 'slack-token',    severity: 'high',     regex: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, group: 1 },
  { id: 'github-token',   severity: 'high',     regex: /\b(gh[pousr]_[A-Za-z0-9]{36,})\b/g, group: 1 },
  { id: 'jwt',            severity: 'medium',   regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, group: 1 },
  { id: 'db-uri',         severity: 'high',     regex: /\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:[^@\s/]+@[^\s'"]+)/gi, group: 1 },
  { id: 'generic-secret', severity: 'medium',   regex: /(?:api[_-]?key|secret|passwd|password|token|bearer)\s*[:=]\s*['"]([^'"\n]{12,})['"]/gi, group: 1 },
];

const PLACEHOLDER_ALLOWLIST = [
  /your[-_]?api[-_]?key/i,
  /api[-_]?key[-_]?here/i,
  /example/i,
  /placeholder/i,
  /changeme/i,
  /replace[-_]?me/i,
  /<[^>]+>/,
  /^\$\{?[A-Z0-9_]+\}?$/,
  /process\.env\./,
  /xxx+/i,
  /\.\.\./,
  /^['"]+$/,
];

// Extra filters applied only to the broad `generic-secret` rule to keep its
// false-positive rate low. Not applied to high-confidence rules.
const GENERIC_ALLOWLIST = [
  /^\[.*\]$/,                    // bracketed placeholders, e.g. [session_token]
  /\s/,                          // a raw secret never contains whitespace
  /(?:test|fake|dummy|wrong|sample|mock|stub|fixture|notreal|nonexistent|invalid)/i,
  /^[a-z0-9]+(?:_[a-z0-9]+)+$/,  // snake_case identifiers (cost_per_token)
  /^[a-z][a-z0-9_]*$/,           // lowercase identifiers
];

function isAllowed(value, ruleId) {
  if (PLACEHOLDER_ALLOWLIST.some((re) => re.test(value))) return true;
  if (ruleId === 'generic-secret' && GENERIC_ALLOWLIST.some((re) => re.test(value))) return true;
  return false;
}

function redact(value) {
  const v = String(value);
  if (v.length <= 8) return '*'.repeat(v.length);
  return `${v.slice(0, 4)}${'*'.repeat(Math.min(v.length - 6, 24))}${v.slice(-2)}`;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      if (IGNORE_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      if (entry.name.endsWith('.map')) continue;
      out.push(full);
    }
  }
  return out;
}

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean).map((f) => path.join(ROOT, f));
}

/**
 * Returns tracked + untracked-but-not-ignored files, so the intended secret
 * store (.env, ignored by .gitignore) is not reported as a finding. Falls back
 * to a filesystem walk outside a git repo.
 */
function workingTreeFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean).map((f) => path.join(ROOT, f));
  } catch {
    return walk(ROOT);
  }
}

function shouldSkip(file) {
  const rel = path.relative(ROOT, file);
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => IGNORE_DIRS.has(p))) return true;
  if (IGNORE_EXT.has(path.extname(file).toLowerCase())) return true;
  if (file.endsWith('.map')) return true;
  return false;
}

function scanFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  if (stat.size > MAX_FILE_BYTES) return [];

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  if (text.includes('\u0000')) return [];

  const lines = text.split(/\r?\n/);
  const findings = [];
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 4000) continue;
      rule.regex.lastIndex = 0;
      let m;
      while ((m = rule.regex.exec(line)) !== null) {
        const value = m[rule.group] ?? m[0];
        if (!value || isAllowed(value, rule.id)) continue;
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          file: path.relative(ROOT, file),
          line: i + 1,
          match: redact(value),
        });
        if (m.index === rule.regex.lastIndex) rule.regex.lastIndex++;
      }
    }
  }
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const staged = args.includes('--staged');
  const pathIdx = args.indexOf('--path');
  const scanRoot = pathIdx !== -1 && args[pathIdx + 1]
    ? path.resolve(ROOT, args[pathIdx + 1])
    : ROOT;

  let files;
  if (staged) {
    files = stagedFiles().filter((f) => fs.existsSync(f) && !shouldSkip(f));
  } else if (scanRoot === ROOT) {
    files = workingTreeFiles().filter((f) => fs.existsSync(f) && !shouldSkip(f));
  } else {
    files = walk(scanRoot).filter((f) => !shouldSkip(f));
  }

  const findings = [];
  for (const f of files) findings.push(...scanFile(f));

  findings.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return (order[a.severity] - order[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line;
  });

  if (asJson) {
    process.stdout.write(JSON.stringify({
      scannedFiles: files.length,
      findings,
      summary: summarize(findings),
    }, null, 2) + '\n');
  } else {
    printHuman(files.length, findings);
  }

  process.exit(findings.length > 0 ? 1 : 0);
}

function summarize(findings) {
  const bySeverity = {};
  const byRule = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  }
  return { total: findings.length, bySeverity, byRule };
}

function printHuman(scanned, findings) {
  const c = process.stdout.isTTY
    ? { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', gray: '\x1b[90m', bold: '\x1b[1m', reset: '\x1b[0m' }
    : { red: '', yellow: '', green: '', gray: '', bold: '', reset: '' };

  console.log(`\n${c.bold}Wanar AI — Secrets Audit${c.reset}`);
  console.log(`${c.gray}Scanned ${scanned} file(s)${c.reset}\n`);

  if (findings.length === 0) {
    console.log(`${c.green}No hardcoded secrets detected.${c.reset}\n`);
    return;
  }

  for (const f of findings) {
    const tag = f.severity === 'critical' ? c.red
      : f.severity === 'high' ? c.red
      : c.yellow;
    console.log(`${tag}[${f.severity.toUpperCase()}]${c.reset} ${f.file}:${f.line}  ${c.gray}${f.rule}${c.reset}  ${f.match}`);
  }

  const s = summarize(findings);
  console.log(`\n${c.bold}Total: ${s.total} finding(s)${c.reset}`);
  for (const [sev, n] of Object.entries(s.bySeverity)) console.log(`  ${sev}: ${n}`);
  console.log(`\n${c.gray}Remediate: move values to .env / secrets manager, rotate the exposed credential, then purge from git history if committed.${c.reset}\n`);
}

main();
