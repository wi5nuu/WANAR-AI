/**
 * Model Performance Analytics - Tracking dan analisis performa model secara real-time
 * Machine learning untuk optimize model selection berdasarkan historical performance
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Performance Metric Types
 */
export const MetricType = {
  LATENCY: 'latency',
  TOKEN_THROUGHPUT: 'token_throughput',
  ERROR_RATE: 'error_rate',
  COST_PER_TOKEN: 'cost_per_token',
  QUALITY_SCORE: 'quality_score',
  SUCCESS_RATE: 'success_rate'
};

/**
 * Model Performance Analytics Engine
 */
export class ModelPerformanceAnalytics {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, '..', '..', 'data', 'analytics');
    this.sessions = new Map();
    this.aggregates = new Map();
    this.maxSessionSize = 1000;
    this.learningEnabled = options.learningEnabled !== false;
    
    // Ensure data directory exists
    this.ensureDataDir();
    
    // Load existing data
    this.loadAggregates();
  }

  /**
   * Ensure data directory exists
   */
  ensureDataDir() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch (error) {
      console.warn('Failed to create analytics data directory:', error.message);
    }
  }

  /**
   * Record a model request
   */
  recordRequest(data) {
    const {
      provider,
      model,
      taskType = 'general',
      startTime,
      endTime,
      inputTokens = 0,
      outputTokens = 0,
      success = true,
      error = null,
      cost = 0,
      qualityScore = null
    } = data;

    const sessionKey = `${provider}:${model}`;
    
    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, []);
    }

    const session = this.sessions.get(sessionKey);
    
    const latency = endTime - startTime;
    const totalTokens = inputTokens + outputTokens;
    const throughput = totalTokens > 0 ? (totalTokens / (latency / 1000)) : 0;

    const record = {
      timestamp: new Date(startTime).toISOString(),
      provider,
      model,
      taskType,
      latency,
      inputTokens,
      outputTokens,
      totalTokens,
      throughput,
      success,
      error,
      cost,
      qualityScore
    };

    session.push(record);

    // Limit session size
    if (session.length > this.maxSessionSize) {
      session.shift();
    }

    // Update aggregates
    this.updateAggregates(sessionKey, record);

    return record;
  }

  /**
   * Update aggregate statistics
   */
  updateAggregates(sessionKey, record) {
    if (!this.aggregates.has(sessionKey)) {
      this.aggregates.set(sessionKey, {
        provider: record.provider,
        model: record.model,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        totalLatency: 0,
        totalTokens: 0,
        totalCost: 0,
        latencies: [],
        throughputs: [],
        qualityScores: [],
        errorsByType: {},
        byTaskType: {},
        lastUpdated: null
      });
    }

    const agg = this.aggregates.get(sessionKey);

    // Update counts
    agg.totalRequests++;
    if (record.success) {
      agg.successfulRequests++;
    } else {
      agg.failedRequests++;
      
      // Track error types
      const errorType = this.classifyError(record.error);
      agg.errorsByType[errorType] = (agg.errorsByType[errorType] || 0) + 1;
    }

    // Update metrics
    agg.totalLatency += record.latency;
    agg.totalTokens += record.totalTokens;
    agg.totalCost += record.cost;

    // Store recent values for percentile calculations
    agg.latencies.push(record.latency);
    if (agg.latencies.length > 100) agg.latencies.shift();

    if (record.throughput > 0) {
      agg.throughputs.push(record.throughput);
      if (agg.throughputs.length > 100) agg.throughputs.shift();
    }

    if (record.qualityScore !== null) {
      agg.qualityScores.push(record.qualityScore);
      if (agg.qualityScores.length > 100) agg.qualityScores.shift();
    }

    // Track by task type
    const taskType = record.taskType;
    if (!agg.byTaskType[taskType]) {
      agg.byTaskType[taskType] = {
        count: 0,
        avgLatency: 0,
        successRate: 0
      };
    }
    
    const taskStats = agg.byTaskType[taskType];
    taskStats.count++;
    taskStats.avgLatency = ((taskStats.avgLatency * (taskStats.count - 1)) + record.latency) / taskStats.count;
    taskStats.successRate = record.success ? 
      ((taskStats.successRate * (taskStats.count - 1)) + 1) / taskStats.count :
      (taskStats.successRate * (taskStats.count - 1)) / taskStats.count;

    agg.lastUpdated = new Date().toISOString();
  }

  /**
   * Classify error for analytics
   */
  classifyError(error) {
    if (!error) return 'unknown';
    
    const msg = error.toLowerCase();
    if (msg.includes('timeout')) return 'timeout';
    if (msg.includes('rate limit')) return 'rate_limit';
    if (msg.includes('auth')) return 'auth';
    if (msg.includes('quota')) return 'quota';
    if (msg.includes('network')) return 'network';
    if (msg.includes('500') || msg.includes('502') || msg.includes('503')) return 'server_error';
    return 'other';
  }

  /**
   * Get performance metrics for a model
   */
  getModelMetrics(provider, model) {
    const sessionKey = `${provider}:${model}`;
    const agg = this.aggregates.get(sessionKey);

    if (!agg) {
      return {
        provider,
        model,
        error: 'No data available for this model'
      };
    }

    const successRate = agg.totalRequests > 0 ? 
      (agg.successfulRequests / agg.totalRequests * 100).toFixed(1) : 0;
    
    const avgLatency = agg.totalRequests > 0 ? 
      Math.round(agg.totalLatency / agg.totalRequests) : 0;
    
    const avgThroughput = agg.throughputs.length > 0 ?
      Math.round(agg.throughputs.reduce((a, b) => a + b, 0) / agg.throughputs.length) : 0;
    
    const avgQuality = agg.qualityScores.length > 0 ?
      (agg.qualityScores.reduce((a, b) => a + b, 0) / agg.qualityScores.length).toFixed(2) : null;

    // Calculate percentiles
    const sortedLatencies = [...agg.latencies].sort((a, b) => a - b);
    const p50 = this.percentile(sortedLatencies, 0.50);
    const p95 = this.percentile(sortedLatencies, 0.95);
    const p99 = this.percentile(sortedLatencies, 0.99);

    return {
      provider,
      model,
      summary: {
        totalRequests: agg.totalRequests,
        successRate: successRate + '%',
        avgLatency: avgLatency + 'ms',
        avgThroughput: avgThroughput + ' tok/s',
        avgQuality: avgQuality,
        totalCost: '$' + agg.totalCost.toFixed(4)
      },
      latency: {
        avg: avgLatency,
        p50,
        p95,
        p99
      },
      tokens: {
        total: agg.totalTokens,
        avgPerRequest: Math.round(agg.totalTokens / agg.totalRequests)
      },
      errors: {
        total: agg.failedRequests,
        rate: ((agg.failedRequests / agg.totalRequests) * 100).toFixed(1) + '%',
        byType: agg.errorsByType
      },
      byTaskType: agg.byTaskType,
      lastUpdated: agg.lastUpdated
    };
  }

  /**
   * Calculate percentile
   */
  percentile(sortedArray, p) {
    if (sortedArray.length === 0) return 0;
    const index = Math.ceil(sortedArray.length * p) - 1;
    return Math.round(sortedArray[index]);
  }

  /**
   * Compare models
   */
  compareModels(models) {
    const comparison = models.map(({ provider, model }) => 
      this.getModelMetrics(provider, model)
    );

    // Find best in each category
    const best = {
      fastest: null,
      mostReliable: null,
      cheapest: null,
      highestQuality: null
    };

    let minLatency = Infinity;
    let maxSuccessRate = 0;
    let minCost = Infinity;
    let maxQuality = 0;

    comparison.forEach(metrics => {
      if (metrics.error) return;

      const latency = metrics.latency.avg;
      const successRate = parseFloat(metrics.summary.successRate);
      const cost = parseFloat(metrics.summary.totalCost.replace('$', ''));
      const quality = metrics.summary.avgQuality ? parseFloat(metrics.summary.avgQuality) : 0;

      if (latency < minLatency) {
        minLatency = latency;
        best.fastest = `${metrics.provider}/${metrics.model}`;
      }

      if (successRate > maxSuccessRate) {
        maxSuccessRate = successRate;
        best.mostReliable = `${metrics.provider}/${metrics.model}`;
      }

      if (cost < minCost) {
        minCost = cost;
        best.cheapest = `${metrics.provider}/${metrics.model}`;
      }

      if (quality > maxQuality) {
        maxQuality = quality;
        best.highestQuality = `${metrics.provider}/${metrics.model}`;
      }
    });

    return {
      comparison,
      best,
      recommendation: this.getRecommendation(comparison)
    };
  }

  /**
   * Get recommendation based on analytics
   */
  getRecommendation(comparison) {
    // Score each model based on multiple factors
    const scored = comparison
      .filter(m => !m.error)
      .map(metrics => {
        let score = 0;
        
        // Success rate (40%)
        const successRate = parseFloat(metrics.summary.successRate);
        score += successRate * 0.4;

        // Speed (30%) - inverse of latency
        const latency = metrics.latency.avg;
        const speedScore = Math.max(0, 100 - (latency / 100));
        score += speedScore * 0.3;

        // Cost (20%) - inverse of cost
        const cost = parseFloat(metrics.summary.totalCost.replace('$', ''));
        const costScore = Math.max(0, 100 - (cost * 1000));
        score += costScore * 0.2;

        // Quality (10%)
        const quality = metrics.summary.avgQuality ? 
          parseFloat(metrics.summary.avgQuality) * 10 : 50;
        score += quality * 0.1;

        return {
          provider: metrics.provider,
          model: metrics.model,
          score: score.toFixed(2),
          metrics
        };
      })
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return null;
    }

    return {
      recommended: `${scored[0].provider}/${scored[0].model}`,
      score: scored[0].score,
      reason: this.explainRecommendation(scored[0].metrics),
      alternatives: scored.slice(1, 3).map(s => ({
        model: `${s.provider}/${s.model}`,
        score: s.score
      }))
    };
  }

  /**
   * Explain why a model is recommended
   */
  explainRecommendation(metrics) {
    const reasons = [];

    const successRate = parseFloat(metrics.summary.successRate);
    if (successRate > 95) {
      reasons.push(`sangat reliable (${metrics.summary.successRate} success rate)`);
    }

    if (metrics.latency.avg < 2000) {
      reasons.push(`cepat (${metrics.latency.avg}ms avg latency)`);
    }

    if (metrics.summary.avgQuality && parseFloat(metrics.summary.avgQuality) > 8) {
      reasons.push(`kualitas tinggi (${metrics.summary.avgQuality}/10)`);
    }

    return reasons.length > 0 ? reasons.join(', ') : 'performa seimbang';
  }

  /**
   * Get all tracked models
   */
  getAllModels() {
    return Array.from(this.aggregates.keys()).map(key => {
      const [provider, model] = key.split(':');
      return { provider, model };
    });
  }

  /**
   * Save aggregates to disk
   */
  saveAggregates() {
    try {
      const data = {
        version: '1.0.0',
        savedAt: new Date().toISOString(),
        aggregates: Array.from(this.aggregates.entries()).map(([key, value]) => ({
          key,
          ...value
        }))
      };

      const filepath = path.join(this.dataDir, 'model-performance.json');
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
      
      return filepath;
    } catch (error) {
      console.error('Failed to save performance analytics:', error.message);
      return null;
    }
  }

  /**
   * Load aggregates from disk
   */
  loadAggregates() {
    try {
      const filepath = path.join(this.dataDir, 'model-performance.json');
      
      if (!fs.existsSync(filepath)) {
        return false;
      }

      const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      
      if (data.aggregates) {
        data.aggregates.forEach(agg => {
          const { key, ...value } = agg;
          this.aggregates.set(key, value);
        });
      }

      return true;
    } catch (error) {
      console.warn('Failed to load performance analytics:', error.message);
      return false;
    }
  }

  /**
   * Get performance trends over time
   */
  getTrends(provider, model, timeframe = '24h') {
    const sessionKey = `${provider}:${model}`;
    const session = this.sessions.get(sessionKey);

    if (!session || session.length === 0) {
      return { error: 'No session data available' };
    }

    // Filter by timeframe
    const now = Date.now();
    const timeframes = {
      '1h': 3600000,
      '6h': 21600000,
      '24h': 86400000,
      '7d': 604800000
    };

    const cutoff = now - (timeframes[timeframe] || timeframes['24h']);
    const filtered = session.filter(r => 
      new Date(r.timestamp).getTime() > cutoff
    );

    if (filtered.length === 0) {
      return { error: 'No data in selected timeframe' };
    }

    // Group into buckets
    const bucketCount = 20;
    const bucketSize = (timeframes[timeframe] || timeframes['24h']) / bucketCount;
    const buckets = Array(bucketCount).fill(null).map(() => ({
      latencies: [],
      throughputs: [],
      successes: 0,
      failures: 0
    }));

    filtered.forEach(record => {
      const age = now - new Date(record.timestamp).getTime();
      const bucketIndex = Math.min(
        Math.floor(age / bucketSize),
        bucketCount - 1
      );
      
      const bucket = buckets[bucketIndex];
      bucket.latencies.push(record.latency);
      bucket.throughputs.push(record.throughput);
      if (record.success) {
        bucket.successes++;
      } else {
        bucket.failures++;
      }
    });

    // Calculate trends
    const trend = buckets.map((bucket, i) => ({
      bucket: i,
      avgLatency: bucket.latencies.length > 0 ?
        Math.round(bucket.latencies.reduce((a, b) => a + b, 0) / bucket.latencies.length) : null,
      avgThroughput: bucket.throughputs.length > 0 ?
        Math.round(bucket.throughputs.reduce((a, b) => a + b, 0) / bucket.throughputs.length) : null,
      successRate: (bucket.successes + bucket.failures) > 0 ?
        (bucket.successes / (bucket.successes + bucket.failures) * 100).toFixed(1) : null
    })).filter(b => b.avgLatency !== null);

    return {
      provider,
      model,
      timeframe,
      dataPoints: filtered.length,
      trend
    };
  }

  /**
   * Auto-save periodically
   */
  startAutoSave(intervalMs = 300000) {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }

    this.autoSaveInterval = setInterval(() => {
      this.saveAggregates();
    }, intervalMs);
  }

  /**
   * Stop auto-save
   */
  stopAutoSave() {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
  }
}

export default ModelPerformanceAnalytics;
