/**
 * Vector Provider - Enhanced with BaseProvider
 * Full tool calling, large context, and streaming support
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 2.0.0
 */

import axios from 'axios';
import BaseProvider from './base-provider.js';
import config from '../../config/config.js';

export class VectorProvider extends BaseProvider {
  constructor() {
    super({
      name: 'Vector',
      apiKey: config.vector?.apiKey || process.env.VECTOR_API_KEY,
      baseUrl: config.vector?.baseUrl || process.env.VECTOR_BASE_URL || 'https://api.vector.dev/v1',
      defaultModel: config.vector?.defaultModel || 'vector-1',
      maxTokens: parseInt(config.vector?.maxTokens || '4096', 10),
      maxContextTokens: parseInt(config.vector?.maxContextTokens || '128000', 10),
      timeout: 60000,
    });

    this.capabilities = {
      streaming: true,
      toolCalling: true,
      largeContext: true,
      vision: false,
      functionCalling: true,
      multiTurn: true,
    };
  }

  /**
   * Chat completion with enhanced large context and tool calling
   */
  async chat(messages, options = {}) {
    const startTime = Date.now();
    
    if (!this.isConfigured()) {
      return {
        success: false,
        error: 'Vector provider not configured. Set VECTOR_API_KEY in .env',
      };
    }

    try {
      this.validateMessages(messages);
      
      const model = options.model || this.defaultModel;
      const maxTokens = options.maxTokens || this.maxTokens;
      
      // Smart truncation for large context
      const { messages: truncatedMessages, totalTokens } = this.truncateMessages(
        messages,
        this.maxContextTokens - maxTokens
      );

      const body = {
        model,
        messages: truncatedMessages,
        max_tokens: maxTokens,
      };

      if (options.temperature !== undefined) body.temperature = options.temperature;
      if (options.top_p !== undefined) body.top_p = options.top_p;
      
      // Add tool calling support
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
            'Content-Type': 'application/json'
          },
          timeout: this.timeout,
        }
      );

      const latency = Date.now() - startTime;
      const usage = response.data.usage || {};
      
      this.updateStats(true, usage.total_tokens || 0, latency);

      if (response.data && response.data.choices && response.data.choices.length > 0) {
        const message = response.data.choices[0].message;
        const result = {
          success: true,
          content: message.content || '',
          finish_reason: response.data.choices[0].finish_reason || 'stop',
          model: response.data.model,
          usage: {
            prompt_tokens: usage.prompt_tokens || 0,
            completion_tokens: usage.completion_tokens || 0,
            total_tokens: usage.total_tokens || 0,
          },
          latency,
          provider: 'vector',
        };

        // Include tool calls if present
        if (message.tool_calls && message.tool_calls.length > 0) {
          result.tool_calls = message.tool_calls;
        }

        return result;
      }

      throw new Error('Invalid response format from Vector API');
    } catch (error) {
      const latency = Date.now() - startTime;
      this.updateStats(false, 0, latency);
      
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message,
        code: error.response?.status || 'UNKNOWN',
        provider: 'vector',
      };
    }
  }

  /**
   * Streaming chat with tool calling support
   */
  async *chatStream(messages, options = {}) {
    if (!this.isConfigured()) {
      yield { type: 'error', content: 'Vector provider not configured' };
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
        stream: true,
      };

      if (options.temperature !== undefined) body.temperature = options.temperature;
      if (options.top_p !== undefined) body.top_p = options.top_p;
      
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
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') {
            if (trimmed === 'data: [DONE]') {
              if (toolCalls.length > 0) {
                yield { type: 'tool_calls', tool_calls: toolCalls };
              }
              yield { type: 'done' };
              return;
            }
            continue;
          }
          
          if (trimmed.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              const delta = parsed.choices?.[0]?.delta;
              
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
              if (parsed.choices?.[0]?.finish_reason) {
                if (toolCalls.length > 0) {
                  yield { type: 'tool_calls', tool_calls: toolCalls };
                }
                yield { type: 'done', finish_reason: parsed.choices[0].finish_reason };
              }
            } catch (e) {
              // Skip parse errors
            }
          }
        }
      }

      yield { type: 'done' };
    } catch (error) {
      yield { type: 'error', content: error.response?.data?.error?.message || error.message };
    }
  }

  /**
   * Convert tools to OpenAI-compatible format
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
    return config.vector?.models || [
      { id: 'vector-1', label: 'Vector 1', family: 'Vector', rec: true, tags: ['Balanced', 'Fast'] },
      { id: 'vector-1-turbo', label: 'Vector 1 Turbo', family: 'Vector', tags: ['Ultra Fast'] },
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

export default VectorProvider;
