/**
 * src/automation/prayer-times.js
 *
 * Jadwal waktu shalat untuk kota (default: Bekasi, Indonesia).
 * Mengambil data dari Aladhan API (gratis, tidak perlu API key) dan
 * mengirim ke Telegram melalui channel adapter yang sudah ada.
 *
 * Endpoint: https://api.aladhan.com/v1/timingsByCity?city=Bekasi&country=Indonesia&method=2
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { boolEnv, intEnv } from './channels/base.js';
import { MailError } from './mailer.js';

const DEFAULT_CITY = 'Bekasi';
const DEFAULT_COUNTRY = 'Indonesia';
const DEFAULT_METHOD = 2; // ISNA — umum digunakan di Indonesia

const PRAYER_LABELS_ID = {
  Fajr: 'Subuh',
  Dhuhr: 'Dzuhur',
  Asr: 'Ashar',
  Maghrib: 'Maghrib',
  Isha: 'Isya',
  Sunrise: 'Terbit',
  Sunset: 'Terbenam',
};

/** Aladhan hanya mengembalikan nama hari dalam bahasa Inggris; map ke Indonesia. */
const WEEKDAY_EN_TO_ID = {
  Sunday: 'Minggu',
  Monday: 'Senin',
  Tuesday: 'Selasa',
  Wednesday: 'Rabu',
  Thursday: 'Kamis',
  Friday: 'Jumat',
  Saturday: 'Sabtu',
};

const PRAYER_EMOJIS = {
  Fajr: '🌅',
  Dhuhr: '☀️',
  Asr: '🏟️',
  Maghrib: '🌇',
  Isha: '🌙',
  Sunrise: '🌄',
  Sunset: '🌆',
};

const ORDER = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

/** Apakah fitur waktu shalat diaktifkan via env. */
export function isPrayerTimesEnabled(env = process.env) {
  return boolEnv(env, 'PRAYER_TIMES_ENABLED', true);
}

/** Chat ID tujuan default: pakai PRAYER_TIMES_CHAT_ID, fallback ke TELEGRAM_AI_CHAT_IDS pertama. */
export function defaultChatId(env = process.env) {
  const explicit = String(env.PRAYER_TIMES_CHAT_ID || '').trim();
  if (explicit) return explicit;
  const first = String(env.TELEGRAM_AI_CHAT_IDS || '').split(',')[0]?.trim();
  return first || null;
}

/**
 * Ambil jadwal waktu shalat dari Aladhan API.
 * @param {{city?:string, country?:string, method?:number}} opts
 * @returns {Promise<{timings:object, date:object, meta:object}>}
 */
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
    throw new MailError(
      `Gagal menghubungi Aladhan API: ${err?.message || err}`,
      'TRANSIENT',
      { code: err?.cause?.code || 'ENETWORK' },
    );
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

/** Format jadwal waktu shalat menjadi pesan teks Bahasa Indonesia. */
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

  const lines = [];
  lines.push(`🕌 Jadwal Waktu Shalat — ${city}`);
  lines.push(
    `📅 ${weekdayId}, ${tanggal} ${bulan} ${tahun} / ${hijriDate} ${hijriMonth} ${hijriYear} H`,
  );
  lines.push('');
  for (const key of ORDER) {
    const waktu = timings[key];
    if (waktu) {
      lines.push(`${PRAYER_EMOJIS[key]} ${PRAYER_LABELS_ID[key]}: ${waktu}`);
    }
  }
  lines.push('');
  lines.push('Semoga khusyuk dan diterima. 🤲');
  return lines.join('\n');
}

/**
 * Kirim jadwal waktu shalat ke Telegram.
 * @param {{channel:object, chatId:string, city?:string, country?:string, method?:number}} opts
 * @returns {Promise<object>} hasil pengiriman channel
 */
export async function sendPrayerTimesToTelegram({
  channel,
  chatId,
  city = DEFAULT_CITY,
  country = DEFAULT_COUNTRY,
  method = DEFAULT_METHOD,
} = {}) {
  if (!channel) throw new MailError('Channel Telegram tidak tersedia', 'INVALID');
  if (channel.mode !== 'live') {
    throw new MailError('Telegram belum dikonfigurasi (mode simulasi). Isi TELEGRAM_BOT_TOKEN di .env.', 'INVALID');
  }
  if (!chatId) throw new MailError('Chat ID tujuan belum diisi. Set PRAYER_TIMES_CHAT_ID atau TELEGRAM_AI_CHAT_IDS di .env.', 'INVALID');

  const data = await fetchPrayerTimes({ city, country, method });
  const text = formatPrayerTimesMessage(data, { city });
  return channel.send({ to: chatId, text });
}

