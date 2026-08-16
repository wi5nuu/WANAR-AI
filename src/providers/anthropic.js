/**
 * Anthropic Provider - Direct API Integration
 * No middleman, full control over system prompt
 * by Wisnu Alfian Nur Ashar
 */

import axios from 'axios';
import config from '../../config/config.js';

export class AnthropicProvider {
  constructor() {
    this.apiKey = config.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
    this.baseUrl = 'https://api.anthropic.com/v1';
    this.defaultModel = config.anthropic?.defaultModel || 'claude-sonnet-4-20250514';
    this.anthropicVersion = '2023-06-01';
  }

  async chat(messages, options = {}) {
    const model = options.model || this.defaultModel;
    const maxTokens = options.maxTokens || 4096;
    
    // Extract system prompt from messages (first message with role 'system')
    let systemPrompt = '';
    const conversationMessages = [];
    
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
      } else {
        conversationMessages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    const body = {
      model,
      max_tokens: maxTokens,
      messages: conversationMessages
    };

    // Add system prompt if exists
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.top_p !== undefined) body.top_p = options.top_p;

    try {
      const response = await axios.post(
        `${this.baseUrl}/messages`,
        body,
        {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': this.anthropicVersion,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      );

      if (response.data && response.data.content && response.data.content.length > 0) {
        const content = response.data.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('');

        return {
          success: true,
          content,
          finish_reason: response.data.stop_reason || 'end_turn',
          model: response.data.model,
          usage: {
            prompt_tokens: response.data.usage?.input_tokens || 0,
            completion_tokens: response.data.usage?.output_tokens || 0,
            total_tokens: (response.data.usage?.input_tokens || 0) + (response.data.usage?.output_tokens || 0)
          },
          provider: 'anthropic'
        };
      }

      throw new Error('Invalid response format from Anthropic API');
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message,
        provider: 'anthropic'
      };
    }
  }

  async *chatStream(messages, options = {}) {
    const model = options.model || this.defaultModel;
    const maxTokens = options.maxTokens || 4096;

    // Extract system prompt
    let systemPrompt = '';
    const conversationMessages = [];
    
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
      } else {
        conversationMessages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    const body = {
      model,
      max_tokens: maxTokens,
      messages: conversationMessages,
      stream: true
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.top_p !== undefined) body.top_p = options.top_p;

    try {
      const response = await axios.post(
        `${this.baseUrl}/messages`,
        body,
        {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': this.anthropicVersion,
            'Content-Type': 'application/json',
          },
          responseType: 'stream',
          timeout: 120000,
        }
      );

      const stream = response.data;
      const decoder = new TextDecoder();
      let buffer = '';

      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            yield { type: 'done' };
            return;
          }

          try {
            const parsed = JSON.parse(data);
            
            if (parsed.type === 'content_block_delta') {
              const content = parsed.delta?.text || '';
              if (content) yield { type: 'content', content };
            } else if (parsed.type === 'message_stop') {
              yield { type: 'done' };
              return;
            }
          } catch (e) {
            // Skip parse errors
          }
        }
      }

      yield { type: 'done' };
    } catch (error) {
      yield { type: 'error', content: error.response?.data?.error?.message || error.message };
      yield { type: 'done' };
    }
  }

  getAvailableModels() {
    return config.anthropic?.models || [
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', rec: true, tags: ['Latest', 'Balanced'] },
      { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', rec: true, tags: ['Fast', 'Coding'] },
      { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku', tags: ['Fast', 'Light'] },
      { id: 'claude-3-opus-20240229', label: 'Claude 3 Opus', tags: ['Deep Analysis'] },
    ];
  }
}

export default AnthropicProvider;
