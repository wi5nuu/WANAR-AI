/**
 * src/observability/quota.js
 *
 * "How much is left?" per provider — from real sources only, each labelled:
 *
 *   1. provider headers   x-ratelimit-* / anthropic-ratelimit-* / retry-after, captured
 *                         from every real response by the shared HTTP client.
 *   2. provider API       OpenRouter GET /api/v1/key (credit limit, usage, remaining).
 *   3. local accounting   tokens Wanar actually used today (token_usage table) and
 *                         the daily budget from config.
 *   4. failover state     models cooling down after "quota exhausted", rejected keys,
 *                         open circuits — with the time they recover.
 *
 * A provider that publishes none of these says so; nothing is guessed.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import http from '../providers/http-client.js';

/** host -> { at, status, info, raw } */
const seen = new Map();

const PICK = {
  remainingRequests: ['x-ratelimit-remaining-requests', 'x-ratelimit-remaining', 'anthropic-ratelimit-requests-remaining', 'x-ratelimit-remaining-requests-day'],
  limitRequests: ['x-ratelimit-limit-requests', 'x-ratelimit-limit', 'anthropic-ratelimit-requests-limit', 'x-ratelimit-limit-requests-day'],
  resetRequests: ['x-ratelimit-reset-requests', 'x-ratelimit-reset', 'anthropic-ratelimit-requests-reset'],
  remainingTokens: ['x-ratelimit-remaining-tokens', 'anthropic-ratelimit-tokens-remaining', 'anthropic-ratelimit-input-tokens-remaining', 'x-ratelimit-remaining-tokens-minute'],
  limitTokens: ['x-ratelimit-limit-tokens', 'anthropic-ratelimit-tokens-limit', 'anthropic-ratelimit-input-tokens-limit', 'x-ratelimit-limit-tokens-minute'],
  resetTokens: ['x-ratelimit-reset-tokens', 'anthropic-ratelimit-tokens-reset'],
  retryAfter: ['retry-after'],
};

function lower(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === 'function' && !Array.isArray(headers) && typeof headers.toJSON !== 'function'
    ? [...headers.entries()]
    : Object.entries(typeof headers.toJSON === 'function' ? headers.toJSON() : headers);
  for (const [k, v] of entries) out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v);
  return out;
}

/** Extracts the rate-limit fields a response carries (null when it carries none). */
export function parseRateHeaders(headers) {
  const h = lower(headers);
  const info = {};
  for (const [field, names] of Object.entries(PICK)) {
    for (const n of names) {
      if (h[n] != null && h[n] !== '') { info[field] = h[n]; break; }
    }
  }
  const raw = {};
  for (const [k, v] of Object.entries(h)) if (/ratelimit|retry-after|x-credits|x-balance/.test(k)) raw[k] = v;
  return Object.keys(raw).length ? { info, raw } : null;
}

/** Called by the shared HTTP client for every provider response (success or error). */
export function recordResponseHeaders(url, status, headers) {
  let host;
  try { host = new URL(url).host; } catch { return; }
  const parsed = parseRateHeaders(headers);
  if (!parsed) return;
  seen.set(host, { at: Date.now(), status, ...parsed });
}

export function headerQuotaFor(baseUrl) {
  try { return seen.get(new URL(baseUrl).host) || null; } catch { return null; }
}

/** Installs the capture hook on the shared axios instance (idempotent). */
let installed = false;
export function installHeaderCapture(client = http) {
  if (installed || !client?.interceptors) return;
  installed = true;
  const grab = (res) => {
    try {
      const url = res?.config?.url ? new URL(res.config.url, res.config.baseURL || undefined).toString() : null;
      if (url) recordResponseHeaders(url, res.status, res.headers);
    } catch { /* telemetry must never break a request */ }
  };
  client.interceptors.response.use(
    (res) => { grab(res); return res; },
    (err) => { grab(err?.response); return Promise.reject(err); }
  );
}

// ------------------------------------------------------------- provider APIs

const apiCache = new Map(); // provider -> {at, data}
const API_TTL_MS = 5 * 60 * 1000;

/** OpenRouter publishes the key's credit limit and usage (documented /api/v1/key). */
async function openRouterKey(inst, fetcher) {
  const base = String(inst.baseUrl || inst.baseURL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const res = await fetcher.get(`${base}/key`, { headers: { Authorization: `Bearer ${inst.apiKey}` }, timeout: 10_000 });
  const d = res.data?.data || {};
  return {
    source: 'OpenRouter /api/v1/key',
    label: d.label || null,
    freeTier: d.is_free_tier ?? null,
    creditLimit: d.limit ?? null,          // null = unlimited
    creditUsed: d.usage ?? null,
    creditRemaining: d.limit_remaining ?? (d.limit != null && d.usage != null ? d.limit - d.usage : null),
    rateLimit: d.rate_limit || null,
  };
}

const PROVIDER_APIS = { openrouter: openRouterKey };

const inflight = new Map(); // provider -> Promise

/**
 * @param {{refresh?:boolean, wait?:boolean, fetcher?:object}} opts
 *   wait=false: answer instantly from cache (null on first call) and refresh in the
 *   background — the live map must never stall on a slow provider API.
 */
export async function providerApiQuota(name, inst, { refresh = false, wait = true, fetcher = http } = {}) {
  const fn = PROVIDER_APIS[name];
  if (!fn || !inst?.apiKey) return null;
  const hit = apiCache.get(name);
  if (hit && !refresh && Date.now() - hit.at < API_TTL_MS) return hit.data;
  if (!wait) {
    if (!inflight.has(name)) {
      const job = providerApiQuota(name, inst, { refresh: true, fetcher }).finally(() => inflight.delete(name));
      inflight.set(name, job);
    }
    return hit?.data || null;
  }
  try {
    const data = { ...(await fn(inst, fetcher)), at: Date.now() };
    apiCache.set(name, { at: Date.now(), data });
    return data;
  } catch (e) {
    const data = { source: 'provider API', error: e.response?.data?.error?.message || e.message, at: Date.now() };
    apiCache.set(name, { at: Date.now(), data });
    return data;
  }
}

/** Test helper. */
export function _resetQuotaState() {
  seen.clear();
  apiCache.clear();
  inflight.clear();
}
