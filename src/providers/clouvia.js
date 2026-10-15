/**
 * Clouvia Router provider — OpenAI-compatible gateway (https://router.clouvia.id/v1).
 *
 * The account holds PAID balance next to free tokens, and the gateway lists 100+
 * models (some expensive). So, like the OpenAgentic provider, this one is
 * cost-safe by default: only models in CLOUVIA_MODELS may be used, and the
 * default list contains the free "deepseek-v4.1-flash" only. Failover and the
 * model picker therefore can never spend paid tokens by accident. Add a model on
 * purpose with CLOUVIA_MODELS="deepseek-v4.1-flash,claude-sonnet-5-thinking-agentic".
 *
 * @author Wisnu Alfian Nur Ashar
 */

import axios from './http-client.js';
import TogetherProvider from './together.js';

const FREE_DEFAULT = ['deepseek-v4.1-flash'];

export default class ClouviaProvider extends TogetherProvider {
  constructor() {
    super();
    this.name = 'Clouvia';
    this.apiKey = String(process.env.CLOUVIA_API_KEY || '').replace(/[^\x21-\x7e]/g, '');
    this.baseUrl = (process.env.CLOUVIA_BASE_URL || 'https://router.clouvia.id/v1').replace(/\/+$/, '');
    this.maxTokens = parseInt(process.env.CLOUVIA_MAX_TOKENS || '8192', 10);
    this.maxContextTokens = parseInt(process.env.CLOUVIA_MAX_CONTEXT_TOKENS || '128000', 10);
    this.timeout = 120_000;
    this.supportsStreamingToolCalls = true;

    const configured = String(process.env.CLOUVIA_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
    this.allowedModels = configured.length ? configured : FREE_DEFAULT;
    this.defaultModel = this.allowedModels.includes(process.env.CLOUVIA_DEFAULT_MODEL)
      ? process.env.CLOUVIA_DEFAULT_MODEL
      : this.allowedModels[0];

    /** Full gateway catalog (informational), filled by refreshModels(). */
    this.catalog = [];
  }

  isAvailable() {
    return this.isConfigured();
  }

  /** Never send a model the operator did not allow (cost safety). */
  guardModel(model) {
    return model && this.allowedModels.includes(model) ? model : this.defaultModel;
  }

  async chat(messages, options = {}) {
    try {
      const res = await super.chat(messages, { ...options, model: this.guardModel(options.model) });
      return { success: true, ...res };
    } catch (e) {
      throw new Error(String(e.message).replace(/^Together AI API error:/, 'Clouvia API error:'));
    }
  }

  async *chatStream(messages, options = {}) {
    yield* super.chatStream(messages, { ...options, model: this.guardModel(options.model) });
  }

  /** Synchronous on purpose: the failover chain reads this without awaiting. */
  getAvailableModels() {
    return this.allowedModels.map((id, i) => ({
      id,
      name: `${id} (Clouvia)`,
      contextLimit: this.maxContextTokens,
      owned_by: 'clouvia',
      recommended: i === 0,
      description: id === 'deepseek-v4.1-flash' ? 'Gratis di Clouvia (0 biaya)' : 'Diizinkan lewat CLOUVIA_MODELS',
    }));
  }

  /** Pulls the gateway catalog (all models, for information only). */
  async refreshModels() {
    if (!this.isConfigured()) return [];
    const res = await axios.get(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      timeout: 15_000,
    });
    const list = Array.isArray(res.data?.data) ? res.data.data : [];
    this.catalog = list.map((m) => m.id).filter(Boolean);
    return this.catalog;
  }

  async healthCheck() {
    if (!this.isConfigured()) {
      return { healthy: false, provider: 'clouvia', configured: false, error: 'CLOUVIA_API_KEY belum diisi' };
    }
    try {
      const all = await this.refreshModels();
      const missing = this.allowedModels.filter((m) => all.length && !all.includes(m));
      return {
        healthy: true,
        provider: 'clouvia',
        configured: true,
        modelsInCatalog: all.length,
        modelsAllowed: this.allowedModels,
        warning: missing.length ? `Model tidak ada di katalog: ${missing.join(', ')}` : undefined,
      };
    } catch (e) {
      return { healthy: false, provider: 'clouvia', configured: true, error: e.response?.data?.error?.message || e.message };
    }
  }
}
