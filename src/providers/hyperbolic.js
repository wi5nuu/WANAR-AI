/**
 * Hyperbolic Provider - DeepSeek V3, Qwen 2.5 72B, Llama 405B FREE
 * High-performance inference with latest models
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 1.0.0
 */

import axios from './http-client.js';
import { BaseProvider } from './base-provider.js';

export default class HyperbolicProvider extends BaseProvider {
  constructor() {
    super({
      name: 'Hyperbolic',
      apiKey: process.env.HYPERBOLIC_API_KEY || '',
      baseUrl: process.env.HYPERBOLIC_BASE_URL || 'https://api.hyperbolic.xyz/v1',
      defaultModel: process.env.HYPERBOLIC_DEFAULT_MODEL || 'deepseek-ai/DeepSeek-V3',
      maxTokens: parseInt(process.env.HYPERBOLIC_MAX_TOKENS || '8192', 10),
      maxContextTokens: parseInt(process.env.HYPERBOLIC_MAX_CONTEXT_TOKENS || '128000', 10),
      timeout: 300000,
    });

    this.capabilities = {
      streaming: true,
      toolCalling: true,
      largeContext: true,
      vision: false,
      functionCalling: true,
      multiTurn: true,
      latestModels: true, // DeepSeek V3, Qwen 2.5
    };

    if (!this.apiKey) {
      console.warn('Hyperbolic API key not configured. Get free key at: https://app.hyperbolic.xyz/');
    }
  }

  isAvailable() {
    return this.isConfigured();
  }

  /**
   * Get available models
   */
  async getAvailableModels() {
    return [
      {
        id: 'deepseek-ai/DeepSeek-V3',
        name: 'DeepSeek V3',
        contextLimit: 128000,
        owned_by: 'hyperbolic',
        recommended: true,
        description: 'Latest DeepSeek model - excellent for coding',
      },
      {
        id: 'Qwen/Qwen2.5-72B-Instruct',
        name: 'Qwen 2.5 72B Instruct',
        contextLimit: 128000,
        owned_by: 'hyperbolic',
        recommended: true,
        description: 'Powerful multilingual model',
      },
      {
        id: 'meta-llama/Llama-3.1-405B-Instruct',
        name: 'Meta Llama 3.1 405B Instruct',
        contextLimit: 128000,
        owned_by: 'hyperbolic',
        description: 'Largest Llama model',
      },
      {
        id: 'meta-llama/Llama-3.3-70B-Instruct',
        name: 'Meta Llama 3.3 70B Instruct',
        contextLimit: 128000,
        owned_by: 'hyperbolic',
        description: 'Latest Llama 3.3',
      },
      {
        id: 'meta-llama/Llama-3.1-70B-Instruct',
        name: 'Meta Llama 3.1 70B Instruct',
        contextLimit: 128000,
        owned_by: 'hyperbolic',
      },
      {
        id: 'NousResearch/Hermes-3-Llama-3.1-70B',
        name: 'Hermes 3 Llama 3.1 70B',
        contextLimit: 128000,
        owned_by: 'hyperbolic',
        description: 'Fine-tuned for following instructions',
      },
    ];
  }

  /**
   * Format messages for Hyperbolic API (OpenAI-compatible)
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
        success: true,
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
      throw new Error(`Hyperbolic API error: ${error.response?.data?.error?.message || error.message}`);
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
        provider: 'hyperbolic',
        error: 'Not configured. Get free API key at: https://app.hyperbolic.xyz/',
        configured: false,
      };
    }

    try {
      const models = await this.getAvailableModels();
      return {
        healthy: true,
        provider: 'hyperbolic',
        modelsAvailable: models.length,
        configured: true,
        featuredModels: 'DeepSeek V3, Qwen 2.5 72B, Llama 405B',
        pricing: 'FREE & UNLIMITED',
      };
    } catch (error) {
      return {
        healthy: false,
        provider: 'hyperbolic',
        error: error.message,
        configured: true,
      };
    }
  }
}
