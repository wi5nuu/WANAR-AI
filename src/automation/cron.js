/**
 * src/automation/cron.js
 *
 * Dependency-free schedule parser + "next run" calculator with real timezone
 * support (default Asia/Jakarta / WIB).
 *
 * Accepted schedule expressions
 * -----------------------------
 *   Standard cron (5 fields)   "30 8 * * 1-5"      menit jam tgl bulan hari
 *   Cron presets               "@hourly" "@daily" "@weekly" "@monthly" "@weekdays"
 *   Interval                   "every 15m"  "every 2h"  "setiap 30 menit"
 *   Daily                      "daily@08:00"      | "harian@08:00"
 *   Weekdays (Mon-Fri)         "weekdays@09:30"   | "harikerja@09:30"
 *   Weekly                     "weekly:mon,wed@08:00" | "mingguan:senin@08:00"
 *   Monthly                    "monthly:1@08:00"  | "bulanan:1@08:00"
 *
 * Everything is normalised to either an interval or a 5-field cron, so the
 * scheduler only has to understand two shapes.
 *
 * @author Wisnu Alfian Nur Ashar
 */

export const DEFAULT_TIMEZONE = process.env.AUTOMATION_TZ || 'Asia/Jakarta';

const MIN_INTERVAL_MS = 60_000; // never faster than once a minute

const DOW_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  minggu: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, "jum'at": 5, sabtu: 6,
};
const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8, agu: 8,
  sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, des: 12,
};

const PRESETS = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@weekdays': '0 9 * * 1-5',
};

export class ScheduleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScheduleError';
  }
}

// ---------------------------------------------------------------- field parse

function parseNumber(token, names, min, max, label) {
  const lower = token.toLowerCase();
  let n;
  if (names && Object.prototype.hasOwnProperty.call(names, lower)) n = names[lower];
  else if (/^\d+$/.test(token)) n = parseInt(token, 10);
  else throw new ScheduleError(`Nilai "${token}" tidak valid pada kolom ${label}`);
  if (n < min || n > max) {
    throw new ScheduleError(`Kolom ${label}: ${n} di luar rentang ${min}-${max}`);
  }
  return n;
}

function parseField(spec, min, max, label, names = null) {
  const out = new Set();
  let star = false;
  for (const part of String(spec).split(',')) {
    if (!part) throw new ScheduleError(`Kolom ${label} kosong`);
    const [rangePart, stepPart] = part.split('/');
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || parseInt(stepPart, 10) < 1) {
        throw new ScheduleError(`Step "${stepPart}" tidak valid pada kolom ${label}`);
      }
      step = parseInt(stepPart, 10);
    }

    let lo;
    let hi;
    if (rangePart === '*' || rangePart === '?') {
      lo = min;
      hi = max;
      if (stepPart === undefined) star = true;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = parseNumber(a, names, min, max, label);
      hi = parseNumber(b, names, min, max, label);
      if (lo > hi) throw new ScheduleError(`Rentang terbalik pada kolom ${label}: ${rangePart}`);
    } else {
      lo = parseNumber(rangePart, names, min, max, label);
      hi = stepPart !== undefined ? max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return { values: out, star };
}

// ------------------------------------------------------------ friendly forms

function pad(n) {
  return String(n).padStart(2, '0');
}

function parseHHMM(text) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(text).trim());
  if (!m) throw new ScheduleError(`Jam "${text}" tidak valid — gunakan format HH:MM`);
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) throw new ScheduleError(`Jam "${text}" di luar rentang`);
  return { h, mi };
}

function dowListToCron(list) {
  const nums = String(list)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => {
      if (/^[0-7]$/.test(s)) return s === '7' ? 0 : parseInt(s, 10);
      if (!Object.prototype.hasOwnProperty.call(DOW_NAMES, s)) {
        throw new ScheduleError(`Nama hari "${s}" tidak dikenal`);
      }
      return DOW_NAMES[s];
    });
  if (!nums.length) throw new ScheduleError('Hari belum diisi');
  return [...new Set(nums)].sort((a, b) => a - b).join(',');
}

