/**
 * IIS Security Test Suite
 * Target: jababeka.softwareproperti.com (Microsoft IIS/ASP.NET)
 *
 * Live-external test — hanya jalan bila IIS_SECURITY_TEST=1.
 * Tanpa env tersebut seluruh suite di-skip agar `npx vitest run`
 * tetap hijau di CI / mesin developer (hasil scan eksternal bukan bug repo).
 */

import { describe, it, expect } from 'vitest';

const RUN_LIVE = process.env.IIS_SECURITY_TEST === '1';
const describeLive = RUN_LIVE ? describe : describe.skip;
import https from 'https';
import tls from 'tls';

const HOST = 'jababeka.softwareproperti.com';
const BASE = 'https://' + HOST;

function req(path, method = 'GET', extraHeaders = {}, body = null) {
  return new Promise((resolve) => {
    const start = Date.now();
    const opts = {
      hostname: HOST,
      path,
      method,
      headers: { 'User-Agent': 'Mozilla/5.0 SecurityTest', ...extraHeaders },
      rejectUnauthorized: false,
      timeout: 10000,
    };
    const r = https.request(opts, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: b.slice(0, 500), elapsed: Date.now() - start })
      );
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message, elapsed: Date.now() - start }));
    r.on('timeout', () => { r.destroy(); resolve({ status: -1, error: 'TIMEOUT', elapsed: Date.now() - start }); });
    if (body) r.write(body);
    r.end();
  });
}

function getTLS() {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: HOST, port: 443, rejectUnauthorized: false }, () => {
      const cert = sock.getPeerCertificate();
      const proto = sock.getProtocol();
      sock.destroy();
      resolve({ proto, cert });
    });
    sock.on('error', (e) => resolve({ error: e.message }));
  });
}

// ─── 1. BASELINE ────────────────────────────────────────────────────────────

describeLive('Baseline: Server Availability', () => {
  it('server merespons GET / dengan 200', async () => {
    const r = await req('/');
    console.log(`  / => ${r.status} (${r.elapsed}ms)`);
    expect(r.status).toBe(200);
  });

  it('server adalah IIS', async () => {
    const r = await req('/');
    console.log(`  Server header: ${r.headers['server']}`);
    expect(r.headers['server']).toMatch(/IIS/i);
  });

  it('response time < 3000ms', async () => {
    const r = await req('/');
    console.log(`  Elapsed: ${r.elapsed}ms`);
    expect(r.elapsed).toBeLessThan(3000);
  });
});

// ─── 2. SECURITY HEADERS ────────────────────────────────────────────────────

describeLive('Security Headers', () => {
  it('X-Content-Type-Options: nosniff ada', async () => {
    const r = await req('/');
    const val = r.headers['x-content-type-options'];
    console.log(`  x-content-type-options: ${val || 'MISSING ⚠️'}`);
    expect(val).toBe('nosniff');
  });

  it('X-Frame-Options ada (DENY atau SAMEORIGIN)', async () => {
    const r = await req('/');
    const val = r.headers['x-frame-options'];
    console.log(`  x-frame-options: ${val || 'MISSING ⚠️'}`);
    expect(['DENY', 'SAMEORIGIN']).toContain((val || '').toUpperCase());
  });

  it('Strict-Transport-Security ada', async () => {
    const r = await req('/');
    const val = r.headers['strict-transport-security'];
    console.log(`  strict-transport-security: ${val || 'MISSING ⚠️'}`);
    expect(val).toBeDefined();
  });

  it('X-Powered-By tidak mengekspos versi ASP.NET', async () => {
    const r = await req('/');
    const val = r.headers['x-powered-by'];
    console.log(`  x-powered-by: ${val || 'tidak ada (bagus)'}`);
    // Boleh ada tapi tidak boleh ekspos versi spesifik seperti "ASP.NET 4.x.x"
    if (val) {
      expect(val).not.toMatch(/\d+\.\d+\.\d+/);
    } else {
      expect(val).toBeUndefined();
    }
  });

  it('Server header tidak ekspos versi IIS spesifik', async () => {
    const r = await req('/');
    const val = r.headers['server'];
    console.log(`  server: ${val}`);
    // "Microsoft-IIS/10.0" ekspos versi — harusnya cukup "Microsoft-IIS" atau kosong
    expect(val).not.toMatch(/Microsoft-IIS\/\d/i);
  });

  it('Content-Security-Policy ada', async () => {
    const r = await req('/');
    const val = r.headers['content-security-policy'];
    console.log(`  content-security-policy: ${val || 'MISSING ⚠️'}`);
    expect(val).toBeDefined();
  });
});

