/**
 * src/sales/prompt.js
 *
 * What the owner's chat assistant (the model behind Telegram) is told about the business side. Without
 * this it knows nothing about the client radar and answers "I cannot browse the internet" or invents a
 * price, even though the radar has been working all night. Everything here is real data read at the moment
 * of the question; the model is told to answer client/price questions ONLY from it.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { priceRange } from './catalog.js';
import { skillsFromFacts } from '../career/facts.js';

const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
const hhmm = (ts) => new Date(ts).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }).replace(':', '.');

/** @returns {string[]} prompt lines (empty when the sales desk is off) */
export function salesPromptLines({ sales, career = null }) {
  if (!sales) return [];
  const out = ['', 'BISNIS & KLIEN (data nyata sistem, dibaca saat ini; jawab pertanyaan tentang klien, peluang, dan harga HANYA dari sini):'];
  const pr = sales.prospects;
  try {
    if (pr) {
      const o = pr.overview();
      out.push(
        '- Radar peluang klien BEKERJA OTOMATIS setiap hari tanpa diminta: Freelancer.com tiap 6 jam; usaha lokal tanpa website tiap 3 hari '
        + `(${o.areas.join(', ')}); paket pagi pukul 08.00 WIB dan tindak lanjut pukul 10.00 ke Telegram. JANGAN pernah bilang kamu tidak bisa mencari klien atau "keliling internet": radar sudah melakukannya.`,
        '- Yang TIDAK dilakukan sistem: menghubungi calon klien sendiri. Pesan pertama selalu dikirim ' + 'pemilik dari WhatsApp/platformnya (aturan WhatsApp dan marketplace). Pesan di "paket pagi" disiapkan untuk pemilik kirim, BUKAN terkirim ke klien.',
        `- Terdata: ${o.stats.total} peluang (${o.stats.goodLocal} usaha lokal cocok, ${o.stats.goodMarket} proyek Freelancer cocok). Pindaian Freelancer terakhir ${o.lastFreelancer ? hhmm(o.lastFreelancer) : 'belum ada'} WIB.`,
        `- Paket pagi terakhir: ${o.lastBatch ? `${hhmm(o.lastBatch)} WIB` : 'belum pernah'}. Ditandai dihubungi: ${o.stats.byStatus.contacted || 0}; membalas: ${o.stats.byStatus.replied || 0}; menang: ${o.stats.byStatus.won || 0}.`,
      );
      if (o.recent.length) out.push(`- Peluang terakhir yang dikirim ke pemilik: ${o.recent.map((p) => `#${p.id} ${clip(p.title, 34)} (${p.status})`).join('; ')}.`);
    }
    const st = sales.store.stats();
    out.push(`- Calon klien yang menulis sendiri (website/WhatsApp): ${st.open} aktif, ${st.needsOwner} perlu pemilik, ${st.won30.n} deal 30 hari.`);
    const cat = sales.catalog();
    const approved = cat.services.filter((s) => s.price.approved);
    out.push(approved.length
      ? `- HARGA yang sudah disetujui pemilik (satu-satunya yang boleh kamu sebut): ${approved.map((s) => `${s.name}: ${priceRange(s.price)}`).join('; ')}. Bila ditanya kisaran harga, jawab dari daftar ini; JANGAN mengarang angka pasar sendiri. Bila pemilik ingin tarif lebih rendah untuk usaha kecil, sarankan perintah: atur harga landing 750rb - 2jt.`
      : '- Belum ada harga yang disetujui pemilik. JANGAN menyebut angka harga; minta pemilik menyetujui lewat perintah "setujui harga".');
    const facts = sales.getFacts?.();
    const p = facts?.en?.personalInfo;
    if (p) {
      const projects = (facts.en.projects || []).map((x) => x.name || x.title).filter(Boolean);
      out.push(
        `- PORTOFOLIO pemilik (TERHUBUNG, diimpor dari situsnya ${p.website || ''}): ${p.name}, ${p.role || 'pengembang'}, ${p.location || ''}. GitHub: ${p.github || '-'}. `
        + `Keahlian: ${clip(skillsFromFacts(facts).slice(0, 14).join(', '), 220)}. `
        + (projects.length ? `Proyek: ${clip(projects.slice(0, 8).join('; '), 220)}. ` : '')
        + 'JANGAN bilang kamu belum terhubung atau tidak tahu portofolio pemilik; pakai data ini untuk menjual kemampuannya.',
      );
    }
  } catch { /* the business block is best-effort: never break the chat */ }
  out.push('- Perintah yang bisa pemilik ketik: peluang, "peluang lagi", peluang <id>, peluang <id> dihubungi/balas/menang/kalah/lewati, saran balasan: <pesan klien>, prospek, balas prospek <id>: <pesan>, setujui harga, atur harga <layanan> <min> - <maks>, laporan agent, lowongan baru, kit <id>.');
  void career;
  return out;
}
