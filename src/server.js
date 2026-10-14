import express from 'express';
import path from 'path';
import fs from 'fs';
import helmet from 'helmet';
import cors from 'cors';
import multer from 'multer';
import { createRateLimiters } from './middleware/rate-limit.js';
import contextCache from './context-cache.js';
import * as enterprise from './enterprise-auth.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import JSZip from 'jszip';
const _require = createRequire(import.meta.url);
// pdf-parse v2 (2.4.x) exports class PDFParse, bukan function seperti v1.
// Load defensif agar tetap jalan walau struktur export berubah.
let PDFParseClass = null;
try {
  const _pdfMod = _require('pdf-parse');
  PDFParseClass = _pdfMod?.PDFParse || _pdfMod?.default?.PDFParse || _pdfMod?.default || null;
  if (typeof PDFParseClass !== 'function' || !PDFParseClass.prototype?.getText) {
    // Bukan class v2 yang valid — anggap tidak tersedia, fallback ke ekstraksi mentah.
    if (typeof PDFParseClass !== 'function') PDFParseClass = null;
  }
} catch {
  PDFParseClass = null;
}

import config from '../config/config.js';
import AIManager, { WANAR_SYSTEM_PROMPT, WANAR_SYSTEM_PROMPT_WEB, WANAR_VOICE_PROMPT } from './ai-manager.js';
import * as db from './database.js';
import { getToolDefinitions, executeTool } from './tools/registry.js';
import * as providerRegistry from './providers/registry.js';
import * as auth from './auth.js';
import ContextManager from './context-manager.js';
import ragEngine from './rag/index.js';
import graphStore from './rag/graph-store.js';
import { DistributedCoordinator } from './distributed.js';
import * as securityScanner from './security-scanner.js';
import * as jobAgent from './tools/job-agent.js';
import { agentEvents } from './tools/job-agent.js';
import generator from './generator/project-generator.js';
import * as authMonitor from './security/auth-monitor.js';
import * as actionGate from './security/action-gate.js';
import { authorizeTarget, getScope } from './security/scan-guard.js';
import { runLoadTest, validateRateLimit, LIMITS as LOAD_LIMITS } from './security/load-test.js';
import { closeVisibleBrowser, getLiveBrowserState } from './tools/browser.js';
import { lintRuleSet, reviewRuleSetWithAI, MAX_RULE_SET_CHARS } from './prompt-lab.js';
import { getPoolStats } from './providers/http-client.js';
import sqliteDb from './database.js';
import { initAutomation } from './automation/runtime.js';
import { createAutomationRouter } from './automation/routes.js';
import { initWorklog } from './worklog/index.js';
import { createWorklogRouter } from './worklog/routes.js';
import { initEmailDesk } from './email-desk/index.js';
import { createEmailDeskRouter } from './email-desk/routes.js';
import { createBriefing } from './briefing.js';
import { createCommandCenterRouter } from './command-center/routes.js';
import { createOwnerContext, createTelegramTranscript } from './memory/owner-context.js';
import { makeAssistantResponder } from './worklog/assistant.js';

const coordinator = new DistributedCoordinator();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = config.server.port;
const aiManager = new AIManager();

// Automation (scheduler + bulk email). Constructed here, started in startServer().
const automation = initAutomation({ db: sqliteDb, aiManager });

// Work journal (jam kerja, tugas, keuangan, laporan, evaluasi). Shares the
// Telegram bot: adds owner-only commands and gives the AI chat today's context.
const worklog = initWorklog({ db: sqliteDb, aiManager, automation });
// One shared memory: the Telegram AI sees the journal, automation and past
// chats (web + Telegram), and its own conversations become chat sessions too.
// Email Desk: draft/send email from Telegram, watch replies (IMAP IDLE), auto-reply policy.
const emailDesk = initEmailDesk({ db: sqliteDb, aiManager, automation });
// Morning briefing (schedule, reminders, email, tasks) — built from data, no AI call.
const briefing = createBriefing({
  worklog: worklog.service,
  desk: emailDesk.desk,
  defaultChatId: () => String(process.env.TELEGRAM_AI_CHAT_IDS || '').split(',')[0]?.trim() || null,
  notify: automation.channels.has('telegram')
    ? async (chatId, text) => {
      const tg = automation.channels.get('telegram');
      if (tg.mode !== 'live') throw new Error('Telegram belum dikonfigurasi');
      await tg.send({ to: chatId, text });
    }
    : null,
});
automation.inbox.registerCommands(briefing.commands());
const ownerContext = createOwnerContext({ db: sqliteDb, automation, worklog });
const telegramTranscript = createTelegramTranscript({ db: sqliteDb });
// The owner's plain messages go to an assistant that can also ACT (reminders,
// journal, schedule) through a validated whitelist — one model call per message.
automation.inbox.responder = makeAssistantResponder({
  aiManager,
  worklog: worklog.service,
  emailDesk: emailDesk.desk,
  briefing,
  context: ({ text, chatId }) => ownerContext({ text, excludeSessionId: chatId ? telegramTranscript.sessionId(chatId) : null }),
});
automation.inbox.onExchange = (e) => telegramTranscript.record(e);
automation.inbox.loadHistory = (chatId) => telegramTranscript.history(chatId);

// ==================== MULTER FILE UPLOAD CONFIG ====================
const ALLOWED_MIMETYPES = new Set([
  // Text files
  'text/plain', 'text/csv', 'text/html', 'text/css', 'text/javascript',
  'text/markdown', 'text/x-python', 'text/x-java',
  'application/json', 'application/xml', 'text/xml',
  // Code files
  'application/javascript', 'application/x-javascript', 'application/typescript',
  'application/x-python-code', 'application/x-yaml', 'application/x-sh',
  'application/x-httpd-php',
  // Documents
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  // Images
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/tiff',
  // Archives
  'application/zip', 'application/x-tar', 'application/gzip', 'application/x-rar-compressed',
  'application/x-7z-compressed',
  // Browser fallback saat drag-drop / OS tidak mengenal tipe file
  'application/octet-stream',
]);

// Ekstensi yang diizinkan — dipakai sebagai fallback bila browser mengirim
// mimetype generik (mis. application/octet-stream atau string kosong).
const ALLOWED_EXTENSIONS = new Set([
  'txt','md','markdown','csv','json','xml','yaml','yml','js','jsx','ts','tsx',
  'py','java','cpp','c','cc','cxx','cs','html','htm','css','scss','less','sql',
  'sh','bash','bat','cmd','ps1','env','gitignore','toml','ini','cfg','conf',
  'log','rs','go','rb','php','swift','kt','kts','r','m','h','hpp','vue','svelte',
  'pdf','doc','docx','odt','rtf','ppt','pptx','odp','xls','xlsx','ods',
  'png','jpg','jpeg','gif','webp','svg','bmp','tiff','tif',
  'zip','tar','gz','tgz','rar','7z',
]);

const TEXT_EXTS = new Set([
  'txt','md','markdown','csv','json','xml','yaml','yml','js','jsx','ts','tsx',
  'py','java','cpp','c','cc','cxx','cs','html','htm','css','scss','less','sql',
  'sh','bash','bat','cmd','ps1','env','gitignore','toml','ini','cfg','conf',
  'log','rs','go','rb','php','swift','kt','kts','r','m','h','hpp','vue','svelte',
]);

const MAX_FILE_CHARS = 80000;

function getFileExt(originalname) {
  const base = String(originalname || '').split(/[\\/]/).pop() || '';
  const parts = base.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function isAllowedFile(mimetype, originalname) {
  const ext = getFileExt(originalname);
  if (ext && ALLOWED_EXTENSIONS.has(ext)) return true;
  if (mimetype && ALLOWED_MIMETYPES.has(mimetype)) return true;
  if (mimetype && (mimetype.startsWith('text/') || mimetype.startsWith('image/'))) return true;
  return false;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB max
    files: 1 // Only allow single file upload
  },
  fileFilter: (req, file, cb) => {
    // Validate filename (prevent path traversal + null bytes)
    const name = file.originalname || '';
    if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0')) {
      return cb(new Error('Invalid filename: path traversal detected'));
    }

    // Limit filename length
    if (name.length > 255 || name.length === 0) {
      return cb(new Error('Filename tidak valid (maks 255 karakter)'));
    }

    // Validate mimetype + extension (extension wins — banyak browser kirim octet-stream)
    if (!isAllowedFile(file.mimetype, name)) {
      const ext = getFileExt(name);
      return cb(new Error(
        `Tipe file "${file.mimetype || 'unknown'}${ext ? ' (.' + ext + ')' : ''}" tidak didukung. ` +
        'Didukung: PDF, Word/Excel/PowerPoint, gambar (JPG/PNG/WebP), teks & kode, ZIP.'
      ));
    }

    cb(null, true);
  }
});

/**
 * Normalisasi teks hasil ekstraksi agar akurat & enak dibaca LLM:
 * - satukan line ending, perbaiki ligatur PDF (ﬁ→fi), hapus zero-width/BOM
 * - sambung kata terpotong tanda hubung di akhir baris ("meningkat-\nkan" → "meningkatkan")
 * - rapikan spasi berlebih tanpa menghilangkan struktur paragraf/tabel
 */
function normalizeExtractedText(raw) {
  if (!raw) return '';
  let t = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Ligatur umum dari PDF
  t = t
    .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬀ/g, 'ff')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ/g, 'ft')
    .replace(/ﬆ/g, 'st').replace(/œ/g, 'oe').replace(/Œ/g, 'OE')
    .replace(/æ/g, 'ae').replace(/Æ/g, 'AE');
  // Karakter tak terlihat
  t = t.replace(/\uFEFF/g, '').replace(/[\u200B\u200C\u200D\u2060]/g, '').replace(/\u00A0/g, ' ');
  t = t.replace(/[\u2028\u2029]/g, '\n');
  // Sambung kata terpotong: "transfor-\nmasi" → "transformasi"
  t = t.replace(/(\p{L})-\n(\p{L})/gu, '$1$2');
  // Baris PDF sering dipecah per kata — satukan baris pendek yang jelas satu paragraf?
  // (Konservatif: hanya rapikan spasi, JANGAN gabung baris agar tabel/list tidak rusak.)
  t = t.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').replace(/\s+$/g, '')).join('\n');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

function truncateSmart(text, max = MAX_FILE_CHARS) {
  if (text.length <= max) return { text, truncated: false };
  // Potong di batas paragraf/baris agar tidak memenggal kalimat.
  let cut = text.lastIndexOf('\n\n', max);
  if (cut < max * 0.5) cut = text.lastIndexOf('\n', max);
  if (cut < max * 0.5) cut = text.lastIndexOf(' ', max);
  if (cut < max * 0.5) cut = max;
  return {
    text: text.slice(0, cut).trimEnd() + `\n\n...[dipotong: ${text.length.toLocaleString('id-ID')} karakter total, menampilkan ${cut.toLocaleString('id-ID')} pertama]`,
    truncated: true,
  };
}

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ''; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } });
}

// ---------- Office Open XML via JSZip (akurat, UTF-8 benar) ----------

async function extractDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  // document.xml + header/footer/footnote/endnote/comment agar teks lengkap
  const targets = ['word/document.xml'];
  for (const p of Object.keys(zip.files)) {
    if (/^word\/(header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(p)) targets.push(p);
  }
  const paras = [];
  for (const name of targets) {
    const f = zip.file(name);
    if (!f) continue;
    const xml = await f.async('string');
    // Tiap <w:p> = 1 paragraf; di dalamnya gabung <w:t> + tab/line-break.
    const pRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
    let pm;
    let foundPara = false;
    while ((pm = pRegex.exec(xml)) !== null) {
      foundPara = true;
      const pXml = pm[0];
      const parts = [];
      const tRegex = /<(w:t|w:tab|w:br|w:noBreakHyphen)[^>]*\/?(?:>(.*?)<\/(w:t))?>/g;
      let tm;
      while ((tm = tRegex.exec(pXml)) !== null) {
        const tag = tm[1];
        if (tag === 'w:t') parts.push(decodeXmlEntities(tm[2] || ''));
        else if (tag === 'w:tab') parts.push('\t');
        else if (tag === 'w:br') parts.push('\n');
        else if (tag === 'w:noBreakHyphen') parts.push('-');
      }
      const line = parts.join('').replace(/[ \t]+/g, ' ').trim();
      if (line) paras.push(line);
    }
    // Fallback: dokumen tanpa <w:p> (sangat jarang) → ambil semua <w:t>
    if (!foundPara) {
      const all = [];
      const tAll = /<w:t[^>]*>(.*?)<\/w:t>/g;
      let ta;
      while ((ta = tAll.exec(xml)) !== null) {
        const s = decodeXmlEntities(ta[1]).trim();
        if (s) all.push(s);
      }
      if (all.length) paras.push(all.join(' '));
    }
  }
  return paras.join('\n\n');
}

async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => parseInt(a.match(/slide(\d+)/)[1], 10) - parseInt(b.match(/slide(\d+)/)[1], 10));
  const out = [];
  let n = 0;
  for (const name of slides) {
    n += 1;
    const xml = await zip.file(name).async('string');
    const texts = [];
    const tRegex = /<a:t[^>]*>(.*?)<\/a:t>/g;
    let m;
    while ((m = tRegex.exec(xml)) !== null) {
      const s = decodeXmlEntities(m[1]).trim();
      if (s) texts.push(s);
    }
    if (texts.length) out.push(`--- Slide ${n} ---\n${texts.join('\n')}`);
  }
  return out.join('\n\n');
}

