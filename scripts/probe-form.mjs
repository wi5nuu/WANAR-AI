#!/usr/bin/env node
/**
 * Membuka halaman lamaran dan mencetak struktur formulirnya (label, jenis, wajib/tidak, pilihan).
 * HANYA MEMBACA: tidak mengisi dan tidak mengirim apa pun. Dipakai untuk mempelajari bentuk formulir
 * nyata sebelum menulis/menguji mesin lamaran.
 *
 *   node scripts/probe-form.mjs <url> [--shot out.png]
 */
import { chromium } from 'playwright';

const url = process.argv[2];
const shotIdx = process.argv.indexOf('--shot');
const shot = shotIdx > 0 ? process.argv[shotIdx + 1] : null;
if (!url) { console.error('Pakai: node scripts/probe-form.mjs <url> [--shot out.png]'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1800 }, locale: 'en-US' });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(3500);

const controls = await page.evaluate(() => {
  const txt = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => {
    const out = [];
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) out.push(txt(l)); }
    const wrap = el.closest('label'); if (wrap) out.push(txt(wrap));
    const lb = el.getAttribute('aria-labelledby');
    if (lb) out.push(lb.split(/\s+/).map((i) => txt(document.getElementById(i))).join(' '));
    if (el.getAttribute('aria-label')) out.push(el.getAttribute('aria-label'));
    const fs = el.closest('fieldset'); if (fs?.querySelector('legend')) out.push(txt(fs.querySelector('legend')));
    if (el.placeholder) out.push(`[ph] ${el.placeholder}`);
    return [...new Set(out.filter(Boolean))].join(' | ').slice(0, 220);
  };
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && (r.width > 0 || el.type === 'file' || el.type === 'checkbox' || el.type === 'radio'); };
  return [...document.querySelectorAll('input, select, textarea, [role="combobox"]')]
    .filter((el) => el.type !== 'hidden' && vis(el))
    .map((el) => ({
      tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', id: el.id || '', name: el.name || '',
      req: el.required || el.getAttribute('aria-required') === 'true',
      label: labelOf(el),
      options: el.tagName === 'SELECT' ? [...el.options].slice(0, 8).map((o) => o.text.trim()) : undefined,
    }));
});

console.log(`URL akhir: ${page.url()}`);
console.log(`judul: ${await page.title()}`);
console.log(`jumlah kontrol: ${controls.length}`);
const captcha = await page.evaluate(() => !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha, [data-sitekey], iframe[src*="turnstile"]'));
console.log(`CAPTCHA terlihat: ${captcha}`);
for (const c of controls) {
  console.log(`${c.req ? '*' : ' '} ${c.tag}/${c.type}`.padEnd(22), `id=${c.id || '-'}`.padEnd(30), `${c.label || '(tanpa label)'}${c.options ? `  opsi: ${c.options.join(' / ')}` : ''}`);
}
const submit = await page.evaluate(() => [...document.querySelectorAll('button, input[type=submit]')].map((b) => (b.innerText || b.value || '').trim()).filter((t) => /submit|apply|kirim|send/i.test(t)).slice(0, 4));
console.log(`tombol kirim: ${JSON.stringify(submit)}`);
if (shot) await page.screenshot({ path: shot, fullPage: true });
await browser.close();
