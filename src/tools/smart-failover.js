/**
 * Smart Failover System - Automatic provider switching dengan intelligent routing
 * Memilih provider alternatif terbaik saat primary provider gagal atau lambat
 * 
 * @author Wisnu Alfian Nur Ashar & Siti Nurfadhila Az Zahra Syam
 * @version 1.0.0
 */

/**
 * Failover Strategy
 */
export const FailoverStrategy = {
  FASTEST: 'fastest',           // Prioritas kecepatan
  MOST_RELIABLE: 'most_reliable', // Prioritas reliability
  CHEAPEST: 'cheapest',          // Prioritas biaya
  BALANCED: 'balanced'           // Balance antara speed, reliability, cost
};

/**
 * Provider Priority Tier
 */
export const PriorityTier = {
  PRIMARY: 1,
  SECONDARY: 2,
  TERTIARY: 3,
  FALLBACK: 4
};

/**
 * Smart Failover System
 */
export class SmartFailoverSystem {
  constructor(aiManager, healthMonitor) {
    this.aiManager = aiManager;
    this.healthMonitor = healthMonitor;
    this.strategy = FailoverStrategy.BALANCED;
    this.failoverHistory = [];
    this.maxHistorySize = 100;
    
    // Provider priority configuration
    this.providerPriority = {
      // Primary tier - preferred providers
      primary: ['openagentic', 'anthropic', 'openai'],
      // Secondary tier - good alternatives
      secondary: ['nvidia', 'groq', 'gemini'],
      // Tertiary tier - free/budget options
      tertiary: ['cerebras', 'hyperbolic', 'together', 'fireworks'],
      // Fallback tier - last resort
      fallback: ['puter', 'vector']
    };

    // Model capability mapping untuk cross-provider fallback
    this.modelCapabilities = {
      'coding': ['claude-sonnet', 'gpt-4', 'deepseek', 'codestral', 'llama-3'],
      'reasoning': ['claude-sonnet', 'gpt-4o', 'deepseek', 'llama-3.1-405b', 'qwen'],
      'creative': ['grok', 'claude', 'gpt-4', 'gemini-pro'],
      'fast': ['groq', 'cerebras', 'deepseek-flash', 'gemini-flash'],
      'large-context': ['claude-sonnet', 'gemini-pro', 'gpt-4-turbo']
    };
  }

  /**
   * Execute request dengan automatic failover
   */
  async executeWithFailover(requestFn, options = {}) {
    const {
      primaryProvider,
      primaryModel,
      taskType = 'general',
      maxAttempts = 3,
      strategy = this.strategy,
      timeout = 60000
    } = options;

    const attempts = [];
    const startTime = Date.now();

    // Build provider list berdasarkan strategy
    const providerList = this.buildProviderList(primaryProvider, taskType, strategy);

    for (let i = 0; i < Math.min(maxAttempts, providerList.length); i++) {
      const provider = providerList[i];
      const attemptStart = Date.now();

      try {
        // Check if provider is healthy
        const healthCheck = await this.healthMonitor.checkProvider(provider.name);
        
        if (!healthCheck.healthy && i < maxAttempts - 1) {
          // Skip unhealthy provider unless it's the last attempt
          attempts.push({
            provider: provider.name,
            model: provider.model,
            status: 'skipped',
            reason: 'Provider unhealthy',
            timestamp: new Date().toISOString()
          });
          continue;
        }

        // Execute request
        const result = await Promise.race([
          requestFn(provider.name, provider.model),
          this.timeoutPromise(timeout)
        ]);

        // Success
        const latency = Date.now() - attemptStart;
        attempts.push({
          provider: provider.name,
          model: provider.model,
          status: 'success',
          latency,
          timestamp: new Date().toISOString()
        });

        // Record success in history
        this.recordFailover({
          success: true,
          primaryProvider,
          usedProvider: provider.name,
          attempts: i + 1,
          totalTime: Date.now() - startTime,
          strategy
        });

        return {
          success: true,
          result,
          provider: provider.name,
          model: provider.model,
          attempts,
          totalTime: Date.now() - startTime
        };

      } catch (error) {
        const latency = Date.now() - attemptStart;
        attempts.push({
          provider: provider.name,
          model: provider.model,
          status: 'failed',
          error: error.message,
          latency,
          timestamp: new Date().toISOString()
        });

        // Log failure
        console.warn(
          `Failover attempt ${i + 1}/${maxAttempts} failed: ` +
          `${provider.name} - ${error.message}`
        );

        // If not the last attempt, continue to next provider
        if (i < Math.min(maxAttempts, providerList.length) - 1) {
          continue;
        }

        // All attempts failed
        this.recordFailover({
          success: false,
          primaryProvider,
          attempts: i + 1,
          totalTime: Date.now() - startTime,
          lastError: error.message,
          strategy
        });

        throw new Error(
          `All ${attempts.length} failover attempts failed. ` +
          `Last error: ${error.message}`
        );
      }
    }
  }

