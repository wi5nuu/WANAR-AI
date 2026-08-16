import crypto from 'crypto';

const MODEL_CONTEXT_LIMITS = {
  'deepseek-ai/deepseek-v4-pro': 131072,
  'deepseek-ai/deepseek-v4-flash': 131072,
  'meta/llama-3.1-405b-instruct': 131072,
  'meta/llama-3.1-70b-instruct': 131072,
  'meta/llama-3.1-8b-instruct': 131072,
  'mistralai/mistral-large': 131072,
  'mistralai/mistral-small': 32768,
  'microsoft/phi-4': 16384,
  'google/gemma-2-27b-it': 8192,
  'google/gemma-2-9b-it': 8192,
  'nvidia/llama-3.1-nemotron-70b-instruct': 131072,
  'z-ai/glm-4.5': 131072,
  'z-ai/glm-5.2': 131072,
  'moonshotai/kimi-k2.6': 131072,
  'claude-sonnet-5': 200000,
  'claude-fable-5': 200000,
  'claude-opus-4.8-fast': 200000,
  'claude-opus-4-7': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-haiku-4-5': 200000,
  'gpt-5.4-nano': 131072,
  'gpt-5.4-mini': 131072,
  'gpt-5.4': 131072,
};

const DEFAULT_CONTEXT_LIMIT = 131072;
const DEFAULT_MAX_TURNS = 20;
const SYSTEM_RESERVE = 2048;
const OUTPUT_RESERVE = 8192;

const CACHE_SIZE = 500;

