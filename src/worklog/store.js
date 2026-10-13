/**
 * src/worklog/store.js
 *
 * Persistence for the work journal (same SQLite database as the rest of Wanar
 * AI; injectable for tests).
 *
 *   wl_settings   single JSON document (schedule, targets, sources, telegram)
 *   wl_segments   time segments: kind 'work' | 'break', end_at NULL while open
 *   wl_tasks      what was worked on
 *   wl_finance    income / expense entries (integer Rupiah)
 *   wl_reports    the ~300-char daily report + optional AI evaluation
 *   wl_activity   cached activity snapshots (folders, git, GitHub) per day
 *   wl_meta       small key/value flags (e.g. "daily report sent for date X")
 *
 * @author Wisnu Alfian Nur Ashar
 */

import crypto from 'node:crypto';

export const REPORT_MAX = 600; // the target is ~300, but never truncate a real report too hard

export const DEFAULT_SETTINGS = Object.freeze({
  workStart: '09:00',
  workEnd: '17:00',
  breakStart: '12:00',               // fixed break window (used by "follow schedule")
  breakEnd: '13:00',
  breakMinutes: 60,                  // kept in sync with the window, for older readers
  // null = derived from the schedule: (workEnd - workStart) - break window.
  // A fixed number would drift out of sync whenever the schedule changes.
  targetHours: null,
  followSchedule: true,              // after "Mulai": auto break, auto resume
  autoStop: true,                    // stop automatically at workEnd (start again to log overtime)
  autoStart: false,                  // start automatically at workStart on workdays
  workdays: [1, 2, 3, 4, 5],          // Mon–Fri
  hourlyRate: 0,                       // optional, for "nilai jam kerja"
  monthlyIncomeTarget: 0,
  currency: 'IDR',
  sources: {
    folders: [],                       // [{ path, label }]
    github: { username: '', repos: [] },
    gitAuthor: '',                     // filter local git log (email or name), optional
  },
  telegram: {
    dailyReport: true,                 // send the evening summary
    scheduleNotices: true,             // "waktunya istirahat" / "jam kerja selesai" messages
    morningReminder: false,
    reportTime: '',                    // '' = at workEnd
    chatId: '',                        // '' = first of TELEGRAM_AI_CHAT_IDS
  },
});

const id = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const parse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

function mergeSettings(base, patch) {
  const out = { ...base, ...patch };
  out.sources = {
    ...base.sources, ...(patch.sources || {}),
    github: { ...base.sources.github, ...(patch.sources?.github || {}) },
  };
  out.telegram = { ...base.telegram, ...(patch.telegram || {}) };
  return out;
}

