import https from 'https';
import config from '../../config/config.js';

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  keepAliveMsecs: 30000,
  timeout: 60000,
});

class TokenBucket {
  constructor(capacity, refillIntervalMs) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillIntervalMs = refillIntervalMs;
    this.lastRefill = Date.now();
  }

  tryConsume(count = 1) {
    this._refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refillTokens = Math.floor(elapsed / this.refillIntervalMs);
    if (refillTokens > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + refillTokens);
      this.lastRefill = now;
    }
  }
}

class KeyManager {
  constructor(keys) {
    this.keys = keys.map(key => ({
      key,
      bucket: new TokenBucket(50, 60000),
      consecutiveErrors: 0,
      isAvailable: true,
      cooldownUntil: 0,
    }));
    this.currentIndex = 0;
    this.cooldownPeriodMs = 30000;
    this.maxConsecutiveErrors = 3;
  }

  getAvailableKey() {
    const now = Date.now();
    for (let attempt = 0; attempt < this.keys.length; attempt++) {
      const idx = (this.currentIndex + attempt) % this.keys.length;
      const entry = this.keys[idx];

      if (!entry.isAvailable) {
        if (now >= entry.cooldownUntil) {
          entry.isAvailable = true;
          entry.consecutiveErrors = 0;
        } else {
          continue;
        }
      }

      if (entry.bucket.tryConsume()) {
        this.currentIndex = (idx + 1) % this.keys.length;
        return entry;
      }
    }

    const allCooledDown = this.keys
      .filter(k => now >= k.cooldownUntil)
      .sort((a, b) => b.bucket.tokens - a.bucket.tokens);

    if (allCooledDown.length > 0) {
      const best = allCooledDown[0];
      if (best.bucket.tryConsume()) return best;
    }

    return null;
  }

  markSuccess(keyObj) {
    keyObj.consecutiveErrors = 0;
  }

  markError(keyObj) {
    keyObj.consecutiveErrors++;
    if (keyObj.consecutiveErrors >= this.maxConsecutiveErrors) {
      keyObj.isAvailable = false;
      keyObj.cooldownUntil = Date.now() + this.cooldownPeriodMs;
    }
  }

  getKeyCount() {
    return this.keys.length;
  }

  getStatus() {
    return this.keys.map(k => ({
      available: k.isAvailable,
      errors: k.consecutiveErrors,
      tokens: k.bucket.tokens,
      cooldown: k.cooldownUntil > Date.now() ? Math.ceil((k.cooldownUntil - Date.now()) / 1000) : 0,
    }));
  }
}

export class NVIDIAProvider {
  constructor() {
    this.baseUrl = config.nvidia.baseUrl;
    this.name = 'nvidia';
    this.apiKey = config.nvidia.apiKey;

    const rawKeys = config.nvidia.apiKeys || (config.nvidia.apiKey ? [config.nvidia.apiKey] : []);
    if (rawKeys.length === 0) {
      throw new Error('NVIDIA_API_KEY atau NVIDIA_KEYS tidak dikonfigurasi');
    }
    this.keyManager = new KeyManager(rawKeys);
    this.maxRetries = 3;
    this.retryDelayMs = 1000;
  }

