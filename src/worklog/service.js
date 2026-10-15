/**
 * src/worklog/service.js
 *
 * The work journal ("Jurnal Kerja"): live work clock, tasks, money, daily
 * report, folder/GitHub evidence, analytics, AI evaluation and Telegram
 * summaries — one service shared by the web API, the agent tools and the
 * Telegram commands, so every surface sees exactly the same numbers.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { EventEmitter } from 'node:events';
import {
  localDate, localTime, dayBounds, atTime, addDays, isDate, weekday, monthOf, datesOfMonth,
  formatDateId, formatMinutes, formatRupiah,
} from './time.js';
import { computeDay, compare, balance, productivity, verdict, summarize } from './analytics.js';
import { parseQuick, normaliseAiProposal, isEmptyProposal, parseAmount } from './parse.js';
import { collectActivity, validateFolder, SourceError } from './activity.js';
import { collectParsed, collect } from '../automation/ai-compose.js';
import { DEFAULT_SETTINGS, REPORT_MAX } from './store.js';

export class WorklogError extends Error {
  constructor(message, code = 'bad_request') {
    super(message);
    this.name = 'WorklogError';
    this.code = code;
  }
}

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

/** Planned minutes of work in the schedule: (end - start) minus the break window inside it. */
export function scheduleHours(s) {
  const ws = toMin(s.workStart);
  const we = toMin(s.workEnd);
  if (!(we > ws)) return 0;
  let brk = 0;
  if (s.breakStart && s.breakEnd) {
    const bs = Math.max(ws, toMin(s.breakStart));
    const be = Math.min(we, toMin(s.breakEnd));
    brk = Math.max(0, be - bs);
  } else {
    brk = Number(s.breakMinutes) || 0;
  }
  return Math.max(0, (we - ws - brk) / 60);
}

/** Settings with targetHours resolved (null => from the schedule). */
export function resolveSettings(s) {
  const auto = s.targetHours == null || s.targetHours === '' || s.targetHours === 'auto';
  return { ...s, targetHoursAuto: auto, targetHours: auto ? scheduleHours(s) : Number(s.targetHours) };
}
const ACTIVITY_TTL_MS = 10 * 60_000;

