/**
 * Intelligent Model Router - Smart Model Selection & Load Balancing
 * Automatically selects optimal model based on task type, cost, and performance
 * 
 * Features:
 * - Task-based routing (coding, reasoning, general, creative)
 * - Cost optimization (use cheapest model that meets quality threshold)
 * - Load balancing across providers
 * - Automatic fallback on errors
 * - Performance tracking & learning
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 2.0.0
 */

export default class IntelligentModelRouter {
  constructor() {
    // Model capabilities matrix
    this.modelCapabilities = {
      // OpenAgentic models
      'openagentic/claude-sonnet-4.5': {
        provider: 'openagentic',
        strengths: ['coding', 'reasoning', 'analysis', 'long-context'],
        contextWindow: 200000,
        cost: 0, // Unlimited in plan
        speed: 'fast',
        quality: 0.95,
        recommended: true
      },
      'openagentic/claude-sonnet-4.6': {
        provider: 'openagentic',
        strengths: ['coding', 'reasoning', 'latest'],
        contextWindow: 200000,
        cost: 0.003,
        speed: 'fast',
        quality: 0.97
      },
      'openagentic/grok-4.5': {
        provider: 'openagentic',
        strengths: ['reasoning', 'creative', 'fast'],
        contextWindow: 128000,
        cost: 0.002,
        speed: 'very-fast',
        quality: 0.90
      },

      // NVIDIA models
      'nvidia/deepseek-v4-pro': {
        provider: 'nvidia',
        strengths: ['coding', 'reasoning', 'cost-effective'],
        contextWindow: 128000,
        cost: 0.0015,
        speed: 'fast',
        quality: 0.92
      },
      'nvidia/deepseek-v4-flash': {
        provider: 'nvidia',
        strengths: ['coding', 'fast', 'budget'],
        contextWindow: 128000,
        cost: 0.0008,
        speed: 'very-fast',
        quality: 0.85
      },
      'nvidia/llama-3.1-405b': {
        provider: 'nvidia',
        strengths: ['reasoning', 'complex', 'analysis'],
        contextWindow: 128000,
        cost: 0.005,
        speed: 'medium',
        quality: 0.94
      },

      // Vector models
      'vector/claude-sonnet-5': {
        provider: 'vector',
        strengths: ['coding', 'reasoning', 'enterprise'],
        contextWindow: 200000,
        cost: 0.004,
        speed: 'fast',
        quality: 0.96
      }
    };

    // Task type definitions
    this.taskTypes = {
      coding: {
        keywords: ['code', 'function', 'class', 'bug', 'error', 'implement', 'refactor', 'debug', 'api', 'algorithm'],
        preferredModels: [
          'openagentic/claude-sonnet-4.5',
          'nvidia/deepseek-v4-pro',
          'vector/claude-sonnet-5'
        ],
        minQuality: 0.90
      },
      reasoning: {
        keywords: ['why', 'how', 'explain', 'analyze', 'compare', 'evaluate', 'logic', 'reason', 'think'],
        preferredModels: [
          'openagentic/claude-sonnet-4.5',
          'nvidia/llama-3.1-405b',
          'openagentic/grok-4.5'
        ],
        minQuality: 0.90
      },
      creative: {
        keywords: ['write', 'create', 'generate', 'design', 'story', 'content', 'draft', 'compose'],
        preferredModels: [
          'openagentic/grok-4.5',
          'openagentic/claude-sonnet-4.5'
        ],
        minQuality: 0.85
      },
      general: {
        keywords: ['what', 'who', 'when', 'where', 'tell', 'show', 'list', 'find'],
        preferredModels: [
          'nvidia/deepseek-v4-flash',
          'openagentic/grok-4.5',
          'openagentic/claude-sonnet-4.5'
        ],
        minQuality: 0.80
      },
      longContext: {
        keywords: ['large', 'entire', 'whole', 'all', 'complete', 'full', 'comprehensive'],
        preferredModels: [
          'openagentic/claude-sonnet-4.5',
          'vector/claude-sonnet-5'
        ],
        minQuality: 0.90,
        requiresLargeContext: true
      }
    };

    // Performance tracking
    this.performanceStats = {};
    this.loadBalancing = {
      currentLoad: {},
      maxConcurrent: 10,
      errorCount: {}
    };

    // Routing strategy
    this.strategy = 'quality-cost-balanced'; // 'quality-first', 'cost-first', 'quality-cost-balanced', 'speed-first'
    
    this.initializeStats();
  }