async function extractXlsx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  // 1) Shared strings
  let shared = [];
  const ssFile = zip.file('xl/sharedStrings.xml');
  if (ssFile) {
    const xml = await ssFile.async('string');
    const siRegex = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRegex.exec(xml)) !== null) {
      const inner = m[1];
      const tParts = [];
      const tRegex = /<t[^>]*>(.*?)<\/t>/g;
      let tm;
      while ((tm = tRegex.exec(inner)) !== null) tParts.push(decodeXmlEntities(tm[1]));
      shared.push(tParts.join(''));
    }
  }
  // 2) Sheet names
  const sheetNames = {};
  const wbFile = zip.file('xl/workbook.xml');
  if (wbFile) {
    const xml = await wbFile.async('string');
    const shRegex = /<sheet[^>]*name="([^"]+)"[^>]*sheetId="(\d+)"[^>]*\/>|<sheet[^>]*sheetId="(\d+)"[^>]*name="([^"]+)"[^>]*\/>|<sheet[^>]*>/g;
    // Parse sederhana: ambil name + r:id berurutan
    const names = [...xml.matchAll(/name="([^"]+)"/g)].map((x) => decodeXmlEntities(x[1]));
    const sheetFiles = Object.keys(zip.files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
      .sort((a, b) => parseInt(a.match(/sheet(\d+)/)[1], 10) - parseInt(b.match(/sheet(\d+)/)[1], 10));
    sheetFiles.forEach((sf, i) => { sheetNames[sf] = names[i] || `Sheet${i + 1}`; });
  }
  // 3) Cell values per sheet
  const sheetFiles = Object.keys(zip.files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => parseInt(a.match(/sheet(\d+)/)[1], 10) - parseInt(b.match(/sheet(\d+)/)[1], 10));
  const out = [];
  for (const sf of sheetFiles) {
    const xml = await zip.file(sf).async('string');
    const rows = [];
    const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRegex.exec(xml)) !== null) {
      const rowXml = rm[1];
      const cells = [];
      // Catatan: JANGAN pakai pola lazy + grup opsional untuk atribut t
      // (mis. /<c[^>]*?(?:t="...")?/) — regex seperti itu selalu match kosong
      // dan membuat sel shared-string terbaca sebagai indeks mentah ("0","1").
      // Parse atribut dulu, baru isi sel.
      const cRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cRegex.exec(rowXml)) !== null) {
        const attrs = cm[1] || '';
        const inner = cm[2] || '';
        const tMatch = attrs.match(/\bt="([^"]*)"/);
        const t = tMatch ? tMatch[1] : '';
        let val = '';
        if (t === 's') {
          const idx = parseInt((inner.match(/<v>(.*?)<\/v>/) || [])[1] || '-1', 10);
          val = shared[idx] ?? '';
        } else if (t === 'inlineStr') {
          const tm = inner.match(/<t[^>]*>(.*?)<\/t>/);
          val = decodeXmlEntities(tm ? tm[1] : '');
        } else if (t === 'b') {
          val = (inner.match(/<v>(.*?)<\/v>/) || [])[1] === '1' ? 'TRUE' : 'FALSE';
        } else if (t === 'e' || t === 'str' || t === 'n' || t === '') {
          const vm = inner.match(/<v>(.*?)<\/v>/);
          val = vm ? decodeXmlEntities(vm[1]) : '';
        }
        cells.push(val);
      }
      // Buang baris kosong
      if (cells.some((c) => String(c).trim() !== '')) rows.push(cells.join('\t'));
      if (rows.length > 2000) break; // batas aman per sheet
    }
    if (rows.length) out.push(`--- ${sheetNames[sf] || sf} ---\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}

// ---------- PDF via pdf-parse v2 (API class, bukan function) ----------

async function extractPdf(buffer, originalname) {
  if (!PDFParseClass) {
    // Fallback mentah: ambil string printable dari stream PDF
    return { text: '', pages: null, engine: 'none', note: 'PDF engine tidak tersedia' };
  }
  let parser = null;
  try {
    const data = Buffer.isBuffer(buffer) ? new Uint8Array(buffer) : buffer;
    parser = new PDFParseClass({ data, verbosity: 0 });
    const result = await parser.getText();
    let text = normalizeExtractedText(result?.text || '');
    const pages = result?.total || result?.pages?.length || null;
    // pdf-parse v2 menambah penanda "-- N of M --" di tiap halaman.
    // Untuk PDF 1 halaman penanda itu hanya noise — buang agar akurat & bersih.
    if (pages === 1) {
      text = text.replace(/^\s*--\s*1\s+of\s+1\s*--\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    }
    return { text, pages, engine: 'pdfjs', note: '' };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/password|encrypted|decrypt/i.test(msg)) {
      const err = new Error(`PDF "${originalname}" terproteksi password — buka kunci dulu lalu upload ulang.`);
      err.code = 'PDF_LOCKED';
      throw err;
    }
    throw new Error(`Gagal membaca PDF: ${msg.slice(0, 200)}`);
  } finally {
    try { await parser?.destroy(); } catch { /* abaikan */ }
  }
}

// ---------- OCR gambar via tesseract.js (lazy, dengan timeout) ----------

async function ocrImage(buffer, timeoutMs = 25000) {
  const { default: Tesseract } = await import('tesseract.js');
  const job = Tesseract.recognize(buffer, 'ind+eng');
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('OCR timeout')), timeoutMs)
  );
  const result = await Promise.race([job, timeout]);
  const text = normalizeExtractedText(result?.data?.text || '');
  return text;
}

// ---------- Arsip ZIP (daftar + ekstrak file teks di dalamnya) ----------

async function extractZip(buffer, originalname) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  if (names.length === 0) return `[Arsip ${originalname}: kosong]`;
  const textable = names.filter((n) => {
    const ext = n.split('.').pop().toLowerCase();
    return TEXT_EXTS.has(ext) || ext === 'txt' || ext === 'md' || ext === 'csv' || ext === 'json';
  }).slice(0, 20);
  const parts = [`[Arsip ${originalname}: ${names.length} file]`, ...names.slice(0, 100).map((n) => `- ${n}`)];
  if (names.length > 100) parts.push(`... dan ${names.length - 100} file lainnya`);
  const extracted = [];
  for (const n of textable) {
    try {
      const f = zip.file(n);
      if (!f) continue;
      const buf = await f.async('nodebuffer');
      if (buf.length > 500 * 1024) { extracted.push(`\n\n--- ${n} (dilewati: >500KB) ---`); continue; }
      if (buf.includes(0)) continue; // biner
      let t = normalizeExtractedText(buf.toString('utf8'));
      if (t.trim().length < 1) continue;
      if (t.length > 10000) t = t.slice(0, 10000) + '\n...[dipotong per file]';
      extracted.push(`\n\n--- ${n} ---\n${t}`);
    } catch { /* lewati file rusak */ }
  }
  return parts.join('\n') + extracted.join('');
}

/**
 * Extract text content from uploaded file buffer.
 * Mengembalikan STRING (kompatibel dengan kode lama).
 */
async function extractFileContent(buffer, mimetype, originalname) {
  const result = await extractFileContentDetailed(buffer, mimetype, originalname);
  return result.content;
}

/**
 * Versi detail: { content, pages, truncated, charCount, engine }
 * Dipakai endpoint /api/upload agar frontend dapat metadata akurat.
 */
async function extractFileContentDetailed(buffer, mimetype, originalname) {
  const ext = getFileExt(originalname);
  const mime = mimetype || '';
  const kb = (buffer.length / 1024).toFixed(1);

  // Plain text / code — deteksi biner (byte NUL) agar tidak ngaco
  if (TEXT_EXTS.has(ext) || mime.startsWith('text/') || ['application/json','application/xml','application/javascript','application/typescript','application/x-yaml','application/x-sh'].some((t) => mime.startsWith(t))) {
    if (buffer.includes(0)) {
      return { content: `[File: ${originalname}, ${kb}KB. File biner — tidak bisa dibaca sebagai teks.]`, pages: null, truncated: false, charCount: 0, engine: 'none' };
    }
    let text = buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    text = normalizeExtractedText(text);
    const { text: out, truncated } = truncateSmart(text);
    return { content: out, pages: null, truncated, charCount: text.length, engine: 'utf8' };
  }

  // SVG adalah XML teks
  if (ext === 'svg' || mime === 'image/svg+xml') {
    const text = normalizeExtractedText(buffer.toString('utf8'));
    const { text: out, truncated } = truncateSmart(text);
    return { content: out, pages: null, truncated, charCount: text.length, engine: 'svg' };
  }

  // Images — OCR agar teks di dalam gambar tetap terbaca akurat
  if (mime.startsWith('image/') || ['png','jpg','jpeg','gif','webp','bmp','tiff','tif'].includes(ext)) {
    if (buffer.length > 8 * 1024 * 1024) {
      return { content: `[Gambar ${originalname}, ${kb}KB. Terlalu besar untuk OCR (maks 8MB).]`, pages: null, truncated: false, charCount: 0, engine: 'none' };
    }
    try {
      const ocr = await ocrImage(buffer);
      if (ocr.trim().length >= 10) {
        const { text: out, truncated } = truncateSmart(ocr);
        return { content: `--- OCR ${originalname} ---\n${out}`, pages: null, truncated, charCount: ocr.length, engine: 'tesseract' };
      }
      return { content: `[Gambar ${originalname}, ${kb}KB. Tidak ada teks terdeteksi (OCR kosong).]`, pages: null, truncated: false, charCount: 0, engine: 'tesseract-empty' };
    } catch {
      return { content: `[Gambar ${originalname}, ${kb}KB, tipe: ${mime || ext}. OCR gagal — gambar diteruskan sebagai visual saja.]`, pages: null, truncated: false, charCount: 0, engine: 'none' };
    }
  }

  // PDF — ekstraksi teks akurat via pdf-parse v2
  if (mime === 'application/pdf' || ext === 'pdf') {
    const { text, pages } = await extractPdf(buffer, originalname);
    if (text.trim().length > 50) {
      const { text: out, truncated } = truncateSmart(text);
      const head = pages ? `[PDF ${originalname}: ${pages} halaman, ${text.length.toLocaleString('id-ID')} karakter]\n\n` : '';
      return { content: head + out, pages, truncated, charCount: text.length, engine: 'pdf-parse-v2' };
    }
    if (text.trim().length > 0) {
      // Sedikit teks (<50 char) — kemungkinan PDF pindaian
      const head = pages ? `[PDF ${originalname}: ${pages} halaman — tampaknya hasil pindaian (scan), teks minim]\n\n` : '';
      return { content: head + text + `\n\n[Catatan: PDF ini kemungkinan hasil scan. Untuk hasil akurat, upload versi teks atau jalankan OCR terlebih dulu.]`, pages, truncated: false, charCount: text.length, engine: 'pdf-parse-v2-scan' };
    }
    const pageInfo = pages ? ` (${pages} halaman)` : '';
    return { content: `[PDF ${originalname}${pageInfo}, ${kb}KB. Tidak ada teks yang bisa diekstrak — kemungkinan hasil pindaian (scan) atau terproteksi. Coba: (1) upload versi teks/asli, (2) jalankan OCR, atau (3) pastikan tidak terproteksi password.]`, pages, truncated: false, charCount: 0, engine: 'pdf-empty' };
  }

  // Office Open XML — DOCX/PPTX/XLSX akurat via JSZip
  if (['docx','pptx','xlsx'].includes(ext) ||
      mime.includes('wordprocessingml') ||
      mime.includes('presentationml') ||
      mime.includes('spreadsheetml')) {
    try {
      let text = '';
      let engine = '';
      if (ext === 'docx' || mime.includes('wordprocessingml')) { text = await extractDocx(buffer); engine = 'jszip-docx'; }
      else if (ext === 'pptx' || mime.includes('presentationml')) { text = await extractPptx(buffer); engine = 'jszip-pptx'; }
      else { text = await extractXlsx(buffer); engine = 'jszip-xlsx'; }
      text = normalizeExtractedText(text);
      if (text.trim().length > 20) {
        const { text: out, truncated } = truncateSmart(text);
        return { content: out, pages: null, truncated, charCount: text.length, engine };
      }
    } catch (e) {
      // jatuh ke fallback di bawah
    }
    return { content: `[File Office ${originalname}, ${kb}KB. Tidak bisa mengekstrak teks — file mungkin rusak atau kosong.]`, pages: null, truncated: false, charCount: 0, engine: 'office-empty' };
  }

  // Legacy MS Office (OLE: .doc/.xls/.ppt) + ODT/RTF — best effort strings
  if (['doc','xls','ppt','odt','rtf'].includes(ext) || ['application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint'].includes(mime)) {
    try {
      // .doc legacy menyimpan teks UTF-16LE; coba decode lalu ambil runtunan terbaca
      const u16 = buffer.toString('utf16le');
      const latin = buffer.toString('latin1');
      const collect = (s) => (s.match(/[\p{L}\p{N}\p{P}][\p{L}\p{N}\p{P} ]{3,}/gu) || []).map((x) => x.trim()).filter((x) => x.length >= 4);
      const cands = [...collect(u16), ...collect(latin)];
      // Buang sampah biner: hanya simpan yang mayoritas huruf/angka
      const clean = [...new Set(cands)].filter((s) => {
        const letters = (s.match(/[\p{L}\p{N}]/gu) || []).length;
        return letters / Math.max(1, s.length) > 0.5 && s.length < 500;
      }).slice(0, 2000);
      const text = normalizeExtractedText(clean.join('\n'));
      if (text.trim().length > 50) {
        const { text: out, truncated } = truncateSmart(text);
        return { content: `[Dokumen lama ${originalname} — ekstraksi best-effort, akurasi tidak 100%]\n\n${out}`, pages: null, truncated, charCount: text.length, engine: 'legacy-strings' };
      }
    } catch { /* abaikan */ }
    return { content: `[Dokumen ${originalname}, ${kb}KB. Format lama (.${ext}) — konversi ke DOCX/PDF agar terbaca 100% akurat.]`, pages: null, truncated: false, charCount: 0, engine: 'legacy-empty' };
  }

  // ZIP / archives — daftar isi + ekstrak file teks di dalamnya
  if (['zip'].includes(ext) || mime === 'application/zip') {
    try {
      const content = await extractZip(buffer, originalname);
      const { text: out, truncated } = truncateSmart(normalizeExtractedText(content));
      return { content: out, pages: null, truncated, charCount: content.length, engine: 'jszip' };
    } catch {
      return { content: `[Arsip ${originalname}, ${kb}KB. Tidak bisa membaca isi arsip — file mungkin rusak.]`, pages: null, truncated: false, charCount: 0, engine: 'zip-error' };
    }
  }
  if (['tar','gz','tgz','rar','7z'].includes(ext)) {
    return { content: `[Arsip ${originalname}, ${kb}KB. Format .${ext} belum didukung ekstraksi — kompres sebagai .zip agar bisa dibaca.]`, pages: null, truncated: false, charCount: 0, engine: 'none' };
  }

  // Fallback
  return { content: `[File: ${originalname}, tipe: ${mime || ext || 'unknown'}, ukuran: ${kb}KB. Format biner — konten tidak bisa diekstrak sebagai teks.]`, pages: null, truncated: false, charCount: 0, engine: 'none' };
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Allow inline scripts for React
      styleSrc: ["'self'", "'unsafe-inline'"], // Allow inline styles
      imgSrc: ["'self'", "data:", "https:"], // Allow images from data URIs and HTTPS
      connectSrc: ["'self'"], // Restrict API connections to same origin
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Keep disabled for compatibility
  crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow cross-origin resources
  dnsPrefetchControl: { allow: false },
  frameguard: { action: 'deny' }, // Prevent clickjacking
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  },
  ieNoOpen: true,
  noSniff: true, // Prevent MIME type sniffing
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  xssFilter: true,
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
}));

app.use(express.json({ limit: '15mb' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Request body terlalu besar. Maks 15MB. Kurangi ukuran file/lampiran.' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Invalid JSON in request body.' });
  }
  next(err);
});

const rateLimiters = createRateLimiters();

// Trust exactly one hop of proxy when deployed behind IIS/ARR (see web.config),
// so req.ip reflects the real client rather than the proxy. Set TRUST_PROXY=0
// when the Node process is exposed directly, otherwise a client could spoof its
// own address via X-Forwarded-For and evade rate limiting.
app.set('trust proxy', parseInt(process.env.TRUST_PROXY || '1', 10));

app.use(rateLimiters.global);
app.use(authMonitor.requestAudit);

const clientDist = path.join(__dirname, '../client/dist');
// Hashed assets can be cached hard, but index.html must never be cached —
// otherwise browsers keep serving an old build after a deploy.
app.use(express.static(clientDist, {
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (/[-.][0-9a-zA-Z_]{8,}\.(js|css)$/.test(path.basename(filePath))) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
}));

const ctxManager = new ContextManager({
  maxTurns: config.context?.maxTurns || 20,
  maxContextTokens: config.context?.maxContextTokens || 131072,
});

const MAX_CHAT_MSG_CHARS = 200000;

function sanitize(str) {
  if (typeof str !== 'string') return '';
  // JANGAN strip <...> — merusak kode/XML (<div>, Array<string>, dsb).
  // Frontend sudah escape HTML user (escapeHtml) + sanitasi HTML asisten,
  // jadi backend cukup buang NUL dan batasi panjang.
  return str.replace(/\0/g, '').slice(0, MAX_CHAT_MSG_CHARS);
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function validateChatBody(body) {
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return { valid: false, error: 'messages array is required' };
  }
  if (body.messages.length > 100) {
    return { valid: false, error: 'Too many messages. Max 100.' };
  }
  for (const msg of body.messages) {
    if (!msg.role || !['user', 'assistant', 'system'].includes(msg.role)) {
      return { valid: false, error: 'Invalid message role' };
    }
    if (typeof msg.content !== 'string' || msg.content.length > MAX_CHAT_MSG_CHARS) {
      return { valid: false, error: `Message content too long (max ${MAX_CHAT_MSG_CHARS} chars)` };
    }
  }
  const validProviders = ['openagentic', 'nvidia', 'puter', 'vector', 'openrouter'];
  if (body.provider && !validProviders.includes(body.provider)) {
    return { valid: false, error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` };
  }
  return { valid: true };
}

