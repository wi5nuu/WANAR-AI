#!/usr/bin/env node
/**
 * Health Monitor CLI - Interactive health monitoring untuk semua AI providers
 * Real-time dashboard, analytics, dan diagnostics
 * 
 * @author Wisnu Alfian Nur Ashar
 * @version 1.0.0
 */

import AIManager from '../ai-manager.js';
import ProviderHealthMonitor from './provider-health-monitor.js';
import ModelPerformanceAnalytics from './model-performance-analytics.js';
import SmartFailoverSystem from './smart-failover.js';
import config from '../../config/config.js';

// Terminal colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m'
};

class HealthMonitorCLI {
  constructor() {
    this.aiManager = new AIManager();
    this.healthMonitor = new ProviderHealthMonitor(this.aiManager);
    this.analytics = new ModelPerformanceAnalytics();
    this.failover = new SmartFailoverSystem(this.aiManager, this.healthMonitor);
    this.refreshInterval = null;
  }

  /**
   * Main entry point
   */
  async run() {
    const command = process.argv[2] || 'dashboard';
    const args = process.argv.slice(3);

    try {
      switch (command) {
        case 'dashboard':
        case 'dash':
          await this.showDashboard(args[0] === '--live');
          break;

        case 'check':
          await this.checkProviders(args);
          break;

        case 'provider':
          await this.showProviderDetail(args[0]);
          break;

        case 'analytics':
          await this.showAnalytics(args);
          break;

        case 'failover':
          await this.showFailoverStats();
          break;

        case 'test':
          await this.testProvider(args[0]);
          break;

        case 'recommend':
          await this.showRecommendation(args[0]);
          break;

        case 'export':
          await this.exportData(args[0]);
          break;

        case 'monitor':
          await this.startMonitoring(args[0]);
          break;

        case 'help':
        default:
          this.showHelp();
          break;
      }
    } catch (error) {
      console.error(`${colors.red}Error: ${error.message}${colors.reset}`);
      process.exit(1);
    }
  }

  /**
   * Show main dashboard
   */
  async showDashboard(live = false) {
    const showOnce = async () => {
      console.clear();
      this.printHeader('WANAR AI - Provider Health Dashboard');

      console.log(`${colors.gray}Checking all providers...${colors.reset}\n`);

      const summary = await this.healthMonitor.checkAllProviders();

      // Overall status
      this.printSection('Overall Status');
      console.log(`  Total Providers: ${colors.bright}${summary.overall.total}${colors.reset}`);
      console.log(`  ${colors.green}●${colors.reset} Healthy: ${summary.overall.healthy}`);
      console.log(`  ${colors.yellow}●${colors.reset} Degraded: ${summary.overall.degraded}`);
      console.log(`  ${colors.red}●${colors.reset} Unhealthy: ${summary.overall.unhealthy}`);
      console.log(`  ${colors.gray}●${colors.reset} Unknown: ${summary.overall.unknown}`);
      console.log();

      // Provider list
      this.printSection('Providers');
      console.log(`  ${'Provider'.padEnd(20)} ${'Status'.padEnd(12)} ${'Latency'.padEnd(12)} ${'Last Check'}`);
      console.log(`  ${colors.gray}${'─'.repeat(70)}${colors.reset}`);

      for (const provider of summary.providers) {
        const statusColor = this.getStatusColor(provider.status);
        const statusIcon = this.getStatusIcon(provider.status);
        const latency = provider.latency ? `${provider.latency}ms` : 'N/A';
        const lastCheck = provider.lastCheck ? 
          new Date(provider.lastCheck).toLocaleTimeString('id-ID') : 'Never';

        console.log(
          `  ${provider.name.padEnd(20)} ` +
          `${statusColor}${statusIcon} ${provider.status.padEnd(10)}${colors.reset} ` +
          `${latency.padEnd(12)} ` +
          `${colors.gray}${lastCheck}${colors.reset}`
        );
      }
      console.log();

      // Recent alerts
      if (summary.recentAlerts && summary.recentAlerts.length > 0) {
        this.printSection('Recent Alerts');
        summary.recentAlerts.slice(0, 5).forEach(alert => {
          const time = new Date(alert.timestamp).toLocaleTimeString('id-ID');
          console.log(
            `  ${colors.yellow}⚠${colors.reset} ${colors.gray}${time}${colors.reset} ` +
            `${colors.bright}${alert.provider}${colors.reset}: ${alert.message}`
          );
        });
        console.log();
      }

      console.log(`${colors.gray}Last updated: ${new Date().toLocaleTimeString('id-ID')}${colors.reset}`);
      
      if (live) {
        console.log(`${colors.gray}Refreshing in 30s... (Ctrl+C to exit)${colors.reset}`);
      } else {
        console.log(`\n${colors.dim}Tip: Use 'npm run analytics -- dashboard --live' for auto-refresh${colors.reset}`);
      }
    };

    await showOnce();

    if (live) {
      this.refreshInterval = setInterval(showOnce, 30000);
      
      // Handle Ctrl+C
      process.on('SIGINT', () => {
        if (this.refreshInterval) {
          clearInterval(this.refreshInterval);
        }
        console.log(`\n${colors.gray}Monitoring stopped.${colors.reset}`);
        process.exit(0);
      });
    }
  }