  /**
   * Initialize performance statistics
   */
  initializeStats() {
    Object.keys(this.modelCapabilities).forEach(model => {
      this.performanceStats[model] = {
        requests: 0,
        successes: 0,
        failures: 0,
        avgLatency: 0,
        avgCost: 0,
        totalCost: 0,
        lastUsed: null,
        userSatisfaction: 0.5 // Start neutral
      };

      this.loadBalancing.currentLoad[model] = 0;
      this.loadBalancing.errorCount[model] = 0;
    });
  }

  /**
   * Route request to optimal model
   */
  async route(request, options = {}) {
    const {
      userMessage,
      conversationHistory = [],
      forceProvider = null,
      forceModel = null,
      maxCost = null,
      minQuality = null,
      requireSpeed = null
    } = request;

    // If model is explicitly specified, use it
    if (forceModel) {
      return {
        provider: this.getProviderFromModel(forceModel),
        model: forceModel,
        reason: 'explicitly-specified'
      };
    }

    // Detect task type
    const taskType = this.detectTaskType(userMessage, conversationHistory);
    
    // Estimate context size
    const contextSize = this.estimateContextSize(userMessage, conversationHistory);

    // Get candidate models
    let candidates = this.getCandidateModels(taskType, contextSize, {
      forceProvider,
      maxCost,
      minQuality: minQuality || taskType.minQuality,
      requireSpeed
    });

    // Apply routing strategy
    const selected = this.applyRoutingStrategy(candidates, taskType, options);

    // Update load balancing
    this.loadBalancing.currentLoad[selected.model]++;

    return {
      provider: selected.provider,
      model: selected.model,
      taskType: taskType.name,
      reason: selected.reason,
      alternatives: candidates.slice(0, 3).map(c => ({ provider: c.provider, model: c.model, score: c.score })),
      estimatedCost: selected.cost,
      estimatedQuality: selected.quality
    };
  }

  /**
   * Detect task type from user message
   */
  detectTaskType(userMessage, conversationHistory = []) {
    const text = (userMessage + ' ' + conversationHistory.slice(-3).map(m => m.content).join(' ')).toLowerCase();
    
    const scores = {};
    
    // Score each task type
    Object.entries(this.taskTypes).forEach(([typeName, typeConfig]) => {
      let score = 0;
      typeConfig.keywords.forEach(keyword => {
        if (text.includes(keyword)) score++;
      });
      scores[typeName] = score;
    });

    // Find highest scoring task type
    const maxScore = Math.max(...Object.values(scores));
    const detectedType = Object.keys(scores).find(key => scores[key] === maxScore) || 'general';

    return {
      name: detectedType,
      ...this.taskTypes[detectedType],
      confidence: maxScore / this.taskTypes[detectedType].keywords.length
    };
  }

  /**
   * Estimate context size needed
   */
  estimateContextSize(userMessage, conversationHistory = []) {
    const messageTokens = Math.ceil(userMessage.length / 4);
    const historyTokens = conversationHistory.reduce((sum, msg) => sum + Math.ceil(msg.content.length / 4), 0);
    return messageTokens + historyTokens;
  }

