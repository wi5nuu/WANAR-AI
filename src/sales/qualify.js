/**
 * src/sales/qualify.js
 *
 * Turns a stranger's free-text message into facts the sales desk can act on: which service they mean,
 * their budget and deadline, whether it is spam, whether it needs the owner personally, and how hot
 * the lead is. Everything here is a written rule (no model), so the same message always gives the
 * same answer and every decision can be explained.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { parseAmount } from '../worklog/parse.js';

const MAX_TEXT = 2000;

// -------------------------------------------------------------------- language

const EN_WORDS = /\b(hello|hi|hey|need|want|looking|website|build|quote|price|cost|budget|please|developer|project|how much|thanks|thank you|deadline)\b/gi;
const ID_WORDS = /\b(halo|hai|selamat|butuh|mau|ingin|cari|bikin|buat|jasa|harga|berapa|biaya|tolong|terima kasih|makasih|bisa|apakah|untuk|dan|yang|saya|kami|aku)\b/gi;

/** 'id' unless the message is clearly English. */
export function detectLanguage(text) {
  const t = String(text || '');
  const en = (t.match(EN_WORDS) || []).length;
  const id = (t.match(ID_WORDS) || []).length;
  return en >= 2 && en > id ? 'en' : 'id';
}

// -------------------------------------------------------------------- service

/**
 * @param {string} text
 * @param {Array<{id:string, match:RegExp}>} services
 * @returns {{service: object|null, confidence: 'high'|'low'|'none', hits: string[]}}
 */
export function matchService(text, services) {
  const t = String(text || '');
  const scored = [];
  for (const s of services) {
    const m = t.match(new RegExp(s.match.source, `${s.match.flags.replace('g', '')}g`));
    if (m && m.length) scored.push({ s, n: m.length, hits: [...new Set(m.map((x) => x.toLowerCase().trim()))] });
  }
  // The specific services win over the generic "aplikasi/sistem/hosting" words.
  const GENERIC = new Set(['webapp', 'maintenance']);
  scored.sort((a, b) => (GENERIC.has(a.s.id) - GENERIC.has(b.s.id)) || b.n - a.n);
  if (scored.length) return { service: scored[0].s, confidence: 'high', hits: scored[0].hits.slice(0, 4) };
  // Only "website / web / situs" with nothing more specific: probably a landing page, but ask.
  if (/\b(website|web\s*site|situs|web)\b/i.test(t)) {
    return { service: services.find((s) => s.id === 'landing') || null, confidence: 'low', hits: ['website'] };
  }
  return { service: null, confidence: 'none', hits: [] };
}

// -------------------------------------------------------------------- budget / deadline

const AMOUNT = /(?:rp\.?\s*)?\d+(?:[.,]\d+)*\s*(?:rb|ribu|k|jt|juta|m\b|miliar|milyar)?/gi;

/** Rupiah amounts mentioned near budget words (or the only amount in the text). */
export function parseBudget(text) {
  const t = String(text || '').toLowerCase();
  // "3-5 juta" / "3 sampai 5jt": the unit is shared
  const range = /(\d+(?:[.,]\d+)?)\s*(?:-|–|sampai|s\/d|hingga|to)\s*(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)\b/.exec(t);
  if (range) {
    const lo = parseAmount(`${range[1]}${range[3]}`);
    const hi = parseAmount(`${range[2]}${range[3]}`);
    if (lo && hi) return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
  }
  const found = [];
  for (const m of t.matchAll(AMOUNT)) {
    const raw = m[0].trim();
    if (!/(rb|ribu|k|jt|juta|miliar|milyar|rp|\d[.,]\d{3})/i.test(raw) && !/rp/i.test(raw)) continue; // bare "5" or "2024" is not money
    const v = parseAmount(raw);
    if (!v || v < 50_000) continue;
    const ctx = t.slice(Math.max(0, m.index - 40), m.index + raw.length + 12);
    found.push({ v, near: /(budget|anggaran|dana|biaya|maksimal|maks|sekitar|kisaran|plafon|bayar|siapkan|punya)/.test(ctx) });
  }
  if (!found.length) return null;
  const near = found.filter((f) => f.near);
  const pick = near.length ? near : (found.length === 1 ? found : []);
  if (!pick.length) return null;
  const vals = pick.map((f) => f.v);
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

/** Days until the client needs it, when they say so ("2 minggu", "besok", "bulan depan"); null otherwise. */
export function parseDeadlineDays(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(hari ini|sekarang juga|secepatnya|asap|urgent|mendesak|segera)\b/.test(t)) return 3;
  if (/\bbesok\b/.test(t)) return 2;
  if (/\bminggu\s*depan\b/.test(t)) return 7;
  if (/\bbulan\s*depan\b/.test(t)) return 30;
  const m = /(\d{1,3})\s*(hari|minggu|bulan)\b/.exec(t);
  if (m && /(deadline|dalam|selesai|target|maksimal|paling lambat|butuh|ingin|mau|launch|rilis|tayang|jadi)/.test(t)) {
    return Number(m[1]) * ({ hari: 1, minggu: 7, bulan: 30 }[m[2]]);
  }
  return null;
}