  /**
   * Check specific providers
   */
  async checkProviders(providerNames) {
    if (providerNames.length === 0) {
      providerNames = this.healthMonitor.getAvailableProviders();
    }

    this.printHeader('Provider Health Check');

    for (const name of providerNames) {
      console.log(`\n${colors.bright}Checking ${name}...${colors.reset}`);
      
      const health = await this.healthMonitor.checkProvider(name);
      
      const statusColor = health.healthy ? colors.green : colors.red;
      const statusIcon = health.healthy ? '✓' : '✗';
      
      console.log(`  Status: ${statusColor}${statusIcon} ${health.healthy ? 'Healthy' : 'Unhealthy'}${colors.reset}`);
      
      if (health.latency) {
        console.log(`  Latency: ${health.latency}ms`);
      }
      
      if (health.configured !== undefined) {
        console.log(`  Configured: ${health.configured ? 'Yes' : 'No'}`);
      }
      
      if (health.error) {
        console.log(`  ${colors.red}Error: ${health.error}${colors.reset}`);
      }
      
      if (health.stats) {
        console.log(`  Total Requests: ${health.stats.totalRequests}`);
        console.log(`  Success Rate: ${health.stats.successRate}`);
      }
    }
  }

  /**
   * Show detailed provider information
   */
  async showProviderDetail(providerName) {
    if (!providerName) {
      console.error(`${colors.red}Error: Provider name required${colors.reset}`);
      console.log('Usage: npm run analytics -- provider <provider-name>');
      return;
    }

    this.printHeader(`Provider Detail: ${providerName}`);

    const report = this.healthMonitor.getProviderReport(providerName);

    if (report.error) {
      console.error(`${colors.red}${report.error}${colors.reset}`);
      return;
    }

    // Current status
    this.printSection('Current Status');
    const statusColor = this.getStatusColor(report.status);
    console.log(`  Status: ${statusColor}${report.status}${colors.reset}`);
    console.log(`  Uptime: ${report.uptime}`);
    console.log(`  Health Checks: ${report.checks}`);
    console.log();

    // Recent history
    this.printSection('Recent History (Last 10 checks)');
    report.recentHistory.slice(-10).forEach(h => {
      const icon = h.healthy ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
      const time = new Date(h.timestamp).toLocaleTimeString('id-ID');
      const latency = h.latency ? `${h.latency}ms` : 'N/A';
      console.log(`  ${icon} ${colors.gray}${time}${colors.reset} - ${latency}`);
    });
    console.log();

    // Alerts
    if (report.alerts && report.alerts.length > 0) {
      this.printSection('Alerts');
      report.alerts.slice(-5).forEach(alert => {
        const time = new Date(alert.timestamp).toLocaleTimeString('id-ID');
        console.log(`  ${colors.yellow}⚠${colors.reset} ${colors.gray}${time}${colors.reset} - ${alert.message}`);
      });
      console.log();
    }

    // Recommendations
    if (report.recommendations && report.recommendations.length > 0) {
      this.printSection('Recommendations');
      report.recommendations.forEach(rec => {
        const severityColor = rec.severity === 'high' ? colors.red :
                             rec.severity === 'medium' ? colors.yellow : colors.blue;
        console.log(`  ${severityColor}[${rec.severity.toUpperCase()}]${colors.reset} ${rec.message}`);
        console.log(`  ${colors.dim}→ ${rec.action}${colors.reset}\n`);
      });
    }
  }

