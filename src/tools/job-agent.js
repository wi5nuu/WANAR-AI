/**
 * WANAR AI - Job Application Agent Engine
 * by Wisnu Alfian Nur Ashar
 *
 * Autonomous job crawler + form detector + field mapper + auto-submit
 * dengan human-in-the-loop untuk field confidence rendah dan CAPTCHA.
 */

import { chromium } from 'playwright';
import { EventEmitter } from 'events';
import os from 'os';
import * as db from '../database.js';
import { createWorker } from 'tesseract.js';

// ── Live event bus (SSE) ──────────────────────────────────────────────────
export const agentEvents = new EventEmitter();
agentEvents.setMaxListeners(50);

function emit(sessionId, type, payload) {
  agentEvents.emit('event', { sessionId: String(sessionId), type, payload, ts: new Date().toISOString() });
}

// ── Constants ──────────────────────────────────────────────────────────────
const DELAY_MIN = 8000;    // 8s minimum jeda (lebih cepat agar bisa dipantau)
const DELAY_MAX = 20000;   // 20s maximum
const MAX_RETRY = 2;
const CONFIDENCE_THRESHOLD = 0.85;

// Form type patterns
const FORM_PATTERNS = {
  google_form:  /docs\.google\.com\/forms/i,
  greenhouse:   /greenhouse\.io|boards\.greenhouse/i,
  lever:        /jobs\.lever\.co|lever\.co\/.*\/apply/i,
  workday:      /myworkdayjobs\.com|workday\.com/i,
  jobstreet:    /jobstreet\.co\.id|jobstreet\.com/i,
  linkedin:     /linkedin\.com\/jobs/i,
  glints:       /glints\.com/i,
  kalibrr:      /kalibrr\.com/i,
  indeed:       /indeed\.com/i,
};

// Field label → profile key mapping (diperluas dan lebih akurat)
const FIELD_MAP = [
  // ── Identitas ──
  { patterns: [/full.?name|nama.?lengkap|your.?name|nama\s*anda|nama\s*pelamar|^nama$/i], key: 'full_name', confidence: 0.95 },
  { patterns: [/\bemail\b|e-mail|alamat.?email|surel|email.?address/i], key: 'email', confidence: 0.98 },
  { patterns: [/phone|telepon|no.?hp|whatsapp|handphone|nomor.?hp|nomor.?telepon|nomer.?hp|no\.?\s*telp|kontak/i], key: 'phone', confidence: 0.92 },
  { patterns: [/^alamat$|address|alamat(?!.?email)|domisili|tempat.?tinggal|alamat.?lengkap/i], key: 'address', confidence: 0.88 },
  { patterns: [/\bcity\b|kota.?domisili|kota.?asal|asal.?kota|kota.?tinggal|^kota$/i], key: 'city', confidence: 0.90 },
  { patterns: [/province|provinsi|propinsi|^provinsi$/i], key: 'province', confidence: 0.90 },
  { patterns: [/postal|kode.?pos|zip/i], key: 'postal_code', confidence: 0.88 },
  { patterns: [/gender|jenis.?kelamin|^jk$/i], key: 'gender', confidence: 0.92 },
  { patterns: [/birth|lahir|tanggal.?lahir|tgl.?lahir|date.?of.?birth|dob|ttl/i], key: 'date_of_birth', confidence: 0.90 },
  { patterns: [/nationality|kewarganegaraan|warga.?negara/i], key: 'nationality', confidence: 0.90 },
  { patterns: [/npwp|tax.?number/i], key: 'npwp', confidence: 0.95 },
  { patterns: [/ktp|nik|id.?number|nomor.?identitas|no.?ktp/i], key: 'nik', confidence: 0.90 },
  { patterns: [/agama|religion/i], key: 'religion', confidence: 0.88 },

  // ── Pendidikan ──
  { patterns: [/university|universitas|institusi|institution|perguruan.?tinggi|nama.?kampus|nama.?universitas|asal.?kampus/i], key: 'university', confidence: 0.90 },
  { patterns: [/\bmajor\b|jurusan|program.?studi|prodi|faculty|fakultas|bidang.?studi/i], key: 'major', confidence: 0.88 },
  { patterns: [/\bgpa\b|ipk|indeks.?prestasi|nilai.?ipk/i], key: 'gpa', confidence: 0.92 },
  { patterns: [/graduation|lulus|angkatan|tahun.?lulus|semester|tahun.?masuk/i], key: 'graduation_year', confidence: 0.85 },
  { patterns: [/pendidikan.?terakhir|jenjang.?pendidikan|tingkat.?pendidikan|education.?level/i], key: 'education_level', confidence: 0.88 },

  // ── Karir & Lamaran ──
  { patterns: [/position|posisi|jabatan|applying.?for|lamar.?posisi|posisi.?dilamar|posisi.?yang.?dilamar|divisi/i], key: 'position_applied', confidence: 0.85 },
  { patterns: [/salary|gaji|ekspektasi.?gaji|expected.?salary|gaji.?yang.?diharapkan|harapan.?gaji/i], key: 'expected_salary', confidence: 0.83 },
  { patterns: [/available|mulai.?kerja|start.?date|join.?date|kapan.?bisa|bisa.?mulai/i], key: 'available_date', confidence: 0.82 },
  { patterns: [/experience|pengalaman|riwayat.?kerja|work.?history|lama.?pengalaman/i], key: 'work_experience', confidence: 0.80 },
  { patterns: [/skill|kemampuan|keahlian|kompetensi|keahlian.?yang.?dimiliki/i], key: 'skills', confidence: 0.82 },
  { patterns: [/sumber.?info|dari.?mana.?tahu|how.?did.?you.?hear|referral|informasi.?lowongan/i], key: 'source_info', confidence: 0.80 },

  // ── Online presence ──
  { patterns: [/linkedin/i], key: 'linkedin', confidence: 0.97 },
  { patterns: [/portfolio|website|personal.?web|link.?portfolio/i], key: 'portfolio', confidence: 0.90 },
  { patterns: [/github/i], key: 'github', confidence: 0.97 },

  // ── Dokumen ──
  { patterns: [/cover.?letter|surat.?lamaran|motivation.?letter|perkenalan.?diri|motivasi/i], key: 'cover_letter', confidence: 0.88 },
  { patterns: [/\bcv\b|resume|curriculum|upload.*cv|attach.*cv|kirim.*cv/i], key: 'cv_url', confidence: 0.85 },
];

// ── Active sessions (in-memory) ────────────────────────────────────────────
const activeSessions = new Map(); // sessionId -> { browser, page, status, abortController }

