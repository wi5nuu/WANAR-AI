/**
 * Provider Health Monitor - Real-time monitoring dan health check untuk semua providers
 * Memberikan visibility terhadap status, performance, dan reliability setiap provider
 * 
 * @author Wisnu Alfian Nur Ashar & Siti Nurfadhila Az Zahra Syam
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Health status levels
 */
export const HealthStatus = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  UNKNOWN: 'unknown'
};

/**
 * Provider Health Monitor Class
 */
export class ProviderHealthMonitor {
  constructor(aiManager) {
    this.aiManager = aiManager;
    this.healthData = new Map();
    this.monitoringInterval = null;
    this.checkIntervalMs = 60000; // 1 minute
    this.historyMaxSize = 100;
    this.alertThresholds = {
      errorRate: 0.3, // 30%
      avgLatency: 10000, // 10s
      consecutiveFailures: 5
    };
    this.alerts = [];
  }

  /**
   * Start continuous health monitoring
   */
  startMonitoring(intervalMs = 60000) {
    this.checkIntervalMs = intervalMs;
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }

    // Initial check
    this.checkAllProviders().catch(console.error);

    // Periodic checks
    this.monitoringInterval = setInterval(() => {
      this.checkAllProviders().catch(console.error);
    }, this.checkIntervalMs);

