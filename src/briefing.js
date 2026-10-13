/**
 * src/briefing.js
 *
 * Morning briefing for a remote workday, built from the system's own data
 * (no AI call, so it is free, instant and never hallucinates):
 *   schedule · today's reminders · email that needs you · email you are
 *   waiting on · follow-ups due · yesterday's numbers · open tasks.
 *
 * Sent automatically on workdays (default 15 minutes before work starts),
 * and on demand with /brief or "agenda hari ini".
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { localDate, localTime, addDays, atTime, weekday, formatDateId, formatMinutes, formatRupiah } from './worklog/time.js';

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const daysAgo = (now, at) => Math.max(0, Math.floor((now - at) / 86_400_000));

/** HH:MM minus N minutes (floored at 00:00). */
function minus(hhmm, min) {
  const [h, m] = String(hhmm || '08:00').split(':').map(Number);
  const t = Math.max(0, h * 60 + m - min);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export function createBriefing({ worklog, desk = null, notify = null, defaultChatId = () => null, env = process.env, now = () => Date.now() }) {
  const enabled = String(env.BRIEFING_ENABLED ?? 'true').toLowerCase() !== 'false';
  let timer = null;

  function sendTime(settings) {
    return /^\d{2}:\d{2}$/.test(env.BRIEFING_TIME || '') ? env.BRIEFING_TIME : minus(settings.workStart, 15);
  }

  /** @returns {string} */
  function build(at = now()) {
    const today = localDate(at);
    const s = worklog.getSettings();
    const lines = [`☀️ Briefing — ${formatDateId(today)}`];

    const workday = (s.workdays || []).includes(weekday(today));
    lines.push(workday
      ? `⏰ Jam kerja ${s.workStart}–${s.workEnd}${s.breakStart && s.breakEnd ? ` · istirahat ${s.breakStart}–${s.breakEnd}` : ''}${s.autoStart ? ' · mulai otomatis' : ''}`
      : '🌴 Hari ini bukan hari kerja.');

    // reminders today
    const rem = worklog.listReminders(100).filter((r) => localDate(r.at) === today);
    lines.push('', rem.length ? `📌 Pengingat hari ini (${rem.length}):` : '📌 Tidak ada pengingat hari ini.');
    for (const r of rem.slice(0, 10)) lines.push(`  • ${localTime(r.at)} — ${clip(r.text, 90)}`);

    // email
    if (desk) {
      const o = desk.overview();
      const parts = [];
      const draftCount = o.drafts.length + o.batches.reduce((n, b) => n + b.count, 0);
      if (draftCount) parts.push(`  • ${draftCount} draf menunggu "kirim"${o.batches.length ? ` (termasuk ${o.batches.length} email massal)` : ''}`);
      if (o.awaitingYou.length) {
        parts.push(`  • Perlu kamu balas (${o.awaitingYou.length}):`);
        for (const t of o.awaitingYou.slice(0, 5)) parts.push(`     – ${t.counterpart} — ${clip(t.subject, 50)}: «${clip(t.last?.snippet, 70)}»`);
      }
      if (o.awaitingThem.length) {
        parts.push(`  • Menunggu balasan (${o.awaitingThem.length}):`);
        for (const t of o.awaitingThem.slice(0, 5)) parts.push(`     – ${t.counterpart} — ${clip(t.subject, 50)} (sejak ${daysAgo(at, t.last.at)} hari)`);
      }
      const dueToday = o.followUps.filter((t) => localDate(t.followUpAt) <= today);
      if (dueToday.length) parts.push(`  • Follow-up jatuh tempo: ${dueToday.map((t) => t.counterpart).slice(0, 5).join(', ')}`);
      lines.push('', parts.length ? '📧 Email:' : '📧 Email: tidak ada yang perlu ditindaklanjuti.', ...parts);
    }

    // yesterday
    const y = worklog.day(addDays(today, -1), { light: true });
    if (y.workedMin > 0 || y.tasks.total || y.money.income || y.money.expense) {
      lines.push('', `📊 Kemarin: kerja ${formatMinutes(y.workedMin)}${y.achievement ? ` (${Math.round(y.achievement * 100)}%)` : ''} · tugas ${y.tasks.done}/${y.tasks.total} · bersih ${formatRupiah(y.money.net)}`);
    }

    // open tasks (today + carried over from yesterday)
    const open = [...(worklog.day(today).taskList || []), ...(worklog.day(addDays(today, -1)).taskList || [])].filter((t) => !t.done);
    if (open.length) {
      lines.push('', `✅ Tugas terbuka (${open.length}):`);
      for (const t of open.slice(0, 8)) lines.push(`  • ${clip(t.title, 90)}`);
    }

    lines.push('', 'Balas di sini untuk mencatat, mengingatkan, atau mengirim email.');
    return lines.join('\n');
  }

  async function tick() {
    if (!enabled || !notify) return false;
    const at = now();
    const today = localDate(at);
    const s = worklog.getSettings();
    if (!(s.workdays || []).includes(weekday(today))) return false;
    const when = atTime(today, sendTime(s));
    if (when == null || at < when || at - when > 3 * 3_600_000) return false; // late start: skip a stale briefing
    const key = `briefing_sent:${today}`;
    if (worklog.store.meta.get(key)) return false;
    worklog.store.meta.set(key, String(at)); // mark first: never twice
    const chat = defaultChatId();
    if (!chat) return false;
    try { await notify(chat, build(at)); return true; } catch (e) { console.warn('[BRIEFING] gagal kirim:', e.message); return false; }
  }

  return {
    build,
    tick,
    start() {
      if (timer || !enabled) return false;
      timer = setInterval(() => { tick().catch(() => {}); }, 60_000);
      timer.unref?.();
      return true;
    },
    stop() { clearInterval(timer); timer = null; },
    commands() {
      return {
        brief: { description: 'briefing hari ini: jadwal, pengingat, email, tugas', run: async () => build() },
        agenda: { description: 'sama dengan /brief', run: async () => build() },
      };
    },
  };
}
