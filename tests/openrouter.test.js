/**
 * tests/openrouter.test.js
 *
 * Auto-switch model gratis + penanganan kuota harian free-tier.
 * Kuota `free-models-per-day` bersifat akun (50 request/hari), jadi pindah
 * model TIDAK menolong — provider harus berhenti mencoba dan melapor 429.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

vi.mock('../src/providers/http-client.js', () => ({
  default: { post: vi.fn(), get: vi.fn() },
}));

import http from '../src/providers/http-client.js';
import OpenRouterProvider from '../src/providers/openrouter.js';

const QUOTA_MESSAGE = 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day';

function quotaError(resetMs = 1791849600000) {
  const err = new Error('Request failed with status code 429');
  err.response = {
    status: 429,
    data: {
      error: {
        message: QUOTA_MESSAGE,
        code: 429,
        metadata: {
          headers: {
            'X-RateLimit-Limit': '50',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(resetMs),
          },
        },
      },
    },
  };
  return err;
}

function rateLimitError() {
  const err = new Error('Request failed with status code 429');
  err.response = { status: 429, data: { error: { message: 'Rate limit exceeded for this model' } } };
  return err;
}

function makeProvider() {
  const p = new OpenRouterProvider();
  p.apiKey = 'test-key';
  p.capabilities.autoSwitchFree = true;
  return p;
}

describe('OpenRouter: klasifikasi auto-switch', () => {
  it('kuota harian akun TIDAK memicu auto-switch (model lain pasti ikut kena)', () => {
    const p = makeProvider();
    expect(p._shouldSwitch(quotaError())).toBe(false);
    expect(p._isDailyQuota(quotaError())).toBe(true);
  });

  it('rate-limit per-model tetap memicu auto-switch', () => {
    const p = makeProvider();
    expect(p._shouldSwitch(rateLimitError())).toBe(true);
  });

  it('auto-switch nonaktif → tidak pernah pindah model', () => {
    const p = makeProvider();
    p.capabilities.autoSwitchFree = false;
    expect(p._shouldSwitch(rateLimitError())).toBe(false);
  });
});

describe('OpenRouter: pesan kuota harian', () => {
  it('menyebut batas harian dan waktu reset (WIB)', () => {
    const p = makeProvider();
    const msg = p._dailyQuotaMessage(quotaError());
    expect(msg).toContain('Kuota harian model gratis OpenRouter habis');
    expect(msg).toContain('50 request/hari');
    expect(msg).toContain('Reset');
    expect(msg).toContain('WIB');
    expect(msg).toContain('$10');
  });

  it('tanpa header reset → tetap meminta coba lagi nanti', () => {
    const p = makeProvider();
    const msg = p._dailyQuotaMessage(quotaError(0));
    expect(msg).toContain('Coba lagi');
  });
});

describe('OpenRouter.chat: kuota habis', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('berhenti setelah 1 percobaan (tanpa pemborosan auto-switch)', async () => {
    http.post.mockRejectedValue(quotaError());
    const p = makeProvider();
    const res = await p.chat([{ role: 'user', content: 'halo' }]);

    expect(res.success).toBe(false);
    expect(res.daily_quota).toBe(true);
    expect(res.code).toBe(429);
    expect(res.error).toContain('Kuota harian model gratis OpenRouter habis');
    expect(res.auto_switch).toBeNull();
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('rate-limit per-model tetap berpindah model sebelum menyerah', async () => {
    http.post.mockRejectedValueOnce(rateLimitError()).mockRejectedValueOnce(rateLimitError());
    const p = makeProvider();
    const res = await p.chat([{ role: 'user', content: 'halo' }]);

    expect(res.success).toBe(false);
    expect(http.post.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('OpenRouter.chatStream: kuota habis', () => {
  it('mengirim event error berisi pesan ramah', async () => {
    http.post.mockRejectedValue(quotaError());
    const p = makeProvider();
    const events = [];
    for await (const ev of p.chatStream([{ role: 'user', content: 'halo' }])) events.push(ev);

    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent.content).toContain('Kuota harian model gratis OpenRouter habis');
  });
});

// ── Status HTTP endpoint chat ──────────────────────────────────────────────
// Kegagalan upstream bukan kesalahan server: 429 untuk kuota, 502 untuk matinya
// provider. 500 dipakai hanya untuk bug internal.
describe('POST /api/chat: status ketika upstream gagal', () => {
  let app;
  const originalChat = OpenRouterProvider.prototype.chat;

  let fetchSpy;
  beforeAll(async () => {
    // Providers that use fetch (NVIDIA) are not covered by the http-client mock: cut the real
    // network so "everything upstream failed" is what this test really exercises.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled in test'));
    const mod = await import('../src/server.js');
    app = mod.default;
  });
  afterAll(() => { OpenRouterProvider.prototype.chat = originalChat; fetchSpy?.mockRestore(); });

  it('kuota harian habis → 429 dengan pesan ramah', async () => {
    OpenRouterProvider.prototype.chat = async () => ({
      success: false,
      error: 'Kuota harian model gratis OpenRouter habis (50 request/hari).',
      code: 429,
      daily_quota: true,
    });
    const res = await request(app)
      .post('/api/chat')
      .send({ provider: 'openrouter', messages: [{ role: 'user', content: 'halo' }] });
    expect(res.status).toBe(429);
    expect(res.body.error).toContain('Kuota harian');
  });

  it('provider mati/error upstream → 502 (bukan 500)', async () => {
    OpenRouterProvider.prototype.chat = async () => ({
      success: false,
      error: 'Upstream exploded',
      code: 503,
    });
    const res = await request(app)
      .post('/api/chat')
      .send({ provider: 'openrouter', messages: [{ role: 'user', content: 'halo' }] });
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
  });
});