export function createWorklogStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wl_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wl_segments (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('work','break')),
      start_at INTEGER NOT NULL,
      end_at INTEGER,
      source TEXT NOT NULL DEFAULT 'manual',
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wl_seg_date ON wl_segments(date);
    CREATE INDEX IF NOT EXISTS idx_wl_seg_open ON wl_segments(end_at);

    CREATE TABLE IF NOT EXISTS wl_tasks (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      minutes INTEGER,
      project TEXT,
      created_at INTEGER NOT NULL,
      done_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_wl_task_date ON wl_tasks(date);

    CREATE TABLE IF NOT EXISTS wl_finance (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('income','expense')),
      amount INTEGER NOT NULL CHECK (amount >= 0),
      category TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wl_fin_date ON wl_finance(date);

    CREATE TABLE IF NOT EXISTS wl_reports (
      date TEXT PRIMARY KEY,
      text TEXT NOT NULL DEFAULT '',
      mood INTEGER,
      evaluation TEXT,
      evaluated_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wl_activity (
      date TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      collected_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wl_reminders (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      text TEXT NOT NULL,
      chat_id TEXT,
      source TEXT NOT NULL DEFAULT 'telegram',
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      cancelled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_wl_rem_due ON wl_reminders(sent_at, cancelled_at, at);

    CREATE TABLE IF NOT EXISTS wl_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL
    );
  `);

  const now = () => Date.now();

  const settings = {
    get() {
      const row = db.prepare('SELECT data FROM wl_settings WHERE id = 1').get();
      return mergeSettings(DEFAULT_SETTINGS, parse(row?.data, {}));
    },
    set(next) {
      const merged = mergeSettings(DEFAULT_SETTINGS, next);
      db.prepare('INSERT INTO wl_settings (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .run(JSON.stringify(merged), now());
      return merged;
    },
  };

  const segments = {
    add({ date, kind, startAt, endAt = null, source = 'manual', note = null }) {
      const sid = id('seg');
      db.prepare('INSERT INTO wl_segments (id, date, kind, start_at, end_at, source, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(sid, date, kind, startAt, endAt, source, note, now());
      return segments.get(sid);
    },
    get: (sid) => db.prepare('SELECT * FROM wl_segments WHERE id = ?').get(sid) || null,
    forDate: (date) => db.prepare('SELECT * FROM wl_segments WHERE date = ? ORDER BY start_at ASC').all(date),
    forRange: (from, to) => db.prepare('SELECT * FROM wl_segments WHERE date >= ? AND date <= ? ORDER BY start_at ASC').all(from, to),
    open: () => db.prepare('SELECT * FROM wl_segments WHERE end_at IS NULL ORDER BY start_at DESC').all(),
    close(sid, endAt) {
      db.prepare('UPDATE wl_segments SET end_at = ? WHERE id = ? AND end_at IS NULL').run(endAt, sid);
      return segments.get(sid);
    },
    update(sid, { startAt, endAt, note }) {
      const cur = segments.get(sid);
      if (!cur) return null;
      db.prepare('UPDATE wl_segments SET start_at = ?, end_at = ?, note = ? WHERE id = ?')
        .run(startAt ?? cur.start_at, endAt === undefined ? cur.end_at : endAt, note === undefined ? cur.note : note, sid);
      return segments.get(sid);
    },
    remove: (sid) => db.prepare('DELETE FROM wl_segments WHERE id = ?').run(sid).changes > 0,
  };

  const tasks = {
    add({ date, title, done = false, minutes = null, project = null }) {
      const tid = id('task');
      const t = now();
      db.prepare('INSERT INTO wl_tasks (id, date, title, done, minutes, project, created_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(tid, date, title, done ? 1 : 0, minutes, project, t, done ? t : null);
      return tasks.get(tid);
    },
    get: (tid) => db.prepare('SELECT * FROM wl_tasks WHERE id = ?').get(tid) || null,
    forDate: (date) => db.prepare('SELECT * FROM wl_tasks WHERE date = ? ORDER BY created_at ASC').all(date),
    forRange: (from, to) => db.prepare('SELECT * FROM wl_tasks WHERE date >= ? AND date <= ? ORDER BY date, created_at').all(from, to),
    update(tid, patch) {
      const cur = tasks.get(tid);
      if (!cur) return null;
      const done = patch.done === undefined ? cur.done : (patch.done ? 1 : 0);
      db.prepare('UPDATE wl_tasks SET title = ?, done = ?, minutes = ?, project = ?, done_at = ? WHERE id = ?').run(
        patch.title ?? cur.title, done,
        patch.minutes === undefined ? cur.minutes : patch.minutes,
        patch.project === undefined ? cur.project : patch.project,
        done && !cur.done ? now() : (done ? cur.done_at : null),
        tid
      );
      return tasks.get(tid);
    },
    remove: (tid) => db.prepare('DELETE FROM wl_tasks WHERE id = ?').run(tid).changes > 0,
  };

  const finance = {
    add({ date, type, amount, category = null, note = null }) {
      const fid = id('fin');
      db.prepare('INSERT INTO wl_finance (id, date, type, amount, category, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(fid, date, type, Math.round(amount), category, note, now());
      return db.prepare('SELECT * FROM wl_finance WHERE id = ?').get(fid);
    },
    forDate: (date) => db.prepare('SELECT * FROM wl_finance WHERE date = ? ORDER BY created_at ASC').all(date),
    forRange: (from, to) => db.prepare('SELECT * FROM wl_finance WHERE date >= ? AND date <= ? ORDER BY date, created_at').all(from, to),
    remove: (fid) => db.prepare('DELETE FROM wl_finance WHERE id = ?').run(fid).changes > 0,
  };

  const reports = {
    get: (date) => db.prepare('SELECT * FROM wl_reports WHERE date = ?').get(date) || null,
    set(date, { text, mood }) {
      const cur = reports.get(date);
      db.prepare(`INSERT INTO wl_reports (date, text, mood, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET text = excluded.text, mood = excluded.mood, updated_at = excluded.updated_at`)
        .run(date, String(text ?? cur?.text ?? '').slice(0, REPORT_MAX), mood ?? cur?.mood ?? null, now());
      return reports.get(date);
    },
    setEvaluation(date, evaluation) {
      if (!reports.get(date)) reports.set(date, { text: '' });
      db.prepare('UPDATE wl_reports SET evaluation = ?, evaluated_at = ? WHERE date = ?').run(evaluation, now(), date);
      return reports.get(date);
    },
    forRange: (from, to) => db.prepare('SELECT * FROM wl_reports WHERE date >= ? AND date <= ? ORDER BY date').all(from, to),
  };

  const activity = {
    get(date) {
      const r = db.prepare('SELECT * FROM wl_activity WHERE date = ?').get(date);
      return r ? { ...parse(r.data, {}), collectedAt: r.collected_at } : null;
    },
    set(date, data) {
      db.prepare('INSERT INTO wl_activity (date, data, collected_at) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET data = excluded.data, collected_at = excluded.collected_at')
        .run(date, JSON.stringify(data), now());
      return activity.get(date);
    },
    forRange(from, to) {
      return db.prepare('SELECT * FROM wl_activity WHERE date >= ? AND date <= ?').all(from, to)
        .map((r) => ({ date: r.date, ...parse(r.data, {}) }));
    },
  };

  const meta = {
    get: (key) => db.prepare('SELECT value FROM wl_meta WHERE key = ?').get(key)?.value || null,
    set: (key, value) => db.prepare('INSERT INTO wl_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, String(value), now()),
  };

  const reminders = {
    add({ at, text, chatId = null, source = 'telegram' }) {
      const rid = id('rem');
      db.prepare('INSERT INTO wl_reminders (id, at, text, chat_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(rid, at, text, chatId, source, now());
      return reminders.get(rid);
    },
    get: (rid) => db.prepare('SELECT * FROM wl_reminders WHERE id = ?').get(rid) || null,
    upcoming: (limit = 20) => db.prepare('SELECT * FROM wl_reminders WHERE sent_at IS NULL AND cancelled_at IS NULL ORDER BY at ASC LIMIT ?').all(limit),
    due: (atMs) => db.prepare('SELECT * FROM wl_reminders WHERE sent_at IS NULL AND cancelled_at IS NULL AND at <= ? ORDER BY at ASC').all(atMs),
    markSent: (rid) => db.prepare('UPDATE wl_reminders SET sent_at = ? WHERE id = ? AND sent_at IS NULL').run(now(), rid).changes > 0,
    cancel: (rid) => db.prepare('UPDATE wl_reminders SET cancelled_at = ? WHERE id = ? AND sent_at IS NULL AND cancelled_at IS NULL').run(now(), rid).changes > 0,
  };

  /** Dates that have any data, newest first. */
  function datesWithData(limit = 60) {
    return db.prepare(`
      SELECT date FROM (
        SELECT date FROM wl_segments UNION SELECT date FROM wl_tasks
        UNION SELECT date FROM wl_finance UNION SELECT date FROM wl_reports WHERE text <> ''
      ) ORDER BY date DESC LIMIT ?
    `).all(limit).map((r) => r.date);
  }

  return { settings, segments, tasks, finance, reports, activity, meta, reminders, datesWithData, _db: db };
}
