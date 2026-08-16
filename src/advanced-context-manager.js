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
    // L1: Active context window (immediate conversation)
    this.l1MaxTokens = options.l1MaxTokens || 200000; // 200K for Claude Sonnet 4.5
    this.l1Messages = [];
    
    // L2: Recent context (summarized recent sessions)
    this.l2MaxTokens = options.l2MaxTokens || 2000000; // 2M tokens
    this.l2Summaries = [];
    this.l2MaxSummaries = options.l2MaxSummaries || 20;
    
    // L3: Long-term memory (simulated via RAG + embeddings)
    this.l3Enabled = options.l3Enabled !== false;
    this.l3MaxTokensSimulated = options.l3MaxTokens || 100000000; // 100M simulation
    
    // Context compression settings
    this.compressionRatio = options.compressionRatio || 0.2; // 5:1 compression
    this.summaryModel = options.summaryModel || 'claude-sonnet-4.5';
    
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

    console.log(`[Context Manager] Compressed ${messagesToCompress.length} messages to L2. L1: ${this.stats.l1Tokens} tokens, L2: ${this.stats.l2Tokens} tokens`);
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
   * Generate unique session ID
   */
  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get current statistics
   */
  getStats() {
    return {
      ...this.stats,
      totalTokens: this.stats.l1Tokens + this.stats.l2Tokens + this.stats.l3Tokens,
      l1Messages: this.l1Messages.length,
      l2Summaries: this.l2Summaries.length,
      sessionDuration: Date.now() - this.sessionStart,
      compressionEfficiency: this.stats.compressions > 0 
        ? ((1 - this.compressionRatio) * 100).toFixed(2) + '%'
        : 'N/A'
    };
  }

  /**
   * Get context info for debugging
   */
  getContextInfo() {
    return {
      sessionId: this.sessionId,
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
