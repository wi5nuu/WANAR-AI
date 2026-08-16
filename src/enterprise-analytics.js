/**
 * Enterprise Analytics & Monitoring System
 * Real-time tracking, metrics, alerts, and performance monitoring
 * 
 * Features:
 * - Real-time metrics collection
 * - Cost tracking & forecasting
 * - Performance monitoring (latency, throughput, errors)
 * - Token usage analytics
 * - Provider health checks
 * - Alert system (threshold-based)
 * - Historical data & trends
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 2.0.0
 */

import * as db from './database.js';

export default class EnterpriseAnalytics {
  constructor(options = {}) {
    // Real-time metrics
    this.metrics = {
      requests: {
        total: 0,
        success: 0,
        failed: 0,
        byProvider: {},
        byModel: {},
        byTaskType: {}
      },
      tokens: {
        total: 0,
        input: 0,
        output: 0,
        byProvider: {},
        byModel: {}
      },
      costs: {
        total: 0,
        byProvider: {},
        byModel: {},
        estimatedMonthly: 0
      },
      performance: {
        avgLatency: 0,
        p50Latency: 0,
        p95Latency: 0,
        p99Latency: 0,
        latencyHistory: []
      },
      cache: {
        hits: 0,
        misses: 0,
        hitRate: 0
      },
      context: {
        avgContextSize: 0,
        maxContextSize: 0,
        compressions: 0
      }
    };

    // Alert configuration
    this.alerts = {
      enabled: options.alertsEnabled !== false,
      thresholds: {
        errorRate: options.errorRateThreshold || 0.1, // 10%
        latency: options.latencyThreshold || 5000, // 5s
        costPerHour: options.costPerHourThreshold || 10, // $10/hour
        tokenUsagePerHour: options.tokenUsageThreshold || 1000000 // 1M tokens/hour
      },
      callbacks: []
    };

    // Time windows for analytics
    this.timeWindows = {
      current: { start: Date.now(), requests: 0, tokens: 0, cost: 0 },
      hourly: [],
      daily: [],
      maxHourlyRecords: 24,
      maxDailyRecords: 30
    };

    // Provider health tracking
    this.providerHealth = {};

    // Start background tasks
    this.startBackgroundTasks();
  }

  /**
   * Record request metrics
   */
  recordRequest(data) {
    const {
      provider,
      model,
      taskType,
      success,
      latency,
      tokens = {},
      cost = 0,
      error = null
    } = data;

    // Update request counts
    this.metrics.requests.total++;
    if (success) {
      this.metrics.requests.success++;
    } else {
      this.metrics.requests.failed++;
    }

    // By provider
    if (!this.metrics.requests.byProvider[provider]) {
      this.metrics.requests.byProvider[provider] = { total: 0, success: 0, failed: 0 };
    }
    this.metrics.requests.byProvider[provider].total++;
    if (success) {
      this.metrics.requests.byProvider[provider].success++;
    } else {
      this.metrics.requests.byProvider[provider].failed++;
    }

    // By model
    if (!this.metrics.requests.byModel[model]) {
      this.metrics.requests.byModel[model] = { total: 0, success: 0, failed: 0 };
    }
    this.metrics.requests.byModel[model].total++;
    if (success) {
      this.metrics.requests.byModel[model].success++;
    } else {
      this.metrics.requests.byModel[model].failed++;
    }

    // By task type
    if (taskType) {
      if (!this.metrics.requests.byTaskType[taskType]) {
        this.metrics.requests.byTaskType[taskType] = { total: 0, success: 0, failed: 0 };
      }
      this.metrics.requests.byTaskType[taskType].total++;
      if (success) {
        this.metrics.requests.byTaskType[taskType].success++;
      } else {
        this.metrics.requests.byTaskType[taskType].failed++;
      }
    }

    // Update token metrics
    const totalTokens = (tokens.promptTokens || 0) + (tokens.completionTokens || 0);
    this.metrics.tokens.total += totalTokens;
    this.metrics.tokens.input += tokens.promptTokens || 0;
    this.metrics.tokens.output += tokens.completionTokens || 0;

    if (!this.metrics.tokens.byProvider[provider]) {
      this.metrics.tokens.byProvider[provider] = 0;
    }
    this.metrics.tokens.byProvider[provider] += totalTokens;

    if (!this.metrics.tokens.byModel[model]) {
      this.metrics.tokens.byModel[model] = 0;
    }
    this.metrics.tokens.byModel[model] += totalTokens;

    // Update cost metrics
    this.metrics.costs.total += cost;
    if (!this.metrics.costs.byProvider[provider]) {
      this.metrics.costs.byProvider[provider] = 0;
    }
    this.metrics.costs.byProvider[provider] += cost;

    if (!this.metrics.costs.byModel[model]) {
      this.metrics.costs.byModel[model] = 0;
    }
    this.metrics.costs.byModel[model] += cost;

    // Update performance metrics
    if (latency) {
      this.metrics.performance.latencyHistory.push(latency);
      
      // Keep only last 1000 latencies
      if (this.metrics.performance.latencyHistory.length > 1000) {
        this.metrics.performance.latencyHistory.shift();
      }
      
      this.updateLatencyPercentiles();
    }

    // Update time windows
    this.timeWindows.current.requests++;
    this.timeWindows.current.tokens += totalTokens;
    this.timeWindows.current.cost += cost;

    // Check alerts
    this.checkAlerts();

    // Update provider health
    this.updateProviderHealth(provider, success, latency, error);

    // Persist to database
    this.persistMetrics(data);
  }

