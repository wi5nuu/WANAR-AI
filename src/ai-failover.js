/**
 * src/ai-failover.js
 *
 * Smart auto-failover untuk Wanar AI.
 *
 * Ketika provider/model gagal — kehabisan token/quota, rate limit, API key
 * invalid, server down, timeout — sistem otomatis pindah ke model lain di
 * provider yang sama, lalu ke provider lain yang masih sehat, tanpa user
 * perlu melakukan apa pun.
 *
 * Cerdas & ringan:
 *   - Klasifikasi penyebab error (quota/rate/token/auth/server/network)
 *   - Rantai fallback lintas-provider yang sadar biaya & kecepatan
 *   - Circuit breaker: provider yang sering gagal "didiamkan" sementara
 *   - Cooldown per provider+model agar tidak menghajar endpoint yang sama
 *   - Riwayat percobaan untuk ditampilkan di UI (event provider_switch)
 *
 * @author Wisnu Alfian Nur Ashar
 */

import fs from 'fs';
import path from 'path';

/** Default location of the cooldown state that survives restarts. */
export const DEFAULT_STATE_PATH = path.join(process.cwd(), 'data', 'failover-state.json');

export const FailReason = {
  QUOTA: 'quota',       // kredit/quota habis — pindah model/provider
  RATE: 'rate',         // rate limit / 429
  TOKEN: 'token',       // context/token melebihi batas
  AUTH: 'auth',         // API key invalid / 401 / 403
  SERVER: 'server',     // 5xx / overloaded
  NETWORK: 'network',   // timeout / koneksi
  EMPTY: 'empty',       // model balas kosong
  UNKNOWN: 'unknown',
};

const PATTERNS = [
  [FailReason.QUOTA, /(quota|kuota|telah habis|sudah habis|kredit habis|saldo|insufficient|credit|balance|billing|payment required|402|exceeded your current quota|out of credits|no credits)/i],
  [FailReason.RATE, /(rate ?limit|too many requests|429|tokens per minute|\btpm\b|requests per minute|\brpm\b|overloaded)/i],
  [FailReason.TOKEN, /(context length|maximum context|context window|max.?tokens|token limit|too long|reduce the length)/i],
  [FailReason.AUTH, /(401|403|unauthorized|invalid api key|invalid_api_key|forbidden|authentication|api key not valid|permission)/i],
  [FailReason.SERVER, /(5\d\d|internal server error|bad gateway|service unavailable|gateway timeout|server error)/i],
  [FailReason.NETWORK, /(econnreset|etimedout|enotfound|econnrefused|socket hang up|network|fetch failed|timeout)/i],
  [FailReason.EMPTY, /(empty response|empty response|returned an empty)/i],
];

export function classifyError(message) {
  const msg = String(message || '');
  for (const [reason, re] of PATTERNS) {
    if (re.test(msg)) return reason;
  }
  return FailReason.UNKNOWN;
}

/** Apakah error ini layak memicu failover? */
export function shouldFailover(message) {
  const r = classifyError(message);
  // Unknown tetap dicoba failover — lebih baik pindah daripada menyerah.
  return r !== null;
}

/** Provider default tier ordering (semakin kecil, semakin diprioritaskan). */
const PROVIDER_TIER = {
  openagentic: 1,
  anthropic: 1,
  openai: 1,
  gemini: 1,
  nvidia: 2,
  groq: 2,
  vector: 3,
  cerebras: 3,
  together: 3,
  clouvia: 2,
  fireworks: 3,
  opencode: 3,
  // OpenRouter punya auto-switch internal ke model `:free` — cadangan andal.
  openrouter: 3,
  azure: 2,
  'azure-openai': 2,
  puter: 4,
};

// Only cooldowns that are expensive to re-discover are persisted. AUTH is
// deliberately excluded: after the operator fixes an API key and restarts, the
// model must be usable immediately.
const PERSIST_REASONS = new Set([FailReason.QUOTA, FailReason.TOKEN]);

const COOLDOWN_MS = {
  [FailReason.QUOTA]: 10 * 60 * 1000,
  [FailReason.AUTH]: 10 * 60 * 1000,
  [FailReason.RATE]: 60 * 1000,
  [FailReason.SERVER]: 45 * 1000,
  [FailReason.NETWORK]: 20 * 1000,
  [FailReason.TOKEN]: 5 * 60 * 1000,
  [FailReason.EMPTY]: 30 * 1000,
  [FailReason.UNKNOWN]: 30 * 1000,
};

export { PROVIDER_TIER };

