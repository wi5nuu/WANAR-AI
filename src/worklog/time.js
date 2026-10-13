/**
 * src/worklog/time.js
 *
 * Calendar helpers for the work journal. Every "day" is a LOCAL day in the
 * configured timezone (default Asia/Jakarta), never a UTC day: work that ends
 * at 23:30 WIB belongs to that date, not the next one.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { zonedParts, zonedToUtc, DEFAULT_TIMEZONE } from '../automation/cron.js';

export const TZ = process.env.WORKLOG_TZ || DEFAULT_TIMEZONE;
const pad = (n) => String(n).padStart(2, '0');
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDate(s) {
  const m = DATE_RE.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Local calendar date ("YYYY-MM-DD") of an instant. */
export function localDate(ms = Date.now(), tz = TZ) {
  const p = zonedParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Local "HH:MM" of an instant. */
export function localTime(ms, tz = TZ) {
  const p = zonedParts(ms, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Minutes since local midnight. */
export function minuteOfDay(ms, tz = TZ) {
  const p = zonedParts(ms, tz);
  return p.hour * 60 + p.minute;
}

/** [startMs, endMs) of a local date. */
export function dayBounds(date, tz = TZ) {
  const [y, m, d] = date.split('-').map(Number);
  const start = zonedToUtc(y, m, d, 0, 0, tz);
  const next = addDays(date, 1).split('-').map(Number);
  return [start, zonedToUtc(next[0], next[1], next[2], 0, 0, tz)];
}

/** Instant of "HH:MM" on a local date. Accepts "9", "9.30", "09:30", "24:00". */
export function atTime(date, hhmm, tz = TZ) {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2] || 0);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return null;
  if (h === 24) return dayBounds(date, tz)[1];
  const [y, mo, d] = date.split('-').map(Number);
  return zonedToUtc(y, mo, d, h, mi, tz);
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday, for a local date. */
export function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function monthOf(date) {
  return date.slice(0, 7);
}

/** Every date of a "YYYY-MM" month. */
export function datesOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => `${y}-${pad(m)}-${pad(i + 1)}`);
}

const DAY_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTH_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** "Senin, 12 Oktober 2026" */
export function formatDateId(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${DAY_ID[weekday(date)]}, ${d} ${MONTH_ID[m - 1]} ${y}`;
}

/** "7j 30m" */
export function formatMinutes(min) {
  const v = Math.max(0, Math.round(min));
  const h = Math.floor(v / 60);
  const mm = v % 60;
  if (!h) return `${mm}m`;
  return mm ? `${h}j ${mm}m` : `${h}j`;
}

/** "Rp1.250.000" */
export function formatRupiah(n) {
  const v = Math.round(Number(n) || 0);
  return `${v < 0 ? '-' : ''}Rp${Math.abs(v).toLocaleString('id-ID')}`;
}
