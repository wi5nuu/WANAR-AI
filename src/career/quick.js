/**
 * src/career/quick.js
 *
 * Plain-language career commands for the Telegram/WhatsApp assistant, answered by code
 * (instant, no tokens, from the radar's own data):
 *
 *   "lowongan baru"  ·  "ada lowongan cocok?"  ·  "loker hari ini"
 *   "pindai lowongan sekarang"  ·  "cari lowongan sekarang"
 *   "status lamaran"  ·  "rekap lamaran"
 *
 * The patterns are deliberately tight: "buatkan cover letter untuk lowongan di X" is a request for
 * the model, not a radar query, so it must fall through untouched.
 *
 * @author Wisnu Alfian Nur Ashar
 */

const SCAN = /^\s*(?:tolong\s+)?(?:pindai|scan|cari(?:kan)?|cek)\s+(?:lowongan|loker)(?:\s+(?:remote|kerja))?(?:\s+(?:sekarang|lagi|ulang|baru))?\s*[.!?]*\s*$/i;
const LIST = /^\s*(?:ada\s+)?(?:lowongan|loker)(?:\s+(?:kerja|remote))?(?:\s+(?:apa|baru|terbaru|cocok|hari\s+ini|untuk\s+(?:saya|aku|mas)))*\s*(?:yang\s+cocok)?\s*[.!?]*\s*$|^\s*(?:lowongan|loker)\s+apa\s+(?:yang\s+)?(?:cocok|baru)\b|^\s*radar\s+(?:lowongan|kerja|karir|karier)\s*[.!?]*\s*$/i;
const STATUS = /^\s*(?:status|rekap|ringkasan)\s+(?:lamaran|karir|karier|lowongan)\s*[.!?]*\s*$/i;

const LABEL = { new: 'baru', shortlisted: 'dipilih', applying: 'sedang dilamar', applied: 'sudah dilamar', interview: 'wawancara', offer: 'penawaran', rejected: 'ditolak', skipped: 'dilewati' };
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

export async function quickCareer(career, text) {
  const t = String(text || '').trim();
  if (!career || !t || t.length > 80) return null;

  if (SCAN.test(t)) {
    if (career.running) return 'Pemindaian lowongan masih berjalan. Hasilnya saya kabari begitu selesai.';
    career.scan().catch(() => {});
    return 'Baik, saya pindai semua sumber lowongan remote sekarang. Kalau ada yang cocok, saya kirim ringkasannya di sini.';
  }

  if (STATUS.test(t)) {
    const s = career.store.stats();
    const parts = Object.entries(s.byStatus).filter(([k]) => k !== 'skipped').map(([k, n]) => `${LABEL[k] || k}: ${n}`);
    return [
      `Rekap karir: ${s.total} lowongan terpantau, ${s.apply} layak dilamar (belum diproses), ${s.maybe} perlu dipertimbangkan.`,
      parts.length ? `Status: ${parts.join(', ')}.` : 'Belum ada lamaran yang tercatat.',
      s.lastScan ? `Pemindaian terakhir: ${new Date(s.lastScan).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false })} WIB.` : 'Belum pernah memindai.',
    ].join('\n');
  }

  if (LIST.test(t)) {
    const apply = career.store.listJobs({ verdict: 'apply', status: 'new', limit: 5 }).jobs;
    const maybe = apply.length < 5 ? career.store.listJobs({ verdict: 'maybe', status: 'new', limit: 5 - apply.length }).jobs : [];
    if (!apply.length && !maybe.length) {
      return 'Belum ada lowongan baru yang cocok. Radar memindai sendiri tiap beberapa jam; ketik "pindai lowongan sekarang" kalau mau saya cek saat ini.';
    }
    const lines = ['Lowongan remote yang cocok dengan profil Mas:', ''];
    [...apply, ...maybe].forEach((j, i) => {
      lines.push(`${i + 1}. [${j.score}] ${clip(j.title, 80)} - ${clip(j.company || 'perusahaan tidak disebut', 40)}${j.verdict === 'maybe' ? ' (perlu dicek)' : ''}`);
      if (j.location) lines.push(`   ${clip(j.location, 70)}${j.salary_text ? ` | ${clip(j.salary_text, 30)}` : ''}`);
      lines.push(`   ${j.url}`);
    });
    return lines.join('\n');
  }

  return null;
}