  /**
   * Show analytics
   */
  async showAnalytics(args) {
    const [provider, model] = args[0]?.split('/') || [];

    if (provider && model) {
      // Show specific model metrics
      this.printHeader(`Analytics: ${provider}/${model}`);
      const metrics = this.analytics.getModelMetrics(provider, model);

      if (metrics.error) {
        console.error(`${colors.red}${metrics.error}${colors.reset}`);
        return;
      }

      this.printSection('Summary');
      Object.entries(metrics.summary).forEach(([key, value]) => {
        console.log(`  ${key}: ${colors.bright}${value}${colors.reset}`);
      });
      console.log();

      this.printSection('Latency');
      console.log(`  Average: ${metrics.latency.avg}ms`);
      console.log(`  P50: ${metrics.latency.p50}ms`);
      console.log(`  P95: ${metrics.latency.p95}ms`);
      console.log(`  P99: ${metrics.latency.p99}ms`);
      console.log();

      this.printSection('Errors');
      console.log(`  Total: ${metrics.errors.total}`);
      console.log(`  Rate: ${metrics.errors.rate}`);
      if (Object.keys(metrics.errors.byType).length > 0) {
        console.log(`  By Type:`);
        Object.entries(metrics.errors.byType).forEach(([type, count]) => {
          console.log(`    ${type}: ${count}`);
        });
      }

    } else {
      // Show all models
      this.printHeader('Model Performance Analytics');
      const models = this.analytics.getAllModels();

      if (models.length === 0) {
        console.log('No analytics data available yet.');
        return;
      }

      // Compare all models
      const comparison = this.analytics.compareModels(models);

      this.printSection('Best Performers');
      console.log(`  Fastest: ${colors.green}${comparison.best.fastest || 'N/A'}${colors.reset}`);
      console.log(`  Most Reliable: ${colors.green}${comparison.best.mostReliable || 'N/A'}${colors.reset}`);
      console.log(`  Cheapest: ${colors.green}${comparison.best.cheapest || 'N/A'}${colors.reset}`);
      console.log(`  Highest Quality: ${colors.green}${comparison.best.highestQuality || 'N/A'}${colors.reset}`);
      console.log();

      if (comparison.recommendation) {
        this.printSection('Recommendation');
        console.log(`  ${colors.bright}${comparison.recommendation.recommended}${colors.reset}`);
        console.log(`  Score: ${comparison.recommendation.score}/100`);
        console.log(`  Reason: ${comparison.recommendation.reason}`);
      }
    }
  }

  /**
   * Show failover statistics
   */
  async showFailoverStats() {
    this.printHeader('Smart Failover Statistics');

    const stats = this.failover.getFailoverStats();

    this.printSection('Overview');
    console.log(`  Total Failovers: ${stats.totalFailovers}`);
    console.log(`  Success Rate: ${colors.green}${stats.successRate}${colors.reset}`);
    console.log(`  Avg Attempts: ${stats.avgAttempts}`);
    console.log(`  Avg Time: ${stats.avgTime}`);
    console.log();

    if (Object.keys(stats.byProvider).length > 0) {
      this.printSection('By Provider');
      Object.entries(stats.byProvider).forEach(([provider, data]) => {
        const successRate = ((data.success / data.total) * 100).toFixed(1);
        console.log(
          `  ${provider.padEnd(20)} ` +
          `Success: ${data.success}/${data.total} (${successRate}%)`
        );
      });
      console.log();
    }

    if (stats.recentFailovers && stats.recentFailovers.length > 0) {
      this.printSection('Recent Failovers');
      stats.recentFailovers.slice(0, 5).forEach(f => {
        const icon = f.success ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
        const time = new Date(f.timestamp).toLocaleTimeString('id-ID');
        console.log(
          `  ${icon} ${colors.gray}${time}${colors.reset} ` +
          `${f.primaryProvider} → ${f.usedProvider || 'failed'} ` +
          `(${f.attempts} attempts, ${f.totalTime}ms)`
        );
      });
    }
  }

  /**
   * Test provider connection
   */
  async testProvider(providerName) {
    if (!providerName) {
      console.error(`${colors.red}Error: Provider name required${colors.reset}`);
      return;
    }

    this.printHeader(`Testing ${providerName}`);

    console.log(`${colors.gray}Running connection test...${colors.reset}\n`);

    const startTime = Date.now();
    const health = await this.healthMonitor.checkProvider(providerName);
    const duration = Date.now() - startTime;

    if (health.healthy) {
      console.log(`${colors.green}✓ Test passed${colors.reset}`);
      console.log(`  Duration: ${duration}ms`);
      console.log(`  Latency: ${health.latency}ms`);
      if (health.modelsAvailable) {
        console.log(`  Models Available: ${health.modelsAvailable}`);
      }
    } else {
      console.log(`${colors.red}✗ Test failed${colors.reset}`);
      console.log(`  Error: ${health.error}`);
      if (health.userFriendlyError) {
        console.log(`  ${colors.yellow}${health.userFriendlyError}${colors.reset}`);
      }
    }
  }