function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text !== 'string') return 0;
  let tokens = 0;
  let charCount = 0;
  let isCode = false;
  let codeBlockCount = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4E00 && code <= 0x9FFF) {
      tokens += 2;
    } else if (code >= 0x0600 && code <= 0x06FF) {
      tokens += 1.5;
    } else if (code >= 0x0400 && code <= 0x04FF) {
      tokens += 1.5;
    } else {
      charCount++;
    }
  }

  if (text.includes('```') || text.includes('\nfunction') || text.includes('\nconst ') ||
      text.includes('\nlet ') || text.includes('\nvar ') || text.includes('\nclass ') ||
      text.includes('\nimport ') || text.includes('\nexport ') || text.includes('\ninterface ') ||
      text.includes('\ntype ') || text.includes('\ndef ') || text.includes('\nclass ')) {
    isCode = true;
    codeBlockCount = (text.match(/```/g) || []).length;
  }

  const ratio = isCode ? 3.5 : 4.5;
  tokens += Math.ceil(charCount / ratio);

  return Math.ceil(tokens);
}

function truncateContent(content, maxTokens) {
  if (estimateTokens(content) <= maxTokens) return content;
  const avgCharsPerToken = 4;
  const maxChars = maxTokens * avgCharsPerToken;
  if (content.length <= maxChars) return content;
  const head = content.slice(0, Math.floor(maxChars * 0.4));
  const tail = content.slice(-Math.floor(maxChars * 0.4));
  return `${head}\n\n[... truncated: ${content.length} chars → ${maxTokens} tokens ...]\n\n${tail}`;
}

export class ContextManager {
  constructor(options = {}) {
    this.maxTurns = options.maxTurns || DEFAULT_MAX_TURNS;
    this.maxContextTokens = options.maxContextTokens || DEFAULT_CONTEXT_LIMIT;
    this.history = [];
    this.summary = null;
    this.summaryTokens = 0;
    this._tokenCache = new Map();
    this._cacheSize = 0;
  }

  _getCachedTokens(text) {
    if (this._tokenCache.has(text)) return this._tokenCache.get(text);
    const tokens = estimateTokens(text);
    if (this._cacheSize < CACHE_SIZE) {
      this._tokenCache.set(text, tokens);
      this._cacheSize++;
    }
    return tokens;
  }

  _clearCache() {
    this._tokenCache.clear();
    this._cacheSize = 0;
  }

  _countMessagesTokens(messages) {
    return messages.reduce((sum, m) => sum + this._getCachedTokens(m.content), 0);
  }

  addTurn(role, content) {
    this.history.push({ role, content, timestamp: Date.now() });
    this._clearCache();
  }

  getContext(modelId = null, systemPrompt = null, userMessage = null) {
    const contextLimit = MODEL_CONTEXT_LIMITS[modelId] || this.maxContextTokens;
    const maxInputTokens = contextLimit - OUTPUT_RESERVE;

    let systemTokens = 0;
    if (systemPrompt) {
      systemTokens = this._getCachedTokens(systemPrompt);
    }

    const availableTokens = maxInputTokens - systemTokens - SYSTEM_RESERVE;

    let selected = [];
    let selectedTokens = 0;

    if (this.summary && this.history.length > this.maxTurns) {
      selected.push({ role: 'system', content: `[Ringkasan percakapan sebelumnya: ${this.summary}]` });
      selectedTokens += this.summaryTokens + 20;
    }

    const turns = [...this.history];
    for (let i = turns.length - 1; i >= 0; i--) {
      const turnTokens = this._getCachedTokens(turns[i].content);
      if (selectedTokens + turnTokens > availableTokens) {
        const truncated = truncateContent(turns[i].content, availableTokens - selectedTokens);
        if (estimateTokens(truncated) > 0) {
          selected.unshift({ role: turns[i].role, content: truncated });
        }
        break;
      }
      selected.unshift(turns[i]);
      selectedTokens += turnTokens;

      if (selected.length >= this.maxTurns * 2) break;
    }

    const result = [];
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    result.push(...selected);

    if (userMessage) {
      result.push({ role: 'user', content: userMessage });
    }

    return result;
  }

  getTruncatedMessages(messages, modelId = null, systemPrompt = null) {
    const contextLimit = MODEL_CONTEXT_LIMITS[modelId] || this.maxContextTokens;
    const maxInputTokens = contextLimit - OUTPUT_RESERVE;

    let systemTokens = 0;
    if (systemPrompt) {
      systemTokens = this._getCachedTokens(systemPrompt);
    }

    const availableTokens = maxInputTokens - systemTokens - SYSTEM_RESERVE;

    let totalTokens = 0;
    let selected = [];

    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this._getCachedTokens(messages[i].content);
      if (totalTokens + msgTokens > availableTokens) {
        const truncated = truncateContent(messages[i].content, availableTokens - totalTokens);
        if (estimateTokens(truncated) > 0) {
          selected.unshift({ role: messages[i].role, content: truncated });
        }
        break;
      }
      selected.unshift(messages[i]);
      totalTokens += msgTokens;

      if (selected.length > 200) break;
    }

    const result = [];
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }
    result.push(...selected);

    return { messages: result, totalTokens: totalTokens + systemTokens };
  }

  generateSummary(modelId = null) {
    if (this.history.length === 0) return;
    const totalTokens = this._countMessagesTokens(this.history);
    if (totalTokens < 3000) return;

    const firstMessages = this.history.slice(0, Math.min(4, this.history.length));
    const topics = firstMessages
      .filter(m => m.role === 'user')
      .map(m => m.content.slice(0, 100))
      .join('; ');

    const lastMessages = this.history.slice(-4);
    const lastTopics = lastMessages
      .filter(m => m.role === 'user')
      .map(m => m.content.slice(0, 100))
      .join('; ');

    const turnCount = Math.floor(this.history.length / 2);
    this.summary = `Percakapan ${turnCount} putaran. Topik awal: ${topics}. Topik terakhir: ${lastTopics}. Total ~${totalTokens} token.`;
    this.summaryTokens = this._getCachedTokens(this.summary);
  }

  clear() {
    this.history = [];
    this.summary = null;
    this.summaryTokens = 0;
    this._clearCache();
  }

  getHistoryLength() {
    return this.history.length;
  }

  getEstimatedTokens() {
    return this._countMessagesTokens(this.history);
  }

  setMaxTurns(turns) {
    this.maxTurns = Math.max(2, Math.min(100, turns));
  }
}

export default ContextManager;
