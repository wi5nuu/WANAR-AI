/**
 * Advanced Context Manager - Hierarchical Context Windows
 * Simulates 100M+ context through intelligent layering and compression
 * 
 * Architecture:
 * - L1 (Active): 200K tokens - Current conversation window
 * - L2 (Recent): 2M tokens - Last 10-20 conversations with summarization
 * - L3 (Long-term): 100M simulation - Full project knowledge via RAG + embeddings
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 2.0.0
 */

import * as db from './database.js';

export default class AdvancedContextManager {
  constructor(options = {}) {
    // Dynamic context limits based on model capabilities
    this.modelId = options.modelId || 'claude-sonnet-4-6';
    
    // L1: Active context window (immediate conversation) - AUTO-SCALE based on model
    this.l1MaxTokens = this._getModelContextLimit(this.modelId, options.l1MaxTokens);
    this.l1Messages = [];
    
    // L2: Recent context (summarized recent sessions)
    this.l2MaxTokens = options.l2MaxTokens || 5000000; // 5M tokens (increased)
    this.l2Summaries = [];
    this.l2MaxSummaries = options.l2MaxSummaries || 50; // More summaries
    
    // L3: Long-term memory (simulated via RAG + embeddings)
    this.l3Enabled = options.l3Enabled !== false;
    this.l3MaxTokensSimulated = options.l3MaxTokens || 100000000; // 100M simulation
    
    // Smart compression settings - adaptive
    this.compressionRatio = options.compressionRatio || 0.15; // 6.67:1 compression (more aggressive)
    this.summaryModel = options.summaryModel || 'claude-sonnet-4-6';
    
    // Semantic caching for token savings
    this.semanticCache = new Map();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.tokensSaved = 0;
    
    // Priority scoring for context retention
    this.priorityWeights = {
      recency: 0.3,
      relevance: 0.4,
      importance: 0.3
    };
    
    // Statistics
    this.stats = {
      l1Tokens: 0,
      l2Tokens: 0,
      l3Tokens: 0,
      totalMessages: 0,
      compressions: 0,
      retrievals: 0,
      avgRetrievalTime: 0
    };
    
    // Session metadata
    this.sessionId = this.generateSessionId();
    this.sessionStart = Date.now();
    this.lastActivity = Date.now();
  }

  /**
   * Get model context limit dynamically based on model ID
   */
  _getModelContextLimit(modelId, override) {
    if (override) return override;
    
    // Map of model ID to context window size (in tokens)
    const modelLimits = {
      // OpenAgentic Claude models with long context
      'claude-sonnet-4-5-1m': 1000000,      // 1M context
      'claude-sonnet-4-6': 200000,          // 200K
      'claude-sonnet-4-5': 200000,          // 200K
      'claude-opus-4-5': 200000,            // 200K
      'claude-opus-4': 200000,              // 200K
      'claude-3-5-sonnet-20241022': 200000, // 200K
      
      // GPT models
      'gpt-4.5': 128000,                    // 128K
      'gpt-4.1': 128000,                    // 128K
      'gpt-4o': 128000,                     // 128K
      'gpt-4-turbo': 128000,                // 128K
      
      // Gemini models
      'gemini-2.0-flash-exp': 1000000,      // 1M
      'gemini-1.5-pro': 2000000,            // 2M
      'gemini-1.5-flash': 1000000,          // 1M
      
      // DeepSeek
      'deepseek-chat': 64000,               // 64K
      'deepseek-coder': 64000,              // 64K
      
      // Qwen
      'qwen-plus': 32000,                   // 32K
      'qwen-turbo': 8000,                   // 8K
    };
    
    // Check for exact match
    if (modelLimits[modelId]) {
      return modelLimits[modelId];
    }
    
    // Check for partial match (e.g., "claude-sonnet-4-5-20251101" matches "claude-sonnet-4-5")
    for (const [key, limit] of Object.entries(modelLimits)) {
      if (modelId.includes(key)) {
        return limit;
      }
    }
    
    // Default: 200K for unknown models
    return 200000;
  }

  /**
   * Add message to L1 active context
   */
  addMessage(role, content, metadata = {}) {
    const message = {
      role,
      content,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      tokens: this.estimateTokens(content),
      metadata: {
        ...metadata,
        importance: metadata.importance || this.calculateImportance(content),
        tags: metadata.tags || []
      }
    };

    this.l1Messages.push(message);
    this.stats.l1Tokens += message.tokens;
    this.stats.totalMessages++;
    this.lastActivity = Date.now();

    // Check if L1 is approaching capacity
    if (this.stats.l1Tokens > this.l1MaxTokens * 0.8) {
      this.compressL1ToL2();
    }

    return message;
  }

