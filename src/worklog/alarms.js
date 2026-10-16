/**
 * src/worklog/alarms.js
 *
 * "Bangunkan saya jam 4 subuh": an alarm that does not stop after one message.
 *
 *   armed -> (time arrives) -> ringing -> acknowledged by the owner  (or snoozed, or gives up)
 *
 * While ringing it sends a notification again and again, escalating in wording and
 * frequency, until the owner answers ("bangun" / "stop") or the cap is reached.
 * Delivery channels: Telegram (always) and, optionally, ntfy.sh with *urgent*
 * priority (NTFY_TOPIC), which on a phone with the ntfy app rings like a real alarm.
 *
 * Honest limit: a Telegram bot cannot override a silenced phone. Notification
 * volume/DND is the phone's decision; the instructions in the confirmation say how
 * to make this chat (and ntfy) break through.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import crypto from 'node:crypto';
import { localDate, localTime, addDays, atTime } from './time.js';

const ID = () => `alm_${crypto.randomBytes(5).toString('hex')}`;

export const ALARM_INTENT = /\b(alarm|alaram|bangunkan|bangunin|bangunkn|bunyikan|bunyiin|bunyi(?:kan)?\s+hp|bangun(?:kan|in)?\s+(?:saya|aku|gue|gw))\b/i;
const ALARM_OFF = /\b(matikan|mati?kan|stop|hentikan|batalkan|batal|hapus|cancel|nonaktifkan)\b.*\b(alarm|alaram)\b|\b(alarm|alaram)\b.*\b(matikan|stop|hentikan|batalkan|batal|hapus|cancel|nonaktifkan|mati)\b/i;
const ACK_WORDS = /^(?:sudah\s+)?(?:saya\s+|aku\s+|gue\s+)?(?:bangun|udah\s+bangun|sudah|siap|oke|ok|okay|ya|iya|yes|stop|matikan|diam|cukup|terima kasih|makasih|thanks)\b/i;

/**
 * Extracts "when" from natural Indonesian: "jam 4 subuh", "besok jam 5.30 pagi",
 * "setengah 5 pagi", "30 menit lagi", "jam 22.00 malam".
 * @returns {{at:number, label:string, assumed?:string}|null}
 */
export function parseAlarmRequest(text, now = Date.now()) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return null;
  const today = localDate(now);

  // relative: "10 menit lagi", "2 jam lagi"
  const rel = /(\d{1,3})\s*(menit|jam)\s*lagi/i.exec(src);
  if (rel && !/\bjam\s*\d/i.test(src.replace(rel[0], ''))) {
    const ms = Number(rel[1]) * (/jam/i.test(rel[2]) ? 3_600_000 : 60_000);
    if (ms > 0 && ms <= 24 * 3_600_000) return { at: now + ms, label: labelFor(src) };
  }

  const period = (/\b(subuh|fajar|dini hari|pagi|siang|sore|petang|malam)\b/i.exec(src)?.[1] || '').toLowerCase();
  let h = null;
  let min = 0;
  const half = /\bsetengah\s*(\d{1,2})\b/i.exec(src);
  const hm = /\b(?:jam|pukul|pkl)\s*(\d{1,2})(?:\s*[:.]\s*(\d{2}))?\b/i.exec(src) || /\b(\d{1,2})\s*[:.]\s*(\d{2})\b/.exec(src);
  if (half) { h = Number(half[1]) - 1; min = 30; if (h <= 0) h += 12; }
  else if (hm) { h = Number(hm[1]); min = Number(hm[2] || 0); }
  else if (period === 'subuh' || period === 'fajar') { h = 4; min = 30; }
  else return null;
  if (h > 24 || min > 59) return null;

  if (period === 'siang' && h >= 1 && h <= 4) h += 12;
  else if ((period === 'sore' || period === 'petang') && h < 12) h += 12;
  else if (period === 'malam') { if (h >= 5 && h < 12) h += 12; else if (h === 12) h = 0; }
  else if ((period === 'subuh' || period === 'fajar' || period === 'dini hari') && h === 12) h = 0;
  if (h === 24) h = 0;

  const explicit = /\blusa\b/i.test(src) ? 2 : /\bbesok\b/i.test(src) ? 1 : 0;
  const hhmm = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  let date = addDays(today, explicit);
  let at = atTime(date, hhmm);
  let assumed;
  if (!explicit && at <= now) { date = addDays(today, 1); at = atTime(date, hhmm); assumed = 'besok'; }
  if (!Number.isFinite(at)) return null;
  return { at, label: labelFor(src), assumed, hhmm, date };
}