export class WorklogService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.store            createWorklogStore()
   * @param {object} [deps.aiManager]
   * @param {Function} [deps.notify]       async (chatId, text) => void   (Telegram)
   * @param {Function} [deps.defaultChatId] () => string|null
   * @param {Function} [deps.now]
   */
  constructor({ store, aiManager = null, notify = null, defaultChatId = () => null, now = () => Date.now(), env = process.env, fetchImpl, execFileImpl }) {
    super();
    this.store = store;
    this.aiManager = aiManager;
    this.notify = notify;
    this.defaultChatId = defaultChatId;
    this.now = now;
    this.env = env;
    this.collectOpts = { env, ...(fetchImpl ? { fetchImpl } : {}), ...(execFileImpl ? { execFileImpl } : {}) };
    this._timer = null;
    this._ticking = false;
  }

  _changed(date, kind) {
    this.emit('change', { date, kind, at: this.now() });
  }

  today() {
    return localDate(this.now());
  }

  _date(d) {
    const date = d || this.today();
    if (!isDate(date)) throw new WorklogError('Tanggal tidak valid (format YYYY-MM-DD)');
    return date;
  }

  // ------------------------------------------------------------- settings

  /** Stored settings with the target resolved from the schedule when on "auto". */
  getSettings() {
    return resolveSettings(this.store.settings.get());
  }

  updateSettings(patch = {}) {
    const cur = this.store.settings.get();
    const next = { ...cur };
    const err = (m) => { throw new WorklogError(m); };

    if (patch.workStart !== undefined) { if (!HHMM.test(patch.workStart)) err('Jam mulai tidak valid (HH:MM)'); next.workStart = patch.workStart; }
    if (patch.workEnd !== undefined) { if (!HHMM.test(patch.workEnd)) err('Jam selesai tidak valid (HH:MM)'); next.workEnd = patch.workEnd; }
    for (const k of ['breakStart', 'breakEnd']) {
      if (patch[k] !== undefined) {
        if (patch[k] && !HHMM.test(patch[k])) err('Jam istirahat tidak valid (HH:MM)');
        next[k] = patch[k] || '';
      }
    }
    if (patch.breakMinutes !== undefined) {
      const v = Number(patch.breakMinutes);
      if (!Number.isFinite(v) || v < 0 || v > 600) err('Durasi istirahat tidak valid');
      next.breakMinutes = Math.round(v);
    }
    if (patch.targetHours !== undefined) {
      if (patch.targetHours === null || patch.targetHours === '' || patch.targetHours === 'auto') {
        next.targetHours = null;
      } else {
        const v = Number(patch.targetHours);
        if (!Number.isFinite(v) || v < 0 || v > 24) err('Target jam tidak valid (0–24)');
        next.targetHours = Math.round(v * 4) / 4;
      }
    }
    for (const k of ['followSchedule', 'autoStop', 'autoStart']) {
      if (patch[k] !== undefined) next[k] = Boolean(patch[k]);
    }
    if (toMin(next.workEnd) <= toMin(next.workStart)) err('Jam selesai harus setelah jam mulai');
    if (next.breakStart && next.breakEnd) {
      const bs = toMin(next.breakStart);
      const be = toMin(next.breakEnd);
      if (be <= bs) err('Istirahat selesai harus setelah istirahat mulai');
      if (bs < toMin(next.workStart) || be > toMin(next.workEnd)) err('Jam istirahat harus di dalam jam kerja');
      next.breakMinutes = be - bs;
    }
    if (patch.workdays !== undefined) {
      if (!Array.isArray(patch.workdays) || patch.workdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) err('Hari kerja tidak valid');
      next.workdays = [...new Set(patch.workdays)].sort();
    }
    for (const k of ['hourlyRate', 'monthlyIncomeTarget']) {
      if (patch[k] !== undefined) {
        const v = typeof patch[k] === 'number' ? patch[k] : parseAmount(patch[k]) ?? Number(patch[k]);
        if (!Number.isFinite(v) || v < 0) err('Nilai uang tidak valid');
        next[k] = Math.round(v);
      }
    }
    if (patch.telegram) {
      const t = { ...cur.telegram };
      if (patch.telegram.dailyReport !== undefined) t.dailyReport = Boolean(patch.telegram.dailyReport);
      if (patch.telegram.morningReminder !== undefined) t.morningReminder = Boolean(patch.telegram.morningReminder);
      if (patch.telegram.scheduleNotices !== undefined) t.scheduleNotices = Boolean(patch.telegram.scheduleNotices);
      if (patch.telegram.reportTime !== undefined) {
        if (patch.telegram.reportTime && !HHMM.test(patch.telegram.reportTime)) err('Jam laporan tidak valid (HH:MM)');
        t.reportTime = patch.telegram.reportTime || '';
      }
      if (patch.telegram.chatId !== undefined) {
        const c = String(patch.telegram.chatId || '').trim();
        if (c && !/^-?\d{5,20}$/.test(c)) err('Chat ID Telegram tidak valid');
        t.chatId = c;
      }
      next.telegram = t;
    }
    if (patch.sources) {
      const s = { ...cur.sources, github: { ...cur.sources.github } };
      if (patch.sources.github) {
        const u = String(patch.sources.github.username ?? s.github.username ?? '').trim();
        if (u && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(u)) err('Username GitHub tidak valid');
        s.github.username = u;
        if (patch.sources.github.repos !== undefined) {
          const repos = (Array.isArray(patch.sources.github.repos) ? patch.sources.github.repos : String(patch.sources.github.repos).split(/[\s,]+/))
            .map((r) => String(r).trim()).filter(Boolean);
          if (repos.some((r) => !/^[\w.-]+\/[\w.-]+$/.test(r))) err('Format repo harus pemilik/nama');
          s.github.repos = repos.slice(0, 50);
        }
      }
      if (patch.sources.gitAuthor !== undefined) s.gitAuthor = String(patch.sources.gitAuthor || '').slice(0, 120);
      next.sources = s;
    }
    this.store.settings.set(next);
    this._changed(this.today(), 'settings');
    return this.getSettings();
  }

  addFolder(rawPath, label = '') {
    let full;
    try { full = validateFolder(rawPath); } catch (e) { throw new WorklogError(e instanceof SourceError ? e.message : 'Folder tidak valid'); }
    const s = this.store.settings.get();
    if (s.sources.folders.some((f) => f.path.toLowerCase() === full.toLowerCase())) throw new WorklogError('Folder sudah terhubung');
    if (s.sources.folders.length >= 20) throw new WorklogError('Maksimal 20 folder');
    s.sources.folders = [...s.sources.folders, { path: full, label: String(label || '').slice(0, 60) }];
    this.store.settings.set(s);
    this._changed(this.today(), 'settings');
    return s.sources.folders;
  }

  removeFolder(rawPath) {
    const s = this.store.settings.get();
    const before = s.sources.folders.length;
    s.sources.folders = s.sources.folders.filter((f) => f.path.toLowerCase() !== String(rawPath).toLowerCase());
    if (s.sources.folders.length === before) throw new WorklogError('Folder tidak ditemukan', 'not_found');
    this.store.settings.set(s);
    this._changed(this.today(), 'settings');
    return s.sources.folders;
  }

  // ------------------------------------------------------- schedule engine

  /**
   * "Ikuti jadwal": once work has started, the clock follows the configured
   * schedule by itself — break at breakStart, back to work at breakEnd, stop at
   * workEnd. Transitions are written at the EXACT scheduled minute (not when
   * this happened to run), so the record is precise even after downtime.
   * Idempotent: safe to call from every read.
   */
  applySchedule() {
    const s = this.getSettings();
    if (!s.followSchedule && !s.autoStart) return [];
    const now = this.now();
    const date = localDate(now);

    // A session left running from a PREVIOUS day (nobody pressed stop, the server was off at
    // closing time) must not block today: close it at that day's scheduled end, or the
    // end of that day, whichever comes first. Otherwise today could never auto-start.
    const stale = this._open();
    if (stale && stale.date < date && s.autoStop && stale.kind === 'work') {
      // Only a session that began BEFORE the scheduled end should have been stopped by the
      // schedule; one that began after it is deliberate overtime and stays open.
      const planned = atTime(stale.date, s.workEnd);
      if (stale.start_at < planned) {
        this.store.segments.close(stale.id, planned);
        this._changed(stale.date, 'clock');
      }
    }

    if (!s.workdays.includes(weekday(date))) return [];

    const ws = atTime(date, s.workStart);
    const we = atTime(date, s.workEnd);
    const hasBreak = Boolean(s.breakStart && s.breakEnd);
    const bs = hasBreak ? atTime(date, s.breakStart) : null;
    const be = hasBreak ? atTime(date, s.breakEnd) : null;
    const events = [];

    // Auto start (opt-in): on a day with nothing recorded yet, the day is built from the
    // SCHEDULE — work from workStart, the break at its scheduled minutes, then back to work —
    // even when the server first noticed it late (restart, reset, opened at noon).
    const autoSegs = () => this.store.segments.forDate(date);
    // Repair for an earlier bug: a late auto start began the day at breakStart (12:00) and never
    // recorded the break. That exact shape (one auto work segment starting at breakStart) is rebuilt.
    if (s.autoStart && hasBreak && ws < bs && now >= ws && now < we) {
      const segs = autoSegs();
      if (segs.length === 1 && segs[0].source === 'auto' && segs[0].kind === 'work' && segs[0].start_at === bs) {
        this.store.segments.remove(segs[0].id);
        this.store.meta.set(`autostart:${date}`, '');
        this.store.meta.set(`autobreak:${date}`, '');
      }
    }
    if (s.autoStart && now >= ws && now < we && !this._open()
        && !this.store.meta.get(`autostart:${date}`) && !autoSegs().length) {
      this.store.meta.set(`autostart:${date}`, now);
      const add = (kind, startAt, endAt = null) => this.store.segments.add({ date, kind, startAt, ...(endAt != null ? { endAt } : {}), source: 'auto' });
      if (hasBreak && ws < bs && now >= bs) {
        add('work', ws, bs);                       // 08:00 → 12:00
        this.store.meta.set(`autobreak:${date}`, now);
        if (now >= be) {
          add('break', bs, be);                    // 12:00 → 13:00
          if (!(s.autoStop && be >= we)) add('work', be);   // 13:00 → now (open)
        } else {
          add('break', bs);                        // still on break (open)
        }
      } else {
        add('work', ws);                           // before the break: simply from workStart
      }
      events.push({ kind: 'start', at: ws });
    }
    if (!s.followSchedule) return this._afterSchedule(date, events);

    // Several boundaries may have passed (server was off): walk them in order.
    for (let guard = 0; guard < 6; guard++) {
      const open = this._open();
      if (!open || open.date !== date) break;

      if (open.kind === 'work' && hasBreak && open.start_at < bs && now >= bs
          && !this.store.meta.get(`autobreak:${date}`)) {
        this.store.meta.set(`autobreak:${date}`, now);
        this.store.segments.close(open.id, bs);
        this.store.segments.add({ date, kind: 'break', startAt: bs, source: 'auto' });
        events.push({ kind: 'break', at: bs });
        continue;
      }
      if (open.kind === 'break' && open.source === 'auto' && hasBreak && now >= be) {
        this.store.segments.close(open.id, be);
        // Resume only if the working day is not already over.
        if (!(s.autoStop && be >= we)) {
          this.store.segments.add({ date, kind: 'work', startAt: be, source: 'auto' });
          events.push({ kind: 'resume', at: be });
        }
        continue;
      }
      if (open.kind === 'work' && s.autoStop && open.start_at < we && now >= we) {
        this.store.segments.close(open.id, we);
        events.push({ kind: 'stop', at: we });
        continue;
      }
      break;
    }
    return this._afterSchedule(date, events);
  }

  _afterSchedule(date, events) {
    if (!events.length) return events;
    this._changed(date, 'clock');
    const s = this.getSettings();
    if (this.notify && s.telegram.scheduleNotices && this._chatId()) {
      const fresh = events.filter((e) => this.now() - e.at < 10 * 60_000); // no stale notices after downtime
      const text = {
        start: (e) => `Jam kerja dimulai otomatis pukul ${localTime(e.at)}. Semangat!`,
        break: (e) => `Waktunya istirahat (${localTime(e.at)}–${s.breakEnd}). Jam kerja dijeda otomatis.`,
        resume: (e) => `Istirahat selesai (${localTime(e.at)}). Jam kerja dilanjutkan otomatis.`,
        stop: (e) => `Jam kerja selesai (${localTime(e.at)}). Total hari ini ${formatMinutes(this.day(date, { light: true }).workedMin)}. Kirim /mulai bila ingin lembur.`,
      };
      for (const e of fresh) this.notify(this._chatId(), text[e.kind](e)).catch(() => {});
    }
    return events;
  }

  /** What the schedule will do next (for the UI countdown). */
  nextScheduleEvent() {
    const s = this.getSettings();
    if (!s.followSchedule) return null;
    const now = this.now();
    const date = localDate(now);
    if (!s.workdays.includes(weekday(date))) return null;
    const open = this._open();
    if (!open || open.date !== date) return null;
    const hasBreak = Boolean(s.breakStart && s.breakEnd);
    const bs = hasBreak ? atTime(date, s.breakStart) : null;
    const be = hasBreak ? atTime(date, s.breakEnd) : null;
    const we = atTime(date, s.workEnd);
    if (open.kind === 'work' && hasBreak && open.start_at < bs && now < bs && !this.store.meta.get(`autobreak:${date}`)) return { kind: 'break', at: bs };
    if (open.kind === 'break' && open.source === 'auto' && hasBreak && now < be) return { kind: 'resume', at: be };
    if (open.kind === 'work' && s.autoStop && open.start_at < we && now < we) return { kind: 'stop', at: we };
    return null;
  }

  // ---------------------------------------------------------------- clock

  _open() {
    return this.store.segments.open()[0] || null;
  }

  /** Closes the open segment, splitting it at midnight if it crossed days. */
  _closeOpen(at) {
    const seg = this._open();
    if (!seg) return null;
    const [, dayEnd] = dayBounds(seg.date);
    if (at <= dayEnd) return this.store.segments.close(seg.id, at);
    this.store.segments.close(seg.id, dayEnd);
    const today = localDate(at);
    return this.store.segments.add({ date: today, kind: seg.kind, startAt: dayBounds(today)[0], endAt: at, source: seg.source });
  }

  clockStart(source = 'web') {
    this.applySchedule();
    const now = this.now();
    const open = this._open();
    if (open?.kind === 'work') throw new WorklogError('Anda sudah sedang bekerja', 'bad_state');
    if (open?.kind === 'break') this._closeOpen(now);
    const seg = this.store.segments.add({ date: localDate(now), kind: 'work', startAt: now, source });
    this._changed(seg.date, 'clock');
    return this.status();
  }

  clockPause(source = 'web') {
    this.applySchedule();
    const now = this.now();
    const open = this._open();
    if (!open || open.kind !== 'work') throw new WorklogError('Belum mulai bekerja', 'bad_state');
    this._closeOpen(now);
    this.store.segments.add({ date: localDate(now), kind: 'break', startAt: now, source });
    this._changed(localDate(now), 'clock');
    return this.status();
  }

  clockResume(source = 'web') {
    const open = this._open();
    if (!open || open.kind !== 'break') throw new WorklogError('Sedang tidak istirahat', 'bad_state');
    return this.clockStart(source);
  }

  clockStop() {
    this.applySchedule();
    const now = this.now();
    if (!this._open()) throw new WorklogError('Tidak ada sesi kerja yang berjalan', 'bad_state');
    this._closeOpen(now);
    this._changed(localDate(now), 'clock');
    return this.status();
  }

  status() {
    this.applySchedule();
    const date = this.today();
    const open = this._open();
    const day = this.day(date, { light: true });
    return {
      date,
      now: this.now(),
      state: open ? (open.kind === 'work' ? 'working' : 'break') : (day.workedMin > 0 ? 'done' : 'idle'),
      openSince: open?.start_at ?? null,
      workedMin: day.workedMin,
      breakMin: day.breakMin,
      targetMin: day.targetMin,
      next: this.nextScheduleEvent(),
      followSchedule: this.getSettings().followSchedule,
    };
  }

  // ------------------------------------------------------- manual entries

  addSegment({ date, kind, start, end, note }) {
    const d = this._date(date);
    if (!['work', 'break'].includes(kind)) throw new WorklogError('Jenis harus work atau break');
    const s = atTime(d, start);
    const e = atTime(d, end);
    if (s == null || e == null) throw new WorklogError('Jam tidak valid (HH:MM)');
    if (e <= s) throw new WorklogError('Jam selesai harus setelah jam mulai');
    const seg = this.store.segments.add({ date: d, kind, startAt: s, endAt: e, source: 'manual', note: note ? String(note).slice(0, 200) : null });
    this._changed(d, 'segment');
    return seg;
  }

  /**
   * Deletes recorded work/break sessions of a day (and optionally its tasks,
   * money and report). Returns the counts so the UI can confirm exactly what
   * was removed.
   */
  resetDay(date, { segments = true, tasks = false, finance = false, report = false } = {}) {
    const d = this._date(date);
    const out = { segments: 0, tasks: 0, finance: 0, report: false };
    if (segments) {
      for (const s of this.store.segments.forDate(d)) { this.store.segments.remove(s.id); out.segments++; }
      for (const k of ['autobreak', 'autostart', 'report_sent']) this.store.meta.set(`${k}:${d}`, '');
    }
    if (tasks) for (const t of this.store.tasks.forDate(d)) { this.store.tasks.remove(t.id); out.tasks++; }
    if (finance) for (const f of this.store.finance.forDate(d)) { this.store.finance.remove(f.id); out.finance++; }
    if (report && this.store.reports.get(d)) { this.store.reports.set(d, { text: '', mood: null }); out.report = true; }
    this._changed(d, 'reset');
    return out;
  }

  removeSegment(id) {
    const seg = this.store.segments.get(id);
    if (!seg) throw new WorklogError('Segmen tidak ditemukan', 'not_found');
    this.store.segments.remove(id);
    this._changed(seg.date, 'segment');
    return true;
  }

  addTask({ date, title, done = false, minutes = null, project = null }) {
    const d = this._date(date);
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    if (!t) throw new WorklogError('Judul tugas kosong');
    // Idempotent: the same task on the same day is one task (a retried message must not duplicate it).
    const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const same = this.store.tasks.forDate(d).find((x) => norm(x.title) === norm(t.slice(0, 160)));
    if (same) {
      if (done && !same.done) {
        const upd = this.store.tasks.update(same.id, { done: true });
        this._changed(d, 'task');
        return upd;
      }
      return same;
    }
    const task = this.store.tasks.add({ date: d, title: t.slice(0, 160), done, minutes, project: project ? String(project).slice(0, 60) : null });
    this._changed(d, 'task');
    return task;
  }

  updateTask(id, patch) {
    const cur = this.store.tasks.get(id);
    if (!cur) throw new WorklogError('Tugas tidak ditemukan', 'not_found');
    const clean = {};
    if (patch.title !== undefined) {
      const t = String(patch.title || '').trim();
      if (!t) throw new WorklogError('Judul tugas kosong');
      clean.title = t.slice(0, 160);
    }
    if (patch.done !== undefined) clean.done = Boolean(patch.done);
    if (patch.minutes !== undefined) clean.minutes = patch.minutes == null ? null : Math.max(0, Math.round(Number(patch.minutes) || 0));
    if (patch.project !== undefined) clean.project = patch.project ? String(patch.project).slice(0, 60) : null;
    const t = this.store.tasks.update(id, clean);
    this._changed(cur.date, 'task');
    return t;
  }

  removeTask(id) {
    const cur = this.store.tasks.get(id);
    if (!cur) throw new WorklogError('Tugas tidak ditemukan', 'not_found');
    this.store.tasks.remove(id);
    this._changed(cur.date, 'task');
    return true;
  }

  addFinance({ date, type, amount, category, note }) {
    const d = this._date(date);
    if (!['income', 'expense'].includes(type)) throw new WorklogError('Jenis harus income atau expense');
    const v = typeof amount === 'number' ? Math.round(amount) : parseAmount(amount);
    if (!v || v <= 0) throw new WorklogError('Jumlah tidak valid (mis. 25000, 25rb, 1,5jt)');
    const f = this.store.finance.add({
      date: d, type, amount: v,
      category: category ? String(category).slice(0, 60) : (type === 'income' ? 'Pemasukan lain' : 'Lainnya'),
      note: note ? String(note).slice(0, 160) : null,
    });
    this._changed(d, 'finance');
    return f;
  }

  removeFinance(id, date) {
    if (!this.store.finance.remove(id)) throw new WorklogError('Catatan keuangan tidak ditemukan', 'not_found');
    this._changed(date || this.today(), 'finance');
    return true;
  }

  setReport(date, { text, mood }) {
    const d = this._date(date);
    const t = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (t.length > REPORT_MAX) throw new WorklogError(`Laporan maksimal ${REPORT_MAX} karakter`);
    let m = null;
    if (mood !== undefined && mood !== null && mood !== '') {
      m = Number(mood);
      if (!Number.isInteger(m) || m < 1 || m > 5) throw new WorklogError('Mood harus 1–5');
    }
    const r = this.store.reports.set(d, { text: t, mood: m });
    this._changed(d, 'report');
    return r;
  }

  // ------------------------------------------------------------ reminders

  /**
   * Schedules a Telegram reminder. `at` = epoch ms, or "YYYY-MM-DD HH:MM" in
   * the journal timezone. Must be in the future and within a year.
   */
  addReminder({ at, text, chatId = null, source = 'telegram' }) {
    let ms = at;
    if (typeof at === 'string') {
      const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}[:.]\d{2})$/.exec(at.trim());
      if (!m || !isDate(m[1])) throw new WorklogError('Waktu pengingat tidak valid (YYYY-MM-DD HH:MM)');
      ms = atTime(m[1], m[2].replace('.', ':'));
    }
    if (!Number.isFinite(ms)) throw new WorklogError('Waktu pengingat tidak valid');
    const now = this.now();
    if (ms < now - 60_000) throw new WorklogError('Waktu pengingat sudah lewat');
    if (ms > now + 366 * 86_400_000) throw new WorklogError('Pengingat maksimal satu tahun ke depan');
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) throw new WorklogError('Isi pengingat kosong');
    if (this.store.reminders.upcoming(500).length >= 200) throw new WorklogError('Terlalu banyak pengingat aktif (maks 200)');
    // Idempotent: same text within the same minute is the same reminder.
    const normText = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const dup = this.store.reminders.upcoming(500).find((x) => Math.abs(x.at - Math.max(ms, now)) < 60_000 && normText(x.text) === normText(t.slice(0, 300)));
    if (dup) return dup;
    const r = this.store.reminders.add({ at: Math.max(ms, now), text: t.slice(0, 300), chatId: chatId || this._chatId(), source });
    this._changed(localDate(r.at), 'reminder');
    return r;
  }

  listReminders(limit = 20) {
    return this.store.reminders.upcoming(limit);
  }

  cancelReminder(rid) {
    if (!this.store.reminders.cancel(rid)) throw new WorklogError('Pengingat tidak ditemukan atau sudah terkirim', 'not_found');
    this._changed(this.today(), 'reminder');
    return true;
  }

  /** Sends reminders that are due. Late ones (server was down) are sent with a note, up to 6 hours. */
  async deliverReminders() {
    if (!this.notify) return 0;
    let sent = 0;
    for (const r of this.store.reminders.due(this.now())) {
      if (!this.store.reminders.markSent(r.id)) continue; // mark first: never send twice
      const late = this.now() - r.at;
      if (late > 6 * 3_600_000) continue; // far too late to be useful
      const chatId = r.chat_id || this._chatId();
      if (!chatId) continue;
      const when = localTime(r.at);
      try {
        await this.notify(chatId, `Pengingat (${when}): ${r.text}${late > 5 * 60_000 ? `\n(terlambat ${formatMinutes(late / 60_000)} — server sempat tidak aktif)` : ''}`);
        sent++;
      } catch (e) {
        console.warn('[WORKLOG] gagal kirim pengingat:', e.message);
      }
    }
    return sent;
  }

  // ------------------------------------------------------ text -> entries

  /**
   * Free text -> proposal. Uses the AI when available (it understands context
   * like "tadi pagi"), with the offline parser as a fallback.
   */
  async parseText(text, { useAi = true } = {}) {
    const src = String(text || '').trim();
    if (!src) throw new WorklogError('Teks kosong');
    if (src.length > 4000) throw new WorklogError('Teks terlalu panjang (maks 4000 karakter)');
    const quick = normaliseAiProposal(parseQuick(src));
    if (!useAi || !this.aiManager) return { engine: 'quick', proposal: quick };

    const s = this.getSettings();
    const system = [
      'Kamu mengubah catatan kerja harian berbahasa Indonesia menjadi data terstruktur.',
      `Jam kerja normal: ${s.workStart}-${s.workEnd}. Hari ini: ${formatDateId(this.today())}.`,
      'Balas HANYA satu objek JSON valid, tanpa markdown, dengan bentuk:',
      '{"work":[{"start":"HH:MM","end":"HH:MM"}],"breaks":[{"start":"HH:MM","end":"HH:MM"}],',
      '"tasks":[{"title":"...","done":true,"minutes":null,"project":null}],',
      '"finance":[{"type":"income|expense","amount":25000,"category":"...","note":"..."}],"report":"..."}',
      'Aturan: amount angka Rupiah utuh (25rb=25000, 1,5jt=1500000). Jangan mengarang data yang tidak disebut.',
      'tasks = pekerjaan yang dikerjakan. report = ringkasan 1-3 kalimat apa yang dikerjakan hari ini (maks 300 karakter).',
      'Jika tidak ada data untuk sebuah bagian, isi dengan array kosong.',
    ].join('\n');
    try {
      const r = await collectParsed(this.aiManager, [{ role: 'user', content: src }],
        { systemPrompt: system, temperature: 0.1, maxTokens: 1500 },
        (t) => {
          const a = t.indexOf('{');
          const b = t.lastIndexOf('}');
          if (a === -1 || b <= a) return null;
          try { return normaliseAiProposal(JSON.parse(t.slice(a, b + 1))); } catch { return null; }
        });
      if (r.parsed && !isEmptyProposal(r.parsed)) return { engine: 'ai', model: r.model, proposal: r.parsed };
    } catch { /* fall back to the offline parser */ }
    return { engine: 'quick', proposal: quick };
  }

  /** Saves a (validated) proposal. Returns what was written. */
  applyProposal(date, raw, source = 'web') {
    const d = this._date(date);
    const p = normaliseAiProposal(raw);
    const saved = { segments: 0, tasks: 0, finance: 0, report: false };
    for (const w of p.work) { this.addSegment({ date: d, kind: 'work', start: w.start, end: w.end, note: source }); saved.segments++; }
    for (const b of p.breaks) { this.addSegment({ date: d, kind: 'break', start: b.start, end: b.end, note: source }); saved.segments++; }
    for (const t of p.tasks) { this.addTask({ date: d, ...t }); saved.tasks++; }
    for (const f of p.finance) { this.addFinance({ date: d, ...f }); saved.finance++; }
    if (p.report) {
      const cur = this.store.reports.get(d)?.text || '';
      const merged = cur ? `${cur}\n${p.report}` : p.report;
      this.setReport(d, { text: merged.slice(0, REPORT_MAX) });
      saved.report = true;
    }
    return saved;
  }

  // -------------------------------------------------------------- activity

  async refreshActivity(date, { force = false } = {}) {
    const d = this._date(date);
    const cached = this.store.activity.get(d);
    const [, dayEnd] = dayBounds(d);
    const final = cached && cached.collectedAt >= dayEnd; // collected after the day ended
    if (cached && !force && (final || this.now() - cached.collectedAt < ACTIVITY_TTL_MS)) return cached;
    const data = await collectActivity(d, this.getSettings(), this.collectOpts);
    const stored = this.store.activity.set(d, data);
    this._changed(d, 'activity');
    return stored;
  }

  // ------------------------------------------------------------ analytics

  _raw(date) {
    return {
      date,
      segments: this.store.segments.forDate(date),
      tasks: this.store.tasks.forDate(date),
      finance: this.store.finance.forDate(date),
      report: this.store.reports.get(date),
      activity: this.store.activity.get(date),
    };
  }

  _compute(date, settings) {
    return computeDay({ ...this._raw(date), settings, now: this.now() });
  }

  /** Full analysis of one day. */
  day(date, { light = false } = {}) {
    const d = this._date(date);
    const settings = this.getSettings();
    const raw = this._raw(d);
    const base = computeDay({ ...raw, settings, now: this.now() });
    if (light) return base;

    const recent = [];
    for (let i = 1; i <= 14 && recent.length < 7; i++) {
      const x = this._compute(addDays(d, -i), settings);
      if (x.workedMin > 0 || x.tasks.total || x.money.income || x.money.expense) recent.push(x);
    }
    const norm = recent.length
      ? { activity: recent.reduce((s, x) => s + x.activity.commits * 3 + x.activity.filesChanged, 0) / recent.length }
      : { activity: 0 };
    for (const x of recent) x.productivity = productivity(x).score;
    const prod = productivity(base, norm);
    base.productivity = prod.score;

    return {
      ...base,
      productivityParts: prod.parts,
      balance: balance(base, recent),
      comparison: compare(base, recent[0] || null),
      verdict: verdict(base),
      settings: {
        workStart: settings.workStart, workEnd: settings.workEnd, breakStart: settings.breakStart, breakEnd: settings.breakEnd,
        targetHours: settings.targetHours, targetHoursAuto: settings.targetHoursAuto, followSchedule: settings.followSchedule,
      },
      segments: raw.segments,
      taskList: raw.tasks,
      financeList: raw.finance,
      reportText: raw.report?.text || '',
      mood: raw.report?.mood ?? null,
      evaluation: raw.report?.evaluation || null,
      evaluatedAt: raw.report?.evaluated_at || null,
      activityDetail: raw.activity,
      label: formatDateId(d),
    };
  }

  range(from, to) {
    const f = this._date(from);
    const t = this._date(to);
    if (t < f) throw new WorklogError('Rentang tanggal terbalik');
    const days = [];
    for (let d = f, i = 0; d <= t && i < 400; d = addDays(d, 1), i++) days.push(d);
    const settings = this.getSettings();
    const computed = days.map((d) => {
      const x = this._compute(d, settings);
      x.productivity = productivity(x).score;
      x.balance = balance(x);
      return x;
    });
    return { from: f, to: t, days: computed, summary: summarize(computed) };
  }

  week(date) {
    const d = this._date(date);
    return this.range(addDays(d, -6), d);
  }

  month(ym) {
    const m = ym || monthOf(this.today());
    if (!/^\d{4}-\d{2}$/.test(m)) throw new WorklogError('Bulan tidak valid (YYYY-MM)');
    const dates = datesOfMonth(m);
    const r = this.range(dates[0], dates[dates.length - 1]);
    const s = this.getSettings();
    r.summary.incomeTarget = s.monthlyIncomeTarget || 0;
    r.summary.incomeProgress = s.monthlyIncomeTarget ? r.summary.income / s.monthlyIncomeTarget : null;
    const cats = {};
    for (const f of this.store.finance.forRange(dates[0], dates[dates.length - 1])) {
      if (f.type !== 'expense') continue;
      cats[f.category || 'Lainnya'] = (cats[f.category || 'Lainnya'] || 0) + f.amount;
    }
    r.expenseByCategory = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([category, amount]) => ({ category, amount }));
    return r;
  }

  // ---------------------------------------------------------- AI + texts

  /** Plain-text summary of a day (Telegram, agent, notifications). */
  summaryText(date) {
    const x = this.day(date);
    const lines = [
      `Ringkasan kerja — ${x.label}`,
      `Jam kerja: ${formatMinutes(x.workedMin)}${x.targetMin ? ` dari ${formatMinutes(x.targetMin)} (${Math.round((x.achievement || 0) * 100)}%)` : ''}`,
      `Istirahat: ${formatMinutes(x.breakMin)}`,
    ];
    if (x.comparison.workedPct != null) {
      lines.push(`Dibanding ${x.comparison.previousDate}: ${x.comparison.workedPct >= 0 ? '+' : ''}${x.comparison.workedPct}% jam kerja`);
    }
    lines.push(`Tugas selesai: ${x.tasks.done}/${x.tasks.total}`);
    if (x.money.income || x.money.expense) {
      lines.push(`Uang: +${formatRupiah(x.money.income)} / -${formatRupiah(x.money.expense)} = ${formatRupiah(x.money.net)}`);
    }
    if (x.activity.commits || x.activity.filesChanged) {
      lines.push(`Aktivitas: ${x.activity.commits} commit, ${x.activity.filesChanged} file diubah`);
    }
    lines.push(`Produktivitas: ${x.productivity}/100 · Keseimbangan: ${x.balance.label} (${x.balance.score}/100)`);
    lines.push(x.verdict.text);
    const warn = x.balance.checks.filter((c) => c.level === 'warn' || c.level === 'bad');
    for (const c of warn.slice(0, 3)) lines.push(`• ${c.message}`);
    if (x.reportText) lines.push('', `Laporan: ${x.reportText.slice(0, 300)}`);
    return lines.join('\n');
  }

  /** AI evaluation of a day; deterministic fallback when the AI is unavailable. */
  async evaluate(date) {
    const d = this._date(date);
    const x = this.day(d);
    const facts = {
      tanggal: x.label,
      jamKerja: formatMinutes(x.workedMin),
      target: formatMinutes(x.targetMin),
      pencapaian: x.achievement != null ? `${Math.round(x.achievement * 100)}%` : 'tanpa target',
      istirahat: formatMinutes(x.breakMin),
      dibandingHariSebelumnya: x.comparison.workedPct != null ? `${x.comparison.workedPct}%` : 'tidak ada data',
      tugasSelesai: `${x.tasks.done}/${x.tasks.total}`,
      daftarTugas: x.taskList.map((t) => `${t.done ? '[x]' : '[ ]'} ${t.title}`).slice(0, 15),
      uang: { pemasukan: x.money.income, pengeluaran: x.money.expense, bersih: x.money.net },
      aktivitas: { commit: x.activity.commits, fileDiubah: x.activity.filesChanged },
      produktivitas: x.productivity,
      keseimbangan: { skor: x.balance.score, label: x.balance.label, catatan: x.balance.checks.map((c) => c.message) },
      laporan: x.reportText || '(belum ada)',
    };

    let text = null;
    if (this.aiManager) {
      try {
        const r = await collect(this.aiManager, [{ role: 'user', content: JSON.stringify(facts) }], {
          systemPrompt: [
            'Kamu adalah coach kerja pribadi yang jujur dan suportif. Bahasa Indonesia, teks biasa tanpa markdown.',
            'Dari data JSON hari kerja berikut tulis evaluasi singkat (maks 6 kalimat):',
            '1) apakah pekerjaan hari ini cukup, 2) perbandingan dengan hari sebelumnya, 3) keseimbangan kerja-istirahat,',
            '4) satu catatan keuangan bila ada, 5) satu saran konkret untuk besok.',
            'Gunakan hanya angka dari data. Jangan mengarang.',
          ].join('\n'),
          temperature: 0.4,
          maxTokens: 700,
        });
        text = r.text.trim().slice(0, 1500);
      } catch { /* deterministic fallback */ }
    }
    if (!text) {
      const tips = [];
      if (x.balance.checks.some((c) => c.id === 'no_break')) tips.push('Jadwalkan istirahat minimal 30 menit besok.');
      if (x.balance.checks.some((c) => ['overtime', 'long_day', 'trend_over'].includes(c.id))) tips.push('Batasi jam kerja besok agar tidak kelelahan.');
      if (!x.tasks.total) tips.push('Catat 2–3 tugas utama di pagi hari agar progres terukur.');
      if (!x.reportText) tips.push('Tulis laporan singkat sebelum pulang.');
      text = `${x.verdict.text} Keseimbangan: ${x.balance.label}. ${tips.join(' ') || 'Pertahankan ritme ini.'}`;
    }
    this.store.reports.setEvaluation(d, text);
    this._changed(d, 'evaluation');
    return text;
  }

  // ----------------------------------------------------------- telegram

  _chatId() {
    return this.getSettings().telegram.chatId || this.defaultChatId() || null;
  }

  async sendDailySummary(date, { withEvaluation = true } = {}) {
    if (!this.notify) throw new WorklogError('Telegram belum terhubung', 'unavailable');
    const chatId = this._chatId();
    if (!chatId) throw new WorklogError('Chat ID Telegram belum diatur (isi di pengaturan Jurnal Kerja atau TELEGRAM_AI_CHAT_IDS)', 'unavailable');
    const d = this._date(date);
    try { await this.refreshActivity(d); } catch { /* evidence is optional */ }
    let text = this.summaryText(d);
    if (withEvaluation) {
      try {
        const ev = await Promise.race([this.evaluate(d), new Promise((r) => setTimeout(() => r(null), 60_000))]);
        if (ev) text += `\n\nEvaluasi:\n${ev}`;
      } catch { /* summary still goes out */ }
    }
    await this.notify(chatId, text);
    return { chatId, text };
  }

  /** Called every minute: evening summary + optional morning reminder. */
  async tick() {
    if (this._ticking) return;
    this._ticking = true;
    try {
      this.applySchedule();
      await this.deliverReminders();
      const s = this.getSettings();
      const now = this.now();
      const date = localDate(now);
      const hm = localTime(now);
      const workday = s.workdays.includes(weekday(date));
      if (!workday || !this.notify || !this._chatId()) return;

      const reportAt = s.telegram.reportTime || s.workEnd;
      const reportAtMs = atTime(date, reportAt);
      // Only within 6 hours after the report time: a server started late at night
      // must not fire a stale "evening" summary.
      const inWindow = reportAtMs != null && now >= reportAtMs && now - reportAtMs <= 6 * 3_600_000;
      if (s.telegram.dailyReport && inWindow && !this.store.meta.get(`report_sent:${date}`)) {
        const st = this.status();
        const x = this.day(date, { light: true });
        const hasData = x.workedMin > 0 || x.tasks.total > 0 || x.money.income > 0 || x.money.expense > 0 || x.report.hasReport;
        // Nothing to summarise yet: stay quiet WITHOUT marking, so data logged
        // later inside the window still gets its summary.
        if (!hasData && st.state === 'idle') return;
        this.store.meta.set(`report_sent:${date}`, now); // mark before sending: never spam on failure loops
        try {
          if (st.state === 'working') {
            await this.notify(this._chatId(), `Sudah pukul ${hm}, jam kerja selesai. Anda masih tercatat bekerja (${formatMinutes(st.workedMin)}). Kirim /selesai bila sudah pulang — ringkasan lengkap menyusul.`);
          }
          await this.sendDailySummary(date);
        } catch (e) {
          console.warn('[WORKLOG] gagal kirim ringkasan:', e.message);
        }
      }

      if (s.telegram.morningReminder && hm >= s.workStart && !this.store.meta.get(`morning_sent:${date}`)) {
        this.store.meta.set(`morning_sent:${date}`, now);
        if (this.status().state === 'idle') {
          try {
            await this.notify(this._chatId(), `Selamat pagi! Jam kerja dimulai ${s.workStart}. Kirim /mulai saat Anda mulai bekerja, dan /catat untuk mencatat apa pun.`);
          } catch { /* ignore */ }
        }
      }
    } finally {
      this._ticking = false;
    }
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => { this.tick().catch(() => {}); }, 30_000);
    this._timer.unref?.();
    this.alarms?.start();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.alarms?.stop();
  }

  /** Short context for the AI chat ("berapa jam saya kerja hari ini?"). */
  contextForChat() {
    try {
      const st = this.status();
      const x = this.day(st.date, { light: true });
      const stateId = { working: 'sedang bekerja', break: 'sedang istirahat', done: 'sudah selesai bekerja', idle: 'belum mulai bekerja' }[st.state];
      return `Data jurnal kerja pengguna hari ini (${formatDateId(st.date)}): ${stateId}; jam kerja ${formatMinutes(st.workedMin)} dari target ${formatMinutes(st.targetMin)}; istirahat ${formatMinutes(st.breakMin)}; tugas selesai ${x.tasks.done}/${x.tasks.total}; pemasukan ${formatRupiah(x.money.income)}, pengeluaran ${formatRupiah(x.money.expense)}.`;
    } catch {
      return '';
    }
  }
}

export { DEFAULT_SETTINGS };