  /**
   * Get messages for API call with intelligent context assembly
   */
  getMessages(systemPrompt = '', userMessage = '', options = {}) {
    const messages = [];

    // 1. System prompt
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // 2. L3: Retrieve relevant long-term context (if enabled)
    if (this.l3Enabled && userMessage) {
      const l3Context = this.retrieveL3Context(userMessage, options);
      if (l3Context && l3Context.length > 0) {
        messages.push({
          role: 'system',
          content: `## Long-term Knowledge (Relevant Context):\n${l3Context}`
        });
        this.stats.retrievals++;
      }
    }

    // 3. L2: Add summarized recent context
    if (this.l2Summaries.length > 0) {
      const l2Context = this.getRelevantL2Summaries(userMessage, 3);
      if (l2Context.length > 0) {
        messages.push({
          role: 'system',
          content: `## Recent Context Summary:\n${l2Context.join('\n\n')}`
        });
      }
    }

    // 4. L1: Add active conversation messages
    const l1Context = this.getL1MessagesForContext(options.maxL1Messages || 20);
    messages.push(...l1Context);

    // 5. Current user message
    if (userMessage) {
      messages.push({ role: 'user', content: userMessage });
    }

    return messages;
  }

  /**
   * Compress L1 to L2 when capacity is reached
   */
  async compressL1ToL2() {
    if (this.l1Messages.length < 4) return; // Need at least 2 turns to summarize

    // Take oldest 50% of L1 messages for compression
    const messagesToCompress = this.l1Messages.splice(0, Math.floor(this.l1Messages.length / 2));
    
    // Generate summary
    const summary = await this.generateSummary(messagesToCompress);
    
    // Add to L2
    this.l2Summaries.push({
      summary,
      messageCount: messagesToCompress.length,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      tokens: this.estimateTokens(summary),
      originalTokens: messagesToCompress.reduce((sum, m) => sum + m.tokens, 0)
    });

    // Update stats
    this.stats.compressions++;
    this.stats.l2Tokens = this.l2Summaries.reduce((sum, s) => sum + s.tokens, 0);
    this.stats.l1Tokens = this.l1Messages.reduce((sum, m) => sum + m.tokens, 0);

    // Trim L2 if needed
    if (this.l2Summaries.length > this.l2MaxSummaries) {
      const removed = this.l2Summaries.shift();
      this.stats.l2Tokens -= removed.tokens;
      
      // Archive to L3 (database or vector store)
      this.archiveToL3(removed);
    }
  }

  /**
   * Generate intelligent summary of messages
   */
  async generateSummary(messages) {
    if (messages.length === 0) return '';

    // Extract key information
    const conversation = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');
    
    // Simple heuristic summary (in production, use AI model for better summaries)
    const summary = `**Session ${this.sessionId} (${messages.length} messages)**\n` +
      `Topics discussed: ${this.extractTopics(messages).join(', ')}\n` +
      `Key decisions: ${this.extractDecisions(messages).join('; ')}\n` +
      `Technical details: ${this.extractTechnicalDetails(messages)}\n` +
      `Timestamp: ${new Date(messages[0].timestamp).toISOString()}`;

    return summary;
  }

  /**
   * Extract topics from messages
   */
  extractTopics(messages) {
    const topics = new Set();
    const keywords = [
      'provider', 'model', 'api', 'context', 'token', 'enterprise',
      'security', 'performance', 'cache', 'database', 'deployment',
      'configuration', 'authentication', 'optimization'
    ];

    messages.forEach(m => {
      const content = m.content.toLowerCase();
      keywords.forEach(keyword => {
        if (content.includes(keyword)) topics.add(keyword);
      });
    });

    return Array.from(topics);
  }

  /**
   * Extract decisions from messages
   */
  extractDecisions(messages) {
    const decisions = [];
    const decisionPatterns = [
      /decided to (.+?)[\.\n]/gi,
      /will (.+?)[\.\n]/gi,
      /implemented (.+?)[\.\n]/gi,
      /changed (.+?)[\.\n]/gi,
      /updated (.+?)[\.\n]/gi
    ];

    messages.forEach(m => {
      if (m.role === 'assistant') {
        decisionPatterns.forEach(pattern => {
          const matches = m.content.match(pattern);
          if (matches) {
            matches.forEach(match => decisions.push(match.slice(0, 100)));
          }
        });
      }
    });

    return decisions.slice(0, 5); // Top 5 decisions
  }

