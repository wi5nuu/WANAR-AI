/**
 * src/sales/prospects/sources.js
 *
 * Where potential clients can be found without bothering anyone who did not ask for it:
 *
 *  freelancer   Freelancer.com's public API: projects whose owners are ASKING for a developer right now.
 *  osm          OpenStreetMap (open data, ODbL): local businesses that list a phone number but no website.
 *
 * Both are read-only. Nothing here contacts anyone: first contact is always made by the owner himself
 * (a bid on the platform, a WhatsApp message from his own phone), because marketplace and WhatsApp rules
 * forbid robots doing it and a banned number would cost far more than the lead is worth.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { stripHtml } from '../../career/sources.js';

const UA = 'WanarAI/1.0 (personal freelance radar; contact via the owner portfolio)';

/** Freelancer.com skill ids for the owner's stack (looked up from /jobs/search). */
export const FREELANCER_JOBS = [3, 9, 17, 69, 500, 759, 669, 13, 305, 335]; // PHP JS WebsiteDesign WordPress Node React Laravel Python MySQL HTML

// ------------------------------------------------------------------ Freelancer.com

export function normFreelancer(p, { usdIdr = 16500 } = {}) {
  const rate = Number(p.currency?.exchange_rate) || 1;       // 1 unit of project currency = rate USD
  const min = Number(p.budget?.minimum) || 0;
  const max = Number(p.budget?.maximum) || min;
  const usdMin = min * rate; const usdMax = max * rate;
  const skills = (p.jobs || []).map((j) => (typeof j === 'string' ? j : j?.name)).filter(Boolean);
  return {
    source: 'freelancer', extId: String(p.id), kind: 'marketplace',
    url: `https://www.freelancer.com/projects/${p.seo_url || p.id}`,
    title: String(p.title || '').trim().slice(0, 200),
    description: stripHtml(p.description || p.preview_description || '', 3000),
    contact: null, category: skills.slice(0, 4).join(', '),
    currency: p.currency?.code || 'USD', budgetMin: min, budgetMax: max,
    budgetIdrMin: Math.round(usdMin * usdIdr), budgetIdrMax: Math.round(usdMax * usdIdr),
    hourly: p.type === 'hourly', bids: Number(p.bid_stats?.bid_count) || 0,
    postedAt: (Number(p.time_submitted) || Number(p.submitdate) || 0) * 1000,
    skills, location: '', mobile: false,
  };
}

/** @returns {Promise<object[]>} normalised projects, newest first */
export async function fetchFreelancer(fetchImpl = globalThis.fetch, { limit = 100, usdIdr = 16500 } = {}) {
  const q = new URLSearchParams({ limit: String(limit), full_description: 'true', job_details: 'true', sort_field: 'time_submitted', compact: 'false' });
  for (const id of FREELANCER_JOBS) q.append('jobs[]', String(id));
  q.append('languages[]', 'en');
  const res = await fetchImpl(`https://www.freelancer.com/api/projects/0.1/projects/active/?${q}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== 'success') throw new Error('Freelancer.com: respons tidak sukses');
  return (j.result?.projects || []).filter((p) => p && p.status === 'active' && !p.nonpublic).map((p) => normFreelancer(p, { usdIdr }));
}

// ------------------------------------------------------------------ OpenStreetMap local businesses

/** "+62 813-9488-2490" / "0813..." / "(021) 884 4654" -> { digits, mobile } (Indonesia only). */
export function normalizePhone(raw) {
  const first = String(raw || '').split(/[;,/]/)[0];
  let d = first.replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('0')) d = `62${d.slice(1)}`;
  else if (d.startsWith('8')) d = `62${d}`;
  if (!d.startsWith('62') || d.length < 9 || d.length > 15) return null;
  return { digits: d, mobile: /^628\d{7,12}$/.test(d) };
}

const CATEGORY_LABEL = {
  restaurant: 'restoran', cafe: 'kafe', fast_food: 'warung makan', clinic: 'klinik', dentist: 'klinik gigi', pharmacy: 'apotek', school: 'sekolah', kindergarten: 'TK/PAUD',
  clothes: 'toko pakaian', boutique: 'butik', laundry: 'laundry', car_repair: 'bengkel', hairdresser: 'salon', beauty: 'salon kecantikan', bakery: 'toko roti',
  supermarket: 'minimarket', computer: 'toko komputer', hardware: 'toko bangunan', electronics: 'toko elektronik', furniture: 'toko furnitur', florist: 'toko bunga',
  travel_agency: 'agen perjalanan', real_estate: 'agen properti', insurance: 'agen asuransi', lawyer: 'kantor hukum', accountant: 'kantor akuntan', company: 'perusahaan',
};

export function normOsm(el) {
  const t = el.tags || {};
  const phone = normalizePhone(t.phone || t['contact:phone'] || t['contact:mobile'] || t.mobile);
  const cat = t.shop || t.amenity || t.office || t.craft || '';
  const addr = [t['addr:street'], t['addr:housenumber'], t['addr:suburb'] || t['addr:city']].filter(Boolean).join(' ');
  return {
    source: 'osm', extId: `${el.type || 'node'}/${el.id}`, kind: 'local',
    url: `https://www.openstreetmap.org/${el.type || 'node'}/${el.id}`,
    title: String(t.name || '').trim().slice(0, 120), description: [CATEGORY_LABEL[cat] || cat, addr].filter(Boolean).join(' · '),
    contact: phone?.digits || null, mobile: Boolean(phone?.mobile), category: cat, email: t.email || t['contact:email'] || null,
    currency: 'IDR', budgetMin: 0, budgetMax: 0, budgetIdrMin: 0, budgetIdrMax: 0, hourly: false, bids: 0, postedAt: 0,
    skills: [], location: addr,
  };
}

/** Businesses with a phone number and NO website inside a named administrative area. */
export async function fetchOsmBusinesses(fetchImpl = globalThis.fetch, { area = 'Bekasi', limit = 400 } = {}) {
  if (!/^[A-Za-z0-9 .'-]{2,40}$/.test(area)) throw new Error('nama area tidak valid');
  const q = `[out:json][timeout:60];area["name"="${area}"]["boundary"="administrative"]->.a;(`
    + 'node(area.a)["shop"]["phone"][!"website"];'
    + 'node(area.a)["amenity"~"restaurant|cafe|fast_food|clinic|dentist|pharmacy|school|kindergarten"]["phone"][!"website"];'
    + 'node(area.a)["office"]["phone"][!"website"];'
    + `);out body ${Math.min(1000, limit)};`;
  const res = await fetchImpl('https://overpass-api.de/api/interpreter', {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(q)}`, signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j.elements || []).map(normOsm).filter((p) => p.title && p.contact);
}
