/**
 * src/career/report.js
 *
 * The owner's daily report: short, plain, and the same shape every day, so it can be read in ten
 * seconds. It says what the agent did in the last 24 hours, whether there is good news, whether
 * the agent itself stayed alive, and the one thing (if any) that needs the owner.
 *
 * Pure: it only reads the store, so it is easy to test and can never change anything.
 *
 * @author Wisnu Alfian Nur Ashar
 */

const DAY = 86_400_000;
const WIB = 7 * 3_600_000;

const DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** WIB calendar parts for an epoch ms. */
export function wib(now) {
  const d = new Date(now + WIB);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes() };
}

/** "2026-10-16" in WIB: the key that makes "one report per day" survive restarts. */
export function wibDay(now) {
  const p = wib(now);
  return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

const hhmm = (ts) => {
  const p = wib(ts);
  return `${String(p.h).padStart(2, '0')}.${String(p.min).padStart(2, '0')}`;
};
const n = (v) => Number(v || 0).toLocaleString('id-ID');

/**
 * @param {import('./store.js').CareerStore} store
 * @param {{now?: number, sections?: Array<() => string[]>, intervalMs?: number}} opts
 * @returns {{text: string, facts: object}}
 */
export function buildDailyReport(store, { now = Date.now(), sections = [], intervalMs = 6 * 3_600_000 } = {}) {
  const since = now - DAY;
  const db = store.db;
  const one = (sql, ...a) => db.prepare(sql).get(...a);

  const f = {
    newJobs: one('SELECT COUNT(*) c FROM career_jobs WHERE first_seen >= ?', since).c,
    newApply: one("SELECT COUNT(*) c FROM career_jobs WHERE first_seen >= ? AND verdict = 'apply'", since).c,
    newMaybe: one("SELECT COUNT(*) c FROM career_jobs WHERE first_seen >= ? AND verdict = 'maybe'", since).c,
    applied: one("SELECT COUNT(*) c FROM career_jobs WHERE status = 'applied' AND status_at >= ?", since).c,
    appliedTotal: one("SELECT COUNT(*) c FROM career_jobs WHERE status IN ('applied','interview','offer','rejected')").c,
    interview: one("SELECT COUNT(*) c FROM career_jobs WHERE status = 'interview' AND status_at >= ?", since).c,
    offer: one("SELECT COUNT(*) c FROM career_jobs WHERE status = 'offer' AND status_at >= ?", since).c,
    rejected: one("SELECT COUNT(*) c FROM career_jobs WHERE status = 'rejected' AND status_at >= ?", since).c,
    waiting: one("SELECT COUNT(*) c FROM career_jobs WHERE verdict = 'apply' AND status = 'new'").c,
    scans: one("SELECT COUNT(*) c FROM agent_activity WHERE agent = 'career' AND kind = 'scan' AND level != 'error' AND ts >= ?", since).c,
    sourceErrors: one("SELECT COUNT(*) c FROM agent_activity WHERE kind = 'source_error' AND ts >= ?", since).c,
    starts: one("SELECT COUNT(*) c FROM agent_activity WHERE kind = 'start' AND ts >= ?", since).c,
    lastScan: one("SELECT MAX(ts) t FROM agent_activity WHERE agent = 'career' AND kind = 'scan' AND level != 'error'").t || null,
  };
  const restarts = Math.max(0, f.starts - 1);
  const stalled = !f.lastScan || now - f.lastScan > intervalMs * 2;

  const p = wib(now);
  const lines = [`Laporan harian agent - ${DAYS[p.dow]}, ${p.d} ${MONTHS[p.m]} (${String(p.h).padStart(2, '0')}.${String(p.min).padStart(2, '0')} WIB)`, ''];

  // 1) the numbers the owner asked for: how many applications, and is there good news
  lines.push(`Lamaran: ${n(f.applied)} terkirim dalam 24 jam (total ${n(f.appliedTotal)})`);
  if (f.offer || f.interview) {
    const good = [];
    if (f.offer) good.push(`${f.offer} penawaran kerja`);
    if (f.interview) good.push(`${f.interview} undangan wawancara`);
    lines.push(`Kabar baik: ${good.join(', ')}`);
  } else {
    lines.push('Kabar baik: belum ada');
  }
  if (f.rejected) lines.push(`Ditolak: ${f.rejected}`);

  // 2) what the radar found
  lines.push(`Radar: ${n(f.newJobs)} lowongan baru dibaca, ${n(f.newApply)} layak dilamar, ${n(f.newMaybe)} perlu dicek`);

  // 3) anything other modules want to say (market alerts, emails, alarms...)
  for (const fn of sections) {
    try {
      for (const l of fn({ since, now }) || []) if (l) lines.push(l);
    } catch { /* one broken section must never block the report */ }
  }

  // 4) is the agent itself alive?
  lines.push('');
  if (stalled) {
    lines.push(f.lastScan
      ? `Kesehatan: PERHATIAN, radar terakhir memindai pukul ${hhmm(f.lastScan)} WIB. Saya sedang mencoba menyalakannya lagi.`
      : 'Kesehatan: PERHATIAN, radar belum pernah memindai.');
  } else {
    lines.push(`Kesehatan: aktif terus (${f.scans} pemindaian, terakhir ${hhmm(f.lastScan)} WIB, restart ${restarts}x, sumber gagal ${f.sourceErrors}x)`);
  }

  // 5) the one thing that needs the owner, if anything
  if (f.waiting > 0) lines.push(`Menunggu keputusan Mas: ${f.waiting} lowongan layak dilamar. Ketik "lowongan baru" untuk melihatnya.`);
  else lines.push('Tidak ada yang perlu Mas putuskan sekarang.');

  return { text: lines.join('\n'), facts: { ...f, restarts, stalled } };
}
