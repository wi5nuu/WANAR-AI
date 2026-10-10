/**
 * src/providers/http-client.js
 *
 * Shared high-performance HTTP client for all AI providers.
 *
 * Why this exists:
 *   Previously every provider imported `axios` directly, so each request to a
 *   provider opened a brand-new TCP + TLS connection and threw it away. For an
 *   AI agent that fires many sequential calls to the same host (chat turns,
 *   tool loops, model listing, failover probes) the TLS handshake alone adds
 *   50-200ms of pure latency per call.
 *
 *   This module exports a single axios instance backed by keep-alive
 *   connection pools (one for http, one for https). Sockets are reused across
 *   requests to the same origin, so only the first call to a provider pays the
 *   handshake cost — every call after that is "super kencang".
 *
 * It is a drop-in replacement for `axios`: `import http from './http-client.js'`
 * then use `http.post(...)` / `http.get(...)` exactly as before.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import axios from 'axios';
import http from 'http';
import https from 'https';

const POOL = {
  // Allow plenty of concurrent sockets per host; AI agents fan out during
  // tool loops and failover probing. Kept generous but bounded.
  maxSockets: parseInt(process.env.HTTP_POOL_MAX_SOCKETS || '128', 10),
  maxFreeSockets: parseInt(process.env.HTTP_POOL_MAX_FREE || '32', 10),
  // Keep idle sockets alive long enough to be reused by the next chat turn,
  // but not so long that we hold dead connections to flaky providers.
  keepAliveMsecs: parseInt(process.env.HTTP_POOL_KEEPALIVE_MS || '30000', 10),
  // Socket-level inactivity timeout (not the request timeout, which each
  // provider sets per call). Prevents half-open sockets lingering forever.
  timeout: parseInt(process.env.HTTP_POOL_SOCKET_TIMEOUT_MS || '120000', 10),
  scheduling: 'lifo', // reuse the hottest (most-recently-used) socket first
};

export const httpAgent = new http.Agent({ keepAlive: true, ...POOL });
export const httpsAgent = new https.Agent({ keepAlive: true, ...POOL });

/**
 * Preconfigured axios instance shared by every provider.
 * Per-call options (headers, timeout, responseType: 'stream', signal) still
 * work exactly as with vanilla axios and override these defaults.
 */
const client = axios.create({
  httpAgent,
  httpsAgent,
  // Ask upstreams to gzip/br responses — model listings and long completions
  // compress well, cutting transfer time on top of connection reuse.
  decompress: true,
  headers: {
    'Accept-Encoding': 'gzip, deflate, br',
    // Identify ourselves so provider-side rate limiting/analytics behave.
    'User-Agent': `wanar-ai/${process.env.npm_package_version || '2.0'} (+https://wanar.ai)`,
  },
  // Never let axios cap a large streamed completion.
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
  // We classify status codes ourselves in each provider; keep axios's default
  // (reject >= 400) so existing try/catch error handling stays intact.
});

/**
 * Live pool telemetry for the health/analytics endpoints — lets the enterprise
 * dashboard show socket reuse so you can confirm the fast path is active.
 */
export function getPoolStats() {
  const snap = (agent) => ({
    activeSockets: Object.values(agent.sockets || {}).reduce((n, a) => n + a.length, 0),
    freeSockets: Object.values(agent.freeSockets || {}).reduce((n, a) => n + a.length, 0),
    queuedRequests: Object.values(agent.requests || {}).reduce((n, a) => n + a.length, 0),
  });
  return { http: snap(httpAgent), https: snap(httpsAgent), config: POOL };
}

export default client;
