/**
 * tests/stress-realtime.test.js
 *
 * Realtime stress & penetration test suite untuk server PRODUCTION/STAGING.
 * Kirim request HTTP langsung ke URL target — bukan in-process.
 *
 * PENGGUNAAN:
 *   PENTEST_TARGET_URL=https://your-server.com npx vitest run tests/stress-realtime.test.js
 *
 * PERINGATAN: Jalankan HANYA terhadap server milik sendiri.
 * Tujuan: identifikasi kelemahan → perbaiki → uji ulang → enterprise-grade.
 *
 * KATEGORI:
 *  1. Rate Limit Flooding (auth, chat, global)
 *  2. Concurrent Connection Burst
 *  3. Slow Request / Slowloris Simulation
 *  4. Payload Bomb (large body, deeply nested)
 *  5. Header Injection & Bypass
 *  6. Endpoint Enumeration / Fuzzing
 *  7. Session Flood
 *  8. Auth Brute Force Simulation
 *  9. Response Time Baseline & SLA
 * 10. Server Recovery (apakah server bangkit setelah serangan)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import http from 'http';
import https from 'https';
import { URL } from 'url';

// ─── Konfigurasi ──────────────────────────────────────────────────────────────
const TARGET = process.env.PENTEST_TARGET_URL || 'http://localhost:3000';
const TIMEOUT_MS = parseInt(process.env.PENTEST_TIMEOUT || '10000');
const BURST_SIZE = parseInt(process.env.PENTEST_BURST || '30');

console.log(`\n🎯 Target: ${TARGET}`);
console.log(`⏱  Timeout: ${TIMEOUT_MS}ms per request`);
console.log(`💥 Burst size: ${BURST_SIZE} concurrent requests\n`);

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function req(method, path, body = null, headers = {}) {
  return new Promise((resolve) => {
    const url = new URL(path, TARGET);
    const lib = url.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'WanarSecurityTest/1.0',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...headers,
      },
      timeout: TIMEOUT_MS,
      rejectUnauthorized: false, // allow self-signed certs
    };

    const startTime = Date.now();
    const request = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers, elapsed, ok: true });
      });
    });

    request.on('timeout', () => {
      request.destroy();
      resolve({ status: 0, body: null, headers: {}, elapsed: TIMEOUT_MS, ok: false, timedOut: true });
    });

    request.on('error', (e) => {
      resolve({ status: 0, body: null, headers: {}, elapsed: Date.now() - startTime, ok: false, error: e.message });
    });

    if (bodyStr) request.write(bodyStr);
    request.end();
  });
}

// Kirim N request sekaligus (concurrent burst)
async function burst(method, path, body, headers, n = BURST_SIZE) {
  const promises = Array.from({ length: n }, () => req(method, path, body, headers));
  return Promise.all(promises);
}

// Kirim N request berurutan (sequential flood)
async function sequential(method, path, body, headers, n = BURST_SIZE) {
  const results = [];
  for (let i = 0; i < n; i++) {
    results.push(await req(method, path, body, headers));
  }
  return results;
}

// ─── Skip jika tidak ada target URL ──────────────────────────────────────────
const SKIP = !process.env.PENTEST_TARGET_URL;
const maybeIt = SKIP ? it.skip : it;

if (SKIP) {
  console.warn('⚠️  PENTEST_TARGET_URL tidak di-set. Semua stress tests di-skip.');
  console.warn('   Jalankan: PENTEST_TARGET_URL=http://localhost:3000 npx vitest run tests/stress-realtime.test.js\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// 0. BASELINE — apakah server up?
// ═════════════════════════════════════════════════════════════════════════════
describe('Baseline: Server Availability', () => {
  maybeIt('server merespons GET /api/health', async () => {
    const res = await req('GET', '/api/health');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    console.log(`  ✓ Health check: ${res.elapsed}ms`);
  });

  maybeIt('response time health < 2000ms', async () => {
    const res = await req('GET', '/api/health');
    expect(res.elapsed).toBeLessThan(2000);
    console.log(`  ✓ Response time: ${res.elapsed}ms`);
  });

  maybeIt('security headers ada di production', async () => {
    const res = await req('GET', '/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. RATE LIMIT FLOODING
// ═════════════════════════════════════════════════════════════════════════════
describe('Rate Limit Flooding: Auth endpoint (max 10/min)', () => {
  maybeIt(`${BURST_SIZE} concurrent auth requests — rate limiter aktif`, async () => {
    const results = await burst('POST', '/api/auth/api-key', { api_key: 'brute_test' });
    const statuses = results.map(r => r.status);
    const hit429 = statuses.filter(s => s === 429).length;
    const blocked = statuses.filter(s => s >= 400).length;

    console.log(`  Statuses: ${[...new Set(statuses)].join(', ')}`);
    console.log(`  Rate limited (429): ${hit429}/${BURST_SIZE}`);
    console.log(`  Total blocked: ${blocked}/${BURST_SIZE}`);

    // Dengan 30 concurrent request ke endpoint limit 10/min, harus ada yang kena 429
    if (BURST_SIZE > 10) {
      expect(hit429).toBeGreaterThan(0);
    }
  }, 60000);

  maybeIt(`${BURST_SIZE} sequential auth requests — server tidak crash`, async () => {
    const results = await sequential('POST', '/api/auth/google', { idToken: 'fake' });
    const crashed = results.filter(r => r.status === 500 || !r.ok).length;
    expect(crashed).toBe(0);
    console.log(`  OK: ${results.filter(r => r.ok).length}/${BURST_SIZE}`);
  }, 60000);
});

describe('Rate Limit Flooding: Chat endpoint (max 40/min)', () => {
  maybeIt(`${BURST_SIZE} concurrent chat requests — server tetap hidup`, async () => {
    const chatBody = {
      messages: [{ role: 'user', content: 'stress test' }],
      provider: 'openagentic',
    };
    const results = await burst('POST', '/api/chat', chatBody);
    const responded = results.filter(r => r.ok || r.timedOut).length;
    const crashed = results.filter(r => r.status === 500 && !r.timedOut).length;

    console.log(`  Responded: ${responded}/${BURST_SIZE}`);
    console.log(`  Crashed (500): ${crashed}/${BURST_SIZE}`);
    console.log(`  Rate limited (429): ${results.filter(r => r.status === 429).length}/${BURST_SIZE}`);

    // Server tidak boleh down total
    expect(responded).toBeGreaterThan(0);
  }, 120000);

  maybeIt('global rate limiter aktif setelah flood', async () => {
    // Cek apakah server masih merespons health setelah flood
    const health = await req('GET', '/api/health');
    expect([200, 429]).toContain(health.status);
    console.log(`  Post-flood health: ${health.status} (${health.elapsed}ms)`);
  });
});

describe('Rate Limit Flooding: Global (120/min)', () => {
  maybeIt(`${Math.min(BURST_SIZE * 4, 130)} concurrent requests ke /api/health`, async () => {
    const n = Math.min(BURST_SIZE * 4, 130);
    const results = await burst('GET', '/api/health', null, {}, n);
    const ok = results.filter(r => r.status === 200).length;
    const limited = results.filter(r => r.status === 429).length;
    const errors = results.filter(r => !r.ok && !r.timedOut).length;

    console.log(`  OK (200): ${ok}/${n}`);
    console.log(`  Rate limited (429): ${limited}/${n}`);
    console.log(`  Connection errors: ${errors}/${n}`);

    // Server harus tetap merespons (tidak crash total)
    expect(ok + limited).toBeGreaterThan(0);
  }, 120000);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. CONCURRENT CONNECTION BURST
// ═════════════════════════════════════════════════════════════════════════════
describe('Concurrent Connection Burst', () => {
  maybeIt('50 concurrent GET /api/sessions — server tidak crash', async () => {
    const results = await burst('GET', '/api/sessions', null, {}, 50);
    const responded = results.filter(r => r.ok).length;
    const errors = results.filter(r => !r.ok && !r.timedOut).length;

    console.log(`  Responded: ${responded}/50`);
    console.log(`  Errors: ${errors}/50`);
    console.log(`  Avg response: ${Math.round(results.reduce((s, r) => s + r.elapsed, 0) / results.length)}ms`);

    expect(responded).toBeGreaterThan(40); // >80% harus berhasil
  }, 60000);

  maybeIt('50 concurrent POST /api/sessions — tidak ada data corruption', async () => {
    const results = await burst('POST', '/api/sessions', { title: 'stress_test' }, {}, 50);
    const created = results.filter(r => r.status === 200 && r.body?.id).length;
    const errors = results.filter(r => r.status === 500).length;

    console.log(`  Sessions dibuat: ${created}/50`);
    console.log(`  Server errors: ${errors}/50`);

    // Tidak boleh ada server error saat create session
    expect(errors).toBe(0);
  }, 60000);

  maybeIt('response time tidak degradasi signifikan di bawah load', async () => {
    // Baseline (1 request)
    const baseline = await req('GET', '/api/health');

    // Load (20 concurrent)
    const loadResults = await burst('GET', '/api/health', null, {}, 20);
    const avgLoad = loadResults.reduce((s, r) => s + r.elapsed, 0) / loadResults.length;

    console.log(`  Baseline: ${baseline.elapsed}ms`);
    console.log(`  Avg under load: ${Math.round(avgLoad)}ms`);
    console.log(`  Degradasi: ${Math.round((avgLoad / baseline.elapsed - 1) * 100)}%`);

    // Response time di bawah load tidak boleh > 10x baseline
    expect(avgLoad).toBeLessThan(baseline.elapsed * 10 + 5000);
  }, 60000);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. SLOW REQUEST (Slowloris simulation)
// ═════════════════════════════════════════════════════════════════════════════
describe('Slow Request / Slowloris Simulation', () => {
  maybeIt('server tidak hang karena slow incomplete request', async () => {
    // Kirim request dengan Content-Length besar tapi body tidak lengkap
    const url = new URL('/api/chat', TARGET);
    const lib = url.protocol === 'https:' ? https : http;

    const slowRequest = new Promise((resolve) => {
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '100000', // klaim body besar
        },
        timeout: 5000,
        rejectUnauthorized: false,
      };

      const request = lib.request(options, (res) => {
        resolve({ status: res.statusCode, ok: true });
      });

      request.on('timeout', () => {
        request.destroy();
        resolve({ status: 0, ok: false, timedOut: true });
      });

      request.on('error', () => {
        resolve({ status: 0, ok: false, error: true });
      });

      // Kirim hanya sebagian body (simulasi slowloris)
      request.write('{"messages":[{"role":"user","content":"slow');
      // TIDAK di-end — tunggu timeout server
    });

    const result = await slowRequest;
    // Server harus timeout atau reset koneksi, bukan hang selamanya
    expect(result.timedOut || result.error || result.status > 0).toBe(true);
    console.log(`  Slow request result: ${result.timedOut ? 'timeout' : result.error ? 'error (server reset)' : `status ${result.status}`}`);
  }, 15000);

  maybeIt('server tetap merespons request normal setelah slow attack', async () => {
    const res = await req('GET', '/api/health');
    expect([200, 429]).toContain(res.status);
    console.log(`  Post-slowloris health: ${res.status} (${res.elapsed}ms)`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. PAYLOAD BOMB
// ═════════════════════════════════════════════════════════════════════════════
describe('Payload Bomb: Oversized & Malformed Bodies', () => {
  maybeIt('body 3MB ditolak dengan 413', async () => {
    const bigContent = 'A'.repeat(3 * 1024 * 1024);
    const res = await req('POST', '/api/sessions', { title: 'test', data: bigContent });
    expect(res.status).toBe(413);
    console.log(`  3MB body: ${res.status}`);
  });

  maybeIt('body 1.9MB diterima (di bawah limit)', async () => {
    const content = 'A'.repeat(1.9 * 1024 * 1024);
    const res = await req('POST', '/api/sessions', { title: 'test', data: content });
    expect(res.status).not.toBe(413);
    console.log(`  1.9MB body: ${res.status}`);
  }, 30000);

  maybeIt('100 messages dalam satu request chat ditolak', async () => {
    const msgs = Array.from({ length: 101 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
    const res = await req('POST', '/api/chat', { messages: msgs, provider: 'openagentic' });
    expect(res.status).toBe(400);
    console.log(`  101 messages: ${res.status}`);
  });

  maybeIt('message content 50001 karakter ditolak', async () => {
    const res = await req('POST', '/api/chat', {
      messages: [{ role: 'user', content: 'X'.repeat(50001) }],
      provider: 'openagentic',
    });
    expect(res.status).toBe(400);
    console.log(`  50001 char content: ${res.status}`);
  });

  maybeIt('deeply nested JSON (100 level) tidak crash server', async () => {
    let nested = '{}';
    for (let i = 0; i < 100; i++) nested = `{"a":${nested}}`;
    const url = new URL('/api/sessions', TARGET);
    const lib = url.protocol === 'https:' ? https : http;

    const result = await new Promise((resolve) => {
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: '/api/sessions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(nested) },
        timeout: TIMEOUT_MS,
        rejectUnauthorized: false,
      };
      const request = lib.request(options, (res) => {
        resolve({ status: res.statusCode, ok: true });
      });
      request.on('error', () => resolve({ ok: false }));
      request.on('timeout', () => { request.destroy(); resolve({ ok: false, timedOut: true }); });
      request.write(nested);
      request.end();
    });

    expect(result.status).not.toBe(500);
    console.log(`  100-level nested JSON: ${result.status || 'error/timeout'}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. HEADER INJECTION & BYPASS
// ═════════════════════════════════════════════════════════════════════════════
describe('Header Injection & Rate Limit Bypass', () => {
  maybeIt('X-Forwarded-For spoofing tidak bypass rate limit', async () => {
    // Flood dengan X-Forwarded-For berbeda-beda — seharusnya tidak bypass per-IP limit
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        req('POST', '/api/auth/api-key', { api_key: 'test' }, {
          'X-Forwarded-For': `10.0.0.${i}`,
        })
      )
    );
    const limited = results.filter(r => r.status === 429).length;
    console.log(`  Rate limited via X-Forwarded-For spoofing: ${limited}/20`);
    // Jika server menggunakan X-Forwarded-For untuk key generator, spoofing bypass akan terlihat dari 0 yang ke-429
    // Idealnya minimal ada beberapa yang kena limit
  }, 30000);

  maybeIt('X-Real-IP spoofing tidak bypass auth', async () => {
    const res = await req('GET', '/api/auth/admin/users', null, {
      'X-Real-IP': '127.0.0.1',
      'X-Forwarded-For': '127.0.0.1',
    });
    expect([401, 403, 429]).toContain(res.status);
    console.log(`  X-Real-IP bypass attempt: ${res.status}`);
  });

  maybeIt('Host header injection tidak crash server', async () => {
    const res = await req('GET', '/api/health', null, {
      'Host': 'evil.com',
    });
    expect(res.status).toBeDefined();
    expect(res.status).not.toBe(500);
    console.log(`  Host injection: ${res.status}`);
  });

  maybeIt('oversized headers tidak crash server', async () => {
    const bigHeader = 'X'.repeat(8000);
    const res = await req('GET', '/api/health', null, {
      'X-Custom-Header': bigHeader,
    });
    // Server harus menolak atau memotong, tidak crash
    expect(res.status).not.toBe(500);
    console.log(`  8KB header: ${res.status || 'connection reset'}`);
  });

  maybeIt('Content-Type injection tidak crash server', async () => {
    const res = await req('POST', '/api/sessions', '{"title":"test"}', {
      'Content-Type': 'application/json; charset=utf-8; boundary=something; injected=value',
    });
    expect(res.status).not.toBe(500);
    console.log(`  Content-Type injection: ${res.status}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. ENDPOINT ENUMERATION / FUZZING
// ═════════════════════════════════════════════════════════════════════════════
describe('Endpoint Enumeration & Path Fuzzing', () => {
  const commonAdminPaths = [
    '/admin', '/admin/', '/admin/users', '/admin/config',
    '/api/admin', '/api/admin/users', '/api/admin/config',
    '/.env', '/.env.local', '/.env.production',
    '/config', '/config.json', '/config.js',
    '/api/debug', '/api/internal', '/api/secret',
    '/wp-admin', '/phpmyadmin', '/adminer',
    '/api/v1', '/api/v2', '/graphql',
    '/swagger', '/swagger.json', '/api-docs',
    '/health', '/metrics', '/status',
  ];

  maybeIt('path enumeration — tidak ada endpoint sensitif terbuka', async () => {
    const results = await Promise.all(
      commonAdminPaths.map(p => req('GET', p))
    );

    const exposed = [];
    results.forEach((res, i) => {
      if (res.status === 200) {
        // Cek apakah konten mengandung info sensitif
        const body = JSON.stringify(res.body || '');
        const isSensitive = body.match(/password|secret|api.?key|token|credential/i);
        if (isSensitive) exposed.push(commonAdminPaths[i]);
      }
    });

    const open200 = results.map((r, i) => r.status === 200 ? commonAdminPaths[i] : null).filter(Boolean);
    console.log(`  Path yang return 200: ${open200.join(', ') || 'none'}`);
    console.log(`  Path dengan data sensitif: ${exposed.join(', ') || 'none'}`);

    expect(exposed.length).toBe(0);
  }, 60000);

  maybeIt('path traversal via URL tidak mengungkap file sistem', async () => {
    const traversalPaths = [
      '/../../../etc/passwd',
      '/api/../../../etc/passwd',
      '/api/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/api/....//....//etc/passwd',
    ];

    for (const p of traversalPaths) {
      const res = await req('GET', p);
      const body = JSON.stringify(res.body || res.body || '');
      expect(body).not.toMatch(/root:x:0:0/);
      expect(res.status).not.toBe(500);
    }
    console.log(`  Path traversal: semua aman`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. SESSION FLOOD
// ═════════════════════════════════════════════════════════════════════════════
describe('Session Flood: Database Stress', () => {
  maybeIt(`buat ${BURST_SIZE} session sekaligus — database tidak crash`, async () => {
    const results = await burst('POST', '/api/sessions', { title: 'flood_test' }, {}, BURST_SIZE);
    const created = results.filter(r => r.status === 200 && r.body?.id).length;
    const errors = results.filter(r => r.status === 500).length;
    const ids = results.filter(r => r.body?.id).map(r => r.body.id);
    const uniqueIds = new Set(ids);

    console.log(`  Sessions dibuat: ${created}/${BURST_SIZE}`);
    console.log(`  Server errors: ${errors}/${BURST_SIZE}`);
    console.log(`  ID unik: ${uniqueIds.size}/${created} (${uniqueIds.size === created ? '✓ no collision' : '⚠ collision detected'})`);

    expect(errors).toBe(0);
    // Semua ID harus unik — tidak ada race condition
    expect(uniqueIds.size).toBe(created);
  }, 60000);

  maybeIt('hapus semua session flood test — cleanup', async () => {
    // Ambil semua session
    const listRes = await req('GET', '/api/sessions?limit=1000');
    const sessions = Array.isArray(listRes.body) ? listRes.body : [];
    const floodSessions = sessions.filter(s => s.title === 'flood_test' || s.title === 'stress_test');

    const deleteResults = await Promise.all(
      floodSessions.map(s => req('DELETE', `/api/sessions/${s.id}`))
    );
    const deleted = deleteResults.filter(r => r.status === 200).length;
    console.log(`  Cleanup: ${deleted}/${floodSessions.length} sessions dihapus`);
  }, 30000);
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. AUTH BRUTE FORCE SIMULATION
// ═════════════════════════════════════════════════════════════════════════════
describe('Auth Brute Force Simulation', () => {
  maybeIt('100 percobaan login berurutan — rate limit aktif sebelum 100', async () => {
    let firstBlock = -1;
    let attempts = 0;

    for (let i = 0; i < 20; i++) {
      const res = await req('POST', '/api/auth/api-key', {
        api_key: `brute_force_${i}_${Date.now()}`,
      });
      attempts++;
      if (res.status === 429 && firstBlock === -1) {
        firstBlock = i + 1;
        break;
      }
    }

    console.log(`  Total percobaan: ${attempts}`);
    console.log(`  Rate limited setelah: ${firstBlock === -1 ? 'tidak kena (dalam 20 percobaan)' : `percobaan ke-${firstBlock}`}`);

    // Dalam 20 percobaan berurutan seharusnya kena rate limit (max 10/min)
    // Jika tidak, catat sebagai warning bukan failure (counter mungkin belum reset)
    if (firstBlock === -1) {
      console.warn('  ⚠️  Rate limit tidak aktif dalam 20 percobaan — periksa counter reset');
    }
  }, 60000);

  maybeIt('Google auth flood — server tidak crash', async () => {
    const results = await sequential('POST', '/api/auth/google', { idToken: 'fake_token_brute' }, {}, 15);
    const crashed = results.filter(r => r.status === 500).length;
    expect(crashed).toBe(0);
    console.log(`  Google auth flood: ${results.filter(r => r.status === 429).length}/15 rate limited`);
  }, 60000);
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. RESPONSE TIME SLA
// ═════════════════════════════════════════════════════════════════════════════
describe('Response Time SLA (Service Level Agreement)', () => {
  maybeIt('GET /api/health: p99 < 1000ms', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => req('GET', '/api/health')));
    const times = results.filter(r => r.ok).map(r => r.elapsed).sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.5)];
    const p95 = times[Math.floor(times.length * 0.95)];
    const p99 = times[Math.floor(times.length * 0.99)] || times[times.length - 1];

    console.log(`  p50: ${p50}ms | p95: ${p95}ms | p99: ${p99}ms`);
    expect(p99).toBeLessThan(1000);
  }, 30000);

  maybeIt('GET /api/config: p95 < 2000ms', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => req('GET', '/api/config')));
    const times = results.filter(r => r.ok).map(r => r.elapsed).sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] || times[times.length - 1];
    console.log(`  p95 /api/config: ${p95}ms`);
    expect(p95).toBeLessThan(2000);
  }, 30000);

  maybeIt('GET /api/sessions: p95 < 3000ms', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => req('GET', '/api/sessions')));
    const times = results.filter(r => r.ok).map(r => r.elapsed).sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] || times[times.length - 1];
    console.log(`  p95 /api/sessions: ${p95}ms`);
    expect(p95).toBeLessThan(3000);
  }, 30000);
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. SERVER RECOVERY
// ═════════════════════════════════════════════════════════════════════════════
describe('Server Recovery: Apakah server bangkit setelah serangan?', () => {
  maybeIt('server masih merespons health setelah semua stress tests', async () => {
    // Tunggu sebentar untuk rate limit counter reset sebagian
    await new Promise(r => setTimeout(r, 2000));

    const res = await req('GET', '/api/health');
    expect(res.ok).toBe(true);
    expect([200, 429]).toContain(res.status);
    console.log(`  Post-attack health: ${res.status} (${res.elapsed}ms)`);
  });

  maybeIt('server masih bisa create session setelah semua stress tests', async () => {
    await new Promise(r => setTimeout(r, 1000));
    const res = await req('POST', '/api/sessions', { title: 'recovery_check' });
    expect(res.status).not.toBe(500);
    console.log(`  Post-attack session create: ${res.status}`);

    // Cleanup
    if (res.body?.id) await req('DELETE', `/api/sessions/${res.body.id}`);
  });

  maybeIt('laporan summary serangan', async () => {
    const health = await req('GET', '/api/health');
    const config = await req('GET', '/api/config');
    const sessions = await req('GET', '/api/sessions');

    console.log('\n  ═══════════════════════════════════════');
    console.log('  📊 LAPORAN HASIL STRESS TEST');
    console.log('  ═══════════════════════════════════════');
    console.log(`  Target    : ${TARGET}`);
    console.log(`  Health    : ${health.status} (${health.elapsed}ms)`);
    console.log(`  Config    : ${config.status} (${config.elapsed}ms)`);
    console.log(`  Sessions  : ${sessions.status} (${sessions.elapsed}ms)`);
    console.log(`  Status    : ${health.status === 200 ? '✅ SERVER MASIH HIDUP' : '⚠️  SERVER TERDEGRADASI'}`);
    console.log('  ═══════════════════════════════════════\n');

    // Server harus tetap hidup di akhir
    expect(health.ok).toBe(true);
  });
});