function labelFor(src) {
  if (/\b(subuh|fajar)\b/i.test(src) || /\b(shalat|sholat|salat)\b/i.test(src)) {
    const which = /\b(subuh|fajar)\b/i.test(src) ? 'Subuh' : (/\b(dzuhur|zuhur)\b/i.test(src) ? 'Dzuhur' : (/\bashar\b|\bashr\b/i.test(src) ? 'Ashar' : (/\bmaghrib\b/i.test(src) ? 'Maghrib' : (/\bisya\b/i.test(src) ? 'Isya' : ''))));
    return `Shalat ${which}`.trim();
  }
  const why = /(?:karena|untuk|buat|supaya|agar)\s+(.{3,80})$/i.exec(src)?.[1];
  return why ? why.replace(/[.!?]+$/, '') : 'Bangun';
}

export function createAlarms({
  db, notify = null, chatId = () => null, now = () => Date.now(), env = process.env, onChange = () => {}, fetchImpl = globalThis.fetch, call = 'Mas',
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wl_alarms (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      label TEXT NOT NULL,
      chat_id TEXT,
      status TEXT NOT NULL DEFAULT 'armed',
      fires INTEGER NOT NULL DEFAULT 0,
      snoozes INTEGER NOT NULL DEFAULT 0,
      last_fire_at INTEGER,
      acked_at INTEGER,
      created_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'telegram'
    );
    CREATE INDEX IF NOT EXISTS idx_wl_alarm_status ON wl_alarms(status, at);
  `);

  const cfg = {
    maxFires: Math.max(5, parseInt(env.ALARM_MAX_FIRES || '60', 10) || 60),
    fastGapS: Math.max(5, parseInt(env.ALARM_REPEAT_SECONDS || '20', 10) || 20),
    slowGapS: Math.max(10, parseInt(env.ALARM_REPEAT_SLOW_SECONDS || '45', 10) || 45),
    ntfy: String(env.NTFY_TOPIC || '').trim(),
    ntfyBase: String(env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, ''),
    callName: String(env.OWNER_CALL || '').trim() || call,
  };
  let timer = null;
  let busy = false;

  /** Alarm yang lewat lebih dari 1 jam tidak dibunyikan lagi, kedaluwarsa saja. */
  const ALARM_STALE_MS = 60 * 60_000;

  const q = {
    insert: db.prepare('INSERT INTO wl_alarms (id, at, label, chat_id, created_at, source) VALUES (?, ?, ?, ?, ?, ?)'),
    get: db.prepare('SELECT * FROM wl_alarms WHERE id = ?'),
    active: db.prepare("SELECT * FROM wl_alarms WHERE status IN ('armed','ringing') ORDER BY at ASC"),
    recent: db.prepare("SELECT * FROM wl_alarms WHERE status NOT IN ('armed','ringing') ORDER BY COALESCE(acked_at, last_fire_at, at) DESC LIMIT ?"),
    ringing: db.prepare("SELECT * FROM wl_alarms WHERE status = 'ringing' ORDER BY at ASC"),
    ring: db.prepare("UPDATE wl_alarms SET status = 'ringing' WHERE id = ? AND status = 'armed'"),
    fired: db.prepare('UPDATE wl_alarms SET fires = fires + 1, last_fire_at = ? WHERE id = ?'),
    ack: db.prepare("UPDATE wl_alarms SET status = 'acked', acked_at = ? WHERE id = ? AND status = 'ringing'"),
    cancel: db.prepare("UPDATE wl_alarms SET status = 'cancelled', acked_at = ? WHERE id = ? AND status IN ('armed','ringing')"),
    expire: db.prepare("UPDATE wl_alarms SET status = 'expired' WHERE id = ? AND status = 'ringing'"),
    snooze: db.prepare("UPDATE wl_alarms SET status = 'armed', at = ?, snoozes = snoozes + 1, fires = 0, last_fire_at = NULL WHERE id = ? AND status = 'ringing'"),
  };

  const view = (r) => r && ({
    id: r.id, at: r.at, label: r.label, status: r.status, fires: r.fires, snoozes: r.snoozes,
    lastFireAt: r.last_fire_at, ackedAt: r.acked_at, source: r.source,
  });

  function add({ at, label = 'Bangun', chatId: cid = null, source = 'telegram' }) {
    const t = now();
    if (!Number.isFinite(at)) throw new Error('Waktu alarm tidak valid');
    if (at < t - 30_000) throw new Error('Waktu alarm sudah lewat');
    if (at > t + 31 * 86_400_000) throw new Error('Alarm maksimal 31 hari ke depan');
    if (q.active.all().length >= 20) throw new Error('Terlalu banyak alarm aktif (maks 20)');
    const rid = ID();
    q.insert.run(rid, Math.max(at, t), String(label).slice(0, 80) || 'Bangun', cid || chatId(), t, source);
    onChange();
    return view(q.get.get(rid));
  }

  const list = () => q.active.all().map(view);
  const recent = (n = 5) => q.recent.all(n).map(view);
  const ringing = () => q.ringing.all().map(view);

  /** "bangun" / "stop": silences every ringing alarm. */
  function ack() {
    let n = 0;
    for (const r of q.ringing.all()) n += q.ack.run(now(), r.id).changes;
    if (n) onChange();
    return n;
  }

  function cancel(id) {
    const n = q.cancel.run(now(), id).changes;
    if (n) onChange();
    return n > 0;
  }

  /** Cancels every armed/ringing alarm (used by "matikan alarm"). */
  function cancelAll() {
    let n = 0;
    for (const r of q.active.all()) n += q.cancel.run(now(), r.id).changes;
    if (n) onChange();
    return n;
  }

  function snooze(minutes = 5) {
    const m = Math.min(30, Math.max(1, Math.round(minutes)));
    let n = 0;
    for (const r of q.ringing.all()) {
      if (r.snoozes >= 5) continue; // no endless snooze: after 5 it keeps ringing until acknowledged
      n += q.snooze.run(now() + m * 60_000, r.id).changes;
    }
    if (n) onChange();
    return { snoozed: n, minutes: m };
  }

  function textFor(a) {
    const n = a.fires + 1;
    const when = localTime(a.at);
    const c = cfg.callName;
    const bells = '🔔'.repeat(Math.min(5, 1 + Math.floor(n / 3)));
    if (n === 1) return `⏰ ALARM ${when} — ${a.label}\n${bells}\n${c}, waktunya bangun! Balas "bangun" untuk mematikan alarm ini.`;
    if (n <= 4) return `⏰ ${a.label.toUpperCase()} — BANGUN ${c.toUpperCase()}! (${n})\n${bells}\nBalas "bangun" kalau sudah bangun, atau "tunda 5 menit".`;
    if (n <= 10) return `🚨 ${c}, SUDAH ${Math.round((now() - a.at) / 60_000) || 1} MENIT! ${a.label.toUpperCase()}!\n${bells}\nBangun dulu, ambil air wudhu. Balas "bangun" supaya saya berhenti. (${n})`;
    return `🚨🚨 ALARM MASIH BUNYI (${n}) — ${a.label}\n${bells}\n${c}, ini bukan latihan. Duduk, nyalakan lampu, balas "bangun".`;
  }

  async function ringOnce(a) {
    const text = textFor(a);
    const cid = a.chat_id || chatId();
    const jobs = [];
    if (notify && cid) jobs.push(notify(cid, text).catch((e) => console.warn('[ALARM] telegram gagal:', e.message)));
    if (cfg.ntfy && typeof fetchImpl === 'function') {
      jobs.push(fetchImpl(`${cfg.ntfyBase}/${encodeURIComponent(cfg.ntfy)}`, {
        method: 'POST',
        headers: {
          Title: `ALARM ${localTime(a.at)} — ${a.label}`,
          Priority: 'urgent',
          Tags: 'rotating_light,alarm_clock',
        },
        body: text.replace(/[\u{1F300}-\u{1FAFF}]/gu, '').trim().slice(0, 500),
      }).catch((e) => console.warn('[ALARM] ntfy gagal:', e.message)));
    }
    await Promise.all(jobs);
  }

  async function tick() {
    if (busy) return 0;
    busy = true;
    let fired = 0;
    try {
      const t = now();
      for (const a of q.active.all()) {
        if (a.status === 'armed') {
          if (a.at > t) continue; // belum waktunya
          // Alarm yang waktunya sudah lewat lebih dari 1 jam (service sebelumnya
          // mati saat seharusnya berbunyi): jangan bunyikan, tandai expired saja.
          if (t - a.at > ALARM_STALE_MS) {
            q.expire.run(a.id);
            onChange();
            continue;
          }
          if (!q.ring.run(a.id).changes) continue;
          a.status = 'ringing';
          onChange();
        }
        // ringing: fast at first, slower later, with a hard cap
        if (a.status === 'ringing' && t - a.at > ALARM_STALE_MS) {
          q.expire.run(a.id);
          onChange();
          const cid = a.chat_id || chatId();
          if (notify && cid) notify(cid, `Alarm ${localTime(a.at)} (${a.label}) saya hentikan karena sudah terlambat lebih dari ${Math.round((t - a.at) / 60_000)} menit. ${cfg.callName} belum menjawab.`).catch(() => {});
          continue;
        }
        if (a.fires >= cfg.maxFires) {
          q.expire.run(a.id);
          onChange();
          const cid = a.chat_id || chatId();
          if (notify && cid) notify(cid, `Alarm ${localTime(a.at)} (${a.label}) saya hentikan setelah ${a.fires} kali dibunyikan. ${cfg.callName} belum menjawab — semoga tidak apa-apa.`).catch(() => {});
          continue;
        }
        const gap = (a.fires < 10 ? cfg.fastGapS : cfg.slowGapS) * 1000;
        if (a.last_fire_at && t - a.last_fire_at < gap) continue;
        q.fired.run(t, a.id); // count first: a slow network can never double-fire
        a.fires += 1;
        await ringOnce({ ...a, fires: a.fires - 1 });
        fired++;
        onChange();
      }
    } finally {
      busy = false;
    }
    return fired;
  }

  /** Membersihkan alarm lama yang waktunya sudah lewat terlalu lama (stale) saat service pertama kali menyala. */
  function cleanupStale() {
    const t = now();
    let n = 0;
    for (const a of q.active.all()) {
      if (a.at <= t && t - a.at > ALARM_STALE_MS) {
        if (a.status === 'armed') n += q.expire.run(a.id).changes;
        else if (a.status === 'ringing') n += q.cancel.run(t, a.id).changes;
      }
    }
    if (n) onChange();
    return n;
  }

  return {
    add, list, recent, ringing, ack, cancel, cancelAll, snooze, tick, view, config: cfg, cleanupStale,
    start() {
      if (timer) return;
      cleanupStale(); // bersihkan alarm stale segera saat nyala
      timer = setInterval(() => { tick().catch(() => {}); }, 5_000);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

/** Word the owner uses to switch the alarm off (deterministic: never depends on the model). */
export function alarmReplyKind(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 120) return null;
  if (/^(?:tunda|snooze)\b|\b(\d{1,2})\s*menit\s*lagi\b/i.test(t) && !ALARM_INTENT.test(t.replace(/\b(\d{1,2})\s*menit\s*lagi\b/i, ''))) return 'snooze';
  if (ALARM_OFF.test(t)) return 'cancel';
  if (ACK_WORDS.test(t)) return 'ack';
  return null;
}

export function snoozeMinutes(text, fallback = 5) {
  const m = /(\d{1,2})\s*menit/i.exec(String(text || ''));
  return m ? Number(m[1]) : fallback;
}