export class SmartFailover {
  /**
   * @param {object} providers  map nama → instance provider (AIManager.providers)
   * @param {object} config     config global (untuk daftar model per provider)
   */
  constructor(providers, config, options = {}) {
    this.providers = providers || {};
    this.config = config || {};
    this.statePath = options.statePath || null;
    /** @type {Map<string, {until:number, reason:string}>} */
    this._persisted = new Map();
    this._saveTimer = null;
    /** @type {Map<string, number>} key `provider::model` → timestamp bebas */
    this.cooldown = new Map();
    /** @type {Map<string, number>} provider -> timestamp (credential rejected) */
    this.providerDown = new Map();
    /** @type {Map<string, {fails:number, openedAt:number}>} sirkuit per provider */
    this.circuit = new Map();
    /** @type {Map<string, {reason:string, at:number, until:number}>} last failure per provider::model */
    this.lastFailure = new Map();
    /** @type {Map<string, number>} last success per provider::model */
    this.lastSuccess = new Map();
    this.history = [];
    this.maxHistory = 200;
    this.circuitThreshold = 4;      // gagal beruntun sebelum provider "dibuka"
    this.circuitOpenMs = 60 * 1000; // lama provider didiamkan
    this._loadState();
  }

  /** Restores quota/token cooldowns so a restart does not re-probe dead models. */
  _loadState() {
    if (!this.statePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      const now = Date.now();
      for (const [key, v] of Object.entries(raw.cooldown || {})) {
        if (v && v.until > now && PERSIST_REASONS.has(v.reason)) {
          this.cooldown.set(key, v.until);
          this._persisted.set(key, v);
          this.lastFailure.set(key, { reason: v.reason, at: v.until - (COOLDOWN_MS[v.reason] || 0), until: v.until });
        }
      }
    } catch { /* first run or unreadable file: start clean */ }
  }

