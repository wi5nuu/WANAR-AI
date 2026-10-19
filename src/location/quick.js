/**
 * src/location/quick.js
 *
 * Deterministic answers for location questions on any chat surface — no model
 * call, no invented place. Everything here reads from the tracking service and
 * says exactly what it knows:
 *
 *   - "posisi saya di mana?"      → live vs last-known, age, accuracy, place
 *   - "hari ini ke mana saja?"    → today's trips & stops (GPS trajectory)
 *   - "berapa km hari ini?"       → GPS distance, explicitly not the odometer
 *   - "minggu ini ke mana?"       → 7-day summary
 *   - "tadi berhenti di mana?"    → last stop with its classification
 *   - "mulai/matikan pelacakan"   → session control (privacy switch is respected)
 *   - "daftar tempat"             → the saved places, from their own records
 *   - "di mana rumah?"            → a saved place by name (never guessed)
 *   - "simpan lokasi ini ..."     → named place from a shared pin, typed
 *                                   coordinates, or the last FRESH position
 *
 * quickLocationPin() handles the other half: a Telegram/WhatsApp location pin
 * is held in memory (never written) until the owner names it in a follow-up.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { formatDistance, formatSpeed, haversineM } from './geo.js';
import { KIND_LABELS } from './classify.js';
import { formatMinutes } from '../worklog/time.js';

const WHERE_ASK = /\b(di ?mana|dimana)\b|\b(posisi|lokasi)\b.*\b(saya|aku|sekarang|kini|skrg)\b|\b(saya|aku)\b.*\b(posisi|lokasi|berada)\b/i;
const TODAY_ASK = /\b(hari ini|sejak pagi|tadi)\b/i;
const WEEK_ASK = /\b(minggu ini|7 hari|tujuh hari|seminggu)\b/i;
const DISTANCE_ASK = /\b(berapa (jauh|km|kilometer)|jarak|menempuh|odometer)\b/i;
const LAST_STOP_ASK = /\b(terakhir|tadi)\b.*\b(berhenti|stop|mampir|singgah)\b|\b(berhenti|mampir|singgah)\b.*\b(terakhir|tadi)\b/i;
const TRACK_ON = /\b(mulai|nyalakan|aktifkan|hidupkan)\b.{0,20}\b(tracking|pelacakan|lacak|lokasi)\b/i;
const TRACK_OFF = /\b(matikan|hentikan|stop|nonaktifkan)\b.{0,20}\b(tracking|pelacakan|lacak)\b/i;
const TRACK_PAUSE = /\b(jeda|pause|tangguhkan)\b.{0,20}\b(tracking|pelacakan|lacak)\b/i;
const TRACK_RESUME = /\b(lanjut|resume)\b.{0,20}\b(tracking|pelacakan|lacak)\b/i;
const CORRECT_LAST = /\b(tempat|lokasi)\b.{0,20}\b(terakhir|tadi)\b.{0,10}\b(nama(nya)?|itu)\b\s*[:\-]?\s*(.+)$/i;
const ROUTE_ASK = /\b(rute|perjalanan|jalan-jalan)\b/i;
// Places. SAVE requires a save verb AND (tempat|lokasi) or "sebagai", so
// "catat servis ini" or "tambahkan bensin" can never be mistaken for a place.
const PLACE_SAVE = /\b(simpan|tambahkan|tambah|catat)\b[^\n]{0,60}\b(tempat|lokasi)\b|\b(simpan|tambahkan|tambah)\b[^\n]{0,40}\bsebagai\b/i;
const PLACE_LIST = /\b(daftar|lihat|tampilkan|list|semua)\b[^\n]{0,30}\btempat\b|\btempat\b[^\n]{0,20}\b(apa saja|tersimpan)\b/i;
const PLACE_ASK = /\b(di ?mana|dimana|lokasi|posisi|alamat)\b/i;
const PLACE_HINT = /\b(rumah sakit|rumah|kantor|kos(?:an)?|kost|warung|toko|bengkel|spbu|pom bensin|sekolah|kampus|masjid|musholla|mushola|apotek|pasar|mall|mal|kafe|resto|warkop|gym|klinik)\b/i;
const SAVE_AS = /\b(?:sebagai|dengan nama|namanya|nama)\s+(.+)$/i;
// "posisi saya", "di mana saya sekarang": these ask for the live position, not
// for a place that merely shares a word.
const SELF_ASK = /\b(sekarang|kini|saat ini)\b|\bposisi\s+(saya|aku)\b|\b(di ?mana|dimana)\s{0,2}(saya|aku)\b|\blokasi\s+(saya|aku)\b/i;
// Saving needs a location reference: typed coordinates, the pin this chat just
// shared, or an anaphor ("lokasi ini", "saat ini"). Without one, messages like
// "catat tempat parkir lantai 3" stay with the personal-memory intents.
const PLACE_ANAPHOR = /\b(ini|saat ini|sekarang|di sini|tersebut|itu)\b/i;
const PLACE_FRESH_MS = 15 * 60_000; // "simpan lokasi saat ini" only trusts a fix this recent

const kindLabel = (kind) => KIND_LABELS[kind] || kind || 'belum teridentifikasi';
const timeOf = (ts) => new Date(ts).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
const visitTime = (ts) => new Date(ts).toLocaleString('id-ID', {
  timeZone: 'Asia/Jakarta', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

/**
 * @param {object} location  the location service
 * @param {string} text      the owner's message
 * @param {{chatId?:string|null}} [opts]  chat id, so "simpan lokasi ini" can find
 *   the pin that chat shared a moment ago
 * @returns {string|null}    reply, or null when the message is not about location
 */
