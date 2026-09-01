/**
 * Enhanced Base Provider with Advanced Error Handling & Resilience
 * Adds circuit breaker, intelligent retry, and health monitoring
 * 
 * @author Wisnu Alfian Nur Ashar & Siti Nurfadhila Az Zahra Syam
 * @version 3.0.0
 */

import { BaseProvider } from './base-provider.js';

/**
 * Circuit Breaker States
 */
const CircuitState = {
  CLOSED: 'CLOSED',     // Normal operation
  OPEN: 'OPEN',         // Failing, reject requests
  HALF_OPEN: 'HALF_OPEN' // Testing if recovered
};

/**
 * Error Classification
 */
const ErrorType = {
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  AUTH: 'AUTH',
  SERVER: 'SERVER',
  INVALID_REQUEST: 'INVALID_REQUEST',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  UNKNOWN: 'UNKNOWN'
};

export class EnhancedBaseProvider extends BaseProvider {
  constructor(config) {
    super(config);
    
    // Circuit breaker configuration
    this.circuit = {
      state: CircuitState.CLOSED,
      failureCount: 0,
      successCount: 0,
      lastFailureTime: null,
      failureThreshold: config.failureThreshold || 5,
      successThreshold: config.successThreshold || 2,
      timeout: config.circuitTimeout || 60000, // 1 minute
      halfOpenRequests: 0,
      maxHalfOpenRequests: 3
    };

    // Enhanced retry configuration
    this.retryConfig = {
      maxAttempts: config.maxRetryAttempts || 5,
      baseDelay: config.baseRetryDelay || 1000,
      maxDelay: config.maxRetryDelay || 30000,
      exponentialBase: 2,
      jitterFactor: 0.1 // 10% random jitter
    };

    // Health monitoring
    this.health = {
      status: 'unknown',
      lastCheck: null,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      uptime: 0,
      lastError: null
    };

    // Enhanced statistics
    this.enhancedStats = {
      ...this.stats,
      errorsByType: {},
      retries: 0,
      circuitBreaks: 0,
      avgResponseTime: 0,
      p95ResponseTime: 0,
      p99ResponseTime: 0,
      responseTimes: []
    };
  }

  /**
   * Classify error type for intelligent handling
   */
  classifyError(error) {
    const message = error.message?.toLowerCase() || '';
    const status = error.response?.status || error.status;

    if (status === 429 || message.includes('rate limit')) {
      return ErrorType.RATE_LIMIT;
    }
    if (status === 401 || status === 403 || message.includes('auth')) {
      return ErrorType.AUTH;
    }
    if (status === 404 && message.includes('model')) {
      return ErrorType.MODEL_NOT_FOUND;
    }
    if (status === 400 || status === 422) {
      return ErrorType.INVALID_REQUEST;
    }
    if (message.includes('timeout') || message.includes('timed out')) {
      return ErrorType.TIMEOUT;
    }
    if (message.includes('quota') || message.includes('limit exceeded')) {
      return ErrorType.QUOTA_EXCEEDED;
    }
    if (status >= 500 || message.includes('network') || message.includes('econnrefused')) {
      return ErrorType.SERVER;
    }
    if (message.includes('network') || message.includes('fetch')) {
      return ErrorType.NETWORK;
    }
    return ErrorType.UNKNOWN;
  }

  /**
   * Check if error is retryable
   */
  isRetryableError(errorType) {
    return [
      ErrorType.RATE_LIMIT,
      ErrorType.TIMEOUT,
      ErrorType.NETWORK,
      ErrorType.SERVER
    ].includes(errorType);
  }

  /**
   * Calculate delay with exponential backoff and jitter
   */
  calculateDelay(attemptNumber) {
    const exponentialDelay = this.retryConfig.baseDelay * 
      Math.pow(this.retryConfig.exponentialBase, attemptNumber - 1);
    
    const cappedDelay = Math.min(exponentialDelay, this.retryConfig.maxDelay);
    
    // Add jitter to prevent thundering herd
    const jitter = cappedDelay * this.retryConfig.jitterFactor * (Math.random() - 0.5);
    
    return Math.floor(cappedDelay + jitter);
  }

