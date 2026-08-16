/**
 * OpenAI Provider - GPT-4, GPT-4o, GPT-4 Turbo, o1, o3
 * Full tool calling, streaming, and large context support
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 2.0.0
 */

import axios from 'axios';
import BaseProvider from './base-provider.js';
import config from '../../config/config.js';

export class OpenAIProvider extends BaseProvider {
  constructor() {
    super({
      name: 'OpenAI',
      apiKey: config.openai?.apiKey || process.env.OPENAI_API_KEY,
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: config.openai?.defaultModel || 'gpt-4o',
      maxTokens: 16384,
      maxContextTokens: 128000,
      timeout: 60000,
    });

    this.capabilities = {
      streaming: true,
      toolCalling: true,
      largeContext: true,
      vision: true,
      functionCalling: true,
      multiTurn: true,
      jsonMode: true,
    };
  }

  /**
   * Chat completion with tool calling support
   */
  async chat(messages, options = {}) {
    const startTime = Date.now();
    
    if (!this.isConfigured()) {
      return {
        success: false,
        error: 'OpenAI provider not configured. Set OPENAI_API_KEY in .env',
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
      yield { type: 'error', content: 'OpenAI provider not configured' };
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
   * Convert tools to OpenAI format
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
    return config.openai?.models || [
      { id: 'gpt-4o', label: 'GPT-4o', family: 'OpenAI', rec: true, tags: ['Fast', 'Multimodal', '128K Context'] },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', family: 'OpenAI', tags: ['Fast', 'Cheap', '128K Context'] },
      { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', family: 'OpenAI', tags: ['Powerful', '128K Context'] },
      { id: 'gpt-4', label: 'GPT-4', family: 'OpenAI', tags: ['Powerful', '8K Context'] },
      { id: 'o1-preview', label: 'o1 Preview', family: 'OpenAI', tags: ['Reasoning', 'Advanced'] },
      { id: 'o1-mini', label: 'o1 Mini', family: 'OpenAI', tags: ['Reasoning', 'Fast'] },
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

export default OpenAIProvider;