function checkTokenLimit() {
  const today = new Date().toISOString().slice(0, 10);
  const usage = db.getDailyUsage(today);
  if (usage.total >= config.tokens.dailyLimit) {
    return { blocked: true, usage };
  }
  return { blocked: false, usage };
}

const ESTIMATED_COST_PER_TOKEN = {
  nvidia: 1.0 / 1e6,
  puter: 0,
  // Model gratis OpenRouter (auto-switch) tidak dikenai biaya.
  openrouter: 0,
};

function estimateCost(provider, tokens) {
  return tokens * (ESTIMATED_COST_PER_TOKEN[provider] || 0);
}

async function saveMessagesToDb(sessionId, messages, newAssistantContent, tokens, provider, model) {
  const existing = db.getMessages(sessionId);
  const existingCount = existing.length;

  const newMessages = messages.slice(existingCount);

  for (const msg of newMessages) {
    db.addMessage(sessionId, msg.role, msg.content, 0, provider, model);
  }

  db.addMessage(sessionId, 'assistant', newAssistantContent, tokens, provider, model);
}

// ==================== FILE UPLOAD ENDPOINT ====================

// Bungkus multer agar error (tipe file, ukuran, dsb) selalu JSON 400 yang jelas,
// bukan 500/HTML generik yang membuat frontend hanya tampil "[Failed to read]".
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ success: false, error: 'File terlalu besar. Maksimal 20MB per file.' });
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ success: false, error: 'Upload satu file per request (field "file").' });
        }
        return res.status(400).json({ success: false, error: `Upload gagal: ${err.message}` });
      }
      return res.status(400).json({ success: false, error: err.message || 'Upload gagal' });
    }
    next();
  });
}

app.post('/api/upload', handleUpload, asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded (field "file" wajib diisi)' });
  }

  const { buffer, mimetype, originalname, size } = req.file;

  try {
    const detailed = await extractFileContentDetailed(buffer, mimetype, originalname);
    const content = detailed.content;

    // For images, also return base64 for potential vision use (batasi 5MB agar respons tidak jumbo)
    let imageData = null;
    if ((mimetype && mimetype.startsWith('image/')) && buffer.length <= 5 * 1024 * 1024) {
      imageData = `data:${mimetype};base64,${buffer.toString('base64')}`;
    }

    // Preview = first 500 chars
    const preview = content.length > 500 ? content.slice(0, 500) + '...' : content;

    res.json({
      success: true,
      name: originalname,
      type: mimetype,
      size,
      content,
      preview,
      imageData,
      pages: detailed.pages ?? null,
      charCount: detailed.charCount ?? content.length,
      truncated: Boolean(detailed.truncated),
      engine: detailed.engine || null,
    });
  } catch (err) {
    if (err.code === 'PDF_LOCKED') {
      return res.status(422).json({ success: false, error: err.message });
    }
    res.status(500).json({ success: false, error: `Failed to process file: ${err.message}` });
  }
}));

// ==================== BROWSER AGENT ENDPOINT ====================

app.post('/api/browse', asyncHandler(async (req, res) => {
  const { url, action = 'open', query, filter, extract = 'text', wait_for, timeout = 30, scroll = false } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'url is required' });
  }

  // Lazy import to avoid startup delay
  const { executeBrowserTool } = await import('./tools/browser.js');

  let result;
  if (action === 'search') {
    result = await executeBrowserTool('browser_search_page', { url, query, context_chars: 300 });
  } else if (action === 'links') {
    result = await executeBrowserTool('browser_extract_links', { url, filter });
  } else {
    result = await executeBrowserTool('browser_open', { url, extract, wait_for, timeout, scroll });
  }

  res.json(result);
}));

// ==================== PROFILE & APPLY HISTORY ENDPOINTS ====================

app.get('/api/profile', asyncHandler(async (req, res) => {
  const { getProfile } = await import('./database.js');
  const profile = getProfile();
  res.json({ success: true, profile: profile || {} });
}));

app.post('/api/profile', asyncHandler(async (req, res) => {
  const { saveProfile } = await import('./database.js');
  const profile = saveProfile(req.body);
  res.json({ success: true, profile });
}));

app.get('/api/apply-history', asyncHandler(async (req, res) => {
  const { getApplyHistory } = await import('./database.js');
  const history = getApplyHistory(100);
  res.json({ success: true, history });
}));

app.patch('/api/apply-history/:id', asyncHandler(async (req, res) => {
  const { updateApplyStatus } = await import('./database.js');
  const { status, notes } = req.body;
  const record = updateApplyStatus(req.params.id, status, notes);
  res.json({ success: true, record });
}));

app.get('/api/config', (req, res) => {
  res.json({
    providers: ['openagentic', 'nvidia', 'puter', 'vector', 'openrouter'],
    defaultProvider: config.defaultProvider,
    openagentic: {
      models: config.openagentic.models.map(m => ({
        id: m.id || m,
        label: m.label || m.id || m,
        family: m.family || 'Unknown',
        rec: m.rec || false,
        tags: m.tags || [],
      })),
      defaultModel: config.openagentic.defaultModel,
      maxTokens: config.openagentic.maxTokens,
      configured: Boolean(config.openagentic.apiKey),
    },
    nvidia: {
      models: config.nvidia.models.map(m => ({ id: m.id || m, label: m.label || m.id || m, family: m.family || '', rec: m.rec || false, tags: m.tags || [] })),
      defaultModel: config.nvidia.defaultModel,
      maxTokens: config.nvidia.maxTokens,
      keyCount: config.nvidia.apiKeys?.length || 1,
    },
    puter: {
      models: config.puter.models.map(m => ({ id: m.id || m, label: m.label || m.id || m, rec: m.rec || false, tags: m.tags || [] })),
      defaultModel: config.puter.defaultModel,
      enabled: config.puter.enabled,
    },
    vector: {
      models: config.vector.models.map(m => ({ id: m.id || m, label: m.label || m.id || m, family: m.family || '', rec: m.rec || false, tags: m.tags || [] })),
      defaultModel: config.vector.defaultModel,
      maxTokens: config.vector.maxTokens,
    },
    openrouter: {
      models: ((config.openrouter || {}).models || []).map(m => ({ id: m.id || m, label: m.label || m.id || m, family: m.family || '', rec: m.rec || false, tags: m.tags || [] })),
      defaultModel: (config.openrouter || {}).defaultModel,
      maxTokens: (config.openrouter || {}).maxTokens,
      configured: Boolean((config.openrouter || {}).apiKey),
      autoSwitchFree: (config.openrouter || {}).autoSwitchFree !== false,
      freeModels: (config.openrouter || {}).freeModels,
    },
    tokens: { dailyLimit: config.tokens.dailyLimit, dailyCostLimit: config.tokens.dailyCostLimit },
    context: { maxTurns: config.context?.maxTurns || 20 },
    rag: { enabled: config.rag?.enabled || false },
  });
});

app.get('/api/sessions', (req, res) => {
  const sessions = db.getSessions(parseInt(req.query.limit) || 50);
  res.json(sessions);
});

app.post('/api/sessions', (req, res) => {
  const { id, title, provider, model, messages } = req.body;
  const sessionId = id || crypto.randomUUID();
  const existing = db.getSessions(1000).find(s => s.id === sessionId);

  if (!existing) {
    const sessionTitle = title || (messages && messages.length > 0 ? messages[0].content.slice(0, 60) : 'New Chat');
    db.createSession(sessionId, sessionTitle, provider || config.defaultProvider, model || '');
  }

  if (messages && Array.isArray(messages)) {
    db.deleteMessages(sessionId);
    for (const msg of messages) {
      db.addMessage(sessionId, msg.role, sanitize(msg.content).slice(0, 50000), msg.tokens || 0, provider, model);
    }
  }

  res.json({ id: sessionId });
});

/** Deletes abandoned sessions that contain no messages. Never touches real chats. */
app.post('/api/sessions/cleanup', rateLimiters.automation || rateLimiters.strict, (req, res) => {
  const deleted = db.deleteEmptySessions(0);
  res.json({ success: true, deleted });
});

app.get('/api/sessions/:id', (req, res) => {
  const messages = db.getMessages(req.params.id);
  res.json({ id: req.params.id, messages });
});

app.delete('/api/sessions/:id', (req, res) => {
  db.deleteSession(req.params.id);
  res.json({ success: true });
});
app.patch('/api/sessions/:id', (req, res) => {
  const { title } = req.body;
  if (title) db.updateSessionTitle(req.params.id, sanitize(title).slice(0, 200));
  res.json({ success: true });
});

// ==================== TOOL APPROVAL (HUMAN-IN-THE-LOOP) ====================
//
// The agent cannot execute side-effecting tools without a human approval bound
// to the exact tool + target. These endpoints are the human-facing half of that
// gate. See src/security/action-gate.js for the model.

