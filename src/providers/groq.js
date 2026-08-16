/**
 * Groq Provider - Ultra-fast inference with LPU
 * Llama 3.3, Mixtral, Gemma 2 with blazing fast speed
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 2.0.0
 */

import axios from 'axios';
import BaseProvider from './base-provider.js';
import config from '../../config/config.js';

export class GroqProvider extends BaseProvider {
  constructor() {
    super({
      name: 'Groq',
      apiKey: config.groq?.apiKey || process.env.GROQ_API_KEY,
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: config.groq?.defaultModel || 'llama-3.3-70b-versatile',
      maxTokens: 8192,
      maxContextTokens: 128000,
      timeout: 30000, // Groq is FAST!
    });

    this.capabilities = {
      streaming: true,
      toolCalling: true,
      largeContext: true,
      vision: false, // Coming soon
      functionCalling: true,
      multiTurn: true,
      jsonMode: true,
      ultraFast: true, // Groq's specialty!
    };
  }

  /**
   * Chat completion with tool calling support
   * Groq uses OpenAI-compatible API
   */
  async chat(messages, options = {}) {
    const startTime = Date.now();
    
    if (!this.isConfigured()) {
      return {
        success: false,
        error: 'Groq provider not configured. Set GROQ_API_KEY in .env',
      };
    }

    try {
      this.validateMessages(messages);
      
      const model = options.model || this.defaultModel;
      const maxTokens = options.maxTokens || this.maxTokens;
      
      // Handle large context with smart truncation
      const { messages: truncatedMessages, totalTokens } = this.truncateMessages(
        messages,
        this.maxContextTokens - maxTokens
      );

      const body = {
        model,
        messages: truncatedMessages,
        max_tokens: maxTokens,
        temperature: options.temperature ?? 0.7,
      };

      // Add tool/function calling if provided
      if (options.tools && options.tools.length > 0) {
        body.tools = this.convertToolsFormat(options.tools);
        body.tool_choice = options.tool_choice || 'auto';
      }

      // JSON mode support
      if (options.response_format === 'json') {
        body.response_format = { type: 'json_object' };
      }

      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        body,
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

      const choice = response.data.choices[0];
      const result = {
        success: true,
        content: choice.message.content || '',
        finish_reason: choice.finish_reason,
        model: response.data.model,
        usage: {
          prompt_tokens: usage.prompt_tokens || 0,
          completion_tokens: usage.completion_tokens || 0,
          total_tokens: usage.total_tokens || 0,
        },
        latency,
        tokensPerSecond: usage.completion_tokens / (latency / 1000), // Groq is FAST!
      };

      // Include tool calls if present
      if (choice.message.tool_calls) {
        result.tool_calls = choice.message.tool_calls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
      }

      return result;
    } catch (error) {
      const latency = Date.now() - startTime;
      this.updateStats(false, 0, latency);
      
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message,
        code: error.response?.status || 'UNKNOWN',
      };
    }
  }

  /**
   * Streaming chat with tool calling support
   */
  async *chatStream(messages, options = {}) {
    if (!this.isConfigured()) {
      yield { type: 'error', content: 'Groq provider not configured' };
      return;
    }

    try {
      this.validateMessages(messages);
      
      const model = options.model || this.defaultModel;
      const maxTokens = options.maxTokens || this.maxTokens;
      
      const { messages: truncatedMessages } = this.truncateMessages(
        messages,
        this.maxContextTokens - maxTokens
      );

      const body = {
        model,
        messages: truncatedMessages,
        max_tokens: maxTokens,
        temperature: options.temperature ?? 0.7,
        stream: true,
      };

      // Add tools if provided
      if (options.tools && options.tools.length > 0) {
        body.tools = this.convertToolsFormat(options.tools);
        body.tool_choice = options.tool_choice || 'auto';
      }

      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        body,
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
      const toolCalls = [];

      for await (const chunk of response.data) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || line.trim() === 'data: [DONE]') continue;
          if (!line.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(line.slice(6));
            const delta = data.choices?.[0]?.delta;

            if (!delta) continue;

            // Handle content
            if (delta.content) {
              yield { type: 'content', content: delta.content };
            }

            // Handle tool calls
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = {
                    id: tc.id,
                    type: 'function',
                    function: { name: '', arguments: '' },
                  };
                }
                
                if (tc.function?.name) {
                  toolCalls[tc.index].function.name += tc.function.name;
                }
                if (tc.function?.arguments) {
                  toolCalls[tc.index].function.arguments += tc.function.arguments;
                }
              }
            }

            // Handle finish
            if (data.choices?.[0]?.finish_reason) {
              if (toolCalls.length > 0) {
                yield { type: 'tool_calls', tool_calls: toolCalls };
              }
              yield { type: 'done', finish_reason: data.choices[0].finish_reason };
            }
          } catch (e) {
            // Skip parse errors
          }
        }
      }

      yield { type: 'done' };
    } catch (error) {
      yield { type: 'error', content: error.response?.data?.error?.message || error.message };
    }
  }

  /**
   * Convert tools to OpenAI format (Groq compatible)
   */
  convertToolsFormat(tools) {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || {
          type: 'object',
          properties: {},
        },
      },
    }));
  }

  /**
   * Get available models
   */
  async getAvailableModels() {
    return config.groq?.models || [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', family: 'Meta', rec: true, tags: ['Fast', 'Versatile', '128K Context'] },
      { id: 'llama-3.1-70b-versatile', label: 'Llama 3.1 70B', family: 'Meta', tags: ['Fast', '128K Context'] },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B', family: 'Meta', tags: ['Ultra Fast', 'Cheap'] },
      { id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B', family: 'Mistral', tags: ['Fast', 'MoE'] },
      { id: 'gemma2-9b-it', label: 'Gemma 2 9B', family: 'Google', tags: ['Fast', 'Efficient'] },
    ];
  }

  /**
   * Get default model
   */
  getDefaultModel() {
    return this.defaultModel;
  }

  /**
   * Check if available
   */
  isAvailable() {
    return this.isConfigured();
  }
}

export default GroqProvider;
