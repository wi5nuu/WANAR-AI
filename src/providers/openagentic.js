/**
 * OpenAgentic Provider - Multi-model support with streaming & tool calling
 * Enterprise-grade provider with advanced features
 *
 * @author Wisnu Alfian Nur Ashar
 * @version 3.0.0
 */

import axios from './http-client.js';
import config from '../../config/config.js';

export default class OpenAgenticProvider {
  constructor() {
    this.name = 'OpenAgentic';
    this.baseURL = process.env.OPENAGENTIC_BASE_URL || 'https://openagentic.id/api/v1';
    this.apiKey = process.env.OPENAGENTIC_API_KEY || '';
    this.defaultModel = this.normalizeModel(process.env.OPENAGENTIC_DEFAULT_MODEL || 'deepseek-v4.1-flash-free');
    this.maxTokens = parseInt(process.env.OPENAGENTIC_MAX_TOKENS || '16000', 10);
    this.timeout = 300000; // 5 minutes
    this.retryAttempts = 3;
    this.retryDelay = 1000;
    // chatStream accumulates tool-call deltas into complete 'tool_calls' events,
    // enabling real streaming in AIManager.chatWithTools
    this.supportsStreamingToolCalls = true;

    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalTokens: 0,
      avgLatency: 0,
      lastRequestTime: null,
    };