    console.log(`Provider health monitoring started (interval: ${intervalMs}ms)`);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      console.log('Provider health monitoring stopped');
    }
  }

  /**
   * Check health of all providers
   */
  async checkAllProviders() {
    const providers = this.getAvailableProviders();
    const checks = [];

    for (const providerName of providers) {
      checks.push(this.checkProvider(providerName));
    }

    const results = await Promise.allSettled(checks);
    
    // Analyze results and trigger alerts
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        this.analyzeAndAlert(providers[index], result.value);
      }
    });

    return this.getHealthSummary();
  }

  /**
   * Check health of a single provider
   */
  async checkProvider(providerName) {
    const provider = this.getProvider(providerName);
    if (!provider) {
      return this.createUnknownHealth(providerName);
    }

    const startTime = Date.now();
    let healthCheck;

    try {
      // Use enhanced health check if available
      if (typeof provider.enhancedHealthCheck === 'function') {
        healthCheck = await provider.enhancedHealthCheck();
      } else if (typeof provider.healthCheck === 'function') {
        healthCheck = await provider.healthCheck();
      } else {
        // Fallback: check if provider is configured
        healthCheck = {
          provider: providerName,
          healthy: provider.isConfigured?.() || false,
          configured: provider.isConfigured?.() || false,
          latency: Date.now() - startTime
        };
      }

      // Add timestamp
      healthCheck.timestamp = new Date().toISOString();
      healthCheck.checkDuration = Date.now() - startTime;

      // Store in history
      this.storeHealthData(providerName, healthCheck);

      return healthCheck;

    } catch (error) {
      const errorHealth = {
        provider: providerName,
        healthy: false,
        status: HealthStatus.UNHEALTHY,
        error: error.message,
        timestamp: new Date().toISOString(),
        checkDuration: Date.now() - startTime
      };

      this.storeHealthData(providerName, errorHealth);
      return errorHealth;
    }
  }

  /**
   * Store health check result in history
   */
  storeHealthData(providerName, healthData) {
    if (!this.healthData.has(providerName)) {
      this.healthData.set(providerName, {
        current: null,
        history: [],
        alerts: []
      });
    }

    const data = this.healthData.get(providerName);
    data.current = healthData;
    data.history.push(healthData);

    // Limit history size
    if (data.history.length > this.historyMaxSize) {
      data.history.shift();
    }
  }

  /**
   * Analyze health data and trigger alerts if needed
   */
  analyzeAndAlert(providerName, healthData) {
    const data = this.healthData.get(providerName);
    if (!data || data.history.length < 3) return;

    const recent = data.history.slice(-10);
    const unhealthyCount = recent.filter(h => !h.healthy).length;
    const errorRate = unhealthyCount / recent.length;

    // Check for consecutive failures
    const consecutiveFailures = this.getConsecutiveFailures(recent);
    if (consecutiveFailures >= this.alertThresholds.consecutiveFailures) {
      this.triggerAlert(providerName, 'CONSECUTIVE_FAILURES', {
        count: consecutiveFailures,
        message: `Provider ${providerName} has ${consecutiveFailures} consecutive failures`
      });
    }

    // Check error rate
    if (errorRate >= this.alertThresholds.errorRate) {
      this.triggerAlert(providerName, 'HIGH_ERROR_RATE', {
        errorRate: (errorRate * 100).toFixed(1) + '%',
        message: `Provider ${providerName} has high error rate: ${(errorRate * 100).toFixed(1)}%`
      });
    }

    // Check latency
    const healthyChecks = recent.filter(h => h.healthy && h.latency);
    if (healthyChecks.length > 0) {
      const avgLatency = healthyChecks.reduce((sum, h) => sum + h.latency, 0) / healthyChecks.length;
      if (avgLatency > this.alertThresholds.avgLatency) {
        this.triggerAlert(providerName, 'HIGH_LATENCY', {
          avgLatency: Math.round(avgLatency),
          message: `Provider ${providerName} has high average latency: ${Math.round(avgLatency)}ms`
        });
      }
    }
  }

  /**
   * Count consecutive failures
   */
  getConsecutiveFailures(history) {
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (!history[i].healthy) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * Trigger an alert
   */
  triggerAlert(providerName, type, details) {
    const alert = {
      provider: providerName,
      type,
      timestamp: new Date().toISOString(),
      ...details
    };

    // Deduplicate: don't add if same alert exists in last 5 minutes
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const recentSimilar = this.alerts.find(a => 
      a.provider === providerName &&
      a.type === type &&
      new Date(a.timestamp).getTime() > fiveMinutesAgo
    );

    if (!recentSimilar) {
      this.alerts.push(alert);
      
      // Limit alerts array size
      if (this.alerts.length > 100) {
        this.alerts.shift();
      }

      // Store in provider data
      const data = this.healthData.get(providerName);
      if (data) {
        data.alerts.push(alert);
        if (data.alerts.length > 20) {
          data.alerts.shift();
        }
      }

      console.warn(`[ALERT] ${alert.message}`);
    }
  }

  /**
   * Get health summary for all providers
   */
  getHealthSummary() {
    const summary = {
      timestamp: new Date().toISOString(),
      providers: [],
      overall: {
        total: 0,
        healthy: 0,
        degraded: 0,
        unhealthy: 0,
        unknown: 0
      },
      recentAlerts: this.alerts.slice(-10)
    };

    for (const [providerName, data] of this.healthData.entries()) {
      if (!data.current) continue;

      const providerSummary = {
        name: providerName,
        status: this.determineStatus(data),
        healthy: data.current.healthy,
        latency: data.current.latency,
        lastCheck: data.current.timestamp,
        stats: data.current.stats,
        recentAlerts: data.alerts.slice(-5)
      };

      summary.providers.push(providerSummary);
      summary.overall.total++;
      summary.overall[providerSummary.status]++;
    }

    // Sort by status (unhealthy first)
    summary.providers.sort((a, b) => {
      const order = { unhealthy: 0, degraded: 1, healthy: 2, unknown: 3 };
      return order[a.status] - order[b.status];
    });

    return summary;
  }

  /**
   * Determine provider status based on recent history
   */
  determineStatus(data) {
    if (!data.current) return HealthStatus.UNKNOWN;
    if (!data.current.healthy) return HealthStatus.UNHEALTHY;

    const recent = data.history.slice(-5);
    const unhealthyCount = recent.filter(h => !h.healthy).length;
    
    if (unhealthyCount === 0) return HealthStatus.HEALTHY;
    if (unhealthyCount <= 2) return HealthStatus.DEGRADED;
    return HealthStatus.UNHEALTHY;
  }

  /**
   * Get detailed report for a specific provider
   */
  getProviderReport(providerName) {
    const data = this.healthData.get(providerName);
    
    // If no health data, try to get provider info from AI manager
    if (!data) {
      const provider = this.getProvider(providerName);
      if (provider) {
        // Run a quick check to populate data
        this.checkProvider(providerName);
        // Get the newly created data
        const newData = this.healthData.get(providerName);
        if (newData) {
          return this.getProviderReport(providerName);
        }
      }
      
      // Return basic provider info without health data
      const providerInfo = this.getProviderBasicInfo(providerName);
      if (providerInfo) {
        return {
          provider: providerName,
          current: {
            provider: providerName,
            healthy: providerInfo.configured,
            configured: providerInfo.configured,
            status: providerInfo.configured ? HealthStatus.UNKNOWN : HealthStatus.UNHEALTHY
          },
          status: providerInfo.configured ? HealthStatus.UNKNOWN : HealthStatus.UNHEALTHY,
          uptime: 'N/A',
          checks: 0,
          recentHistory: [],
          alerts: [],
          recommendations: this.generateBasicRecommendations(providerName, providerInfo),
          message: 'No health checks performed yet. Run a health check first.'
        };
      }
      
      return { error: `Provider not found: ${providerName}` };
    }

    const recent = data.history.slice(-20);
    const healthyCount = recent.filter(h => h.healthy).length;
    const uptime = (healthyCount / recent.length * 100).toFixed(1);

    return {
      provider: providerName,
      current: data.current,
      status: this.determineStatus(data),
      uptime: uptime + '%',
      checks: recent.length,
      recentHistory: recent,
      alerts: data.alerts,
      recommendations: this.generateRecommendations(providerName, data)
    };
  }

  /**
   * Generate recommendations based on health data
   */
  generateRecommendations(providerName, data) {
    const recommendations = [];
    const status = this.determineStatus(data);

    if (status === HealthStatus.UNHEALTHY) {
      recommendations.push({
        severity: 'high',
        message: 'Provider is unhealthy. Consider using alternative providers.',
        action: 'Switch to a healthy provider or check configuration.'
      });
    }

    if (status === HealthStatus.DEGRADED) {
      recommendations.push({
        severity: 'medium',
        message: 'Provider is experiencing intermittent issues.',
        action: 'Monitor closely or consider using a more reliable provider for critical tasks.'
      });
    }

    // Check latency
    const recentHealthy = data.history.slice(-10).filter(h => h.healthy && h.latency);
    if (recentHealthy.length > 0) {
      const avgLatency = recentHealthy.reduce((sum, h) => sum + h.latency, 0) / recentHealthy.length;
      if (avgLatency > 5000) {
        recommendations.push({
          severity: 'low',
          message: `High average latency: ${Math.round(avgLatency)}ms`,
          action: 'Consider using a faster provider for time-sensitive tasks.'
        });
      }
    }

    // Check configuration
    if (data.current && !data.current.configured) {
      recommendations.push({
        severity: 'high',
        message: 'Provider is not properly configured.',
        action: 'Check API keys and configuration in .env file.'
      });
    }

    return recommendations;
  }

  /**
   * Get best available provider for a task
   */
  getBestProvider(options = {}) {
    const summary = this.getHealthSummary();
    const { requiresSpeed = false, requiresReliability = true } = options;

    let candidates = summary.providers.filter(p => 
      p.status === HealthStatus.HEALTHY || p.status === HealthStatus.DEGRADED
    );

    if (candidates.length === 0) {
      // Fallback to any provider that's at least configured
      candidates = summary.providers.filter(p => p.healthy !== false);
    }

    if (candidates.length === 0) {
      return null;
    }

    // Sort by preference
    candidates.sort((a, b) => {
      // Prioritize healthy over degraded
      if (a.status !== b.status) {
        return a.status === HealthStatus.HEALTHY ? -1 : 1;
      }

      // If speed is required, prioritize lower latency
      if (requiresSpeed && a.latency && b.latency) {
        return a.latency - b.latency;
      }

      // Default: prefer fewer recent alerts
      return (a.recentAlerts?.length || 0) - (b.recentAlerts?.length || 0);
    });

    return candidates[0].name;
  }

  /**
   * Create unknown health data
   */
  createUnknownHealth(providerName) {
    return {
      provider: providerName,
      healthy: false,
      status: HealthStatus.UNKNOWN,
      error: 'Provider not found',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get available providers from AI manager
   */
  getAvailableProviders() {
    if (!this.aiManager) return [];
    
    // Try to get providers from AI manager
    if (typeof this.aiManager.getAvailableProviders === 'function') {
      return this.aiManager.getAvailableProviders();
    }

    // Fallback: common providers
    return ['openagentic', 'nvidia', 'vector', 'anthropic', 'openai', 'gemini', 'groq'];
  }

  /**
   * Get provider instance
   */
  getProvider(providerName) {
    if (!this.aiManager) return null;
    
    if (typeof this.aiManager.getProvider === 'function') {
      return this.aiManager.getProvider(providerName);
    }

    // Fallback: try to access providers property
    return this.aiManager.providers?.[providerName] || 
           this.aiManager[providerName] ||
           null;
  }

  /**
   * Export health data to JSON
   */
  exportHealthData(filepath) {
    const data = {
      exportTime: new Date().toISOString(),
      summary: this.getHealthSummary(),
      detailedData: Array.from(this.healthData.entries()).map(([name, data]) => ({
        provider: name,
        ...data
      })),
      alerts: this.alerts
    };

    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    return filepath;
  }

  /**
   * Get recent alerts
   */
  getRecentAlerts(limit = 20) {
    return this.alerts.slice(-limit).reverse();
  }

  /**
   * Clear alerts for a provider
   */
  clearAlerts(providerName) {
    if (providerName) {
      const data = this.healthData.get(providerName);
      if (data) {
        data.alerts = [];
      }
      this.alerts = this.alerts.filter(a => a.provider !== providerName);
    } else {
      this.alerts = [];
      for (const data of this.healthData.values()) {
        data.alerts = [];
      }
    }
  }

  /**
   * Get basic provider info without running health check
   */
  getProviderBasicInfo(providerName) {
    const provider = this.getProvider(providerName);
    if (!provider) return null;

    return {
      configured: provider.isConfigured?.() || false,
      defaultModel: provider.defaultModel || null,
      models: provider.getAvailableModels?.() || [],
      capabilities: provider.getCapabilities?.() || {}
    };
  }

  /**
   * Generate basic recommendations without health data
   */
  generateBasicRecommendations(providerName, info) {
    const recommendations = [];

    if (!info.configured) {
      recommendations.push({
        severity: 'high',
        message: 'Provider is not configured.',
        action: 'Set API key in .env file or run configuration.'
      });
    } else {
      recommendations.push({
        severity: 'info',
        message: 'Provider is configured but no health checks performed.',
        action: 'Run a health check to verify connectivity and performance.'
      });
    }

    return recommendations;
  }
}

export default ProviderHealthMonitor;
