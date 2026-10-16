/**
 * src/automation/prayer-times.js
 *
 * Jadwal waktu shalat untuk kota (default: Bekasi, Indonesia).
 * Mengambil data dari Aladhan API dan mengirim pengingat ke Telegram
 * pada setiap waktu shalat (5 kali sehari: Subuh, Dzuhur/Jumat, Ashar, Maghrib, Isya).
 *
 * Endpoint: https://api.aladhan.com/v1/timingsByCity?city=Bekasi&country=Indonesia&method=2
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { boolEnv, intEnv } from './channels/base.js';
import { MailError } from './mailer.js';
import { zonedToUtc, zonedParts, DEFAULT_TIMEZONE } from './cron.js';

const DEFAULT_CITY = 'Bekasi';
const DEFAULT_COUNTRY = 'Indonesia';
const DEFAULT_METHOD = 2; // ISNA

const PRAYER_LABELS_ID = {
  Fajr: 'Subuh',
  Dhuhr: 'Dzuhur',
  Asr: 'Ashar',
  Maghrib: 'Maghrib',
  Isha: 'Isya',
};

const PRAYER_EMOJIS = {
  Fajr: '🌅',
  Dhuhr: '☀️',
  Asr: '🏟️',
  Maghrib: '🌇',
  Isha: '🌙',
};

const ORDER = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

const WEEKDAY_EN_TO_ID = {
  Sunday: 'Minggu',
  Monday: 'Senin',
  Tuesday: 'Selasa',
  Wednesday: 'Rabu',
  Thursday: 'Kamis',
  Friday: 'Jumat',
  Saturday: 'Sabtu',
};

export function isPrayerTimesEnabled(env = process.env) {
  return boolEnv(env, 'PRAYER_TIMES_ENABLED', true);
}

export function defaultChatId(env = process.env) {
  const explicit = String(env.PRAYER_TIMES_CHAT_ID || '').trim();
  if (explicit) return explicit;
  const first = String(env.TELEGRAM_AI_CHAT_IDS || '').split(',')[0]?.trim();
  return first || null;
}

export async function fetchPrayerTimes({
  city = DEFAULT_CITY,
  country = DEFAULT_COUNTRY,
  method = DEFAULT_METHOD,
} = {}) {
  const url = `https://api.aladhan.com/v1/timingsByCity` +
    `?city=${encodeURIComponent(String(city))}` +
    `&country=${encodeURIComponent(String(country))}` +
    `&method=${Number(method)}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new MailError(`Gagal menghubungi Aladhan API: ${err?.message || err}`, 'TRANSIENT', { code: err?.cause?.code || 'ENETWORK' });
  }
  if (!res.ok) {
    throw new MailError(`Aladhan API gagal: HTTP ${res.status}`, 'TRANSIENT', { responseCode: res.status });
  }
  const json = await res.json().catch(() => ({}));
  if (json.code !== 200 || !json.data) {
    throw new MailError(`Aladhan API gagal: ${json.status || 'respons tidak valid'}`, 'INVALID');
  }
  return json.data;
}

export function formatPrayerTimesMessage(data, { city = DEFAULT_CITY } = {}) {
  const { timings, date } = data || {};
  if (!timings) throw new MailError('Data waktu shalat tidak lengkap', 'INVALID');

  const gregorian = date.gregorian || {};
  const hijri = date.hijri || {};
  const weekdayEn = gregorian.weekday?.en || '';
  const weekdayId = WEEKDAY_EN_TO_ID[weekdayEn] || weekdayEn;
  const tanggal = gregorian.date || '';
  const bulan = gregorian.month?.en || '';
  const tahun = gregorian.year || '';
  const hijriDate = hijri.date || '';
  const hijriMonth = hijri.month?.en || '';
  const hijriYear = hijri.year || '';

  const isJumat = weekdayId === 'Jumat';

  const lines = [];
  lines.push(`🕌 Jadwal Waktu Shalat — ${city}`);
  lines.push(
    `📅 ${weekdayId}, ${tanggal} ${bulan} ${tahun} / ${hijriDate} ${hijriMonth} ${hijriYear} H`,
  );
  lines.push('');
  for (const key of ORDER) {
    const waktu = timings[key];
    if (waktu) {
      let label = PRAYER_LABELS_ID[key];
      let emoji = PRAYER_EMOJIS[key];
      if (key === 'Dhuhr' && isJumat) {
        label = 'Jumat';
        emoji = '🕌';
      }
      lines.push(`${emoji} ${label}: ${waktu}`);
    }
  }
  lines.push('');
  lines.push('Semoga khusyuk dan diterima. 🤲');
  return lines.join('\n');
}

export function formatPrayerReminder(data, { city = DEFAULT_CITY, prayerKey } = {}) {
  const { timings, date } = data || {};
  if (!timings || !prayerKey) throw new MailError('Data waktu shalat tidak lengkap', 'INVALID');

  const waktu = timings[prayerKey];
  if (!waktu) throw new MailError(`Waktu ${prayerKey} tidak ditemukan`, 'INVALID');

  const gregorian = date.gregorian || {};
  const weekdayEn = gregorian.weekday?.en || '';
  const weekdayId = WEEKDAY_EN_TO_ID[weekdayEn] || weekdayEn;
  const isJumat = weekdayId === 'Jumat';

  let label = PRAYER_LABELS_ID[prayerKey];
  let emoji = PRAYER_EMOJIS[prayerKey];
  if (prayerKey === 'Dhuhr' && isJumat) {
    label = 'Jumat';
    emoji = '🕌';
  }

  const callName = String(process.env.OWNER_NAME || 'Wisnu Alfian Nur Ashar').split(/\s+/)[0] || 'Mas Wisnu';

  const lines = [];
  lines.push(`${emoji} Waktu Shalat ${label} — ${city}`);
  lines.push(`📅 ${waktu} WIB`);
  lines.push('');
  lines.push(`Waktunya shalat ${label.toLowerCase()}, ${callName}. Semoga khusyuk dan diterima. 🤲`);
  return lines.join('\n');
}

export async function sendPrayerReminderToTelegram({
  channel,
  chatId,
  city = DEFAULT_CITY,
  country = DEFAULT_COUNTRY,
  method = DEFAULT_METHOD,
  prayerKey,
} = {}) {
  if (!channel) throw new MailError('Channel Telegram tidak tersedia', 'INVALID');
  if (channel.mode !== 'live') {
    throw new MailError('Telegram belum dikonfigurasi (mode simulasi). Isi TELEGRAM_BOT_TOKEN di .env.', 'INVALID');
  }
  if (!chatId) throw new MailError('Chat ID tujuan belum diisi. Set PRAYER_TIMES_CHAT_ID atau TELEGRAM_AI_CHAT_IDS di .env.', 'INVALID');

  const data = await fetchPrayerTimes({ city, country, method });
  const text = formatPrayerReminder(data, { city, prayerKey });
  return channel.send({ to: chatId, text });
}

export function createPrayerTimesService({
  channel,
  chatId = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const city = String(env.PRAYER_TIMES_CITY || DEFAULT_CITY).trim();
  const country = String(env.PRAYER_TIMES_COUNTRY || DEFAULT_COUNTRY).trim();
  const method = intEnv(env, 'PRAYER_TIMES_METHOD', DEFAULT_METHOD, { min: 1, max: 11 });
  const targetChatId = chatId || defaultChatId(env);
  const enabled = boolEnv(env, 'PRAYER_TIMES_ENABLED', true);
  const tz = env.AUTOMATION_TZ || 'Asia/Jakarta';

  let timers = [];
  let lastData = null;
  let lastRunAt = null;
  let lastError = null;

  async function fetchAndSchedule() {
    const data = await fetchPrayerTimes({ city, country, method });
    lastData = data;
    const timings = data.timings;

    // Clear existing timers
    for (const t of timers) clearTimeout(t);
    timers = [];

    const now = Date.now();
    const local = zonedParts(now, tz);

    for (const key of ORDER) {
      const timeStr = timings[key]; // "04:33"
      const [h, m] = timeStr.split(':').map(Number);
      const runAt = zonedToUtc(local.year, local.month, local.day, h, m, tz);
      const delay = runAt - now;

      if (delay > 0 && delay < 24 * 60 * 60 * 1000) {
        const timer = setTimeout(async () => {
          try {
            await sendPrayerReminderToTelegram({ channel, chatId: targetChatId, city, country, method, prayerKey: key });
            lastRunAt = Date.now();
            lastError = null;
          } catch (e) {
            lastError = e.message;
            console.warn(`[PRAYER-TIMES] pengingat ${key} gagal:`, e.message);
          }
        }, delay);
        timers.push(timer);
        timer.unref?.();
      }
    }
  }

  async function sendNow(prayerKey) {
    if (!enabled) throw new MailError('Fitur waktu shalat dinonaktifkan (PRAYER_TIMES_ENABLED=false)', 'INVALID');
    if (!targetChatId) throw new MailError('Chat ID tujuan belum dikonfigurasi', 'INVALID');
    const data = lastData || await fetchPrayerTimes({ city, country, method });
    const text = formatPrayerReminder(data, { city, prayerKey });
    const result = await channel.send({ to: targetChatId, text });
    lastRunAt = Date.now();
    lastError = null;
    return { ok: true, chatId: targetChatId, city, prayerKey, result };
  }

  function start() {
    if (!enabled) return false;
    if (!targetChatId) {
      console.log('[PRAYER-TIMES] tidak dimulai: PRAYER_TIMES_CHAT_ID / TELEGRAM_AI_CHAT_IDS belum diisi');
      return false;
    }

    // Fetch and schedule immediately
    fetchAndSchedule().catch((e) => { lastError = e.message; console.warn('[PRAYER-TIMES] jadwal awal gagal:', e.message); });

    // Refetch every 24 hours to get next day's prayer times
    const refetchTimer = setInterval(async () => {
      try {
        await fetchAndSchedule();
      } catch (e) {
        lastError = e.message;
        console.warn('[PRAYER-TIMES] refetch jadwal harian gagal:', e.message);
      }
    }, 24 * 60 * 60 * 1000);
    refetchTimer.unref?.();
    timers.push(refetchTimer);

    return true;
  }

  function stop() {
    for (const t of timers) clearTimeout(t);
    timers = [];
    return true;
  }

  function status() {
    const nowId = new Date().toLocaleDateString('id-ID', {
      weekday: 'long',
      timeZone: tz,
    });
    const upcoming = [];
    if (lastData && lastData.timings) {
      const now = Date.now();
      const local = zonedParts(now, tz);
      for (const key of ORDER) {
        const timeStr = lastData.timings[key];
        const [h, m] = timeStr.split(':').map(Number);
        const runAt = zonedToUtc(local.year, local.month, local.day, h, m, tz);
        if (runAt > now) {
          upcoming.push({ prayer: PRAYER_LABELS_ID[key], time: timeStr, at: runAt });
        }
      }
    }
    return {
      enabled,
      configured: Boolean(channel && channel.configured),
      live: Boolean(channel && channel.mode === 'live'),
      city,
      country,
      method,
      weekday: nowId,
      chatId: targetChatId || null,
      running: timers.length > 0,
      lastRunAt,
      lastError,
      upcoming,
    };
  }

  return {
    start,
    stop,
    status,
    sendNow,
    fetchPrayerTimes: () => fetchPrayerTimes({ city, country, method }),
    formatMessage: (data) => formatPrayerTimesMessage(data, { city }),
    formatReminder: (data, prayerKey) => formatPrayerReminder(data, { city, prayerKey }),
  };
}
