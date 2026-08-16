// Wanar AI - Puter Provider
// Handles communication with Puter.js (Free Claude API)

import config from '../../config/config.js';

export class PuterProvider {
  constructor() {
    this.defaultModel = config.puter.defaultModel;
    this.enabled = config.puter.enabled;
  }

  async chat(messages, options = {}) {
    if (!this.enabled) {
      return {
        success: false,
        error: 'Puter provider is not enabled',
        provider: 'puter'
      };
    }

    const model = options.model || this.defaultModel;

    // Format messages for Puter.js
    const prompt = messages.map(m => {
      if (m.role === 'system') return `System: ${m.content}`;
      if (m.role === 'user') return `User: ${m.content}`;
      if (m.role === 'assistant') return `Assistant: ${m.content}`;
      return m.content;
    }).join('\n\n');

    try {
      // Note: Puter.js requires browser environment
      // For Node.js, we need to simulate or use a different approach
      // This is a placeholder implementation
      
      return {
        success: false,
        error: 'Puter.js requires browser environment. Use web interface for Puter provider.',
        provider: 'puter',
        note: 'Puter provider works best in web interface'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        provider: 'puter'
      };
    }
  }

  getAvailableModels() {
    return config.puter.models;
  }

  isAvailable() {
    return this.enabled && typeof window !== 'undefined';
  }
}

export default PuterProvider;