export function quickLocation(location, text, { chatId = null } = {}) {
  if (!location) return null;
  const t = String(text || '').trim();
  if (!t || t.length > 280) return null;

  // ------------------------------------------------------------ tracking on/off
  if (TRACK_ON.test(t) && !/\bkenapa|apakah|kalau\b/i.test(t)) {
    try {
      const s = location.startSession({ label: 'dinyalakan lewat chat' });
      const st = location.currentStatus();
      return [
        `✓ Pelacakan lokasi menyala (sesi ${s.id}).`,
        st.position
          ? `Titik terakhir yang tersimpan: ${st.position.lat.toFixed(5)}, ${st.position.lon.toFixed(5)} (${st.position.label}).`
          : 'Belum ada titik lokasi masuk — pastikan aplikasi pelacak di HP mengirim data.',
        'Ingat: yang merekam GPS adalah HP (aplikasi/browser pelacak). Server hanya menyimpan dan mengolah kiriman itu.',
      ].join('\n');
    } catch (e) {
      return `✗ ${e.message}`;
    }
  }
  if (TRACK_OFF.test(t)) {
    try {
      location.stopSession(null, { reason: 'dimatikan lewat chat' });
      return '✓ Pelacakan lokasi dimatikan. Tidak ada titik baru yang akan disimpan sampai dinyalakan lagi.';
    } catch (e) {
      return `✗ ${e.message}`;
    }
  }
  if (TRACK_PAUSE.test(t)) {
    try {
      location.pauseSession();
      return '✓ Pelacakan dijeda. Data yang sudah ada tetap tersimpan; kirim "lanjut pelacakan" untuk meneruskan.';
    } catch (e) {
      return `✗ ${e.message}`;
    }
  }
  if (TRACK_RESUME.test(t)) {
    try {
      location.resumeSession();
      return '✓ Pelacakan dilanjutkan.';
    } catch (e) {
      return `✗ ${e.message}`;
    }
  }

  // ------------------------------------------------------------------- places
  // "daftar tempat" / "tempat tersimpan": the saved list, straight from the DB.
  if (PLACE_LIST.test(t)) return listPlacesText(location);

  // "simpan lokasi ini sebagai Rumah" / "tambahkan lokasi -6.24, 106.97 sebagai Warung"
  // Runs BEFORE the "where is X" branch: "simpan lokasi ..." contains "lokasi"
  // too, and saving is the more specific intent.
  // Source of truth, in order: coordinates typed in this message, the pin this
  // chat shared (held in memory), or the last position if it is truly fresh.
  // "tempat terakhir namanya X" keeps its own older flow below.
  if (PLACE_SAVE.test(t) && !CORRECT_LAST.test(t)) {
    const nameMatch = SAVE_AS.exec(t);
    let name = nameMatch ? cleanPlaceName(nameMatch[1]) : '';
    const coords = parseCoords(t);
    const pin = chatId ? location.pendingPin(chatId) : null;
    if (!name && pin?.name) name = cleanPlaceName(pin.name);

    let target = null;
    let origin = '';
    if (coords) {
      target = coords;
      origin = 'dari koordinat di pesan ini';
    } else if (pin) {
      target = { lat: pin.lat, lon: pin.lon };
      origin = 'dari lokasi yang Anda bagikan tadi';
    } else if (PLACE_ANAPHOR.test(t)) {
      const st = location.currentStatus();
      if (st.position && Number.isFinite(st.position.ageMs) && st.position.ageMs <= PLACE_FRESH_MS) {
        target = { lat: st.position.lat, lon: st.position.lon };
        const min = Math.round(st.position.ageMs / 60000);
        origin = `dari posisi terakhir (${min < 1 ? 'kurang dari semenit' : `${min} menit`} lalu)`;
      }
    }
    if (!target) {
      if (!PLACE_ANAPHOR.test(t) && !coords) return null; // not a place request after all
      return 'Belum ada lokasi yang bisa disimpan dari pesan ini. Cara menyimpan:\n1) Bagikan lokasi (pin) di Telegram/WhatsApp, lalu balas: simpan lokasi ini sebagai Rumah\n2) Tulis koordinatnya: simpan lokasi -6.2383, 106.9756 sebagai Rumah\n3) Nyalakan pelacakan di HP, lalu: simpan lokasi saat ini sebagai Rumah';
    }
    if (!name) {
      return 'Namanya apa? Balas: simpan lokasi ini sebagai <nama> — misalnya "Rumah", "Kantor", atau "Bengkel langganan".';
    }
    try {
      const place = location.addPlace({
        name,
        kind: guessPlaceKind(name),
        lat: target.lat,
        lon: target.lon,
        radiusM: 120,
        source: 'user',
        note: 'dibuat dari chat pemilik',
      });
      if (pin && !coords) location.clearPendingPin(chatId);
      return [
        `✓ Tersimpan: "${place.name}" — ${Number(place.lat).toFixed(5)}, ${Number(place.lon).toFixed(5)} (radius ${place.radius_m} m, kategori: ${kindLabel(place.kind)}), ${origin}.`,
        `Kunjungan ke area ini mulai sekarang dikenali sebagai "${place.name}".`,
        'Ubah nama/radius atau hapus: dasbor Pelacakan → tab Tempat.',
      ].join('\n');
    } catch (e) {
      return e?.code === 'exists'
        ? `ℹ️ ${e.message} Ketik "daftar tempat" untuk melihat semuanya, atau ubah/hapus di dasbor Pelacakan → tab Tempat.`
        : `✗ ${e.message}`;
    }
  }

  // "berapa jauh dari rumah?" / "jarak rumah ke kantor?" — a straight-line
  // distance read from stored data: from the last known fix, or between two
  // saved places. Never estimated, never invented.
  if (DISTANCE_ASK.test(t) && !TODAY_ASK.test(t)) {
    const named = findSavedPlaces(location, t);
    if (named.length >= 2) {
      // Present them in the order the owner wrote them: "jarak rumah ke kantor"
      // reads "Rumah → Kantor", not whatever the name-length sort produced.
      const lt = t.toLowerCase();
      const posOf = (p) => {
        const direct = lt.indexOf(String(p.name).toLowerCase());
        if (direct >= 0) return direct;
        return (p.aliases || []).reduce((best, a) => {
          const i = lt.indexOf(String(a).toLowerCase());
          return i >= 0 && i < best ? i : best;
        }, Infinity);
      };
      const [a, b] = named.slice(0, 2).sort((x, y) => posOf(x) - posOf(y));
      const d = haversineM(a.lat, a.lon, b.lat, b.lon);
      return `📏 Jarak "${a.name}" → "${b.name}": ${formatDistance(d)} (garis lurus, bukan jarak tempuh jalan).`;
    }
    if (named.length === 1) {
      const place = named[0];
      const st = location.currentStatus();
      if (!st.position) {
        return `Belum ada posisi tersimpan, jadi jarak ke "${place.name}" belum bisa dihitung. Nyalakan pelacakan di HP (halaman /track) lebih dulu.`;
      }
      const d = haversineM(st.position.lat, st.position.lon, place.lat, place.lon);
      const ageStr = st.position.ageMs < 60_000 ? 'kurang dari semenit lalu' : `${Math.round(st.position.ageMs / 60000)} menit lalu`;
      return [
        `📏 Jarak ke "${place.name}" (${kindLabel(place.kind)}): ${formatDistance(d)} — ${st.position.fresh ? 'dari posisi terkini' : `dari lokasi terakhir yang diketahui (${ageStr}, bukan live)`}.`,
        d <= place.radius_m
          ? `Anda berada DI DALAM area "${place.name}" (radius ${place.radius_m} m).`
          : `Anda di luar area "${place.name}" (±${Math.round(d - place.radius_m)} m dari batas area, radius ${place.radius_m} m).`,
      ].join('\n');
    }
  }

  // "di mana rumah?" — answered from the saved place's own record. A name that
  // is not saved is said so, with the exact way to save it. Never guessed.
  if (PLACE_ASK.test(t) && !SELF_ASK.test(t)) {
    const place = findSavedPlace(location, t);
    if (place) {
      const lines = [
        `📍 ${place.name} — ${Number(place.lat).toFixed(5)}, ${Number(place.lon).toFixed(5)} (±${place.radius_m} m)${place.kind && place.kind !== 'unknown' ? `, kategori: ${kindLabel(place.kind)}` : ''}.`,
      ];
      lines.push(place.last_visit_at
        ? `Terakhir dikunjungi: ${visitTime(place.last_visit_at)} WIB (${place.visits}× tercatat).`
        : 'Belum pernah tercatat dikunjungi sejak disimpan.');
      return lines.join('\n');
    }
    const hint = PLACE_HINT.exec(t);
    if (hint) {
      return `Belum ada tempat bernama "${hint[1]}" yang tersimpan. Cara menyimpannya: bagikan lokasi (pin) di Telegram/WhatsApp lalu balas "simpan lokasi ini sebagai ${hint[1]}", tulis koordinatnya ("simpan lokasi -6.2383, 106.9756 sebagai ${hint[1]}"), atau isi di dasbor Pelacakan → tab Tempat.`;
    }
  }

  // ------------------------------------------------------------------- position
  if (WHERE_ASK.test(t)) {
    const st = location.currentStatus();
    if (!st.position) {
      return 'Belum ada data lokasi sama sekali. Nyalakan pelacakan di HP (halaman Pelacakan → Pelacak) supaya saya bisa menjawab.';
    }
    const ageMin = Math.round(st.position.ageMs / 60000);
    const ageStr = ageMin < 1 ? 'kurang dari semenit lalu' : `${ageMin} menit lalu`;
    const lines = [
      st.position.fresh
        ? `Posisi terkini: ${st.position.lat.toFixed(5)}, ${st.position.lon.toFixed(5)} (±${st.position.accuracy != null ? `${Math.round(st.position.accuracy)} m` : 'akurasi tidak dilaporkan'}).`
        : `Lokasi terakhir yang diketahui (bukan live): ${st.position.lat.toFixed(5)}, ${st.position.lon.toFixed(5)}, terakhir terlihat ${ageStr}.`,
    ];
    if (st.place) lines.push(`Di dalam area yang Anda beri nama "${st.place.label}".`);
    const near = Array.isArray(st.places) ? st.places.slice(0, 3) : [];
    if (near.length) lines.push(`Jarak: ${near.map((p) => `${p.name} ${formatDistance(p.distanceM)}${p.inside ? ' (di dalam area)' : ''}`).join(' · ')}.`);
    if (st.movement?.state === 'moving') lines.push(`Sedang bergerak${Number.isFinite(st.position.speedMps) && st.position.speedMps > 0.5 ? ` sekitar ${formatSpeed(st.position.speedMps)}` : ''}.`);
    else if (st.movement?.state === 'stopped') lines.push('Perangkat tampak sedang berhenti.');
    if (st.position.battery != null) lines.push(`Baterai HP pelacak: ${Math.round(st.position.battery)}%.`);
    lines.push(`Hari ini: ${formatDistance(st.today.distanceM)} jarak lintasan GPS dari ${st.today.trips} perjalanan (bukan angka odometer).`);
    return lines.join(' ');
  }

  // --------------------------------------------------------------------- today
  if (TODAY_ASK.test(t) && (DISTANCE_ASK.test(t) || ROUTE_ASK.test(t) || /\bke ?mana\b|\bsaya ke\b/i.test(t))) {
    const d = location.daySummary();
    if (!d.trips.length && !d.stops.length) {
      return `Hari ini belum ada perjalanan tercatat. ${d.dataQuality.note}`;
    }
    const lines = [`Hari ini (jarak lintasan GPS, bukan odometer): ${formatDistance(d.distanceM)}, ${d.trips.length} perjalanan, bergerak ${formatMinutes(Math.round(d.movingS / 60))}.`];
    const items = d.timeline.slice(0, 12).map((x) => {
      if (x.kind === 'trip') return `• ${timeOf(x.at)}–${x.endAt ? timeOf(x.endAt) : '…'} perjalanan ${formatDistance(x.distanceM || 0)}`;
      return `• ${timeOf(x.at)} ${x.label}${x.unknown ? ' (belum teridentifikasi, tidak dikarang)' : ''} ${Math.round((x.durationMs || 0) / 60000)} menit`;
    });
    lines.push(...items);
    if (d.timeline.length > 12) lines.push(`… dan ${d.timeline.length - 12} catatan lain di halaman Pelacakan.`);
    lines.push(d.dataQuality.note);
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------- week
  if (WEEK_ASK.test(t) && (DISTANCE_ASK.test(t) || ROUTE_ASK.test(t) || /\bke ?mana\b/i.test(t))) {
    const now = new Date();
    const iso = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
    const to = iso(now.getTime());
    const from = iso(now.getTime() - 6 * 86_400_000);
    const r = location.rangeSummary(from, to);
    if (!r.days.length) return 'Belum ada data perjalanan dalam 7 hari terakhir.';
    const lines = r.days.map((d) => `• ${d.date}: ${formatDistance(d.distanceM)}, ${d.trips} perjalanan, ${d.stops} kunjungan`);
    lines.push(`Total: ${formatDistance(r.totalDistanceM)} lintasan GPS dalam ${r.days.length} hari aktif (bukan odometer).`);
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ last stop
  if (LAST_STOP_ASK.test(t)) {
    const w = location.whereWasI();
    const last = w.stops[w.stops.length - 1];
    if (!last) return 'Belum ada catatan berhenti hari ini.';
    return [
      `Terakhir berhenti: ${last.label || (last.kind === 'unknown' ? 'lokasi yang belum teridentifikasi' : kindLabel(last.kind))}`,
      `pukul ${last.arrival}${last.departure ? `–${last.departure}` : ' (masih di sana)'}, ${last.durationMin} menit, keyakinan ${Math.round((last.confidence || 0) * 100)}%.`,
      last.kind === 'unknown' ? 'Saya tidak mengarang nama tempat; kirim "tempat terakhir namanya X" untuk memberi nama.' : '',
    ].filter(Boolean).join(' ');
  }

  // --------------------------------------------------------------- correction
  const m = CORRECT_LAST.exec(t);
  if (m && m[4]) {
    const w = location.whereWasI();
    const lastStop = w.stops[w.stops.length - 1];
    if (!lastStop) return 'Belum ada catatan tempat yang bisa saya beri nama.';
    try {
      const name = m[4].trim().replace(/[.?!]+$/, '');
      location.correctStop(lastStop.id, { label: name, savePlace: true, radiusM: 120, note: 'diberi nama lewat chat' });
      return `✓ Tempat terakhir saya catat sebagai "${name}" dan sekaligus dibuatkan geofence — kunjungan berikutnya ke area itu akan langsung dikenali.`;
    } catch (e) {
      return `✗ ${e.message}`;
    }
  }

  return null;
}

// -------------------------------------------------------------- place helpers

/**
 * "daftar tempat" in chat and the /tempat Telegram command share this listing.
 * Everything comes from the places table; nothing is suggested or invented.
 */
export function listPlacesText(location, filter = null) {
  const all = location?.store?.places?.list?.() || [];
  const f = String(filter || '').trim().toLowerCase();
  if (!all.length) {
    return 'Belum ada tempat tersimpan. Bagikan lokasi (pin) di Telegram/WhatsApp lalu balas "simpan lokasi ini sebagai Rumah", atau isi di dasbor Pelacakan → tab Tempat.';
  }
  const places = f
    ? all.filter((p) => p.name.toLowerCase().includes(f) || (p.aliases || []).some((a) => String(a).toLowerCase().includes(f)))
    : all;
  if (!places.length) return `Tidak ada tempat yang cocok dengan "${filter}". Ketik "daftar tempat" untuk melihat semuanya.`;
  const lines = places.slice(0, 15).map((p) => `• ${p.name} — ${Number(p.lat).toFixed(5)}, ${Number(p.lon).toFixed(5)} (±${p.radius_m} m)${p.kind && p.kind !== 'unknown' ? ` · ${kindLabel(p.kind)}` : ''}`);
  if (places.length > 15) lines.push(`… dan ${places.length - 15} lainnya di dasbor Pelacakan.`);
  return [`Tempat tersimpan (${places.length}):`, ...lines].join('\n');
}

/**
 * A location pin shared in a private owner chat. Held in memory, never written
 * unnamed; the owner is told exactly how to name it in the same chat.
 * @returns {string|null} reply text, or null when the pin itself is unusable
 */
export function quickLocationPin(location, { chatId, lat, lon, title = null } = {}) {
  if (!location || !chatId) return null;
  try {
    location.setPendingPin(chatId, { lat, lon, name: title, from: 'chat' });
  } catch (e) {
    return `✗ ${e.message}`;
  }
  const la = Number(lat);
  const lo = Number(lon);
  const lines = [`📍 Lokasi diterima: ${la.toFixed(5)}, ${lo.toFixed(5)}${title ? ` — "${String(title).slice(0, 60)}"` : ''}.`];
  lines.push(title
    ? 'Balas "simpan lokasi ini" untuk memakai nama itu, atau "simpan lokasi ini sebagai <nama lain>".'
    : 'Balas: simpan lokasi ini sebagai <nama> — misalnya Rumah, Kantor, atau Bengkel langganan.');
  return lines.join('\n');
}

/** The saved place whose name (or alias) appears in the message; null otherwise. */
function findSavedPlace(location, text) {
  return findSavedPlaces(location, text)[0] || null;
}

/** Every saved place whose name (or alias) appears in the message, longest name first, unique. */
function findSavedPlaces(location, text) {
  try {
    const t = String(text || '').toLowerCase();
    const places = (location?.store?.places?.list?.() || [])
      .slice()
      .sort((a, b) => String(b.name).length - String(a.name).length);
    const out = [];
    for (const p of places) {
      const hit = (p.name.length >= 3 && t.includes(p.name.toLowerCase()))
        || (p.aliases || []).some((a) => String(a).length >= 3 && t.includes(String(a).toLowerCase()));
      if (hit && !out.some((x) => x.id === p.id)) out.push(p);
    }
    return out;
  } catch {
    return [];
  }
}

/** "-6.2383, 106.9756" (or space-separated) in the owner's own message. */
function parseCoords(text) {
  const m = /(-?\d{1,2}\.\d{3,7})(?:\s*[,;]\s*|\s+)(-?\d{1,3}\.\d{3,7})/.exec(String(text || ''));
  if (!m) return null;
  let lat = Number(m[1]);
  let lon = Number(m[2]);
  // Indonesia sits at negative latitude / ~95–141 longitude: if the pair is the
  // other way around, swap it instead of refusing.
  if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) {
    const swap = lat; lat = lon; lon = swap;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** A tidy place name: no quotes, no "saat ini" leftovers, single spaces, capped. */
function cleanPlaceName(s) {
  return String(s || '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/^(saat ini|sekarang|di sini|ini)\s+/i, '')
    .replace(/\s+(saat ini|sekarang|di sini)$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:]+$/, '')
    .trim()
    .slice(0, 60);
}

/** Kategori is a convenience guess from the name — always editable in the dashboard. */
const KIND_HINTS = [
  [/\b(rumah|home)\b/i, 'home'],
  [/\b(kantor|kost|kosan|kos|kerja)\b/i, 'office'],
  [/\b(toko|grosir|swalayan|ritel)\b/i, 'shop'],
  [/\b(bengkel|workshop|servis)\b/i, 'workshop'],
  [/\b(spbu|pom bensin|pertamina|shell|bensin)\b/i, 'fuel'],
  [/\b(warung|makan|resto|kafe|kopi|warkop|bakso|mie|sate|nasi|ayam)\b/i, 'food'],
  [/\b(mall|mal|plaza)\b/i, 'mall'],
  [/\b(minimarket|alfamart|indomaret)\b/i, 'minimarket'],
  [/\b(kampus|sekolah|kuliah)\b/i, 'campus'],
  [/\b(masjid|musholla|mushola|gereja|pura|vihara)\b/i, 'worship'],
  [/\b(apotek)\b/i, 'pharmacy'],
  [/\b(bank|atm)\b/i, 'bank'],
  [/\b(klinik|rumah sakit|puskesmas)\b/i, 'clinic'],
  [/\b(parkir)\b/i, 'parking'],
  [/\b(laundry|binatu)\b/i, 'laundry'],
];
const guessPlaceKind = (name) => (KIND_HINTS.find(([re]) => re.test(name)) || [null, 'public'])[1];