  /**
   * Record cache metrics
   */
  recordCache(hit) {
    if (hit) {
      this.metrics.cache.hits++;
    } else {
      this.metrics.cache.misses++;
    }
    
    const total = this.metrics.cache.hits + this.metrics.cache.misses;
    this.metrics.cache.hitRate = total > 0 ? (this.metrics.cache.hits / total) : 0;
  }

  /**
   * Record context metrics
   */
  recordContext(contextSize, compressed = false) {
    const currentAvg = this.metrics.context.avgContextSize;
    const totalRequests = this.metrics.requests.total;
    
    this.metrics.context.avgContextSize = totalRequests > 0
      ? (currentAvg * (totalRequests - 1) + contextSize) / totalRequests
      : contextSize;
    
    if (contextSize > this.metrics.context.maxContextSize) {
      this.metrics.context.maxContextSize = contextSize;
    }
    
    if (compressed) {
      this.metrics.context.compressions++;
    }
  }

  /**
   * Update latency percentiles
   */
  updateLatencyPercentiles() {
    const sorted = [...this.metrics.performance.latencyHistory].sort((a, b) => a - b);
    const len = sorted.length;
    
    if (len === 0) return;
    
    this.metrics.performance.avgLatency = sorted.reduce((a, b) => a + b, 0) / len;
    this.metrics.performance.p50Latency = sorted[Math.floor(len * 0.50)];
    this.metrics.performance.p95Latency = sorted[Math.floor(len * 0.95)];
    this.metrics.performance.p99Latency = sorted[Math.floor(len * 0.99)];
  }

  /**
   * Update provider health status
   */
  updateProviderHealth(provider, success, latency, error) {
    if (!this.providerHealth[provider]) {
      this.providerHealth[provider] = {
        status: 'healthy',
        uptime: 100,
        avgLatency: 0,
        errorRate: 0,
        lastError: null,
        lastSuccess: null,
        consecutiveErrors: 0
      };
    }
    
    const health = this.providerHealth[provider];
    
    if (success) {
      health.lastSuccess = Date.now();
      health.consecutiveErrors = 0;
      
      if (latency) {
        health.avgLatency = health.avgLatency === 0 
          ? latency 
          : health.avgLatency * 0.9 + latency * 0.1; // Exponential moving average
      }
    } else {
      health.lastError = { time: Date.now(), message: error };
      health.consecutiveErrors++;
    }
    
    // Calculate error rate
    const providerStats = this.metrics.requests.byProvider[provider];
    if (providerStats && providerStats.total > 0) {
      health.errorRate = providerStats.failed / providerStats.total;
      health.uptime = (providerStats.success / providerStats.total) * 100;
    }
    
    // Determine status
    if (health.consecutiveErrors >= 5) {
      health.status = 'critical';
    } else if (health.errorRate > 0.3) {
      health.status = 'degraded';
    } else if (health.avgLatency > 10000) {
      health.status = 'slow';
    } else {
      health.status = 'healthy';
    }
  }