  /**
   * Enhanced retry with exponential backoff, jitter, and circuit breaker
   */
  async retryWithEnhancedBackoff(fn, context = {}) {
    let lastError;
    const startTime = Date.now();

    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt++) {
      try {
        // Check circuit breaker
        if (!this.canMakeRequest()) {
          throw new Error(
            `Circuit breaker is OPEN for ${this.name}. ` +
            `Provider is temporarily unavailable. Try again in ${
              Math.ceil((this.circuit.timeout - (Date.now() - this.circuit.lastFailureTime)) / 1000)
            }s`
          );
        }

        const result = await fn();
        
        // Success - update circuit breaker
        this.recordSuccess();
        
        // Record performance
        const latency = Date.now() - startTime;
        this.recordPerformance(latency);
        
        if (attempt > 1) {
          this.enhancedStats.retries++;
        }

        return result;

      } catch (error) {
        lastError = error;
        const errorType = this.classifyError(error);
        
        // Track error by type
        this.enhancedStats.errorsByType[errorType] = 
          (this.enhancedStats.errorsByType[errorType] || 0) + 1;

        // Record failure
        this.recordFailure(error);

        // Don't retry non-retryable errors
        if (!this.isRetryableError(errorType)) {
          throw this.enhanceError(error, errorType, attempt);
        }

        // Don't retry if we're out of attempts
        if (attempt >= this.retryConfig.maxAttempts) {
          throw this.enhanceError(error, errorType, attempt);
        }

        // Calculate delay based on error type
        let delay = this.calculateDelay(attempt);
        
        // Special handling for rate limits
        if (errorType === ErrorType.RATE_LIMIT) {
          const retryAfter = error.response?.headers?.['retry-after'];
          if (retryAfter) {
            delay = parseInt(retryAfter) * 1000;
          } else {
            delay = Math.min(delay * 2, this.retryConfig.maxDelay);
          }
        }

        // Log retry attempt
        if (context.verbose) {
          console.log(
            `${this.name} retry ${attempt}/${this.retryConfig.maxAttempts} ` +
            `after ${delay}ms (${errorType})`
          );
        }

        await this.sleep(delay);
      }
    }

