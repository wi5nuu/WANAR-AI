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
      if (value == null || String(value).trim() === '') continue;
      // Array (skills, dll) → join jadi string yang bermakna
      const strValue = Array.isArray(value)
        ? value.join(', ')
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
      if (strValue.trim() === '') continue;
      return { key: mapping.key, value: strValue, confidence: mapping.confidence };
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

// ── TAHAP 1: Analisis konten lowongan + fraud detection ───────────────────
// Membaca isi halaman lowongan, mengekstrak konteks, dan memutuskan layak/tidak
async function analyzeJobContent(page, job, profile, options = {}) {
  const url = page.url();

  // Ambil teks halaman DULU — harus sebelum apapun yang butuh textLower
  const pageText = await page.evaluate(() => {
    const body = document.body;
    if (!body) return '';
    const clone = body.cloneNode(true);
    for (const el of clone.querySelectorAll('script,style,noscript')) el.remove();
    return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
  }).catch(() => '');

  const textLower = pageText.toLowerCase();

  // ── Deteksi redirect ke halaman login ───────────────────────────────────
  // PENTING: Google Forms memiliki elemen Google Account di header —
  // deteksi login HARUS pakai input[type="password"] saja, bukan class "login/signin"
  // karena Google Forms bukan halaman login meskipun ada tombol profil Google di corner.
  const isLoginUrl = /\/(login|signin|sign-in|auth|sso|oauth|account\/login)\b/i.test(url);
  const hasPasswordField = await page.evaluate(() => {
    return !!document.querySelector('input[type="password"]');
  }).catch(() => false);
  const isLoginPage = isLoginUrl || hasPasswordField;

  // ── Ekstrak konteks lowongan dari teks halaman ──
  const context = {
    position: job.title || '',
    company: job.company || '',
    description: '',
    qualifications: '',
    location: 'tidak disebutkan',
    work_type: 'tidak disebutkan',
    salary: 'tidak disebutkan',
    deadline: 'tidak disebutkan',
  };

  // Ekstrak lokasi
  const locMatch = pageText.match(/(?:lokasi|location|kota|city)[:\s]+([A-Za-z ,]+?)(?:\n|\.|,|;)/i);
  if (locMatch) context.location = locMatch[1].trim();

  // Ekstrak tipe kerja
  if (/\bremote\b/i.test(textLower)) context.work_type = 'remote';
  else if (/hybrid/i.test(textLower)) context.work_type = 'hybrid';
  else if (/on.?site|onsite|wfo|work.?from.?office/i.test(textLower)) context.work_type = 'onsite';

  // Ekstrak gaji jika ada
  const salaryMatch = pageText.match(/(?:gaji|salary|kompensasi|remuneration)[:\s]+([\w\s.,\-\/Rp$]+?)(?:\n|\.|per)/i);
  if (salaryMatch) context.salary = salaryMatch[1].trim();

  // Ekstrak deskripsi (200 char pertama dari paragraf panjang)
  const descMatch = pageText.match(/(?:deskripsi|description|tanggung.?jawab|responsibilities|job.?desc)[:\s]+(.{50,300})/i);
  if (descMatch) context.description = descMatch[1].trim();
  else context.description = pageText.substring(0, 300).trim();

  // Ekstrak kualifikasi
  const qualMatch = pageText.match(/(?:kualifikasi|qualification|persyaratan|requirement)[:\s]+(.{30,300})/i);
  if (qualMatch) context.qualifications = qualMatch[1].trim();

  // ── FRAUD DETECTION ──────────────────────────────────────────────────────
  const fraudSignals = [];
  const suspiciousDomains = /bit\.ly|tinyurl|cutt\.ly|rb\.gy|gg\.gg|t\.co\/[a-z0-9]{5,}$/i;
  if (suspiciousDomains.test(url)) fraudSignals.push('URL pendek mencurigakan (bukan domain resmi)');

  // Minta data finansial / rekening
  if (/rekening|no\.?\s*rek|account.?number|bank.?account|kartu.?kredit|credit.?card/i.test(textLower))
    fraudSignals.push('Meminta nomor rekening atau data finansial');

  // Minta biaya pendaftaran
  if (/biaya.?pendaftaran|registration.?fee|bayar|payment.?required|deposit.?required|transfer.*rp|rp.*transfer/i.test(textLower))
    fraudSignals.push('Minta biaya pendaftaran atau transfer uang');

  // Redirect ke domain asing di tengah proses
  const jobDomain = (() => { try { return new URL(job.link || url).hostname; } catch { return ''; } })();
  const currentDomain = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const knownJobSites = /jobstreet|linkedin|glints|kalibrr|indeed|greenhouse|lever|workday|google\.com/i;
  if (jobDomain && currentDomain && jobDomain !== currentDomain && !knownJobSites.test(currentDomain))
    fraudSignals.push(`Redirect ke domain berbeda: ${currentDomain} (asalnya: ${jobDomain})`);

  // Form minta data sensitif non-standar
  if (/\bpassport\b|\bkk\b|kartu.?keluarga|akta.?lahir|ijazah.?asli|scan.?ktp.*bayar/i.test(textLower))
    fraudSignals.push('Meminta dokumen sangat sensitif di tahap awal (passport, KK, ijazah asli)');

  // ── PENGECEKAN PREFERENSI PENGGUNA ──────────────────────────────────────
  const skipReasons = [];

  // Cek preferensi lokasi (jika ada dan bukan remote)
  if (options.preferensi_lokasi && options.preferensi_lokasi.length > 0 && context.work_type !== 'remote') {
    const locOk = options.preferensi_lokasi.some(pref =>
      context.location.toLowerCase().includes(pref.toLowerCase())
    );
    if (!locOk && context.location !== 'tidak disebutkan')
      skipReasons.push(`Lokasi "${context.location}" di luar preferensi [${options.preferensi_lokasi.join(', ')}]`);
  }

  // Cek preferensi remote
  if (options.preferensi_remote === true && context.work_type === 'onsite')
    skipReasons.push('Posisi onsite, pengguna preferensi remote');

  // ── Cek filter bidang pekerjaan ─────────────────────────────────────────
  // Jika options.bidang_pekerjaan diisi, lowongan yang tidak relevan di-skip
  // Contoh: ['software engineer', 'programmer', 'developer', 'frontend', 'backend', 'fullstack', 'it']
  if (options.bidang_pekerjaan && options.bidang_pekerjaan.length > 0) {
    const posisiLower = (context.position || job.title || '').toLowerCase();
    const deskripsiLower = (context.description || '').toLowerCase().substring(0, 500);
    const relevant = options.bidang_pekerjaan.some(keyword =>
      posisiLower.includes(keyword.toLowerCase()) ||
      deskripsiLower.includes(keyword.toLowerCase())
    );
    if (!relevant) {
      skipReasons.push(
        `Posisi "${context.position || job.title}" tidak sesuai bidang yang dicari: [${options.bidang_pekerjaan.join(', ')}]`
      );
    }
  }

  // ── REASONING LOG ────────────────────────────────────────────────────────
  const reasoning = {
    analisis: `Halaman menampilkan posisi "${context.position}" di "${context.company}". Tipe kerja: ${context.work_type}. Lokasi: ${context.location}. Gaji: ${context.salary}.`,
    perbandingan_profil: skipReasons.length === 0
      ? 'Data profil tersedia dan lokasi/tipe kerja sesuai preferensi.'
      : `Ada ketidakcocokan: ${skipReasons.join('; ')}`,
    risiko: fraudSignals.length > 0
      ? `PERINGATAN FRAUD: ${fraudSignals.join('; ')}`
      : 'Tidak ada sinyal penipuan terdeteksi.',
    keputusan: fraudSignals.length > 0
      ? 'Perlu Review — ada indikasi penipuan lowongan'
      : skipReasons.length > 0
        ? 'Dilewati — lowongan tidak sesuai preferensi pengguna'
        : 'Lanjut ke Tahap 2 — lowongan layak diproses',
  };

  return { context, fraudSignals, skipReasons, reasoning, requiresLogin: isLoginPage };
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
    // Tunggu sampai setidaknya satu container pertanyaan muncul di DOM
    // Ini menggantikan static wait — jauh lebih reliabel untuk Google Forms
    const containerSelectors = [
      '.freebirdFormviewerViewItemsItemItem',
      '[data-item-id]',
      '.Qr7Oae',
      '.freebirdFormviewerComponentsQuestionBaseRoot',
      'div[jsmodel]',                        // 2025 Google Forms class
    ];
    let foundSel = null;
    for (const sel of containerSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 6000 });
        foundSel = sel;
        break;
      } catch {}
    }
    // Jika semua selector gagal — coba fallback: tunggu form element apapun
    if (!foundSel) {
      try { await page.waitForSelector('form', { timeout: 4000 }); } catch {}
    }

    return await page.evaluate(() => {
      const fields = [];

      // ── Selector container pertanyaan (urut dari yang paling spesifik) ──
      const itemSelectors = [
        '.freebirdFormviewerViewItemsItemItem',
        '[data-item-id]',
        '.Qr7Oae',
        '.freebirdFormviewerComponentsQuestionBaseRoot',
        'div[jsmodel]',
      ];

      let items = [];
      for (const sel of itemSelectors) {
        const found = Array.from(document.querySelectorAll(sel));
        // Filter: hanya yang visible dan mengandung input/textarea/radio
        const withInput = found.filter(el => el.querySelector(
          'input, textarea, [role="radio"], [role="checkbox"], [role="listbox"], select'
        ));
        if (withInput.length > 0) { items = withInput; break; }
        if (found.length > 0) { items = found; break; }
      }

      // ── Fallback universal: cari semua input/textarea yang visible di halaman ──
      if (items.length === 0) {
        // Dapatkan semua input visible, ambil container parentnya
        const allInputs = Array.from(document.querySelectorAll(
          'input[type="text"], input:not([type]), textarea, [role="radio"], [role="listbox"]'
        )).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        // Group by closest shared parent (naik 3 level)
        const seen = new Set();
        for (const inp of allInputs) {
          let parent = inp.parentElement?.parentElement?.parentElement || inp.parentElement || inp;
          if (!seen.has(parent)) { seen.add(parent); items.push(parent); }
        }
      }

      for (const item of items) {
        // Label: coba banyak selector dari yang paling spesifik ke generik
        const labelEl = item.querySelector(
          '.M7eMe, ' +
          '.freebirdFormviewerViewItemsItemItemTitle, ' +
          '[role="heading"], ' +
          '.aDTYNe, ' +
          '.HoXoMd, ' +
          '.pMTkAe, ' +                        // 2025 Google Forms
          'span[dir="auto"]:first-of-type, ' +
          '[data-params] span, ' +
          'label'
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

  const { trustedMode = false, aiGenerateCoverLetter, sessionId, bidang_pekerjaan } = options;
  // Teruskan bidang_pekerjaan ke analyzeJobContent via options (sudah ada di options object)
  const sid = sessionId;

  // ── DUPLICATE SUBMIT GUARD ────────────────────────────────────────────────
  // Satu lowongan = satu kali submit. Jangan proses ulang jika sudah submitted.
  if (job.status === 'submitted') {
    emit(sid, 'job:skip', { jobId, company: job.company, title: job.title, reason: 'Sudah pernah di-submit sebelumnya — skip untuk mencegah duplikasi' });
    return;
  }

  try {
    emit(sid, 'job:start', { jobId, company: job.company, title: job.title, link: job.link });

    // Check robots.txt
    const robotsOk = await checkRobotsTxt(page, job.link);
    if (!robotsOk) {
      db.updateJobStatus(jobId, 'skipped', { notes: 'robots.txt melarang automated application', robotsOk: 0 });
      emit(sid, 'job:skip', { jobId, company: job.company, title: job.title, reason: 'robots.txt melarang' });
      emit(sid, 'job:log', buildJobLog(job, 'Dilewati', 'robots.txt melarang automated application', [], null));
      return;
    }

    // Navigate to job page
    db.updateJobStatus(jobId, 'processing');
    emit(sid, 'job:navigate', { jobId, company: job.company, title: job.title, url: job.link });
    try {
      await page.goto(job.link, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (navErr) {
      db.incrementJobRetry(jobId);
      const retried = db.getJobById(jobId); // re-fetch agar retry_count tidak stale
      const isTimeout = /timeout/i.test(navErr.message);
      const isNetwork = /net::|ERR_|ECONNREFUSED|ENOTFOUND/i.test(navErr.message);
      const errCategory = isTimeout ? 'Timeout' : isNetwork ? 'Network error' : 'Navigation error';
      const msg = `${errCategory}: ${navErr.message}`;
      if ((retried?.retry_count || 0) >= MAX_RETRY) {
        db.updateJobStatus(jobId, 'failed', { notes: msg });
        emit(sid, 'job:failed', { jobId, company: job.company, title: job.title, reason: msg });
        emit(sid, 'job:log', buildJobLog(job, 'Gagal', msg, [], null));
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

    // ── TAHAP 1: Baca & Pahami konten lowongan ─────────────────────────────
    emit(sid, 'job:analyzing', { jobId, company: job.company, title: job.title, message: 'Menganalisis konten lowongan...' });
    let analysis;
    try {
      analysis = await analyzeJobContent(page, job, profile, options);
    } catch (analyzeErr) {
      // analyzeJobContent gagal (misal halaman tidak bisa dibaca) → skip, bukan failed
      const skipNote = `Analisis konten gagal: ${analyzeErr.message}`;
      db.updateJobStatus(jobId, 'skipped', { notes: skipNote });
      emit(sid, 'job:skip', { jobId, company: job.company, title: job.title, reason: skipNote });
      emit(sid, 'job:log', buildJobLog(job, 'Dilewati', skipNote, [], null));
      return;
    }
    const { context: jobContext, fraudSignals, skipReasons, reasoning } = analysis;

    // Emit reasoning log ke UI — user bisa lihat keputusan agent secara transparan
    emit(sid, 'job:reasoning', {
      jobId,
      company: job.company,
      title: job.title,
      analisis: reasoning.analisis,
      perbandingan_profil: reasoning.perbandingan_profil,
      risiko: reasoning.risiko,
      keputusan: reasoning.keputusan,
      jobContext,
    });

    // ── Handle login redirect dari Tahap 1 ────────────────────────────────
    if (analysis.requiresLogin) {
      const loginNote = 'Halaman memerlukan login manual sebelum bisa mengakses form lamaran';
      db.updateJobStatus(jobId, 'needs_review', { notes: loginNote, jobContext });
      db.addToReviewQueue(jobId, [], null, loginNote);
      emit(sid, 'job:review', { jobId, company: job.company, title: job.title, reason: loginNote });
      emit(sid, 'job:log', buildJobLog(job, 'Perlu Review', loginNote, [], null));
      return;
    }

    // Jika ada fraud signal → Perlu Review + peringatan eksplisit
    if (fraudSignals.length > 0) {
      const fraudNote = `PERINGATAN PENIPUAN: ${fraudSignals.join('; ')}`;
      db.updateJobStatus(jobId, 'needs_review', { notes: fraudNote, jobContext });
      db.addToReviewQueue(jobId, [], null, fraudNote);
      emit(sid, 'job:fraud_warning', {
        jobId, company: job.company, title: job.title,
        signals: fraudSignals,
        message: 'Lowongan ini memiliki indikasi penipuan — JANGAN submit tanpa verifikasi manual.',
      });
      emit(sid, 'job:log', buildJobLog(job, 'Perlu Review', fraudNote, [], null));
      return;
    }

    // Jika ada alasan skip dari preferensi pengguna → Dilewati
    if (skipReasons.length > 0) {
      const skipNote = skipReasons.join('; ');
      db.updateJobStatus(jobId, 'skipped', { notes: skipNote, jobContext });
      emit(sid, 'job:skip', { jobId, company: job.company, title: job.title, reason: skipNote });
      emit(sid, 'job:log', buildJobLog(job, 'Dilewati', skipNote, [], null));
      return;
    }

    // ── TAHAP 2: Deteksi & navigasi ke form ────────────────────────────────
    // Beberapa halaman listing memiliki tombol Apply/Lamar yang perlu diklik
    // sebelum form muncul. Coba deteksi dulu, navigate jika perlu.
    const applyBtnSelectors = [
      'a:has-text("Apply Now")', 'a:has-text("Apply")', 'a:has-text("Lamar")',
      'a:has-text("Lamar Sekarang")', 'a:has-text("Apply for this job")',
      'button:has-text("Apply Now")', 'button:has-text("Lamar")',
      'button:has-text("Apply")', 'button:has-text("Daftar")',
      '[data-qa="btn-apply"]', '[class*="apply-btn"]', '[class*="btn-apply"]',
      '[id*="apply-button"]', '[class*="apply-button"]',
    ];
    let navigatedToForm = false;
    for (const sel of applyBtnSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.count() > 0) {
          const href = await btn.getAttribute('href').catch(() => null);
          if (href && href.startsWith('http')) {
            // Link ke halaman lain — navigate
            await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } else {
            // Tombol di halaman yang sama — klik
            await btn.click();
            await page.waitForTimeout(2000);
          }
          navigatedToForm = true;
          emit(sid, 'job:navigate', { jobId, company: job.company, title: job.title, url: page.url(), note: 'Klik tombol Apply/Lamar' });
          break;
        }
      } catch {}
    }
    if (navigatedToForm) await page.waitForTimeout(1500);

    const formType = detectFormType(page.url());
    emit(sid, 'job:form_detected', { jobId, company: job.company, title: job.title, formType, url: page.url() });

    // Tunggu extra untuk Google Forms render JS
    if (formType === 'google_form') {
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
      emit(sid, 'job:log', buildJobLog(job, 'Dilewati', 'Form sudah ditutup oleh pembuat', [], null));
      return;
    }

    // Extract form fields
    let fields = [];
    if (formType === 'google_form') {
      fields = await extractGoogleFormFields(page);
      if (fields.length === 0) {
        await page.waitForTimeout(3000);
        fields = await extractGoogleFormFields(page);
      }
      if (fields.length === 0) fields = await extractFormFields(page);
    } else {
      fields = await extractFormFields(page);
    }

    if (fields.length === 0) {
      db.updateJobStatus(jobId, 'skipped', { notes: 'Tidak ada form yang terdeteksi di halaman ini', formType });
      emit(sid, 'job:skip', { jobId, company: job.company, title: job.title, reason: 'Tidak ada form terdeteksi' });
      emit(sid, 'job:log', buildJobLog(job, 'Dilewati', 'Tidak ada form yang terdeteksi di halaman ini', [], null));
      return;
    }

    emit(sid, 'job:fields', { jobId, company: job.company, title: job.title, fieldCount: fields.length });

    // Map fields to profile
    const fieldMapping = [];
    let mappedConfidences = [];
    let hasLowConfidence = false;
    let hasMissingRequired = false;   // field wajib tanpa nilai = needs_review
    let missingRequiredFields = [];   // daftar field wajib yang kosong untuk log

    for (const field of fields) {

      // ── File upload: coba upload CV otomatis jika ada path di profil ──────
      if (field.isFile) {
        const cvPath = profile.cv_path || profile.cv_url || profile.resume_path;
        const isCvField = /\bcv\b|resume|curriculum|upload.*cv|attach.*cv/i.test(field.label);
        if (isCvField && cvPath && !cvPath.startsWith('http')) {
          // Path lokal tersedia — tandai untuk diupload otomatis
          fieldMapping.push({ ...field, mappedKey: 'cv_path', mappedValue: cvPath, confidence: 0.95, isFile: true, needsManual: false, uploadPath: cvPath });
          mappedConfidences.push(0.95);
        } else {
          // Tidak ada path lokal atau field file non-CV — masuk review jika required
          if (field.required) {
            hasMissingRequired = true;
            missingRequiredFields.push(field.label || 'File upload');
          }
          fieldMapping.push({ ...field, mappedKey: null, mappedValue: null, confidence: 1, isFile: true, needsManual: field.required });
        }
        continue;
      }

      // ── Expected salary: JANGAN tebak jika tidak ada di profil ───────────
      const isSalaryField = /salary|gaji|ekspektasi.?gaji|expected.?salary|gaji.?yang.?diharapkan|harapan.?gaji/i.test(field.label);
      if (isSalaryField) {
        const salaryValue = profile.expected_salary;
        if (salaryValue) {
          fieldMapping.push({ ...field, mappedKey: 'expected_salary', mappedValue: String(salaryValue), confidence: 0.90 });
          mappedConfidences.push(0.90);
        } else {
          // Tidak ada di profil — jangan tebak, tandai needs_review
          hasMissingRequired = true;
          missingRequiredFields.push(`Expected Salary (belum diset di profil)`);
          fieldMapping.push({ ...field, mappedKey: 'expected_salary', mappedValue: null, confidence: 0, needsManual: true });
        }
        continue;
      }

      const mapped = mapFieldToProfile(field.label, profile);
      if (mapped && mapped.value) {
        fieldMapping.push({ ...field, mappedKey: mapped.key, mappedValue: mapped.value, confidence: mapped.confidence });
        mappedConfidences.push(mapped.confidence);
        if (mapped.confidence < CONFIDENCE_THRESHOLD) hasLowConfidence = true;
      } else {
        // ── Essay / screening field: jawab spesifik, bukan template generik ──
        const isEssay = field.isEssay || field.type === 'textarea' ||
          /why|motivat|cover.?letter|tell.?us|describe|strength|weakness|cerit|alasan|motivasi|perkenalkan/i.test(field.label);

        if (isEssay) {
          // Cek apakah pertanyaan spesifik atau generik
          const isSpecificScreening = /why\s+(?:do\s+you|should\s+we)|what\s+(?:makes|is\s+your)|describe\s+(?:a\s+time|your\s+experience|an\s+instance)|tell\s+us\s+about\s+a\s+(?:time|challenge|project)/i.test(field.label);
          fieldMapping.push({
            ...field,
            mappedKey: 'cover_letter',
            mappedValue: null,
            confidence: 0.90,
            isEssay: true,
            isSpecificScreening,  // flag: perlu generate jawaban spesifik vs cover letter
            screeningQuestion: field.label,
            needsManual: false,
          });
          mappedConfidences.push(0.90);
        } else {
          // Field tidak dikenal — jika wajib, tandai missing
          if (field.required) {
            hasMissingRequired = true;
            missingRequiredFields.push(field.label || 'Unknown required field');
          }
          fieldMapping.push({ ...field, mappedKey: null, mappedValue: null, confidence: 1, needsManual: field.required, skipField: !field.required });
        }
      }
    }

    // ── Verifikasi: jika ada field wajib kosong → Perlu Review, JANGAN submit ──
    if (hasMissingRequired) {
      const missingNote = `Field wajib tanpa nilai: ${missingRequiredFields.join(', ')}`;
      db.updateJobStatus(jobId, 'needs_review', { fieldMapping, formType, notes: missingNote });
      db.addToReviewQueue(jobId, fieldMapping, null, missingNote);
      emit(sid, 'job:review', {
        jobId, company: job.company, title: job.title,
        reason: missingNote,
        missingFields: missingRequiredFields,
        fieldCount: fieldMapping.length,
      });
      emit(sid, 'job:log', buildJobLog(job, 'Perlu Review', missingNote, fieldMapping, null));
      return;
    }

    // Hitung minConfidence hanya dari field yang benar-benar di-mapping
    const minConfidence = mappedConfidences.length > 0 ? Math.min(...mappedConfidences) : 0.9;

    // Generate cover letter — personalisasi dengan konteks lowongan dari Tahap 1
    let coverLetter = null;
    try { coverLetter = await generateCoverLetter(job.company, job.title, profile, jobContext); } catch {}

    // Decide: auto-submit or review queue
    // trustedMode = submit langsung meskipun ada field yang tidak ter-mapping
    // needsReview hanya jika confidence SANGAT rendah (< 50%) dan tidak ada field ter-mapping sama sekali
    // Essay fields (confidence 0.90) tidak boleh trigger review — mereka akan di-generate saat fill
    const criticalLowConfidence = minConfidence < 0.5 && mappedConfidences.length === 0;
    const needsReview = criticalLowConfidence && !trustedMode;

    if (needsReview) {
      const reviewReason = hasLowConfidence ? 'Field confidence rendah / ada pertanyaan essay' : 'Mode review aktif — menunggu approval';
      db.updateJobStatus(jobId, 'needs_review', { fieldMapping, coverLetter, formType, confidence: minConfidence, robotsOk: 1 });
      db.addToReviewQueue(jobId, fieldMapping, null, reviewReason);
      emit(sid, 'job:review', {
        jobId, company: job.company, title: job.title,
        reason: hasLowConfidence ? 'Confidence rendah' : 'Menunggu approval',
        confidence: Math.round(minConfidence * 100),
        fieldCount: fieldMapping.length,
      });
      emit(sid, 'job:log', buildJobLog(job, 'Perlu Review', reviewReason, fieldMapping, null));
    } else {
      // Auto-fill + submit + verify
      emit(sid, 'job:filling', { jobId, company: job.company, title: job.title, fieldCount: fieldMapping.length });

      // Emit per-field ke live feed agar user bisa pantau real-time
      const fieldEmit = (label, value) => {
        const preview = String(value).length > 40 ? String(value).substring(0, 40) + '...' : String(value);
        emit(sid, 'job:field_filled', { jobId, company: job.company, label, preview });
      };

      await autoFillForm(page, fieldMapping, coverLetter, formType, fieldEmit, profile);
      await page.waitForTimeout(1000);

      const result = await submitFormAndVerify(page, formType);

      if (result.submitted) {
        // "Terkirim" HANYA jika ada bukti konkret dari halaman
        db.updateJobStatus(jobId, 'submitted', { fieldMapping, coverLetter, formType, confidence: minConfidence, robotsOk: 1 });
        db.addApplyHistory({ company: job.company, position: job.title, apply_url: job.link, status: 'applied', form_data: fieldMapping });
        emit(sid, 'job:submitted', {
          jobId, company: job.company, title: job.title,
          confidence: Math.round(minConfidence * 100),
          fieldCount: fieldMapping.length,
          bukti_konfirmasi: result.evidence,
        });
        emit(sid, 'job:log', buildJobLog(job, 'Terkirim', `Bukti: ${result.evidence}`, fieldMapping, result.evidence));

      } else if (result.ambiguous) {
        // Ambigu: tidak ada sinyal jelas ke arah manapun — JANGAN tebak, masuk review
        const ambiguousNote = result.reason || 'Konfirmasi tidak dapat diverifikasi otomatis';
        db.updateJobStatus(jobId, 'needs_review', { fieldMapping, coverLetter, formType, confidence: minConfidence, robotsOk: 1 });
        db.addToReviewQueue(jobId, fieldMapping, null, ambiguousNote);
        emit(sid, 'job:review', {
          jobId, company: job.company, title: job.title,
          reason: ambiguousNote,
          confidence: Math.round(minConfidence * 100),
          fieldCount: fieldMapping.length,
        });
        emit(sid, 'job:log', buildJobLog(job, 'Perlu Review', ambiguousNote, fieldMapping, null));

      } else {
        // Submit gagal dengan pesan error jelas — retry jika belum melebihi MAX_RETRY
        const failReason = result.reason || 'Submit gagal tanpa pesan error';
        const currentRetry = job.retry_count || 0;
        if (currentRetry < MAX_RETRY) {
          db.incrementJobRetry(jobId);
          db.updateJobStatus(jobId, 'needs_review', { fieldMapping, coverLetter, formType, confidence: minConfidence, robotsOk: 1 });
          db.addToReviewQueue(jobId, fieldMapping, null, `Submit gagal (retry ${currentRetry + 1}/${MAX_RETRY}): ${failReason}`);
          emit(sid, 'job:review', {
            jobId, company: job.company, title: job.title,
            reason: `Submit gagal: ${failReason}`,
            retry: currentRetry + 1,
            confidence: Math.round(minConfidence * 100),
          });
        } else {
          db.updateJobStatus(jobId, 'failed', { notes: failReason, fieldMapping });
          emit(sid, 'job:failed', { jobId, company: job.company, title: job.title, reason: failReason });
          emit(sid, 'job:log', buildJobLog(job, 'Gagal', failReason, fieldMapping, null));
        }
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
async function fillGoogleForm(page, fieldMapping, coverLetter, emitFn, profile) {
  // Tunggu sampai container pertanyaan benar-benar muncul di DOM
  // Static wait(2000) tidak cukup — Google Forms render via JS dan bisa lebih lambat
  const gfSelectors = [
    '.freebirdFormviewerViewItemsItemItem',
    '[data-item-id]',
    '.Qr7Oae',
    '.freebirdFormviewerComponentsQuestionBaseRoot',
    'div[jsmodel]',
  ];
  let rendered = false;
  for (const sel of gfSelectors) {
    try { await page.waitForSelector(sel, { timeout: 8000 }); rendered = true; break; } catch {}
  }
  if (!rendered) {
    // Fallback: tunggu form element generik
    try { await page.waitForSelector('form input, form textarea', { timeout: 5000 }); } catch {}
  }
  await page.waitForTimeout(500); // buffer kecil setelah render

  // Simulasi gerakan mouse natural (anti-bot detection)
  await page.mouse.move(400 + Math.random() * 200, 300 + Math.random() * 100);
  await page.waitForTimeout(300);

  // Scan semua question container sekaligus dari DOM
  // Ambil semua input/textarea/listbox yang visible di halaman
  // PENTING: simpan usedSelector agar fillGoogleFormQuestion re-query pakai selector yang sama
  const { questions, usedSelector } = await page.evaluate(() => {
    const result = [];
    // Cari semua container pertanyaan
    const containerSelectors = [
      '.freebirdFormviewerViewItemsItemItem',
      '[data-item-id]',
      '.Qr7Oae',
      '.freebirdFormviewerComponentsQuestionBaseRoot',
    ];
    let containers = [];
    let foundSelector = null;
    for (const sel of containerSelectors) {
      containers = Array.from(document.querySelectorAll(sel));
      if (containers.length > 0) { foundSelector = sel; break; }
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

      result.push({ index: i, label, type, radioOptions, usedSelector: foundSelector });
    }
    return { questions: result, usedSelector: foundSelector };
  });

  if (!questions || questions.length === 0) {
    // Emit skip agar user tahu kenapa form tidak diisi
    if (emitFn) emitFn('(scan)', 'Tidak ada pertanyaan terdeteksi di form Google Forms');
    return;
  }

  // Match field mapping ke question DOM berdasarkan label similarity
  for (const field of fieldMapping) {
    if (field.skipField) continue;

    // ── CV file upload di Google Form ─────────────────────────────────────
    if (field.isFile && field.uploadPath) {
      try {
        const fileInput = page.locator('input[type="file"]').first();
        if (await fileInput.count() > 0) {
          await fileInput.setInputFiles(field.uploadPath);
          if (emitFn) emitFn(field.label || 'CV/Resume', field.uploadPath);
        }
      } catch {}
      continue;
    }
    if (field.isFile) continue;

    // ── Tentukan nilai yang akan diisi ────────────────────────────────────
    let value;
    if (field.isEssay) {
      if (field.isSpecificScreening && field.screeningQuestion) {
        // Pertanyaan screening spesifik: generate jawaban berbasis profil + konteks
        value = generateScreeningAnswer(field.screeningQuestion, profile);
      } else {
        // Cover letter / motivasi generik
        value = coverLetter;
      }
    } else {
      value = field.mappedValue;
    }
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
  // Re-query container by index pakai usedSelector yang SAMA dari saat scan
  // Ini mencegah index mismatch ketika selector berbeda menghasilkan urutan berbeda
  const selectorToUse = question.usedSelector || '.freebirdFormviewerViewItemsItemItem';

  let container = null;
  const all = page.locator(selectorToUse);
  const count = await all.count();
  if (count > question.index) {
    container = all.nth(question.index);
  }
  // Fallback: jika selector asli tidak match lagi (DOM berubah), coba selector lain
  if (!container || count === 0) {
    const fallbackSelectors = [
      '.freebirdFormviewerViewItemsItemItem',
      '[data-item-id]',
      '.Qr7Oae',
      '.freebirdFormviewerComponentsQuestionBaseRoot',
    ].filter(s => s !== selectorToUse);
    for (const sel of fallbackSelectors) {
      const all2 = page.locator(sel);
      const c2 = await all2.count();
      if (c2 > question.index) { container = all2.nth(question.index); break; }
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
    if (radioCount === 0) return; // tidak ada radio option — skip
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
async function fillGenericForm(page, fieldMapping, coverLetter, profile, emitFn) {
  for (const field of fieldMapping) {
    // Skip field yang tidak perlu diisi
    if (field.skipField) continue;
    if (!field.selector) continue;

    try {
      // ── CV file upload ───────────────────────────────────────────────────
      if (field.isFile && field.uploadPath) {
        const el = page.locator(field.selector + ', input[type="file"]').first();
        if (await el.count() > 0) {
          await el.setInputFiles(field.uploadPath);
          if (emitFn) emitFn(field.label || 'CV/Resume', field.uploadPath);
        }
        continue;
      }
      if (field.isFile) continue;

      // ── Tentukan nilai ────────────────────────────────────────────────────
      let value;
      if (field.isEssay) {
        value = (field.isSpecificScreening && field.screeningQuestion)
          ? generateScreeningAnswer(field.screeningQuestion, profile)
          : coverLetter;
      } else {
        value = field.mappedValue;
      }
      if (!value) continue;

      const el = page.locator(field.selector).first();
      if (await el.count() === 0) continue;
      await el.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);

      if (field.type === 'select') {
        await el.selectOption({ label: value }).catch(() => el.selectOption({ value }));
      } else if (field.type === 'checkbox' || field.type === 'radio') {
        // Untuk checkbox/radio: pilih berdasarkan value
        const options = page.locator(`input[type="${field.type}"][value="${value}"], label:has-text("${value}")`);
        if (await options.count() > 0) await options.first().click({ force: true });
        else await el.click({ force: true }); // fallback: klik elemen pertama
      } else {
        await el.click();
        await el.click({ clickCount: 3 });
        await el.fill('');
        await page.keyboard.type(value, { delay: 30 + Math.random() * 40 });
      }

      if (emitFn) emitFn(field.label, value);
      await page.waitForTimeout(200 + Math.random() * 400);
    } catch { /* lanjut ke field berikutnya, jangan hentikan proses */ }
  }
}

// ── Helper: Generate jawaban screening spesifik berbasis profil ───────────
// Untuk pertanyaan seperti "Describe a time you...", "Why do you want to work here?", dll.
// Menggunakan data profil nyata, bukan template kosong.
function generateScreeningAnswer(question, profile) {
  const name = profile.full_name || 'Saya';
  const skills = (() => {
    const raw = profile.skills || '';
    const arr = Array.isArray(raw) ? raw : String(raw).split(/[,;\/\n]+/).map(s => s.trim()).filter(Boolean);
    return arr.slice(0, 4).join(', ') || 'programming, web development';
  })();
  const university = profile.university || 'universitas';
  const major = profile.major || 'Teknologi Informasi';

  // "Why do you want to work here / Why this company / Mengapa melamar"
  if (/why.{0,20}(?:company|us|here|join|this\s+role|position)|mengapa.{0,20}(?:melamar|bergabung|tertarik)/i.test(question)) {
    return `Saya tertarik bergabung karena ingin berkontribusi langsung dalam lingkungan yang mendorong pertumbuhan teknis. Dengan latar belakang ${major} dari ${university} dan keahlian dalam ${skills}, saya yakin dapat memberikan nilai nyata bagi tim. Saya percaya kolaborasi antara passion teknis dan tantangan bisnis nyata adalah cara terbaik untuk berkembang secara profesional.`;
  }

  // "Describe a time / Tell us about a situation / STAR method questions"
  if (/describe.{0,30}time|tell.{0,20}about.{0,20}(?:time|situation|experience|instance|challenge)|ceritakan.{0,20}pengalaman/i.test(question)) {
    const exp = Array.isArray(profile.pengalaman_kerja) && profile.pengalaman_kerja[0]
      ? `${profile.pengalaman_kerja[0].title} di ${profile.pengalaman_kerja[0].company}`
      : 'proyek pengembangan sistem';
    return `Selama saya bekerja sebagai ${exp}, saya dihadapkan pada tantangan di mana tim membutuhkan solusi teknis yang cepat namun andal. Saya mengambil inisiatif untuk menganalisis root cause masalah, membuat rencana mitigasi, dan berkoordinasi dengan stakeholders untuk memastikan implementasi berjalan lancar. Hasilnya, masalah berhasil diselesaikan tepat waktu dan sistem berjalan lebih stabil. Pengalaman ini mengajarkan saya pentingnya komunikasi proaktif dan pendekatan sistematis dalam problem-solving.`;
  }

  // "What are your strengths / Kelebihan Anda"
  if (/strength|kelebihan|keunggulan|strength.{0,20}weakness/i.test(question)) {
    return `Kekuatan utama saya adalah kemampuan problem-solving teknis yang didukung oleh pemahaman mendalam tentang ${skills}. Saya terbiasa bekerja dengan deadline ketat, belajar teknologi baru dengan cepat, dan menghasilkan kode yang bersih dan terdokumentasi dengan baik. Selain itu, saya memiliki kemampuan komunikasi yang baik sehingga dapat menjelaskan solusi teknis kepada stakeholder non-teknis secara efektif.`;
  }

  // "What are your weaknesses / Kelemahan Anda"
  if (/weakness|kelemahan|kekurangan/i.test(question)) {
    return `Saya cenderung sangat detail-oriented, yang kadang membuat saya meluangkan lebih banyak waktu dari yang diperlukan untuk memastikan kualitas. Namun saya telah belajar untuk menyeimbangkan antara kesempurnaan dan efisiensi dengan menerapkan time-boxing dan memprioritaskan berdasarkan dampak bisnis. Ini justru membantu saya menghasilkan output yang lebih terstruktur dan terukur.`;
  }

  // "Where do you see yourself / Career goals / Tujuan karir"
  if (/where.{0,20}see.{0,20}yourself|career.{0,20}goal|5.{0,10}year|tujuan.{0,20}karir|rencana.{0,20}(?:karir|masa depan)/i.test(question)) {
    return `Dalam 3-5 tahun ke depan, saya ingin berkembang menjadi senior engineer yang tidak hanya handal secara teknis tetapi juga berkontribusi pada arsitektur sistem dan mentoring junior developers. Saya ingin terus mendalami ${skills} sambil memperluas kemampuan di area system design dan cloud infrastructure. Bergabung dengan perusahaan ini adalah langkah strategis untuk mencapai tujuan tersebut karena saya dapat belajar dari tim yang berpengalaman sekaligus memberikan kontribusi nyata.`;
  }

  // "Why should we hire you / Mengapa kami harus memilih Anda"
  if (/why\s+(?:should|hire|choose|pick)|mengapa\s+(?:kami|harus\s+memilih)/i.test(question)) {
    return `Saya membawa kombinasi unik antara keahlian teknis yang solid dalam ${skills} dan pengalaman membangun sistem production-ready yang skalabel. Saya adalah fast learner yang sudah terbukti mampu deliver dalam lingkungan dinamis, dan saya membawa mindset ownership — bukan sekadar menyelesaikan tugas, tapi memastikan solusi yang saya buat benar-benar berdampak positif bagi bisnis dan pengguna akhir.`;
  }

  // Default: jawaban generik berbasis profil untuk pertanyaan yang tidak dikenali
  return `Dengan latar belakang ${major} dari ${university} dan keahlian dalam ${skills}, saya memiliki fondasi teknis yang kuat untuk menjawab tantangan yang disebutkan. Saya selalu berorientasi pada solusi praktis, terbiasa bekerja secara kolaboratif, dan berkomitmen untuk terus belajar dan berkembang sesuai kebutuhan peran ini.`;
}

// ── Helper: cek apakah teks halaman mengandung konfirmasi sukses (makna, bukan literal) ──
function detectConfirmationText(text, url) {
  // Gunakan lowercase untuk matching, tapi simpan original untuk evidence
  const textLower = text.toLowerCase();
  const u = (url || '').toLowerCase();

  // Langkah 1: periksa negasi — jangan false positive karena "belum berhasil" dll
  const negationPattern = /(?:tidak|belum|gagal|failed|error|invalid|salah)\s+(?:berhasil|submitted|terkirim|diterima)/i;
  if (negationPattern.test(text)) return { confirmed: false, evidence: 'Teks mengandung negasi konfirmasi' };

  // Langkah 2: pola konfirmasi positif (bahasa Indonesia)
  const idPatterns = [
    /lamaran\s+(?:anda\s+)?(?:telah\s+)?(?:ter)?kirim/i,
    /terima\s+kasih\s+(?:telah|sudah)\s+melamar/i,
    /pendaftaran\s+(?:anda\s+)?berhasil/i,
    /kami\s+(?:telah\s+)?menerima\s+(?:lamaran|aplikasi)/i,
    /aplikasi\s+(?:anda\s+)?(?:sedang\s+)?(?:diproses|direview|diterima)/i,
    /respons\s+anda\s+telah\s+dicatat/i,
    /formulir\s+(?:berhasil\s+)?terkirim/i,
  ];
  // Langkah 3: pola konfirmasi positif (bahasa Inggris)
  const enPatterns = [
    /application\s+(?:has\s+been\s+)?(?:submitted|received|sent)/i,
    /thank\s+you\s+for\s+(?:applying|your\s+application)/i,
    /your\s+(?:response|application)\s+has\s+been\s+(?:recorded|received|sent)/i,
    /we(?:'ve|\s+have)\s+received\s+your\s+(?:application|response)/i,
    /application\s+successful/i,
    /successfully\s+(?:submitted|applied|sent)/i,
  ];

  for (const pattern of [...idPatterns, ...enPatterns]) {
    if (pattern.test(textLower)) return { confirmed: true, evidence: text.match(pattern)?.[0] || 'pola konfirmasi ditemukan' };
  }

  // Langkah 4: sinyal URL konfirmasi (bukan sekadar berubah URL)
  const confirmUrlPatterns = ['/success', '/confirmation', '/thank-you', '/thankyou', '/applied', '/submitted', '/done'];
  for (const p of confirmUrlPatterns) {
    if (u.includes(p)) return { confirmed: true, evidence: `URL konfirmasi: ${url}` };
  }

  return { confirmed: false, evidence: null };
}

// ── Core: Submit form dan verifikasi (strict, anti false-positive) ─────────
async function submitFormAndVerify(page, formType) {
  try {
    // Scroll ke bawah agar tombol submit visible
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await page.waitForTimeout(1000);

    // Cek validasi error SEBELUM submit — form kosong yang mau di-submit ulang
    const preSubmitErrors = await page.evaluate(() => {
      const errorEls = document.querySelectorAll(
        '[aria-invalid="true"], .error, .field-error, .has-error, [data-error], ' +
        '.freebirdFormviewerViewItemsItemErrorMessage'
      );
      return Array.from(errorEls)
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .map(el => el.textContent?.trim())
        .filter(Boolean)
        .slice(0, 5);
    }).catch(() => []);

    if (preSubmitErrors.length > 0) {
      return { submitted: false, reason: `Validasi error sebelum submit: ${preSubmitErrors.join('; ')}` };
    }

    // Simulasi gerakan mouse natural
    const viewportSize = page.viewportSize() || { width: 1280, height: 720 };
    await page.mouse.move(
      viewportSize.width * 0.4 + Math.random() * viewportSize.width * 0.2,
      viewportSize.height * 0.7 + Math.random() * viewportSize.height * 0.2
    );
    await page.waitForTimeout(400);

    // Cari tombol submit — Google Forms pakai [role="button"] bukan <button>
    const submitSelectors = [
      '[role="button"]:has-text("Kirim")',
      '[role="button"]:has-text("Submit")',
      '[role="button"]:has-text("Send")',
      'button:has-text("Kirim")',
      'button:has-text("Submit")',
      'button:has-text("Send")',
      'button:has-text("Apply")',
      'button:has-text("Lamar")',
      'button:has-text("Daftar")',
      'button[type="submit"]',
      'input[type="submit"]',
    ];

    let submitBtn = null;
    for (const sel of submitSelectors) {
      const el = page.locator(sel).first();
      if (await el.count() > 0) { submitBtn = el; break; }
    }

    if (!submitBtn) return { submitted: false, reason: 'Tombol submit tidak ditemukan' };

    await submitBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);

    // Hover lalu klik (natural, anti-bot-detection)
    const btnBox = await submitBtn.boundingBox().catch(() => null);
    if (btnBox) {
      await page.mouse.move(
        btnBox.x + btnBox.width * 0.3 + Math.random() * btnBox.width * 0.4,
        btnBox.y + btnBox.height * 0.2 + Math.random() * btnBox.height * 0.6
      );
      await page.waitForTimeout(300);
    }

    const urlBeforeSubmit = page.url();
    await submitBtn.click({ force: true });

    // ── MODUL DETEKSI SUBMISSION SUKSES ──────────────────────────────────
    // Langkah 1a: Untuk Google Forms — tunggu selector konfirmasi khusus
    // Selector konfirmasi HANYA yang muncul SETELAH submit, bukan yang sudah ada sebelumnya
    if (formType === 'google_form') {
      const gfConfirmSelectors = [
        '.freebirdFormviewerViewResponseConfirmationMessage',
        '.freebirdFormviewerViewResponseMessage',
        '[data-isresponsemessage="true"]',
        '.vHW8K',
        '.VHQTFd',
      ];
      let gfConfirmed = false;
      let gfEvidence = '';
      // Tunggu sampai 10 detik untuk konfirmasi Google Forms muncul
      for (const sel of gfConfirmSelectors) {
        try {
          await page.waitForSelector(sel, { timeout: 10000 });
          const el = page.locator(sel).first();
          gfEvidence = (await el.textContent().catch(() => ''))?.trim() || `Elemen konfirmasi Google Forms: ${sel}`;
          gfConfirmed = true;
          break;
        } catch {}
      }
      // Fallback: cek teks konfirmasi di body (lebih reliabel dari selector)
      if (!gfConfirmed) {
        const bodyText = await page.textContent('body').catch(() => '');
        const { confirmed, evidence: ev } = detectConfirmationText(bodyText, page.url());
        if (confirmed) { gfConfirmed = true; gfEvidence = ev; }
      }
      // Fallback 2: form container hilang setelah submit (Google Forms behavior)
      if (!gfConfirmed) {
        const formGone = await page.evaluate(() => {
          const formContainers = document.querySelectorAll(
            '.freebirdFormviewerViewItemsItemItem, [data-item-id]'
          );
          // Cek form container TIDAK ada (bukan hanya tersembunyi)
          return formContainers.length === 0;
        }).catch(() => false);
        if (formGone) {
          gfConfirmed = true;
          gfEvidence = 'Form container hilang setelah submit — Google Forms submitted';
        }
      }
      if (gfConfirmed) return { submitted: true, evidence: gfEvidence };
      // Tidak ada konfirmasi terdeteksi → ambiguous
      return {
        submitted: false,
        ambiguous: true,
        reason: 'Tidak ada konfirmasi Google Forms terdeteksi setelah 10 detik — perlu cek manual',
      };
    }

    // Langkah 1b: Untuk form non-Google — tunggu 5 detik lalu cek
    await page.waitForTimeout(5000);

    const currentUrl = page.url();
    const pageContent = await page.textContent('body').catch(() => '');

    // Langkah 2: Cek validasi error TERSEMBUNYI yang muncul SETELAH klik submit
    // (beberapa form JS baru validasi setelah submit diklik)
    const postSubmitErrors = await page.evaluate(() => {
      const errorEls = document.querySelectorAll(
        '[aria-invalid="true"], .error, .field-error, .has-error, [data-error], ' +
        '.freebirdFormviewerViewItemsItemErrorMessage, [class*="error-message"], ' +
        '[class*="validation-error"], [class*="form-error"]'
      );
      return Array.from(errorEls)
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .map(el => el.textContent?.trim())
        .filter(t => t && t.length > 0)
        .slice(0, 5);
    }).catch(() => []);

    if (postSubmitErrors.length > 0) {
      return { submitted: false, reason: `Validasi error setelah submit: ${postSubmitErrors.join('; ')}` };
    }

    // Langkah 3: Cek apakah form masih ada (halaman tidak berubah sama sekali = kemungkinan gagal)
    const formStillPresent = await page.evaluate(() => {
      const form = document.querySelector('form, [role="form"]');
      if (!form) return false;
      const rect = form.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).catch(() => false);

    // Langkah 4: Cek tombol submit berubah jadi disabled / "Applied"
    const submitBtnChanged = await page.evaluate(() => {
      const btns = document.querySelectorAll('button[type="submit"], input[type="submit"], [role="button"]');
      for (const btn of btns) {
        const txt = (btn.textContent || btn.value || '').toLowerCase();
        if (/applied|sudah\s+dilamar|lamaran\s+terkirim/i.test(txt)) return true;
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return true;
      }
      return false;
    }).catch(() => false);

    // Langkah 6: Deteksi teks konfirmasi (makna penuh, anti false-positive)
    const { confirmed, evidence } = detectConfirmationText(pageContent, currentUrl);
    if (confirmed) return { submitted: true, evidence };

    // Langkah 7: Jika URL berubah DAN form tidak ada lagi → indikasi sukses
    if (currentUrl !== urlBeforeSubmit && !formStillPresent) {
      // Pastikan bukan redirect ke homepage atau halaman error
      const isErrorPage = /error|404|not.?found|forbidden|access.?denied/i.test(pageContent.substring(0, 500));
      const isHomePage = currentUrl.replace(/\/$/, '') === new URL(currentUrl).origin;
      if (!isErrorPage && !isHomePage) {
        return { submitted: true, evidence: `Redirect ke: ${currentUrl} dan form tidak lagi tersedia` };
      }
    }

    // Langkah 8: Jika tombol submit disabled/berubah label → kemungkinan sukses
    if (submitBtnChanged) {
      return { submitted: true, evidence: 'Tombol submit berubah menjadi disabled atau label "Applied"' };
    }

    // Langkah 9: Ambigu — tidak ada sinyal ke arah manapun setelah 5 detik
    // Jangan tebak. Status = perlu review, bukan "Terkirim".
    return {
      submitted: false,
      ambiguous: true,
      reason: 'Konfirmasi tidak dapat diverifikasi otomatis setelah 5 detik — perlu cek manual',
    };

  } catch (err) {
    return { submitted: false, reason: err.message };
  }
}

// ── Helper: Build JSON log per lowongan (format standar UI queue) ──────────
function buildJobLog(job, status, alasan, fieldMapping = [], buktiKonfirmasi = null) {
  return {
    posisi: job.title || '',
    perusahaan: job.company || '',
    status,
    alasan,
    field_terisi: (fieldMapping || [])
      .filter(f => f.mappedValue || f.isEssay)
      .map(f => f.label || f.mappedKey)
      .filter(Boolean),
    bukti_konfirmasi: buktiKonfirmasi || null,
    timestamp: new Date().toISOString(),
  };
}

// ── Core: Generate cover letter (dipersonalisasi berdasarkan deskripsi lowongan) ────
async function generateCoverLetter(company, position, profile, jobContext = {}) {
  const name = profile.full_name || 'Wisnu Alfian Nur Ashar';
  const major = profile.major || 'Teknik Informatika';
  const university = profile.university || 'Universitas';
  const skillsRaw = profile.skills || 'programming, web development';
  const experience = profile.work_experience || '';

  // Identifikasi skill yang paling relevan dengan posisi/deskripsi lowongan
  const allSkills = Array.isArray(skillsRaw)
    ? skillsRaw
    : String(skillsRaw).split(/[,;\/\n]+/).map(s => s.trim()).filter(Boolean);

  const positionLower = (position + ' ' + (jobContext.description || '') + ' ' + (jobContext.qualifications || '')).toLowerCase();

  // Filter skill yang relevan dengan deskripsi lowongan (jika ada konteks)
  let relevantSkills = allSkills;
  if (jobContext.description || jobContext.qualifications) {
    const matched = allSkills.filter(s => positionLower.includes(s.toLowerCase().split(' ')[0]));
    if (matched.length >= 2) relevantSkills = matched;
  }
  const skillsStr = relevantSkills.slice(0, 5).join(', ');

  // Identifikasi pengalaman paling relevan
  const expLines = [];
  if (Array.isArray(profile.pengalaman_kerja)) {
    for (const exp of profile.pengalaman_kerja.slice(0, 2)) {
      if (exp.title && exp.company) expLines.push(`${exp.title} di ${exp.company}`);
    }
  } else if (experience) {
    expLines.push(experience);
  }
  const expStr = expLines.length > 0 ? expLines.join(' dan ') : 'pengembangan sistem berbasis teknologi informasi';

  // Tentukan konteks spesifik lowongan untuk paragraf pertama
  const jobType = jobContext.work_type
    ? ` (${jobContext.work_type})`
    : '';
  const locationNote = jobContext.location && jobContext.location !== 'tidak disebutkan'
    ? ` yang berlokasi di ${jobContext.location}`
    : '';

  // Paragraf motivasi: personalisasi jika ada deskripsi tugas
  let motivationParagraph = '';
  if (jobContext.description && jobContext.description.length > 30) {
    const descSnippet = jobContext.description.substring(0, 120).replace(/\s+/g, ' ').trim();
    motivationParagraph = `\nBerdasarkan deskripsi pekerjaan yang menyebutkan "${descSnippet}...", saya yakin pengalaman saya dalam ${skillsStr} sangat relevan untuk mendukung kebutuhan tim ${company}.\n`;
  }

  return `Kepada Yth. Tim Rekrutmen ${company},

Dengan hormat, saya ${name}, mahasiswa ${major} dari ${university}, dengan ini mengajukan lamaran untuk posisi ${position}${jobType}${locationNote} di ${company}.

Saya memiliki keahlian teknis dalam ${skillsStr}, serta pengalaman profesional di bidang ${expStr}. ${motivationParagraph}
Saya adalah individu yang berorientasi pada hasil, terbiasa bekerja dalam lingkungan kolaboratif maupun mandiri, dan memiliki komitmen tinggi terhadap kualitas pekerjaan. Saya sangat tertarik untuk berkontribusi dan bertumbuh bersama ${company}.

Saya terbuka untuk berdiskusi lebih lanjut mengenai bagaimana latar belakang saya dapat memberikan nilai tambah bagi perusahaan Bapak/Ibu.

Terima kasih atas perhatian dan kesempatan yang diberikan.

Hormat saya,
${name}
${profile.phone || ''}
${profile.email || ''}
${profile.linkedin_url || profile.linkedin || ''}`.replace(/\n{3,}/g, '\n\n').trim();
}

// ── Core: Auto-fill form (router) ──────────────────────────────────────────
async function autoFillForm(page, fieldMapping, coverLetter, formType, emitFn, profile) {
  if (formType === 'google_form') {
    await fillGoogleForm(page, fieldMapping, coverLetter, emitFn, profile);
  } else {
    await fillGenericForm(page, fieldMapping, coverLetter, profile, emitFn);
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
