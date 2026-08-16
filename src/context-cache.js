import crypto from 'crypto';
import coordinator from './distributed.js';

const DEFAULT_MAX_SIZE = 1000;
const DEFAULT_TTL = 5 * 60 * 1000;
const CLEANUP_INTERVAL = 60 * 1000;

export class ContextCache {
  constructor(options = {}) {
    this.maxSize = options.maxSize || DEFAULT_MAX_SIZE;
    this.defaultTtl = options.defaultTtl || DEFAULT_TTL;
    this._cache = new Map();
    this._stats = { hits: 0, misses: 0, sets: 0, evictions: 0 };

    this._cleanupTimer = setInterval(() => this._evictExpired(), CLEANUP_INTERVAL);

    coordinator.onCacheInvalidate((data) => {
      if (data.key === '*') {
        this.clear();
      } else if (data.key) {
        this._cache.delete(data.key);
      }
    });
  }

  _hash(obj) {
    const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
    return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
  }

  _key(prefix, data) {
    return `${prefix}:${this._hash(data)}`;
  }

  get(key) {
    const entry = this._cache.get(key);
    if (!entry) {
      this._stats.misses++;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      this._stats.misses++;
      return null;
    }
    entry.lastAccess = Date.now();
    this._stats.hits++;
    return entry.value;
  }

  set(key, value, ttl = this.defaultTtl) {
    if (this._cache.size >= this.maxSize) this._evictLRU();
    this._cache.set(key, {
      value,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl,
      lastAccess: Date.now(),
    });
    this._stats.sets++;
    return key;
  }

  getOrSet(key, factory, ttl = this.defaultTtl) {
    const cached = this.get(key);
    if (cached !== null) return cached;
    const value = factory();
    this.set(key, value, ttl);
    return value;
  }

  async getOrSetAsync(key, factory, ttl = this.defaultTtl) {
    const cached = this.get(key);
    if (cached !== null) return cached;
    const value = await factory();
    this.set(key, value, ttl);
    return value;
  }

  has(key) {
    const entry = this._cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      return false;
    }
    return true;
  }

  delete(key) {
    return this._cache.delete(key);
  }

  clear() {
    this._cache.clear();
    this._stats = { hits: 0, misses: 0, sets: 0, evictions: 0 };
  }

  invalidateByPrefix(prefix) {
    const prefixMatch = `${prefix}:`;
    let count = 0;
    for (const key of this._cache.keys()) {
      if (key.startsWith(prefixMatch)) {
        this._cache.delete(key);
        count++;
      }
    }
    return count;
  }

  invalidateAcrossCluster(key) {
    this._cache.delete(key);
    coordinator.invalidateCache(key);
  }

  flushAll() {
    this.clear();
    coordinator.invalidateCache('*');
  }

  _evictExpired() {
    const now = Date.now();
    let count = 0;
    for (const [key, entry] of this._cache) {
      if (now > entry.expiresAt) {
        this._cache.delete(key);
        count++;
      }
    }
    if (count > 0) this._stats.evictions += count;
  }

  _evictLRU() {
    let oldest = null;
    let oldestKey = null;
    for (const [key, entry] of this._cache) {
      if (!oldest || entry.lastAccess < oldest) {
        oldest = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this._cache.delete(oldestKey);
      this._stats.evictions++;
    }
  }

  get size() {
    return this._cache.size;
  }

  getStats() {
    const hitRate = this._stats.hits + this._stats.misses > 0
      ? (this._stats.hits / (this._stats.hits + this._stats.misses) * 100).toFixed(1)
      : '0.0';
    return {
      size: this._cache.size,
      maxSize: this.maxSize,
      defaultTtl: this.defaultTtl,
      hits: this._stats.hits,
      misses: this._stats.misses,
      sets: this._stats.sets,
      evictions: this._stats.evictions,
      hitRate: `${hitRate}%`,
    };
  }

  destroy() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this.clear();
  }
}

const contextCache = new ContextCache();
export default contextCache;