/** List the tools that require approval, plus any pending approvals. */
app.get('/api/tool-approvals', (req, res) => {
  res.json({
    success: true,
    gatedTools: Object.keys(actionGate.GATED_TOOLS),
    pending: actionGate.listApprovals(),
    ttlMs: actionGate.config.approvalTtlMs,
  });
});

/**
 * Approve a specific (tool, target) pair.
 *
 * The approval is single-use and expires. `target` must match exactly what the
 * agent will pass, because the gate binds the authorization to it.
 */
app.post('/api/tool-approvals', rateLimiters.strict, (req, res) => {
  const { tool, target, reason } = req.body || {};
  if (!tool || !target) {
    return res.status(400).json({ success: false, error: 'tool and target are required' });
  }
  if (!actionGate.GATED_TOOLS[tool]) {
    return res.status(400).json({
      success: false,
      error: `Tool "${tool}" is not gated and does not require approval.`,
    });
  }

  // Out-of-scope targets are refused at mint time so the operator gets the bad
  // news immediately instead of after the agent retries and fails.
  const scope = actionGate.checkTargetScope(tool, target);
  if (!scope.allowed) {
    return res.status(403).json({ success: false, error: scope.reason, code: scope.code });
  }

  const approval = actionGate.mintApproval({
    tool,
    target,
    reason,
    approvedBy: req.user?.email || req.user?.id || 'operator',
  });
  authMonitor.recordAdminAction(req, 'tool_approval_granted', { tool, target });
  res.status(201).json({ success: true, approval });
});

/** Revoke a pending approval. */
app.delete('/api/tool-approvals/:id', (req, res) => {
  const removed = actionGate.revokeApproval(req.params.id);
  res.json({ success: removed });
});

// ==================== END TOOL APPROVAL ====================

// ==================== AUTOMATION ====================
app.use('/api/automation', createAutomationRouter({
  automation,
  rateLimiters,
  actorOf: (req) => req.user?.email || String(req.user?.id || 'operator'),
}));
// ==================== END AUTOMATION ====================

// ==================== WORK JOURNAL ====================
app.use('/api/worklog', createWorklogRouter({ worklog, rateLimiters }));
app.use('/api/email-desk', createEmailDeskRouter({ emailDesk, rateLimiters }));
app.use('/api/command-center', createCommandCenterRouter({ worklog, emailDesk, automation, briefing, rateLimiters }));

app.get('/api/sessions/:id/messages', (req, res) => {
  const messages = db.getMessages(req.params.id);  res.json({ messages });
});

app.post('/api/chat', rateLimiters.chat, asyncHandler(async (req, res) => {
  const validation = validateChatBody(req.body);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }

  const limitCheck = checkTokenLimit();
  if (limitCheck.blocked) {
    return res.status(429).json({
      success: false,
      error: `Daily token limit of ${(config.tokens.dailyLimit / 1e6).toFixed(0)}M reached. Please wait until reset.`,
    });
  }

  let provider = req.body.provider || config.defaultProvider;
  let model = req.body.model;
  const messages = req.body.messages.map(m => ({ role: m.role, content: sanitize(m.content) }));
  const sessionId = req.body.session_id;

  let tokenContext = '';
  try {
    const today = new Date().toISOString().slice(0, 10);
    const usage = db.getDailyUsage(today);
    const limit = config.tokens?.dailyLimit || 500000;
    const remaining = Math.max(0, limit - (usage.total || 0));
    const pct = ((usage.total || 0) / limit * 100).toFixed(1);
    tokenContext = `\n\nKONTEKS TOKEN HARI INI (${today}):\n- Total dipakai: ${usage.total || 0} token\n- Sisa: ${remaining} token (${pct}% terpakai)\n- Limit harian: ${limit} token\n- Biaya hari ini: Rp ${(usage.cost || 0).toLocaleString('id-ID')}`;
  } catch (_) {}

  const { messages: truncatedMessages } = ctxManager.getTruncatedMessages(
    messages, model, WANAR_SYSTEM_PROMPT_WEB + tokenContext
  );

  const cacheKey = `chat:${provider}:${model || 'default'}:${truncatedMessages.slice(-2).map(m => m.content.slice(0, 100)).join('|')}`;
  const cached = contextCache.get(cacheKey);
  if (cached && req.body.useCache !== false) {
    return res.json({ ...cached, cached: true });
  }

  const tools = getToolDefinitions();
  let result;
  if (provider === 'openagentic') {
    result = await aiManager.openagenticProvider.chat(truncatedMessages, { model, tools, systemPrompt: WANAR_SYSTEM_PROMPT_WEB + tokenContext });
  } else if (provider === 'nvidia') {
    result = await aiManager.nvidiaProvider.chat(truncatedMessages, { model, tools, top_p: req.body.top_p ?? 1, seed: req.body.seed });
  } else if (provider === 'vector') {
    result = await aiManager.vectorProvider.chat(truncatedMessages, { model, tools });
  } else if (provider === 'openrouter') {
    result = await aiManager.openrouterProvider.chat(truncatedMessages, { model, tools });
  } else {
    const customProvider = providerRegistry.createDynamicProvider(provider);
    if (customProvider) {
      result = await customProvider.chat(truncatedMessages, { model, tools, ...req.body });
    } else {
      return res.status(400).json({ success: false, error: `Provider ${provider} tidak dikenal` });
    }
  }

  // Failover (hemat): when the chosen provider fails (quota, key, outage),
  // walk the shared failover chain — skipping providers already known dead —
  // for at most 5 attempts. Follow-up tool calls then use the provider that worked.
  if (!result?.success && aiManager.providers[provider]) {
    aiManager._handleFailover({ provider, model }, result?.error || 'error');
    let tries = 0;
    for (const cand of aiManager.failover.buildChain(provider, model)) {
      if (tries >= 5) break;
      if (cand.provider === provider && cand.model === model) continue;
      if (aiManager.failover.shouldSkip(cand.provider, cand.model)) continue;
      const inst = aiManager.providers[cand.provider];
      if (!inst?.chat || (typeof inst.isAvailable === 'function' && !inst.isAvailable())) continue;
      tries++;
      const alt = await inst.chat(truncatedMessages, { model: cand.model, tools, systemPrompt: WANAR_SYSTEM_PROMPT_WEB + tokenContext });
      if (alt?.success) {
        aiManager.failover.markSuccess(cand.provider, cand.model);
        result = alt;
        provider = cand.provider;
        model = cand.model;
        break;
      }
      aiManager._handleFailover(cand, alt?.error || 'error');
    }
  }

  if (result && result.success) {
    let finalContent = result.content || '';
    let totalUsage = result.usage || { total_tokens: 0 };

    if (result.tool_calls && result.tool_calls.length > 0) {
      let toolMessages = [...truncatedMessages];
      let tcCount = 0;
      const maxTC = 25;
      let currentResult = result;

      while (currentResult.tool_calls && currentResult.tool_calls.length > 0 && tcCount < maxTC) {
        tcCount++;
        toolMessages.push({
          role: 'assistant',
          content: currentResult.content || null,
          tool_calls: currentResult.tool_calls,
        });

        for (const tc of currentResult.tool_calls) {
          if (tc.type !== 'function') continue;
          const { name, arguments: rawArgs } = tc.function;
          let args;
          try { args = JSON.parse(rawArgs); } catch { args = {}; }
          const toolResult = await executeTool(name, args);
          const resultStr = JSON.stringify(toolResult);
          toolMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: resultStr.length > 8000 ? resultStr.slice(0, 8000) + '\n...(truncated)' : resultStr,
          });
        }

        const providerCall = async (msgs) => {
          if (provider === 'openagentic') return aiManager.openagenticProvider.chat(msgs, { model, tools, systemPrompt: WANAR_SYSTEM_PROMPT_WEB + tokenContext });
          if (provider === 'nvidia') return aiManager.nvidiaProvider.chat(msgs, { model, tools, top_p: req.body.top_p ?? 1, seed: req.body.seed });
          if (provider === 'vector') return aiManager.vectorProvider.chat(msgs, { model, tools });
          if (provider === 'openrouter') return aiManager.openrouterProvider.chat(msgs, { model, tools });
          if (aiManager.providers[provider]?.chat) return aiManager.providers[provider].chat(msgs, { model, tools, systemPrompt: WANAR_SYSTEM_PROMPT_WEB + tokenContext });
          const cp = providerRegistry.createDynamicProvider(provider);
          if (cp) return cp.chat(msgs, { model, tools, ...req.body });
          return null;
        };

        currentResult = await providerCall(toolMessages);
        if (!currentResult || !currentResult.success) break;
      }

      if (currentResult && currentResult.success && currentResult.content) {
        finalContent = currentResult.content;
        totalUsage = currentResult.usage || totalUsage;
      }
    }

    const tokens = totalUsage?.total_tokens || Math.round(finalContent.length * 1.3);
    const date = new Date().toISOString().slice(0, 10);
    db.recordTokenUsage(date, provider, model || 'unknown', tokens, estimateCost(provider, tokens));

    if (sessionId) {
      saveMessagesToDb(sessionId, messages, finalContent, tokens, provider, model);
    }

    const responseResult = { success: true, content: finalContent, model: result.model, usage: totalUsage, provider };
    contextCache.set(cacheKey, responseResult, 60000);
    res.json(responseResult);
  } else {
    // Kegagalan upstream (model/kuota) bukan kesalahan server → 429/502 agar
    // klien bisa membedakan "coba lagi nanti" dari "server rusak".
    const upstream = Number(result?.code);
    const status = (upstream === 429 || upstream === 402 || result?.daily_quota) ? 429 : 502;
    res.status(status).json(result || { success: false, error: 'Failed to get response' });
  }
}));

app.post('/api/chat/stream', rateLimiters.chat, asyncHandler(async (req, res) => {
  const validation = validateChatBody(req.body);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }

  const limitCheck = checkTokenLimit();
  if (limitCheck.blocked) {
    return res.status(429).json({
      success: false,
      error: `Daily token limit of ${(config.tokens.dailyLimit / 1e6).toFixed(0)}M reached.`,
    });
  }

  const provider = req.query.provider || req.body.provider || config.defaultProvider;
  const model = req.query.model || req.body.model;
  const messages = req.body.messages.map(m => ({ role: m.role, content: sanitize(m.content) }));
  const sessionId = req.body.session_id || null;

  let systemPrompt = req.body.voice ? WANAR_VOICE_PROMPT : WANAR_SYSTEM_PROMPT_WEB;

  if (ragEngine.enabled && ragEngine.initialized) {
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (lastUserMsg) {
      const cacheKey = `rag:${lastUserMsg.content.slice(0, 200)}`;
      const ragContext = await contextCache.getOrSetAsync(
        cacheKey,
        () => ragEngine.buildRAGContext(lastUserMsg.content, 3) || '',
        120000
      );
      if (ragContext) {
        systemPrompt += '\n\nAnda memiliki akses ke kode project berikut:\n' + ragContext;
        systemPrompt += '\nGunakan kode di atas untuk menjawab pertanyaan terkait codebase. Jika tidak relevan, abaikan.';
      }
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let clientDisconnected = false;
  
  // Detect client disconnect
  req.on('close', () => {
    clientDisconnected = true;
  });

  req.on('error', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
      clientDisconnected = true;
    }
  });

  const sendEvent = (event, data) => {
    if (clientDisconnected || res.writableEnded) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch (err) {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
        clientDisconnected = true;
      }
      return false;
    }
  };

  let fullContent = '';
  let totalTokens = 0;
  const startTime = Date.now();
  const inputChars = messages.reduce((s, m) => s + m.content.length, 0);
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';

  try {
    const stream = aiManager.chatWithTools(messages, {
      provider,
      model,
      systemPrompt,
      voiceMode: Boolean(req.body.voice),
      voice: Boolean(req.body.voice),
      // Jawaban suara wajib pendek (1-3 kalimat): batasi output agar stream selesai cepat.
      maxTokens: req.body.voice ? 2000 : req.body.maxTokens,
      top_p: req.body.top_p ?? 1,
      seed: req.body.seed,
    });

    for await (const chunk of stream) {
      // Stop streaming if client disconnected
      if (clientDisconnected) {
        console.log('[Stream] Client disconnected, stopping stream');
        break;
      }

      if (chunk.type === 'content') {
        fullContent += chunk.content;
        if (!sendEvent('token', { content: chunk.content })) break;
      } else if (chunk.type === 'tool_start') {
        if (!sendEvent('tool_start', { name: chunk.name, args: chunk.args })) break;
      } else if (chunk.type === 'tool_end') {
        if (!sendEvent('tool_end', { name: chunk.name, result: chunk.result })) break;
      } else if (chunk.type === 'provider_switch') {
        if (!sendEvent('provider_switch', {
          from: chunk.from, to: chunk.to, model: chunk.model,
          reason: chunk.reason, attempt: chunk.attempt, reset: chunk.reset,
        })) break;
      } else if (chunk.type === 'error') {
        sendEvent('error', { message: chunk.content });
      } else if (chunk.type === 'done') {
        break;
      }
    }

    if (!clientDisconnected) {
      totalTokens = Math.round(fullContent.length * 1.3);
      const date = new Date().toISOString().slice(0, 10);
      db.recordTokenUsage(date, provider, model || 'unknown', totalTokens, estimateCost(provider, totalTokens));

      if (sessionId && fullContent) {
        saveMessagesToDb(sessionId, messages, fullContent, totalTokens, provider, model);
      }

      sendEvent('done', { tokens: totalTokens });
    }

    const elapsed = Date.now() - startTime;
    db.logRequest({
      session_id: sessionId,
      provider,
      model: model || 'unknown',
      ip: clientIP,
      input_chars: inputChars,
      output_chars: fullContent.length,
      total_tokens: totalTokens || Math.round(fullContent.length * 1.3),
      response_time_ms: elapsed,
      tokens_per_second: elapsed > 0 ? Math.round((totalTokens / (elapsed / 1000)) * 100) / 100 : 0,
      status: clientDisconnected ? 'client_disconnect' : 'ok',
    });
  } catch (error) {
    if (!clientDisconnected && !res.writableEnded) {
      sendEvent('error', { message: error.message || 'Stream error' });
      sendEvent('done', {});
    }
    const elapsed = Date.now() - startTime;
    db.logRequest({
      session_id: sessionId,
      provider,
      model: model || 'unknown',
      ip: clientIP,
      input_chars: inputChars,
      output_chars: 0,
      total_tokens: 0,
      response_time_ms: elapsed,
      tokens_per_second: 0,
      status: 'error: ' + (error.message || '').slice(0, 50),
    });
  } finally {
    // Safe cleanup
    if (!res.writableEnded) {
      try {
        res.end();
      } catch (err) {
        // Connection already closed, ignore
      }
    }
  }
}));

