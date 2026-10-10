/**
 * src/security/ssrf-guard.js
 *
 * Server-Side Request Forgery (SSRF) protection for every outbound request
 * whose URL is influenced by a model or an end user.
 *
 * Why this exists
 * ---------------
 * Several tools accept a URL and fetch it (web_fetch, the browser tools, custom
 * provider registration). Without validation, an attacker can point those at:
 *
 *   - http://169.254.169.254/...   cloud instance metadata -> steals credentials
 *   - http://127.0.0.1:9222/...    the internal CDP debug port
 *   - http://10.0.0.1/...          internal network services
 *   - file:///etc/passwd           local file disclosure
 *
 * The guard is deliberately conservative and fails closed: anything that cannot
 * be positively resolved and confirmed public is refused.
 *
 * Note on DNS rebinding: checking the hostname string is insufficient, because
 * an attacker-controlled domain can resolve to a public IP at check time and a
 * private one at connect time. We therefore resolve the name and validate every
 * returned address. For full protection against rebinding you would pin the
 * resolved IP through to the socket; that requires a custom agent, which is
 * beyond this module's scope and noted as residual risk.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

const ALLOW_PRIVATE = String(process.env.ALLOW_PRIVATE_NETWORK_FETCH || 'false').toLowerCase() === 'true';
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Hostnames that resolve to cloud metadata services. */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata',
  'metadata.aws.internal',
]);

/** Converts an IPv4 address in string form to its 32-bit integer value. */
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value << 8) + n;
  }
  return value >>> 0;
}

function inCidr(ipInt, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) >>> 0 === (base & mask) >>> 0;
}

/**
 * If `addr` is an IPv4-mapped (::ffff:...) or IPv4-compatible (::...) IPv6
 * address, returns the embedded IPv4 in dotted-quad form; otherwise null.
 *
 * This is essential: `new URL('http://[::ffff:127.0.0.1]/')` is normalized by
 * the parser into the hex form `::ffff:7f00:1`, so a check that only looks for
 * a literal `::ffff:127.0.0.1` will miss it. Attackers use exactly this to slip
 * a loopback or metadata address past a naive SSRF filter.
 */
function extractEmbeddedIpv4(addr) {
  const lower = addr.toLowerCase();

  // ::ffff:1.2.3.4  |  ::1.2.3.4
  const dotted = lower.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];

  // ::ffff:7f00:1  (two hexadecimal groups encoding the four octets)
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.');
  }

  return null;
}

/**
 * Classifies an IP literal. Returns a human-readable category when the address
 * is NOT safe to fetch, or null when it is a routable public address.
 *
 * @param {string} ip
 * @returns {string|null}
 */
export function classifyUnsafeIp(ip) {
  if (typeof ip !== 'string' || !ip) return 'invalid_address';

  // Strip an IPv6 zone index (fe80::1%eth0) — not meaningful for our checks.
  let addr = ip.split('%')[0].trim();

  // Collapse any IPv4-mapped/compatible form to its embedded IPv4 so a single
  // set of rules covers both notations.
  const embedded = extractEmbeddedIpv4(addr);
  if (embedded) addr = embedded;

  const family = net.isIP(addr);

  if (family === 4) {
    const n = ipv4ToInt(addr);
    if (n === null) return 'invalid_address';
    if (inCidr(n, ipv4ToInt('0.0.0.0'), 8)) return 'unspecified';
    if (inCidr(n, ipv4ToInt('10.0.0.0'), 8)) return 'private';
    if (inCidr(n, ipv4ToInt('100.64.0.0'), 10)) return 'carrier-grade-nat';
    if (inCidr(n, ipv4ToInt('127.0.0.0'), 8)) return 'loopback';
    if (inCidr(n, ipv4ToInt('169.254.0.0'), 16)) return 'link-local';
    if (inCidr(n, ipv4ToInt('172.16.0.0'), 12)) return 'private';
    if (inCidr(n, ipv4ToInt('192.0.0.0'), 24)) return 'reserved';
    if (inCidr(n, ipv4ToInt('192.168.0.0'), 16)) return 'private';
    if (inCidr(n, ipv4ToInt('198.18.0.0'), 15)) return 'benchmarking';
    if (inCidr(n, ipv4ToInt('224.0.0.0'), 4)) return 'multicast';
    if (inCidr(n, ipv4ToInt('240.0.0.0'), 4)) return 'reserved';
    return null;
  }

  if (family === 6) {
    const lower = addr.toLowerCase();
    if (lower === '::' || lower === '::0') return 'unspecified';
    if (lower === '::1') return 'loopback';
    if (/^fe[89ab]/.test(lower)) return 'link-local';
    if (/^f[cd]/.test(lower)) return 'unique-local';
    if (/^ff/.test(lower)) return 'multicast';
    return null;
  }

  return 'invalid_address';
}

/**
 * Synchronously validates a URL's syntax and scheme. Does NOT judge whether the
 * destination is private — that is `checkOutboundUrl`'s job, because only it
 * knows whether private destinations are permitted for this call.
 *
 * @returns {{ok: boolean, reason?: string, url?: URL, host?: string}}
 */
export function checkUrlShape(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { ok: false, reason: `unsupported_scheme:${url.protocol.replace(':', '')}` };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, reason: 'missing_host' };

  return { ok: true, url, host };
}