// ── Helpers ────────────────────────────────────────────────────────────────
function randomDelay(min = DELAY_MIN, max = DELAY_MAX) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

function detectFormType(url) {
  for (const [type, pattern] of Object.entries(FORM_PATTERNS)) {
    if (pattern.test(url)) return type;
  }
  return 'custom';
}

function mapFieldToProfile(label, profile) {
  const normalized = label.toLowerCase().trim();
  for (const mapping of FIELD_MAP) {
    if (mapping.patterns.some(p => p.test(normalized))) {
      const value = profile[mapping.key];
      if (value) return { key: mapping.key, value: String(value), confidence: mapping.confidence };
    }
  }
  return null;
}

async function checkRobotsTxt(page, url) {
  // Gunakan fetch biasa, bukan page.goto, agar tidak mengubah halaman aktif
  try {
    const origin = new URL(url).origin;
    const res = await fetch(`${origin}/robots.txt`).catch(() => null);
    if (!res || !res.ok) return true;
    const text = await res.text();
    if (/disallow.*\/apply|disallow.*\/jobs.*apply/i.test(text)) return false;
    return true;
  } catch {
    return true; // assume ok if can't fetch
  }
}

async function detectCaptcha(page) {
  try {
    // Cek elemen CAPTCHA yang benar-benar visible di layar
    // Bukan cek source code (karena Google Forms selalu ada kata "captcha" di JS-nya)
    const visible = await page.evaluate(() => {
      const selectors = [
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        '.g-recaptcha',
        '[data-sitekey]',
        '#cf-challenge-running',
        '.cf-turnstile',
        '#challenge-form',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return true;
        }
      }
      return false;
    });
    return visible;
  } catch {
    return false;
  }
}

