/**
 * Semantic Cache System - Advanced Response Caching
 * Implements both exact match and semantic similarity caching
 * 
 * Features:
 * - Exact match cache (fast hash-based lookup)
 * - Semantic cache (embedding-based similarity matching)
 * - TTL (Time To Live) management
 * - LRU (Least Recently Used) eviction
 * - Cache warming & preloading
 * - Analytics & hit rate tracking
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 2.0.0
 */

export default class SemanticCache {
  constructor(options = {}) {
    // Exact match cache (hash-based)
    this.exactCache = new Map();
    this.exactCacheMaxSize = options.exactCacheMaxSize || 1000;
    
    // Semantic cache (embedding-based)
    this.semanticCache = [];
    this.semanticCacheMaxSize = options.semanticCacheMaxSize || 500;
    this.semanticThreshold = options.semanticThreshold || 0.85; // 85% similarity
    
    // TTL settings (in milliseconds)
    this.defaultTTL = options.defaultTTL || 3600000; // 1 hour
    this.maxTTL = options.maxTTL || 86400000; // 24 hours
    
    // Cache strategy
    this.evictionStrategy = options.evictionStrategy || 'lru'; // 'lru', 'lfu', 'ttl'
    
    // Statistics
    this.stats = {
      exactHits: 0,
      semanticHits: 0,
      misses: 0,
      evictions: 0,
      writes: 0,
      totalRequests: 0,
      avgRetrievalTime: 0,
      hitRate: 0
    };
    
    // Cache warming
    this.warmingEnabled = options.warmingEnabled !== false;
    this.commonQueries = [];
    
    // Background cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Every minute
  }

  /**
   * Get cached response (checks exact then semantic)
   */
  async get(query, options = {}) {
    const startTime = Date.now();
    this.stats.totalRequests++;

    // 1. Try exact match first (fastest)
    const exactResult = this.getExact(query);
    if (exactResult) {
      this.stats.exactHits++;
      this.updateHitRate();
      this.updateRetrievalTime(Date.now() - startTime);
      return {
        hit: true,
        type: 'exact',
        response: exactResult.response,
        metadata: exactResult.metadata,
        age: Date.now() - exactResult.timestamp
      };
    }

    // 2. Try semantic match (slower but more flexible)
    if (options.semanticSearch !== false) {
      const semanticResult = await this.getSemantic(query);
      if (semanticResult) {
        this.stats.semanticHits++;
        this.updateHitRate();
        this.updateRetrievalTime(Date.now() - startTime);
        return {
          hit: true,
          type: 'semantic',
          response: semanticResult.response,
          metadata: semanticResult.metadata,
          similarity: semanticResult.similarity,
          age: Date.now() - semanticResult.timestamp
        };
      }
    }

    // 3. Cache miss
    this.stats.misses++;
    this.updateHitRate();
    this.updateRetrievalTime(Date.now() - startTime);
    
    return {
      hit: false,
      type: 'miss'
    };
  }

  /**
   * Get exact match from cache
   */
  getExact(query) {
    const key = this.generateKey(query);
    const entry = this.exactCache.get(key);
    
    if (!entry) return null;
    
    // Check TTL
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.exactCache.delete(key);
      return null;
    }
    
    // Update access metadata (for LRU/LFU)
    entry.lastAccessed = Date.now();
    entry.accessCount++;
    