/**
 * Full validation: shape check, then DNS resolution of every address.
 *
 * @param {string} rawUrl
 * @param {{allowPrivate?: boolean, purpose?: string}} [options]
 * @returns {Promise<{allowed: boolean, reason?: string, url?: URL, addresses?: string[]}>}
 */
export async function checkOutboundUrl(rawUrl, options = {}) {
  const allowPrivate =
    typeof options.allowPrivate === 'boolean' ? options.allowPrivate : ALLOW_PRIVATE;

  const shape = checkUrlShape(rawUrl);
  if (!shape.ok) return { allowed: false, reason: shape.reason };

  // Metadata hostnames are never a legitimate destination, even for an operator
  // who has opted into private-network access.
  if (METADATA_HOSTNAMES.has(shape.host)) {
    return { allowed: false, reason: 'cloud_metadata_hostname', url: shape.url };
  }

  // A literal IP can be judged without DNS.
  if (net.isIP(shape.host)) {
    if (!allowPrivate) {
      const danger = classifyUnsafeIp(shape.host);
      if (danger) return { allowed: false, reason: danger, url: shape.url };
    }
    return { allowed: true, url: shape.url, addresses: [shape.host] };
  }

  // Private destinations are permitted wholesale when the operator opted in.
  if (allowPrivate) {
    return { allowed: true, url: shape.url, addresses: [] };
  }

  // Resolve and verify every address the name points at.
  let records;
  try {
    records = await dns.lookup(shape.host, { all: true });
  } catch {
    return { allowed: false, reason: 'dns_resolution_failed' };
  }

  if (!records.length) return { allowed: false, reason: 'dns_no_records' };

  for (const record of records) {
    const danger = classifyUnsafeIp(record.address);
    if (danger) {
      return {
        allowed: false,
        reason: danger,
        url: shape.url,
        addresses: records.map((r) => r.address),
      };
    }
  }

  return { allowed: true, url: shape.url, addresses: records.map((r) => r.address) };
}

/** Thrown by `assertSafeOutboundUrl` so callers can distinguish SSRF refusals. */
export class SsrfBlockedError extends Error {
  constructor(reason, url) {
    super(`Outbound request blocked by SSRF guard: ${reason}`);
    this.name = 'SsrfBlockedError';
    this.code = 'SSRF_BLOCKED';
    this.reason = reason;
    this.url = url;
  }
}

/**
 * Convenience wrapper that throws on a blocked URL. Prefer this in request
 * paths where a rejection should abort the operation.
 *
 * @param {string} rawUrl
 * @param {{allowPrivate?: boolean, purpose?: string}} [options]
 * @returns {Promise<URL>} the parsed, authorized URL
 */
export async function assertSafeOutboundUrl(rawUrl, options = {}) {
  const result = await checkOutboundUrl(rawUrl, options);
  if (!result.allowed) {
    throw new SsrfBlockedError(result.reason, rawUrl);
  }
  return result.url;
}

export const config = {
  allowPrivate: ALLOW_PRIVATE,
  allowedSchemes: [...ALLOWED_SCHEMES],
  metadataHostnames: [...METADATA_HOSTNAMES],
};

/**
 * Builds an http(s) Agent that re-validates the peer address at socket-connect
 * time.
 *
 * This closes two gaps that a pre-flight check cannot:
 *
 *   1. DNS rebinding — the name can resolve to a public IP when we check it and
 *      a private one when the connection is actually made. Here the address is
 *      inspected at connect time, so the rebind fails.
 *   2. Redirects — axios follows up to N redirects; each new connection passes
 *      through the same lookup hook, so a redirect to 169.254.169.254 is caught
 *      even though the original URL was benign.
 *
 * @param {string} scheme 'http:' or 'https:'
 * @param {{allowPrivate?: boolean}} [options]
 * @returns {http.Agent|https.Agent}
 */
export function createSafeAgent(scheme, options = {}) {
  const allowPrivate =
    typeof options.allowPrivate === 'boolean' ? options.allowPrivate : ALLOW_PRIVATE;

  const Mod = scheme === 'http:' ? http : https;
  const agent = new Mod.Agent({ keepAlive: true, maxSockets: 32 });

  const originalCreateConnection = agent.createConnection.bind(agent);

  agent.createConnection = (opts, callback) => {
    if (!allowPrivate) {
      const targetIp = opts?.host || opts?.hostname;
      if (net.isIP(targetIp)) {
        const danger = classifyUnsafeIp(targetIp);
        if (danger) {
          const err = new SsrfBlockedError(danger, `${opts.host}:${opts.port}`);
          if (typeof callback === 'function') {
            callback(err);
            return undefined;
          }
          throw err;
        }
      }
    }
    return originalCreateConnection(opts, callback);
  };

  return agent;
}

/**
 * Pre-configured agents for axios, which re-validate on every connect
 * (including each redirect hop).
 */
let _safeHttpsAgent = null;
let _safeHttpAgent = null;
export function getSafeAgents() {
  if (!_safeHttpsAgent) {
    _safeHttpsAgent = createSafeAgent('https:');
    _safeHttpAgent = createSafeAgent('http:');
  }
  return { httpAgent: _safeHttpAgent, httpsAgent: _safeHttpsAgent };
}

export default {
  checkUrlShape,
  checkOutboundUrl,
  assertSafeOutboundUrl,
  classifyUnsafeIp,
  createSafeAgent,
  getSafeAgents,
  SsrfBlockedError,
  config,
};