    throw this.enhanceError(lastError, this.classifyError(lastError), this.retryConfig.maxAttempts);
  }

  /**
   * Check if request can be made based on circuit breaker state
   */
  canMakeRequest() {
    const now = Date.now();

    switch (this.circuit.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        // Check if timeout has passed
        if (now - this.circuit.lastFailureTime >= this.circuit.timeout) {
          this.circuit.state = CircuitState.HALF_OPEN;
          this.circuit.halfOpenRequests = 0;
          return true;
        }
        return false;

      case CircuitState.HALF_OPEN:
        // Allow limited requests to test recovery
        return this.circuit.halfOpenRequests < this.circuit.maxHalfOpenRequests;

      default:
        return false;
    }
  }

  /**
   * Record successful request
   */
  recordSuccess() {
    this.circuit.failureCount = 0;
    this.health.consecutiveFailures = 0;
    this.health.consecutiveSuccesses++;
    this.health.status = 'healthy';

    if (this.circuit.state === CircuitState.HALF_OPEN) {
      this.circuit.successCount++;
      if (this.circuit.successCount >= this.circuit.successThreshold) {
        this.circuit.state = CircuitState.CLOSED;
        this.circuit.successCount = 0;
      }
    }
  }

  /**
   * Record failed request
   */
  recordFailure(error) {
    this.circuit.failureCount++;
    this.circuit.lastFailureTime = Date.now();
    this.health.consecutiveFailures++;
    this.health.consecutiveSuccesses = 0;
    this.health.lastError = error.message;

    if (this.circuit.state === CircuitState.HALF_OPEN) {
      this.circuit.state = CircuitState.OPEN;
      this.circuit.successCount = 0;
      this.enhancedStats.circuitBreaks++;
    } else if (this.circuit.failureCount >= this.circuit.failureThreshold) {
      this.circuit.state = CircuitState.OPEN;
      this.enhancedStats.circuitBreaks++;
      this.health.status = 'unhealthy';
    }
  }

  /**
   * Record performance metrics
   */
  recordPerformance(latency) {
    this.enhancedStats.responseTimes.push(latency);
    
    // Keep only last 1000 response times
    if (this.enhancedStats.responseTimes.length > 1000) {
      this.enhancedStats.responseTimes.shift();
    }

    // Calculate percentiles
    const sorted = [...this.enhancedStats.responseTimes].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p99Index = Math.floor(sorted.length * 0.99);
    
    this.enhancedStats.avgResponseTime = 
      sorted.reduce((a, b) => a + b, 0) / sorted.length;
    this.enhancedStats.p95ResponseTime = sorted[p95Index] || 0;
    this.enhancedStats.p99ResponseTime = sorted[p99Index] || 0;
  }

  /**
   * Enhance error with more context
   */
  enhanceError(error, errorType, attempt) {
    const enhanced = new Error(
      `[${this.name}] ${errorType}: ${error.message} (attempt ${attempt}/${this.retryConfig.maxAttempts})`
    );
    enhanced.originalError = error;
    enhanced.errorType = errorType;
    enhanced.provider = this.name;
    enhanced.attempt = attempt;
    enhanced.circuitState = this.circuit.state;
    return enhanced;
  }

  /**
   * Get user-friendly error message
   */
  getUserFriendlyError(error) {
    const errorType = this.classifyError(error);
    
    const messages = {
      [ErrorType.RATE_LIMIT]: 
        'Rate limit terlampaui. Silakan tunggu beberapa saat atau gunakan provider lain.',
      [ErrorType.AUTH]: 
        'Kesalahan autentikasi. Periksa API key Anda.',
      [ErrorType.QUOTA_EXCEEDED]: 
        'Kuota API habis. Upgrade plan atau gunakan provider lain.',
      [ErrorType.MODEL_NOT_FOUND]: 
        'Model tidak ditemukan. Periksa nama model Anda.',
      [ErrorType.TIMEOUT]: 
        'Request timeout. Coba lagi atau gunakan model yang lebih cepat.',
      [ErrorType.NETWORK]: 
        'Masalah koneksi jaringan. Periksa koneksi internet Anda.',
      [ErrorType.SERVER]: 
        'Server provider sedang bermasalah. Coba lagi nanti atau gunakan provider lain.',
      [ErrorType.INVALID_REQUEST]: 
        'Request tidak valid. Periksa parameter yang Anda kirim.',
      [ErrorType.UNKNOWN]: 
        'Terjadi kesalahan tidak dikenal. Coba lagi.'
    };

    return messages[errorType] || messages[ErrorType.UNKNOWN];
  }

  /**
   * Enhanced health check with detailed metrics
   */
  async enhancedHealthCheck() {
    try {
      const startTime = Date.now();
      const models = await this.getAvailableModels();
      const latency = Date.now() - startTime;

      this.health.status = 'healthy';
      this.health.lastCheck = new Date().toISOString();

      return {
        provider: this.name,
        healthy: true,
        status: this.health.status,
        latency,
        modelsAvailable: models.length,
        configured: this.isConfigured(),
        capabilities: this.capabilities,
        circuit: {
          state: this.circuit.state,
          failureCount: this.circuit.failureCount
        },
        stats: this.getEnhancedStats()
      };
    } catch (error) {
      this.health.status = 'unhealthy';
      this.health.lastError = error.message;
      this.health.lastCheck = new Date().toISOString();

      return {
        provider: this.name,
        healthy: false,
        status: this.health.status,
        error: error.message,
        userFriendlyError: this.getUserFriendlyError(error),
        configured: this.isConfigured(),
        circuit: {
          state: this.circuit.state,
          failureCount: this.circuit.failureCount
        }
      };
    }
  }

  /**
   * Get enhanced statistics
   */
  getEnhancedStats() {
    const baseStats = this.getStats();
    
    return {
      ...baseStats,
      errorsByType: this.enhancedStats.errorsByType,
      retries: this.enhancedStats.retries,
      circuitBreaks: this.enhancedStats.circuitBreaks,
      performance: {
        avg: Math.round(this.enhancedStats.avgResponseTime),
        p95: Math.round(this.enhancedStats.p95ResponseTime),
        p99: Math.round(this.enhancedStats.p99ResponseTime)
      },
      health: {
        status: this.health.status,
        consecutiveFailures: this.health.consecutiveFailures,
        consecutiveSuccesses: this.health.consecutiveSuccesses,
        lastError: this.health.lastError
      }
    };
  }

  /**
   * Reset circuit breaker (manual recovery)
   */
  resetCircuit() {
    this.circuit.state = CircuitState.CLOSED;
    this.circuit.failureCount = 0;
    this.circuit.successCount = 0;
    this.circuit.lastFailureTime = null;
    this.health.status = 'unknown';
    this.health.consecutiveFailures = 0;
  }
}

export default EnhancedBaseProvider;
