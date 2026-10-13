/**
 * src/tools/lazy-playwright.js
 *
 * Loader malas untuk Playwright.
 *
 * Playwright + browser-nya adalah dependensi TERBERAT di proyek ini
 * (±18 MB paket + ±300 MB Chromium). Bila di-import statis di tiap file,
 * modulnya ikut dimuat saat server start — memakan RAM walau tak dipakai,
 * dan server crash total bila tidak terpasang.
 *
 * Dengan loader ini:
 *   - Server start tanpa memuat Playwright sama sekali.
 *   - VPS ringan: `npm ci --omit=optional` boleh melewatkan Playwright.
 *   - Fitur browser tetap jalan selama `npm i playwright` + `npx playwright install chromium`.
 */

import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

let _chromium = null;
let _missing = null;

/** True bila paket playwright terpasang (tanpa memuat modulnya). */
export function isPlaywrightInstalled() {
  if (_chromium) return true;
  if (_missing) return false;
  try {
    _require.resolve('playwright');
    return true;
  } catch {
    _missing = true;
    return false;
  }
}

const INSTALL_HINT =
  'Playwright belum terpasang (fitur browser dinonaktifkan untuk versi ringan). ' +
  'Aktifkan dengan: npm i playwright && npx playwright install --with-deps chromium';

/** Ambil API `chromium` Playwright (dimuat sekali, hanya saat dipakai). */
export async function getChromium() {
  if (_chromium) return _chromium;
  if (_missing) throw Object.assign(new Error(INSTALL_HINT), { code: 'PLAYWRIGHT_MISSING' });
  try {
    const mod = await import('playwright');
    _chromium = mod.chromium;
    if (!_chromium) throw new Error('chromium export tidak ditemukan');
    return _chromium;
  } catch (err) {
    if (err?.code === 'PLAYWRIGHT_MISSING') throw err;
    _missing = true;
    throw Object.assign(new Error(`${INSTALL_HINT} (${err.message})`), { code: 'PLAYWRIGHT_MISSING' });
  }
}

/** Ambil `createWorker` tesseract.js (OCR) hanya saat dibutuhkan. */
export async function getTesseract() {
  try {
    const mod = await import('tesseract.js');
    const createWorker = mod.createWorker || mod.default?.createWorker;
    if (typeof createWorker !== 'function') throw new Error('createWorker tidak ditemukan');
    return { createWorker };
  } catch (err) {
    throw Object.assign(
      new Error(`tesseract.js belum terpasang (OCR nonaktif). Aktifkan: npm i tesseract.js (${err.message})`),
      { code: 'TESSERACT_MISSING' }
    );
  }
}

/** True bila dukungan OCR tersedia. */
export function isOcrAvailable() {
  try {
    _require.resolve('tesseract.js');
    return true;
  } catch {
    return false;
  }
}

export default { getChromium, isPlaywrightInstalled, getTesseract, isOcrAvailable };