  /**
   * Get candidate models for task
   */
  getCandidateModels(taskType, contextSize, filters = {}) {
    let candidates = [];

    // Start with preferred models for task type
    taskType.preferredModels.forEach(modelId => {
      const capability = this.modelCapabilities[modelId];
      if (!capability) return;

      // Apply filters
      if (filters.forceProvider && capability.provider !== filters.forceProvider) return;
      if (filters.maxCost && capability.cost > filters.maxCost) return;
      if (filters.minQuality && capability.quality < filters.minQuality) return;
      if (contextSize > capability.contextWindow) return;

      // Check load balancing
      if (this.loadBalancing.currentLoad[modelId] >= this.loadBalancing.maxConcurrent) return;
      
      // Check error rate
      const errorRate = this.calculateErrorRate(modelId);
      if (errorRate > 0.3) return; // Skip if >30% error rate

      candidates.push({
        model: modelId,
        provider: capability.provider,
        capability,
        score: 0 // Will be calculated by strategy
      });
    });

    // If no candidates from preferred, expand to all compatible models
    if (candidates.length === 0) {
      Object.entries(this.modelCapabilities).forEach(([modelId, capability]) => {
        if (filters.forceProvider && capability.provider !== filters.forceProvider) return;
        if (filters.maxCost && capability.cost > filters.maxCost) return;
        if (filters.minQuality && capability.quality < filters.minQuality) return;
        if (contextSize > capability.contextWindow) return;
        
        const errorRate = this.calculateErrorRate(modelId);
        if (errorRate > 0.3) return;

        candidates.push({
          model: modelId,
          provider: capability.provider,
          capability,
          score: 0
        });
      });
    }

    return candidates;
  }

  /**
   * Apply routing strategy to select best model
   */
  applyRoutingStrategy(candidates, taskType, options = {}) {
    if (candidates.length === 0) {
      // Fallback to default
      return {
        model: 'openagentic/claude-sonnet-4.5',
        provider: 'openagentic',
        reason: 'fallback-default',
        cost: 0,
        quality: 0.95
      };
    }

    // Score each candidate based on strategy
    candidates.forEach(candidate => {
      const cap = candidate.capability;
      const perf = this.performanceStats[candidate.model];

      switch (this.strategy) {
        case 'quality-first':
          candidate.score = cap.quality * 0.7 + perf.userSatisfaction * 0.3;
          break;

        case 'cost-first':
          candidate.score = (1 - cap.cost / 0.01) * 0.7 + cap.quality * 0.3;
          break;

        case 'speed-first':
          const speedScore = { 'very-fast': 1.0, 'fast': 0.8, 'medium': 0.6, 'slow': 0.4 }[cap.speed];
          candidate.score = speedScore * 0.7 + cap.quality * 0.3;
          break;

        case 'quality-cost-balanced':
        default:
          // Balance quality, cost, and performance
          const qualityScore = cap.quality * 0.4;
          const costScore = (1 - cap.cost / 0.01) * 0.3;
          const perfScore = (perf.successes / Math.max(perf.requests, 1)) * 0.2;
          const satisfactionScore = perf.userSatisfaction * 0.1;
          
          candidate.score = qualityScore + costScore + perfScore + satisfactionScore;
          break;
      }

      // Boost recommended models
      if (cap.recommended) candidate.score *= 1.1;

      // Penalize models with high error rates
      const errorRate = this.calculateErrorRate(candidate.model);
      candidate.score *= (1 - errorRate * 0.5);
    });

    // Sort by score
    candidates.sort((a, b) => b.score - a.score);

    const selected = candidates[0];
    
    return {
      model: selected.model,
      provider: selected.provider,
      reason: `${this.strategy}-routing`,
      cost: selected.capability.cost,
      quality: selected.capability.quality,
      score: selected.score
    };
  }

  /**
   * Calculate error rate for model
   */
  calculateErrorRate(modelId) {
    const stats = this.performanceStats[modelId];
    if (stats.requests === 0) return 0;
    return stats.failures / stats.requests;
  }

  /**
   * Get provider from model ID
   */
  getProviderFromModel(modelId) {
    const capability = this.modelCapabilities[modelId];
    return capability ? capability.provider : 'openagentic';
  }