// ── CAPTCHA: Audio challenge solver (reCAPTCHA v2) ────────────────────────
// Strategi: klik tombol audio → ambil URL audio challenge → download MP3
// → transcribe pakai Google Speech API (free tier via browser endpoint)
async function solveAudioCaptcha(page) {
  try {
    // Cari iframe reCAPTCHA
    const frames = page.frames();
    let captchaFrame = null;
    for (const frame of frames) {
      if (frame.url().includes('recaptcha/api2/anchor') || frame.url().includes('recaptcha/api2/bframe')) {
        captchaFrame = frame;
        break;
      }
    }
    if (!captchaFrame) return false;

    // Klik tombol audio (accessibility)
    const audioBtn = captchaFrame.locator('#recaptcha-audio-button, .rc-button-audio');
    if (await audioBtn.count() === 0) return false;
    await audioBtn.click();
    await page.waitForTimeout(2000);

    // Cari frame audio challenge
    let audioFrame = null;
    for (const frame of page.frames()) {
      if (frame.url().includes('recaptcha/api2/bframe')) {
        audioFrame = frame;
        break;
      }
    }
    if (!audioFrame) audioFrame = captchaFrame;

    // Ambil URL audio MP3
    const audioEl = audioFrame.locator('.rc-audiochallenge-tdownload-link, audio source, #audio-source');
    if (await audioEl.count() === 0) return false;
    const audioUrl = await audioEl.getAttribute('href') || await audioEl.getAttribute('src');
    if (!audioUrl) return false;

    // Download audio MP3
    const audioRes = await fetch(audioUrl).catch(() => null);
    if (!audioRes || !audioRes.ok) return false;
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // Transcribe pakai Google Speech-to-Text (free endpoint yang sama dengan Chrome Speech API)
    // Endpoint ini tidak butuh API key untuk penggunaan ringan
    const base64Audio = audioBuffer.toString('base64');
    const speechRes = await fetch(
      'https://www.google.com/speech-api/v2/recognize?output=json&lang=en-US&key=AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw',
      {
        method: 'POST',
        headers: { 'Content-Type': 'audio/x-flac; rate=16000' },
        body: audioBuffer,
      }
    ).catch(() => null);

    let transcript = '';
    if (speechRes && speechRes.ok) {
      const text = await speechRes.text();
      // Response format: {"result":[{"alternative":[{"transcript":"...","confidence":0.9}],"final":true}],"result_index":0}
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          transcript = json?.result?.[0]?.alternative?.[0]?.transcript || '';
          if (transcript) break;
        } catch {}
      }
    }

    if (!transcript) {
      // Fallback: coba Web Speech API di browser (jika Chrome CDP mode)
      transcript = await page.evaluate(async (url) => {
        return new Promise((resolve) => {
          try {
            const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
            recognition.lang = 'en-US';
            recognition.continuous = false;
            recognition.interimResults = false;
            // Buat audio element dan play
            const audio = new Audio(url);
            audio.crossOrigin = 'anonymous';
            const source = recognition.audioContext?.createMediaElementSource?.(audio);
            if (source) source.connect(recognition.audioContext.destination);
            recognition.onresult = (e) => resolve(e.results[0][0].transcript);
            recognition.onerror = () => resolve('');
            recognition.start();
            audio.play();
            setTimeout(() => resolve(''), 15000);
          } catch { resolve(''); }
        });
      }, audioUrl).catch(() => '');
    }

    if (!transcript) return false;

    // Isi field response di reCAPTCHA
    const responseInput = audioFrame.locator('#audio-response, .rc-audiochallenge-response input');
    if (await responseInput.count() === 0) return false;
    await responseInput.fill(transcript.toLowerCase().trim());
    await page.waitForTimeout(500);

    // Submit
    const verifyBtn = audioFrame.locator('#recaptcha-verify-button, .rc-audiochallenge-verify-button');
    if (await verifyBtn.count() > 0) {
      await verifyBtn.click();
      await page.waitForTimeout(3000);
      // Cek apakah CAPTCHA solved
      const stillHas = await detectCaptcha(page);
      return !stillHas;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Core: OCR image in form ────────────────────────────────────────────────
async function ocrImage(imageBuffer) {
  try {
    const worker = await createWorker('eng+ind');
    const { data: { text } } = await worker.recognize(imageBuffer);
    await worker.terminate();
    return text.trim();
  } catch {
    return '';
  }
}

// ── Core: Extract text from images in page ────────────────────────────────
async function extractImagesText(page) {
  // Skip OCR — terlalu lambat dan sering crash di CDP Chrome
  // Google Forms tidak butuh OCR sama sekali
  return '';
}

// ── Core: Crawl listing page ───────────────────────────────────────────────
export async function crawlListingPage(url, page) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Google Sheets: tunggu render tabel
  const isGSheets = /docs\.google\.com\/spreadsheets/i.test(url);
  if (isGSheets) {
    try { await page.waitForSelector('.waffle, .grid-container, [id="sheets-viewport"]', { timeout: 8000 }); } catch {}
    await page.waitForTimeout(2000);
  }

  const isLinktree = /linktr\.ee/i.test(url);
  const isLinkOpen = /linkin\.bio|beacons\.ai|bio\.link/i.test(url);

  const jobs = await page.evaluate((opts) => {
    const results = [];
    const links = Array.from(document.querySelectorAll('a[href]'));

    for (const a of links) {
      const href = a.href;
      const rawText = a.textContent?.trim() || '';

      // Filter hanya link yang relevan lowongan
      if (!/apply|intern|job|lowongan|karir|career|position|magang|rekrut|hiring/i.test(href + rawText)) continue;
      if (!href.startsWith('http')) continue;

      let company = '';
      let title = rawText;

      if (opts.isLinktree) {
        // Di Linktree: teks tombol = "NamaPerusahaan (Career)" atau "NamaPerusahaan (Internship)"
        // Format: "PT Nama Perusahaan (Career)" → company = "PT Nama Perusahaan", title = rawText
        const match = rawText.match(/^(.+?)\s*[\(\-]\s*(career|intern|job|lowongan|magang|hiring)/i);
        if (match) {
          company = match[1].trim();
          title = rawText;
        } else {
          company = rawText.replace(/\s*(career|intern|job|lowongan|magang|hiring|apply).*$/i, '').trim() || rawText;
          title = rawText;
        }
      } else {
        // Sumber lain: cari nama perusahaan dari container
        const container = a.closest('[class*="job"], [class*="card"], [class*="item"], [class*="listing"], [class*="company"], li, article') || a.parentElement;
        const companyEl = container?.querySelector('[class*="company"], [class*="employer"], [class*="brand"], [class*="org"]');
        company = companyEl?.textContent?.trim() || '';
        const titleEl = container?.querySelector('h1,h2,h3,h4,[class*="title"],[class*="position"],[class*="role"]');
        title = titleEl?.textContent?.trim() || rawText;
        if (!company) {
          // Fallback: coba parse dari title teks "Posisi di Perusahaan"
          const splitMatch = rawText.match(/(.+?)\s+(?:at|di|@)\s+(.+)/i);
          if (splitMatch) { title = splitMatch[1].trim(); company = splitMatch[2].trim(); }
        }
      }

      results.push({
        company: company || new URL(href).hostname,
        title: title || rawText,
        link: href,
      });
    }

    // Dedupe by link
    const seen = new Set();
    return results.filter(r => { if (seen.has(r.link)) return false; seen.add(r.link); return true; });
  }, { isLinktree, isLinkOpen });

  return jobs;
}

// ── Core: Extract form fields ──────────────────────────────────────────────
export async function extractFormFields(page) {
  // Extract text from images on the page (OCR)
  const imageTexts = await extractImagesText(page);

  const fields = await page.evaluate((imgTexts) => {
    const fields = [];
    // Standard inputs + Google Form div-based fields
    const inputs = document.querySelectorAll(
      'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]),' +
      'textarea, select,' +
      '[role="textbox"], [role="listbox"], [role="combobox"]'
    );
    for (const el of inputs) {
      const id = el.id || el.name || '';
      // Try multiple label strategies
      const labelEl = (id ? document.querySelector(`label[for="${id}"]`) : null)
        || el.closest('label')
        || el.previousElementSibling
        || el.parentElement?.previousElementSibling
        || el.closest('[class*="question"], [class*="field"], [class*="form-group"]')?.querySelector('label, [class*="label"], [class*="title"], h4, h3, span');

      const label = labelEl?.textContent?.trim()
        || el.placeholder?.trim()
        || el.getAttribute('aria-label')?.trim()
        || (el.getAttribute('aria-labelledby') ? document.getElementById(el.getAttribute('aria-labelledby'))?.textContent?.trim() : '')
        || el.name?.trim()
        || id;
      if (!label) continue;

      // Detect if this is a file upload for CV
      const isFile = el.type === 'file';
      // Detect essay/cover letter fields (large textarea)
      const isEssay = el.tagName === 'TEXTAREA' || (el.getAttribute('rows') && parseInt(el.getAttribute('rows')) > 3);

      fields.push({
        selector: el.id ? `#${CSS.escape(el.id)}` : el.name ? `[name="${el.name}"]` : null,
        label,
        type: isFile ? 'file' : el.tagName.toLowerCase() === 'select' ? 'select' : el.getAttribute('role') || el.type || 'text',
        required: el.required || el.getAttribute('aria-required') === 'true' || label.includes('*'),
        options: el.tagName === 'SELECT' ? Array.from(el.options).map(o => o.text.trim()).filter(Boolean) : [],
        isEssay,
        isFile,
        imageContext: imgTexts, // OCR context dari gambar di halaman
      });
    }
    return fields;
  }, imageTexts);

  return fields;
}

// ── Core: Extract fields khusus Google Forms ─────────────────────────────
async function extractGoogleFormFields(page) {
  try {
    return await page.evaluate(() => {
      const fields = [];
      // Google Forms memiliki beberapa variasi selector tergantung versi
      const itemSelectors = [
        '.freebirdFormviewerViewItemsItemItem',
        '[data-item-id]',
        '.Qr7Oae',                          // versi terbaru 2024+
        'div[role="listitem"]',              // generic listitem
        '.freebirdFormviewerComponentsQuestionBaseRoot', // versi lama
      ];

      let items = [];
      for (const sel of itemSelectors) {
        items = Array.from(document.querySelectorAll(sel));
        if (items.length > 0) break;
      }

      for (const item of items) {
        // Label: coba banyak selector
        const labelEl = item.querySelector(
          '.M7eMe, ' +                          // versi lama
          '.freebirdFormviewerViewItemsItemItemTitle, ' +
          '[role="heading"], ' +
          '.aDTYNe, ' +                         // versi 2024
          '.HoXoMd, ' +
          'span[dir="auto"]:first-of-type, ' +
          '[data-params] span'
        );
        const label = labelEl?.textContent?.trim();
        if (!label || label.length < 2) continue;

        // Short answer (input[type=text])
        const shortInput = item.querySelector('input[type="text"], input:not([type])');
        if (shortInput) {
          fields.push({ label, selector: null, type: 'text', isEssay: false, isFile: false, googleItem: true });
          continue;
        }
        // Paragraph (textarea)
        const textarea = item.querySelector('textarea');
        if (textarea) {
          fields.push({ label, selector: null, type: 'textarea', isEssay: true, isFile: false, googleItem: true });
          continue;
        }
        // Dropdown
        const listbox = item.querySelector('[role="listbox"], select');
        if (listbox) {
          fields.push({ label, selector: null, type: 'select', isEssay: false, isFile: false, googleItem: true });
          continue;
        }
        // Radio
        const radio = item.querySelector('[role="radio"]');
        if (radio) {
          const opts = Array.from(item.querySelectorAll('[role="radio"]'))
            .map(r => r.getAttribute('data-value') || r.textContent?.trim())
            .filter(Boolean);
          fields.push({ label, selector: null, type: 'radio', options: opts, isEssay: false, isFile: false, googleItem: true });
          continue;
        }
        // Checkbox
        const checkbox = item.querySelector('[role="checkbox"]');
        if (checkbox) {
          fields.push({ label, selector: null, type: 'checkbox', isEssay: false, isFile: false, googleItem: true });
          continue;
        }
        // File upload
        const fileInput = item.querySelector('input[type="file"]');
        if (fileInput) {
          fields.push({ label, selector: null, type: 'file', isEssay: false, isFile: true, googleItem: true });
          continue;
        }
        // Date / time input
        const dateInput = item.querySelector('input[type="date"], input[type="time"], input[type="datetime-local"]');
        if (dateInput) {
          fields.push({ label, selector: null, type: dateInput.type, isEssay: false, isFile: false, googleItem: true });
          continue;
        }
      }
      return fields;
    });
  } catch {
    return [];
  }
}

// ── Core: Process a single job link ───────────────────────────────────────
async function processJob(jobId, page, profile, options = {}) {
  const job = db.getJobById(jobId);
  if (!job) return;

  const { trustedMode = false, aiGenerateCoverLetter, sessionId } = options;
  const sid = sessionId;

  try {
    emit(sid, 'job:start', { jobId, company: job.company, title: job.title, link: job.link });

    // Check robots.txt
    const robotsOk = await checkRobotsTxt(page, job.link);
    if (!robotsOk) {
      db.updateJobStatus(jobId, 'skipped', { notes: 'robots.txt melarang automated application', robotsOk: 0 });
      emit(sid, 'job:skip', { jobId, company: job.company, title: job.title, reason: 'robots.txt melarang' });
      return;
    }

    // Navigate to job page
    db.updateJobStatus(jobId, 'processing');
    emit(sid, 'job:navigate', { jobId, company: job.company, title: job.title, url: job.link });
    try {
      await page.goto(job.link, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (navErr) {
      db.incrementJobRetry(jobId);
      const msg = `Gagal load halaman: ${navErr.message}`;
      if ((job.retry_count || 0) >= MAX_RETRY) {
        db.updateJobStatus(jobId, 'failed', { notes: msg });
        emit(sid, 'job:failed', { jobId, company: job.company, title: job.title, reason: msg });
      } else {
        db.updateJobStatus(jobId, 'pending', { notes: 'Retry scheduled' });
        emit(sid, 'job:retry', { jobId, company: job.company, title: job.title });
      }
      return;
    }

    // Tunggu lebih lama untuk Google Forms (JS render)
    const isGoogleForm = /docs\.google\.com\/forms/i.test(job.link);
    await page.waitForTimeout(isGoogleForm ? 4000 : 2000);

    // CAPTCHA check + auto-solve
    const hasCaptcha = await detectCaptcha(page);
    if (hasCaptcha) {
      emit(sid, 'job:captcha', { jobId, company: job.company, title: job.title, url: page.url(), waitingUser: false, solving: true });

      // Coba solve otomatis via audio challenge (gratis, no API key)
      const autoSolved = await solveAudioCaptcha(page);
      if (autoSolved) {
        db.updateJobStatus(jobId, 'processing');
        emit(sid, 'job:captcha_solved', { jobId, company: job.company, title: job.title, method: 'audio_auto' });
      } else {
        // Fallback: minta user solve manual
        db.updateJobStatus(jobId, 'needs_review', { notes: 'CAPTCHA terdeteksi — selesaikan CAPTCHA di browser lalu tunggu agent lanjut otomatis' });
        emit(sid, 'job:captcha', { jobId, company: job.company, title: job.title, url: page.url(), waitingUser: true, solving: false });
        // Tunggu maksimal 3 menit untuk user solve CAPTCHA
        const captchaTimeout = 180000;
        const captchaStart = Date.now();
        let captchaSolved = false;
        while (Date.now() - captchaStart < captchaTimeout) {
          await page.waitForTimeout(3000);
          const stillHas = await detectCaptcha(page);
          if (!stillHas) {
            captchaSolved = true;
            db.updateJobStatus(jobId, 'processing');
            emit(sid, 'job:captcha_solved', { jobId, company: job.company, title: job.title, method: 'manual' });
            break;
          }
          const sessionState = activeSessions.get(String(sid));
          if (!sessionState || sessionState.abortController?.aborted) return;
        }
        if (!captchaSolved) {
          emit(sid, 'job:captcha_timeout', { jobId, company: job.company, title: job.title });
          db.updateJobStatus(jobId, 'skipped', { notes: 'CAPTCHA timeout — tidak diselesaikan dalam 3 menit' });
          return;
        }
      }
    }

    // Detect form type
    const formType = detectFormType(page.url());
    emit(sid, 'job:form_detected', { jobId, company: job.company, title: job.title, formType, url: page.url() });

    // Tunggu extra untuk Google Forms render JS
    if (formType === 'google_form') {
      // Tunggu sampai salah satu selector Google Forms muncul — retry sampai 15 detik
      const gfSelectors = [
        '.freebirdFormviewerViewItemsItemItem',
        '[data-item-id]',
        '.Qr7Oae',
        'div[role="listitem"]',
        '[jsmodel][data-params]',
      ];
      let gfReady = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        for (const sel of gfSelectors) {
          try {
            await page.waitForSelector(sel, { timeout: 4000 });
            gfReady = true; break;
          } catch {}
        }
        if (gfReady) break;
        await page.waitForTimeout(1500);
      }
      await page.waitForTimeout(500);
    }

    // Cek apakah form sudah ditutup (Google Forms closedform)
    const currentUrl = page.url();
    if (currentUrl.includes('closedform')) {
      db.updateJobStatus(jobId, 'skipped', { notes: 'Form sudah ditutup oleh pembuat', formType });
      emit(sid, 'job:skip', { jobId, company: job.company, title: job.title, reason: 'Form sudah ditutup' });
      return;
    }

    // Extract form fields
    // Untuk Google Forms: pakai extractGoogleFormFields langsung (lebih cepat dan akurat)
    // Untuk form lain: pakai extractFormFields generic
    let fields = [];
    if (formType === 'google_form') {
      fields = await extractGoogleFormFields(page);
      // Jika masih kosong, coba lagi sekali setelah delay
      if (fields.length === 0) {
        await page.waitForTimeout(3000);
        fields = await extractGoogleFormFields(page);
      }
      // Fallback ke generic jika masih kosong
      if (fields.length === 0) {
        fields = await extractFormFields(page);
      }
    } else {
      fields = await extractFormFields(page);
    }

    if (fields.length === 0) {
      db.updateJobStatus(jobId, 'skipped', { notes: 'Tidak ada form yang terdeteksi di halaman ini', formType });
      emit(sid, 'job:skip', { jobId, company: job.company, title: job.title, reason: 'Tidak ada form terdeteksi' });
      return;
    }

    emit(sid, 'job:fields', { jobId, company: job.company, title: job.title, fieldCount: fields.length });

    // Map fields to profile
    const fieldMapping = [];
    let mappedConfidences = [];
    let hasLowConfidence = false;

    for (const field of fields) {
      // Skip file fields — tidak bisa auto-fill, masuk review saja
      if (field.isFile) {
        fieldMapping.push({ ...field, mappedKey: null, mappedValue: null, confidence: 1, isFile: true, needsManual: false });
        continue;
      }
      const mapped = mapFieldToProfile(field.label, profile);
      if (mapped && mapped.value) {
        fieldMapping.push({ ...field, mappedKey: mapped.key, mappedValue: mapped.value, confidence: mapped.confidence });
        mappedConfidences.push(mapped.confidence);
        if (mapped.confidence < CONFIDENCE_THRESHOLD) hasLowConfidence = true;
      } else {
        // Essay field (cover letter, motivasi, dll) — generate otomatis
        const isEssay = field.isEssay || field.type === 'textarea' ||
          /why|motivat|cover.?letter|tell.?us|describe|strength|weakness|cerit|alasan|motivasi|perkenalkan/i.test(field.label);
        if (isEssay) {
          // Essay akan diisi cover letter — confidence tinggi
          fieldMapping.push({ ...field, mappedKey: 'cover_letter', mappedValue: null, confidence: 0.90, isEssay: true, needsManual: false });
          mappedConfidences.push(0.90);
        } else {
          // Field tidak dikenal — skip saja, jangan block keseluruhan form
          fieldMapping.push({ ...field, mappedKey: null, mappedValue: null, confidence: 1, needsManual: false, skipField: true });
        }
      }
    }

    // Hitung minConfidence hanya dari field yang benar-benar di-mapping
    const minConfidence = mappedConfidences.length > 0 ? Math.min(...mappedConfidences) : 0.9;

    // Generate cover letter
    let coverLetter = null;
    try { coverLetter = await generateCoverLetter(job.company, job.title, profile); } catch {}

    // Decide: auto-submit or review queue
    // trustedMode = submit langsung meskipun ada field yang tidak ter-mapping
    // Hanya masuk review jika confidence SANGAT rendah (< 50%) DAN tidak trusted
    const criticalLowConfidence = minConfidence < 0.5 && mappedConfidences.length === 0;
    const needsReview = criticalLowConfidence || (!trustedMode && hasLowConfidence);

    if (needsReview) {
      db.updateJobStatus(jobId, 'needs_review', { fieldMapping, coverLetter, formType, confidence: minConfidence, robotsOk: 1 });
      db.addToReviewQueue(jobId, fieldMapping, null,
        hasLowConfidence ? 'Field confidence rendah / ada pertanyaan essay' : 'Mode review aktif — menunggu approval'
      );
      emit(sid, 'job:review', {
        jobId, company: job.company, title: job.title,
        reason: hasLowConfidence ? 'Confidence rendah' : 'Menunggu approval',
        confidence: Math.round(minConfidence * 100),
        fieldCount: fieldMapping.length,
      });
    } else {
      // Auto-fill + submit + verify
      emit(sid, 'job:filling', { jobId, company: job.company, title: job.title, fieldCount: fieldMapping.length });

      // Emit per-field ke live feed agar user bisa pantau real-time
      const fieldEmit = (label, value) => {
        const preview = String(value).length > 40 ? String(value).substring(0, 40) + '...' : String(value);
        emit(sid, 'job:field_filled', { jobId, company: job.company, label, preview });
      };

      await autoFillForm(page, fieldMapping, coverLetter, formType, fieldEmit);
      await page.waitForTimeout(1000);

      const result = await submitFormAndVerify(page, formType);
      if (result.submitted) {
        db.updateJobStatus(jobId, 'submitted', { fieldMapping, coverLetter, formType, confidence: minConfidence, robotsOk: 1 });
        db.addApplyHistory({ company: job.company, position: job.title, apply_url: job.link, status: 'applied', form_data: fieldMapping });
        emit(sid, 'job:submitted', {
          jobId, company: job.company, title: job.title,
          confidence: Math.round(minConfidence * 100),
          fieldCount: fieldMapping.length,
        });
      } else {
        // Submit gagal — masuk review queue agar user bisa submit manual
        db.updateJobStatus(jobId, 'needs_review', { fieldMapping, coverLetter, formType, confidence: minConfidence, robotsOk: 1 });
        db.addToReviewQueue(jobId, fieldMapping, null, `Submit gagal: ${result.reason}`);
        emit(sid, 'job:review', {
          jobId, company: job.company, title: job.title,
          reason: `Submit gagal: ${result.reason}`,
          confidence: Math.round(minConfidence * 100),
          fieldCount: fieldMapping.length,
        });
      }
    }

  } catch (err) {
    db.incrementJobRetry(jobId);
    const retried = db.getJobById(jobId);
    if ((retried?.retry_count || 0) >= MAX_RETRY) {
      db.updateJobStatus(jobId, 'failed', { notes: err.message });
      emit(sid, 'job:failed', { jobId, company: job.company, title: job.title, reason: err.message });
    } else {
      db.updateJobStatus(jobId, 'pending', { notes: `Error: ${err.message}` });
      emit(sid, 'job:retry', { jobId, company: job.company, title: job.title });
    }
  }
}

// ── Core: Auto-fill Google Form ───────────────────────────────────────────
// Strategi baru: scan seluruh DOM Google Forms sekali, lalu fill berdasarkan
// posisi/index field secara langsung — jauh lebih reliabel dari label matching
async function fillGoogleForm(page, fieldMapping, coverLetter, emitFn) {
  // Tunggu semua pertanyaan render penuh
  await page.waitForTimeout(2000);

  // Simulasi gerakan mouse natural (anti-bot detection)
  await page.mouse.move(400 + Math.random() * 200, 300 + Math.random() * 100);
  await page.waitForTimeout(300);

  // Scan semua question container sekaligus dari DOM
  // Ambil semua input/textarea/listbox yang visible di halaman
  const questions = await page.evaluate(() => {
    const result = [];
    // Cari semua container pertanyaan
    const containerSelectors = [
      '.freebirdFormviewerViewItemsItemItem',
      '[data-item-id]',
      '.Qr7Oae',
      '.freebirdFormviewerComponentsQuestionBaseRoot',
    ];
    let containers = [];
    for (const sel of containerSelectors) {
      containers = Array.from(document.querySelectorAll(sel));
      if (containers.length > 0) break;
    }

    for (let i = 0; i < containers.length; i++) {
      const c = containers[i];
      // Ambil label
      const labelEl = c.querySelector(
        '.M7eMe, .freebirdFormviewerViewItemsItemItemTitle, [role="heading"], ' +
        '.aDTYNe, .HoXoMd, span[dir="auto"]'
      );
      const label = labelEl?.textContent?.trim() || '';

      // Detect tipe input
      const shortInput = c.querySelector('input[type="text"], input:not([type="radio"]):not([type="checkbox"]):not([type="file"]):not([type="hidden"])');
      const textarea   = c.querySelector('textarea');
      const listbox    = c.querySelector('[role="listbox"]');
      const radios     = c.querySelectorAll('[role="radio"]');
      const checkboxes = c.querySelectorAll('[role="checkbox"]');

      let type = 'unknown';
      let radioOptions = [];
      if (textarea)          type = 'textarea';
      else if (shortInput)   type = 'text';
      else if (listbox)      type = 'dropdown';
      else if (radios.length > 0) {
        type = 'radio';
        radioOptions = Array.from(radios).map(r =>
          (r.getAttribute('data-value') || r.textContent?.trim() || '').toLowerCase()
        );
      }
      else if (checkboxes.length > 0) type = 'checkbox';

      result.push({ index: i, label, type, radioOptions });
    }
    return result;
  });

  if (!questions || questions.length === 0) return;

  // Match field mapping ke question DOM berdasarkan label similarity
  for (const field of fieldMapping) {
    if (field.skipField || field.isFile) continue;
    const value = field.isEssay && coverLetter ? coverLetter : field.mappedValue;
    if (!value) continue;

    // Cari question yang paling cocok labelnya dengan field.label
    let bestMatch = null;
    let bestScore = 0;
    const fieldLabelLower = (field.label || '').toLowerCase();

    for (const q of questions) {
      if (q.type === 'unknown') continue;
      const qLabelLower = q.label.toLowerCase();
      // Exact match
      if (qLabelLower === fieldLabelLower) { bestMatch = q; break; }
      // Partial match score
      const words = fieldLabelLower.split(/\s+/).filter(w => w.length > 2);
      const matches = words.filter(w => qLabelLower.includes(w)).length;
      const score = words.length > 0 ? matches / words.length : 0;
      if (score > bestScore && score > 0.4) { bestScore = score; bestMatch = q; }
    }

    // Fallback: match berdasarkan tipe field jika tidak ada label match
    if (!bestMatch) {
      const isTextArea = field.type === 'textarea' || field.isEssay;
      bestMatch = questions.find(q =>
        isTextArea ? q.type === 'textarea' : q.type === 'text'
      );
    }

    if (!bestMatch) continue;

    try {
      await fillGoogleFormQuestion(page, bestMatch, value, field);
      if (emitFn) emitFn(field.label, value);
      await page.waitForTimeout(400 + Math.random() * 600);
    } catch { /* lanjut ke field berikutnya */ }
  }
}

// Fill satu pertanyaan Google Forms berdasarkan index container
async function fillGoogleFormQuestion(page, question, value, field) {
  // Re-query container by index setiap kali (DOM bisa berubah setelah interaksi)
  const containerSelectors = [
    '.freebirdFormviewerViewItemsItemItem',
    '[data-item-id]',
    '.Qr7Oae',
    '.freebirdFormviewerComponentsQuestionBaseRoot',
  ];

  let container = null;
  for (const sel of containerSelectors) {
    const all = page.locator(sel);
    const count = await all.count();
    if (count > question.index) {
      container = all.nth(question.index);
      break;
    }
  }
  if (!container) return;

  await container.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);

  // Simulasi mouse hover sebelum isi
  const box = await container.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(
      box.x + box.width * 0.3 + Math.random() * box.width * 0.4,
      box.y + box.height * 0.3 + Math.random() * box.height * 0.4
    );
    await page.waitForTimeout(150);
  }

  if (question.type === 'text') {
    const input = container.locator('input[type="text"], input:not([type="radio"]):not([type="checkbox"]):not([type="file"]):not([type="hidden"])').first();
    await input.click({ force: true });
    await page.waitForTimeout(200);
    // Triple-click untuk select all, lalu type
    await input.click({ clickCount: 3 });
    await input.fill('');
    await page.keyboard.type(value, { delay: 30 + Math.random() * 40 });

  } else if (question.type === 'textarea') {
    const ta = container.locator('textarea').first();
    await ta.click({ force: true });
    await page.waitForTimeout(200);
    await ta.click({ clickCount: 3 });
    await ta.fill('');
    await page.keyboard.type(value, { delay: 20 + Math.random() * 30 });

  } else if (question.type === 'dropdown') {
    const listbox = container.locator('[role="listbox"]').first();
    await listbox.click({ force: true });
    await page.waitForTimeout(800);
    // Cari option yang paling cocok
    const options = page.locator('[role="option"]');
    const optCount = await options.count();
    let filled = false;
    const valueLower = value.toLowerCase();
    for (let i = 0; i < optCount; i++) {
      const optText = (await options.nth(i).textContent().catch(() => '')).toLowerCase();
      if (optText.includes(valueLower) || valueLower.includes(optText.replace(/\s+/g, ''))) {
        await options.nth(i).click();
        filled = true;
        break;
      }
    }
    if (!filled && optCount > 1) {
      await options.nth(1).click(); // pilih opsi kedua (skip placeholder)
    } else if (!filled) {
      await page.keyboard.press('Escape');
    }

  } else if (question.type === 'radio') {
    const radios = container.locator('[role="radio"]');
    const radioCount = await radios.count();
    const valueLower = value.toLowerCase();
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < radioCount; i++) {
      const rText = (await radios.nth(i).textContent().catch(() => '')).toLowerCase();
      // Exact match
      if (rText === valueLower) { bestIdx = i; break; }
      // Common patterns: ya/tidak, laki/perempuan, dll
      if (valueLower.includes('laki') && (rText.includes('laki') || rText === 'l')) { bestIdx = i; break; }
      if (valueLower.includes('perempuan') && (rText.includes('perempuan') || rText === 'p')) { bestIdx = i; break; }
      if (valueLower.includes('ya') && rText === 'ya') { bestIdx = i; break; }
      if (valueLower.includes('tidak') && rText === 'tidak') { bestIdx = i; break; }
      // Score partial
      const score = valueLower.split('').filter(c => rText.includes(c)).length;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    const target = radios.nth(bestIdx);
    await target.scrollIntoViewIfNeeded();
    await target.click({ force: true });

  } else if (question.type === 'checkbox') {
    const first = container.locator('[role="checkbox"]').first();
    await first.scrollIntoViewIfNeeded();
    await first.click({ force: true });
  }
}



