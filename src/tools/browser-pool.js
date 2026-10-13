/**
 * src/tools/browser-pool.js
 *
 * Persistent Chromium pool untuk Wanar AI.
 *
 * MASALAH LAMA: setiap pemanggilan browser_open menjalankan `chromium.launch()`
 * baru. Launch Chromium butuh ~1-3 detik — itu penyebab utama lambat.
 *
 * SOLUSI: satu instance Chromium yang hidup terus (warm), lalu tiap navigasi
 * hanya membuka "tab" (page) di context yang sudah ada. Navigasi jadi ~100-500ms
 * karena browser sudah siap sebelum tool dipanggil.
 *
 * Fitur:
 *   - Warm pool + auto-relaunch bila browser mati/terputus
 *   - Resource blocking opsional agar halaman ringan & cepat (blokir gambar,
 *     font, media, analytics) — bisa dimatikan lewat BROWSER_BLOCK_RESOURCES.
 *   - Context sharing untuk kesan "browser sama" antar pemanggilan
 *   - Idle reaper: browser ditutup otomatis setelah BROWSER_IDLE_MS tidak dipakai
 */

import { getChromium } from './lazy-playwright.js';

const HEADLESS_POOL = String(process.env.BROWSER_POOL_ENABLED || 'true').toLowerCase() !== 'false';
const BLOCK_RESOURCES = String(process.env.BROWSER_BLOCK_RESOURCES || 'true').toLowerCase() === 'true';
const IDLE_MS = parseInt(process.env.BROWSER_IDLE_MS || '90000', 10);
const NAV_TIMEOUT = parseInt(process.env.BROWSER_NAV_TIMEOUT_MS || '30000', 10);
const MAX_PAGES = parseInt(process.env.BROWSER_MAX_PAGES || '6', 10);

const BLOCKED_TYPES = new Set(['image', 'font', 'media']);
const BLOCKED_HOST_RE = /(google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|segment\.io|fullstory|clarity\.ms|mixpanel|amplitude)/i;

let _browser = null;
let _context = null;
let _launching = null;
let _idleTimer = null;
let _activePages = 0;

function launchArgs() {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
    '--disable-extensions',
    '--disable-component-update',
    '--metrics-recording-only',
    '--mute-audio',
    '--hide-scrollbars',
  ];
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function contextOptions() {
  return {
    userAgent: UA,
    viewport: { width: 1366, height: 850 },
    locale: 'id-ID,id;q=0.9,en-US;q=0.8',
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
  };
}

/** Pastikan ada browser + context warm. Return { browser, context }. */
export async function ensurePool() {
  if (_browser && _browser.isConnected?.() && _context) return { browser: _browser, context: _context };
  if (_launching) return _launching;

  _launching = (async () => {
    const chromium = await getChromium();
    _browser = await chromium.launch({ headless: HEADLESS_POOL, args: launchArgs() });
    _context = await _browser.newContext(contextOptions());
    if (BLOCK_RESOURCES) {
      await _context.route('**/*', (route) => {
        const req = route.request();
        try {
          if (BLOCKED_TYPES.has(req.resourceType())) return route.abort();
          if (BLOCKED_HOST_RE.test(req.url())) return route.abort();
        } catch { /* noop */ }
        return route.continue();
      });
    }
    _browser.on('disconnected', () => {
      _browser = null; _context = null; _launching = null;
    });
    return { browser: _browser, context: _context };
  })();

  try {
    return await _launching;
  } finally {
    _launching = null;
  }
}

/** Ambil page baru dari pool (di-manage agar tidak menumpuk). */
export async function acquirePage() {
  const { context } = await ensurePool();

  // Buang page lama bila sudah terlalu banyak.
  try {
    const pages = context.pages();
    if (pages.length >= MAX_PAGES) {
      const idle = pages.find(p => !p.__wanarBusy);
      if (idle) await idle.close().catch(() => {});
    }
  } catch { /* noop */ }

  const page = await context.newPage();
  page.__wanarBusy = true;
  _activePages++;
  resetIdleTimer();
  return page;
}

/** Kembalikan page ke pool (tutup untuk membebaskan memori). */
export async function releasePage(page) {
  if (!page) return;
  page.__wanarBusy = false;
  _activePages = Math.max(0, _activePages - 1);
  try { await page.close(); } catch { /* noop */ }
  resetIdleTimer();
}

/** Tutup browser saat idle terlalu lama — hemat RAM. */
function resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer);
  if (!HEADLESS_POOL) return;
  _idleTimer = setTimeout(() => {
    if (_activePages === 0) closePool();
  }, IDLE_MS);
  _idleTimer.unref?.();
}

/** Tutup seluruh pool. */
export async function closePool() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  const b = _browser;
  _browser = null; _context = null;
  if (b) { try { await b.close(); } catch { /* noop */ } }
}

/** Pre-warm: panggil saat server start agar browser_open pertama tidak lambat. */
export async function warmPool() {
  if (!HEADLESS_POOL) return false;
  try { await ensurePool(); return true; } catch { return false; }
}

/** Navigasi cepat + tunggu seperlunya. */
export async function fastGoto(page, url, opts = {}) {
  const { timeout = NAV_TIMEOUT, wait_for, wait_until = 'domcontentloaded' } = opts;
  const start = Date.now();
  await page.goto(url, { timeout, waitUntil: wait_until });
  const gotoMs = Date.now() - start;

  if (wait_for === 'networkidle') {
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
  } else if (wait_for) {
    await page.waitForSelector(wait_for, { timeout: 8000 }).catch(() => {});
  } else {
    // Tunggu singkat agar JS render — jauh lebih cepat dari 1500ms lama.
    await page.waitForLoadState('load', { timeout: 4000 }).catch(() => {});
  }
  return { gotoMs, totalMs: Date.now() - start };
}

export function poolStats() {
  return {
    enabled: HEADLESS_POOL,
    connected: Boolean(_browser?.isConnected?.()),
    pages: _context ? _context.pages().length : 0,
    active: _activePages,
    blockResources: BLOCK_RESOURCES,
    idleMs: IDLE_MS,
  };
}

process.on('exit', () => { try { _browser?.close(); } catch { /* noop */ } });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { _browser?.close(); } catch { /* noop */ } });
}

export default { ensurePool, acquirePage, releasePage, closePool, warmPool, fastGoto, poolStats };