  /**
   * Record request result for learning
   */
  recordResult(modelId, result) {
    const stats = this.performanceStats[modelId];
    if (!stats) return;

    stats.requests++;
    stats.lastUsed = Date.now();

    if (result.success) {
      stats.successes++;
      
      // Update average latency
      if (result.latency) {
        stats.avgLatency = stats.avgLatency === 0 
          ? result.latency 
          : (stats.avgLatency * (stats.successes - 1) + result.latency) / stats.successes;
      }

      // Update cost
      if (result.cost !== undefined) {
        stats.totalCost += result.cost;
        stats.avgCost = stats.totalCost / stats.successes;
      }

      // Reset error count
      this.loadBalancing.errorCount[modelId] = 0;
    } else {
      stats.failures++;
      this.loadBalancing.errorCount[modelId]++;
    }

    // Decrease load
    this.loadBalancing.currentLoad[modelId] = Math.max(0, this.loadBalancing.currentLoad[modelId] - 1);
  }

  /**
   * Record user feedback (for learning)
   */
  recordFeedback(modelId, satisfaction) {
    const stats = this.performanceStats[modelId];
    if (!stats) return;

    // Update satisfaction score (0-1 scale)
    if (stats.userSatisfaction === 0.5) {
      stats.userSatisfaction = satisfaction;
    } else {
      stats.userSatisfaction = stats.userSatisfaction * 0.9 + satisfaction * 0.1;
    }
  }

  /**
   * Set routing strategy
   */
  setStrategy(strategy) {
    const validStrategies = ['quality-first', 'cost-first', 'quality-cost-balanced', 'speed-first'];
    if (validStrategies.includes(strategy)) {
      this.strategy = strategy;
      return true;
    }
    return false;
  }

  /**
   * Get routing statistics
   */
  getStats() {
    const stats = {};
    
    Object.entries(this.performanceStats).forEach(([model, data]) => {
      stats[model] = {
        requests: data.requests,
        successRate: data.requests > 0 ? ((data.successes / data.requests) * 100).toFixed(2) + '%' : 'N/A',
        avgLatency: data.avgLatency > 0 ? Math.round(data.avgLatency) + 'ms' : 'N/A',
        avgCost: data.avgCost > 0 ? '$' + data.avgCost.toFixed(6) : 'N/A',
        totalCost: '$' + data.totalCost.toFixed(4),
        userSatisfaction: (data.userSatisfaction * 100).toFixed(0) + '%',
        lastUsed: data.lastUsed ? new Date(data.lastUsed).toLocaleString() : 'Never',
        currentLoad: this.loadBalancing.currentLoad[model]
      };
    });

    return {
      strategy: this.strategy,
      models: stats,
      totalRequests: Object.values(this.performanceStats).reduce((sum, s) => sum + s.requests, 0),
      totalCost: Object.values(this.performanceStats).reduce((sum, s) => sum + s.totalCost, 0)
    };
  }

  /**
   * Get model recommendations
   */
  getRecommendations(taskType = null) {
    const recommendations = [];

    if (taskType && this.taskTypes[taskType]) {
      const task = this.taskTypes[taskType];
      recommendations.push({
        taskType,
        recommendedModels: task.preferredModels.map(modelId => ({
          model: modelId,
          provider: this.modelCapabilities[modelId]?.provider,
          quality: this.modelCapabilities[modelId]?.quality,
          cost: this.modelCapabilities[modelId]?.cost,
          speed: this.modelCapabilities[modelId]?.speed
        }))
      });
    } else {
      // General recommendations
      Object.entries(this.taskTypes).forEach(([typeName, typeConfig]) => {
        recommendations.push({
          taskType: typeName,
          description: typeConfig.keywords.slice(0, 5).join(', '),
          recommendedModels: typeConfig.preferredModels.slice(0, 2)
        });
      });
    }

    return recommendations;
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.initializeStats();
  }
}