  /**
   * Extract technical details
   */
  extractTechnicalDetails(messages) {
    const technical = [];
    const patterns = [
      /`([^`]+)`/g, // Inline code
      /```[\s\S]*?```/g, // Code blocks
      /\b[A-Z][a-zA-Z]+(?:Manager|Provider|Service|Controller|Handler)\b/g // Class names
    ];

    messages.forEach(m => {
      patterns.forEach(pattern => {
        const matches = m.content.match(pattern);
        if (matches) technical.push(...matches.slice(0, 3));
      });
    });

    return technical.slice(0, 5).join(', ') || 'General discussion';
  }

  /**
   * Retrieve relevant L3 context using semantic search
   */
  retrieveL3Context(query, options = {}) {
    const startTime = Date.now();
    
    // In production: Use vector database (ChromaDB/Pinecone) for semantic search
    // For now: Simple keyword-based retrieval from database
    const relevantContext = [];
    
    try {
      // Query database for relevant historical context
      const keywords = this.extractKeywords(query);
      const sessions = db.searchSessions?.(keywords, options.limit || 5) || [];
      
      sessions.forEach(session => {
        relevantContext.push(`[${new Date(session.timestamp).toLocaleDateString()}] ${session.summary}`);
      });
    } catch (error) {
      console.error('[Context Manager] L3 retrieval error:', error.message);
    }

    // Update stats
    const retrievalTime = Date.now() - startTime;
    if (this.stats.retrievals === 0) {
      this.stats.avgRetrievalTime = retrievalTime;
    } else {
      this.stats.avgRetrievalTime = (this.stats.avgRetrievalTime * this.stats.retrievals + retrievalTime) / (this.stats.retrievals + 1);
    }

    return relevantContext.join('\n\n');
  }

  /**
   * Get relevant L2 summaries based on query
   */
  getRelevantL2Summaries(query, limit = 3) {
    if (!query || this.l2Summaries.length === 0) return [];

    const keywords = this.extractKeywords(query);
    
    // Score summaries by relevance
    const scored = this.l2Summaries.map(summary => {
      const relevanceScore = this.calculateRelevanceScore(summary.summary, keywords);
      const recencyScore = (Date.now() - summary.timestamp) / (1000 * 60 * 60 * 24); // Days ago
      
      return {
        summary: summary.summary,
        score: relevanceScore * 0.7 + (1 / (recencyScore + 1)) * 0.3
      };
    });

    // Sort by score and return top N
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => item.summary);
  }

  /**
   * Get L1 messages for context
   */
  getL1MessagesForContext(maxMessages = 20) {
    const messages = this.l1Messages.slice(-maxMessages);
    return messages.map(m => ({
      role: m.role,
      content: m.content
    }));
  }

  /**
   * Archive L2 summary to L3 (long-term storage)
   */
  archiveToL3(summary) {
    try {
      db.archiveSummary?.({
        sessionId: summary.sessionId,
        summary: summary.summary,
        messageCount: summary.messageCount,
        tokens: summary.tokens,
        originalTokens: summary.originalTokens,
        timestamp: summary.timestamp,
        compressionRatio: summary.tokens / summary.originalTokens
      });
      
      this.stats.l3Tokens += summary.tokens;
    } catch (error) {
      console.error('[Context Manager] L3 archival error:', error.message);
    }
  }

  /**
   * Calculate importance score for message
   */
  calculateImportance(content) {
    let score = 0.5; // Base importance

    // Boost for code blocks
    if (content.includes('```')) score += 0.2;
    
    // Boost for questions
    if (content.includes('?')) score += 0.1;
    
    // Boost for technical keywords
    const technicalKeywords = ['error', 'bug', 'fix', 'implement', 'optimize', 'security', 'performance'];
    technicalKeywords.forEach(keyword => {
      if (content.toLowerCase().includes(keyword)) score += 0.05;
    });

    // Boost for long, detailed messages
    if (content.length > 500) score += 0.1;