/** Turns friendly expressions into a plain cron string (or interval marker). */
function normalise(raw) {
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!text) throw new ScheduleError('Jadwal kosong');
  const lower = text.toLowerCase();

  if (PRESETS[lower]) return { cron: PRESETS[lower] };

  // interval: "every 15m", "setiap 2 jam", "every 30 minutes"
  let m = /^(?:every|setiap)\s+(\d+)\s*(m|min|mins|minute|minutes|menit|h|hr|hrs|hour|hours|jam|d|day|days|hari)$/.exec(lower);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    let ms;
    if (/^m|menit/.test(unit)) ms = n * 60_000;
    else if (/^h|jam/.test(unit)) ms = n * 3_600_000;
    else ms = n * 86_400_000;
    if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS) {
      throw new ScheduleError('Interval minimal 1 menit');
    }
    return { intervalMs: ms };
  }

  // daily / weekdays
  m = /^(daily|harian|weekdays|harikerja)@(.+)$/.exec(lower);
  if (m) {
    const { h, mi } = parseHHMM(m[2]);
    const dow = /^(weekdays|harikerja)$/.test(m[1]) ? '1-5' : '*';
    return { cron: `${mi} ${h} * * ${dow}` };
  }

  // weekly:mon,wed@08:00
  m = /^(weekly|mingguan):([^@]+)@(.+)$/.exec(lower);
  if (m) {
    const { h, mi } = parseHHMM(m[3]);
    return { cron: `${mi} ${h} * * ${dowListToCron(m[2])}` };
  }

  // monthly:1,15@08:00
  m = /^(monthly|bulanan):([^@]+)@(.+)$/.exec(lower);
  if (m) {
    const { h, mi } = parseHHMM(m[3]);
    return { cron: `${mi} ${h} ${m[2].replace(/\s+/g, '')} * *` };
  }

  // raw 5-field cron
  if (text.split(' ').length === 5) return { cron: text };

  throw new ScheduleError(
    `Format jadwal tidak dikenali: "${raw}". Contoh: "daily@08:00", "weekdays@09:00", "every 30m", atau cron "0 8 * * 1-5".`
  );
}

// ---------------------------------------------------------------- public API

/**
 * Parses an expression into a normalised schedule object.
 * @returns {{type:'cron'|'interval', source:string, cron?:string, intervalMs?:number, fields?:object}}
 */
export function parseSchedule(expression) {
  const n = normalise(expression);
  if (n.intervalMs) {
    return { type: 'interval', source: String(expression).trim(), intervalMs: n.intervalMs };
  }

  const parts = n.cron.split(' ');
  if (parts.length !== 5) throw new ScheduleError('Cron harus memiliki 5 kolom: menit jam tanggal bulan hari');
  const [minS, hourS, domS, monS, dowS] = parts;

  const minute = parseField(minS, 0, 59, 'menit');
  const hour = parseField(hourS, 0, 23, 'jam');
  const dom = parseField(domS, 1, 31, 'tanggal');
  const month = parseField(monS, 1, 12, 'bulan', MONTH_NAMES);
  const dowRaw = parseField(dowS, 0, 7, 'hari', DOW_NAMES);
  const dowValues = new Set([...dowRaw.values].map((v) => (v === 7 ? 0 : v)));

  return {
    type: 'cron',
    source: String(expression).trim(),
    cron: n.cron,
    fields: {
      minute: [...minute.values].sort((a, b) => a - b),
      hour: [...hour.values].sort((a, b) => a - b),
      dom: dom.values,
      month: month.values,
      dow: dowValues,
      domStar: dom.star,
      dowStar: dowRaw.star,
    },
  };
}

// ----------------------------------------------------------------- timezones

const fmtCache = new Map();

function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      throw new ScheduleError(`Zona waktu "${tz}" tidak dikenal`);
    }
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock components of an instant in a timezone. */
export function zonedParts(ms, tz = DEFAULT_TIMEZONE) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10);
  }
  return { year: o.year, month: o.month, day: o.day, hour: o.hour % 24, minute: o.minute, second: o.second };
}

function offsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Converts a wall-clock time in `tz` to a UTC epoch (ms). */
export function zonedToUtc(year, month, day, hour, minute, tz = DEFAULT_TIMEZONE) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utc = guess - offsetMs(guess, tz);
  const off2 = offsetMs(utc, tz);
  utc = guess - off2;
  return utc;
}

