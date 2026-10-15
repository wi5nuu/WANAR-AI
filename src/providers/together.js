/**
 * Together AI Provider - Free Tier with Premium Models
 * Access Llama 405B, Qwen, and more
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 1.0.0
 */

import axios from './http-client.js';
import { BaseProvider } from './base-provider.js';

export default class TogetherProvider extends BaseProvider {
  constructor() {
    super({
      name: 'Together',
      apiKey: process.env.TOGETHER_API_KEY || '',
      baseUrl: process.env.TOGETHER_BASE_URL || 'https://api.together.xyz/v1',
      defaultModel: process.env.TOGETHER_DEFAULT_MODEL || 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
      maxTokens: parseInt(process.env.TOGETHER_MAX_TOKENS || '8192', 10),
      maxContextTokens: parseInt(process.env.TOGETHER_MAX_CONTEXT_TOKENS || '128000', 10),
      timeout: 300000,
    });

    this.capabilities = {
      streaming: true,
      toolCalling: true,
      largeContext: true,
      vision: false,
      functionCalling: true,
      multiTurn: true,
      premiumModels: true,
    };

    if (!this.apiKey) {
      console.warn('Together AI API key not configured. Get free $25 credit at: https://api.together.xyz/');
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
        id: 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
        name: 'Meta Llama 3.1 405B Instruct Turbo',
        contextLimit: 130000,
        owned_by: 'together',
        recommended: true,
        description: 'Largest and most capable Llama model',
      },
      {
        id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        name: 'Llama 3.3 70B Instruct Turbo',
        contextLimit: 128000,
        owned_by: 'together',
        recommended: true,
      },
      {
        id: 'Qwen/Qwen2.5-72B-Instruct-Turbo',
        name: 'Qwen 2.5 72B Instruct Turbo',
        contextLimit: 32768,
        owned_by: 'together',
      },
      {
        id: 'deepseek-ai/deepseek-llm-67b-chat',
        name: 'DeepSeek LLM 67B Chat',
        contextLimit: 4096,
        owned_by: 'together',
      },
      {
        id: 'NousResearch/Nous-Hermes-2-Yi-34B',
        name: 'Nous Hermes 2 Yi 34B',
        contextLimit: 4096,
        owned_by: 'together',
      },
      {
        id: 'mistralai/Mixtral-8x7B-Instruct-v0.1',
        name: 'Mixtral 8x7B Instruct',
        contextLimit: 32768,
        owned_by: 'together',
      },
    ];
  }

  /**
   * Format messages for Together AI API (OpenAI-compatible)
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
      throw new Error(`Together AI API error: ${error.response?.data?.error?.message || error.message}`);
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
        ...(process.env.AI_STREAM_USAGE === 'false' ? {} : { stream_options: { include_usage: true } }),
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
              if (parsed.usage) yield { type: 'usage', usage: parsed.usage };

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
        provider: 'together',
        error: 'Not configured. Get $25 free credit at: https://api.together.xyz/',
        configured: false,
      };
    }

    try {
      const models = await this.getAvailableModels();
      return {
        healthy: true,
        provider: 'together',
        modelsAvailable: models.length,
        configured: true,
        featuredModel: 'Llama 3.1 405B Turbo',
        pricing: '$25 free credit',
      };
    } catch (error) {
      return {
        healthy: false,
        provider: 'together',
        error: error.message,
        configured: true,
      };
    }
  }
}