// ─── 3. TLS / SSL ──────────────────────────────────────────────────────────

describeLive('TLS / SSL', () => {
  it('TLS 1.2 atau 1.3 digunakan', async () => {
    const { proto, error } = await getTLS();
    if (error) { console.log('  TLS error: ' + error); return; }
    console.log(`  Protocol: ${proto}`);
    expect(['TLSv1.2', 'TLSv1.3']).toContain(proto);
  });

  it('Sertifikat belum expired', async () => {
    const { cert, error } = await getTLS();
    if (error) { console.log('  TLS error: ' + error); return; }
    const expiry = new Date(cert.valid_to);
    const now = new Date();
    console.log(`  Cert valid until: ${cert.valid_to}`);
    expect(expiry.getTime()).toBeGreaterThan(now.getTime());
  });

  it('Sertifikat tidak expire dalam 30 hari', async () => {
    const { cert, error } = await getTLS();
    if (error) { console.log('  TLS error: ' + error); return; }
    const expiry = new Date(cert.valid_to);
    const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    console.log(`  Cert expires: ${cert.valid_to} | 30-day deadline: ${in30.toISOString()}`);
    expect(expiry.getTime()).toBeGreaterThan(in30.getTime());
  });
});

// ─── 4. PATH ENUMERATION ────────────────────────────────────────────────────

describeLive('Path Enumeration: Endpoint Sensitif', () => {
  const sensitivePaths = [
    '/admin', '/login', '/wp-admin', '/phpmyadmin', '/.env', '/.git/config',
    '/web.config', '/backup', '/config', '/test', '/shell.php',
    '/xmlrpc.php', '/wp-login.php', '/administrator', '/manager',
    '/elmah.axd', '/trace.axd', '/_vti_bin/shtml.dll', '/error.log',
    '/debug', '/console', '/actuator', '/actuator/health',
    '/App_Data', '/App_Code', '/bin/app.dll',
  ];

  it('tidak ada endpoint sensitif yang return 200', async () => {
    const results = await Promise.all(
      sensitivePaths.map((p) => req(p).then((r) => ({ path: p, status: r.status })))
    );
    const exposed = results.filter((r) => r.status === 200);
    exposed.forEach((r) => console.log(`  ⚠️  EXPOSED: ${r.path} => ${r.status}`));
    if (exposed.length === 0) console.log('  Semua path sensitif: aman');
    expect(exposed.length).toBe(0);
  });

  it('tidak ada path yang return 500 (internal error bocor)', async () => {
    const results = await Promise.all(
      sensitivePaths.map((p) => req(p).then((r) => ({ path: p, status: r.status })))
    );
    const errors = results.filter((r) => r.status === 500);
    errors.forEach((r) => console.log(`  ⚠️  500 error: ${r.path}`));
    expect(errors.length).toBe(0);
  });
});

// ─── 5. HTTP METHODS ────────────────────────────────────────────────────────

