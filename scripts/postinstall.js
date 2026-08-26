#!/usr/bin/env node
/**
 * Post-install script for Wanar AI
 * Sets up user configuration after npm install
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(msg, color = colors.reset) {
  console.log(color + msg + colors.reset);
}

function setupGlobalConfig() {
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.wanar-ai');
  const envPath = path.join(configDir, '.env');
  const envExamplePath = path.join(__dirname, '..', '.env.example');

  try {
    // Create config directory if it doesn't exist
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
      log(`✓ Created config directory: ${configDir}`, colors.green);
    }

    // Copy .env.example to ~/.wanar-ai/.env if it doesn't exist
    if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
      fs.copyFileSync(envExamplePath, envPath);
      log(`✓ Created configuration file: ${envPath}`, colors.green);
      log('', colors.reset);
      log('⚠️  IMPORTANT: Please edit the config file and add your API keys:', colors.yellow);
      log(`   ${envPath}`, colors.cyan);
      log('', colors.reset);
    } else if (fs.existsSync(envPath)) {
      log(`✓ Configuration file already exists: ${envPath}`, colors.blue);
    }
  } catch (error) {
    log(`⚠️  Warning: Could not set up global config: ${error.message}`, colors.yellow);
  }
}

log('', colors.reset);
log('═══════════════════════════════════════════════════════════', colors.blue);
log('  Thank you for installing Wanar AI! 🚀', colors.bright);
log('  Professional Multi-Provider AI Agent', colors.cyan);
log('═══════════════════════════════════════════════════════════', colors.blue);
log('', colors.reset);

setupGlobalConfig();

log('', colors.reset);
log('Getting Started:', colors.bright);
log('  1. Edit your config file and add API keys', colors.reset);
log('  2. Run: wanarai', colors.cyan);
log('  3. Choose CLI or Web interface', colors.reset);
log('', colors.reset);
log('Documentation:', colors.bright);
log('  • README.md in the package directory', colors.reset);
log('  • .env.example for all configuration options', colors.reset);
log('', colors.reset);
log('Need help? Report issues or get support at:', colors.bright);
log('  https://github.com/wisnunugroho21/wanar-ai', colors.cyan);
log('', colors.reset);