  /**
   * Check alert thresholds
   */
  checkAlerts() {
    if (!this.alerts.enabled) return;
    
    const alerts = [];
    
    // Check error rate
    const errorRate = this.metrics.requests.total > 0
      ? this.metrics.requests.failed / this.metrics.requests.total
      : 0;
    
    if (errorRate > this.alerts.thresholds.errorRate) {
      alerts.push({
        type: 'error_rate',
        severity: 'high',
        message: `Error rate ${(errorRate * 100).toFixed(2)}% exceeds threshold ${(this.alerts.thresholds.errorRate * 100).toFixed(2)}%`,
        value: errorRate,
        threshold: this.alerts.thresholds.errorRate
      });
    }
    
    // Check latency
    if (this.metrics.performance.p95Latency > this.alerts.thresholds.latency) {
      alerts.push({
        type: 'latency',
        severity: 'medium',
        message: `P95 latency ${this.metrics.performance.p95Latency}ms exceeds threshold ${this.alerts.thresholds.latency}ms`,
        value: this.metrics.performance.p95Latency,
        threshold: this.alerts.thresholds.latency
      });
    }
    
    // Check cost per hour
    const hourlyRate = this.calculateHourlyRate();
    if (hourlyRate > this.alerts.thresholds.costPerHour) {
      alerts.push({
        type: 'cost',
        severity: 'high',
        message: `Cost rate $${hourlyRate.toFixed(2)}/hour exceeds threshold $${this.alerts.thresholds.costPerHour}/hour`,
        value: hourlyRate,
        threshold: this.alerts.thresholds.costPerHour
      });
    }
    
    // Check token usage per hour
    const tokenRate = this.calculateTokenRate();
    if (tokenRate > this.alerts.thresholds.tokenUsagePerHour) {
      alerts.push({
        type: 'tokens',
        severity: 'medium',
        message: `Token usage ${tokenRate.toLocaleString()} tokens/hour exceeds threshold ${this.alerts.thresholds.tokenUsagePerHour.toLocaleString()} tokens/hour`,
        value: tokenRate,
        threshold: this.alerts.thresholds.tokenUsagePerHour
      });
    }
    
    // Trigger alert callbacks
    if (alerts.length > 0) {
      this.triggerAlerts(alerts);
    }
  }

  /**
   * Calculate hourly cost rate
   */
  calculateHourlyRate() {
    const now = Date.now();
    const hourAgo = now - 3600000;
    
    const recentCost = this.timeWindows.hourly
      .filter(window => window.timestamp > hourAgo)
      .reduce((sum, window) => sum + window.cost, 0);
    
    return recentCost + this.timeWindows.current.cost;
  }

  /**
   * Calculate hourly token rate
   */
  calculateTokenRate() {
    const now = Date.now();
    const hourAgo = now - 3600000;
    
    const recentTokens = this.timeWindows.hourly
      .filter(window => window.timestamp > hourAgo)
      .reduce((sum, window) => sum + window.tokens, 0);
    
    return recentTokens + this.timeWindows.current.tokens;
  }

  /**
   * Trigger alert callbacks
   */
  triggerAlerts(alerts) {
    alerts.forEach(alert => {
      console.warn(`[ALERT] ${alert.severity.toUpperCase()}: ${alert.message}`);
      
      // Call registered callbacks
      this.alerts.callbacks.forEach(callback => {
        try {
          callback(alert);
        } catch (error) {
          console.error('[Analytics] Alert callback error:', error.message);
        }
      });
    });
  }

  /**
   * Register alert callback
   */
  onAlert(callback) {
    this.alerts.callbacks.push(callback);
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics() {
    return {
      ...this.metrics,
      uptime: this.getUptime(),
      requestRate: this.calculateRequestRate(),
      tokenRate: this.calculateTokenRate(),
      costRate: this.calculateHourlyRate(),
      providerHealth: this.providerHealth,
      timestamp: Date.now()
    };
  }

  /**
   * Get detailed analytics report
   */
  getReport() {
    const errorRate = this.metrics.requests.total > 0
      ? (this.metrics.requests.failed / this.metrics.requests.total * 100).toFixed(2) + '%'
      : '0%';
    
    return {
      summary: {
        totalRequests: this.metrics.requests.total,
        successRate: this.metrics.requests.total > 0
          ? ((this.metrics.requests.success / this.metrics.requests.total) * 100).toFixed(2) + '%'
          : '0%',
        errorRate,
        totalTokens: this.metrics.tokens.total.toLocaleString(),
        totalCost: '$' + this.metrics.costs.total.toFixed(4),
        avgLatency: Math.round(this.metrics.performance.avgLatency) + 'ms',
        cacheHitRate: (this.metrics.cache.hitRate * 100).toFixed(2) + '%'
      },
      performance: {
        avgLatency: Math.round(this.metrics.performance.avgLatency) + 'ms',
        p50: Math.round(this.metrics.performance.p50Latency) + 'ms',
        p95: Math.round(this.metrics.performance.p95Latency) + 'ms',
        p99: Math.round(this.metrics.performance.p99Latency) + 'ms'
      },
      providers: Object.entries(this.metrics.requests.byProvider).map(([provider, stats]) => ({
        provider,
        requests: stats.total,
        successRate: ((stats.success / stats.total) * 100).toFixed(2) + '%',
        tokens: this.metrics.tokens.byProvider[provider]?.toLocaleString() || '0',
        cost: '$' + (this.metrics.costs.byProvider[provider] || 0).toFixed(4),
        health: this.providerHealth[provider]?.status || 'unknown'
      })),
      topModels: Object.entries(this.metrics.requests.byModel)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 5)
        .map(([model, stats]) => ({
          model,
          requests: stats.total,
          successRate: ((stats.success / stats.total) * 100).toFixed(2) + '%',
          tokens: this.metrics.tokens.byModel[model]?.toLocaleString() || '0',
          cost: '$' + (this.metrics.costs.byModel[model] || 0).toFixed(4)
        })),
      context: {
        avgSize: Math.round(this.metrics.context.avgContextSize).toLocaleString() + ' tokens',
        maxSize: this.metrics.context.maxContextSize.toLocaleString() + ' tokens',
        compressions: this.metrics.context.compressions
      },
      forecasts: {
        estimatedMonthlyCost: '$' + (this.calculateHourlyRate() * 24 * 30).toFixed(2),
        estimatedMonthlyTokens: (this.calculateTokenRate() * 24 * 30).toLocaleString()
      }
    };
  }

