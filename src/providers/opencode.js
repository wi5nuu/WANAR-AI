/**
 * OpenCode Router Provider - Access to FREE models via OpenCode
 * Connects to local OpenCode router for unlimited free models
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 1.0.0
 */

import axios from './http-client.js';
import { BaseProvider } from './base-provider.js';

export default class OpenCodeProvider extends BaseProvider {
  constructor() {
    super({
      name: 'OpenCode',
      apiKey: process.env.OPENCODE_API_KEY || 'sk-9router',
      baseUrl: process.env.OPENCODE_BASE_URL || 'http://localhost:20128/v1',
      defaultModel: process.env.OPENCODE_DEFAULT_MODEL || 'kc/deepseek/deepseek-chat',
      maxTokens: parseInt(process.env.OPENCODE_MAX_TOKENS || '8192', 10),
      maxContextTokens: parseInt(process.env.OPENCODE_MAX_CONTEXT_TOKENS || '200000', 10),
      timeout: 300000,
    });

    this.capabilities = {
      streaming: true,
      toolCalling: true,
      largeContext: true,
      vision: false,
      functionCalling: true,
      multiTurn: true,
      unlimitedFree: true,
    };
  }

  isAvailable() {
    return true; // OpenCode router should always be available locally
  }

  /**
   * Get available models from OpenCode router
   */
  async getAvailableModels() {
    try {
      const response = await axios.get(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        timeout: 10000,
      });

      if (response.data?.data) {
        return response.data.data.map(m => ({
          id: m.id,
          name: m.id,
          contextLimit: m.context_length || 200000,
          owned_by: m.owned_by || 'opencode',
        }));
      }

      // Fallback to known models if API call fails
      return this.getStaticModels();
    } catch (error) {
      console.warn('OpenCode Router: Could not fetch models, using static list');
      return this.getStaticModels();
    }
  }

  /**
   * Static list of known OpenCode free models
   */
  getStaticModels() {
    return [
      // Ox Alpha - OpenCode's primary model
      { id: 'ox-alpha', name: 'Ox Alpha Free (Unlimited)', family: 'OpenCode', rec: true, tags: ['FREE', 'Unlimited', 'OpenCode', 'Primary'] },
      
      // DeepSeek Models
      { id: 'kc/deepseek/deepseek-chat', name: 'DeepSeek Chat', family: 'DeepSeek', rec: true, tags: ['FREE', 'Unlimited', 'Coding'] },
      { id: 'kc/deepseek/deepseek-reasoner', name: 'DeepSeek Reasoner', family: 'DeepSeek', rec: true, tags: ['FREE', 'Reasoning'] },
      
      // Llama Models
      { id: 'kc/meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct', family: 'Meta', tags: ['FREE', 'Powerful'] },
      { id: 'kc/meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B Instruct', family: 'Meta', rec: true, tags: ['FREE', 'Largest'] },
      { id: 'kc/meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B Instruct', family: 'Meta', tags: ['FREE'] },
      { id: 'kc/meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B Instruct', family: 'Meta', tags: ['FREE', 'Fast'] },
      
      // Qwen Models
      { id: 'kc/qwen/qwen2.5-72b-instruct', name: 'Qwen 2.5 72B Instruct', family: 'Alibaba', rec: true, tags: ['FREE', 'Multilingual'] },
      { id: 'kc/qwen/qwen2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B', family: 'Alibaba', tags: ['FREE', 'Coding'] },
      
      // Mistral Models
      { id: 'kc/mistralai/mixtral-8x7b-instruct', name: 'Mixtral 8x7B Instruct', family: 'Mistral', tags: ['FREE', 'MoE'] },
      { id: 'kc/mistralai/mistral-nemo-instruct', name: 'Mistral NeMo Instruct', family: 'Mistral', tags: ['FREE'] },
      
      // Google Models
      { id: 'kc/google/gemma-2-27b-it', name: 'Gemma 2 27B IT', family: 'Google', tags: ['FREE'] },
      
      // Microsoft Models
      { id: 'kc/microsoft/phi-3.5-mini-instruct', name: 'Phi-3.5 Mini Instruct', family: 'Microsoft', tags: ['FREE', 'Fast'] },
    ];
  }

  /**
   * Format messages for OpenCode router (OpenAI-compatible)
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
      
      if (error.code === 'ECONNREFUSED') {
        throw new Error('OpenCode router not running. Please start OpenCode first.');
      }
      
      throw new Error(`OpenCode API error: ${error.response?.data?.error?.message || error.message}`);
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
      
      if (error.code === 'ECONNREFUSED') {
        yield { type: 'error', content: 'OpenCode router not running. Please start OpenCode first.' };
      } else {
        yield { type: 'error', content: error.response?.data?.error?.message || error.message };
      }
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const response = await axios.get(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        timeout: 5000,
      });

      const modelCount = response.data?.data?.length || 0;
      
      return {
        healthy: true,
        provider: 'opencode',
        modelsAvailable: modelCount,
        configured: true,
        description: 'Local OpenCode router - FREE & UNLIMITED',
      };
    } catch (error) {
      return {
        healthy: false,
        provider: 'opencode',
        error: error.code === 'ECONNREFUSED' 
          ? 'OpenCode router not running (start OpenCode first)'
          : error.message,
        configured: true,
      };
    }
  }
}
