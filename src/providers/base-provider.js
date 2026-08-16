/**
 * Base Provider Interface - Universal Adapter
 * Ensures ALL providers have the same capabilities
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 2.0.0
 */

export class BaseProvider {
  constructor(config) {
    this.name = config.name || 'UnknownProvider';
    this.apiKey = config.apiKey || '';
    this.baseUrl = config.baseUrl || '';
    this.defaultModel = config.defaultModel || '';
    this.maxTokens = config.maxTokens || 4096;
    this.maxContextTokens = config.maxContextTokens || 128000;
    this.timeout = config.timeout || 60000;
    
    // Universal capabilities
    this.capabilities = {
      streaming: true,
      toolCalling: true,
      largeContext: true,
      vision: false,
      functionCalling: true,
      multiTurn: true,
    };
    
    // Statistics
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalTokens: 0,
      avgLatency: 0,
      lastRequestTime: null,
    };
  }

  /**
   * Check if provider is configured
   */
  isConfigured() {
    return Boolean(this.apiKey && this.baseUrl);
  }

  /**
   * Get provider capabilities
   */
  getCapabilities() {
    return this.capabilities;
  }

  /**
   * Validate messages before sending
   */
  validateMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('Messages must be a non-empty array');
    }
    
    for (const msg of messages) {
      if (!msg.role || !msg.content) {
        throw new Error('Each message must have role and content');
      }
    }
    
    return true;
  }

  /**
   * Smart context chunking for large files
   * Breaks down 50k+ line files into manageable chunks
   */
  chunkLargeContext(content, maxChunkSize = 100000) {
    if (content.length <= maxChunkSize) {
      return [content];
    }

    const chunks = [];
    let currentChunk = '';
    const lines = content.split('\n');
    
    for (const line of lines) {
      if (currentChunk.length + line.length > maxChunkSize) {
        chunks.push(currentChunk);
        currentChunk = line + '\n';
      } else {
        currentChunk += line + '\n';
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk);
    }
    
    return chunks;
  }

  /**
   * Convert tools to provider-specific format
   */
  convertToolsFormat(tools) {
    // Base implementation - override in specific providers
    return tools;
  }

  /**
   * Convert tool calls from provider format to universal format
   */
  parseToolCalls(response) {
    // Base implementation - override in specific providers
    return response.tool_calls || [];
  }

  /**
   * Handle rate limiting with exponential backoff
   */
  async retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        if (error.message.includes('rate limit') || error.response?.status === 429) {
          const delay = baseDelay * Math.pow(2, i);
          await this.sleep(delay);
          continue;
        }
        
        throw error;
      }
    }
    
    throw lastError;
  }

  /**
   * Extract system prompt from messages
   */
  extractSystemPrompt(messages) {
    let systemPrompt = '';
    const conversationMessages = [];
    
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
      } else {
        conversationMessages.push(msg);
      }
    }
    
    return { systemPrompt, conversationMessages };
  }

  /**
   * Estimate token count (rough approximation)
   */
  estimateTokens(text) {
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  /**
   * Truncate messages to fit context window
   */
  truncateMessages(messages, maxTokens) {
    const truncated = [];
    let totalTokens = 0;
    
    // Always keep system message
    const systemMsg = messages.find(m => m.role === 'system');
    if (systemMsg) {
      truncated.push(systemMsg);
      totalTokens += this.estimateTokens(systemMsg.content);
    }
    
    // Add messages from most recent to oldest
    const reversed = [...messages].reverse().filter(m => m.role !== 'system');
    
    for (const msg of reversed) {
      const tokens = this.estimateTokens(msg.content);
      if (totalTokens + tokens > maxTokens) {
        break;
      }
      truncated.unshift(msg);
      totalTokens += tokens;
    }
    
    return { messages: truncated, totalTokens };
  }

  /**
   * Update statistics
   */
  updateStats(success, tokens = 0, latency = 0) {
    this.stats.totalRequests++;
    if (success) {
      this.stats.successfulRequests++;
    } else {
      this.stats.failedRequests++;
    }
    this.stats.totalTokens += tokens;
    this.stats.avgLatency = 
      (this.stats.avgLatency * (this.stats.totalRequests - 1) + latency) / 
      this.stats.totalRequests;
    this.stats.lastRequestTime = new Date().toISOString();
  }

  /**
   * Get provider statistics
   */
  getStats() {
    return {
      ...this.stats,
      successRate: this.stats.totalRequests > 0 
        ? (this.stats.successfulRequests / this.stats.totalRequests * 100).toFixed(2) + '%'
        : '0%',
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalTokens: 0,
      avgLatency: 0,
      lastRequestTime: null,
    };
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const models = await this.getAvailableModels();
      return {
        healthy: models.length > 0,
        provider: this.name,
        modelsAvailable: models.length,
        configured: this.isConfigured(),
        capabilities: this.capabilities,
      };
    } catch (error) {
      return {
        healthy: false,
        provider: this.name,
        error: error.message,
        configured: this.isConfigured(),
      };
    }
  }

  // ==================== METHODS TO IMPLEMENT ====================
  // These must be implemented by each provider

  /**
   * Chat completion - MUST be implemented
   */
  async chat(messages, options = {}) {
    throw new Error(`${this.name}: chat() method not implemented`);
  }

  /**
   * Streaming chat - MUST be implemented
   */
  async *chatStream(messages, options = {}) {
    throw new Error(`${this.name}: chatStream() method not implemented`);
  }

  /**
   * Get available models - MUST be implemented
   */
  async getAvailableModels() {
    throw new Error(`${this.name}: getAvailableModels() method not implemented`);
  }
}

export default BaseProvider;