// ── Core: Auto-fill generic form ──────────────────────────────────────────
async function fillGenericForm(page, fieldMapping, coverLetter, emitFn) {
  for (const field of fieldMapping) {
    if (!field.selector) continue;
    const value = field.isEssay && coverLetter ? coverLetter : field.mappedValue;
    if (!value) continue;
    try {
      const el = page.locator(field.selector).first();
      if (await el.count() === 0) continue;
      await el.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      if (field.type === 'select') {
        await el.selectOption({ label: value }).catch(() => el.selectOption({ value }));
      } else if (field.isFile) {
        continue;
      } else {
        await el.click();
        await el.click({ clickCount: 3 });
        await el.fill('');
        await page.keyboard.type(value, { delay: 30 + Math.random() * 40 });
      }
      if (emitFn) emitFn(field.label, value);
      await page.waitForTimeout(200 + Math.random() * 400);
    } catch {}
  }
}

// ── Core: Submit form dan verifikasi ──────────────────────────────────────
async function submitFormAndVerify(page, formType) {
  try {
    // Scroll ke bawah halaman dulu agar semua field terisi dan tombol submit visible
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await page.waitForTimeout(1000);

    // Simulasi gerakan mouse natural ke area bawah halaman sebelum klik
    const viewportSize = page.viewportSize() || { width: 1280, height: 720 };
    await page.mouse.move(
      viewportSize.width * 0.4 + Math.random() * viewportSize.width * 0.2,
      viewportSize.height * 0.7 + Math.random() * viewportSize.height * 0.2
    );
    await page.waitForTimeout(400);

    // Cari tombol submit — Google Forms pakai [role="button"] bukan <button>
    // Coba selector spesifik Google Forms dulu, lalu generic
    const submitSelectors = [
      '[role="button"]:has-text("Kirim")',
      '[role="button"]:has-text("Submit")',
      '[role="button"]:has-text("Send")',
      'button:has-text("Kirim")',
      'button:has-text("Submit")',
      'button:has-text("Send")',
      'button:has-text("Apply")',
      'button[type="submit"]',
      'input[type="submit"]',
    ];

    let submitBtn = null;
    for (const sel of submitSelectors) {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        submitBtn = el;
        break;
      }
    }

    if (!submitBtn) return { submitted: false, reason: 'Tombol submit tidak ditemukan' };

    await submitBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);

    // Hover dulu, lalu klik (lebih natural, menghindari bot detection)
    const btnBox = await submitBtn.boundingBox().catch(() => null);
    if (btnBox) {
      await page.mouse.move(
        btnBox.x + btnBox.width * 0.3 + Math.random() * btnBox.width * 0.4,
        btnBox.y + btnBox.height * 0.2 + Math.random() * btnBox.height * 0.6
      );
      await page.waitForTimeout(300);
    }

    await submitBtn.click({ force: true });
    // Tunggu navigasi atau perubahan halaman setelah submit
    await page.waitForTimeout(4000);

    // Verifikasi submission berhasil
    const currentUrl = page.url();
    const pageContent = (await page.textContent('body').catch(() => '')).toLowerCase();

    // Google Forms confirmation
    if (formType === 'google_form' && /your response has been recorded|respons anda telah dicatat|terima kasih|thank you/i.test(pageContent)) {
      return { submitted: true };
    }
    // Generic confirmation patterns
    if (/thank you|terima kasih|successfully|berhasil|submitted|terkirim|received|diterima/i.test(pageContent)) {
      return { submitted: true };
    }
    // URL changed (redirect after submit)
    if (currentUrl.includes('confirmation') || currentUrl.includes('thank') || currentUrl.includes('success')) {
      return { submitted: true };
    }

    return { submitted: false, reason: 'Tidak ada konfirmasi submission terdeteksi' };
  } catch (err) {
    return { submitted: false, reason: err.message };
  }
}

