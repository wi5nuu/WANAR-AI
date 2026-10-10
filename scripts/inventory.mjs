#!/usr/bin/env node
/**
 * scripts/inventory.mjs
 *
 * Passive asset inventory for a domain YOU OWN.
 *
 * Collects non-sensitive metadata only:
 *   - DNS records (A / AAAA / CNAME / MX / NS / TXT)
 *   - Hostnames from Certificate Transparency logs (public data)
 *   - TLS certificate subject, issuer, validity and days-until-expiry on :443
 *
 * It does NOT scan ports, does NOT send credentials, and does NOT read any
 * files from remote hosts. Use it to keep track of your own attack surface and
 * certificate renewals.
 *
 * Usage:
 *   node scripts/inventory.mjs --domain example.com
 *   node scripts/inventory.mjs --domain example.com --ct
 *   node scripts/inventory.mjs --hosts api.example.com,www.example.com
 *   node scripts/inventory.mjs --domain example.com --ct --json
 *
 * Exit codes: 0 = success, 2 = usage/runtime error.
 */

import dns from 'node:dns/promises';
import tls from 'node:tls';
import path from 'node:path';

const COMMON_SUBDOMAINS = [
  'www', 'api', 'app', 'admin', 'portal', 'mail', 'smtp', 'imap', 'pop',
  'webmail', 'dev', 'staging', 'stage', 'test', 'qa', 'uat', 'beta', 'demo',
  'cdn', 'static', 'assets', 'img', 'media', 'files', 'docs', 'help', 'support',
  'status', 'monitor', 'grafana', 'prometheus', 'db', 'sql', 'redis', 'cache',
  'git', 'gitlab', 'jenkins', 'ci', 'vpn', 'remote', 'ftp', 'ns1', 'ns2',
];

const CONCURRENCY = 8;
const TLS_TIMEOUT_MS = 8000;

