/**
 * src/observability/trace-hub.js
 *
 * Live "how did my agent handle this?" record for every AI request, from every
 * channel (web chat, Telegram, email desk, check-ins, briefing, scheduler).
 *
 * One trace = one request: what came in, which provider/model the router chose
 * and why, every attempt and failover, tools, tokens, what went out and where
 * it was delivered. Entry points open a trace with `withTrace()`; deeper code
 * (AIManager, the assistant, the inbox) just calls `traceStep()` and the event
 * lands in whichever trace is active — AsyncLocalStorage carries it across
 * awaits and async generators, so no plumbing through function signatures.
 *
 * Privacy: traces live in memory only (a ring buffer, never written to disk),
 * text is truncated, and anything that looks like a credential is masked.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

const MAX_TRACES = parseInt(process.env.TRACE_MAX || '150', 10);
const MAX_EVENTS = 400;
const MAX_TEXT = 6000;

export const CHANNELS = {
  web: { label: 'Chat Web', icon: '💬' },
  telegram: { label: 'Telegram', icon: '✈️' },
  email: { label: 'Email Desk', icon: '📧' },
  companion: { label: 'Sapaan Peka', icon: '💛' },
  briefing: { label: 'Briefing Pagi', icon: '🌅' },
  automation: { label: 'Otomasi', icon: '⚙️' },
  system: { label: 'Sistem', icon: '🧩' },
};

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bclv_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bnvapi-[A-Za-z0-9_-]{16,}/g,
  /\bgsk_[A-Za-z0-9]{16,}/g,
  /\bxai-[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bxkeysib-[A-Za-z0-9-]{16,}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot token
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:password|passwd|pass|token|api[_-]?key|secret)\s*[:=]\s*)\S+/gi,
];

/** Masks credentials and caps length. Exported for tests. */
export function redact(value, max = MAX_TEXT) {
  if (value == null) return value;
  let s = typeof value === 'string' ? value : safeJson(value);
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (m, keep) => (typeof keep === 'string' && m.startsWith(keep) ? `${keep}••••` : '••••'));
  }
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max} karakter)` : s;
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Rough token estimate (~3.6 chars per token for mixed Indonesian/English). */
export function estimateTokens(text) {
  const n = typeof text === 'string' ? text.length : safeJson(text || '').length;
  return Math.max(0, Math.round(n / 3.6));
}

export class TraceHub extends EventEmitter {
  constructor({ max = MAX_TRACES, now = () => Date.now() } = {}) {
    super();
    this.setMaxListeners(100);
    this.max = max;
    this.now = now;
    this.als = new AsyncLocalStorage();
    /** @type {Map<string, object>} insertion-ordered: oldest first */
    this.traces = new Map();
  }

  current() {
    return this.als.getStore() || null;
  }

  /** Opens a trace (does not activate it; see run/withTrace). */
  start({ channel = 'system', title = '', input = '', meta = {}, parent = null } = {}) {
    const t = this.now();
    const trace = {
      id: `tr_${t.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      channel: CHANNELS[channel] ? channel : 'system',
      title: String(title || CHANNELS[channel]?.label || 'Permintaan').slice(0, 140),
      input: redact(input),
      output: null,
      meta: sanitizeMeta(meta),
      parent,
      status: 'running',
      error: null,
      startedAt: t,
      endedAt: null,
      provider: null,
      model: null,
      tokens: { prompt: 0, completion: 0, total: 0, estimated: true },
      attempts: 0,
      tools: 0,
      events: [],
    };
    this.traces.set(trace.id, trace);
    while (this.traces.size > this.max) this.traces.delete(this.traces.keys().next().value);
    this.emit('trace', { kind: 'start', trace: summary(trace) });
    return trace;
  }

  run(trace, fn) {
    return this.als.run(trace, fn);
  }

  /** Appends an event to `trace` (default: the active one). No-op without a trace. */
  step(type, data = {}, trace = this.current()) {
    if (!trace) return null;
    const at = this.now();
    const ev = { type, at, dt: at - trace.startedAt, ...cleanData(data) };
    if (trace.events.length < MAX_EVENTS) trace.events.push(ev);
    else if (trace.events.length === MAX_EVENTS) trace.events.push({ type: 'truncated', at, dt: ev.dt });

    // Keep the headline fields current so lists need no event replay.
    if (type === 'attempt') trace.attempts += 1;
    if (type === 'tool_start') trace.tools += 1;
    if (type === 'success' || type === 'attempt') {
      if (data.provider) trace.provider = data.provider;
      if (data.model) trace.model = data.model;
    }
    if (type === 'usage') {
      trace.tokens.prompt += Number(data.prompt) || 0;
      trace.tokens.completion += Number(data.completion) || 0;
      trace.tokens.total = trace.tokens.prompt + trace.tokens.completion;
      if (data.estimated === false) trace.tokens.estimated = false;
    }
    this.emit('trace', { kind: 'event', traceId: trace.id, channel: trace.channel, event: ev });
    return ev;
  }

  finish(trace, { status = 'ok', output = null, error = null } = {}) {
    if (!trace || trace.endedAt) return trace;
    trace.endedAt = this.now();
    trace.status = status;
    if (output != null) trace.output = redact(output);
    if (error) trace.error = redact(String(error?.message || error), 600);
    this.emit('trace', { kind: 'end', trace: summary(trace) });
    return trace;
  }

  /**
   * Opens a trace, runs fn inside it, closes it. If a trace is already active the
   * work is recorded there instead (one request = one trace, no nesting noise).
   * A string result becomes the trace output.
   */
  async withTrace(opts, fn) {
    if (this.current()) return fn(this.current());
    const trace = this.start(opts);
    try {
      const out = await this.run(trace, () => fn(trace));
      const text = typeof out === 'string' ? out : trace.output;
      const failed = !String(text || '').trim() && trace.events.some((e) => e.type === 'all_failed');
      this.finish(trace, { status: failed ? 'error' : 'ok', output: text, error: failed ? 'Semua provider gagal' : null });
      return out;
    } catch (e) {
      this.finish(trace, { status: 'error', error: e });
      throw e;
    }
  }

  list({ limit = 60, channel = null } = {}) {
    const all = [...this.traces.values()].reverse();
    return all.filter((t) => !channel || t.channel === channel).slice(0, limit).map(summary);
  }

  get(id) {
    return this.traces.get(id) || null;
  }

  clear() {
    this.traces.clear();
  }
}

function sanitizeMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) if (v != null) out[k] = scrub(v, k);
  return out;
}

const LONG_FIELDS = new Set(['text', 'result', 'args', 'system', 'output', 'input']);

/** Deep copy with every string redacted and capped; bounded depth/width. */
function scrub(v, key = '', depth = 0) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return redact(v, LONG_FIELDS.has(key) ? 2500 : 600);
  if (depth >= 4) return '…';
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => scrub(x, key, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 40)) if (x !== undefined) out[k] = scrub(x, k, depth + 1);
    return out;
  }
  return String(v);
}

function cleanData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) if (v !== undefined) out[k] = scrub(v, k);
  return out;
}

export function summary(t) {
  return {
    id: t.id,
    channel: t.channel,
    title: t.title,
    input: t.input ? String(t.input).slice(0, 220) : '',
    output: t.output ? String(t.output).slice(0, 220) : '',
    status: t.status,
    error: t.error,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    ms: (t.endedAt || Date.now()) - t.startedAt,
    provider: t.provider,
    model: t.model,
    tokens: t.tokens,
    attempts: t.attempts,
    tools: t.tools,
    events: t.events.length,
  };
}

/** Process-wide hub. */
export const traceHub = new TraceHub();

export const traceStep = (type, data) => traceHub.step(type, data);
export const withTrace = (opts, fn) => traceHub.withTrace(opts, fn);
export const currentTrace = () => traceHub.current();