/**
 * Buat service waktu shalat yang bisa dijadwalkan.
 * @param {{channel:object, chatId?:string, env?:object, fetchImpl?:Function}} deps
 */
export function createPrayerTimesService({
  channel,
  chatId = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const city = String(env.PRAYER_TIMES_CITY || DEFAULT_CITY).trim();
  const country = String(env.PRAYER_TIMES_COUNTRY || DEFAULT_COUNTRY).trim();
  const method = intEnv(env, 'PRAYER_TIMES_METHOD', DEFAULT_METHOD, { min: 1, max: 11 });
  const schedule = String(env.PRAYER_TIMES_SCHEDULE || 'daily@04:00').trim();
  const targetChatId = chatId || defaultChatId(env);
  const enabled = boolEnv(env, 'PRAYER_TIMES_ENABLED', true);

  let timer = null;
  let lastRunAt = null;
  let lastError = null;
  let lastResult = null;

  async function sendNow() {
    if (!enabled) throw new MailError('Fitur waktu shalat dinonaktifkan (PRAYER_TIMES_ENABLED=false)', 'INVALID');
    if (!targetChatId) throw new MailError('Chat ID tujuan belum dikonfigurasi', 'INVALID');
    const data = await fetchPrayerTimes({ city, country, method });
    const text = formatPrayerTimesMessage(data, { city });
    const result = await channel.send({ to: targetChatId, text });
    lastRunAt = Date.now();
    lastError = null;
    lastResult = result;
    return { ok: true, chatId: targetChatId, city, result };
  }

  async function start() {
    if (timer) return false;
    if (!enabled) return false;
    if (!targetChatId) {
      console.log('[PRAYER-TIMES] tidak dimulai: PRAYER_TIMES_CHAT_ID / TELEGRAM_AI_CHAT_IDS belum diisi');
      return false;
    }
    // Jalankan segera saat start, lalu tiap menit cek apakah sudah waktunya.
    sendNow().catch((e) => { lastError = e.message; console.warn('[PRAYER-TIMES] kirim awal gagal:', e.message); });

    const { parseSchedule, nextRun } = await import('./cron.js');
    let parsed;
    try { parsed = parseSchedule(schedule); } catch (e) {
      console.warn('[PRAYER-TIMES] jadwal tidak valid ("' + schedule + '"), pakai daily@04:00:', e.message);
      parsed = parseSchedule('daily@04:00');
    }

    let lastDue = null; // epoch ms terakhir yang sudah terkirim, mencegah duplikasi
    timer = setInterval(async () => {
      try {
        const now = Date.now();
        // nextRun(afterMs) = waktu jadwal berikutnya yang LEBIH BESAR dari afterMs.
        // Pakai now - 1s agar jadwal yang tepat sekarang masih ikut terbaca.
        const due = nextRun(parsed, now - 1_000, env.AUTOMATION_TZ || 'Asia/Jakarta');
        // Kirim jika jadwal sudah tiba / akan tiba dalam 1 menit, dan belum pernah dikirim untuk jadwal ini.
        if (due && due <= now + 60_000 && (!lastDue || due > lastDue)) {
          await sendNow();
          lastDue = due;
        }
      } catch (e) {
        lastError = e.message;
        console.warn('[PRAYER-TIMES] jadwal gagal:', e.message);
      }
    }, 60_000);
    timer.unref?.();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    return true;
  }

  function status() {
    return {
      enabled,
      configured: Boolean(channel && channel.configured),
      live: Boolean(channel && channel.mode === 'live'),
      city,
      country,
      method,
      schedule,
      chatId: targetChatId || null,
      running: Boolean(timer),
      lastRunAt,
      lastError,
      lastResult: lastResult ? { messageId: lastResult.messageId, parts: lastResult.parts, dryRun: lastResult.dryRun } : null,
    };
  }

  return { start, stop, status, sendNow, fetchPrayerTimes: () => fetchPrayerTimes({ city, country, method }), formatMessage: (data) => formatPrayerTimesMessage(data, { city }) };
}
