/**
 * src/worklog/analytics.js
 *
 * Pure functions: given a day's raw records, compute what the dashboard,
 * Telegram summary and AI evaluation need. No I/O, so every rule is testable.
 *
 * Definitions
 *   worked minutes = union(work segments) minus its overlap with union(breaks)
 *     (so "kerja 09–17, istirahat 12–13" = 7 jam, and the live clock — where
 *      work and break never overlap — gives the same answer)
 *   achievement    = worked / target   (target 0 on non-workdays)
 *   balance        = 100 minus penalties from explicit, explainable checks
 *   productivity   = hours (40) + tasks (30) + activity vs 7-day norm (20) + report (10)
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { dayBounds, minuteOfDay, weekday, formatMinutes, formatRupiah } from './time.js';

// ----------------------------------------------------------- interval math

function merge(intervals) {
  const xs = intervals.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of xs) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const total = (xs) => xs.reduce((s, [a, b]) => s + (b - a), 0);

function overlap(as, bs) {
  let sum = 0;
  for (const [a1, b1] of as) {
    for (const [a2, b2] of bs) {
      const lo = Math.max(a1, a2);
      const hi = Math.min(b1, b2);
      if (hi > lo) sum += hi - lo;
    }
  }
  return sum;
}

const MIN = 60_000;

// ---------------------------------------------------------------- per day

/**
 * @param {object} p
 * @param {string} p.date
 * @param {Array}  p.segments  wl_segments rows
 * @param {Array}  p.tasks     wl_tasks rows
 * @param {Array}  p.finance   wl_finance rows
 * @param {object} [p.report]  wl_reports row
 * @param {object} [p.activity] activity snapshot
 * @param {object} p.settings
 * @param {number} [p.now]
 */
export function computeDay({ date, segments = [], tasks = [], finance = [], report = null, activity = null, settings, now = Date.now() }) {
  const [dayStart, dayEnd] = dayBounds(date);
  const cap = Math.min(now, dayEnd);
  const clip = (s) => [Math.max(s.start_at, dayStart), Math.min(s.end_at ?? cap, dayEnd)];

  const workIv = merge(segments.filter((s) => s.kind === 'work').map(clip));
  const breakIv = merge(segments.filter((s) => s.kind === 'break').map(clip));
  const workedMin = Math.max(0, Math.round((total(workIv) - overlap(workIv, breakIv)) / MIN));
  const breakMin = Math.round(total(breakIv) / MIN);

  const open = segments.find((s) => s.end_at == null);
  let status = 'idle';
  if (open) status = open.kind === 'work' ? 'working' : 'break';
  else if (workIv.length) status = 'done';

  const isWorkday = (settings.workdays || []).includes(weekday(date));
  const targetMin = isWorkday ? Math.round((Number(settings.targetHours) || 0) * 60) : 0;

  const income = finance.filter((f) => f.type === 'income').reduce((s, f) => s + f.amount, 0);
  const expense = finance.filter((f) => f.type === 'expense').reduce((s, f) => s + f.amount, 0);

  const act = activity || {};
  const commits = (act.localCommits || 0) + (act.github?.commits || 0);

  return {
    date,
    status,
    openSegment: open ? { id: open.id, kind: open.kind, startAt: open.start_at } : null,
    isWorkday,
    workedMin,
    breakMin,
    targetMin,
    achievement: targetMin ? workedMin / targetMin : null,
    firstStart: workIv.length ? workIv[0][0] : null,
    lastEnd: workIv.length ? workIv[workIv.length - 1][1] : null,
    tasks: { total: tasks.length, done: tasks.filter((t) => t.done).length },
    money: { income, expense, net: income - expense },
    activity: {
      commits,
      filesChanged: act.filesChanged || 0,
      github: act.github || null,
      collectedAt: act.collectedAt || null,
    },
    report: { length: (report?.text || '').trim().length, hasReport: Boolean((report?.text || '').trim()) },
  };
}

// -------------------------------------------------------------- comparison

const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);

/** Change vs the previous day that actually has data. */
export function compare(day, prev) {
  if (!prev) return { previousDate: null, workedPct: null, tasksDelta: null, netDelta: null, productivityDelta: null };
  return {
    previousDate: prev.date,
    workedPct: pct(day.workedMin, prev.workedMin),
    workedDeltaMin: day.workedMin - prev.workedMin,
    tasksDelta: day.tasks.done - prev.tasks.done,
    netDelta: day.money.net - prev.money.net,
    productivityDelta: day.productivity != null && prev.productivity != null ? day.productivity - prev.productivity : null,
  };
}

// --------------------------------------------------------------- balance

/**
 * Work–life balance with explicit reasons. `recent` = computed days before this
 * one (most recent first), used for multi-day patterns.
 */