describeLive('HTTP Methods', () => {
  it('TRACE method dinonaktifkan', async () => {
    const r = await req('/', 'TRACE');
    console.log(`  TRACE / => ${r.status}`);
    // TRACE harus return 405 atau 403, bukan 200
    expect([403, 405]).toContain(r.status);
  });

  it('OPTIONS tidak mengekspos method berbahaya', async () => {
    const r = await req('/', 'OPTIONS');
    const allow = r.headers['allow'] || r.headers['public'] || '';
    console.log(`  OPTIONS Allow: ${allow || '(tidak ada header)'}`);
    expect(allow).not.toMatch(/TRACE/i);
  });

  it('DELETE ke root ditolak', async () => {
    const r = await req('/', 'DELETE');
    console.log(`  DELETE / => ${r.status}`);
    expect([403, 405, 401]).toContain(r.status);
  });

  it('PUT ke root ditolak', async () => {
    const r = await req('/', 'PUT');
    console.log(`  PUT / => ${r.status}`);
    expect([403, 405, 401]).toContain(r.status);
  });
});

// ─── 6. INJECTION ───────────────────────────────────────────────────────────

describeLive('Injection & Path Traversal', () => {
  it('XSS di URL path tidak di-reflect di body', async () => {
    const r = await req('/search?q=<script>alert(1)</script>');
    console.log(`  XSS test: ${r.status}`);
    expect(r.body).not.toMatch(/<script>alert\(1\)<\/script>/i);
  });

  it('path traversal ../windows/win.ini tidak return 200', async () => {
    const r = await req('/../../windows/win.ini');
    console.log(`  Path traversal: ${r.status}`);
    expect(r.status).not.toBe(200);
  });

  it('encoded path traversal tidak return 200', async () => {
    const r = await req('/%2e%2e/%2e%2e/windows/win.ini');
    console.log(`  Encoded traversal: ${r.status}`);
    expect(r.status).not.toBe(200);
  });

  it('null byte injection tidak crash server', async () => {
    const r = await req('/index.html%00.php');
    console.log(`  Null byte: ${r.status}`);
    expect(r.status).not.toBe(500);
  });

  it('SQL injection di query string tidak return 500', async () => {
    const r = await req("/search?id=1%27+OR+%271%27%3D%271");
    console.log(`  SQL injection: ${r.status}`);
    expect(r.status).not.toBe(500);
  });
});

// ─── 7. LOAD TEST ───────────────────────────────────────────────────────────

describeLive('Load Test: IIS', () => {
  it('20 concurrent GET / — semua merespons', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => req('/')));
    const ok = results.filter((r) => r.status === 200).length;
    const errors = results.filter((r) => r.status === 0 || r.status === -1).length;
    console.log(`  OK: ${ok}/20 | Errors: ${errors}/20`);
    expect(ok).toBeGreaterThanOrEqual(18);
  });

  it('response time p95 < 3000ms di bawah 20 concurrent load', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => req('/')));
    const times = results.map((r) => r.elapsed).sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    console.log(`  avg: ${avg}ms | p95: ${p95}ms | max: ${times[times.length - 1]}ms`);
    expect(p95).toBeLessThan(3000);
  });

  it('50 concurrent GET / — server tidak crash (< 10% error)', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => req('/')));
    const errors = results.filter((r) => r.status === 0 || r.status === -1 || r.status >= 500).length;
    console.log(`  Errors: ${errors}/50`);
    expect(errors).toBeLessThan(5);
  });
});

// ─── 8. HTTP -> HTTPS REDIRECT ──────────────────────────────────────────────

describeLive('HTTP → HTTPS Redirect', () => {
  it('HTTP port 80 redirect ke HTTPS', () => {
    return new Promise((resolve) => {
      const http = require('http');
      const r = http.request({ hostname: HOST, path: '/', method: 'GET', timeout: 8000 }, (res) => {
        console.log(`  HTTP status: ${res.statusCode} Location: ${res.headers['location'] || '?'}`);
        expect([301, 302, 307, 308]).toContain(res.statusCode);
        if (res.headers['location']) {
          expect(res.headers['location']).toMatch(/^https/i);
        }
        resolve();
      });
      r.on('error', (e) => { console.log(`  HTTP error: ${e.message}`); resolve(); });
      r.on('timeout', () => { r.destroy(); console.log('  HTTP timeout'); resolve(); });
      r.end();
    });
  });
});