app.get('/api/token-usage', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const daily = db.getDailyUsage(today);
  const limit = config.tokens.dailyLimit;
  const remaining = Math.max(0, limit - daily.total);
  const percent = Math.min(100, ((daily.total / limit) * 100));
  const history = db.getUsageHistory(30);

  res.json({
    today: {
      total: daily.total,
      cost: daily.cost,
      limit,
      remaining,
      percent: Math.round(percent * 100) / 100,
      providers: daily.providers,
      models: daily.models,
    },
    history: history.map(h => ({ date: h.date, total: h.total, cost: h.cost })),
  });
});

app.get('/api/tools', (req, res) => {
  res.json({ tools: getToolDefinitions() });
});

app.post('/api/tools/execute', rateLimiters.strict, asyncHandler(async (req, res) => {
  const { name, args } = req.body;
  if (!name || !args) return res.status(400).json({ error: 'name and args required' });
  const result = await executeTool(name, args);
  res.json({ name, args, result });
}));

app.get('/api/providers', (req, res) => {
  const providers = providerRegistry.getProviders();
  const safe = {};
  for (const [name, prov] of Object.entries(providers)) {
    safe[name] = { ...prov, apiKey: prov.apiKey ? '••••••' + prov.apiKey.slice(-4) : null };
  }
  res.json({ providers: safe, failover: aiManager.failover?.stats?.() || null });
});

app.post('/api/providers/test', rateLimiters.strict, asyncHandler(async (req, res) => {
  const { baseUrl, apiKey, model, format } = req.body;
  if (!baseUrl || !apiKey || !model) return res.status(400).json({ success: false, error: 'baseUrl, apiKey, and model required' });
  const result = await providerRegistry.testProviderConnection(baseUrl, apiKey, model, { format });
  res.json(result);
}));

app.post('/api/providers', rateLimiters.strict, asyncHandler(async (req, res) => {
  const { name, ...provConfig } = req.body;
  if (!name || !provConfig.baseUrl || !provConfig.apiKey) {
    return res.status(400).json({ success: false, error: 'name, baseUrl, and apiKey required' });
  }
  const result = await providerRegistry.addProvider(name, provConfig);
  res.status(result.success ? 201 : 400).json(result);
}));

app.delete('/api/providers/:name', (req, res) => {
  const result = providerRegistry.removeProvider(req.params.name);
  res.json(result);
});

app.post('/api/providers/:name/models', asyncHandler(async (req, res) => {
  const { modelId, modelLabel } = req.body;
  if (!modelId) return res.status(400).json({ success: false, error: 'modelId required' });
  const result = await providerRegistry.addModel(req.params.name, modelId, modelLabel);
  res.status(result.success ? 201 : 400).json(result);
}));

app.delete('/api/providers/:name/models/:modelId', (req, res) => {
  const result = providerRegistry.removeModel(req.params.name, req.params.modelId);
  res.json(result);
});

app.get('/api/models', (req, res) => {
  const registryModels = providerRegistry.getAllModels();
  res.json({
    builtin: {
      nvidia: config.nvidia.models.map(m => ({ id: m.id, provider: 'nvidia' })),
      puter: config.puter.models.map(m => ({ id: m.id, provider: 'puter' })),
    },
    custom: registryModels,
  });
});

app.get('/api/analytics', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  res.json(db.getAnalytics(hours));
});

app.post('/api/chat/rag', rateLimiters.rag, asyncHandler(async (req, res) => {
  if (!ragEngine.initialized) {
    return res.status(400).json({ success: false, error: 'RAG tidak diaktifkan. Set RAG_ENABLED=true dan rebuild index.' });
  }

  const { query, maxResults } = req.body;
  if (!query) return res.status(400).json({ success: false, error: 'query required' });

  const results = ragEngine.retrieve(query, { maxResults: maxResults || 10 });
  res.json({ success: true, query, results });
}));

app.post('/api/rag/query', rateLimiters.rag, asyncHandler(async (req, res) => {
  if (!ragEngine.initialized) {
    return res.status(400).json({ success: false, error: 'RAG belum di-index. Panggil POST /api/rag/reindex dulu.' });
  }

  const { query, maxResults } = req.body;
  if (!query) return res.status(400).json({ success: false, error: 'query required' });

  const results = ragEngine.retrieve(query, { maxResults: maxResults || 5 });
  const context = ragEngine.buildRAGContext(query, maxResults || 5);

  res.json({
    success: true,
    query,
    results,
    context,
    stats: ragEngine.getStats(),
  });
}));

app.post('/api/rag/reindex', asyncHandler(async (req, res) => {
  const { workspaceDir } = req.body;
  ragEngine.enabled = true;
  const result = await ragEngine.reindex(workspaceDir);
  coordinator.invalidateCache('rag:*');
  contextCache.invalidateByPrefix('rag');
  coordinator.broadcast({ type: 'reindex', files: result.files, chunks: result.chunks });
  res.json({ success: !result.error, ...result });
}));

app.get('/api/rag/status', (req, res) => {
  res.json(ragEngine.getStats());
});

app.post('/api/rag/codegraph', asyncHandler(async (req, res) => {
  const { filePath } = req.body;
  if (filePath) {
    res.json({
      dependencies: ragEngine.indexer.codeGraph?.getDependencies(filePath) || [],
      dependents: ragEngine.indexer.codeGraph?.getDependents(filePath) || [],
      functions: ragEngine.indexer.codeGraph?.getFunctions(filePath) || [],
      classes: ragEngine.indexer.codeGraph?.getClasses(filePath) || [],
      related: ragEngine.indexer.codeGraph?.getRelatedFiles(filePath, 1) || [],
      graph: {
        depCount: graphStore ? graphStore.getStats().totalEdges : 0,
      },
    });
  } else {
    res.json(ragEngine.getCodeGraph());
  }
}));

app.get('/api/rag/graph/stats', (req, res) => {
  res.json(graphStore.getStats());
});

app.get('/api/rag/graph/symbols', (req, res) => {
  const { name, pattern } = req.query;
  if (name) {
    res.json(graphStore.findSymbol(name));
  } else if (pattern) {
    res.json(graphStore.searchSymbols(pattern, parseInt(req.query.limit) || 20));
  } else {
    res.json(graphStore.getStats());
  }
});

app.get('/api/rag/graph/related', (req, res) => {
  const { filePath, depth } = req.query;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  const related = graphStore.getRelatedFiles(filePath, parseInt(depth) || 1);
  const dependencies = graphStore.getDependencies(filePath);
  const dependents = graphStore.getDependents(filePath);
  res.json({ filePath, related, dependencies, dependents });
});

app.get('/api/rag/graph/shortest-path', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const path = graphStore.shortestPath(from, to);
  res.json({ from, to, path, length: path ? path.length : 0 });
});

app.get('/api/rag/graph/components', (req, res) => {
  const components = graphStore.findConnectedComponents();
  res.json({
    total: components.length,
    components: components.map((c, i) => ({
      index: i,
      size: c.length,
      files: c.map(n => n.rel_path || n.file_path),
    })),
  });
});

app.get('/api/rag/git', (req, res) => {
  res.json(ragEngine.getGitInfo());
});

app.get('/api/rag/git/diff', (req, res) => {
  const base = req.query.base || 'HEAD';
  res.json(ragEngine.git.getDiff({ base }));
});

app.get('/api/rag/git/branch-diff', (req, res) => {
  const target = req.query.target || 'main';
  res.json(ragEngine.git.getBranchDiff(target));
});

app.get('/api/rag/git/log', (req, res) => {
  const count = parseInt(req.query.count) || 10;
  res.json(ragEngine.git.getLog(count));
});

app.delete('/api/rag/index', (req, res) => {
  ragEngine.indexer.clear();
  res.json({ success: true, message: 'RAG index cleared' });
});

app.get('/api/health', (req, res) => {
  const limitCheck = checkTokenLimit();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    tokenLimitReached: limitCheck.blocked,
    providers: {
      openagentic: { available: Boolean(aiManager.openagenticProvider.isAvailable()), configured: Boolean(config.openagentic.apiKey) },
      nvidia: { available: Boolean(aiManager.nvidiaProvider.isAvailable()), keyCount: aiManager.nvidiaProvider.getKeyCount?.() || 1 },
    },
    context: {
      maxTurns: config.context?.maxTurns || 20,
    },
    rag: ragEngine.getStats(),
    cluster: coordinator.redisAvailable ? { instances: coordinator.getInstanceCount(), redisConnected: true } : { standalone: true },
    httpPool: getPoolStats(),
  });
});

app.get('/api/cluster', (req, res) => {
  const stats = coordinator.getStats();
  // Never echo a Redis URL that may embed credentials.
  const redactedRedis = typeof stats.redisUrl === 'string'
    ? stats.redisUrl.replace(/(:\/\/[^:@/]*):[^@/]*@/, '$1:****@')
    : stats.redisUrl;
  res.json({
    instanceId: stats.instanceId,
    mode: stats.redisAvailable ? 'distributed' : 'standalone',
    instances: stats.instances,
    instanceList: stats.instanceList,
    redis: redactedRedis,
  });
});

app.post('/api/cluster/broadcast', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  coordinator.broadcast(message);
  res.json({ success: true, instanceId: coordinator.instanceId, message });
});

app.get('/api/cluster/cache/flush', (req, res) => {
  coordinator.invalidateCache('*');
  contextCache.flushAll();
  res.json({ success: true, message: 'Cache invalidated across cluster' });
});

app.get('/api/cache/stats', (req, res) => {
  res.json(contextCache.getStats());
});

app.post('/api/cache/flush', (req, res) => {
  const { prefix } = req.body;
  if (prefix) {
    const count = contextCache.invalidateByPrefix(prefix);
    res.json({ success: true, invalidated: count, prefix });
  } else {
    contextCache.flushAll();
    res.json({ success: true, message: 'All cache flushed' });
  }
});

app.post('/api/auth/google', rateLimiters.auth, asyncHandler(async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ success: false, error: 'idToken required' });
  const result = await auth.loginWithGoogle(idToken);
  if (result.success) authMonitor.recordLoginSuccess(req, result.user, 'google');
  else authMonitor.recordLoginFailure(req, result.error || 'invalid_google_token', undefined, 'google');
  res.status(result.success ? 200 : 401).json(result);
}));

app.post('/api/auth/api-key', rateLimiters.auth, (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ success: false, error: 'apiKey required' });
  const user = db.getUserByApiKey(apiKey);
  if (!user) {
    authMonitor.recordLoginFailure(req, 'invalid_api_key', undefined, 'api_key');
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }
  authMonitor.recordLoginSuccess(req, user, 'api_key');
  const jwtToken = jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    auth.JWT_SECRET_FINAL,
    { algorithm: auth.JWT_ALGORITHM, expiresIn: '7d' }
  );
  res.json({ success: true, token: jwtToken, user });
});

app.get('/api/auth/profile', rateLimiters.auth, auth.authMiddleware, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true, user });
});

app.get('/api/auth/admin/users', rateLimiters.auth, auth.authMiddleware, auth.adminOnly, (req, res) => {
  const users = db.getAllUsers();
  res.json({ success: true, users });
});

app.patch('/api/auth/admin/users/:id/role', rateLimiters.auth, auth.authMiddleware, auth.adminOnly, (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin', 'superadmin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const targetId = parseInt(req.params.id);
  db.updateUserRole(targetId, role);
  authMonitor.recordAdminAction(req, 'update_user_role', { userId: targetId, role });
  res.json({ success: true });
});

app.get('/api/auth/admin/security/events', rateLimiters.auth, auth.authMiddleware, auth.adminOnly, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  res.json({
    success: true,
    stats: authMonitor.getStats(),
    events: authMonitor.getRecentEvents(limit),
  });
});

// ==================== ANALYTICS API ENDPOINTS ====================

// GET /api/analytics/summary - Total summary (requests, tokens, cost, avg response time)
app.get('/api/analytics/summary', (req, res) => {
  const days = parseInt(req.query.days) || 14;
  const summary = db.getAnalyticsSummary(days);
  res.json({ success: true, data: summary });
});