    return entry;
  }

  /**
   * Get semantic match from cache
   */
  async getSemantic(query) {
    if (this.semanticCache.length === 0) return null;
    
    const queryEmbedding = this.generateEmbedding(query);
    let bestMatch = null;
    let bestSimilarity = 0;
    
    for (const entry of this.semanticCache) {
      // Check TTL first
      if (Date.now() - entry.timestamp > entry.ttl) continue;
      
      const similarity = this.cosineSimilarity(queryEmbedding, entry.embedding);
      
      if (similarity > bestSimilarity && similarity >= this.semanticThreshold) {
        bestSimilarity = similarity;
        bestMatch = entry;
      }
    }
    
    if (bestMatch) {
      // Update access metadata
      bestMatch.lastAccessed = Date.now();
      bestMatch.accessCount++;
      
      return {
        ...bestMatch,
        similarity: bestSimilarity
      };
    }
    
    return null;
  }

  /**
   * Set cache entry
   */
  async set(query, response, options = {}) {
    const ttl = options.ttl || this.defaultTTL;
    const metadata = options.metadata || {};
    const timestamp = Date.now();
    
    // 1. Store in exact cache
    const key = this.generateKey(query);
    const exactEntry = {
      query,
      response,
      metadata,
      timestamp,
      ttl,
      lastAccessed: timestamp,
      accessCount: 0
    };
    
    this.exactCache.set(key, exactEntry);
    
    // Check exact cache size and evict if needed
    if (this.exactCache.size > this.exactCacheMaxSize) {
      this.evictExact();
    }
    
    // 2. Store in semantic cache (if enabled)
    if (options.semanticCache !== false) {
      const embedding = this.generateEmbedding(query);
      const semanticEntry = {
        query,
        response,
        metadata,
        timestamp,
        ttl,
        embedding,
        lastAccessed: timestamp,
        accessCount: 0
      };
      
      this.semanticCache.push(semanticEntry);
      
      // Check semantic cache size and evict if needed
      if (this.semanticCache.length > this.semanticCacheMaxSize) {
        this.evictSemantic();
      }
    }
    
    this.stats.writes++;
  }

  /**
   * Generate cache key (hash)
   */
  generateKey(query) {
    // Simple hash function (in production, use crypto.createHash)
    let hash = 0;
    const str = typeof query === 'string' ? query : JSON.stringify(query);
    
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    return hash.toString(36);
  }

  /**
   * Generate embedding for semantic search
   * In production: Use actual embedding model (OpenAI, Cohere, etc.)
   * For now: Simple TF-IDF-like representation
   */
  generateEmbedding(text) {
    const str = typeof text === 'string' ? text.toLowerCase() : JSON.stringify(text).toLowerCase();
    
    // Simple word frequency vector (128 dimensions)
    const embedding = new Array(128).fill(0);
    const words = str.match(/\b\w+\b/g) || [];
    
    words.forEach(word => {
      // Hash word to embedding dimension
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash) + word.charCodeAt(i);
        hash = hash & hash;
      }
      const dim = Math.abs(hash) % 128;
      embedding[dim]++;
    });
    
    // Normalize
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    return magnitude > 0 ? embedding.map(val => val / magnitude) : embedding;
  }

  /**
   * Calculate cosine similarity between embeddings
   */
  cosineSimilarity(embedding1, embedding2) {
    if (embedding1.length !== embedding2.length) return 0;
    
    let dotProduct = 0;
    let mag1 = 0;
    let mag2 = 0;
    
    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      mag1 += embedding1[i] * embedding1[i];
      mag2 += embedding2[i] * embedding2[i];
    }
    
    mag1 = Math.sqrt(mag1);
    mag2 = Math.sqrt(mag2);
    
    if (mag1 === 0 || mag2 === 0) return 0;
    
    return dotProduct / (mag1 * mag2);
  }

  /**
   * Evict entry from exact cache
   */
  evictExact() {
    let keyToEvict = null;
    
    switch (this.evictionStrategy) {
      case 'lru': // Least Recently Used
        let oldestAccess = Infinity;
        for (const [key, entry] of this.exactCache.entries()) {
          if (entry.lastAccessed < oldestAccess) {
            oldestAccess = entry.lastAccessed;
            keyToEvict = key;
          }
        }
        break;
        
      case 'lfu': // Least Frequently Used
        let lowestCount = Infinity;
        for (const [key, entry] of this.exactCache.entries()) {
          if (entry.accessCount < lowestCount) {
            lowestCount = entry.accessCount;
            keyToEvict = key;
          }
        }
        break;
        
      case 'ttl': // Earliest expiration
        let earliestExpiry = Infinity;
        for (const [key, entry] of this.exactCache.entries()) {
          const expiry = entry.timestamp + entry.ttl;
          if (expiry < earliestExpiry) {
            earliestExpiry = expiry;
            keyToEvict = key;
          }
        }
        break;
        
      default: // LRU fallback
        const firstKey = this.exactCache.keys().next().value;
        keyToEvict = firstKey;
    }
    
    if (keyToEvict) {
      this.exactCache.delete(keyToEvict);
      this.stats.evictions++;
    }
  }

  /**
   * Evict entry from semantic cache
   */
  evictSemantic() {
    let indexToEvict = 0;
    
    switch (this.evictionStrategy) {
      case 'lru':
        let oldestAccess = Infinity;
        this.semanticCache.forEach((entry, index) => {
          if (entry.lastAccessed < oldestAccess) {
            oldestAccess = entry.lastAccessed;
            indexToEvict = index;
          }
        });
        break;
        
      case 'lfu':
        let lowestCount = Infinity;
        this.semanticCache.forEach((entry, index) => {
          if (entry.accessCount < lowestCount) {
            lowestCount = entry.accessCount;
            indexToEvict = index;
          }
        });
        break;
        
      case 'ttl':
        let earliestExpiry = Infinity;
        this.semanticCache.forEach((entry, index) => {
          const expiry = entry.timestamp + entry.ttl;
          if (expiry < earliestExpiry) {
            earliestExpiry = expiry;
            indexToEvict = index;
          }
        });
        break;
        
      default:
        indexToEvict = 0; // Remove oldest
    }
    
    this.semanticCache.splice(indexToEvict, 1);
    this.stats.evictions++;
  }

  /**
   * Cleanup expired entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    // Cleanup exact cache
    for (const [key, entry] of this.exactCache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.exactCache.delete(key);
        cleaned++;
      }
    }
    
    // Cleanup semantic cache
    this.semanticCache = this.semanticCache.filter(entry => {
      const expired = now - entry.timestamp > entry.ttl;
      if (expired) cleaned++;
      return !expired;
    });
    
    if (cleaned > 0) {
      console.log(`[Semantic Cache] Cleaned up ${cleaned} expired entries`);
    }
  }

  /**
   * Warm cache with common queries
   */
  async warmCache(queries, getResponseFn) {
    if (!this.warmingEnabled) return;
    
    console.log(`[Semantic Cache] Warming cache with ${queries.length} queries...`);
    
    for (const query of queries) {
      try {
        const response = await getResponseFn(query);
        await this.set(query, response, { ttl: this.maxTTL });
      } catch (error) {
        console.error(`[Semantic Cache] Failed to warm cache for query:`, error.message);
      }
    }
    
    console.log(`[Semantic Cache] Cache warming complete`);
  }

  /**
   * Update hit rate
   */
  updateHitRate() {
    const hits = this.stats.exactHits + this.stats.semanticHits;
    this.stats.hitRate = this.stats.totalRequests > 0 
      ? (hits / this.stats.totalRequests * 100) 
      : 0;
  }

  /**
   * Update average retrieval time
   */
  updateRetrievalTime(time) {
    if (this.stats.totalRequests === 1) {
      this.stats.avgRetrievalTime = time;
    } else {
      this.stats.avgRetrievalTime = (this.stats.avgRetrievalTime * (this.stats.totalRequests - 1) + time) / this.stats.totalRequests;
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      ...this.stats,
      hitRate: this.stats.hitRate.toFixed(2) + '%',
      exactCacheSize: this.exactCache.size,
      semanticCacheSize: this.semanticCache.length,
      exactCacheCapacity: this.exactCacheMaxSize,
      semanticCacheCapacity: this.semanticCacheMaxSize,
      avgRetrievalTime: Math.round(this.stats.avgRetrievalTime) + 'ms',
      evictionStrategy: this.evictionStrategy,
      semanticThreshold: (this.semanticThreshold * 100).toFixed(0) + '%'
    };
  }

  /**
   * Clear all cache
   */
  clear() {
    this.exactCache.clear();
    this.semanticCache = [];
    console.log('[Semantic Cache] All caches cleared');
  }

  /**
   * Clear exact cache only
   */
  clearExact() {
    this.exactCache.clear();
    console.log('[Semantic Cache] Exact cache cleared');
  }

  /**
   * Clear semantic cache only
   */
  clearSemantic() {
    this.semanticCache = [];
    console.log('[Semantic Cache] Semantic cache cleared');
  }

  /**
   * Invalidate specific query
   */
  invalidate(query) {
    const key = this.generateKey(query);
    const exactRemoved = this.exactCache.delete(key);
    
    const semanticIndex = this.semanticCache.findIndex(entry => entry.query === query);
    const semanticRemoved = semanticIndex !== -1;
    if (semanticRemoved) {
      this.semanticCache.splice(semanticIndex, 1);
    }
    
    return { exactRemoved, semanticRemoved };
  }

  /**
   * Get cache entries (for debugging/analysis)
   */
  getEntries(type = 'all') {
    const entries = [];
    
    if (type === 'exact' || type === 'all') {
      for (const [key, entry] of this.exactCache.entries()) {
        entries.push({
          type: 'exact',
          key,
          query: entry.query,
          age: Date.now() - entry.timestamp,
          accessCount: entry.accessCount,
          ttl: entry.ttl
        });
      }
    }
    
    if (type === 'semantic' || type === 'all') {
      this.semanticCache.forEach(entry => {
        entries.push({
          type: 'semantic',
          query: entry.query,
          age: Date.now() - entry.timestamp,
          accessCount: entry.accessCount,
          ttl: entry.ttl
        });
      });
    }
    
    return entries;
  }

  /**
   * Cleanup on destroy
   */
  destroy() {
    clearInterval(this.cleanupInterval);
    this.clear();
  }
}