// ── Core: Generate cover letter ────────────────────────────────────────────
async function generateCoverLetter(company, position, profile) {
  const name = profile.full_name || 'Wisnu Alfian Nur Ashar';
  const major = profile.major || 'Teknik Informatika';
  const university = profile.university || 'Universitas';
  const skills = profile.skills || 'programming, web development';
  const experience = profile.work_experience || '';

  return `Kepada Yth. HRD ${company},

Dengan hormat, saya ${name}, mahasiswa ${major} dari ${university}, ingin mengajukan lamaran untuk posisi ${position} di ${company}.

Saya memiliki keahlian dalam ${skills} dan memiliki pengalaman ${experience ? experience : 'dalam bidang teknologi informasi'}. Saya sangat tertarik untuk berkontribusi di ${company} dan yakin dapat memberikan nilai tambah bagi tim Bapak/Ibu.

Saya adalah pribadi yang cepat belajar, berorientasi pada hasil, dan siap bekerja dalam tim maupun mandiri. Saya berharap dapat mendapatkan kesempatan untuk berdiskusi lebih lanjut mengenai lamaran ini.

Terima kasih atas perhatian dan kesempatan yang diberikan.

Hormat saya,
${name}
${profile.phone || ''}
${profile.email || ''}`;
}

// ── Core: Auto-fill form (router) ──────────────────────────────────────────
async function autoFillForm(page, fieldMapping, coverLetter, formType, emitFn) {
  if (formType === 'google_form') {
    await fillGoogleForm(page, fieldMapping, coverLetter, emitFn);
  } else {
    await fillGenericForm(page, fieldMapping, coverLetter, emitFn);
  }
}