// GET /api/analytics/daily - Daily usage data for charts
app.get('/api/analytics/daily', (req, res) => {
  const days = parseInt(req.query.days) || 14;
  const dailyData = db.getAnalyticsDailyUsage(days);
  res.json({ success: true, data: dailyData });
});

// GET /api/analytics/by-model - Breakdown by model
app.get('/api/analytics/by-model', (req, res) => {
  const days = parseInt(req.query.days) || 14;
  const modelData = db.getAnalyticsByModel(days);
  res.json({ success: true, data: modelData });
});

// GET /api/analytics/by-provider - Breakdown by provider
app.get('/api/analytics/by-provider', (req, res) => {
  const days = parseInt(req.query.days) || 14;
  const providerData = db.getAnalyticsByProvider(days);
  res.json({ success: true, data: providerData });
});

// GET /api/analytics/logs - Detailed logs with filters
app.get('/api/analytics/logs', (req, res) => {
  const filters = {
    startDate: req.query.startDate,
    endDate: req.query.endDate,
    model: req.query.model,
    provider: req.query.provider,
    limit: parseInt(req.query.limit) || 100,
    offset: parseInt(req.query.offset) || 0
  };
  
  const logs = db.getAnalyticsLogs(filters);
  res.json({ success: true, data: logs });
});

// GET /api/analytics/models - Get list of available models for filter
app.get('/api/analytics/models', (req, res) => {
  const models = db.getAnalyticsModels();
  res.json({ success: true, data: models });
});

// GET /api/analytics/providers - Get list of available providers for filter
app.get('/api/analytics/providers', (req, res) => {
  const providers = db.getAnalyticsProviders();
  res.json({ success: true, data: providers });
});

// GET /api/analytics/export - Export to CSV
app.get('/api/analytics/export', (req, res) => {
  const filters = {
    startDate: req.query.startDate,
    endDate: req.query.endDate,
    model: req.query.model,
    provider: req.query.provider,
    limit: 10000 // Max 10k rows for CSV
  };
  
  const logs = db.getAnalyticsLogs(filters);
  
  // Convert to CSV
  const csvHeader = 'Waktu,Model,Provider,Input Tokens,Output Tokens,Total Tokens,Response Time (ms),Status\n';
  const csvRows = logs.map(log => {
    const inputTokens = Math.round(log.total_tokens * 0.4); // Rough estimate
    const outputTokens = log.total_tokens - inputTokens;
    return `${log.created_at},${log.model},${log.provider},${inputTokens},${outputTokens},${log.total_tokens},${log.response_time_ms},${log.status}`;
  }).join('\n');
  
  const csv = csvHeader + csvRows;
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="wanar-ai-analytics-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

app.get('/api/auth/me', rateLimiters.auth, auth.authMiddleware, (req, res) => {
  const user = db.getUserById(req.user.id);
  const todayUsage = db.getUserTokensToday(req.user.id);
  const teams = enterprise.getTeamsByUser(req.user.id);
  res.json({
    success: true,
    user,
    usage: { today: todayUsage, limit: auth.getUserDailyLimit() },
    teams,
  });
});

app.get('/api/teams', enterprise.authMiddleware, asyncHandler(async (req, res) => {
  const teams = enterprise.getTeamsByUser(req.user.id);
  res.json({ teams });
}));

app.post('/api/teams', enterprise.authMiddleware, asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Team name required' });
  const team = enterprise.createTeam(name, req.user.id);
  res.json({ success: true, team });
}));

app.get('/api/teams/:teamId', enterprise.authMiddleware, enterprise.requireTeamRole('viewer'), asyncHandler(async (req, res) => {
  const team = enterprise.getTeam(parseInt(req.params.teamId));
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const stats = enterprise.getTeamStats(parseInt(req.params.teamId));
  res.json({ team, stats });
}));

app.patch('/api/teams/:teamId', enterprise.authMiddleware, enterprise.requireTeamRole('admin'), asyncHandler(async (req, res) => {
  const { name } = req.body;
  enterprise.updateTeam(parseInt(req.params.teamId), { name });
  res.json({ success: true });
}));

app.delete('/api/teams/:teamId', enterprise.authMiddleware, enterprise.requireTeamRole('owner'), asyncHandler(async (req, res) => {
  enterprise.deleteTeam(parseInt(req.params.teamId));
  res.json({ success: true });
}));

app.get('/api/teams/:teamId/members', enterprise.authMiddleware, enterprise.requireTeamRole('viewer'), asyncHandler(async (req, res) => {
  const members = enterprise.getTeamMembers(parseInt(req.params.teamId));
  res.json({ members });
}));

app.post('/api/teams/:teamId/members', enterprise.authMiddleware, enterprise.requireTeamRole('admin'), asyncHandler(async (req, res) => {
  const { userId, role } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const result = enterprise.addTeamMember(parseInt(req.params.teamId), userId, role || 'member');
  res.json({ success: true, ...result });
}));

app.delete('/api/teams/:teamId/members/:userId', enterprise.authMiddleware, enterprise.requireTeamRole('admin'), asyncHandler(async (req, res) => {
  enterprise.removeTeamMember(parseInt(req.params.teamId), parseInt(req.params.userId));
  res.json({ success: true });
}));

app.get('/api/teams/:teamId/workspaces', enterprise.authMiddleware, enterprise.requireTeamRole('viewer'), asyncHandler(async (req, res) => {
  const workspaces = enterprise.getWorkspaces(parseInt(req.params.teamId));
  res.json({ workspaces });
}));

app.post('/api/teams/:teamId/workspaces', enterprise.authMiddleware, enterprise.requireTeamRole('editor'), asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Workspace name required' });
  const ws = enterprise.createWorkspace(parseInt(req.params.teamId), name, req.user.id);
  res.json({ success: true, workspace: ws });
}));

app.delete('/api/teams/:teamId/workspaces/:wsId', enterprise.authMiddleware, enterprise.requireTeamRole('admin'), asyncHandler(async (req, res) => {
  const teamId = parseInt(req.params.teamId, 10);
  const wsId = parseInt(req.params.wsId, 10);

  // Authorization must bind the object to the team named in the path. Checking
  // only that the caller is an admin of *some* team, then deleting by wsId,
  // lets them delete another team's workspace (IDOR).
  const teamWorkspaces = enterprise.getWorkspaces(teamId);
  if (!teamWorkspaces.some((w) => w.id === wsId)) {
    authMonitor.recordAuthzDenied(req, 'workspace_not_in_team');
    return res.status(404).json({ success: false, error: 'Workspace not found in this team' });
  }

  enterprise.deleteWorkspace(wsId);
  res.json({ success: true });
}));

app.get('/api/teams/:teamId/keys', enterprise.authMiddleware, enterprise.requireTeamRole('viewer'), asyncHandler(async (req, res) => {
  const keys = enterprise.getApiKeys(parseInt(req.params.teamId));
  res.json({ keys });
}));

app.post('/api/teams/:teamId/keys', enterprise.authMiddleware, enterprise.requireTeamRole('editor'), asyncHandler(async (req, res) => {
  const { name, permissions } = req.body;
  const result = enterprise.createApiKey(parseInt(req.params.teamId), req.user.id, name || 'default', permissions);
  res.json({ success: true, key: result });
}));

app.delete('/api/teams/:teamId/keys/:keyId', enterprise.authMiddleware, enterprise.requireTeamRole('admin'), asyncHandler(async (req, res) => {
  enterprise.revokeApiKey(parseInt(req.params.keyId), parseInt(req.params.teamId));
  res.json({ success: true });
}));

app.post('/api/teams/:teamId/keys/:keyId/rotate', enterprise.authMiddleware, enterprise.requireTeamRole('admin'), asyncHandler(async (req, res) => {
  const { name } = req.body;
  const result = enterprise.rotateApiKey(parseInt(req.params.keyId), parseInt(req.params.teamId), name);
  if (!result) return res.status(404).json({ error: 'API key not found' });
  res.json({ success: true, key: result });
}));

app.get('/api/teams/:teamId/usage', enterprise.authMiddleware, enterprise.requireTeamRole('admin'), asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const usage = enterprise.getTeamUsage(parseInt(req.params.teamId), days);
  res.json({ usage, teamId: parseInt(req.params.teamId), days });
}));

// ============================================
// SECURITY TESTING API ENDPOINTS
// by Wisnu Alfian Nur Ashar
// ============================================

// Scope authorization: only targets the operator declared as owned may be
// scanned. This prevents the endpoints from being used as an open mass-scanner.
function requireInScope(req, res, next) {
  const target = req.body?.target;
  if (!target) return res.status(400).json({ success: false, error: 'Target URL required' });
  const auth = authorizeTarget(target);
  if (!auth.allowed) {
    return res.status(403).json({
      success: false,
      error: `Target "${auth.host || target}" is out of scope (${auth.reason}).`,
      reason: auth.reason,
      hint: auth.hint || 'Add the host to SCAN_ALLOWED_TARGETS to authorize it.',
      scope: getScope(),
    });
  }
  req.scanScope = auth;
  next();
}

app.get('/api/security/scope', (req, res) => {
  res.json({ success: true, scope: getScope(), loadTestLimits: LOAD_LIMITS });
});

// Close the visible ("watch") browser window opened by the agent.
app.post('/api/browser/close', asyncHandler(async (req, res) => {
  await closeVisibleBrowser();
  res.json({ success: true });
}));

// Live state of the visible browser (for voice split-screen panel).
// Poll dari frontend tiap ~2 detik saat voice call aktif.
app.get('/api/browser/live', asyncHandler(async (req, res) => {
  const state = await getLiveBrowserState();
  res.json({ success: true, ...state });
}));

