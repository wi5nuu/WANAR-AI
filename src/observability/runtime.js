/**
 * src/observability/runtime.js — real process health for the "mode teknis" panel:
 * event-loop delay (the honest "is the server keeping up?" number), memory, uptime.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import os from 'node:os';

const h = monitorEventLoopDelay({ resolution: 20 });
h.enable();
const STARTED = Date.now();

export function runtimeSnapshot({ sseClients = 0 } = {}) {
  const mem = process.memoryUsage();
  const ns = (v) => Math.round((v / 1e6) * 10) / 10; // ns -> ms
  const snap = {
    uptimeSec: Math.round((Date.now() - STARTED) / 1000),
    loopLagMs: { p50: ns(h.percentile(50)), p99: ns(h.percentile(99)), max: ns(h.max) },
    rssMb: Math.round(mem.rss / 1048576),
    heapMb: Math.round(mem.heapUsed / 1048576),
    load: os.loadavg().map((x) => Math.round(x * 100) / 100),
    freeMemMb: Math.round(os.freemem() / 1048576),
    totalMemMb: Math.round(os.totalmem() / 1048576),
    node: process.version,
    sseClients,
  };
  h.reset();
  return snap;
}
