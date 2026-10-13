/**
 * OpenRouter Provider — satu API, ratusan model (termasuk varian `:free`).
 *
 * FITUR UTAMA: AUTO-SWITCH MODEL GRATIS
 * --------------------------------------
 * Bila request ke model pilihan gagal karena rate-limit (429), kuota (402),
 * model tidak tersedia (404/400), atau error server (5xx), provider ini
 * otomatis mengulang request ke model GRATIS OpenRouter berikutnya:
 *
 *   1. varian `:free` dari model yang sama (mis. `deepseek/deepseek-chat-v3-0324`
 *      → `google/gemma-4-31b-it:free`)
 *   2. daftar `config.openrouter.freeModels` (bisa dioverride via env
 *      OPENROUTER_FREE_MODELS)
 *   3. daftar gratis hasil query API OpenRouter (di-cache 6 jam di
 *      data/openrouter-free-models.json) sehingga selalu valid walau
 *      katalog model berubah
 *
 * Hasil berisi `auto_switch: { from, to, reason }` agar UI/CLI bisa
 * menampilkan bahwa pergantian terjadi.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from './http-client.js';
import BaseProvider from './base-provider.js';
import config from '../../config/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FREE_CACHE_PATH = path.join(__dirname, '..', '..', 'data', 'openrouter-free-models.json');
const FREE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 jam

const MAX_FREE_ATTEMPTS = 3;   // maksimum pergantian model gratis per request
const RETRYABLE_STATUS = new Set([402, 408, 429, 500, 502, 503, 504, 529]);

export class OpenRouterProvider extends BaseProvider {
  constructor() {
    super({
      name: 'OpenRouter',
      apiKey: config.openrouter?.apiKey || process.env.OPENROUTER_API_KEY,
      baseUrl: config.openrouter?.baseUrl || 'https://openrouter.ai/api/v1',
      defaultModel: config.openrouter?.defaultModel || 'nvidia/nemotron-3-super-120b-a12b:free',
      maxTokens: config.openrouter?.maxTokens || 8192,
      maxContextTokens: config.openrouter?.maxContextTokens || 131072,
      timeout: 45000,
    });

    this.capabilities = {
      streaming: true,
      toolCalling: true,
      largeContext: true,
      vision: true,
      functionCalling: true,
      multiTurn: true,
      jsonMode: true,
      freeTier: true,
      autoSwitchFree: config.openrouter?.autoSwitchFree !== false,
    };

    this._freeCache = { at: 0, models: null };
  }

  // ── Util ────────────────────────────────────────────────────────────────

  _headers() {
    const h = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    // Dianjurkan OpenRouter agar model gratis tidak disalahartikan sebagai bot.
    if (config.openrouter?.referer) h['HTTP-Referer'] = config.openrouter.referer;
    if (config.openrouter?.title) h['X-Title'] = config.openrouter.title;
    return h;
  }

  /** Daftar model gratis statis dari konfigurasi/env. */
  _configFreeModels() {
    const list = config.openrouter?.freeModels || [];
    return Array.isArray(list) ? list.filter(Boolean) : [];
  }

  /**
   * Daftar gratis dari katalog live OpenRouter (di-cache 6 jam).
   * Hanya dipanggil saat kandidat konfigurasi sudah habis — katalog model
   * berubah cepat, jadi ini penyelamat terakhir sebelum menyerah.
   */
  async _liveFreeModels() {
    const now = Date.now();
    if (this._freeCache.models && now - this._freeCache.at < FREE_CACHE_TTL_MS) {
      return this._freeCache.models;
    }
    try {
      if (fs.existsSync(FREE_CACHE_PATH)) {
        const raw = JSON.parse(fs.readFileSync(FREE_CACHE_PATH, 'utf8'));
        if (raw?.at && now - raw.at < FREE_CACHE_TTL_MS) {
          this._freeCache = { at: raw.at, models: raw.models || [] };
          return this._freeCache.models;
        }
      }
    } catch { /* cache rusak → abaikan */ }

    try {
      const res = await axios.get(`${this.baseUrl}/models`, { timeout: 6000, headers: this._headers() });
      const free = (res.data?.data || [])
        .filter((m) => typeof m.id === 'string' && (
          m.id.endsWith(':free') || m.pricing?.prompt === '0' || m.pricing?.prompt === 0
        ))
        .map((m) => m.id);
      if (free.length > 0) {
        this._freeCache = { at: now, models: free };
        try {
          fs.mkdirSync(path.dirname(FREE_CACHE_PATH), { recursive: true });
          fs.writeFileSync(FREE_CACHE_PATH, JSON.stringify({ at: now, models: free.slice(0, 300) }));
        } catch { /* cache write gagal → bukan fatal */ }
        return free;
      }
    } catch { /* offline/gagal → lewat */ }
    return [];
  }

  /**
   * Kuota harian free-tier (`free-models-per-day`) bersifat AKUN, bukan per-model.
   * Pindah model tidak menolong — buang-buang percobaan & jatah rate-limit.
   */
  _isDailyQuota(error) {
    const msg = String(error?.response?.data?.error?.message || error?.message || '');
    return /free-models-per-day/i.test(msg);
  }

  /** Pesan ramah untuk kuota harian habis, lengkap dengan waktu reset WIB. */
  _dailyQuotaMessage(error) {
    const err = error?.response?.data?.error || {};
    const headers = err?.metadata?.headers || {};
    const limit = headers['X-RateLimit-Limit'] || '50';
    const resetMs = Number(headers['X-RateLimit-Reset']);
    let when = '';
    if (Number.isFinite(resetMs) && resetMs > 0) {
      when = new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      }).format(new Date(resetMs));
    }
    return [
      `Kuota harian model gratis OpenRouter habis (${limit} request/hari).`,
      when ? `Reset ${when} WIB.` : 'Coba lagi setelah pergantian hari.',
      'Alternatif: tambah kredit $10 di openrouter.ai (1000 request/hari) atau pilih provider lain.',
    ].join(' ');
  }

  /** Klasifikasi error: layak auto-switch ke model gratis? */
  _shouldSwitch(error) {
    if (this.capabilities.autoSwitchFree === false) return false;
    if (this._isDailyQuota(error)) return false; // limit akun → model lain pasti ikut kena
    const status = error?.response?.status;
    const msg = String(error?.response?.data?.error?.message || error?.message || '');
    if (RETRYABLE_STATUS.has(status)) return true;
    if (/(rate ?limit|too many requests|quota|kuota|insufficient credit|402|429)/i.test(msg)) return true;
    if (/(model not found|no endpoints found|model.*not available|invalid model|decommissioned|unavailable for free|deprecated|migrating to)/i.test(msg)) return true;
    if (status === 404 || status === 400) return /(model|endpoint)/i.test(msg);
    return false;
  }

  /** Ambil kandidat pertama yang belum dicoba dari sebuah daftar. */
  _firstUntried(list, currentModel, tried) {
    const ordered = [];
    // Varian `:free` dari model yang sama didahulukan bila memang ada di daftar.
    const variant = currentModel && !currentModel.endsWith(':free') ? `${currentModel}:free` : null;
    if (variant && list.includes(variant)) ordered.push(variant);
    ordered.push(...list);
    for (const m of ordered) {
      if (m && m !== currentModel && !tried.has(m)) return m;
    }
    return null;
  }

  /** Pilih kandidat model gratis berikutnya yang belum dicoba. */
  async _pickFree(currentModel, tried) {
    if (!this.capabilities.autoSwitchFree) return null;

    // 1) Daftar konfigurasi (cepat, tanpa jaringan)
    const fromConfig = this._configFreeModels();
    const next = this._firstUntried(fromConfig, currentModel, tried);
    if (next) return next;

    // 2) Kandidat konfigurasi habis → katalog live (fresh, di-cache 6 jam)
    const live = await this._liveFreeModels();
    return this._firstUntried(live, currentModel, tried);
  }

  /** POST chat/completions dengan auto-switch. Return { data, autoSwitch, error }. */
  async _post(body, tried) {
    const originalModel = body.model;
    let model = body.model;
    let reason = null;

    for (let attempt = 0; ; attempt++) {
      tried.add(model);
      try {
        const res = await axios.post(`${this.baseUrl}/chat/completions`, body, {
          headers: this._headers(),
          timeout: this.timeout,
          ...(body.stream ? { responseType: 'stream' } : {}),
        });
        return {
          data: res.data,
          autoSwitch: reason ? { from: originalModel, to: model, reason } : null,
        };
      } catch (error) {
        const canSwitch = attempt < MAX_FREE_ATTEMPTS && this._shouldSwitch(error);
        const next = canSwitch ? await this._pickFree(model, tried) : null;
        if (!next) {
          return {
            data: null,
            autoSwitch: reason ? { from: originalModel, to: model, reason } : null,
            error,
          };
        }
        reason = error?.response?.data?.error?.message || error?.message || 'unknown error';
        console.warn(
          `[OPENROUTER] auto-switch ${model} → ${next} (${String(reason).slice(0, 120)})`
        );
        model = next;
        body = { ...body, model: next };
      }
    }
  }

  // ── API wajib BaseProvider ──────────────────────────────────────────────

  async chat(messages, options = {}) {
    const startTime = Date.now();

    if (!this.isConfigured()) {
      return { success: false, error: 'OpenRouter not configured. Set OPENROUTER_API_KEY in .env' };
    }

    try {
      this.validateMessages(messages);

      const maxTokens = options.maxTokens || this.maxTokens;
      const { messages: truncatedMessages } = this.truncateMessages(
        messages,
        this.maxContextTokens - maxTokens
      );

      const body = {
        model: options.model || this.defaultModel,
        messages: truncatedMessages,
        max_tokens: maxTokens,
        temperature: options.temperature ?? 0.7,
      };
      if (options.tools && options.tools.length > 0) {
        body.tools = this.convertToolsFormat(options.tools);
        body.tool_choice = options.tool_choice || 'auto';
      }
      if (options.response_format === 'json') {
        body.response_format = { type: 'json_object' };
      }

      const tried = new Set();
      const { data, autoSwitch, error } = await this._post(body, tried);
      const latency = Date.now() - startTime;

      if (!data) {
        this.updateStats(false, 0, latency);
        const daily = this._isDailyQuota(error);
        return {
          success: false,
          error: daily
            ? this._dailyQuotaMessage(error)
            : (error?.response?.data?.error?.message || error?.message || 'OpenRouter request failed'),
          code: error?.response?.status || 'UNKNOWN',
          ...(daily ? { daily_quota: true } : {}),
          auto_switch: autoSwitch,
        };
      }

      const usage = data.usage || {};
      const choice = data.choices?.[0];
      // Model penalar (reasoning) terkadang mengisi `reasoning` lebih dulu;
      // bila `content` kosong tapi reasoning ada, pakai itu agar jawaban
      // tidak pernah kosong.
      let content = choice?.message?.content || '';
      if (!content && typeof choice?.message?.reasoning === 'string' && choice.message.reasoning.trim()) {
        content = choice.message.reasoning.trim();
      }

      const hasToolCalls = Boolean(choice?.message?.tool_calls?.length);
      if (!content && !hasToolCalls) {
        this.updateStats(false, 0, latency);
        return {
          success: false,
          error: `Empty response from OpenRouter (${choice?.finish_reason || 'no finish_reason'})`,
          code: 'EMPTY',
          model: data.model,
          auto_switch: autoSwitch,
        };
      }

      this.updateStats(true, usage.total_tokens || 0, latency);

      const result = {
        success: true,
        content,
        finish_reason: choice?.finish_reason,
        model: data.model,
        usage: {
          prompt_tokens: usage.prompt_tokens || 0,
          completion_tokens: usage.completion_tokens || 0,
          total_tokens: usage.total_tokens || 0,
        },
        latency,
      };
      if (autoSwitch) result.auto_switch = autoSwitch;
      if (choice?.message?.tool_calls) {
        result.tool_calls = choice.message.tool_calls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));
      }
      return result;
    } catch (error) {
      this.updateStats(false, 0, Date.now() - startTime);
      const daily = this._isDailyQuota(error);
      return {
        success: false,
        error: daily
          ? this._dailyQuotaMessage(error)
          : (error?.response?.data?.error?.message || error?.message),
        code: error?.response?.status || 'UNKNOWN',
        ...(daily ? { daily_quota: true } : {}),
      };
    }
  }

  async *chatStream(messages, options = {}) {
    if (!this.isConfigured()) {
      yield { type: 'error', content: 'OpenRouter not configured. Set OPENROUTER_API_KEY in .env' };
      return;
    }

    try {
      this.validateMessages(messages);

      const maxTokens = options.maxTokens || this.maxTokens;
      const { messages: truncatedMessages } = this.truncateMessages(
        messages,
        this.maxContextTokens - maxTokens
      );

      let body = {
        model: options.model || this.defaultModel,
        messages: truncatedMessages,
        max_tokens: maxTokens,
        temperature: options.temperature ?? 0.7,
        stream: true,
      };
      if (options.tools && options.tools.length > 0) {
        body.tools = this.convertToolsFormat(options.tools);
        body.tool_choice = options.tool_choice || 'auto';
      }

      const tried = new Set();
      const { data, autoSwitch, error } = await this._post(body, tried);

      if (!data) {
        yield {
          type: 'error',
          content: this._isDailyQuota(error)
            ? this._dailyQuotaMessage(error)
            : (error?.response?.data?.error?.message || error?.message || 'OpenRouter stream failed'),
        };
        return;
      }

      if (autoSwitch) {
        yield { type: 'provider_switch', provider: 'openrouter', model: autoSwitch.to, auto_switch: autoSwitch };
      }

      let buffer = '';
      const toolCalls = [];
      let contentEmitted = false;
      let reasoningBuf = '';

      for await (const chunk of data) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || line.trim() === 'data: [DONE]') continue;
          if (!line.startsWith('data: ')) continue;

          try {
            const payload = JSON.parse(line.slice(6));
            if (payload.error) {
              yield { type: 'error', content: payload.error.message || 'OpenRouter stream error' };
              return;
            }
            const delta = payload.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.content) { contentEmitted = true; yield { type: 'content', content: delta.content }; }
            // Model penalar mengirim `reasoning` terpisah — kumpulkan sebagai
            // cadangan bila tidak pernah ada konten jawaban.
            if (delta.reasoning && !contentEmitted) reasoningBuf += delta.reasoning;

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
                }
                if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
              }
            }

            if (payload.choices?.[0]?.finish_reason) {
              if (toolCalls.length > 0) yield { type: 'tool_calls', tool_calls: toolCalls };
              if (!contentEmitted && !toolCalls.length && reasoningBuf.trim()) {
                contentEmitted = true;
                yield { type: 'content', content: reasoningBuf.trim() };
              }
              yield { type: 'done', finish_reason: payload.choices[0].finish_reason };
            }
          } catch { /* lewati baris rusak */ }
        }
      }

      if (!contentEmitted && !toolCalls.length && reasoningBuf.trim()) {
        yield { type: 'content', content: reasoningBuf.trim() };
      }
      yield { type: 'done' };
    } catch (error) {
      yield { type: 'error', content: error?.response?.data?.error?.message || error?.message };
    }
  }

  convertToolsFormat(tools) {
    return tools.map((tool) => {
      const fn = tool.function || tool;
      return {
        type: 'function',
        function: {
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters || { type: 'object', properties: {} },
        },
      };
    });
  }

  /** Disengaja sinkron agar bisa dipakai oleh getProviderInfo() tanpa await. */
  getAvailableModels() {
    return config.openrouter?.models || [
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B (Free)', family: 'NVIDIA', rec: true, tags: ['FREE', 'Fast', 'Auto-Switch'] },
      { id: 'openrouter/free', label: 'Auto Free Router', family: 'OpenRouter', rec: true, tags: ['FREE', 'Always Available'] },
      { id: 'cohere/north-mini-code:free', label: 'North Mini Code (Free)', family: 'Cohere', tags: ['FREE', 'Coding'] },
      { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B (Free)', family: 'Google', tags: ['FREE', 'Auto-Switch'] },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (Free)', family: 'Meta', rec: true, tags: ['FREE', 'Powerful'] },
      { id: 'qwen/qwen3-235b-a22b:free', label: 'Qwen3 235B (Free)', family: 'Alibaba', rec: true, tags: ['FREE', 'Reasoning'] },
      { id: 'google/gemma-3-27b-it:free', label: 'Gemma 3 27B (Free)', family: 'Google', tags: ['FREE', 'Fast'] },
    ];
  }

  getDefaultModel() {
    return this.defaultModel;
  }

  isAvailable() {
    return this.isConfigured();
  }
}

export default OpenRouterProvider;