    return Math.min(score, 1.0);
  }

  /**
   * Extract keywords from text
   */
  extractKeywords(text) {
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
    const words = text.toLowerCase().match(/\b\w+\b/g) || [];
    
    return words
      .filter(word => word.length > 3 && !stopWords.has(word))
      .slice(0, 10);
  }

  /**
   * Calculate relevance score between text and keywords
   */
  calculateRelevanceScore(text, keywords) {
    const textLower = text.toLowerCase();
    const matches = keywords.filter(keyword => textLower.includes(keyword)).length;
    return matches / Math.max(keywords.length, 1);
  }

  /**
   * Estimate tokens (simple heuristic: ~4 chars per token)
   */
  estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Semantic cache check - returns cached response if similar query exists
   * This saves tokens by avoiding re-processing similar queries
   */
  checkSemanticCache(query, similarityThreshold = 0.85) {
    const queryNormalized = this._normalizeQuery(query);
    const queryTokens = this._tokenizeQuery(queryNormalized);
    
    for (const [cachedQuery, cachedData] of this.semanticCache.entries()) {
      const cachedTokens = this._tokenizeQuery(cachedQuery);
      const similarity = this._calculateSimilarity(queryTokens, cachedTokens);
      
      if (similarity >= similarityThreshold) {
        // Check if cache is still fresh (within 1 hour)
        if (Date.now() - cachedData.timestamp < 3600000) {
          this.cacheHits++;
          this.tokensSaved += cachedData.tokens;
          return cachedData.response;
        }
      }
    }
    
    this.cacheMisses++;
    return null;
  }

  /**
   * Store response in semantic cache
   */
  storeInSemanticCache(query, response, tokens) {
    const queryNormalized = this._normalizeQuery(query);
    
    // Limit cache size to 100 entries
    if (this.semanticCache.size >= 100) {
      // Remove oldest entry
      const firstKey = this.semanticCache.keys().next().value;
      this.semanticCache.delete(firstKey);
    }
    
    this.semanticCache.set(queryNormalized, {
      response,
      tokens,
      timestamp: Date.now()
    });
  }

  /**
   * Normalize query for better cache matching
   */
  _normalizeQuery(query) {
    return query.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Tokenize query into words
   */
  _tokenizeQuery(query) {
    return query.split(' ').filter(w => w.length > 2);
  }

  /**
   * Calculate similarity between two token arrays (Jaccard similarity)
   */
  _calculateSimilarity(tokens1, tokens2) {
    const set1 = new Set(tokens1);
    const set2 = new Set(tokens2);
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size;
  }

  /**
   * Smart code chunking for reading large full-stack codebases
   * Chunks code intelligently by preserving function/class boundaries
   */
  chunkCodeForContext(code, maxChunkTokens = 4000) {
    const chunks = [];
    const lines = code.split('\n');
    let currentChunk = [];
    let currentTokens = 0;
    let inFunction = false;
    let braceCount = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineTokens = this.estimateTokens(line);
      
      // Detect function/class boundaries
      if (line.match(/^(function|class|const\s+\w+\s*=\s*(async\s+)?function|export\s+(async\s+)?function)/)) {
        inFunction = true;
      }
      
      // Track braces for function end detection
      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;
      
      if (braceCount === 0 && inFunction) {
        inFunction = false;
      }
      
      // If adding this line would exceed limit and we're not in a function, start new chunk
      if (currentTokens + lineTokens > maxChunkTokens && !inFunction && currentChunk.length > 0) {
        chunks.push({
          content: currentChunk.join('\n'),
          tokens: currentTokens,
          startLine: i - currentChunk.length + 1,
          endLine: i
        });
        currentChunk = [];
        currentTokens = 0;
      }
      
      currentChunk.push(line);
      currentTokens += lineTokens;
    }
    
    // Add remaining chunk
    if (currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.join('\n'),
        tokens: currentTokens,
        startLine: lines.length - currentChunk.length + 1,
        endLine: lines.length
      });
    }
    
    return chunks;
  }

  /**
   * Intelligent prompt compression - removes redundancy while preserving meaning
   */
  compressPrompt(prompt, targetCompressionRatio = 0.7) {
    // Step 1: Remove excessive whitespace
    let compressed = prompt.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ');
    
    // Step 2: Remove redundant phrases
    const redundantPhrases = [
      /please\s+/gi,
      /kindly\s+/gi,
      /I would like to\s+/gi,
      /Could you\s+/gi,
      /Can you\s+/gi,
    ];
    
    redundantPhrases.forEach(pattern => {
      compressed = compressed.replace(pattern, '');
    });
    
    // Step 3: Compress code comments if present
    compressed = compressed.replace(/\/\/[^\n]*/g, match => {
      // Keep important comments (TODO, FIXME, NOTE)
      if (match.match(/\b(TODO|FIXME|NOTE|IMPORTANT)\b/i)) {
        return match;
      }
      return '';
    });
    
    // Step 4: If still too long, apply more aggressive compression
    const currentRatio = this.estimateTokens(compressed) / this.estimateTokens(prompt);
    if (currentRatio > targetCompressionRatio) {
      // Extract key sentences (first sentence of each paragraph)
      const paragraphs = compressed.split('\n\n');
      compressed = paragraphs.map(p => {
        const sentences = p.split(/[.!?]+/);
        return sentences[0] + (sentences.length > 1 ? '...' : '');
      }).join('\n\n');
    }
    
    return compressed.trim();
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const totalRequests = this.cacheHits + this.cacheMisses;
    const hitRate = totalRequests > 0 ? (this.cacheHits / totalRequests * 100).toFixed(2) : '0.00';
    
    return {
      cacheSize: this.semanticCache.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      hitRate: `${hitRate}%`,
      tokensSaved: this.tokensSaved,
      estimatedCostSaved: (this.tokensSaved * 0.000003).toFixed(4) // Rough estimate: $3/1M tokens
    };
  }

  /**
   * Generate unique session ID
   */
  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get current statistics with cache info
   */
  getStats() {
    const cacheStats = this.getCacheStats();
    return {
      ...this.stats,
      totalTokens: this.stats.l1Tokens + this.stats.l2Tokens + this.stats.l3Tokens,
      l1Messages: this.l1Messages.length,
      l2Summaries: this.l2Summaries.length,
      sessionDuration: Date.now() - this.sessionStart,
      compressionEfficiency: this.stats.compressions > 0 
        ? ((1 - this.compressionRatio) * 100).toFixed(2) + '%'
        : 'N/A',
      cache: cacheStats,
      contextLimit: this.l1MaxTokens
    };
  }

  /**
   * Get context info for debugging (enhanced with model and cache info)
   */
  getContextInfo() {
    const cacheStats = this.getCacheStats();
    return {
      sessionId: this.sessionId,
      modelId: this.modelId,
      layers: {
        l1: {
          name: 'Active Context',
          messages: this.l1Messages.length,
          tokens: this.stats.l1Tokens,
          capacity: this.l1MaxTokens,
          usage: ((this.stats.l1Tokens / this.l1MaxTokens) * 100).toFixed(2) + '%'
        },
        l2: {
          name: 'Recent Context',
          summaries: this.l2Summaries.length,
          tokens: this.stats.l2Tokens,
          capacity: this.l2MaxTokens,
          usage: ((this.stats.l2Tokens / this.l2MaxTokens) * 100).toFixed(2) + '%'
        },
        l3: {
          name: 'Long-term Memory',
          enabled: this.l3Enabled,
          tokens: this.stats.l3Tokens,
          simulated: this.l3MaxTokensSimulated,
          retrievals: this.stats.retrievals,
          avgRetrievalTime: Math.round(this.stats.avgRetrievalTime) + 'ms'
        }
      },
      performance: {
        compressions: this.stats.compressions,
        totalMessages: this.stats.totalMessages,
        sessionDuration: Math.round((Date.now() - this.sessionStart) / 1000) + 's'
      }
    };
  }

  /**
   * Clear L1 active context
   */
  clearL1() {
    this.l1Messages = [];
    this.stats.l1Tokens = 0;
  }

  /**
   * Clear all context
   */
  clearAll() {
    this.l1Messages = [];
    this.l2Summaries = [];
    this.stats.l1Tokens = 0;
    this.stats.l2Tokens = 0;
    this.sessionId = this.generateSessionId();
    this.sessionStart = Date.now();
  }

  /**
   * Export context for backup/analysis
   */
  exportContext() {
    return {
      sessionId: this.sessionId,
      sessionStart: this.sessionStart,
      l1Messages: this.l1Messages,
      l2Summaries: this.l2Summaries,
      stats: this.getStats()
    };
  }

  /**
   * Import context from backup
   */
  importContext(data) {
    if (!data || !data.sessionId) {
      throw new Error('Invalid context data');
    }

    this.sessionId = data.sessionId;
    this.sessionStart = data.sessionStart || Date.now();
    this.l1Messages = data.l1Messages || [];
    this.l2Summaries = data.l2Summaries || [];
    
    // Recalculate stats
    this.stats.l1Tokens = this.l1Messages.reduce((sum, m) => sum + m.tokens, 0);
    this.stats.l2Tokens = this.l2Summaries.reduce((sum, s) => sum + s.tokens, 0);
  }
}
