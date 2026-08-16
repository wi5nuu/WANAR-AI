/**
 * Google Gemini Provider - Gemini 2.0, 1.5 Pro, Flash
 * Full tool calling, streaming, and 2M context support
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 2.0.0
 */

import axios from 'axios';
import BaseProvider from './base-provider.js';
import config from '../../config/config.js';

export class GeminiProvider extends BaseProvider {
  constructor() {
    super({
      name: 'Gemini',
      apiKey: config.gemini?.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      defaultModel: config.gemini?.defaultModel || 'gemini-2.0-flash-exp',
      maxTokens: 8192,
      maxContextTokens: 2000000, // 2M tokens!
      timeout: 60000,
    });

    this.capabilities = {
      streaming: true,
      toolCalling: true,
      largeContext: true, // 2 MILLION tokens!
      vision: true,
      functionCalling: true,
      multiTurn: true,
      jsonMode: true,
      codeExecution: true,
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
        error: 'Gemini provider not configured. Set GEMINI_API_KEY or GOOGLE_API_KEY in .env',
      };
    }

    try {
      this.validateMessages(messages);
      
      const model = options.model || this.defaultModel;
      const maxTokens = options.maxTokens || this.maxTokens;
      
      // Gemini can handle HUGE contexts - 2M tokens!
      // But we still truncate for performance
      const maxContextSize = Math.min(
        this.maxContextTokens,
        options.maxContextTokens || 1000000 // Default 1M for performance
      );
      
      const { messages: truncatedMessages } = this.truncateMessages(
        messages,
        maxContextSize - maxTokens
      );

      // Convert to Gemini format
      const { systemInstruction, contents } = this.convertToGeminiFormat(truncatedMessages);

      const body = {
        contents,
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: maxTokens,
        },
      };

      // Add system instruction if present
      if (systemInstruction) {
        body.systemInstruction = { parts: [{ text: systemInstruction }] };
      }

      // Add tools if provided
      if (options.tools && options.tools.length > 0) {
        body.tools = [{ functionDeclarations: this.convertToolsFormat(options.tools) }];
      }

      // JSON mode support
      if (options.response_format === 'json') {
        body.generationConfig.responseMimeType = 'application/json';
      }

      const url = `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`;
      const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: this.timeout,
      });

      const latency = Date.now() - startTime;
      const candidate = response.data.candidates?.[0];
      
      if (!candidate) {
        throw new Error('No candidates in response');
      }

      const usage = response.data.usageMetadata || {};
      this.updateStats(true, usage.totalTokenCount || 0, latency);

      const result = {
        success: true,
        content: this.extractContent(candidate.content),
        finish_reason: candidate.finishReason?.toLowerCase() || 'stop',
        model: model,
        usage: {
          prompt_tokens: usage.promptTokenCount || 0,
          completion_tokens: usage.candidatesTokenCount || 0,
          total_tokens: usage.totalTokenCount || 0,
        },
        latency,
      };

      // Handle function/tool calls
      const functionCalls = this.extractFunctionCalls(candidate.content);
      if (functionCalls.length > 0) {
        result.tool_calls = functionCalls;
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
   * Streaming chat
   */
  async *chatStream(messages, options = {}) {
    if (!this.isConfigured()) {
      yield { type: 'error', content: 'Gemini provider not configured' };
      return;
    }

    try {
      this.validateMessages(messages);
      
      const model = options.model || this.defaultModel;
      const maxTokens = options.maxTokens || this.maxTokens;
      
      const maxContextSize = Math.min(
        this.maxContextTokens,
        options.maxContextTokens || 1000000
      );
      
      const { messages: truncatedMessages } = this.truncateMessages(
        messages,
        maxContextSize - maxTokens
      );

      const { systemInstruction, contents } = this.convertToGeminiFormat(truncatedMessages);

      const body = {
        contents,
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: maxTokens,
        },
      };

      if (systemInstruction) {
        body.systemInstruction = { parts: [{ text: systemInstruction }] };
      }

      if (options.tools && options.tools.length > 0) {
        body.tools = [{ functionDeclarations: this.convertToolsFormat(options.tools) }];
      }

      const url = `${this.baseUrl}/models/${model}:streamGenerateContent?key=${this.apiKey}&alt=sse`;
      const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        responseType: 'stream',
        timeout: this.timeout,
      });

      let buffer = '';

      for await (const chunk of response.data) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(line.slice(6));
            const candidate = data.candidates?.[0];
            
            if (!candidate) continue;

            const content = this.extractContent(candidate.content);
            if (content) {
              yield { type: 'content', content };
            }

            const functionCalls = this.extractFunctionCalls(candidate.content);
            if (functionCalls.length > 0) {
              yield { type: 'tool_calls', tool_calls: functionCalls };
            }

            if (candidate.finishReason) {
              yield { type: 'done', finish_reason: candidate.finishReason.toLowerCase() };
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
   * Convert messages to Gemini format
   */
  convertToGeminiFormat(messages) {
    let systemInstruction = '';
    const contents = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction += (systemInstruction ? '\n\n' : '') + msg.content;
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    return { systemInstruction, contents };
  }

  /**
   * Convert tools to Gemini format
   */
  convertToolsFormat(tools) {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || {
        type: 'object',
        properties: {},
      },
    }));
  }

  /**
   * Extract text content from Gemini response
   */
  extractContent(content) {
    if (!content?.parts) return '';
    
    return content.parts
      .filter(part => part.text)
      .map(part => part.text)
      .join('');
  }

  /**
   * Extract function calls from Gemini response
   */
  extractFunctionCalls(content) {
    if (!content?.parts) return [];
    
    const calls = [];
    for (const part of content.parts) {
      if (part.functionCall) {
        calls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        });
      }
    }
    
    return calls;
  }

  /**
   * Get available models
   */
  async getAvailableModels() {
    return config.gemini?.models || [
      { id: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash', family: 'Google', rec: true, tags: ['Fast', 'Latest', '2M Context'] },
      { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', family: 'Google', rec: true, tags: ['Powerful', '2M Context'] },
      { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', family: 'Google', tags: ['Fast', '1M Context'] },
      { id: 'gemini-1.5-flash-8b', label: 'Gemini 1.5 Flash-8B', family: 'Google', tags: ['Fast', 'Cheap', '1M Context'] },
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

export default GeminiProvider;
