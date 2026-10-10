/**
 * src/security/scan-scope.js
 *
 * Persistent, auditable record of the hosts the operator has declared as
 * owned/authorized for active security testing.
 *
 * Why a file instead of only an env var
 * -------------------------------------
 * `SCAN_ALLOWED_TARGETS` is convenient but has three problems: it needs a
 * restart to change, it leaves no record of who authorized what or when, and it
 * gives no place to capture the reason. This module stores scope in a JSON file
 * with an audit trail, so authorization is an explicit, reviewable act rather
 * than a silent config edit.
 *
 * What this is NOT
 * ----------------
 * This does not grant permission to test anything. It records the operator's
 * own declaration that they are authorized. Only the owner of a system (or
 * someone with written authorization from them) may make that declaration. The
 * software cannot verify ownership, which is precisely why the declaration is
 * kept explicit, dated, attributed, and reviewable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCOPE_PATH =
  process.env.SCAN_SCOPE_FILE || path.join(__dirname, '..', '..', 'config', 'scan-scope.json');

const SCHEMA_VERSION = 1;

function normalizeHost(host) {
  return String(host || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

/** Rejects anything that is not a plausible DNS hostname or IP literal. */
export function isValidHost(host) {
  const h = normalizeHost(host);
  if (!h || h.length > 253) return false;
  if (h === 'localhost') return true;
  // IPv4 / IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^[0-9a-f:]+$/.test(h) && h.includes(':')) return true;
  // DNS name: labels of alphanumerics and hyphens, at least two labels.
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(h);
}

function emptyStore() {
  return { version: SCHEMA_VERSION, hosts: [] };
}

/** Reads the scope file. Returns an empty store if missing or unparseable. */
export function loadScope() {
  try {
    const raw = fs.readFileSync(SCOPE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.hosts)) return emptyStore();
    return { version: parsed.version || SCHEMA_VERSION, hosts: parsed.hosts };
  } catch {
    return emptyStore();
  }
}

function saveScope(store) {
  fs.mkdirSync(path.dirname(SCOPE_PATH), { recursive: true });
  fs.writeFileSync(SCOPE_PATH, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

/**
 * Returns the authorized hostnames recorded in the scope file.
 * @returns {string[]}
 */
export function getAuthorizedHosts() {
  return loadScope().hosts.map((h) => h.host);
}

/**
 * Adds a host to the authorized scope.
 *
 * @param {string} host - the hostname the operator is declaring as owned
 * @param {{reason?: string, addedBy?: string, authorization?: string}} meta
 * @returns {{success: boolean, error?: string, entry?: object}}
 */
export function authorizeHost(host, meta = {}) {
  const h = normalizeHost(host);
  if (!isValidHost(h)) {
    return { success: false, error: `"${host}" is not a valid hostname or IP address.` };
  }

  const store = loadScope();
  const existing = store.hosts.find((x) => x.host === h);
  if (existing) {
    return { success: false, error: `"${h}" is already in the authorized scope.`, entry: existing };
  }

  const entry = {
    host: h,
    reason: meta.reason ? String(meta.reason).slice(0, 500) : '',
    authorization: meta.authorization ? String(meta.authorization).slice(0, 200) : 'operator-declared-ownership',
    addedBy: meta.addedBy || process.env.USER || process.env.USERNAME || 'operator',
    addedAt: new Date().toISOString(),
  };

  store.hosts.push(entry);
  saveScope(store);
  return { success: true, entry };
}

/**
 * Removes a host from the authorized scope.
 * @returns {{success: boolean, error?: string, removed?: object}}
 */
export function revokeHost(host) {
  const h = normalizeHost(host);
  const store = loadScope();
  const idx = store.hosts.findIndex((x) => x.host === h);
  if (idx === -1) return { success: false, error: `"${h}" is not in the authorized scope.` };
  const [removed] = store.hosts.splice(idx, 1);
  saveScope(store);
  return { success: true, removed };
}

/** True when the host is explicitly present in the scope file. */
export function isAuthorizedInFile(hostname) {
  const h = normalizeHost(hostname);
  return loadScope().hosts.some((x) => x.host === h);
}

export const config = { scopePath: SCOPE_PATH, schemaVersion: SCHEMA_VERSION };

export default {
  loadScope,
  getAuthorizedHosts,
  authorizeHost,
  revokeHost,
  isAuthorizedInFile,
  isValidHost,
  config,
};