/**
 * Next fire time strictly after `afterMs`.
 * @returns {number|null} epoch ms, or null when the schedule can never fire.
 */
export function nextRun(schedule, afterMs = Date.now(), tz = DEFAULT_TIMEZONE) {
  if (schedule.type === 'interval') return afterMs + schedule.intervalMs;

  const f = schedule.fields;
  const start = Math.floor(afterMs / 60_000) * 60_000 + 60_000; // next whole minute
  const sp = zonedParts(start, tz);

  // Walk day by day in calendar space; ~6 years covers Feb-29 schedules.
  const cursor = new Date(Date.UTC(sp.year, sp.month - 1, sp.day));
  for (let i = 0; i < 366 * 6; i++) {
    const y = cursor.getUTCFullYear();
    const mo = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    const dow = cursor.getUTCDay();

    if (f.month.has(mo)) {
      let dayOk;
      if (f.domStar && f.dowStar) dayOk = true;
      else if (f.domStar) dayOk = f.dow.has(dow);
      else if (f.dowStar) dayOk = f.dom.has(d);
      else dayOk = f.dom.has(d) || f.dow.has(dow); // classic cron OR semantics

      if (dayOk) {
        for (const h of f.hour) {
          for (const mi of f.minute) {
            const utc = zonedToUtc(y, mo, d, h, mi, tz);
            if (utc >= start) return utc;
          }
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null;
}

/** Next `count` fire times — used by the UI to preview a schedule. */
export function upcoming(schedule, count = 5, fromMs = Date.now(), tz = DEFAULT_TIMEZONE) {
  const out = [];
  let t = fromMs;
  for (let i = 0; i < count; i++) {
    const n = nextRun(schedule, t, tz);
    if (n == null) break;
    out.push(n);
    t = n;
  }
  return out;
}

const DAY_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

/** Human-readable Indonesian description. */
export function describe(schedule) {
  if (schedule.type === 'interval') {
    const ms = schedule.intervalMs;
    if (ms % 86_400_000 === 0) return `Setiap ${ms / 86_400_000} hari`;
    if (ms % 3_600_000 === 0) return `Setiap ${ms / 3_600_000} jam`;
    return `Setiap ${ms / 60_000} menit`;
  }
  const f = schedule.fields;
  const single = (arr) => (arr.length === 1 ? arr[0] : null);
  const h = single(f.hour);
  const mi = single(f.minute);
  const time = h !== null && mi !== null ? `pukul ${pad(h)}:${pad(mi)}` : null;

  if (f.domStar && f.dowStar && f.month.size === 12) {
    if (time) return `Setiap hari ${time}`;
    return `Setiap menit ${f.minute.join(',')} pada jam ${f.hour.join(',')}`;
  }
  if (f.domStar && !f.dowStar) {
    const days = [...f.dow].sort((a, b) => a - b);
    const isWeekdays = days.join(',') === '1,2,3,4,5';
    const label = isWeekdays ? 'Senin–Jumat' : days.map((d) => DAY_ID[d]).join(', ');
    return `Setiap ${label}${time ? ` ${time}` : ''}`;
  }
  if (!f.domStar && f.dowStar) {
    return `Setiap tanggal ${[...f.dom].sort((a, b) => a - b).join(', ')}${time ? ` ${time}` : ''}`;
  }
  return `Cron: ${schedule.cron}`;
}

/** Validates an expression + timezone, returning a UI-ready summary. */
export function previewSchedule(expression, tz = DEFAULT_TIMEZONE, count = 5) {
  formatter(tz); // validates tz
  const schedule = parseSchedule(expression);
  const times = upcoming(schedule, count, Date.now(), tz);
  if (!times.length) throw new ScheduleError('Jadwal ini tidak akan pernah berjalan');
  return {
    expression: schedule.source,
    type: schedule.type,
    normalized: schedule.type === 'cron' ? schedule.cron : `every ${schedule.intervalMs / 60_000}m`,
    description: describe(schedule),
    timezone: tz,
    next: times,
  };
}