  async _fetchWithRetry(url, options, retriesLeft = this.maxRetries) {
    const keyEntry = this.keyManager.getAvailableKey();
    if (!keyEntry) {
      const waitTime = this._estimateWaitTime();
      if (waitTime > 0) {
        await new Promise(r => setTimeout(r, Math.min(waitTime, 10000)));
      }
      const retryEntry = this.keyManager.getAvailableKey();
      if (!retryEntry) {
        throw new Error('Semua API key NVIDIA kehabisan kuota. Coba lagi nanti.');
      }
      return this._fetchWithRetry(url, options, retriesLeft);
    }

    const headers = {
      'Authorization': `Bearer ${keyEntry.key}`,
      'Content-Type': 'application/json',
    };

    const fetchOptions = {
      method: 'POST',
      headers: { ...headers, ...options.headers },
      body: options.body,
      signal: options.signal,
      agent,
    };

    try {
      const response = await fetch(url, fetchOptions);

      if (response.status === 429) {
        this.keyManager.markError(keyEntry);
        if (retriesLeft > 0) {
          const delay = this.retryDelayMs * (this.maxRetries - retriesLeft + 1);
          await new Promise(r => setTimeout(r, delay));
          return this._fetchWithRetry(url, options, retriesLeft - 1);
        }
        const retryAfter = response.headers.get('Retry-After');
        const waitSec = retryAfter ? parseInt(retryAfter) : 30;
        throw new Error(`Rate limit tercapai. Coba lagi setelah ${waitSec} detik.`);
      }

      if (!response.ok && response.status >= 500) {
        this.keyManager.markError(keyEntry);
        if (retriesLeft > 0) {
          const delay = this.retryDelayMs * (this.maxRetries - retriesLeft + 1);
          await new Promise(r => setTimeout(r, delay));
          return this._fetchWithRetry(url, options, retriesLeft - 1);
        }
      }

      this.keyManager.markSuccess(keyEntry);
      return response;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Request timeout setelah 60 detik');
      }
      this.keyManager.markError(keyEntry);
      if (retriesLeft > 0 && !error.message.includes('Rate limit')) {
        const delay = this.retryDelayMs * (this.maxRetries - retriesLeft + 1);
        await new Promise(r => setTimeout(r, delay));
        return this._fetchWithRetry(url, options, retriesLeft - 1);
      }
      throw error;
    }
  }

  _estimateWaitTime() {
    const now = Date.now();
    const waitTimes = this.keyManager.keys
      .filter(k => k.cooldownUntil > now)
      .map(k => k.cooldownUntil - now);
    return waitTimes.length === this.keyManager.keys.length
      ? Math.min(...waitTimes)
      : 1000;
  }

  async chat(messages, options = {}) {
    const model = options.model || config.nvidia.defaultModel;
    const maxTokens = options.maxTokens || config.nvidia.maxTokens;
    const tools = options.tools;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const body = {
        model,
        messages,
        temperature: options.temperature ?? 1,
        top_p: options.top_p ?? 1,
        max_tokens: maxTokens,
        stream: false,
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
      };
      if (tools && tools.length > 0) body.tools = tools;

      const response = await this._fetchWithRetry(
        `${this.baseUrl}/chat/completions`,
        { headers: {}, body: JSON.stringify(body), signal: controller.signal }
      );

      clearTimeout(timeout);

      const data = await response.json();

      if (data.choices && data.choices.length > 0) {
        const message = data.choices[0].message;
        return {
          success: true,
          content: message.content || '',
          tool_calls: message.tool_calls || [],
          finish_reason: data.choices[0].finish_reason || 'stop',
          model: data.model || model,
          usage: data.usage || { total_tokens: 0 },
          provider: 'nvidia',
        };
      }

      return { success: false, error: data.error?.message || 'Invalid response', provider: 'nvidia' };
    } catch (error) {
      clearTimeout(timeout);
      return { success: false, error: error.message, provider: 'nvidia' };
    }
  }

  async *chatStream(messages, options = {}) {
    const model = options.model || config.nvidia.defaultModel;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      const response = await this._fetchWithRetry(
        `${this.baseUrl}/chat/completions`,
        {
          headers: {},
          body: JSON.stringify({
            model,
            messages,
            temperature: options.temperature ?? 1,
            top_p: options.top_p ?? 1,
            max_tokens: options.maxTokens || config.nvidia.maxTokens,
            stream: true,
            ...(options.seed !== undefined ? { seed: options.seed } : {}),
          }),
          signal: controller.signal,
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        yield { type: 'error', content: err.error?.message || `HTTP ${response.status}` };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') { yield { type: 'done' }; return; }
          if (trimmed.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              const content = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.text || '';
              if (content) yield { type: 'content', content };
              if (parsed.choices?.[0]?.finish_reason === 'stop') yield { type: 'done' };
            } catch { }
          }
        }
      }
      yield { type: 'done' };
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        yield { type: 'error', content: 'Request timeout setelah 120 detik' };
      } else {
        yield { type: 'error', content: error.message };
      }
    }
  }

  getAvailableModels() {
    return config.nvidia.models;
  }

  getDefaultModel() {
    return config.nvidia.defaultModel;
  }

  isAvailable() {
    return this.apiKey || (config.nvidia.apiKeys && config.nvidia.apiKeys.length > 0);
  }

  getKeyCount() {
    return this.keyManager.getKeyCount();
  }

  getKeyStatus() {
    return this.keyManager.getStatus();
  }
}

export default NVIDIAProvider;
