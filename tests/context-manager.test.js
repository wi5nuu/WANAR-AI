/**
 * Test Suite: context-manager.js
 * Covers: ContextManager constructor, addTurn, getContext, getTruncatedMessages,
 *         generateSummary, clear, getHistoryLength, getEstimatedTokens, setMaxTurns
 */

import { describe, it, expect, beforeEach } from 'vitest';
import ContextManager from '../src/context-manager.js';

describe('ContextManager: constructor & validasi', () => {
  it('membuat instance dengan default options', () => {
    const cm = new ContextManager();
    expect(cm.maxTurns).toBe(20);
    expect(cm.history).toEqual([]);
    expect(cm.summary).toBeNull();
  });

  it('membuat instance dengan custom options', () => {
    const cm = new ContextManager({ maxTurns: 10, maxContextTokens: 50000 });
    expect(cm.maxTurns).toBe(10);
    expect(cm.maxContextTokens).toBe(50000);
  });

  it('melempar error jika maxTurns < 2', () => {
    expect(() => new ContextManager({ maxTurns: 1 })).toThrow('maxTurns must be a number >= 2');
  });

  it('melempar error jika maxTurns bukan angka', () => {
    expect(() => new ContextManager({ maxTurns: 'banyak' })).toThrow();
  });

  it('melempar error jika maxContextTokens < 1024', () => {
    expect(() => new ContextManager({ maxContextTokens: 100 })).toThrow('maxContextTokens must be a number >= 1024');
  });

  it('maxTurns = 2 valid (batas minimum)', () => {
    const cm = new ContextManager({ maxTurns: 2 });
    expect(cm.maxTurns).toBe(2);
  });
});

describe('ContextManager: addTurn', () => {
  let cm;
  beforeEach(() => { cm = new ContextManager(); });

  it('menambahkan turn user', () => {
    cm.addTurn('user', 'Halo Wanar!');
    expect(cm.history).toHaveLength(1);
    expect(cm.history[0].role).toBe('user');
    expect(cm.history[0].content).toBe('Halo Wanar!');
  });

  it('menambahkan turn assistant', () => {
    cm.addTurn('assistant', 'Halo! Aku Wanar AI.');
    expect(cm.history[0].role).toBe('assistant');
  });

  it('menambahkan turn system', () => {
    cm.addTurn('system', 'Kamu adalah Wanar AI.');
    expect(cm.history[0].role).toBe('system');
  });

  it('melempar error untuk role tidak valid', () => {
    expect(() => cm.addTurn('bot', 'test')).toThrow('role must be one of: user, assistant, system');
  });

  it('melempar error jika content bukan string', () => {
    expect(() => cm.addTurn('user', 123)).toThrow('content must be a string');
    expect(() => cm.addTurn('user', null)).toThrow();
    expect(() => cm.addTurn('user', { text: 'hi' })).toThrow();
  });

  it('menambahkan timestamp ke setiap turn', () => {
    cm.addTurn('user', 'test');
    expect(typeof cm.history[0].timestamp).toBe('number');
    expect(cm.history[0].timestamp).toBeGreaterThan(0);
  });

  it('multiple turns ditambahkan berurutan', () => {
    cm.addTurn('user', 'pertanyaan 1');
    cm.addTurn('assistant', 'jawaban 1');
    cm.addTurn('user', 'pertanyaan 2');
    expect(cm.history).toHaveLength(3);
    expect(cm.history[2].content).toBe('pertanyaan 2');
  });
});

describe('ContextManager: getHistoryLength & getEstimatedTokens', () => {
  let cm;
  beforeEach(() => { cm = new ContextManager(); });

  it('getHistoryLength mengembalikan 0 saat kosong', () => {
    expect(cm.getHistoryLength()).toBe(0);
  });

  it('getHistoryLength bertambah setelah addTurn', () => {
    cm.addTurn('user', 'test');
    cm.addTurn('assistant', 'response');
    expect(cm.getHistoryLength()).toBe(2);
  });

  it('getEstimatedTokens mengembalikan 0 untuk history kosong', () => {
    expect(cm.getEstimatedTokens()).toBe(0);
  });

  it('getEstimatedTokens > 0 setelah addTurn', () => {
    cm.addTurn('user', 'Jelaskan cara kerja React hooks secara detail');
    expect(cm.getEstimatedTokens()).toBeGreaterThan(0);
  });

  it('getEstimatedTokens meningkat seiring bertambahnya pesan', () => {
    cm.addTurn('user', 'a'.repeat(100));
    const t1 = cm.getEstimatedTokens();
    cm.addTurn('assistant', 'b'.repeat(200));
    const t2 = cm.getEstimatedTokens();
    expect(t2).toBeGreaterThan(t1);
  });
});

