/**
 * HuggingFace Provider - Community Models FREE
 * Access thousands of open-source models
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 1.0.0
 */

import axios from './http-client.js';
import { BaseProvider } from './base-provider.js';

export default class HuggingFaceProvider extends BaseProvider {
  constructor() {
    super({
      name: 'HuggingFace',
      apiKey: process.env.HUGGINGFACE_API_KEY || '',
      baseUrl: process.env.HUGGINGFACE_BASE_URL || 'https://api-inference.huggingface.co/models',
      defaultModel: process.env.HUGGINGFACE_DEFAULT_MODEL || 'meta-llama/Llama-3.3-70B-Instruct',
      maxTokens: parseInt(process.env.HUGGINGFACE_MAX_TOKENS || '8192', 10),
      maxContextTokens: parseInt(process.env.HUGGINGFACE_MAX_CONTEXT_TOKENS || '128000', 10),
      timeout: 300000,
    });

    this.capabilities = {
      streaming: true,
      toolCalling: false, // Most HF models don't support native tool calling
      largeContext: true,
      vision: false,
      functionCalling: false,
      multiTurn: true,
      openSource: true,
    };

    if (!this.apiKey) {
      console.warn('HuggingFace API key not configured. Get free key at: https://huggingface.co/settings/tokens');
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
        id: 'meta-llama/Llama-3.3-70B-Instruct',
        name: 'Llama 3.3 70B Instruct',
        contextLimit: 128000,
        owned_by: 'meta',
        recommended: true,
      },
      {
        id: 'Qwen/Qwen2.5-72B-Instruct',
        name: 'Qwen 2.5 72B Instruct',
        contextLimit: 128000,
        owned_by: 'qwen',
        recommended: true,
      },
      {
        id: 'mistralai/Mistral-Nemo-Instruct-2407',
        name: 'Mistral NeMo 12B Instruct',
        contextLimit: 128000,
        owned_by: 'mistral',
      },
      {
        id: 'microsoft/Phi-3.5-mini-instruct',
        name: 'Phi-3.5 Mini Instruct',
        contextLimit: 128000,
        owned_by: 'microsoft',
      },
      {
        id: 'google/gemma-2-27b-it',
        name: 'Gemma 2 27B IT',
        contextLimit: 8192,
        owned_by: 'google',
      },
      {
        id: 'NousResearch/Hermes-3-Llama-3.1-8B',
        name: 'Hermes 3 Llama 3.1 8B',
        contextLimit: 128000,
        owned_by: 'nousresearch',
      },
    ];
  }

  /**
   * Format messages for HuggingFace API
   */
  formatMessages(messages) {
    // HuggingFace Inference API expects messages in chat format
    return messages.map(msg => ({
      role: msg.role === 'system' ? 'system' : msg.role,
      content: msg.content,
    }));
  }

  /**
   * Chat completion (non-streaming)
   */
  async chat(messages, options = {}) {
    const startTime = Date.now();
    
    try {
      this.validateMessages(messages);

      const model = options.model || this.defaultModel;
      const payload = {
        inputs: this.formatMessages(messages),
        parameters: {
          max_new_tokens: options.max_tokens || this.maxTokens,
          temperature: options.temperature ?? 0.7,
          top_p: options.top_p ?? 0.95,
          return_full_text: false,
        },
      };

      const response = await axios.post(
        `${this.baseUrl}/${model}`,
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
      
      // HuggingFace response format varies by model
      let content = '';
      if (Array.isArray(response.data)) {
        content = response.data[0]?.generated_text || '';
      } else if (response.data.generated_text) {
        content = response.data.generated_text;
      } else {
        content = JSON.stringify(response.data);
      }

      const tokens = this.estimateTokens(content);
      this.updateStats(true, tokens, latency);

      return {
        content,
        role: 'assistant',
        tool_calls: [],
        usage: {
          prompt_tokens: this.estimateTokens(JSON.stringify(messages)),
          completion_tokens: tokens,
          total_tokens: this.estimateTokens(JSON.stringify(messages)) + tokens,
        },
        model,
        finish_reason: 'stop',
        latency,
      };
    } catch (error) {
      this.updateStats(false, 0, Date.now() - startTime);
      
      // Handle model loading state
      if (error.response?.status === 503) {
        throw new Error('Model is loading, please wait a moment and try again');
      }
      
      throw new Error(`HuggingFace API error: ${error.response?.data?.error || error.message}`);
    }
  }

  /**
   * Streaming chat completion
   */
  async *chatStream(messages, options = {}) {
    const startTime = Date.now();
    
    try {
      this.validateMessages(messages);

      const model = options.model || this.defaultModel;
      const payload = {
        inputs: this.formatMessages(messages),
        parameters: {
          max_new_tokens: options.max_tokens || this.maxTokens,
          temperature: options.temperature ?? 0.7,
          top_p: options.top_p ?? 0.95,
          return_full_text: false,
        },
        stream: true,
      };

      const response = await axios.post(
        `${this.baseUrl}/${model}`,
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
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed);
            
            if (parsed.token?.text) {
              const text = parsed.token.text;
              totalTokens += this.estimateTokens(text);
              yield { type: 'content', content: text };
            }
            
            if (parsed.generated_text) {
              yield { type: 'content', content: parsed.generated_text };
            }
            
            if (parsed.details?.finish_reason) {
              yield { type: 'finish_reason', reason: parsed.details.finish_reason };
            }
          } catch (parseError) {
            // Ignore malformed JSON
          }
        }
      }

      const latency = Date.now() - startTime;
      this.updateStats(true, totalTokens, latency);
      yield { type: 'done' };
    } catch (error) {
      this.updateStats(false, 0, Date.now() - startTime);
      
      if (error.response?.status === 503) {
        yield { type: 'error', content: 'Model is loading, please wait a moment and try again' };
      } else {
        yield { type: 'error', content: error.response?.data?.error || error.message };
      }
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    if (!this.isConfigured()) {
      return {
        healthy: false,
        provider: 'huggingface',
        error: 'Not configured. Get free API key at: https://huggingface.co/settings/tokens',
        configured: false,
      };
    }

    try {
      const models = await this.getAvailableModels();
      return {
        healthy: true,
        provider: 'huggingface',
        modelsAvailable: models.length,
        configured: true,
        description: 'Thousands of open-source models',
        pricing: 'FREE (rate limited)',
      };
    } catch (error) {
      return {
        healthy: false,
        provider: 'huggingface',
        error: error.message,
        configured: true,
      };
    }
  }
}
