/**
 * src/automation/channels/base.js
 *
 * Shared plumbing for non-email channels: HTTP with a hard timeout, error
 * normalisation onto the same MailError/ErrorKind vocabulary the campaign
 * engine already understands, and message chunking.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { MailError, ErrorKind } from '../mailer.js';

export { MailError, ErrorKind };

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Splits text into pieces of at most `max` characters, preferring paragraph,
 * then line, then sentence/word boundaries so a long message stays readable.
 */
export function chunkText(text, max) {
  const src = String(text ?? '');
  if (max <= 0 || src.length <= max) return [src];

  const out = [];
  let rest = src;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    if (cut < max * 0.4) cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf(' '));
    if (cut < max * 0.4) cut = max; // no good boundary: hard split
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out.filter((c) => c.length > 0);
}

/**
 * fetch() wrapper: timeout, JSON parsing that never throws, and network
 * failures surfaced as transient MailErrors.
 */
export async function httpRequest(fetchImpl, url, { method = 'POST', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new MailError(
      timedOut ? `Waktu habis setelah ${Math.round(timeoutMs / 1000)} detik` : `Gagal terhubung: ${err?.cause?.code || err?.message || err}`,
      ErrorKind.TRANSIENT,
      { code: err?.cause?.code || (timedOut ? 'ETIMEDOUT' : 'ENETWORK') }
    );
  }

  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

/** Seconds from a Retry-After header, as milliseconds (undefined if absent). */
export function retryAfterMs(headers, fallbackSeconds) {
  const raw = headers?.get?.('retry-after');
  const n = raw != null ? Number(raw) : NaN;
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 600) * 1000;
  return fallbackSeconds != null ? fallbackSeconds * 1000 : undefined;
}

/** Common HTTP-status fallback used when a provider gives no better signal. */
export function classifyHttp(status, message, headers) {
  const msg = String(message || `HTTP ${status}`).slice(0, 220);
  if (status === 401 || status === 403) return new MailError(`Akses ditolak (${status}): ${msg}`, ErrorKind.AUTH, { responseCode: status });
  if (status === 404) return new MailError(`Tujuan tidak ditemukan / dicabut (404): ${msg}`, ErrorKind.CONFIG, { responseCode: status });
  if (status === 429) return new MailError(`Terlalu banyak permintaan: ${msg}`, ErrorKind.TRANSIENT, { responseCode: status, retryAfterMs: retryAfterMs(headers, 5) });
  if (status >= 500) return new MailError(`Server tujuan bermasalah (${status}): ${msg}`, ErrorKind.TRANSIENT, { responseCode: status });
  return new MailError(msg, ErrorKind.PERMANENT, { responseCode: status });
}

/** Parameters of a safe `describe()` result shared by all adapters. */
export function missingList(pairs) {
  return pairs.filter(([, ok]) => !ok).map(([name]) => name);
}

export function intEnv(env, key, fallback, { min = 0 } = {}) {
  const n = parseInt(env[key] ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function boolEnv(env, key) {
  return String(env[key] || '').toLowerCase() === 'true';
}

let dryCounter = 0;
export function dryId(prefix) {
  dryCounter += 1;
  return `${prefix}-dry-${Date.now().toString(36)}-${dryCounter}`;
}