  _scheduleSave() {
    if (!this.statePath || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        const now = Date.now();
        const cooldown = {};
        for (const [k, v] of this._persisted) {
          if (v.until > now) cooldown[k] = v;
          else this._persisted.delete(k);
        }
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        const tmp = `${this.statePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ savedAt: now, cooldown }, null, 2));
        fs.renameSync(tmp, this.statePath);
      } catch { /* persistence is best-effort */ }
    }, 500);
    this._saveTimer.unref?.();
  }

  _key(provider, model) { return `${provider}::${model || ''}`; }

  /**
   * Is the whole provider known-bad right now? A rejected credential fails for
   * every model of that provider, so there is no point trying the other 30.
   */
  isProviderDown(provider) {
    const until = this.providerDown.get(provider);
    return Boolean(until && until > Date.now());
  }

  /**
   * Re-evaluated for EVERY candidate while a request walks the chain (the chain
   * itself is built once, before anything has failed).
   */
  shouldSkip(provider, model) {
    return this.isProviderDown(provider) || this.isCircuitOpen(provider) || this.isCoolingDown(provider, model);
  }

  isCoolingDown(provider, model) {
    const until = this.cooldown.get(this._key(provider, model));
    return Boolean(until && until > Date.now());
  }

  /** Provider sedang dikarantina (circuit open)? */
  isCircuitOpen(provider) {
    const c = this.circuit.get(provider);
    if (!c || !c.openedAt) return false;
    if (Date.now() - c.openedAt > this.circuitOpenMs) {
      c.openedAt = 0; c.fails = 0; // setengah-terbuka: coba lagi
      return false;
    }
    return true;
  }

  markFailure(provider, model, reason = FailReason.UNKNOWN) {
    const cd = COOLDOWN_MS[reason] || COOLDOWN_MS[FailReason.UNKNOWN];
    const key = this._key(provider, model);
    this.cooldown.set(key, Date.now() + cd);
    this.lastFailure.set(key, { reason, at: Date.now(), until: Date.now() + cd });
    // A bad/placeholder API key is a property of the provider, not of one model.
    if (reason === FailReason.AUTH) this.providerDown.set(provider, Date.now() + cd);
    if (PERSIST_REASONS.has(reason)) {
      this._persisted.set(key, { until: Date.now() + cd, reason });
      this._scheduleSave();
    }

    const c = this.circuit.get(provider) || { fails: 0, openedAt: 0 };
    c.fails += 1;
    if (c.fails >= this.circuitThreshold) c.openedAt = Date.now();
    this.circuit.set(provider, c);
  }

  markSuccess(provider, model) {
    this.lastSuccess.set(this._key(provider, model), Date.now());
    this.lastFailure.delete(this._key(provider, model));
    this.cooldown.delete(this._key(provider, model));
    this.providerDown.delete(provider);
    if (this._persisted.delete(this._key(provider, model))) this._scheduleSave();
    const c = this.circuit.get(provider);
    if (c) { c.fails = 0; c.openedAt = 0; }
  }

  _modelsFor(provider) {
    const inst = this.providers[provider];
    let models = [];
    try {
      const list = typeof inst?.getAvailableModels === 'function' ? inst.getAvailableModels() : null;
      if (Array.isArray(list)) models = list.map(m => m.id || m);
      else if (list && typeof list.then !== 'function' && Array.isArray(list.models)) models = list.models.map(m => m.id || m);
    } catch { /* noop */ }
    if (models.length === 0) {
      const cfg = this.config[provider];
      if (cfg?.models) models = cfg.models.map(m => m.id);
      if (models.length === 0 && inst?.defaultModel) models = [inst.defaultModel];
    }
    return [...new Set(models.filter(Boolean))];
  }

  _isAvailable(provider) {
    const inst = this.providers[provider];
    if (!inst) return false;
    try {
      if (typeof inst.isAvailable === 'function') return inst.isAvailable();
      if (typeof inst.isConfigured === 'function') return inst.isConfigured();
    } catch { return false; }
    return true;
  }

  /**
   * Bangun rantai kandidat: model utama → model lain di provider sama →
   * provider lain (terurut tier), masing-masing model default-nya.
   * @returns {Array<{provider:string, model:string, reason?:string}>}
   */
  buildChain(primaryProvider, primaryModel) {
    const chain = [];
    const seen = new Set();
    const push = (provider, model, reason) => {
      const k = this._key(provider, model);
      if (seen.has(k)) return;
      seen.add(k);
      chain.push({ provider, model, reason });
    };

    // 1) Kandidat awal. Without an explicit model the provider would use its default one:
    // name it, so it is not tried a second time as "another model".
    // Resolving it here also makes cooldowns land on the real model name, so the
    // next request knows that exact model is out of quota.
    if (this._isAvailable(primaryProvider)) {
      push(primaryProvider, primaryModel || this.providers[primaryProvider]?.defaultModel, 'primary');
    }

    // 2) Model lain di provider yang sama (skip yang cooldown)
    for (const m of this._modelsFor(primaryProvider)) {
      if (m === primaryModel) continue;
      if (this.isCoolingDown(primaryProvider, m)) continue;
      push(primaryProvider, m, 'same-provider');
    }

    // 3) Provider lain, diurutkan tier lalu kesehatan
    const others = Object.keys(this.providers)
      .filter(p => p !== primaryProvider && this._isAvailable(p) && !this.isCircuitOpen(p))
      .sort((a, b) => {
        const ta = PROVIDER_TIER[a] ?? 5;
        const tb = PROVIDER_TIER[b] ?? 5;
        if (ta !== tb) return ta - tb;
        const fa = this.circuit.get(a)?.fails || 0;
        const fb = this.circuit.get(b)?.fails || 0;
        return fa - fb;
      });

    for (const p of others) {
      const models = this._modelsFor(p);
      const inst = this.providers[p];
      const preferred = inst?.defaultModel || models[0];
      if (preferred) push(p, preferred, 'cross-provider');
      for (const m of models) {
        if (this.isCoolingDown(p, m)) continue;
        push(p, m, 'cross-provider');
      }
    }

    return chain;
  }

  /**
   * Why a candidate would be skipped right now (null = usable). Read-only:
   * unlike isCircuitOpen() it never half-opens a circuit as a side effect.
   */
  skipReason(provider, model) {
    const now = Date.now();
    const down = this.providerDown.get(provider);
    if (down && down > now) return { why: 'auth', until: down };
    const c = this.circuit.get(provider);
    if (c?.openedAt && now - c.openedAt <= this.circuitOpenMs) return { why: 'circuit', until: c.openedAt + this.circuitOpenMs };
    const until = this.cooldown.get(this._key(provider, model));
    if (until && until > now) return { why: this.lastFailure.get(this._key(provider, model))?.reason || 'cooldown', until };
    return null;
  }

  /** Health of one provider (and its known models) for dashboards. */
  providerState(provider) {
    const now = Date.now();
    const models = {};
    const prefix = `${provider}::`;
    for (const [k, f] of this.lastFailure) if (k.startsWith(prefix)) models[k.slice(prefix.length)] = { ...(models[k.slice(prefix.length)] || {}), lastFailure: f, coolingDown: f.until > now };
    for (const [k, at] of this.lastSuccess) if (k.startsWith(prefix)) models[k.slice(prefix.length)] = { ...(models[k.slice(prefix.length)] || {}), lastSuccess: at };
    const c = this.circuit.get(provider);
    const down = this.providerDown.get(provider);
    return {
      tier: PROVIDER_TIER[provider] ?? 5,
      down: Boolean(down && down > now),
      downUntil: down && down > now ? down : null,
      circuitOpen: Boolean(c?.openedAt && now - c.openedAt <= this.circuitOpenMs),
      consecutiveFails: c?.fails || 0,
      models,
    };
  }

  record(entry) {
    this.history.push({ ...entry, at: Date.now() });
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  stats() {
    return {
      coolingDown: [...this.cooldown.entries()]
        .filter(([, t]) => t > Date.now())
        .map(([k, t]) => ({ key: k, secondsLeft: Math.round((t - Date.now()) / 1000) })),
      circuit: [...this.circuit.entries()].map(([p, c]) => ({ provider: p, fails: c.fails, open: this.isCircuitOpen(p) })),
      recent: this.history.slice(-10),
    };
  }
}

export default SmartFailover;