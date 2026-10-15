/**
 * Alarm control by plain language, deterministic (never depends on the model):
 *   - "bunyikan alarm jam 4 subuh" / "bangunkan saya jam 5"      -> arm an alarm
 *   - while it rings: "bangun" / "stop" / "tunda 5 menit"        -> acknowledge / snooze
 *   - "matikan alarm" / "alarm apa saja"                         -> cancel / list
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { localDate, localTime, formatDateId } from './time.js';
import { ALARM_INTENT, parseAlarmRequest, alarmReplyKind, snoozeMinutes } from './alarms.js';

const MENTIONS_ALARM = /\b(alarm|alaram)\b/i;
const LIST_WORDS = /\b(apa saja|apa aja|daftar|list|lihat|cek|ada)\b/i;
const ASKS_ABOUT = /\b(alarm|alaram)\b.*\b(apa|berapa)\b/i;

/**
 * @param {{alarms?: object}} worklog  the worklog service (has .alarms)
 * @returns {string|null} reply, or null when the message is not about alarms
 */
export function quickAlarm(worklog, text, now = Date.now(), env = process.env) {
  const al = worklog?.alarms;
  if (!al) return null;
  const t = String(text || '').trim();
  const call = String(env.OWNER_CALL || '').trim() || al.config.callName || 'Mas';
  const ringing = al.ringing();
  const kind = alarmReplyKind(t);

  if (ringing.length && kind === 'ack') {
    al.ack();
    return `Alhamdulillah, ${call} sudah bangun. Alarm saya matikan. Semoga shalatnya khusyuk dan harinya lancar. 🤲`;
  }
  if (ringing.length && kind === 'snooze') {
    const r = al.snooze(snoozeMinutes(t, 5));
    return r.snoozed
      ? `Baik, saya tunda ${r.minutes} menit. Setelah itu saya bunyikan lagi sampai ${call} benar-benar bangun.`
      : 'Alarm ini sudah ditunda lima kali, jadi tidak bisa ditunda lagi. Bangun dulu ya, lalu balas "bangun".';
  }
  if (kind === 'cancel' && MENTIONS_ALARM.test(t)) {
    const n = al.cancelAll();
    return n ? `Siap, ${n} alarm saya matikan.` : 'Tidak ada alarm aktif.';
  }
  if (MENTIONS_ALARM.test(t) && LIST_WORDS.test(t) && !parseAlarmRequest(t, now)) {
    const list = al.list();
    if (!list.length) return 'Tidak ada alarm aktif.';
    return ['Alarm aktif:', ...list.map((a, i) => `${i + 1}. ${formatDateId(localDate(a.at))} pukul ${localTime(a.at)} — ${a.label}${a.status === 'ringing' ? ' (sedang berbunyi)' : ''}`)].join('\n');
  }
  if (ALARM_INTENT.test(t) && !ASKS_ABOUT.test(t)) {
    const req = parseAlarmRequest(t, now);
    if (!req) return `Alarm jam berapa, ${call}? Tulis misalnya "bunyikan alarm jam 4 subuh".`;
    let a;
    try {
      a = al.add({ at: req.at, label: req.label, source: 'telegram' });
    } catch (e) {
      return `✗ ${e.message}`;
    }
    const day = formatDateId(localDate(a.at));
    const ntfy = al.config.ntfy ? ' Notifikasi darurat ntfy juga aktif.' : '';
    return [
      `✓ Alarm "${a.label}" terpasang: ${day} pukul ${localTime(a.at)} WIB${req.assumed ? ' (jam itu sudah lewat hari ini, jadi untuk besok)' : ''}.`,
      `Saat waktunya saya kirim notifikasi beruntun tiap ${al.config.fastGapS} detik, makin tegas, sampai ${call} membalas "bangun" (atau "tunda 5 menit").${ntfy}`,
      'Supaya HP benar-benar bunyi keras: di Telegram buka chat ini → Notifikasi → pilih nada keras & izinkan melewati Jangan Ganggu, dan jangan matikan suara chat ini sebelum tidur. Bot tidak bisa menembus mode senyap bawaan HP.',
    ].join('\n');
  }
  return null;
}