// Human-like TTS (opsional, bila ada API key).
// Prioritas: OpenAI TTS (gpt-4o-mini-tts, suara natural Indonesia-friendly)
// lalu ElevenLabs (suara paling manusiawi). Tanpa key → 501 agar
// frontend fallback ke suara natural browser (Microsoft/Google id-ID).
app.post('/api/voice/tts', asyncHandler(async (req, res) => {
  const text = String(req.body?.text || '').slice(0, 2000);
  if (!text.trim()) return res.status(400).json({ success: false, error: 'text required' });
  const voice = req.body?.voice || 'alloy';

  // 1) OpenAI TTS
  if (process.env.OPENAI_API_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
          voice: process.env.OPENAI_TTS_VOICE || voice,
          input: text,
          response_format: 'mp3',
        }),
      });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader('Content-Type', 'audio/mpeg');
        return res.send(buf);
      }
    } catch { /* fallback below */ }
  }

  // 2) ElevenLabs (paling manusiawi)
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const vid = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.4 },
        }),
      });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader('Content-Type', 'audio/mpeg');
        return res.send(buf);
      }
    } catch { /* fallback below */ }
  }

  // 3) Google Translate TTS Bahasa Indonesia — GRATIS, tanpa key.
  // Kualitas jauh lebih manusiawi daripada suara robot browser.
  // Client meminta per kalimat (pendek), jadi pas dengan batas endpoint ini.
  try {
    const q = text.slice(0, 500);
    const r = await fetch(
      `https://translate.google.com/translate_tts?ie=UTF-8&client=gtx&tl=id&q=${encodeURIComponent(q)}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Referer': 'https://translate.google.com/',
        },
      }
    );
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || '';
      if (buf.length > 1024 && ct.includes('audio')) {
        res.setHeader('Content-Type', 'audio/mpeg');
        return res.send(buf);
      }
    }
  } catch { /* fallback ke suara browser */ }

  return res.status(501).json({
    success: false,
    error: 'no_tts_key',
    hint: 'Isi OPENAI_API_KEY atau ELEVENLABS_API_KEY di .env untuk suara super manusiawi. Sementara pakai suara natural browser (id-ID).',
  });
}));

// Bounded load test — capacity measurement with automatic safety abort.
app.post('/api/security/load-test', rateLimiters.strict, requireInScope, asyncHandler(async (req, res) => {
  const result = await runLoadTest(req.body || {});
  res.status(result.success ? 200 : 403).json(result);
}));

// Rate-limit validation — proves the target's limiter engages (429 + Retry-After).
app.post('/api/security/rate-limit-test', rateLimiters.strict, requireInScope, asyncHandler(async (req, res) => {
  const result = await validateRateLimit(req.body || {});
  res.status(result.success ? 200 : 403).json(result);
}));

app.post('/api/security/scan', rateLimiters.strict, requireInScope, asyncHandler(async (req, res) => {
  const { target, scanType, modules, aggressive } = req.body;
  
  if (!target) {
    return res.status(400).json({ success: false, error: 'Target URL required' });
  }

  try {
    const result = await securityScanner.scanVulnerabilities(
      target,
      scanType || 'quick',
      modules || ['sqli', 'xss', 'csrf', 'security_headers', 'ssl']
    );

    res.json({ success: true, results: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

app.post('/api/security/auth-test', rateLimiters.strict, requireInScope, asyncHandler(async (req, res) => {
  const { target, username, password, testTypes } = req.body;

  try {
    const result = await securityScanner.testAuthentication(
      target,
      username || 'admin',
      testTypes || ['bruteforce', 'bypass', 'session_hijack']
    );

    res.json({ success: true, results: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

app.post('/api/security/code-audit', asyncHandler(async (req, res) => {
  const { path: codePath, language, checks, severity } = req.body;
  
  if (!codePath) {
    return res.status(400).json({ success: false, error: 'Code path required' });
  }

  try {
    const result = await securityScanner.auditCode(codePath);

    res.json({ success: true, results: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

app.post('/api/security/dependency-scan', asyncHandler(async (req, res) => {
  const { path: projectPath, includeDevDeps, fixable } = req.body;

  try {
    const result = await securityScanner.scanDependencies();

    res.json({ success: true, results: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

// Realtime Security Scan via SSE
app.post('/api/security/scan/stream', rateLimiters.strict, requireInScope, asyncHandler(async (req, res) => {
  const { target, scanType, modules } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let clientDisconnected = false;

  req.on('close', () => { clientDisconnected = true; });
  req.on('error', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE') clientDisconnected = true;
  });

  const sendEvent = (event, data) => {
    if (clientDisconnected || res.writableEnded) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch (err) {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
        clientDisconnected = true;
      }
      return false;
    }
  };

  try {
    const stream = securityScanner.streamScanVulnerabilities(
      target,
      scanType || 'deep',
      modules || ['sqli', 'xss', 'csrf', 'security_headers', 'ssl'],
      aiManager
    );

    for await (const chunk of stream) {
      if (clientDisconnected) break;

      if (chunk.type === 'vulnerability') {
        sendEvent('vulnerability', chunk);
      } else if (chunk.type === 'progress') {
        sendEvent('progress', chunk);
      } else if (chunk.type === 'check_pass') {
        sendEvent('check_pass', chunk);
      } else if (chunk.type === 'check_error') {
        sendEvent('check_error', chunk);
      } else if (chunk.type === 'target_info') {
        sendEvent('target_info', chunk);
      } else if (chunk.type === 'scan_start') {
        sendEvent('scan_start', chunk);
      } else if (chunk.type === 'ai_analysis') {
        sendEvent('ai_analysis', chunk);
      } else if (chunk.type === 'scan_complete') {
        sendEvent('scan_complete', chunk);
      } else if (chunk.type === 'scan_error') {
        sendEvent('scan_error', chunk);
      }
    }

    if (!clientDisconnected && !res.writableEnded) {
      sendEvent('stream_end', {});
    }
  } catch (error) {
    if (!clientDisconnected && !res.writableEnded) {
      sendEvent('scan_error', { message: error.message });
    }
  } finally {
    if (!res.writableEnded) {
      try { res.end(); } catch (err) {}
    }
  }
}));

// AI Analysis for Security Scan Results
app.post('/api/security/analyze', asyncHandler(async (req, res) => {
  const { vulnerabilities, target } = req.body;

  if (!vulnerabilities || !Array.isArray(vulnerabilities)) {
    return res.status(400).json({ success: false, error: 'Vulnerabilities array required' });
  }

  try {
    const analysis = await securityScanner.analyzeScanResultsWithAI(vulnerabilities, target, aiManager);
    res.json({ success: true, analysis });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

// AI Chat for Security - uses DeepSeek/NVIDIA for contextual analysis
app.post('/api/security/ai-advice', asyncHandler(async (req, res) => {
  const { vulnerability, target, question } = req.body;

  if (!vulnerability) {
    return res.status(400).json({ success: false, error: 'Vulnerability data required' });
  }

  try {
    const result = await securityScanner.aiDeepQuery(vulnerability, target, question || '', aiManager);
    if (result._aiGenerated) {
      res.json({ success: true, analysis: result.analysis });
    } else {
      const fallback = await securityScanner.analyzeScanResultsWithAI([vulnerability], target, aiManager);
      const av = fallback.attackVectors?.[0] || {};
      const answer = `## AI Security Analysis: ${vulnerability.type}

### Cara Kerja Attack
${av.howItWorks || 'Attacker mengeksploitasi celah ini untuk mengompromikan sistem.'}

### Dampak
${av.impact || 'Dapat menyebabkan kebocoran data atau kompromi sistem.'}

### Prioritas
${av.priority || 'P2 - Fix in current sprint'}

### Langkah Remediasi
${vulnerability.recommendation || 'Apply security patches and follow best practices.'}

### Detail
${vulnerability.description}
${vulnerability.evidence ? '\n**Evidence:** ' + vulnerability.evidence.join(', ') : ''}
${vulnerability.cvss ? '\n**CVSS:** ' + vulnerability.cvss + '/10' : ''}`;
      res.json({ success: true, analysis: answer });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

// ==================== JOB AGENT ENDPOINTS ====================

// GET /api/job-agent/sessions — list semua sesi
app.get('/api/job-agent/sessions', (req, res) => {
  const sessions = db.getJobSessions();
  const activeIds = jobAgent.getActiveSessionIds();
  res.json({ success: true, sessions, activeIds });
});

// POST /api/job-agent/sessions — buat sesi baru
app.post('/api/job-agent/sessions', asyncHandler(async (req, res) => {
  const { name, source_url, settings } = req.body;
  if (!source_url) return res.status(400).json({ success: false, error: 'source_url wajib diisi' });
  const session = db.createJobSession(name || 'Job Scan Session', source_url, settings || {});
  res.json({ success: true, session });
}));

// GET /api/job-agent/sessions/:id — detail sesi + stats
app.get('/api/job-agent/sessions/:id', (req, res) => {
  const session = db.getJobSession(Number(req.params.id));
  if (!session) return res.status(404).json({ success: false, error: 'Session tidak ditemukan' });
  const stats = db.getJobQueueStats();
  const activeIds = jobAgent.getActiveSessionIds();
  res.json({ success: true, session, stats, isActive: activeIds.includes(req.params.id) });
});

// POST /api/job-agent/sessions/:id/start — mulai crawl & apply
app.post('/api/job-agent/sessions/:id/start', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { trustedMode = false, headless = false } = req.body || {};
  res.json({ success: true, message: 'Session dimulai', sessionId: id });
  // Run async — tidak block response
  jobAgent.startJobSession(id, { trustedMode, headless }).catch(err => {
    console.error('[job-agent] session error:', err.message, err.stack);
  });
}));

// POST /api/job-agent/sessions/:id/stop — hentikan sesi
app.post('/api/job-agent/sessions/:id/stop', (req, res) => {
  const stopped = jobAgent.stopJobSession(Number(req.params.id));
  res.json({ success: true, stopped });
});

// POST /api/job-agent/launch-chrome — launch Chrome dengan CDP remote debugging
// Agar agent bisa connect ke Chrome yang sudah login via CDP
app.post('/api/job-agent/launch-chrome', asyncHandler(async (req, res) => {
  const { execSync, spawn } = await import('child_process');

  // Cek apakah CDP sudah aktif
  try {
    const cdpRes = await fetch('http://localhost:9222/json/version', { signal: AbortSignal.timeout(1500) });
    if (cdpRes.ok) {
      return res.json({ success: true, message: 'Chrome CDP sudah aktif di port 9222', alreadyRunning: true });
    }
  } catch {}

  // Cari path Chrome
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  let chromePath = null;
  for (const p of chromePaths) {
    try { execSync(`if exist "${p}" echo found`, { shell: true }).toString().includes('found') && (chromePath = p); } catch {}
    if (chromePath) break;
  }
  // Fallback: cari via registry
  if (!chromePath) {
    try {
      const reg = execSync('reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve', { shell: true }).toString();
      const match = reg.match(/REG_SZ\s+(.+\.exe)/);
      if (match) chromePath = match[1].trim();
    } catch {}
  }

  if (!chromePath) {
    return res.status(404).json({ success: false, message: 'Chrome tidak ditemukan. Install Google Chrome terlebih dahulu.' });
  }

  // Launch Chrome dengan CDP flag
  const userDataDir = `C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Google\\Chrome\\User Data`;
  spawn(chromePath, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { detached: true, stdio: 'ignore' }).unref();

  // Tunggu Chrome ready
  let ready = false;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 800));
    try {
      const check = await fetch('http://localhost:9222/json/version', { signal: AbortSignal.timeout(1000) });
      if (check.ok) { ready = true; break; }
    } catch {}
  }

  if (ready) {
    res.json({ success: true, message: 'Chrome berhasil diluncurkan dengan CDP di port 9222. Agent akan menggunakan Chrome yang sudah login.' });
  } else {
    res.json({ success: false, message: 'Chrome diluncurkan tapi CDP belum merespons. Coba lagi dalam beberapa detik.' });
  }
}));

// DELETE /api/job-agent/sessions/:id — hapus sesi dan semua job-nya
app.delete('/api/job-agent/sessions/:id', (req, res) => {
  const id = Number(req.params.id);
  jobAgent.stopJobSession(id); // pastikan stop dulu jika sedang running
  db.deleteJobSession(id);
  res.json({ success: true });
});

// GET /api/job-agent/queue — daftar job di queue
app.get('/api/job-agent/queue', (req, res) => {
  const { status, limit = 100, offset = 0 } = req.query;
  const jobs = db.getJobQueue(status || null, Number(limit), Number(offset));
  const stats = db.getJobQueueStats();
  res.json({ success: true, jobs, stats });
});

// PATCH /api/job-agent/queue/:id — update status job manual
app.patch('/api/job-agent/queue/:id', asyncHandler(async (req, res) => {
  const { status, notes } = req.body;
  const updated = db.updateJobStatus(Number(req.params.id), status, { notes });
  res.json({ success: true, job: updated });
}));

// GET /api/job-agent/review — review queue (needs_review)
app.get('/api/job-agent/review', (req, res) => {
  const { status = 'pending' } = req.query;
  const items = db.getReviewQueue(status);
  res.json({ success: true, items });
});

// POST /api/job-agent/review/:id/approve — approve review item
app.post('/api/job-agent/review/:id/approve', asyncHandler(async (req, res) => {
  const { editedMapping } = req.body || {};
  const item = db.updateReviewItem(Number(req.params.id), 'approved', editedMapping || null);
  // Update job status ke submitted
  if (item) db.updateJobStatus(item.job_id, 'submitted', { notes: 'Approved dari review queue' });
  res.json({ success: true, item });
}));

// POST /api/job-agent/review/:id/reject — reject review item
app.post('/api/job-agent/review/:id/reject', asyncHandler(async (req, res) => {
  const item = db.updateReviewItem(Number(req.params.id), 'rejected');
  if (item) db.updateJobStatus(item.job_id, 'rejected', { notes: 'Ditolak dari review queue' });
  res.json({ success: true, item });
}));

// POST /api/job-agent/crawl — crawl URL sekarang (preview tanpa start session)
app.post('/api/job-agent/crawl', asyncHandler(async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'url wajib diisi' });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const jobs = await jobAgent.crawlListingPage(url, page);
    res.json({ success: true, count: jobs.length, jobs: jobs.slice(0, 50) });
  } finally {
    await browser.close().catch(() => {});
  }
}));

// DELETE /api/job-agent/queue — clear semua queue
app.delete('/api/job-agent/queue', (req, res) => {
  db.clearJobQueue();
  res.json({ success: true, message: 'Queue dibersihkan' });
});

// GET /api/job-agent/sessions/:id/live — SSE live feed
app.get('/api/job-agent/sessions/:id/live', (req, res) => {
  const sessionId = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial ping
  send({ type: 'connected', sessionId });

  const handler = (event) => {
    if (event.sessionId === sessionId) {
      send(event);
    }
  };

  agentEvents.on('event', handler);

  // Heartbeat every 15s to keep connection alive
  const hb = setInterval(() => res.write(': heartbeat\n\n'), 15000);

  req.on('close', () => {
    clearInterval(hb);
    agentEvents.off('event', handler);
  });
});

// ==================== AI FULL-STACK PROJECT GENERATOR ====================

// POST /api/generator/start — mulai generate project full-stack
app.post('/api/generator/start', rateLimiters.chat, asyncHandler(async (req, res) => {
  const { description, framework, appType, projectName, extra, maxFiles, provider, model } = req.body || {};
  if (!description || !String(description).trim()) {
    return res.status(400).json({ error: 'description wajib diisi' });
  }
  if (!framework) {
    return res.status(400).json({ error: 'framework wajib dipilih' });
  }
  const id = generator.start({
    description: String(description).slice(0, 4000),
    framework,
    appType: appType || 'web-app',
    projectName,
    extra,
    maxFiles,
    provider,
    model,
  }, aiManager);
  res.json({ success: true, id });
}));

// GET /api/generator/projects — daftar semua project
app.get('/api/generator/projects', (req, res) => {
  res.json({ projects: generator.list() });
});

// GET /api/generator/:id — status + file list
app.get('/api/generator/:id', (req, res) => {
  const p = generator.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const { emitter, stopFlag, ...rest } = p;
  res.json(rest);
});

// GET /api/generator/:id/events — SSE live progress
app.get('/api/generator/:id/events', (req, res) => {
  const p = generator.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: 'connected', id: p.id, status: p.status });

  // Replay kondisi terkini agar UI langsung sinkron
  if (p.plan?.length) send({ type: 'plan', name: p.name, total: p.plan.length, files: p.plan });
  for (const f of p.files) send({ type: 'file_done', path: f.path, size: f.size });

  const handler = (event) => send(event);
  p.emitter.on('event', handler);
  const hb = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => { clearInterval(hb); p.emitter.off('event', handler); });
});

// GET /api/generator/:id/file?path=... — isi satu file
app.get('/api/generator/:id/file', (req, res) => {
  const p = generator.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  try {
    const content = generator.readFile(p, req.query.path);
    if (content === null) return res.status(404).json({ error: 'File not found' });
    res.json({ path: req.query.path, content });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/generator/:id/download — download ZIP
app.get('/api/generator/:id/download', asyncHandler(async (req, res) => {
  const p = generator.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const zipBuffer = await generator.makeZip(p);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${p.name}.zip"`);
  res.send(zipBuffer);
}));