// -------------------------------------------------------------------- intent / safety

const WANTS = /\b(butuh|perlu|mau|ingin|cari|bikin|buat(?:kan)?|jasa|order|pesan|tertarik|konsultasi|tanya|nanya|harga|tarif|biaya|berapa|quote|penawaran|rate|need|want|looking|how much|quotation|interested)\b/i;

const SPAM = [
  /\b(backlink|guest\s*post|seo\s*(?:murah|dijamin|guarantee)|ranking\s*(?:#?1|satu)\s*google)\b/i,
  /\b(slot|gacor|togel|casino|judi|pinjol|pinjaman\s*online|kredit\s*tanpa\s*agunan|investasi\s*bodong|bitcoin\s*double|forex\s*signal)\b/i,
  /\b(kami|we)\s+(?:menawarkan|menyediakan|offer|provide)\b/i,
  /\b(klik|click)\s+(?:link|tautan|here)\b/i,
  /\b(selamat\s*anda\s*(?:menang|terpilih)|you\s*(?:have\s*)?won|claim\s*your)\b/i,
];

/** More than two links, or a bare link with no ask, is spam. */
export function looksLikeSpam(text) {
  const t = String(text || '');
  if (SPAM.some((re) => re.test(t))) return true;
  const links = (t.match(/https?:\/\/\S+|\bwww\.\S+/gi) || []).length;
  if (links >= 3) return true;
  if (links >= 1 && t.replace(/https?:\/\/\S+|\bwww\.\S+/gi, '').trim().length < 12) return true;
  return false;
}

const HUMAN = /\b(telepon|telfon|telp|call|video\s*call|zoom|meet|ketemu|bertemu|bicara\s*(?:langsung|dengan)|hubungi\s*saya|owner|orangnya|manusia|human)\b/i;
const LEGAL = /\b(kontrak|perjanjian|nda|spk|invoice|faktur|npwp|pajak|legal|tender|rfp|po\s*(?:resmi)?|purchase\s*order|termin|escrow)\b/i;
const COMPLAINT = /\b(refund|komplain|kecewa|penipuan|tipu|marah|ganti\s*rugi|tidak\s*puas|batal(?:kan)?\s*(?:order|pesanan))\b/i;

/**
 * @param {string} rawText
 * @param {Array} services
 * @param {{minDays?: number}} [opts]
 */
export function qualify(rawText, services) {
  const text = String(rawText || '').trim().slice(0, MAX_TEXT);
  const lang = detectLanguage(text);
  const spam = looksLikeSpam(text);
  const match = matchService(text, services);
  const budget = parseBudget(text);
  const deadlineDays = parseDeadlineDays(text);
  const wants = WANTS.test(text);
  const wantsHuman = HUMAN.test(text);
  const legal = LEGAL.test(text);
  const complaint = COMPLAINT.test(text);

  // Heat of the lead: how likely this is a real, winnable job.
  let score = 0;
  if (match.service) score += match.confidence === 'high' ? 30 : 15;
  if (wants) score += 15;
  if (budget) score += 15;
  if (deadlineDays != null) score += 8;
  if (text.length >= 120) score += 12;
  if (text.length >= 300) score += 5;
  if (/@|\b(?:\+?62|0)8\d{7,}\b/.test(text)) score += 5; // left a way to reach them
  if (spam) score = 0;

  return {
    text, lang, spam, wants, score: Math.min(100, score),
    service: match.service, serviceConfidence: match.confidence, hits: match.hits,
    budget, deadlineDays, urgent: deadlineDays != null && deadlineDays < 7,
    wantsHuman, legal, complaint,
  };
}
