/**
 * Cerebras Provider - Ultra-Fast Inference (1800 tokens/sec)
 * FREE & UNLIMITED for personal use
 * 
 * @author Wisnu Alfian Nur Ashar & Siti Nurfadhila Az Zahra Syam
 * @version 1.0.0
 */

import axios from 'axios';
import { BaseProvider } from './base-provider.js';

export default class CerebrasProvider extends BaseProvider {
  constructor() {
    super({
      name: 'Cerebras',
      apiKey: process.env.CEREBRAS_API_KEY || '',
      baseUrl: process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1',
      defaultModel: process.env.CEREBRAS_DEFAULT_MODEL || 'llama-3.3-70b',
      maxTokens: parseInt(process.env.CEREBRAS_MAX_TOKENS || '8192', 10),
      maxContextTokens: parseInt(process.env.CEREBRAS_MAX_CONTEXT_TOKENS || '128000', 10),
      timeout: 300000,
    });

    this.capabilities = {
      streaming: true,
      toolCalling: true,
      largeContext: true,
      vision: false,
      functionCalling: true,
      multiTurn: true,
      ultraFast: true, // 1800 tokens/sec!
    };

    if (!this.apiKey) {
      console.warn('Cerebras API key not configured. Get free key at: https://inference.cerebras.ai/');
    }
  }

  isAvailable() {
    return this.isConfigured();
  }

  /**
   * Get available models (static list)
   */
  async getAvailableModels() {
    return [
      {
        id: 'llama-3.3-70b',
        name: 'Llama 3.3 70B',
        contextLimit: 128000,
        speed: '1800 tokens/sec',
        owned_by: 'cerebras',
        recommended: true,
      },
      {
        id: 'llama-3.1-70b',
        name: 'Llama 3.1 70B',
        contextLimit: 128000,
        speed: '1800 tokens/sec',
        owned_by: 'cerebras',
      },
      {
        id: 'llama-3.1-8b',
        name: 'Llama 3.1 8B',
        contextLimit: 128000,
        speed: '2100 tokens/sec',
        owned_by: 'cerebras',
      },
    ];
  }

  /**
   * Format messages for Cerebras API (OpenAI-compatible)
   */
  formatMessages(messages) {
    return messages.map(msg => {
      if (msg.role === 'system') {
        return { role: 'system', content: msg.content };
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        return {
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.tool_calls,
        };
      }
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.tool_call_id,
          content: msg.content,
        };
      }
      return { role: msg.role, content: msg.content };
    });
  }

  /**
   * Chat completion (non-streaming)
   */
  async chat(messages, options = {}) {
    const startTime = Date.now();
    
    try {
      this.validateMessages(messages);

      const payload = {
        model: options.model || this.defaultModel,
        messages: this.formatMessages(messages),
        max_tokens: options.max_tokens || this.maxTokens,
        temperature: options.temperature ?? 0.7,
        top_p: options.top_p ?? 0.95,
        stream: false,
      };

      if (options.tools && options.tools.length > 0) {
        payload.tools = options.tools;
        payload.tool_choice = options.tool_choice || 'auto';
      }

      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
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
      const usage = response.data.usage || {};
      this.updateStats(true, usage.total_tokens || 0, latency);

      return {
        content: response.data.choices[0].message.content,
        role: 'assistant',
        tool_calls: response.data.choices[0].message.tool_calls || [],
        usage: usage,
        model: response.data.model,
        finish_reason: response.data.choices[0].finish_reason,
        latency,
      };
    } catch (error) {
      this.updateStats(false, 0, Date.now() - startTime);
      throw new Error(`Cerebras API error: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Streaming chat completion
   */
  async *chatStream(messages, options = {}) {
    const startTime = Date.now();
    
    try {
      this.validateMessages(messages);

      const payload = {
        model: options.model || this.defaultModel,
        messages: this.formatMessages(messages),
        max_tokens: options.max_tokens || this.maxTokens,
        temperature: options.temperature ?? 0.7,
        top_p: options.top_p ?? 0.95,
        stream: true,
      };

      if (options.tools && options.tools.length > 0) {
        payload.tools = options.tools;
        payload.tool_choice = options.tool_choice || 'auto';
      }

      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: this.timeout,
          responseType: 'stream',
        }
      );

      let buffer = '';
      let totalTokens = 0;

      for await (const chunk of response.data) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') {
            if (trimmed === 'data: [DONE]') {
              const latency = Date.now() - startTime;
              this.updateStats(true, totalTokens, latency);
              yield { type: 'done' };
            }
            continue;
          }

          if (trimmed.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              const delta = parsed.choices?.[0]?.delta;
              
              if (delta?.content) {
                totalTokens += this.estimateTokens(delta.content);
                yield { type: 'content', content: delta.content };
              }
              
              if (delta?.tool_calls) {
                yield { type: 'tool_calls', tool_calls: delta.tool_calls };
              }
              
              if (parsed.choices?.[0]?.finish_reason) {
                yield { type: 'finish_reason', reason: parsed.choices[0].finish_reason };
              }
            } catch (parseError) {
              // Ignore malformed JSON
            }
          }
        }
      }

      yield { type: 'done' };
    } catch (error) {
      this.updateStats(false, 0, Date.now() - startTime);
      yield { type: 'error', content: error.response?.data?.error?.message || error.message };
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    if (!this.isConfigured()) {
      return {
        healthy: false,
        provider: 'cerebras',
        error: 'Not configured. Get free API key at: https://inference.cerebras.ai/',
        configured: false,
      };
    }

    try {
      const models = await this.getAvailableModels();
      return {
        healthy: true,
        provider: 'cerebras',
        modelsAvailable: models.length,
        configured: true,
        speed: '1800 tokens/sec',
        pricing: 'FREE & UNLIMITED',
      };
    } catch (error) {
      return {
        healthy: false,
        provider: 'cerebras',
        error: error.message,
        configured: true,
      };
    }
  }
}
