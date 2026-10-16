/**
 * src/sales/prospects/drafts.js
 *
 * The message the OWNER sends to a prospect, written for him. Every sentence is fixed text filled with
 * the prospect's own name/title and the owner's own fact sheet. No price is ever put in a first message
 * to a local business, and a marketplace bid only suggests an amount from prices the owner approved.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { priceRange, proofLines } from '../catalog.js';
import { matchedFactSkills } from '../../career/kit.js';

export function waLink(digits, text) {
  return `https://wa.me/${String(digits).replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

const firstName = (facts) => String(facts?.en?.personalInfo?.name || 'Wisnu').split(/\s+/)[0];
const cityOf = (facts) => String(facts?.en?.personalInfo?.location || 'Bekasi').split(',')[0].trim() || 'Bekasi';

const BENEFIT = [
  [/^(restaurant|cafe|fast_food|bakery)$/, 'memajang menu, jam buka, dan lokasi supaya mudah ditemukan di Google'],
  [/^(clinic|dentist|pharmacy)$/, 'menampilkan jadwal praktik, layanan, dan kontak supaya pasien mudah menghubungi'],
  [/^(school|kindergarten)$/, 'menampilkan program, informasi pendaftaran, dan kontak untuk orang tua'],
  [/^(clothes|boutique|florist|furniture|electronics|computer|hardware|supermarket)$/, 'memajang katalog produk dan memudahkan pelanggan memesan lewat WhatsApp'],
  [/^(laundry|car_repair|hairdresser|beauty|travel_agency|real_estate|insurance|lawyer|accountant)$/, 'menampilkan layanan, cara memesan, dan kontak dengan rapi'],
];
const benefitFor = (cat) => BENEFIT.find(([re]) => re.test(cat))?.[1] || 'menampilkan profil usaha, layanan, dan kontak';

/** First WhatsApp message to a local business: warm, specific, no price, easy to decline. */
export function localOffer(p, facts = null) {
  const pi = facts?.en?.personalInfo || {};
  const lines = [
    `Halo, selamat siang. Saya ${firstName(facts)}, pembuat website dari ${cityOf(facts)}.`,
    '',
    `Saya melihat ${p.title} belum memiliki website. Halaman web sederhana bisa membantu ${benefitFor(p.category)}.`,
  ];
  if (pi.website) lines.push('', `Contoh karya saya: ${pi.website}`);
  lines.push('', 'Kalau berminat, saya bisa kirimkan contoh tampilan dan estimasi tanpa kewajiban apa pun. Kalau tidak berkenan, abaikan saja pesan ini. Terima kasih.');
  const text = lines.join('\n');
  return { channel: 'whatsapp', text, link: p.contact && p.mobile ? waLink(p.contact, text) : null };
}

/** Gentle follow-ups: at most two, then stop. */
export function followUpText(p, facts = null, n = 1) {
  const me = firstName(facts);
  const text = n <= 1
    ? `Halo, saya ${me} yang kemarin menghubungi soal website untuk ${p.title}. Kalau masih berminat, saya siap kirimkan contoh tampilannya. Kalau tidak, tidak apa-apa, terima kasih ya.`
    : `Halo, sekadar menindaklanjuti pesan saya sebelumnya. Kalau suatu saat ${p.title} butuh website, kabari saya saja ya. Terima kasih.`;
  return { channel: 'whatsapp', text, link: p.contact && p.mobile ? waLink(p.contact, text) : null };
}

/**
 * Bid message for a marketplace project plus a suggested amount (only from prices the owner approved).
 * @returns {{text: string, bid: {amount:number, currency:string, note:string}|null, warnings: string[]}}
 */
export function freelancerProposal(p, catalog, facts = null, { serviceId = null, usdIdr = 16500 } = {}) {
  const pi = facts?.en?.personalInfo || {};
  const svc = catalog.services.find((s) => s.id === (serviceId || p.serviceId)) || null;
  const warnings = [];
  const skills = facts ? matchedFactSkills({ title: p.title, tags: p.skills, description: p.description }, facts) : [];
  const proof = svc && facts ? proofLines(svc, facts, 2) : [];

  const lines = ['Hello,', '', `I read your project "${p.title}"${svc ? ` and it matches what I build: ${svc.name.toLowerCase()}` : ''}. I am a full-stack developer based in ${pi.location || 'Indonesia'}.`];
  if (skills.length) lines.push('', `From my own stack, I work with ${skills.join(', ')}.`);
  if (proof.length) lines.push('', 'Relevant work:', ...proof.map((l) => `- ${l}`));
  lines.push('', 'How I would approach it:', '1. Confirm the scope and priorities with you', '2. Build and show progress in clear stages', '3. Test, hand over, and document');
  const qs = (svc?.questions || []).slice(0, 2);
  if (qs.length) lines.push('', 'To give you an accurate plan, could you tell me:', ...qs.map((q, i) => `${i + 1}. ${q}`));
  if (svc?.price.approved) lines.push('', `Typical delivery for work like this: ${svc.days[0]}-${svc.days[1]} working days, depending on final scope.`);
  const links = [pi.website, pi.github].filter(Boolean).join(' | ');
  if (links) lines.push('', `Portfolio: ${links}`);
  lines.push('', 'Best regards,', pi.name || '');

  // Suggested amount: inside BOTH the client's budget and the price range the owner approved.
  let bid = null;
  if (!svc) warnings.push('Layanan belum teridentifikasi; tentukan penawaran sendiri.');
  else if (!svc.price.approved) warnings.push('Harga layanan ini belum Mas setujui, jadi agent tidak menyarankan angka. Tentukan sendiri.');
  else if (p.budgetIdrMax > 0 && p.budgetMax > 0) {
    const perUnit = p.budgetIdrMax / p.budgetMax;            // IDR per 1 unit of the project's currency
    const lo = Math.max(svc.price.min, p.budgetIdrMin || 0);
    const hi = Math.min(svc.price.max, p.budgetIdrMax);
    if (p.budgetIdrMax < svc.price.min) warnings.push(`Anggaran klien (${priceRange({ min: p.budgetIdrMin, max: p.budgetIdrMax, unit: 'proyek' })}) di bawah harga minimum Mas (${priceRange(svc.price)}). Pertimbangkan melewatkannya.`);
    else if (hi >= lo) {
      const idr = Math.round((lo + hi) / 2 / 1000) * 1000;
      bid = { amount: Math.round((idr / perUnit) * 100) / 100, currency: p.currency, note: `tengah-tengah antara anggaran klien dan kisaran harga Mas${p.hourly ? ' (per jam)' : ''}` };
    } else warnings.push('Tidak ada irisan antara anggaran klien dan kisaran harga Mas.');
  } else warnings.push('Klien tidak mencantumkan anggaran; tentukan penawaran sendiri.');
  if (p.bids > 40) warnings.push(`Sudah ${p.bids} penawar: pesan harus menonjol di baris pertama.`);
  void usdIdr;
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), bid, warnings };
}
