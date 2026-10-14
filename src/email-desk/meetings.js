/**
 * src/email-desk/meetings.js
 *
 * Finds a meeting in an email ("rapat jam 2 siang sekitar 30 menit di ruangan IT")
 * so the assistant can put it in the schedule by itself. Deterministic on purpose:
 * no model call, no cost, no hallucinated times. If the email does not state both a
 * meeting word and a clear time, nothing is scheduled.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { localDate, addDays, atTime, weekday } from '../worklog/time.js';

const MEETING_WORD = /\b(rapat|meeting|zoom|google meet|gmeet|ms teams|teams|video ?call|call|panggilan|interview|wawancara|presentasi|demo|briefing|sync|stand-?up|sidang|bimbingan|konsultasi|pertemuan|ketemu(an)?|bertemu|kunjungan|training|pelatihan|workshop|webinar|kelas|seminar)\b/i;

const DAYS = { minggu: 0, ahad: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, "jum'at": 5, jumat: 5, sabtu: 6 };
const MONTHS = {
  januari: 1, jan: 1, februari: 2, feb: 2, maret: 3, mar: 3, april: 4, apr: 4, mei: 5, juni: 6, jun: 6,
  juli: 7, jul: 7, agustus: 8, agu: 8, agt: 8, aug: 8, september: 9, sep: 9, oktober: 10, okt: 10, oct: 10,
  november: 11, nov: 11, desember: 12, des: 12, dec: 12,
};

const pad = (n) => String(n).padStart(2, '0');

function parseTime(text) {
  // "jam 2 siang", "pukul 14.30", "jam 9 pagi", "at 3 pm"
  let m = /(?:\bjam|\bpukul|\bpkl\.?|\bat|@)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:wib|wita|wit)?\s*(pagi|siang|sore|malam|am|pm)?\b/i.exec(text);
  if (!m) {
    // bare 24h time like 14:30 / 14.00, not a date such as 14.10.2026
    const b = /(?<![\d.:/])([01]?\d|2[0-3])[:.]([0-5]\d)(?![\d]|[.:/]\d)/.exec(text);
    if (!b) return null;
    m = [b[0], b[1], b[2], null];
  }
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const period = String(m[3] || '').toLowerCase();
  if (h > 23 || min > 59) return null;
  if ((period === 'siang' || period === 'sore' || period === 'malam' || period === 'pm') && h < 12) h += 12;
  if (period === 'siang' && h === 0) h = 12;
  if ((period === 'pagi' || period === 'am') && h === 12) h = 0;
  // "jam 2" with no period: nobody holds a meeting at 02:00 — read as working hours
  if (!period && h >= 1 && h <= 6 && !m[2]) h += 12;
  return { h, min, idx: m.index ?? 0 };
}

function parseDate(text, today, ref) {
  const t = text.toLowerCase();
  if (/\bhari ini\b|\btoday\b|\bsiang ini\b|\bsore ini\b|\bpagi ini\b|\bmalam ini\b/.test(t)) return { date: today, explicit: true };
  if (/\bbesok\b|\btomorrow\b/.test(t)) return { date: addDays(today, 1), explicit: true };
  if (/\blusa\b/.test(t)) return { date: addDays(today, 2), explicit: true };

  let m = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, explicit: true };

  m = /\b(\d{1,2})\s+(januari|jan|februari|feb|maret|mar|april|apr|mei|juni|jun|juli|jul|agustus|agu|agt|aug|september|sep|oktober|okt|oct|november|nov|desember|des|dec)\w*\.?(?:\s+(20\d{2}))?/.exec(t);
  if (m) {
    const year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
    let date = `${year}-${pad(MONTHS[m[2]])}-${pad(Number(m[1]))}`;
    if (!m[3] && date < today) date = `${year + 1}-${pad(MONTHS[m[2]])}-${pad(Number(m[1]))}`;
    return { date, explicit: true };
  }
  m = /\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/.exec(t);
  if (m) return { date: `${m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`, explicit: true };

  m = /\b(?:hari\s+)?(senin|selasa|rabu|kamis|jum'?at|sabtu|minggu|ahad)\b/.exec(t);
  if (m) {
    const want = DAYS[m[1].replace("'", '')];
    let d = today;
    for (let i = 0; i < 8; i++) {
      d = addDays(today, i);
      if (weekday(d) === want && (i > 0 || ref.timeStillAhead)) break;
    }
    return { date: d, explicit: true };
  }
  return null;
}

/**
 * @param {{text:string, subject?:string, from?:string, now?:number}} p
 * @returns {null|{title:string, date:string, time:string, at:number, durationMin:number|null, place:string|null, assumedDate:boolean, past:boolean}}
 */
export function extractMeeting({ text = '', subject = '', from = '', now = Date.now() }) {
  const body = String(text).replace(/\r/g, '').slice(0, 6000);
  const all = `${subject}\n${body}`;
  if (!MEETING_WORD.test(all)) return null;

  const time = parseTime(body) || parseTime(subject);
  if (!time) return null;

  const today = localDate(now);
  const hhmm = `${pad(time.h)}:${pad(time.min)}`;
  const todayAt = atTime(today, hhmm);
  const dated = parseDate(all, today, { timeStillAhead: todayAt != null && todayAt > now });
  // No day given: today if that time is still ahead, otherwise tomorrow — and say it was assumed.
  const day = dated || { date: todayAt != null && todayAt > now ? today : addDays(today, 1), explicit: false };

  const at = atTime(day.date, hhmm);
  if (at == null) return null;

  let durationMin = null;
  const d = /(?:sekitar|selama|durasi|kurang lebih|±|~)?\s*(\d{1,3})\s*(menit|min|jam)\b/i.exec(body);
  if (d) {
    const n = Number(d[1]);
    durationMin = /jam/i.test(d[2]) ? n * 60 : n;
    if (durationMin < 5 || durationMin > 600) durationMin = null;
  }

  let place = null;
  const p = /\b(?:di|at|lokasi:?|tempat:?|ruang(?:an)?|room)\s+((?:ruang(?:an)?\s+)?[^.,;\n]{2,60}?)(?=\s+(?:di|pada|jam|pukul|sekitar|untuk|dengan|ya|dan)\b|[.,;\n]|$)/i.exec(body);
  if (p) place = p[1].replace(/\s+/g, ' ').trim();
  const link = /(https?:\/\/[^\s>]*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com)[^\s>]*)/i.exec(body);
  if (link) place = place ? `${place} (${link[1]})` : link[1];

  const cleanSubject = String(subject || '').replace(/^\s*((re|balas|fwd?)\s*:\s*)+/i, '').trim();
  const kind = (MEETING_WORD.exec(all)?.[1] || 'Meeting');
  const base = cleanSubject || (kind[0].toUpperCase() + kind.slice(1));
  const title = `${base}${from ? ` — ${from}` : ''}`.slice(0, 110);

  return { title, date: day.date, time: hhmm, at, durationMin, place, assumedDate: !day.explicit, past: at < now - 60_000 };
}