  /**
   * Build prioritized provider list berdasarkan strategy
   */
  buildProviderList(primaryProvider, taskType, strategy) {
    const providers = [];
    
    // 1. Add primary provider first if specified and healthy
    if (primaryProvider) {
      const model = this.getModelForProvider(primaryProvider, taskType);
      providers.push({
        name: primaryProvider,
        model,
        tier: PriorityTier.PRIMARY,
        priority: 1
      });
    }

    // 2. Get all available providers
    const allProviders = this.getAllProviders();
    
    // 3. Score and rank providers based on strategy
    const scoredProviders = allProviders
      .filter(p => p !== primaryProvider) // Exclude primary
      .map(providerName => {
        const score = this.scoreProvider(providerName, taskType, strategy);
        const model = this.getModelForProvider(providerName, taskType);
        const tier = this.getProviderTier(providerName);
        
        return {
          name: providerName,
          model,
          tier,
          score,
          priority: tier * 100 - score // Lower is better
        };
      })
      .sort((a, b) => a.priority - b.priority);

    // 4. Add scored providers
    providers.push(...scoredProviders);

    return providers;
  }

  /**
   * Score provider berdasarkan strategy dan health metrics
   */
  scoreProvider(providerName, taskType, strategy) {
    let score = 50; // Base score

    // Get health data
    const healthData = this.healthMonitor.healthData.get(providerName);
    
    if (!healthData || !healthData.current) {
      return 0; // Unknown provider gets lowest score
    }

    const current = healthData.current;

    // Health status bonus
    if (current.healthy) {
      score += 30;
    } else {
      score -= 20;
    }

    // Recent success rate
    if (healthData.history && healthData.history.length > 0) {
      const recent = healthData.history.slice(-10);
      const successRate = recent.filter(h => h.healthy).length / recent.length;
      score += successRate * 20;
    }

    // Strategy-specific scoring
    switch (strategy) {
      case FailoverStrategy.FASTEST:
        if (current.latency) {
          // Lower latency = higher score
          score += Math.max(0, 20 - (current.latency / 500));
        }
        break;

      case FailoverStrategy.MOST_RELIABLE:
        if (healthData.history) {
          const uptime = healthData.history.filter(h => h.healthy).length / 
                        healthData.history.length;
          score += uptime * 30;
        }
        break;

      case FailoverStrategy.CHEAPEST:
        // Prioritize free providers
        if (this.providerPriority.tertiary.includes(providerName)) {
          score += 25;
        } else if (this.providerPriority.fallback.includes(providerName)) {
          score += 30;
        }
        break;

      case FailoverStrategy.BALANCED:
      default:
        // Balance of all factors
        if (current.latency) {
          score += Math.max(0, 10 - (current.latency / 1000));
        }
        if (healthData.history) {
          const uptime = healthData.history.filter(h => h.healthy).length / 
                        healthData.history.length;
          score += uptime * 15;
        }
        break;
    }

    // Task capability bonus
    if (this.providerSupportsTask(providerName, taskType)) {
      score += 15;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Get provider tier
   */
  getProviderTier(providerName) {
    if (this.providerPriority.primary.includes(providerName)) {
      return PriorityTier.PRIMARY;
    }
    if (this.providerPriority.secondary.includes(providerName)) {
      return PriorityTier.SECONDARY;
    }
    if (this.providerPriority.tertiary.includes(providerName)) {
      return PriorityTier.TERTIARY;
    }
    return PriorityTier.FALLBACK;
  }

  /**
   * Check if provider supports task type
   */
  providerSupportsTask(providerName, taskType) {
    if (taskType === 'general') return true;

    const capabilities = this.modelCapabilities[taskType] || [];
    const provider = this.aiManager?.providers?.[providerName];
    
    if (!provider) return false;

    const models = provider.getAvailableModels?.() || [];
    
    // Check if provider has models for this task type
    return models.some(model => 
      capabilities.some(cap => 
        model.id.toLowerCase().includes(cap.toLowerCase())
      )
    );
  }

  /**
   * Get best model for provider based on task type
   */
  getModelForProvider(providerName, taskType) {
    const provider = this.aiManager?.providers?.[providerName];
    
    if (!provider) {
      return null;
    }

    // Ensure getAvailableModels returns an array
    const modelsResult = provider.getAvailableModels?.();
    const models = Array.isArray(modelsResult) ? modelsResult : [];
    
    if (models.length === 0) {
      return provider.defaultModel;
    }

    // Try to find model matching task type
    const capabilities = this.modelCapabilities[taskType] || [];
    
    for (const capability of capabilities) {
      const match = models.find(m => 
        m?.id?.toLowerCase?.().includes(capability.toLowerCase())
      );
      if (match) return match.id;
    }

    // Fallback to default or first model
    return provider.defaultModel || (models[0]?.id);
  }

  /**
   * Get all available providers
   */
  getAllProviders() {
    const all = [
      ...this.providerPriority.primary,
      ...this.providerPriority.secondary,
      ...this.providerPriority.tertiary,
      ...this.providerPriority.fallback
    ];

    // Filter to only configured providers
    return all.filter(name => {
      const provider = this.aiManager?.providers?.[name];
      return provider?.isConfigured?.() || false;
    });
  }

  /**
   * Timeout promise helper
   */
  timeoutPromise(ms) {
    return new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Request timeout after ${ms}ms`)), ms)
    );
  }

  /**
   * Record failover event in history
   */
  recordFailover(event) {
    this.failoverHistory.push({
      ...event,
      timestamp: new Date().toISOString()
    });

    // Limit history size
    if (this.failoverHistory.length > this.maxHistorySize) {
      this.failoverHistory.shift();
    }
  }

  /**
   * Get failover statistics
   */
  getFailoverStats() {
    if (this.failoverHistory.length === 0) {
      return {
        totalFailovers: 0,
        successRate: 0,
        avgAttempts: 0,
        avgTime: 0,
        byProvider: {},
        byStrategy: {}
      };
    }

    const total = this.failoverHistory.length;
    const successful = this.failoverHistory.filter(f => f.success).length;
    const successRate = (successful / total * 100).toFixed(1);

    const avgAttempts = this.failoverHistory.reduce((sum, f) => 
      sum + f.attempts, 0) / total;
    
    const avgTime = this.failoverHistory.reduce((sum, f) => 
      sum + f.totalTime, 0) / total;

    // Group by provider
    const byProvider = {};
    this.failoverHistory.forEach(f => {
      const provider = f.usedProvider || f.primaryProvider;
      if (!byProvider[provider]) {
        byProvider[provider] = { success: 0, failed: 0, total: 0 };
      }
      byProvider[provider].total++;
      if (f.success) {
        byProvider[provider].success++;
      } else {
        byProvider[provider].failed++;
      }
    });

    // Group by strategy
    const byStrategy = {};
    this.failoverHistory.forEach(f => {
      const strategy = f.strategy || 'unknown';
      if (!byStrategy[strategy]) {
        byStrategy[strategy] = { success: 0, failed: 0, total: 0 };
      }
      byStrategy[strategy].total++;
      if (f.success) {
        byStrategy[strategy].success++;
      } else {
        byStrategy[strategy].failed++;
      }
    });

    return {
      totalFailovers: total,
      successRate: successRate + '%',
      avgAttempts: avgAttempts.toFixed(1),
      avgTime: Math.round(avgTime) + 'ms',
      byProvider,
      byStrategy,
      recentFailovers: this.failoverHistory.slice(-10)
    };
  }

  /**
   * Get recommended provider for task
   */
  async getRecommendedProvider(taskType = 'general', options = {}) {
    const { strategy = this.strategy } = options;
    
    // Build and score providers
    const providers = this.buildProviderList(null, taskType, strategy);
    
    if (providers.length === 0) {
      return null;
    }

    // Check health of top 3 candidates
    const topCandidates = providers.slice(0, 3);
    const healthChecks = await Promise.all(
      topCandidates.map(p => this.healthMonitor.checkProvider(p.name))
    );

    // Find first healthy provider
    for (let i = 0; i < topCandidates.length; i++) {
      if (healthChecks[i].healthy) {
        return {
          provider: topCandidates[i].name,
          model: topCandidates[i].model,
          tier: topCandidates[i].tier,
          score: topCandidates[i].score,
          health: healthChecks[i]
        };
      }
    }

    // If no healthy provider in top 3, return best available
    return {
      provider: providers[0].name,
      model: providers[0].model,
      tier: providers[0].tier,
      score: providers[0].score,
      health: healthChecks[0]
    };
  }

  /**
   * Update provider priority configuration
   */
  updateProviderPriority(tier, providers) {
    if (this.providerPriority[tier]) {
      this.providerPriority[tier] = providers;
    }
  }

  /**
   * Set failover strategy
   */
  setStrategy(strategy) {
    if (Object.values(FailoverStrategy).includes(strategy)) {
      this.strategy = strategy;
    }
  }

  /**
   * Clear failover history
   */
  clearHistory() {
    this.failoverHistory = [];
  }
}

export default SmartFailoverSystem;
