/**
 * src/sales/prospects/score.js
 *
 * Which prospects deserve the owner's two minutes. Written rules, no model: the same prospect always
 * gets the same score and every score carries its reasons.
 *
 *  good   worth acting on today
 *  maybe  plausible, check first
 *  skip   not your service, too small, suspicious, or hopelessly crowded
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { matchService } from '../qualify.js';
import { hasSkill } from '../../career/scoring.js';
import { skillsFromFacts } from '../../career/facts.js';

/** Posts that look like a trap or a race to the bottom, whatever their title says. */
const SUSPICIOUS = /(commission|refer\s.*earn|earn\s+\d+\s*%|unpaid|free\s+(?:sample|trial|test|work)|work\s+for\s+exposure|pay\s+(?:after|later)|payment\s+outside|outside\s+(?:the\s+)?(?:platform|freelancer)|whatsapp|telegram|@gmail\.com|skype|circumvent|bypass|crack(?:ed|ing)?\b|keylogger|ddos|spam\s*bot|fake\s+(?:reviews?|followers|accounts?)|gambling|betting|casino|adult|nsfw|account\s+(?:farm|verification\s+service)|captcha\s+solv)/i;

/** Native/mobile-only work is outside the catalog (web, backend, security, automation). */
const MOBILE_ONLY = /\b(android|ios|iphone|flutter|react\s+native|swift(?:ui)?|kotlin|mobile\s+app)\b/i;

/** Types of local business where a website visibly helps, best first. */
const LOCAL_FIT = {
  restaurant: 55, cafe: 55, clinic: 55, dentist: 55, school: 52, kindergarten: 52, clothes: 52, boutique: 52, beauty: 52, hairdresser: 50, laundry: 48,
  car_repair: 48, bakery: 50, florist: 50, travel_agency: 52, real_estate: 55, insurance: 45, lawyer: 52, accountant: 50, furniture: 50, electronics: 45, computer: 45,
  hardware: 42, pharmacy: 42, supermarket: 38, company: 50,
};

const hoursAgo = (ts, now) => (ts ? (now - ts) / 3_600_000 : Infinity);

/**
 * @param {object} p        normalised prospect (see sources.js)
 * @param {{services: object[]}} catalog
 * @param {object|null} facts
 * @param {{now?: number}} [opts]
 * @returns {{score:number, verdict:'good'|'maybe'|'skip', serviceId:string|null, reasons:string[], warnings:string[]}}
 */
export function scoreProspect(p, catalog, facts = null, { now = Date.now() } = {}) {
  const reasons = []; const warnings = [];
  const skip = (why) => ({ score: 0, verdict: 'skip', serviceId: null, reasons, warnings: [why, ...warnings] });

  // ---------------------------------------------------------------- local businesses
  if (p.kind === 'local') {
    if (!p.title || !p.contact) return skip('tanpa nama atau nomor telepon');
    let score = LOCAL_FIT[p.category] ?? 35;
    reasons.push(`usaha ${p.description?.split(' · ')[0] || p.category || 'lokal'} tanpa website`);
    if (p.mobile) { score += 20; reasons.push('nomor ponsel: bisa dihubungi lewat WhatsApp'); }
    else { score -= 15; warnings.push('hanya telepon rumah/kantor: tidak bisa lewat WhatsApp'); }
    if (p.email) { score += 8; reasons.push('mencantumkan email'); }
    const shop = /^(clothes|boutique|bakery|florist|furniture|electronics|computer|hardware|supermarket)$/.test(p.category);
    const serviceId = shop ? 'ecommerce' : 'landing';
    score = Math.max(0, Math.min(100, Math.round(score)));
    return { score, verdict: score >= 60 ? 'good' : score >= 40 ? 'maybe' : 'skip', serviceId, reasons, warnings };
  }

  // ---------------------------------------------------------------- marketplace project
  const text = `${p.title}\n${p.description}\n${(p.skills || []).join(' ')}`;
  if (SUSPICIOUS.test(text)) return skip('postingan mencurigakan (komisi, tanpa bayaran, atau minta pindah platform)');

  const m = matchService(`${p.title}\n${p.description}`, catalog.services);
  if (!m.service) return skip('bukan layanan yang Mas jual');
  const svc = m.service;
  if (MOBILE_ONLY.test(text) && !/\b(web|website|wordpress|laravel|next\.?js|react(?!\s+native)|node|php|api|backend|dashboard)\b/i.test(text)) return skip('aplikasi seluler murni (di luar layanan Mas)');
  let score = m.confidence === 'high' ? 30 : 12;
  reasons.push(`cocok dengan layanan: ${svc.name}`);

  // The owner's real stack
  const mine = facts ? skillsFromFacts(facts).filter((s) => s.length >= 3 && hasSkill(text, s)) : [];
  if (mine.length) { score += Math.min(24, mine.length * 6); reasons.push(`keahlian cocok: ${mine.slice(0, 5).join(', ')}`); }

  // Money: is it worth the owner's time at all?
  if (p.hourly) {
    const rateUsd = p.budgetIdrMax / 16500;
    if (rateUsd < 8) return skip(`tarif per jam terlalu rendah (sekitar $${rateUsd.toFixed(0)})`);
    score += 8; reasons.push('tarif per jam wajar');
  } else if (p.budgetIdrMax > 0) {
    if (p.budgetIdrMax < svc.price.min * 0.3) return skip('anggaran jauh di bawah harga layanan Mas');
    if (p.budgetIdrMax >= svc.price.min) { score += 14; reasons.push('anggaran sesuai kisaran harga Mas'); }
    else warnings.push('anggaran di bawah kisaran harga Mas');
  }

  // Competition decides whether a bid is even seen
  const b = p.bids;
  if (b <= 5) { score += 25; reasons.push(`baru ${b} penawar`); }
  else if (b <= 15) { score += 15; reasons.push(`${b} penawar`); }
  else if (b <= 40) { score += 5; warnings.push(`${b} penawar`); }
  else if (b <= 100) { score -= 5; warnings.push(`kompetisi ketat: ${b} penawar`); }
  else { score -= 20; warnings.push(`kompetisi sangat ketat: ${b} penawar`); }

  // Early bids get read
  const h = hoursAgo(p.postedAt, now);
  if (h <= 1) { score += 20; reasons.push('baru diposting (<1 jam)'); }
  else if (h <= 3) { score += 12; reasons.push('diposting <3 jam lalu'); }
  else if (h <= 12) score += 5;
  else if (h > 48) { score -= 15; warnings.push('sudah lebih dari 2 hari'); }

  if (!mine.length) { score = Math.min(score, 45); warnings.push('tidak ada keahlian di portofolio yang disebut jelas'); }
  if (b > 100) score = Math.min(score, 54);       // never "good" in a crowd of 100+
  else if (b > 40) score = Math.min(score, 69);
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, verdict: score >= 55 ? 'good' : score >= 35 ? 'maybe' : 'skip', serviceId: svc.id, reasons, warnings };
}