    if (!this.apiKey) {
      console.warn('OpenAgentic API key not configured. Set OPENAGENTIC_API_KEY in .env');
    }
  }

  isConfigured() {
    return Boolean(this.apiKey && this.baseURL);
  }

  isAvailable() {
    return this.isConfigured();
  }

  /**
   * Paksa kebijakan blokir model: model yang ada di config.openagentic.blockedModels
   * otomatis dipetakan ke varian "-free" bila tersedia (contoh: deepseek-v4.1-flash
   * -> deepseek-v4.1-flash-free). Sistem tidak boleh menyentuh tier paid-nya.
   */
  normalizeModel(model) {
    const blocked = config.openagentic?.blockedModels || [];
    if (!model || !blocked.includes(model)) return model;
    const freeVariant = `${model}-free`;
    const exists = (config.openagentic?.models || []).some(m => m.id === freeVariant);
    if (exists) {
      if (!this._warnedBlocked) this._warnedBlocked = new Set();
      if (!this._warnedBlocked.has(model)) {
        this._warnedBlocked.add(model);
        console.warn(`[OpenAgentic] Model "${model}" diblokir — otomatis dialihkan ke "${freeVariant}".`);
      }
      return freeVariant;
    }
    return model;
  }

  /** Saring daftar model dari daftar blokir */
  filterBlocked(models) {
    const blocked = config.openagentic?.blockedModels || [];
    return models.filter(m => !blocked.includes(m.id));
  }

  /** max_tokens per model dari config.openagentic.maxTokensByModel; fallback ke global maxTokens */
  resolveMaxTokens(model) {
    const byModel = config.openagentic?.maxTokensByModel;
    if (byModel && byModel[model] !== undefined) return byModel[model];
    return this.maxTokens;
  }

  /** Return static model list from config */
  getAvailableModels() {
    return this.filterBlocked((config.openagentic?.models || []).map(m => ({
      id: m.id,
      label: m.label || m.id,
      family: m.family || 'Unknown',
      rec: m.rec || false,
      tags: m.tags || [],
    })));
  }

  /** Fetch live model list from API (optional enrichment) */
  async fetchLiveModels() {
    if (!this.isConfigured()) return [];
    try {
      const response = await axios.get(`${this.baseURL}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      if (response.data?.data) {
        return this.filterBlocked(response.data.data.map(m => ({
          id: m.id,
          name: m.name || m.id,
          contextLimit: m.context_limit || 200000,
          owned_by: m.owned_by || 'openagentic',
        })));
      }
      return [];
    } catch (error) {
      console.warn('OpenAgentic: Failed to fetch live models:', error.message);
      return [];
    }
  }

  /**
   * Format messages - handle system messages and tool results.
   *
   * System messages are PRESERVED in the array (standard [OI]-style format).
   * Previously they were filtered out and only sent via the top-level `system`
   * field, which some gateways ignore — causing the model to lose its identity
   * instructions and answer as its upstream persona.
   */
  formatMessages(messages) {
    return messages.map(msg => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.tool_call_id,
          content: msg.content,
        };
      }
      if (msg.tool_calls) {
        return {
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.tool_calls,
        };
      }
      return { role: msg.role, content: msg.content };
    });
  }

  /**
   * Extract system prompt from messages
   */
  extractSystem(messages) {
    const sys = messages.find(m => m.role === 'system');
    return sys ? sys.content : null;
  }

  /**
   * Main chat method - supports tools and streaming
   */
  async chat(messages, options = {}) {
    if (!this.isConfigured()) {
      return {
        success: false,
        error: 'OpenAgentic provider not configured. Set OPENAGENTIC_API_KEY in .env',
        provider: 'openagentic',
      };
    }

    const model = this.normalizeModel(options.model || this.defaultModel);
    const maxTokens = options.maxTokens || this.resolveMaxTokens(model);
    const temperature = options.temperature !== undefined ? options.temperature : 0.7;
    const startTime = Date.now();

    this.stats.totalRequests++;
    this.stats.lastRequestTime = new Date().toISOString();

    const systemPrompt = options.systemPrompt || this.extractSystem(messages);
    const formattedMessages = this.formatMessages(messages);

    const payload = {
      model,
      messages: formattedMessages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    };

    // Only use the top-level field if the array has no system message, to avoid
    // sending the (large) system prompt twice.
    if (systemPrompt && !formattedMessages.some(m => m.role === 'system')) payload.system = systemPrompt;
    if (options.top_p !== undefined) payload.top_p = options.top_p;
    if (options.stop) payload.stop = options.stop;

    // Attach tools if provided
    if (options.tools && options.tools.length > 0) {
      payload.tools = options.tools;
      payload.tool_choice = options.tool_choice || 'auto';
    }

    let attempt = 0;
    let lastError = null;

    while (attempt < this.retryAttempts) {
      try {
        const response = await axios.post(
          `${this.baseURL}/chat/completions`,
          payload,
          {
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: this.timeout,
          }
        );

        const latency = Date.now() - startTime;
        const data = response.data;

        if (data?.choices?.length > 0) {
          const choice = data.choices[0];
          const message = choice.message || {};
          const content = message.content || '';
          const toolCalls = message.tool_calls || null;
          const usage = data.usage || {};

          this.stats.successfulRequests++;
          this.stats.totalTokens += usage.total_tokens || 0;
          this._updateAvgLatency(latency);

          return {
            success: true,
            content,
            tool_calls: toolCalls,
            provider: 'openagentic',
            model,
            usage: {
              prompt_tokens: usage.prompt_tokens || 0,
              completion_tokens: usage.completion_tokens || 0,
              total_tokens: usage.total_tokens || 0,
            },
            latency,
            finishReason: choice.finish_reason,
          };
        }

        throw new Error('Invalid response structure from OpenAgentic API');
      } catch (error) {
        lastError = error;
        attempt++;
        if (attempt < this.retryAttempts && this._shouldRetry(error)) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          console.warn(`OpenAgentic retry ${attempt}/${this.retryAttempts} in ${delay}ms: ${error.message}`);
          await this._sleep(delay);
        } else {
          break;
        }
      }
    }

    this.stats.failedRequests++;
    const errMsg = lastError?.response?.data?.error?.message
      || lastError?.response?.data?.error
      || lastError?.message
      || 'Unknown error';

    return {
      success: false,
      error: errMsg,
      provider: 'openagentic',
    };
  }

  /**
   * Streaming generator - yields { type, content } chunks
   * Used by ai-manager.chatWithTools for SSE streaming
   */
  async *chatStream(messages, options = {}) {
    if (!this.isConfigured()) {
      yield { type: 'error', content: 'OpenAgentic not configured. Set OPENAGENTIC_API_KEY' };
      return;
    }

     const model = this.normalizeModel(options.model || this.defaultModel);
    const maxTokens = options.maxTokens || this.resolveMaxTokens(model);
    const temperature = options.temperature !== undefined ? options.temperature : 0.7;
    const systemPrompt = options.systemPrompt || this.extractSystem(messages);
    const formattedMessages = this.formatMessages(messages);

    const payload = {
      model,
      messages: formattedMessages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
      // ask the gateway for the real token counts (they arrive in the last chunk)
      ...(process.env.AI_STREAM_USAGE === 'false' ? {} : { stream_options: { include_usage: true } }),
    };

    // Only use the top-level field if the array has no system message, to avoid
    // sending the (large) system prompt twice.
    if (systemPrompt && !formattedMessages.some(m => m.role === 'system')) payload.system = systemPrompt;
    if (options.top_p !== undefined) payload.top_p = options.top_p;
    if (options.tools && options.tools.length > 0) {
      payload.tools = options.tools;
      payload.tool_choice = options.tool_choice || 'auto';
    }

    this.stats.totalRequests++;
    this.stats.lastRequestTime = new Date().toISOString();

    try {
      const response = await axios.post(
        `${this.baseURL}/chat/completions`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          responseType: 'stream',
          timeout: this.timeout,
        }
      );

      let buffer = '';
      // OpenAI-style tool-call deltas arrive as fragments across chunks,
      // keyed by index — accumulate until the stream ends, then emit complete calls.
      const pendingToolCalls = new Map();

      const flushToolCalls = function* () {
        if (pendingToolCalls.size > 0) {
          yield { type: 'tool_calls', tool_calls: Array.from(pendingToolCalls.values()) };
        }
      };

      for await (const chunk of response.data) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            this.stats.successfulRequests++;
            yield* flushToolCalls();
            yield { type: 'done' };
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              yield { type: 'content', content: delta.content };
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!pendingToolCalls.has(idx)) {
                  pendingToolCalls.set(idx, {
                    id: tc.id || `call_${idx}`,
                    type: 'function',
                    function: { name: '', arguments: '' },
                  });
                }
                const acc = pendingToolCalls.get(idx);
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.function.name += tc.function.name;
                if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
              }
            }
            if (parsed.usage) {
              this.stats.totalTokens += parsed.usage.total_tokens || 0;
              yield { type: 'usage', usage: parsed.usage };
            }
          } catch { /* skip malformed SSE */ }
        }
      }

      this.stats.successfulRequests++;
      yield* flushToolCalls();
      yield { type: 'done' };
    } catch (error) {
      this.stats.failedRequests++;
      yield { type: 'error', content: error.message };
      yield { type: 'done' };
    }
  }

  _shouldRetry(error) {
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') return true;
    if (error.response?.status >= 500) return true;
    if (error.response?.status === 429) return true;
    return false;
  }

  _updateAvgLatency(latency) {
    const n = this.stats.successfulRequests;
    this.stats.avgLatency = n === 1 ? latency : (this.stats.avgLatency * (n - 1) + latency) / n;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats() {
    return {
      ...this.stats,
      successRate: this.stats.totalRequests > 0
        ? (this.stats.successfulRequests / this.stats.totalRequests * 100).toFixed(2) + '%'
        : '0%',
    };
  }

  async healthCheck() {
    if (!this.isConfigured()) {
      return { healthy: false, provider: 'openagentic', error: 'Not configured', configured: false };
    }
    try {
      const models = await this.fetchLiveModels();
      return {
        healthy: true,
        provider: 'openagentic',
        modelsAvailable: models.length || this.getAvailableModels().length,
        configured: true,
      };
    } catch (error) {
      return { healthy: false, provider: 'openagentic', error: error.message, configured: true };
    }
  }
}
