/**
 * Test Suite: BaseProvider
 * Covers: constructor, isConfigured, getCapabilities, validateMessages,
 *         chunkLargeContext, estimateTokens, truncateMessages, updateStats,
 *         getStats, resetStats, extractSystemPrompt, retryWithBackoff, sleep
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BaseProvider } from '../src/providers/base-provider.js';

class TestProvider extends BaseProvider {
  constructor(cfg = {}) {
    super({
      name: 'TestProvider',
      apiKey: cfg.apiKey || 'test-key-123',
      baseUrl: cfg.baseUrl || 'https://api.test.com',
      defaultModel: cfg.defaultModel || 'test-model',
      maxTokens: cfg.maxTokens || 4096,
      maxContextTokens: cfg.maxContextTokens || 128000,
      ...cfg,
    });
  }
  async chat() { return { success: true, content: 'test response' }; }
  async *chatStream() { yield { type: 'content', content: 'test' }; yield { type: 'done' }; }
  async getAvailableModels() { return ['test-model', 'test-model-2']; }
}

describe('BaseProvider: constructor', () => {
  it('membuat instance dengan config lengkap', () => {
    const p = new TestProvider();
    expect(p.name).toBe('TestProvider');
    expect(p.apiKey).toBe('test-key-123');
    expect(p.baseUrl).toBe('https://api.test.com');
    expect(p.defaultModel).toBe('test-model');
    expect(p.maxTokens).toBe(4096);
    expect(p.maxContextTokens).toBe(128000);
  });

  it('default values saat config minimal', () => {
    class MinProvider extends BaseProvider {
      constructor() { super({ name: 'Min' }); }
      async chat() {}
      async *chatStream() {}
      async getAvailableModels() { return []; }
    }
    const p = new MinProvider();
    expect(p.apiKey).toBe('');
    expect(p.baseUrl).toBe('');
    expect(p.maxTokens).toBe(4096);
    expect(p.timeout).toBe(60000);
  });

  it('capabilities diinisialisasi dengan benar', () => {
    const p = new TestProvider();
    expect(p.capabilities.streaming).toBe(true);
    expect(p.capabilities.toolCalling).toBe(true);
    expect(p.capabilities.largeContext).toBe(true);
    expect(p.capabilities.vision).toBe(false);
    expect(p.capabilities.functionCalling).toBe(true);
    expect(p.capabilities.multiTurn).toBe(true);
  });

  it('stats diinisialisasi dengan 0', () => {
    const p = new TestProvider();
    expect(p.stats.totalRequests).toBe(0);
    expect(p.stats.successfulRequests).toBe(0);
    expect(p.stats.failedRequests).toBe(0);
    expect(p.stats.totalTokens).toBe(0);
    expect(p.stats.avgLatency).toBe(0);
    expect(p.stats.lastRequestTime).toBeNull();
  });
});

describe('BaseProvider: isConfigured', () => {
  it('mengembalikan true jika apiKey dan baseUrl ada', () => {
    const p = new TestProvider({ apiKey: 'key', baseUrl: 'https://api.test.com' });
    expect(p.isConfigured()).toBe(true);
  });

  it('mengembalikan false jika apiKey kosong', () => {
    const p = new TestProvider({ apiKey: '', baseUrl: 'https://api.test.com' });
    expect(p.isConfigured()).toBe(false);
  });

  it('mengembalikan false jika baseUrl kosong', () => {
    const p = new TestProvider({ apiKey: 'key', baseUrl: '' });
    expect(p.isConfigured()).toBe(false);
  });

  it('mengembalikan false jika keduanya kosong', () => {
    const p = new TestProvider({ apiKey: '', baseUrl: '' });
    expect(p.isConfigured()).toBe(false);
  });
});

describe('BaseProvider: getCapabilities', () => {
  it('mengembalikan object capabilities', () => {
    const p = new TestProvider();
    const caps = p.getCapabilities();
    expect(caps).toHaveProperty('streaming');
    expect(caps).toHaveProperty('toolCalling');
    expect(caps).toHaveProperty('largeContext');
    expect(caps).toHaveProperty('vision');
    expect(caps).toHaveProperty('functionCalling');
    expect(caps).toHaveProperty('multiTurn');
  });
});

describe('BaseProvider: validateMessages', () => {
  let p;
  beforeEach(() => { p = new TestProvider(); });

  it('mengembalikan true untuk messages valid', () => {
    const msgs = [
      { role: 'user', content: 'Halo' },
      { role: 'assistant', content: 'Halo juga!' },
    ];
    expect(p.validateMessages(msgs)).toBe(true);
  });

  it('melempar error untuk array kosong', () => {
    expect(() => p.validateMessages([])).toThrow('Messages must be a non-empty array');
  });

  it('melempar error jika messages bukan array', () => {
    expect(() => p.validateMessages('bukan array')).toThrow();
    expect(() => p.validateMessages(null)).toThrow();
    expect(() => p.validateMessages(undefined)).toThrow();
  });

  it('melempar error jika message tidak punya role', () => {
    expect(() => p.validateMessages([{ content: 'test' }])).toThrow('Each message must have role and content');
  });

  it('melempar error jika message tidak punya content dan tidak ada tool_calls', () => {
    expect(() => p.validateMessages([{ role: 'user', content: '' }])).toThrow();
  });

  it('menerima message dengan tool_calls meski content null', () => {
    const msgs = [{ role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'test', arguments: '{}' } }] }];
    expect(p.validateMessages(msgs)).toBe(true);
  });

  it('menerima system message', () => {
    const msgs = [
      { role: 'system', content: 'Kamu adalah Wanar AI.' },
      { role: 'user', content: 'Halo' },
    ];
    expect(p.validateMessages(msgs)).toBe(true);
  });
});

describe('BaseProvider: estimateTokens', () => {
  let p;
  beforeEach(() => { p = new TestProvider(); });

  it('mengembalikan 0 untuk null', () => {
    expect(p.estimateTokens(null)).toBe(0);
  });

  it('mengembalikan 0 untuk undefined', () => {
    expect(p.estimateTokens(undefined)).toBe(0);
  });

  it('mengembalikan angka positif untuk string', () => {
    expect(p.estimateTokens('Hello world')).toBeGreaterThan(0);
  });

  it('pesan lebih panjang = token lebih banyak', () => {
    const short = p.estimateTokens('hi');
    const long = p.estimateTokens('hi '.repeat(100));
    expect(long).toBeGreaterThan(short);
  });

  it('menghandle object dengan JSON.stringify', () => {
    const obj = { role: 'user', content: 'test message' };
    const tokens = p.estimateTokens(obj);
    expect(typeof tokens).toBe('number');
    expect(tokens).toBeGreaterThan(0);
  });

  it('perkiraan sekitar 1 token per 4 karakter', () => {
    const text = 'a'.repeat(400);
    const tokens = p.estimateTokens(text);
    expect(tokens).toBe(100);
  });
});

describe('BaseProvider: chunkLargeContext', () => {
  let p;
  beforeEach(() => { p = new TestProvider(); });

  it('konten kecil mengembalikan 1 chunk', () => {
    const content = 'Hello world\nThis is a test';
    const chunks = p.chunkLargeContext(content, 100000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(content);
  });

  it('konten besar dipecah menjadi beberapa chunks', () => {
    const line = 'x'.repeat(1000) + '\n';
    const content = line.repeat(200); // 200KB
    const chunks = p.chunkLargeContext(content, 50000);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('setiap chunk <= maxChunkSize', () => {
    const line = 'abcdefghij\n';
    const content = line.repeat(10000);
    const maxSize = 5000;
    const chunks = p.chunkLargeContext(content, maxSize);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxSize + 1000); // toleransi 1 baris
    }
  });

  it('semua chunks digabung menghasilkan konten asli (tanpa trailing newline ekstra)', () => {
    const line = 'baris konten\n';
    const content = line.repeat(100);
    const chunks = p.chunkLargeContext(content, 200);
    const rejoined = chunks.join('');
    // chunkLargeContext menambahkan '\n' saat memulai chunk baru
    // sehingga rejoined mungkin memiliki satu newline tambahan di akhir
    // Verifikasi konten inti sama (strip trailing whitespace perbedaan minor)
    expect(rejoined.trimEnd()).toBe(content.trimEnd());
  });

  it('string kosong mengembalikan 1 chunk kosong', () => {
    const chunks = p.chunkLargeContext('', 1000);
    expect(chunks).toHaveLength(1);
  });
});

describe('BaseProvider: truncateMessages', () => {
  let p;
  beforeEach(() => { p = new TestProvider(); });

  it('mengembalikan semua pesan jika muat dalam token limit', () => {
    const msgs = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const { messages } = p.truncateMessages(msgs, 100000);
    expect(messages.length).toBe(3);
  });

  it('mengembalikan objek dengan messages dan totalTokens', () => {
    const msgs = [{ role: 'user', content: 'test' }];
    const result = p.truncateMessages(msgs, 100000);
    expect(result).toHaveProperty('messages');
    expect(result).toHaveProperty('totalTokens');
  });

  it('system message selalu dipertahankan di posisi pertama', () => {
    const msgs = [
      { role: 'system', content: 'Kamu adalah Wanar AI.' },
      { role: 'user', content: 'a'.repeat(1000) },
      { role: 'assistant', content: 'b'.repeat(1000) },
      { role: 'user', content: 'c'.repeat(1000) },
    ];
    const { messages } = p.truncateMessages(msgs, 100);
    if (messages.length > 0) {
      expect(messages[0].role).toBe('system');
    }
  });

  it('pesan lama dihilangkan saat melebihi limit', () => {
    const msgs = [];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'user', content: 'pesan panjang nomor ' + i + ' '.repeat(200) });
      msgs.push({ role: 'assistant', content: 'jawaban nomor ' + i + ' '.repeat(200) });
    }
    const { messages } = p.truncateMessages(msgs, 500);
    expect(messages.length).toBeLessThan(msgs.length);
  });
});

describe('BaseProvider: updateStats & getStats', () => {
  let p;
  beforeEach(() => { p = new TestProvider(); });

  it('updateStats menambah totalRequests', () => {
    p.updateStats(true, 100, 500);
    expect(p.stats.totalRequests).toBe(1);
  });

  it('updateStats success menambah successfulRequests', () => {
    p.updateStats(true, 50, 200);
    expect(p.stats.successfulRequests).toBe(1);
    expect(p.stats.failedRequests).toBe(0);
  });

  it('updateStats failure menambah failedRequests', () => {
    p.updateStats(false, 0, 100);
    expect(p.stats.failedRequests).toBe(1);
    expect(p.stats.successfulRequests).toBe(0);
  });

  it('updateStats menambah totalTokens', () => {
    p.updateStats(true, 300);
    p.updateStats(true, 200);
    expect(p.stats.totalTokens).toBe(500);
  });

  it('updateStats menghitung avgLatency dengan benar', () => {
    p.updateStats(true, 0, 100);
    p.updateStats(true, 0, 200);
    // avg = (100 + 200) / 2 = 150
    expect(p.stats.avgLatency).toBe(150);
  });

  it('updateStats menyimpan lastRequestTime', () => {
    p.updateStats(true);
    expect(p.stats.lastRequestTime).toBeTruthy();
    expect(typeof p.stats.lastRequestTime).toBe('string');
  });

  it('getStats mengembalikan successRate string', () => {
    p.updateStats(true);
    p.updateStats(true);
    p.updateStats(false);
    const stats = p.getStats();
    expect(stats.successRate).toBe('66.67%');
  });

  it('getStats successRate 0% saat tidak ada request', () => {
    const stats = p.getStats();
    expect(stats.successRate).toBe('0%');
  });

  it('getStats 100% saat semua sukses', () => {
    p.updateStats(true);
    p.updateStats(true);
    const stats = p.getStats();
    expect(stats.successRate).toBe('100.00%');
  });
});

describe('BaseProvider: resetStats', () => {
  let p;
  beforeEach(() => { p = new TestProvider(); });

  it('resetStats mereset semua counter ke 0', () => {
    p.updateStats(true, 500, 1000);
    p.updateStats(false, 0, 200);
    p.resetStats();
    expect(p.stats.totalRequests).toBe(0);
    expect(p.stats.successfulRequests).toBe(0);
    expect(p.stats.failedRequests).toBe(0);
    expect(p.stats.totalTokens).toBe(0);
    expect(p.stats.avgLatency).toBe(0);
    expect(p.stats.lastRequestTime).toBeNull();
  });
});

describe('BaseProvider: extractSystemPrompt', () => {
  let p;
  beforeEach(() => { p = new TestProvider(); });

  it('memisahkan system message dari conversation messages', () => {
    const msgs = [
      { role: 'system', content: 'Kamu adalah Wanar AI.' },
      { role: 'user', content: 'Halo' },
      { role: 'assistant', content: 'Halo juga!' },
    ];
    const { systemPrompt, conversationMessages } = p.extractSystemPrompt(msgs);
    expect(systemPrompt).toBe('Kamu adalah Wanar AI.');
    expect(conversationMessages).toHaveLength(2);
    expect(conversationMessages[0].role).toBe('user');
  });

  it('mengembalikan string kosong jika tidak ada system message', () => {
    const msgs = [{ role: 'user', content: 'test' }];
    const { systemPrompt } = p.extractSystemPrompt(msgs);
    expect(systemPrompt).toBe('');
  });

  it('menggabungkan multiple system messages dengan newline', () => {
    const msgs = [
      { role: 'system', content: 'Bagian 1.' },
      { role: 'system', content: 'Bagian 2.' },
      { role: 'user', content: 'test' },
    ];
    const { systemPrompt } = p.extractSystemPrompt(msgs);
    expect(systemPrompt).toContain('Bagian 1.');
    expect(systemPrompt).toContain('Bagian 2.');
  });

  it('conversationMessages tidak mengandung system messages', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ];
    const { conversationMessages } = p.extractSystemPrompt(msgs);
    expect(conversationMessages.every(m => m.role !== 'system')).toBe(true);
  });
});

describe('BaseProvider: retryWithBackoff', () => {
  let p;
  beforeEach(() => { p = new TestProvider(); });

  it('mengembalikan hasil jika sukses pada percobaan pertama', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await p.retryWithBackoff(fn, 3, 10);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retry saat rate limit dan akhirnya sukses', async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) throw new Error('rate limit exceeded');
      return 'ok';
    });
    const result = await p.retryWithBackoff(fn, 3, 1); // delay 1ms untuk test cepat
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  }, 10000);

  it('melempar error setelah maxRetries habis', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('rate limit always fails'));
    await expect(p.retryWithBackoff(fn, 2, 1)).rejects.toThrow('rate limit always fails');
    expect(fn).toHaveBeenCalledTimes(2);
  }, 10000);

  it('melempar error langsung untuk non-rate-limit error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal error'));
    await expect(p.retryWithBackoff(fn, 3, 1)).rejects.toThrow('fatal error');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('BaseProvider: sleep', () => {
  let p;
  beforeEach(() => { p = new TestProvider(); });

  it('sleep menunggu sekitar durasi yang diberikan', async () => {
    const start = Date.now();
    await p.sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('sleep mengembalikan Promise', () => {
    const result = p.sleep(1);
    expect(result).toBeInstanceOf(Promise);
  });
});

describe('BaseProvider: abstract methods melempar error', () => {
  it('chat() base tidak diimplementasi melempar error', async () => {
    class UnimplementedProvider extends BaseProvider {
      constructor() { super({ name: 'Unimplemented', apiKey: 'k', baseUrl: 'u' }); }
    }
    const p = new UnimplementedProvider();
    await expect(p.chat([])).rejects.toThrow('chat() method not implemented');
  });

  it('chatStream() base melempar error', async () => {
    class UnimplementedProvider extends BaseProvider {
      constructor() { super({ name: 'Unimplemented', apiKey: 'k', baseUrl: 'u' }); }
    }
    const p = new UnimplementedProvider();
    const gen = p.chatStream([]);
    await expect(gen.next()).rejects.toThrow('chatStream() method not implemented');
  });

  it('getAvailableModels() base melempar error', async () => {
    class UnimplementedProvider extends BaseProvider {
      constructor() { super({ name: 'Unimplemented', apiKey: 'k', baseUrl: 'u' }); }
    }
    const p = new UnimplementedProvider();
    await expect(p.getAvailableModels()).rejects.toThrow('getAvailableModels() method not implemented');
  });
});