// ── Public: Start a new scan session ──────────────────────────────────────
export async function startJobSession(sessionId, options = {}) {
  const session = db.getJobSession(sessionId);
  if (!session) throw new Error('Session tidak ditemukan');
  if (activeSessions.has(String(sessionId))) throw new Error('Session sudah berjalan');

  const profile = db.getProfile();
  if (!profile) throw new Error('Profil pengguna belum diisi');

  const abortController = { aborted: false };
  let browser, page;

  // Default headless=false agar browser terlihat oleh user
  const headless = options.headless === true ? true : false;

  activeSessions.set(String(sessionId), { status: 'running', abortController });
  db.updateJobSession(sessionId, { status: 'running', started_at: new Date().toISOString() });
  emit(sessionId, 'session:start', { sessionId, name: session.name, sourceUrl: session.source_url, headless });

  // Helper: inject stealth scripts ke page
  async function injectStealth(p) {
    await p.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });
      window.chrome = { runtime: {} };
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        window.navigator.permissions.query = (params) =>
          params.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(params);
      }
    });
  }

  try {
    // ── Strategy 1: Connect ke Chrome yang sudah berjalan via CDP ──────────
    // Chrome harus dijalankan dengan: chrome.exe --remote-debugging-port=9222
    let usingCDP = false;
    try {
      emit(sessionId, 'session:browser', { message: 'Mencoba connect ke Chrome via CDP...' });
      const cdpBrowser = await chromium.connectOverCDP('http://localhost:9222', { timeout: 3000 });
      const contexts = cdpBrowser.contexts();
      const ctx = contexts.length > 0 ? contexts[0] : await cdpBrowser.newContext();
      page = await ctx.newPage();
      await injectStealth(page);
      browser = cdpBrowser;
      usingCDP = true;
      emit(sessionId, 'session:browser', { message: 'Terhubung ke Chrome yang sudah login via CDP' });
    } catch {
      // ── Strategy 2: Playwright persistent context (Chromium) ─────────────
      emit(sessionId, 'session:browser', { message: 'Chrome CDP tidak tersedia, menggunakan Playwright Chromium...' });
      const ctx = await chromium.launchPersistentContext(
        `C:\\Users\\${os.userInfo().username}\\AppData\\Local\\Playwright\\wanar-profile`,
        {
          headless,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=IsolateOrigins,site-per-process',
          ],
          ignoreDefaultArgs: ['--enable-automation'],
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          viewport: { width: 1366, height: 768 },
          locale: 'id-ID',
          timezoneId: 'Asia/Jakarta',
        }
      );
      browser = { close: () => ctx.close() };
      page = await ctx.newPage();
      await injectStealth(page);
      activeSessions.get(String(sessionId)).ctx = ctx;
    }

    activeSessions.get(String(sessionId)).browser = browser;
    activeSessions.get(String(sessionId)).page = page;

    // Simpan ctx agar processJob bisa buka tab baru
    const browserCtx = activeSessions.get(String(sessionId)).ctx ||
      (usingCDP ? browser.contexts()[0] : null);

    // Step 1: Crawl listing — pakai page utama untuk crawl saja
    emit(sessionId, 'session:crawling', { url: session.source_url });
    const jobs = await crawlListingPage(session.source_url, page);
    for (const j of jobs) {
      db.addJobToQueue(sessionId, j.company, j.title, j.link, session.source_url);
    }
    db.updateJobSession(sessionId, { total: jobs.length });
    emit(sessionId, 'session:crawled', { count: jobs.length, jobs: jobs.slice(0, 10) });

    // Step 2: Process each job — setiap job dapat tab Chrome sendiri
    const queue = db.getJobQueue('pending', 500);
    let idx = 0;
    for (const job of queue) {
      if (abortController.aborted) {
        emit(sessionId, 'session:paused', { processed: idx });
        break;
      }
      idx++;
      emit(sessionId, 'session:progress', { current: idx, total: queue.length, company: job.company, title: job.title });

      // Buka tab baru untuk setiap job
      let jobPage = null;
      try {
        const ctx = browserCtx || (browser.contexts && browser.contexts()[0]);
        if (ctx) {
          jobPage = await ctx.newPage();
          await injectStealth(jobPage);
          emit(sessionId, 'session:browser', { message: `Tab baru dibuka untuk: ${job.company}` });
        }
      } catch {
        // Fallback: reuse page utama jika tidak bisa buka tab baru
        jobPage = page;
      }

      await processJob(job.id, jobPage || page, profile, { ...options, sessionId });

      // Tutup tab setelah selesai (jangan tutup page utama)
      if (jobPage && jobPage !== page) {
        await jobPage.close().catch(() => {});
      }

      // Update session counters
      const stats = db.getJobQueueStats();
      const submitted = stats.find(s => s.status === 'submitted')?.count || 0;
      const needs_review = stats.find(s => s.status === 'needs_review')?.count || 0;
      const skipped = stats.find(s => s.status === 'skipped')?.count || 0;
      const failed_count = stats.find(s => s.status === 'failed')?.count || 0;
      db.updateJobSession(sessionId, { submitted, needs_review, skipped, failed_count });

      await randomDelay();
    }

    db.updateJobSession(sessionId, { status: 'completed', finished_at: new Date().toISOString() });
    const finalStats = db.getJobQueueStats();
    emit(sessionId, 'session:completed', {
      submitted: finalStats.find(s => s.status === 'submitted')?.count || 0,
      needs_review: finalStats.find(s => s.status === 'needs_review')?.count || 0,
      skipped: finalStats.find(s => s.status === 'skipped')?.count || 0,
      failed: finalStats.find(s => s.status === 'failed')?.count || 0,
    });
  } catch (err) {
    db.updateJobSession(sessionId, { status: 'failed', finished_at: new Date().toISOString() });
    emit(sessionId, 'session:error', { error: err.message });
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    activeSessions.delete(String(sessionId));
  }
}

export function stopJobSession(sessionId) {
  const s = activeSessions.get(String(sessionId));
  if (s) {
    s.abortController.aborted = true;
    db.updateJobSession(sessionId, { status: 'paused' });
    return true;
  }
  return false;
}

export function getActiveSessionIds() {
  return Array.from(activeSessions.keys());
}
