/**
 * Test Suite: ai-manager.js
 * Covers: constructor, setProvider, getProvider, getAvailableProviders,
 *         getConfiguredProviders, getDefaultModel, getAvailableModels,
 *         chat (mock), chatWithMessages (mock), clearContext, addTurn,
 *         setSystemPrompt, getSystemPrompt, _buildSystemPrompt
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Set env sebelum import
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';

import AIManager from '../src/ai-manager.js';

describe('AIManager: constructor & initialization', () => {
  let manager;
  beforeEach(() => { manager = new AIManager(); });

  it('membuat instance dengan benar', () => {
    expect(manager).toBeTruthy();
    expect(manager.providers).toBeTruthy();
    expect(manager.contextManager).toBeTruthy();
  });

  it('providers registry berisi semua provider yang diharapkan', () => {
    const expected = ['openagentic', 'anthropic', 'nvidia', 'vector', 'puter', 'openai', 'gemini', 'groq', 'azure', 'azure-openai', 'cerebras', 'together', 'fireworks', 'opencode'];
    for (const p of expected) {
      expect(manager.providers, `provider '${p}' harus ada`).toHaveProperty(p);
    }
  });

  it('currentProvider terisi dari config atau default openagentic', () => {
    expect(typeof manager.currentProvider).toBe('string');
    expect(manager.currentProvider.length).toBeGreaterThan(0);
  });

  it('contextManager diinisialisasi', () => {
    expect(manager.contextManager).toBeTruthy();
    expect(typeof manager.contextManager.getHistoryLength).toBe('function');
  });

  it('systemPrompt berisi identitas Wanar AI', () => {
    expect(manager.systemPrompt).toContain('Wanar AI');
  });
});

describe('AIManager: setProvider & getProvider', () => {
  let manager;
  beforeEach(() => { manager = new AIManager(); });

  it('setProvider mengubah currentProvider', () => {
    manager.setProvider('openai');
    expect(manager.getProvider()).toBe('openai');
  });

  it('setProvider ke nvidia berhasil', () => {
    manager.setProvider('nvidia');
    expect(manager.getProvider()).toBe('nvidia');
  });

  it('setProvider ke gemini berhasil', () => {
    manager.setProvider('gemini');
    expect(manager.getProvider()).toBe('gemini');
  });

  it('setProvider ke provider tidak valid melempar error', () => {
    expect(() => manager.setProvider('provider-tidak-ada')).toThrow();
  });

  it('setProvider ke string kosong melempar error', () => {
    expect(() => manager.setProvider('')).toThrow();
  });

  it('getProvider mengembalikan currentProvider saat ini', () => {
    const before = manager.getProvider();
    manager.setProvider('groq');
    expect(manager.getProvider()).toBe('groq');
    manager.setProvider(before);
    expect(manager.getProvider()).toBe(before);
  });
});

describe('AIManager: getAvailableProviders', () => {
  let manager;
  beforeEach(() => { manager = new AIManager(); });

  it('mengembalikan array provider', () => {
    const providers = manager.getAvailableProviders();
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
  });

  it('array berisi provider yang dikenal', () => {
    const providers = manager.getAvailableProviders();
    expect(providers).toContain('openagentic');
    expect(providers).toContain('openai');
    expect(providers).toContain('nvidia');
    expect(providers).toContain('gemini');
    expect(providers).toContain('groq');
  });

  it('tidak ada duplikat provider', () => {
    const providers = manager.getAvailableProviders();
    const unique = [...new Set(providers)];
    expect(providers.length).toBe(unique.length);
  });
});

describe('AIManager: getConfiguredProviders', () => {
  let manager;
  beforeEach(() => { manager = new AIManager(); });

  it('mengembalikan array (mungkin kosong jika tidak ada env key)', () => {
    const configured = manager.getConfiguredProviders();
    expect(Array.isArray(configured)).toBe(true);
  });

  it('semua provider yang dikembalikan punya isAvailable truthy', () => {
    const configured = manager.getConfiguredProviders();
    for (const name of configured) {
      const p = manager.providers[name];
      // isAvailable() bisa mengembalikan boolean true atau api key string (truthy)
      expect(p.isAvailable()).toBeTruthy();
    }
  });
});

describe('AIManager: getDefaultModel & getAvailableModels', () => {
  let manager;
  beforeEach(() => { manager = new AIManager(); });

  it('getDefaultModel mengembalikan string atau null', () => {
    const model = manager.getDefaultModel();
    expect(model === null || typeof model === 'string').toBe(true);
  });

  it('getAvailableModels tanpa arg menggunakan currentProvider', () => {
    const models = manager.getAvailableModels();
    expect(Array.isArray(models)).toBe(true);
  });

  it('getAvailableModels dengan provider spesifik', () => {
    const models = manager.getAvailableModels('nvidia');
    expect(Array.isArray(models)).toBe(true);
  });

  it('getAvailableModels untuk provider tidak dikenal mengembalikan array kosong', () => {
    const models = manager.getAvailableModels('provider-tidak-ada');
    expect(models).toEqual([]);
  });
});

describe('AIManager: setSystemPrompt & getSystemPrompt', () => {
  let manager;
  beforeEach(() => { manager = new AIManager(); });

  it('getSystemPrompt mengembalikan system prompt saat ini', () => {
    const prompt = manager.getSystemPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('setSystemPrompt mengubah systemPrompt', () => {
    manager.setSystemPrompt('Custom prompt for testing');
    expect(manager.getSystemPrompt()).toBe('Custom prompt for testing');
  });

  it('setSystemPrompt bisa di-revert', () => {
    const original = manager.getSystemPrompt();
    manager.setSystemPrompt('Temporary');
    manager.setSystemPrompt(original);
    expect(manager.getSystemPrompt()).toBe(original);
  });
});

describe('AIManager: _buildSystemPrompt', () => {
  let manager;
  beforeEach(() => { manager = new AIManager(); });

  it('menambahkan informasi tanggal dan waktu ke prompt', () => {
    const built = manager._buildSystemPrompt('Base prompt');
    expect(built).toContain('Base prompt');
    expect(built).toContain('WAKTU & TANGGAL SAAT INI');
    expect(built).toContain('Tanggal:');
    expect(built).toContain('Waktu:');
    expect(built).toContain('ISO:');
  });

  it('menggunakan systemPrompt internal jika overridePrompt null', () => {
    const built = manager._buildSystemPrompt(null);
    expect(built).toContain('Wanar AI');
  });

  it('ISO date format dalam prompt', () => {
    const built = manager._buildSystemPrompt('test');
    const today = new Date().toISOString().slice(0, 10);
    expect(built).toContain(today);
  });

  it('tahun aktif benar dalam prompt', () => {
    const built = manager._buildSystemPrompt('test');
    const year = new Date().getFullYear().toString();
    expect(built).toContain(year);
  });
});

describe('AIManager: addTurn & clearContext', () => {
  let manager;
  beforeEach(() => { manager = new AIManager(); });

  it('addTurn menambahkan pesan ke contextManager', () => {
    manager.addTurn('user', 'Halo Wanar!');
    expect(manager.contextManager.getHistoryLength()).toBe(1);
  });

  it('addTurn user dan assistant', () => {
    manager.addTurn('user', 'Pertanyaan saya');
    manager.addTurn('assistant', 'Jawaban saya');
    expect(manager.contextManager.getHistoryLength()).toBe(2);
  });

  it('clearContext mengosongkan history', () => {
    manager.addTurn('user', 'test');
    manager.addTurn('assistant', 'response');
    manager.clearContext();
    expect(manager.contextManager.getHistoryLength()).toBe(0);
  });

  it('clearContext tidak crash saat history sudah kosong', () => {
    expect(() => manager.clearContext()).not.toThrow();
  });
});

describe('AIManager: getProviderInfo', () => {
  let manager;
  beforeEach(() => { manager = new AIManager(); });

  it('mengembalikan object info yang valid', () => {
    const info = manager.getProviderInfo();
    expect(info).toHaveProperty('current');
    expect(info).toHaveProperty('context');
    expect(info).toHaveProperty('providers');
  });

  it('context berisi historyLength, estimatedTokens, maxTurns', () => {
    const { context } = manager.getProviderInfo();
    expect(context).toHaveProperty('historyLength');
    expect(context).toHaveProperty('estimatedTokens');
    expect(context).toHaveProperty('maxTurns');
  });

  it('context.historyLength = 0 saat baru', () => {
    const { context } = manager.getProviderInfo();
    expect(context.historyLength).toBe(0);
  });

  it('context.historyLength meningkat setelah addTurn', () => {
    manager.addTurn('user', 'test');
    const { context } = manager.getProviderInfo();
    expect(context.historyLength).toBe(1);
  });

  it('providers berisi info openagentic, openai, nvidia, dll', () => {
    const { providers } = manager.getProviderInfo();
    expect(providers).toHaveProperty('openagentic');
    expect(providers).toHaveProperty('openai');
    expect(providers).toHaveProperty('nvidia');
  });
});

describe('AIManager: chat dengan mock provider', () => {
  let manager;
  beforeEach(() => { manager = new AIManager(); });

  it('chat mengembalikan error jika provider tidak tersedia dan tidak ada fallback', async () => {
    // Mock semua provider agar tidak available
    const originalProviders = manager.providers;
    manager.providers = {
      'test-provider': {
        isAvailable: () => false,
        chat: async () => ({ success: false, error: 'Not available' }),
      },
    };
    manager.currentProvider = 'test-provider';
    const result = await manager.chat('test message', { provider: 'test-provider' });
    expect(result.success).toBe(false);
    manager.providers = originalProviders;
  });

  it('chat dengan mock provider yang sukses memperbarui context', async () => {
    // Mock provider sukses
    const mockProvider = {
      isAvailable: () => true,
      chat: vi.fn().mockResolvedValue({ success: true, content: 'Halo dari mock!' }),
    };
    manager.providers['mock'] = mockProvider;
    manager.currentProvider = 'mock';

    const result = await manager.chat('Halo!', { provider: 'mock' });
    expect(result.success).toBe(true);
    expect(result.content).toBe('Halo dari mock!');
    // Context harus diperbarui
    expect(manager.contextManager.getHistoryLength()).toBe(2); // user + assistant
    delete manager.providers['mock'];
  });

  it('chat dengan mock provider gagal mengembalikan success: false', async () => {
    const mockProvider = {
      isAvailable: () => true,
      chat: vi.fn().mockResolvedValue({ success: false, error: 'API Error' }),
    };
    manager.providers['mock-fail'] = mockProvider;

    const result = await manager.chat('test', { provider: 'mock-fail' });
    expect(result.success).toBe(false);
    delete manager.providers['mock-fail'];
  });

  it('chat dengan provider yang throw error mengembalikan success: false', async () => {
    const mockProvider = {
      isAvailable: () => true,
      chat: vi.fn().mockRejectedValue(new Error('Network timeout')),
    };
    manager.providers['mock-throw'] = mockProvider;

    const result = await manager.chat('test', { provider: 'mock-throw' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Network timeout');
    delete manager.providers['mock-throw'];
  });
});

describe('AIManager: chatWithMessages dengan mock', () => {
  let manager;
  beforeEach(() => { manager = new AIManager(); });

  it('chatWithMessages dengan mock provider sukses', async () => {
    const mockProvider = {
      isAvailable: () => true,
      chat: vi.fn().mockResolvedValue({ success: true, content: 'Response dari messages' }),
    };
    manager.providers['mock-msgs'] = mockProvider;

    const messages = [
      { role: 'user', content: 'Jelaskan TypeScript' },
    ];
    const result = await manager.chatWithMessages(messages, { provider: 'mock-msgs' });
    expect(result.success).toBe(true);
    expect(mockProvider.chat).toHaveBeenCalledOnce();
    delete manager.providers['mock-msgs'];
  });

  it('chatWithMessages provider tidak ada melempar error', async () => {
    const result = await manager.chatWithMessages([], { provider: 'provider-tidak-ada' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown provider');
  });
});

describe('AIManager: WANAR_SYSTEM_PROMPT exports', () => {
  it('WANAR_SYSTEM_PROMPT dan WANAR_SYSTEM_PROMPT_WEB diekspor', async () => {
    const { WANAR_SYSTEM_PROMPT, WANAR_SYSTEM_PROMPT_WEB } = await import('../src/ai-manager.js');
    expect(typeof WANAR_SYSTEM_PROMPT).toBe('string');
    expect(typeof WANAR_SYSTEM_PROMPT_WEB).toBe('string');
    expect(WANAR_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    expect(WANAR_SYSTEM_PROMPT_WEB.length).toBeGreaterThan(100);
  });

  it('WANAR_SYSTEM_PROMPT berisi identitas Wanar AI', async () => {
    const { WANAR_SYSTEM_PROMPT } = await import('../src/ai-manager.js');
    expect(WANAR_SYSTEM_PROMPT).toContain('Wanar AI');
    expect(WANAR_SYSTEM_PROMPT).toContain('Wisnu Alfian Nur Ashar');
  });

  it('WANAR_SYSTEM_PROMPT_WEB untuk web interface', async () => {
    const { WANAR_SYSTEM_PROMPT_WEB } = await import('../src/ai-manager.js');
    expect(WANAR_SYSTEM_PROMPT_WEB).toContain('web');
  });
});