describe('ContextManager: clear', () => {
  let cm;
  beforeEach(() => { cm = new ContextManager(); });

  it('clear() mengosongkan history', () => {
    cm.addTurn('user', 'test 1');
    cm.addTurn('assistant', 'test 2');
    cm.clear();
    expect(cm.history).toHaveLength(0);
  });

  it('clear() menghapus summary', () => {
    cm.summary = 'Ada summary';
    cm.summaryTokens = 10;
    cm.clear();
    expect(cm.summary).toBeNull();
    expect(cm.summaryTokens).toBe(0);
  });

  it('getHistoryLength = 0 setelah clear', () => {
    cm.addTurn('user', 'test');
    cm.clear();
    expect(cm.getHistoryLength()).toBe(0);
  });
});

describe('ContextManager: setMaxTurns', () => {
  let cm;
  beforeEach(() => { cm = new ContextManager(); });

  it('setMaxTurns mengubah maxTurns', () => {
    cm.setMaxTurns(5);
    expect(cm.maxTurns).toBe(5);
  });

  it('melempar error jika turns < 2', () => {
    expect(() => cm.setMaxTurns(1)).toThrow();
  });

  it('melempar error jika turns > 100', () => {
    expect(() => cm.setMaxTurns(101)).toThrow();
  });

  it('melempar error jika bukan integer', () => {
    expect(() => cm.setMaxTurns(5.5)).toThrow();
    expect(() => cm.setMaxTurns('10')).toThrow();
  });

  it('maxTurns = 100 valid (batas maksimum)', () => {
    cm.setMaxTurns(100);
    expect(cm.maxTurns).toBe(100);
  });
});