export function balance(day, recent = []) {
  const checks = [];
  const add = (id, level, message, penalty) => checks.push({ id, level, message, penalty });

  const target = day.targetMin;
  const w = day.workedMin;

  if (!day.isWorkday && w >= 60) {
    add('offday', 'warn', `Bekerja ${formatMinutes(w)} di hari libur.`, 10);
  }
  if (w > 10 * 60) add('long_day', 'bad', `Jam kerja sangat panjang (${formatMinutes(w)}). Risiko kelelahan.`, 25);
  else if (target && w > target * 1.25) add('overtime', 'warn', `Lembur ${formatMinutes(w - target)} di atas target.`, 12);

  if (w >= 6 * 60 && day.breakMin < 30) {
    add('no_break', 'warn', `Istirahat hanya ${formatMinutes(day.breakMin)} untuk ${formatMinutes(w)} kerja. Idealnya minimal 30 menit.`, 15);
  }
  if (day.lastEnd && minuteOfDay(day.lastEnd) >= 21 * 60 && minuteOfDay(day.lastEnd) > minuteOfDay(day.firstStart || 0)) {
    add('late', 'warn', 'Masih bekerja setelah pukul 21.00.', 10);
  }
  if (day.firstStart && minuteOfDay(day.firstStart) < 6 * 60) {
    add('early', 'warn', 'Mulai bekerja sebelum pukul 06.00.', 5);
  }
  if (target && day.status === 'done' && w < target * 0.5) {
    add('short', 'info', `Jam kerja baru ${Math.round((w / target) * 100)}% dari target.`, 5);
  }

  const window = [day, ...recent].slice(0, 7).filter((d) => d.isWorkday && d.workedMin > 0);
  if (window.length >= 5) {
    const avg = window.reduce((s, d) => s + d.workedMin, 0) / window.length;
    const avgTarget = window.reduce((s, d) => s + d.targetMin, 0) / window.length;
    if (avgTarget && avg > avgTarget * 1.15) {
      add('trend_over', 'bad', `Rata-rata ${formatMinutes(avg)}/hari selama ${window.length} hari kerja terakhir — pola lembur berkelanjutan.`, 15);
    }
  }
  if (day.money.expense > 0 && day.money.income === 0 && day.money.expense >= 500_000) {
    add('spend', 'info', `Pengeluaran ${formatRupiah(day.money.expense)} tanpa pemasukan hari ini.`, 0);
  }

  const score = Math.max(0, 100 - checks.reduce((s, c) => s + c.penalty, 0));
  let label = 'Seimbang';
  let level = 'ok';
  if (score < 60) { label = 'Tidak seimbang'; level = 'bad'; } else if (score < 85) { label = 'Perlu perhatian'; level = 'warn'; }
  if (day.workedMin === 0 && !checks.length) { label = 'Belum ada data kerja'; level = 'idle'; }
  if (!checks.length && day.workedMin > 0) checks.push({ id: 'ok', level: 'ok', message: 'Jam kerja dan istirahat dalam batas sehat.', penalty: 0 });
  return { score, label, level, checks };
}

// ------------------------------------------------------------ productivity

/**
 * 0–100, deliberately simple and explainable. `norm` = average activity of the
 * previous days (commits + files), so a quiet day is judged against YOUR normal.
 */
export function productivity(day, norm = { activity: 0 }) {
  const parts = [];
  if (day.targetMin) {
    const r = day.workedMin / day.targetMin;
    // Full marks around the target; overwork does not earn extra points.
    const s = r <= 1 ? r : Math.max(0.6, 1 - (r - 1.25) * 0.8);
    parts.push({ id: 'hours', max: 40, value: Math.round(40 * Math.min(1, Math.max(0, s))) });
  } else {
    parts.push({ id: 'hours', max: 40, value: day.workedMin > 0 ? 40 : 0 });
  }

  const t = day.tasks;
  parts.push({ id: 'tasks', max: 30, value: t.total ? Math.round(30 * (t.done / t.total)) : 0 });

  const act = day.activity.commits * 3 + day.activity.filesChanged;
  const actScore = norm.activity > 0 ? Math.min(1, act / norm.activity) : (act > 0 ? 1 : 0);
  parts.push({ id: 'activity', max: 20, value: Math.round(20 * actScore) });

  parts.push({ id: 'report', max: 10, value: day.report.hasReport ? (day.report.length >= 100 ? 10 : 6) : 0 });

  return { score: parts.reduce((s, p) => s + p.value, 0), parts };
}

/** Is today's work "enough"? A plain-language verdict. */
export function verdict(day) {
  if (!day.workedMin && !day.tasks.done) return { enough: false, text: 'Belum ada pekerjaan tercatat hari ini.' };
  if (!day.targetMin) return { enough: true, text: 'Hari libur — tidak ada target jam kerja.' };
  const a = day.workedMin / day.targetMin;
  if (a >= 0.9 && a <= 1.25 && day.tasks.done > 0) return { enough: true, text: 'Cukup: target jam tercapai dan ada tugas yang selesai.' };
  if (a >= 0.9 && day.tasks.done === 0) return { enough: true, text: 'Jam kerja cukup, tetapi belum ada tugas yang ditandai selesai.' };
  if (a > 1.25) return { enough: true, text: 'Lebih dari cukup — pertimbangkan untuk berhenti dan istirahat.' };
  return { enough: false, text: `Belum cukup: ${Math.round(a * 100)}% dari target ${formatMinutes(day.targetMin)}.` };
}

// ---------------------------------------------------------------- summary

/** Aggregate a list of computed days (week / month). */
export function summarize(days) {
  const worked = days.reduce((s, d) => s + d.workedMin, 0);
  const target = days.reduce((s, d) => s + d.targetMin, 0);
  const active = days.filter((d) => d.workedMin > 0);
  const income = days.reduce((s, d) => s + d.money.income, 0);
  const expense = days.reduce((s, d) => s + d.money.expense, 0);
  return {
    days: days.length,
    activeDays: active.length,
    workedMin: worked,
    targetMin: target,
    achievement: target ? worked / target : null,
    avgWorkedMin: active.length ? Math.round(worked / active.length) : 0,
    tasksDone: days.reduce((s, d) => s + d.tasks.done, 0),
    commits: days.reduce((s, d) => s + d.activity.commits, 0),
    income,
    expense,
    net: income - expense,
    avgProductivity: active.length ? Math.round(active.reduce((s, d) => s + (d.productivity || 0), 0) / active.length) : 0,
    avgBalance: active.length ? Math.round(active.reduce((s, d) => s + (d.balance?.score ?? 100), 0) / active.length) : 0,
  };
}