function parseArgs(argv) {
  const args = { ct: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ct') args.ct = true;
    else if (a === '--json') args.json = true;
    else if (a === '--domain') args.domain = argv[++i];
    else if (a === '--hosts') args.hosts = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Wanar AI — Passive Asset Inventory

Usage:
  node scripts/inventory.mjs --domain <domain> [--ct] [--json]
  node scripts/inventory.mjs --hosts <h1,h2,...> [--json]

Options:
  --domain   Root domain you own (e.g. example.com)
  --hosts    Explicit comma-separated hostnames to check
  --ct       Also query Certificate Transparency logs for subdomains
  --json     Emit JSON instead of a table

Notes: metadata only — DNS + TLS certificate info. No port scanning, no credentials.`);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'wanar-inventory/1.0' } });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCtSubdomains(domain) {
  try {
    const res = await fetchWithTimeout(`https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`, 15000);
    if (!res.ok) return [];
    const data = await res.json();
    const set = new Set();
    for (const entry of data) {
      for (const name of String(entry.name_value || '').split('\n')) {
        const clean = name.trim().toLowerCase().replace(/^\*\./, '');
        if (clean && clean.endsWith(domain) && !clean.includes('*')) set.add(clean);
      }
    }
    return [...set];
  } catch {
    return [];
  }
}

async function dnsRecords(hostname) {
  const record = { a: [], aaaa: [], cname: [], mx: [], ns: [], txt: [] };
  const tasks = [
    dns.resolve4(hostname).then((v) => { record.a = v; }).catch(() => {}),
    dns.resolve6(hostname).then((v) => { record.aaaa = v; }).catch(() => {}),
    dns.resolveCname(hostname).then((v) => { record.cname = v; }).catch(() => {}),
    dns.resolveMx(hostname).then((v) => { record.mx = v.map((m) => `${m.priority} ${m.exchange}`); }).catch(() => {}),
    dns.resolveNs(hostname).then((v) => { record.ns = v; }).catch(() => {}),
    dns.resolveTxt(hostname).then((v) => { record.txt = v.map((chunks) => chunks.join('')); }).catch(() => {}),
  ];
  await Promise.all(tasks);
  return record;
}

function certInfo(hostname, port = 443) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: TLS_TIMEOUT_MS }, () => {
      if (settled) return;
      settled = true;
      const cert = socket.getPeerCertificate();
      const cipher = socket.getCipher();
      const protocol = socket.getProtocol();
      socket.end();
      if (!cert || !cert.valid_to) return resolve(null);
      const validTo = new Date(cert.valid_to);
      resolve({
        subject: cert.subject?.CN || null,
        issuer: cert.issuer?.O || cert.issuer?.CN || null,
        validFrom: cert.valid_from || null,
        validTo: validTo.toISOString(),
        daysRemaining: Math.floor((validTo.getTime() - Date.now()) / 86400000),
        protocol: protocol || null,
        cipher: cipher?.name || null,
        altNames: cert.subjectaltname ? cert.subjectaltname.split(',').map((s) => s.trim()) : [],
      });
    });
    socket.on('timeout', () => { if (!settled) { settled = true; socket.destroy(); resolve(null); } });
    socket.on('error', () => { if (!settled) { settled = true; resolve(null); } });
  });
}

async function checkHost(hostname) {
  const records = await dnsRecords(hostname);
  const resolves = records.a.length > 0 || records.aaaa.length > 0 || records.cname.length > 0;
  let cert = null;
  if (resolves) cert = await certInfo(hostname);
  return { hostname, records, cert };
}

function printTable(assets) {
  const c = process.stdout.isTTY
    ? { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', gray: '\x1b[90m', bold: '\x1b[1m', reset: '\x1b[0m' }
    : { red: '', yellow: '', green: '', gray: '', bold: '', reset: '' };

  const rows = assets
    .filter((a) => a.records.a.length || a.records.aaaa.length || a.records.cname.length)
    .sort((a, b) => a.hostname.localeCompare(b.hostname));

  console.log(`\n${c.bold}Wanar AI — Asset Inventory${c.reset}`);
  console.log(`${c.gray}${rows.length} resolvable host(s) of ${assets.length} checked${c.reset}\n`);

  if (rows.length === 0) {
    console.log(`${c.yellow}No resolvable hosts found.${c.reset}\n`);
    return;
  }

  for (const a of rows) {
    const ips = [...a.records.a, ...a.records.aaaa].join(', ') || a.records.cname.join(', ');
    let certStr = `${c.gray}no TLS${c.reset}`;
    if (a.cert) {
      const d = a.cert.daysRemaining;
      const color = d < 0 ? c.red : d < 30 ? c.red : d < 90 ? c.yellow : c.green;
      certStr = `${color}${d}d${c.reset} (${a.cert.protocol})`;
    }
    console.log(`${c.bold}${a.hostname}${c.reset}`);
    console.log(`  ${c.gray}IP:${c.reset}   ${ips}`);
    if (a.records.mx.length) console.log(`  ${c.gray}MX:${c.reset}   ${a.records.mx.join(', ')}`);
    if (a.records.txt.length) console.log(`  ${c.gray}TXT:${c.reset}  ${a.records.txt.length} record(s)`);
    console.log(`  ${c.gray}TLS:${c.reset}  ${certStr}${a.cert ? `  issuer=${a.cert.issuer}` : ''}`);
    console.log();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.domain && !args.hosts)) {
    usage();
    process.exit(args.help ? 0 : 2);
  }

  let hostnames = [];
  if (args.hosts) {
    hostnames = args.hosts.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  } else {
    const domain = args.domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    hostnames = [domain, ...COMMON_SUBDOMAINS.map((s) => `${s}.${domain}`)];
    if (args.ct) {
      const ct = await fetchCtSubdomains(domain);
      if (!args.json) console.log(`\n${ct.length} hostname(s) from Certificate Transparency logs.`);
      hostnames = [...new Set([...hostnames, ...ct])];
    }
  }

  if (!args.json) console.log(`\nChecking ${hostnames.length} hostname(s)...`);

  const assets = await mapLimit(hostnames, CONCURRENCY, (h) => checkHost(h));

  if (args.json) {
    process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), assets }, null, 2) + '\n');
  } else {
    printTable(assets);
    const expiring = assets.filter((a) => a.cert && a.cert.daysRemaining < 90);
    if (expiring.length) {
      console.log(`${process.stdout.isTTY ? '\x1b[33m' : ''}Certificates expiring within 90 days:${process.stdout.isTTY ? '\x1b[0m' : ''}`);
      for (const a of expiring) console.log(`  - ${a.hostname}: ${a.cert.daysRemaining} day(s)`);
      console.log();
    }
  }
}

main().catch((err) => {
  console.error(`inventory error: ${err.message}`);
  process.exit(2);
});
