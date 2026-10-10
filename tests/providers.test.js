/**
 * tests/providers.test.js
 * Unit tests for all AI providers (no real network calls)
 *
 * Key facts discovered from probing:
 * - Most providers: getAvailableModels() returns a Promise (async method)
 * - Anthropic: getAvailableModels() returns array sync; no name/isConfigured on instance
 * - Puter: no name/isConfigured/chatStream; only chat/getAvailableModels/isAvailable
 * - Several providers throw instead of returning {success:false} when apiKey=''.
 *   We handle that with try/catch in those tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import BaseProvider from '../src/providers/base-provider.js';
import { EnhancedBaseProvider } from '../src/providers/enhanced-base-provider.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GroqProvider } from '../src/providers/groq.js';
import OpenAgenticProvider from '../src/providers/openagentic.js';
import { NVIDIAProvider } from '../src/providers/nvidia.js';
import { AzureOpenAIProvider } from '../src/providers/azure-openai.js';
import CerebrasProvider from '../src/providers/cerebras.js';
import TogetherProvider from '../src/providers/together.js';
import FireworksProvider from '../src/providers/fireworks.js';
import HyperbolicProvider from '../src/providers/hyperbolic.js';
import SambaNovaProvider from '../src/providers/sambanova.js';
import HuggingFaceProvider from '../src/providers/huggingface.js';
import OpenCodeProvider from '../src/providers/opencode.js';
import { PuterProvider } from '../src/providers/puter.js';
import { VectorProvider } from '../src/providers/vector.js';

const SIMPLE_MSGS = [{ role: 'user', content: 'Hello' }];

// Helper: call chat and get result, catching throws to normalise
async function safeChat(provider, msgs = SIMPLE_MSGS) {
  try {
    return await provider.chat(msgs);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EnhancedBaseProvider
// ─────────────────────────────────────────────────────────────────────────────
describe('EnhancedBaseProvider', () => {
  let p;
  beforeEach(() => {
    p = new EnhancedBaseProvider({
      name: 'TestEnhanced',
      apiKey: 'test-key',
      baseUrl: 'https://example.com/v1',
      defaultModel: 'test-model',
    });
  });

  it('inherits from BaseProvider', () => expect(p).toBeInstanceOf(BaseProvider));
  it('circuit breaker starts CLOSED', () => expect(p.circuit.state).toBe('CLOSED'));
  it('retryConfig has sensible defaults', () => {
    expect(p.retryConfig.maxAttempts).toBeGreaterThanOrEqual(1);
    expect(p.retryConfig.baseDelay).toBeGreaterThan(0);
    expect(p.retryConfig.maxDelay).toBeGreaterThan(p.retryConfig.baseDelay);
  });
  it('enhancedStats initialised', () => {
    expect(p.enhancedStats).toBeDefined();
    expect(typeof p.enhancedStats.errorsByType).toBe('object');
    expect(p.enhancedStats.retries).toBe(0);
    expect(p.enhancedStats.circuitBreaks).toBe(0);
  });
  it('classifyError: 429 → RATE_LIMIT', () => {
    const err = Object.assign(new Error('rate limit'), { response: { status: 429 } });
    expect(p.classifyError(err)).toBe('RATE_LIMIT');
  });
  it('classifyError: 401 → AUTH', () => {
    const err = Object.assign(new Error('unauthorized'), { response: { status: 401 } });
    expect(p.classifyError(err)).toBe('AUTH');
  });
  it('classifyError: 403 → AUTH', () => {
    const err = Object.assign(new Error('forbidden'), { response: { status: 403 } });
    expect(p.classifyError(err)).toBe('AUTH');
  });
  it('classifyError: timeout message → TIMEOUT', () => {
    expect(p.classifyError(new Error('request timed out'))).toBe('TIMEOUT');
  });
  it('classifyError: 500 → SERVER', () => {
    const err = Object.assign(new Error('server error'), { response: { status: 500 } });
    expect(p.classifyError(err)).toBe('SERVER');
  });
  it('classifyError: 400 → INVALID_REQUEST', () => {
    const err = Object.assign(new Error('bad request'), { response: { status: 400 } });
    expect(p.classifyError(err)).toBe('INVALID_REQUEST');
  });
  it('classifyError: unknown → UNKNOWN', () => {
    expect(p.classifyError(new Error('something completely random xyz'))).toBe('UNKNOWN');
  });
  it('isRetryableError: RATE_LIMIT is retryable', () => expect(p.isRetryableError('RATE_LIMIT')).toBe(true));
  it('isRetryableError: TIMEOUT is retryable', () => expect(p.isRetryableError('TIMEOUT')).toBe(true));
  it('isRetryableError: SERVER is retryable', () => expect(p.isRetryableError('SERVER')).toBe(true));
  it('isRetryableError: AUTH is NOT retryable', () => expect(p.isRetryableError('AUTH')).toBe(false));
  it('isRetryableError: INVALID_REQUEST is NOT retryable', () => expect(p.isRetryableError('INVALID_REQUEST')).toBe(false));
  it('calculateDelay returns positive number', () => expect(p.calculateDelay(1)).toBeGreaterThan(0));
  it('calculateDelay does not exceed maxDelay (+15% jitter)', () => {
    for (let i = 1; i <= 20; i++) {
      expect(p.calculateDelay(i)).toBeLessThanOrEqual(p.retryConfig.maxDelay * 1.15);
    }
  });
  it('canMakeRequest returns true when circuit CLOSED', () => expect(p.canMakeRequest()).toBe(true));
  it('recordSuccess increments consecutiveSuccesses', () => {
    p.recordSuccess();
    expect(p.health.consecutiveSuccesses).toBeGreaterThanOrEqual(1);
  });
  it('recordFailure increments consecutiveFailures', () => {
    p.recordFailure(new Error('fail'));
    expect(p.health.consecutiveFailures).toBeGreaterThanOrEqual(1);
  });
  it('getEnhancedStats returns object with errorsByType and performance', () => {
    const s = p.getEnhancedStats();
    expect(s.errorsByType).toBeDefined();
    expect(s.performance).toBeDefined();
  });
  it('resetCircuit resets circuit state to CLOSED', () => {
    p.circuit.state = 'OPEN';
    p.resetCircuit();
    expect(p.circuit.state).toBe('CLOSED');
  });
  it('getUserFriendlyError returns non-empty string', () => {
    const msg = p.getUserFriendlyError(new Error('rate limit'));
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });
  it('recordPerformance adds to responseTimes', () => {
    const before = p.enhancedStats.responseTimes.length;
    p.recordPerformance(100);
    expect(p.enhancedStats.responseTimes.length).toBe(before + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Provider
// ─────────────────────────────────────────────────────────────────────────────
describe('OpenAIProvider', () => {
  let p;
  beforeEach(() => { p = new OpenAIProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('name is OpenAI', () => expect(p.name).toBe('OpenAI'));
  it('defaultModel set', () => expect(typeof p.defaultModel).toBe('string'));
  it('capabilities.streaming true', () => expect(p.capabilities.streaming).toBe(true));
  it('capabilities.toolCalling true', () => expect(p.capabilities.toolCalling).toBe(true));
  it('capabilities.vision true', () => expect(p.capabilities.vision).toBe(true));
  it('getAvailableModels returns array (async)', async () => {
    const m = await p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
    expect(m.length).toBeGreaterThan(0);
  });
  it('getAvailableModels includes gpt-4o', async () => {
    const m = await p.getAvailableModels();
    const ids = m.map(x => x.id || x);
    expect(ids.some(id => id.includes('gpt-4o'))).toBe(true);
  });
  it('isConfigured false without API key', () => {
    const orig = p.apiKey; p.apiKey = '';
    expect(p.isConfigured()).toBe(false);
    p.apiKey = orig;
  });
  it('chat returns error when not configured', async () => {
    p.apiKey = '';
    const res = await safeChat(p);
    expect(res.success).toBe(false);
  });
  it('convertToolsFormat wraps tools correctly', () => {
    const tools = [{ name: 'foo', description: 'bar', parameters: {} }];
    const converted = p.convertToolsFormat(tools);
    expect(Array.isArray(converted)).toBe(true);
    expect(converted[0].type).toBe('function');
    expect(converted[0].function.name).toBe('foo');
  });
  it('isAvailable returns boolean', () => expect(typeof p.isAvailable()).toBe('boolean'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Gemini Provider
// ─────────────────────────────────────────────────────────────────────────────
describe('GeminiProvider', () => {
  let p;
  beforeEach(() => { p = new GeminiProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('name is Gemini', () => expect(p.name).toBe('Gemini'));
  it('maxContextTokens is 2M', () => expect(p.maxContextTokens).toBe(2000000));
  it('capabilities.codeExecution true', () => expect(p.capabilities.codeExecution).toBe(true));
  it('getAvailableModels returns gemini models (async)', async () => {
    const m = await p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
    expect(m.some(x => (x.id || x).includes('gemini'))).toBe(true);
  });
  it('chat returns error when not configured', async () => {
    p.apiKey = '';
    const res = await safeChat(p);
    expect(res.success).toBe(false);
  });
  it('convertToGeminiFormat converts messages', () => {
    const msgs = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ];
    const result = p.convertToGeminiFormat(msgs);
    expect(result).toHaveProperty('contents');
    expect(Array.isArray(result.contents)).toBe(true);
    const modelTurn = result.contents.find(c => c.role === 'model');
    expect(modelTurn).toBeDefined();
  });
  it('convertToolsFormat returns flat function declaration objects', () => {
    const tools = [{ name: 'my_tool', description: 'does stuff', parameters: { type: 'object', properties: {} } }];
    const converted = p.convertToolsFormat(tools);
    expect(Array.isArray(converted)).toBe(true);
    // Gemini returns flat {name, description, parameters} objects (wrapping happens at call site)
    expect(converted[0]).toHaveProperty('name', 'my_tool');
    expect(converted[0]).toHaveProperty('description');
    expect(converted[0]).toHaveProperty('parameters');
  });
  it('extractContent joins text parts', () => {
    const content = { parts: [{ text: 'Hello' }, { text: ' World' }] };
    expect(p.extractContent(content)).toBe('Hello World');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Provider
// Note: Anthropic has no .name or .isConfigured on instance — different structure
// ─────────────────────────────────────────────────────────────────────────────
describe('AnthropicProvider', () => {
  let p;
  beforeEach(() => { p = new AnthropicProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('has chat() method', () => expect(typeof p.chat).toBe('function'));
  it('has chatStream() method', () => expect(typeof p.chatStream).toBe('function'));
  it('getAvailableModels returns array synchronously', () => {
    const m = p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
    expect(m.length).toBeGreaterThan(0);
  });
  it('getAvailableModels includes claude models', () => {
    const m = p.getAvailableModels();
    expect(m.some(x => (x.id || x).toLowerCase().includes('claude'))).toBe(true);
  });
  it('chat returns error or throws when apiKey missing', async () => {
    // AnthropicProvider reads apiKey at construction; force it missing
    p.apiKey = '';
    const res = await safeChat(p);
    expect(res.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Groq Provider
// ─────────────────────────────────────────────────────────────────────────────
describe('GroqProvider', () => {
  let p;
  beforeEach(() => { p = new GroqProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('name is Groq', () => expect(p.name).toBe('Groq'));
  it('baseUrl points to groq.com', () => expect(p.baseUrl).toContain('groq.com'));
  it('getAvailableModels returns llama models (async)', async () => {
    const m = await p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
    expect(m.some(x => (x.id || x).toLowerCase().includes('llama'))).toBe(true);
  });
  it('chat returns error when not configured', async () => {
    p.apiKey = '';
    const res = await safeChat(p);
    expect(res.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OpenAgentic Provider
// ─────────────────────────────────────────────────────────────────────────────
describe('OpenAgenticProvider', () => {
  let p;
  beforeEach(() => { p = new OpenAgenticProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('name is OpenAgentic', () => expect(p.name).toBe('OpenAgentic'));
  it('supportsStreamingToolCalls is true', () => expect(p.supportsStreamingToolCalls).toBe(true));
  it('defaultModel set', () => expect(typeof p.defaultModel).toBe('string'));
  it('isConfigured false without apiKey', () => {
    const orig = p.apiKey; p.apiKey = '';
    expect(p.isConfigured()).toBe(false);
    p.apiKey = orig;
  });
  it('isAvailable === isConfigured', () => expect(p.isAvailable()).toBe(p.isConfigured()));
  it('getAvailableModels returns array synchronously', () => {
    const m = p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
  });
  it('resolveMaxTokens returns positive number', () => {
    const n = p.resolveMaxTokens(p.defaultModel);
    expect(typeof n).toBe('number');
    expect(n).toBeGreaterThan(0);
  });
  it('stats initialised with zeros', () => {
    expect(p.stats.totalRequests).toBe(0);
    expect(p.stats.successfulRequests).toBe(0);
    expect(p.stats.failedRequests).toBe(0);
  });
  it('formatMessages preserves system role (OpenAI-style array)', () => {
    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
    const formatted = p.formatMessages(msgs);
    expect(formatted.some(m => m.role === 'system')).toBe(true);
    expect(formatted.length).toBe(2);
  });
  it('extractSystem returns system content', () => {
    const msgs = [{ role: 'system', content: 'you are helpful' }, { role: 'user', content: 'hello' }];
    expect(p.extractSystem(msgs)).toBe('you are helpful');
  });
  it('extractSystem returns null when no system message', () => {
    expect(p.extractSystem([{ role: 'user', content: 'hello' }])).toBeNull();
  });
  it('chat returns error when not configured', async () => {
    p.apiKey = '';
    const res = await safeChat(p);
    expect(res.success).toBe(false);
  });
  it('getStats returns object', () => expect(typeof p.getStats()).toBe('object'));
});

// ─────────────────────────────────────────────────────────────────────────────
// NVIDIA Provider
// ─────────────────────────────────────────────────────────────────────────────
describe('NVIDIAProvider', () => {
  let p;
  beforeEach(() => {
    process.env.NVIDIA_API_KEY = 'test-nvidia-key';
    p = new NVIDIAProvider();
  });

  it('instance created', () => expect(p).toBeDefined());
  it('name contains NVIDIA', () => expect(p.name.toLowerCase()).toContain('nvidia'));
  it('getAvailableModels returns array (async)', async () => {
    const m = await p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
  });
  it('getKeyCount returns positive number', () => expect(p.getKeyCount()).toBeGreaterThan(0));
  it('getKeyStatus returns array', () => {
    const s = p.getKeyStatus();
    expect(Array.isArray(s)).toBe(true);
    expect(s.length).toBe(p.getKeyCount());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Azure OpenAI Provider
// ─────────────────────────────────────────────────────────────────────────────
describe('AzureOpenAIProvider', () => {
  let p;
  beforeEach(() => { p = new AzureOpenAIProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('name contains Azure', () => expect(p.name.toLowerCase()).toContain('azure'));
  it('getAvailableModels returns array (async)', async () => {
    const m = await p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
    expect(m.some(x => (x.id || x).includes('gpt-4o'))).toBe(true);
  });
  it('capabilities.privateNetworking defined', () => expect(p.capabilities).toHaveProperty('privateNetworking'));
  it('chat returns error when not configured', async () => {
    const res = await safeChat(p);
    expect(res.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cerebras Provider
// ─────────────────────────────────────────────────────────────────────────────
describe('CerebrasProvider', () => {
  let p;
  beforeEach(() => { p = new CerebrasProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('baseUrl points to cerebras.ai', () => expect(p.baseUrl).toContain('cerebras.ai'));
  it('getAvailableModels returns array (async)', async () => {
    const m = await p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
  });
  it('chat throws or returns error when not configured', async () => {
    p.apiKey = '';
    const res = await safeChat(p);
    expect(res.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Together Provider
// ─────────────────────────────────────────────────────────────────────────────
describe('TogetherProvider', () => {
  let p;
  beforeEach(() => { p = new TogetherProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('baseUrl points to together.xyz', () => expect(p.baseUrl).toContain('together.xyz'));
  it('getAvailableModels returns llama models (async)', async () => {
    const m = await p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
    expect(m.some(x => (x.id || x).toLowerCase().includes('llama'))).toBe(true);
  });
  it('chat throws or returns error when not configured', async () => {
    p.apiKey = '';
    const res = await safeChat(p);
    expect(res.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fireworks Provider
// ─────────────────────────────────────────────────────────────────────────────
describe('FireworksProvider', () => {
  let p;
  beforeEach(() => { p = new FireworksProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('baseUrl points to fireworks.ai', () => expect(p.baseUrl).toContain('fireworks.ai'));
  it('capabilities.codingOptimized true', () => expect(p.capabilities.codingOptimized).toBe(true));
  it('getAvailableModels returns array (async)', async () => {
    const m = await p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
  });
  it('chat throws or returns error when not configured', async () => {
    p.apiKey = '';
    const res = await safeChat(p);
    expect(res.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hyperbolic Provider
// ─────────────────────────────────────────────────────────────────────────────
describe('HyperbolicProvider', () => {
  let p;
  beforeEach(() => { p = new HyperbolicProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('baseUrl points to hyperbolic.xyz', () => expect(p.baseUrl).toContain('hyperbolic.xyz'));
  it('defaultModel contains deepseek', () => expect(p.defaultModel.toLowerCase()).toContain('deepseek'));
  it('getAvailableModels returns array (async)', async () => {
    const m = await p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
  });
  it('chat throws or returns error when not configured', async () => {
    p.apiKey = '';
    const res = await safeChat(p);
    expect(res.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SambaNova Provider
// ─────────────────────────────────────────────────────────────────────────────
describe('SambaNovaProvider', () => {
  let p;
  beforeEach(() => { p = new SambaNovaProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('baseUrl points to sambanova.ai', () => expect(p.baseUrl).toContain('sambanova.ai'));
  it('capabilities.ultraLarge true', () => expect(p.capabilities.ultraLarge).toBe(true));
  it('getAvailableModels returns llama models (async)', async () => {
    const m = await p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
    expect(m.some(x => (x.id || x).toLowerCase().includes('llama'))).toBe(true);
  });
  it('chat throws or returns error when not configured', async () => {
    p.apiKey = '';
    const res = await safeChat(p);
    expect(res.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HuggingFace Provider
// ─────────────────────────────────────────────────────────────────────────────
describe('HuggingFaceProvider', () => {
  let p;
  beforeEach(() => { p = new HuggingFaceProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('baseUrl points to huggingface.co', () => expect(p.baseUrl).toContain('huggingface.co'));
  it('capabilities.toolCalling is false', () => expect(p.capabilities.toolCalling).toBe(false));
  it('getAvailableModels returns array with llama (async)', async () => {
    const m = await p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
    expect(m.some(x => (x.id || x).toLowerCase().includes('llama'))).toBe(true);
  });
  it('chat throws or returns error when not configured', async () => {
    p.apiKey = '';
    const res = await safeChat(p);
    expect(res.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode Provider
// ─────────────────────────────────────────────────────────────────────────────
describe('OpenCodeProvider', () => {
  let p;
  beforeEach(() => { p = new OpenCodeProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('baseUrl points to localhost', () => expect(p.baseUrl).toContain('localhost'));
  it('capabilities.unlimitedFree true', () => expect(p.capabilities.unlimitedFree).toBe(true));
  it('isAvailable always returns true', () => expect(p.isAvailable()).toBe(true));
  it('getAvailableModels returns array (async)', async () => {
    const m = await p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Puter Provider
// Note: has no name/isConfigured/chatStream — only chat/getAvailableModels/isAvailable
// ─────────────────────────────────────────────────────────────────────────────
describe('PuterProvider', () => {
  let p;
  beforeEach(() => { p = new PuterProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('has chat() method', () => expect(typeof p.chat).toBe('function'));
  it('has getAvailableModels() method', () => expect(typeof p.getAvailableModels).toBe('function'));
  it('has isAvailable() method', () => expect(typeof p.isAvailable).toBe('function'));
  it('isAvailable returns false in Node.js (no window)', () => expect(p.isAvailable()).toBe(false));
  it('getAvailableModels returns array', () => {
    const m = p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
  });
  it('chat returns error directing user to web UI', async () => {
    const res = await safeChat(p);
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Vector Provider
// ─────────────────────────────────────────────────────────────────────────────
describe('VectorProvider', () => {
  let p;
  beforeEach(() => { p = new VectorProvider(); });

  it('instance created', () => expect(p).toBeDefined());
  it('name contains vector', () => expect(p.name.toLowerCase()).toContain('vector'));
  it('getAvailableModels returns array of models (async)', async () => {
    const m = await p.getAvailableModels();
    expect(Array.isArray(m)).toBe(true);
    expect(m.length).toBeGreaterThan(0);
  });
  it('chat returns error when not configured', async () => {
    p.apiKey = '';
    const res = await safeChat(p);
    expect(res.success).toBe(false);
  });
  it('convertToolsFormat returns array', () => {
    const tools = [{ name: 'test', description: 'test tool', parameters: {} }];
    expect(Array.isArray(p.convertToolsFormat(tools))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-provider structural validation (only methods that actually exist)
// ─────────────────────────────────────────────────────────────────────────────
describe('All providers: structural validation', () => {
  // Providers that follow the full BaseProvider contract
  const standardProviders = [
    new OpenAIProvider(),
    new GeminiProvider(),
    new GroqProvider(),
    new OpenAgenticProvider(),
    new AzureOpenAIProvider(),
    new CerebrasProvider(),
    new TogetherProvider(),
    new FireworksProvider(),
    new HyperbolicProvider(),
    new SambaNovaProvider(),
    new HuggingFaceProvider(),
    new OpenCodeProvider(),
    new VectorProvider(),
  ];

  for (const provider of standardProviders) {
    const name = provider.name || provider.constructor.name;

    it(`${name}: has name string`, () => {
      expect(typeof provider.name).toBe('string');
      expect(provider.name.length).toBeGreaterThan(0);
    });
    it(`${name}: has chat()`, () => expect(typeof provider.chat).toBe('function'));
    it(`${name}: has chatStream()`, () => expect(typeof provider.chatStream).toBe('function'));
    it(`${name}: has getAvailableModels()`, () => expect(typeof provider.getAvailableModels).toBe('function'));
    it(`${name}: has isConfigured()`, () => expect(typeof provider.isConfigured).toBe('function'));
    it(`${name}: isConfigured() returns boolean`, () => expect(typeof provider.isConfigured()).toBe('boolean'));
    it(`${name}: getAvailableModels() returns array (async)`, async () => {
      const m = await provider.getAvailableModels();
      expect(Array.isArray(m)).toBe(true);
    });
  }

  // Minimal providers (Anthropic, Puter) - only check what they have
  const minimalProviders = [
    { label: 'Anthropic', p: new AnthropicProvider(), hasChatStream: true },
    { label: 'Puter', p: new PuterProvider(), hasChatStream: false },
  ];

  for (const { label, p, hasChatStream } of minimalProviders) {
    it(`${label}: has chat()`, () => expect(typeof p.chat).toBe('function'));
    it(`${label}: has getAvailableModels()`, () => expect(typeof p.getAvailableModels).toBe('function'));
    if (hasChatStream) {
      it(`${label}: has chatStream()`, () => expect(typeof p.chatStream).toBe('function'));
    }
  }
});