  /**
   * Calculate uptime
   */
  getUptime() {
    if (!this.startTime) this.startTime = Date.now();
    const uptimeMs = Date.now() - this.startTime;
    const hours = Math.floor(uptimeMs / 3600000);
    const minutes = Math.floor((uptimeMs % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  }

  /**
   * Calculate request rate (requests per minute)
   */
  calculateRequestRate() {
    const now = Date.now();
    const minuteAgo = now - 60000;
    
    const recentRequests = this.timeWindows.hourly
      .filter(window => window.timestamp > minuteAgo)
      .reduce((sum, window) => sum + window.requests, 0);
    
    return recentRequests + this.timeWindows.current.requests;
  }

  /**
   * Persist metrics to database
   */
  persistMetrics(data) {
    try {
      db.recordMetrics?.({
        timestamp: Date.now(),
        provider: data.provider,
        model: data.model,
        taskType: data.taskType,
        success: data.success,
        latency: data.latency,
        tokens: data.tokens,
        cost: data.cost,
        error: data.error
      });
    } catch (error) {
      console.error('[Analytics] Database persist error:', error.message);
    }
  }

  /**
   * Start background tasks
   */
  startBackgroundTasks() {
    // Rotate time windows every hour
    this.windowRotateInterval = setInterval(() => {
      this.rotateTimeWindows();
    }, 3600000); // Every hour
    
    // Update cost forecasts every 5 minutes
    this.forecastInterval = setInterval(() => {
      this.updateForecasts();
    }, 300000); // Every 5 minutes
  }

  /**
   * Rotate time windows
   */
  rotateTimeWindows() {
    // Save current window to hourly
    this.timeWindows.hourly.push({
      timestamp: this.timeWindows.current.start,
      requests: this.timeWindows.current.requests,
      tokens: this.timeWindows.current.tokens,
      cost: this.timeWindows.current.cost
    });
    
    // Trim hourly windows
    if (this.timeWindows.hourly.length > this.timeWindows.maxHourlyRecords) {
      this.timeWindows.hourly.shift();
    }
    
    // Reset current window
    this.timeWindows.current = {
      start: Date.now(),
      requests: 0,
      tokens: 0,
      cost: 0
    };
  }

  /**
   * Update cost forecasts
   */
  updateForecasts() {
    const hourlyRate = this.calculateHourlyRate();
    this.metrics.costs.estimatedMonthly = hourlyRate * 24 * 30;
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.metrics = {
      requests: { total: 0, success: 0, failed: 0, byProvider: {}, byModel: {}, byTaskType: {} },
      tokens: { total: 0, input: 0, output: 0, byProvider: {}, byModel: {} },
      costs: { total: 0, byProvider: {}, byModel: {}, estimatedMonthly: 0 },
      performance: { avgLatency: 0, p50Latency: 0, p95Latency: 0, p99Latency: 0, latencyHistory: [] },
      cache: { hits: 0, misses: 0, hitRate: 0 },
      context: { avgContextSize: 0, maxContextSize: 0, compressions: 0 }
    };
    
    this.providerHealth = {};
    this.startTime = Date.now();
  }

  /**
   * Cleanup on destroy
   */
  destroy() {
    clearInterval(this.windowRotateInterval);
    clearInterval(this.forecastInterval);
  }
}