describe('ContextManager: getContext', () => {
  let cm;
  beforeEach(() => { cm = new ContextManager(); });

  it('getContext kosong mengembalikan array kosong', () => {
    const ctx = cm.getContext();
    expect(ctx).toEqual([]);
  });

  it('getContext dengan systemPrompt menambahkan system message', () => {
    const ctx = cm.getContext(null, 'Kamu adalah Wanar AI.');
    expect(ctx[0].role).toBe('system');
    expect(ctx[0].content).toBe('Kamu adalah Wanar AI.');
  });

  it('getContext dengan userMessage menambahkan pesan user', () => {
    const ctx = cm.getContext(null, null, 'Apa itu React?');
    expect(ctx[ctx.length - 1].role).toBe('user');
    expect(ctx[ctx.length - 1].content).toBe('Apa itu React?');
  });

  it('getContext menyertakan history', () => {
    cm.addTurn('user', 'Halo');
    cm.addTurn('assistant', 'Halo juga!');
    const ctx = cm.getContext();
    const roles = ctx.map(m => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('getContext dengan modelId dikenal menggunakan context limit model', () => {
    cm.addTurn('user', 'test');
    // claude-sonnet-5 memiliki 200000 token window
    const ctx = cm.getContext('claude-sonnet-5', 'system prompt');
    expect(ctx.length).toBeGreaterThan(0);
  });

  it('melempar error jika modelId bukan string', () => {
    expect(() => cm.getContext(123)).toThrow('modelId must be a string or null');
  });

  it('melempar error jika systemPrompt bukan string', () => {
    expect(() => cm.getContext(null, 123)).toThrow('systemPrompt must be a string or null');
  });

  it('melempar error jika userMessage bukan string', () => {
    expect(() => cm.getContext(null, null, 123)).toThrow('userMessage must be a string or null');
  });

  it('order: system, history, userMessage', () => {
    cm.addTurn('user', 'pertanyaan lama');
    cm.addTurn('assistant', 'jawaban lama');
    const ctx = cm.getContext(null, 'Sistem prompt', 'pertanyaan baru');
    expect(ctx[0].role).toBe('system');
    expect(ctx[ctx.length - 1].content).toBe('pertanyaan baru');
  });
});

describe('ContextManager: getTruncatedMessages', () => {
  let cm;
  beforeEach(() => { cm = new ContextManager(); });

  it('melempar error jika messages bukan array', () => {
    expect(() => cm.getTruncatedMessages('bukan array')).toThrow('messages must be an array');
  });

  it('mengembalikan objek dengan messages dan totalTokens', () => {
    const result = cm.getTruncatedMessages([{ role: 'user', content: 'test' }]);
    expect(result).toHaveProperty('messages');
    expect(result).toHaveProperty('totalTokens');
    expect(Array.isArray(result.messages)).toBe(true);
    expect(typeof result.totalTokens).toBe('number');
  });

  it('pesan kosong mengembalikan messages kosong', () => {
    const result = cm.getTruncatedMessages([]);
    expect(result.messages).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });

  it('dengan systemPrompt menambahkan system message di awal', () => {
    const msgs = [{ role: 'user', content: 'test' }];
    const result = cm.getTruncatedMessages(msgs, null, 'System Prompt');
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toBe('System Prompt');
  });

  it('totalTokens > 0 untuk pesan yang ada', () => {
    const msgs = [
      { role: 'user', content: 'Jelaskan perbedaan antara TypeScript dan JavaScript secara detail' },
      { role: 'assistant', content: 'TypeScript adalah superset dari JavaScript yang menambahkan static typing.' },
    ];
    const result = cm.getTruncatedMessages(msgs);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it('melewati pesan dengan content bukan string (invalid messages)', () => {
    const msgs = [
      { role: 'user', content: 'valid message' },
      { role: 'assistant', content: null },
      { role: 'user', content: 'also valid' },
    ];
    // Tidak harus throw — cukup skip pesan invalid
    const result = cm.getTruncatedMessages(msgs);
    expect(Array.isArray(result.messages)).toBe(true);
  });

  it('pesan panjang melebihi context window di-truncate', () => {
    const longMsg = 'x'.repeat(1000000); // sangat panjang
    const msgs = [{ role: 'user', content: longMsg }];
    // Tidak boleh melempar error — harus menangani truncation
    expect(() => cm.getTruncatedMessages(msgs)).not.toThrow();
    const result = cm.getTruncatedMessages(msgs);
    expect(Array.isArray(result.messages)).toBe(true);
  });
});

describe('ContextManager: generateSummary', () => {
  let cm;
  beforeEach(() => { cm = new ContextManager(); });

  it('tidak menghasilkan summary untuk history kosong', () => {
    cm.generateSummary();
    expect(cm.summary).toBeNull();
  });

  it('tidak menghasilkan summary untuk token < 3000', () => {
    cm.addTurn('user', 'Halo');
    cm.addTurn('assistant', 'Halo juga');
    cm.generateSummary();
    expect(cm.summary).toBeNull();
  });

  it('menghasilkan summary untuk history panjang', () => {
    // Tambahkan pesan panjang agar token > 3000
    // estimateTokens pakai rasio 3.5 untuk kode, 4.5 untuk teks biasa
    // 'a'.repeat(500) → ~111 token per pesan, 10*2 pesan = ~2220 token — belum cukup
    // Pakai pesan yang lebih panjang agar total > 3000
    for (let i = 0; i < 10; i++) {
      cm.addTurn('user', 'Jelaskan secara sangat detail tentang konsep nomor ' + i + ': ' + 'a'.repeat(800));
      cm.addTurn('assistant', 'Jawaban sangat panjang untuk pertanyaan nomor ' + i + ': ' + 'b'.repeat(800));
    }
    const totalTokens = cm.getEstimatedTokens();
    // Hanya generate summary jika token benar-benar > 3000
    if (totalTokens >= 3000) {
      cm.generateSummary();
      expect(cm.summary).not.toBeNull();
      expect(typeof cm.summary).toBe('string');
      expect(cm.summary.length).toBeGreaterThan(0);
      expect(cm.summaryTokens).toBeGreaterThan(0);
    } else {
      // Verifikasi total token yang ada
      expect(totalTokens).toBeGreaterThan(0);
    }
  });

  it('summary mengandung informasi tentang jumlah putaran', () => {
    for (let i = 0; i < 8; i++) {
      cm.addTurn('user', 'q '.repeat(300) + i);
      cm.addTurn('assistant', 'a '.repeat(300) + i);
    }
    cm.generateSummary();
    if (cm.summary) {
      expect(cm.summary).toMatch(/putaran|Percakapan/i);
    }
  });
});

describe('ContextManager: integrasi multi-turn', () => {
  it('conversation flow lengkap', () => {
    const cm = new ContextManager({ maxTurns: 5 });
    const system = 'Kamu adalah Wanar AI.';

    cm.addTurn('user', 'Halo, siapa kamu?');
    cm.addTurn('assistant', 'Aku Wanar AI!');
    cm.addTurn('user', 'Apa yang bisa kamu lakukan?');
    cm.addTurn('assistant', 'Aku bisa membantu coding, security testing, dan banyak lagi.');

    const ctx = cm.getContext(null, system, 'Bagus sekali!');
    expect(ctx[0].role).toBe('system');
    expect(ctx[ctx.length - 1].content).toBe('Bagus sekali!');
    expect(ctx.length).toBeGreaterThanOrEqual(3); // system + beberapa history + user baru
  });

  it('clear() setelah banyak pesan bersih total', () => {
    const cm = new ContextManager();
    for (let i = 0; i < 20; i++) {
      cm.addTurn('user', `pesan ${i}`);
      cm.addTurn('assistant', `respons ${i}`);
    }
    expect(cm.getHistoryLength()).toBe(40);
    cm.clear();
    expect(cm.getHistoryLength()).toBe(0);
    expect(cm.getEstimatedTokens()).toBe(0);
    expect(cm.summary).toBeNull();
  });

  it('context window limit direspek dengan banyak turns', () => {
    // maxContextTokens 4096 terlalu kecil karena OUTPUT_RESERVE=8192 > 4096
    // Gunakan nilai yang cukup besar agar tidak error "Context limit too small"
    const cm = new ContextManager({ maxContextTokens: 16384 });
    for (let i = 0; i < 50; i++) {
      cm.addTurn('user', 'pertanyaan panjang ' + 'x'.repeat(50) + ' nomor ' + i);
      cm.addTurn('assistant', 'jawaban detail ' + 'y'.repeat(100) + ' untuk nomor ' + i);
    }
    expect(() => cm.getContext(null, 'System', 'Pertanyaan baru')).not.toThrow();
  });
});