  /**
   * Show recommendation for task
   */
  async showRecommendation(taskType = 'general') {
    this.printHeader(`Provider Recommendation: ${taskType}`);

    const rec = await this.failover.getRecommendedProvider(taskType);

    if (!rec) {
      console.log(`${colors.yellow}No healthy providers available${colors.reset}`);
      return;
    }

    console.log(`\n${colors.bright}Recommended Provider${colors.reset}`);
    console.log(`  Provider: ${colors.green}${rec.provider}${colors.reset}`);
    console.log(`  Model: ${rec.model}`);
    console.log(`  Tier: ${rec.tier}`);
    console.log(`  Score: ${rec.score}/100`);
    console.log();

    if (rec.health) {
      console.log(`${colors.bright}Health Status${colors.reset}`);
      console.log(`  Healthy: ${rec.health.healthy ? 'Yes' : 'No'}`);
      if (rec.health.latency) {
        console.log(`  Latency: ${rec.health.latency}ms`);
      }
    }
  }

  /**
   * Export health data
   */
  async exportData(format = 'json') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `wanar-health-${timestamp}.${format}`;

    console.log(`${colors.gray}Exporting health data...${colors.reset}`);

    const filepath = this.healthMonitor.exportHealthData(filename);

    console.log(`${colors.green}✓ Data exported to: ${filepath}${colors.reset}`);
  }

  /**
   * Start continuous monitoring
   */
  async startMonitoring(intervalSec = '60') {
    const interval = parseInt(intervalSec) * 1000;

    this.printHeader('Starting Health Monitoring');
    console.log(`  Interval: ${intervalSec}s`);
    console.log(`  Press Ctrl+C to stop\n`);

    this.healthMonitor.startMonitoring(interval);

    // Keep process alive
    process.on('SIGINT', () => {
      this.healthMonitor.stopMonitoring();
      console.log(`\n${colors.gray}Monitoring stopped.${colors.reset}`);
      process.exit(0);
    });

    // Initial check
    await this.showDashboard(true);
  }

  /**
   * Print header
   */
  printHeader(title) {
    console.log(`\n${colors.bright}${colors.cyan}${title}${colors.reset}`);
    console.log(`${colors.gray}${'═'.repeat(title.length)}${colors.reset}\n`);
  }

  /**
   * Print section
   */
  printSection(title) {
    console.log(`${colors.bright}${title}${colors.reset}`);
  }

  /**
   * Get status color
   */
  getStatusColor(status) {
    switch (status) {
      case 'healthy': return colors.green;
      case 'degraded': return colors.yellow;
      case 'unhealthy': return colors.red;
      default: return colors.gray;
    }
  }

  /**
   * Get status icon
   */
  getStatusIcon(status) {
    switch (status) {
      case 'healthy': return '✓';
      case 'degraded': return '⚠';
      case 'unhealthy': return '✗';
      default: return '?';
    }
  }

  /**
   * Show help
   */
  showHelp() {
    console.log(`
${colors.bright}${colors.cyan}WANAR AI - Health Monitor CLI${colors.reset}

${colors.bright}Usage:${colors.reset}
  npm run analytics -- [command] [options]

${colors.bright}Commands:${colors.reset}
  dashboard [--live]          Show health dashboard (default)
  check [providers...]        Check specific providers
  provider <name>             Show detailed provider report
  analytics [provider/model]  Show performance analytics
  failover                    Show failover statistics
  test <provider>             Test provider connection
  recommend [taskType]        Get provider recommendation
  export [format]             Export health data (default: json)
  monitor [interval]          Start continuous monitoring (default: 60s)
  help                        Show this help

${colors.bright}Examples:${colors.reset}
  npm run analytics -- dashboard --live
  npm run analytics -- check openagentic nvidia
  npm run analytics -- provider openagentic
  npm run analytics -- analytics openagentic/claude-sonnet-4.5
  npm run analytics -- test nvidia
  npm run analytics -- recommend coding
  npm run analytics -- monitor 30

${colors.gray}Made with ❤️ by Wisnu${colors.reset}
    `);
  }
}

// Run CLI
const cli = new HealthMonitorCLI();
cli.run().catch(error => {
  console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
  process.exit(1);
});