// DELETE /api/generator/:id — hapus project
app.delete('/api/generator/:id', (req, res) => {
  const ok = generator.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Project not found' });
  res.json({ success: true });
});

// POST /api/generator/:id/stop — hentikan generation
app.post('/api/generator/:id/stop', (req, res) => {
  const ok = generator.stop(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Project not found' });
  res.json({ success: true });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/assets/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  const indexPath = path.join(clientDist, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(indexPath);
  }
  return next();
});

// Deep Attack Stream - Professional Pentest
app.post('/api/security/attack/stream', rateLimiters.strict, requireInScope, asyncHandler(async (req, res) => {
  const { target, scanType } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let clientDisconnected = false;
  req.on('close', () => { clientDisconnected = true; });
  req.on('error', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE') clientDisconnected = true;
  });

  const sendEvent = (event, data) => {
    if (clientDisconnected || res.writableEnded) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch { return false; }
  };

  try {
    const { options } = req.body;
    const stream = securityScanner.deepAttackStream(target, scanType || 'deep', options || {}, aiManager);

    for await (const chunk of stream) {
      if (clientDisconnected) break;

      if (chunk.type === 'payload_test') sendEvent('payload_test', chunk);
      else if (chunk.type === 'cloudflare_detected') sendEvent('cloudflare_detected', chunk);
      else if (chunk.type === 'vulnerability_confirmed') sendEvent('vulnerability_confirmed', chunk);
      else if (chunk.type === 'attack_fake') sendEvent('attack_fake', chunk);
      else if (chunk.type === 'progress') sendEvent('progress', chunk);
      else if (chunk.type === 'evidence') sendEvent('evidence', chunk);
      else if (chunk.type === 'ai_guidance') sendEvent('ai_guidance', chunk);
      else if (chunk.type === 'attack_start') sendEvent('attack_start', chunk);
      else if (chunk.type === 'attack_complete') sendEvent('attack_complete', chunk);
      else if (chunk.type === 'attack_error') sendEvent('attack_error', chunk);
      else if (chunk.type === 'exploit_chains') sendEvent('exploit_chains', chunk);
      else if (chunk.type === 'compliance') sendEvent('compliance', chunk);
      else if (chunk.type === 'ddos_start') sendEvent('ddos_start', chunk);
      else if (chunk.type === 'ddos_progress') sendEvent('ddos_progress', chunk);
      else if (chunk.type === 'ddos_complete') sendEvent('ddos_complete', chunk);
      else if (chunk.type === 'bruteforce_complete') sendEvent('bruteforce_complete', chunk);
      else if (chunk.type === 'exploitation') sendEvent('exploitation', chunk);
      else if (chunk.type === 'exploitation_complete') sendEvent('exploitation_complete', chunk);
    }

    if (!clientDisconnected && !res.writableEnded) sendEvent('stream_end', {});
  } catch (error) {
    if (!clientDisconnected && !res.writableEnded) sendEvent('attack_error', { message: error.message });
  } finally {
    if (!res.writableEnded) { try { res.end(); } catch {} }
  }
}));

// Generate Professional Bug Bounty Report
app.post('/api/security/report', asyncHandler(async (req, res) => {
  const { vulnerabilities, fake, target, dnsInfo, techStack, aiGuidance, compliance, format } = req.body;

  if (!vulnerabilities || !Array.isArray(vulnerabilities)) {
    return res.status(400).json({ success: false, error: 'Vulnerabilities array required' });
  }

  try {
    const report = securityScanner.generateProfessionalReport(
      vulnerabilities,
      fake || [],
      target || 'Unknown',
      dnsInfo || {},
      techStack || {},
      aiGuidance || null,
      compliance || null
    );

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(report.htmlReport);
    } else if (format === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(report.rawReport);
    } else {
      res.json({ success: true, report });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

// Professional Attack: Data Extraction
app.post('/api/security/professional/extract', rateLimiters.strict, requireInScope, asyncHandler(async (req, res) => {
  const { target } = req.body;

  try {
    const extraction = await securityScanner.performDeepExtraction(target);
    res.json({ success: true, ...extraction });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

// Compliance Report Endpoint
app.post('/api/security/compliance', asyncHandler(async (req, res) => {
  const { vulnerabilities } = req.body;
  if (!vulnerabilities || !Array.isArray(vulnerabilities)) {
    return res.status(400).json({ success: false, error: 'Vulnerabilities array required' });
  }
  try {
    const compliance = securityScanner.generateComplianceReport(vulnerabilities);
    res.json({ success: true, compliance });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

// Send Notification (Email / WhatsApp)
app.post('/api/security/notify', asyncHandler(async (req, res) => {
  const { target, vulnerabilities, fake, type, contact } = req.body;

  if (!target) {
    return res.status(400).json({ success: false, error: 'Target required' });
  }

  try {
    const report = securityScanner.generateProfessionalReport(
      vulnerabilities || [], fake || [], target, {}, {}, null, null
    );

    if (type === 'email') {
      const emailContent = securityScanner.generateEmailContent(report, contact || 'security@target.com');
      // In production, integrate with nodemailer / SendGrid / SMTP
      // For now, return the email content for preview
      res.json({
        success: true,
        notificationType: 'email',
        preview: {
          to: emailContent.to,
          subject: emailContent.subject,
          html: emailContent.html,
        },
        message: 'Email notification ready. Configure SMTP in production.',
      });
    } else if (type === 'whatsapp') {
      const waContent = securityScanner.generateWhatsAppMessage(report);
      // In production, integrate with WhatsApp Business API
      res.json({
        success: true,
        notificationType: 'whatsapp',
        preview: { message: waContent.message },
        message: 'WhatsApp notification ready. Configure WhatsApp API in production.',
      });
    } else {
      res.json({
        success: true,
        email: securityScanner.generateEmailContent(report, contact),
        whatsapp: securityScanner.generateWhatsAppMessage(report),
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

// ==================== PROMPT RULE LAB (LOCAL) ====================
// Local, offline analysis of a rule set (system prompt / persona rules).
// lint is pure and never touches the network; review asks a model to critique
// the rule set as inert data (it is instructed never to adopt it).

app.post('/api/prompt-lab/lint', (req, res) => {
  const { ruleSet } = req.body || {};

  if (typeof ruleSet !== 'string' || !ruleSet.trim()) {
    return res.status(400).json({ success: false, error: 'ruleSet (string) wajib diisi' });
  }
  if (ruleSet.length > MAX_RULE_SET_CHARS) {
    return res.status(413).json({
      success: false,
      error: `ruleSet terlalu panjang (maks ${MAX_RULE_SET_CHARS} karakter)`,
    });
  }

  res.json({ success: true, report: lintRuleSet(ruleSet) });
});

app.post('/api/prompt-lab/review', rateLimiters.chat, asyncHandler(async (req, res) => {
  const { ruleSet, provider, model } = req.body || {};

  if (typeof ruleSet !== 'string' || !ruleSet.trim()) {
    return res.status(400).json({ success: false, error: 'ruleSet (string) wajib diisi' });
  }
  if (ruleSet.length > MAX_RULE_SET_CHARS) {
    return res.status(413).json({
      success: false,
      error: `ruleSet terlalu panjang (maks ${MAX_RULE_SET_CHARS} karakter)`,
    });
  }

  const report = lintRuleSet(ruleSet);

  let aiReview;
  try {
    aiReview = await reviewRuleSetWithAI(ruleSet, { aiManager, provider, model });
  } catch (error) {
    aiReview = { available: false, error: error.message };
  }

  res.json({ success: true, report, aiReview });
}));

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack || err.message);
  if (res.headersSent) return next(err);
  // Jangan sembunyikan error upload/multer di balik 500 generik.
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ success: false, error: err.message });
  }
  if (err && /File type|Invalid filename|Filename/i.test(err.message || '')) {
    return res.status(400).json({ success: false, error: err.message });
  }
  res.status(500).json({ success: false, error: 'Internal server error' });
});

async function startServer() {
  console.log('[DEBUG] Starting server...');
  try {
    console.log('[DEBUG] Initializing coordinator...');
    const clusterInfo = await coordinator.initialize();
    console.log('[DEBUG] Coordinator initialized');
    if (clusterInfo.redisAvailable) {
      coordinator.onNotify((data) => {
        if (data?.message?.type === 'reindex') {
          console.log(`[CLUSTER] Peer reindexed: ${data.message.files} files`);
        }
      });
    }
  } catch (err) {
    console.log(`[CLUSTER] Coordinator init skipped: ${err.message}`);
  }

  console.log('[DEBUG] About to call app.listen...');
  // WANAR_BIND=127.0.0.1 keeps the app off the public interface (nginx and SSH tunnels
  // reach it over loopback). Unset = all interfaces, as before (local development).
  const BIND = String(process.env.WANAR_BIND || '').trim() || undefined;
  const onListen = () => {
    console.log('[DEBUG] app.listen callback triggered!');
  console.log('\n' + '='.repeat(60));
  console.log('                    WANAR AI v2.0');
  console.log('              Enterprise Multi-Provider AI');
  console.log('='.repeat(60) + '\n');
  console.log(`Server    : http://localhost:${PORT}`);
  console.log(`Token/day : ${(config.tokens.dailyLimit / 1e6).toLocaleString()}M`);
  console.log(`Cost/day  : $${config.tokens.dailyCostLimit}`);
  console.log(`Providers : OpenAgentic (${config.openagentic.models?.length || 0} models), NVIDIA (${config.nvidia.apiKeys?.length || 1} keys), Vector, Puter.js`);
  console.log(`Context   : ${config.context?.maxTurns || 20} max turns, ${(config.context?.maxContextTokens || 131072) / 1000}k tokens`);
  console.log(`Database  : SQLite (WAL mode)`);
  console.log(`Security  : Helmet + CORS + Rate-Limit`);
  console.log(`Streaming : SSE enabled`);
  console.log(`RAG       : ${config.rag?.enabled ? 'Enabled' : 'Disabled'}\n`);
  console.log('Press Ctrl+C to stop\n');
  console.log(`Cluster   : ${coordinator.redisAvailable ? `Distributed (${coordinator.getInstanceCount()} instances)` : 'Standalone'}\n`);

  // Housekeeping: drop abandoned empty sessions left behind by older runs/tests.
  try {
    const pruned = db.deleteEmptySessions(60);
    if (pruned) console.log(`Housekeeping: ${pruned} sesi kosong dibersihkan`);
  } catch { /* non-fatal */ }

  // Penjadwal otomasi (email terjadwal, job AI). Hanya saat server benar-benar jalan.
  //
  // WANAR_BACKGROUND_JOBS=false turns this instance into a "client" (web UI
  // only). Exactly ONE instance may own the Telegram bot and the schedulers:
  // two pollers fight over updates (HTTP 409) and two schedulers send every
  // automated message twice.
  const backgroundJobs = String(process.env.WANAR_BACKGROUND_JOBS || 'true').toLowerCase() !== 'false';
  try {
    if (!backgroundJobs) {
      console.log('Background : NONAKTIF (WANAR_BACKGROUND_JOBS=false) — Telegram, penjadwal & laporan dijalankan instance lain');
    } else {
      automation.scheduler.start();
      if (automation.inbox.start()) console.log('Telegram   : inbox aktif (pelanggan mendaftar lewat /start)');
      worklog.service.start();
      console.log('Worklog    : jurnal kerja aktif (laporan Telegram terjadwal)');
      emailDesk.desk.start(); // follow-up checks
      if (briefing.start()) console.log('Briefing   : briefing pagi otomatis di hari kerja (/brief kapan saja)');
      console.log(emailDesk.watcher.start()
        ? 'Email Desk : memantau balasan email (IMAP IDLE, realtime)'
        : 'Email Desk : aktif tanpa pemantau balasan (IMAP_* belum diatur)');
      console.log('Automation : scheduler aktif (mode email: ' + automation.mailer.mode + ')');
    }
  } catch (e) {
    console.log('Automation : gagal start (' + e.message + ')');
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      try { automation.scheduler.stop(); automation.inbox.stop(); worklog.service.stop(); emailDesk.watcher.stop(); emailDesk.desk.stop(); briefing.stop(); automation.channels.closeAll(); } catch { /* ignore */ }
      process.exit(0);
    });
  }

  // Pre-warm browser pool di background agar browser_open pertama cepat.
  // DIMATIKAN di produksi (NODE_ENV=production) agar VPS tidak langsung
  // memuat Chromium ±300MB saat boot. Aktifkan lagi dengan BROWSER_POOL_WARM=true.
  const warmEnabled = process.env.BROWSER_POOL_WARM === 'true' ||
    (process.env.BROWSER_POOL_WARM !== 'false' && process.env.NODE_ENV !== 'production');
  if (warmEnabled) {
    import('./tools/browser-pool.js').then(async ({ warmPool }) => {
      try {
        const ok = await warmPool();
        console.log(`Browser    : pool ${ok ? 'warm' : 'disabled'}`);
      } catch (e) {
        console.log(`Browser    : pool warmup gagal (${e.message})`);
      }
    }).catch(() => {});
  } else {
    console.log('Browser    : pool tidak di-prewarm (mode ringan; set BROWSER_POOL_WARM=true untuk mengaktifkan)');
  }
  };
  if (BIND) app.listen(PORT, BIND, onListen); else app.listen(PORT, onListen);
}

export default app;

// Jangan auto-listen saat diimpor oleh test (vitest) — hanya saat dijalankan langsung.
// Vitest menyetel process.env.VITEST='true'.
if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
  startServer();
}
