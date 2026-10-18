/**
 * src/emergency/detect.js
 *
 * Risk scoring for a possible crash. Pure function, deterministic, no AI: a
 * safety path that depends on a model being online is not a safety path.
 *
 * What this CAN observe, and nothing more:
 *   - the GPS/speed stream (sudden deceleration, then stillness)
 *   - the phone's accelerometer/gyroscope, IF the device sends it
 *   - how long the device stays motionless afterwards
 *   - where it stopped (a known place makes a crash unlikely)
 *
 * What it cannot do is stated in the output, not hidden: without accelerometer
 * data there is no impact signal, and the score is capped at "watch" — the
 * system may then ask the owner, but it will never claim a crash happened.
 * A phone in a pocket, a bag or on the handlebar changes sensor quality; that
 * uncertainty is part of the reported confidence.
 *
 * @author Wisnu Alfian Nur Ashar
 */

const clamp01 = (n) => Math.max(0, Math.min(1, n));

export const SENSITIVITY_PRESETS = {
  low: { minSpeedBeforeMps: 8.5, speedDropRatio: 0.85, impactG: 4.0, rotationDps: 400, stillnessMs: 90_000, threshold: 0.7 },
  medium: { minSpeedBeforeMps: 7.0, speedDropRatio: 0.75, impactG: 3.0, rotationDps: 300, stillnessMs: 60_000, threshold: 0.55 },
  high: { minSpeedBeforeMps: 5.5, speedDropRatio: 0.65, impactG: 2.4, rotationDps: 220, stillnessMs: 45_000, threshold: 0.45 },
};

export const DEFAULT_DETECT = Object.freeze({
  sensitivity: 'medium',
  ...SENSITIVITY_PRESETS.medium,
  cooldownMs: 10 * 60_000,     // never raise two events for one incident
  windowMs: 2 * 60_000,        // how far back the speed stream is inspected
  maxGapMs: 30_000,            // a data gap this big weakens any conclusion
});

/** Magnitude of a DeviceMotion sample, in g (accelerationIncludingGravity ≈ 1 at rest). */
export function motionMagnitude(m) {
  const a = m?.acceleration || m?.accelerationIncludingGravity;
  if (!a) return null;
  const { x = 0, y = 0, z = 0 } = a;
  const v = Math.sqrt((x || 0) ** 2 + (y || 0) ** 2 + (z || 0) ** 2);
  return Number.isFinite(v) ? v : null;
}

/** Rotation rate magnitude in deg/s from a DeviceMotion rotationRate sample. */
export function rotationMagnitude(m) {
  const r = m?.rotationRate;
  if (!r) return null;
  const { alpha = 0, beta = 0, gamma = 0 } = r;
  const v = Math.sqrt((alpha || 0) ** 2 + (beta || 0) ** 2 + (gamma || 0) ** 2);
  return Number.isFinite(v) ? v : null;
}

/** Peak impact magnitude in a window of motion events. */
export function peakImpact(motionEvents = [], windowMs = 20_000, now = Date.now()) {
  let peak = null;
  let at = null;
  for (const e of motionEvents) {
    if (!e || !Number.isFinite(e.ts) || now - e.ts > windowMs) continue;
    const mag = Number.isFinite(e.mag) ? e.mag : motionMagnitude(e);
    if (mag == null) continue;
    if (peak == null || mag > peak) { peak = mag; at = e.ts; }
  }
  return { peak, at };
}

export function peakRotation(motionEvents = [], windowMs = 20_000, now = Date.now()) {
  let peak = null;
  let at = null;
  for (const e of motionEvents) {
    if (!e || !Number.isFinite(e.ts) || now - e.ts > windowMs) continue;
    const r = Number.isFinite(e.rot) ? e.rot : rotationMagnitude(e);
    if (r == null) continue;
    if (peak == null || r > peak) { peak = r; at = e.ts; }
  }
  return { peak, at };
}

/**
 * Scores one moment in time.
 *
 * @param {object} input
 * @param {Array}  input.samples     recent fixes, oldest first: {ts, lat, lon, accuracy, speed}
 * @param {Array}  [input.motion]    device motion events: {ts, mag, rot}
 * @param {number} [input.sensorAgeMs]  how long ago the last sensor sample arrived (null = never)
 * @param {object} [input.place]     {kind, label, confidence} if the current point is a known place
 * @param {number} [input.stillnessMs] how long the device has not moved (per GPS)
 * @param {object} [config]
 * @returns {{score:number, level:'none'|'watch'|'suspected'|'high', signals:Array, guards:Array, sensorAvailable:boolean, confidence:number, summary:string}}
 */
export function scoreRisk(input = {}, config = {}) {
  const cfg = { ...DEFAULT_DETECT, ...(config.detect || config || {}) };
  if (config.sensitivity && SENSITIVITY_PRESETS[config.sensitivity]) {
    Object.assign(cfg, SENSITIVITY_PRESETS[config.sensitivity]);
  }
  const now = Number(config.now || input.now || Date.now());
  const samples = (Array.isArray(input.samples) ? input.samples : [])
    .filter((s) => Number.isFinite(s?.ts) && Number.isFinite(s?.lat))
    .sort((a, b) => a.ts - b.ts);
  const motion = Array.isArray(input.motion) ? input.motion : [];

  const signals = [];
  const guards = [];

  const sensorAgeMs = Number.isFinite(input.sensorAgeMs) ? input.sensorAgeMs : null;
  const sensorAvailable = sensorAgeMs != null && sensorAgeMs <= 60_000;

  // ---- speed context -------------------------------------------------------
  const window = samples.filter((s) => now - s.ts <= cfg.windowMs);
  if (window.length < 2) {
    return {
      score: 0,
      level: 'none',
      signals,
      guards: ['data GPS belum cukup untuk menilai anomali'],
      sensorAvailable,
      confidence: 0.2,
      summary: 'Data lokasi belum cukup untuk menilai gerak.',
    };
  }

  const speeds = window
    .map((s, i) => {
      if (Number.isFinite(s.speed)) return { ts: s.ts, v: s.speed };
      const prev = window[i - 1];
      if (!prev) return null;
      const dt = (s.ts - prev.ts) / 1000;
      if (!(dt > 0)) return null;
      const R = 6371008.8;
      const rad = (d) => (d * Math.PI) / 180;
      const dLat = rad(s.lat - prev.lat);
      const dLon = rad(s.lon - prev.lon);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(prev.lat)) * Math.cos(rad(s.lat)) * Math.sin(dLon / 2) ** 2;
      const d = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
      return { ts: s.ts, v: d / dt };
    })
    .filter(Boolean);
  if (speeds.length < 2) {
    return {
      score: 0,
      level: 'none',
      signals,
      guards: ['kecepatan tidak dapat dihitung dari titik yang tersedia'],
      sensorAvailable,
      confidence: 0.25,
      summary: 'Kecepatan tidak dapat dihitung.',
    };
  }

  // Largest gap in the stream (a phone that went offline cannot be judged).
  let maxGap = 0;
  for (let i = 1; i < window.length; i++) maxGap = Math.max(maxGap, window[i].ts - window[i - 1].ts);
  if (maxGap > cfg.maxGapMs) guards.push(`ada jeda data ${Math.round(maxGap / 1000)} detik di dalam jendela pengamatan`);

  const before = Math.max(...speeds.map((s) => s.v));
  const last = speeds[speeds.length - 1];
  const after = last.v;
  const dropRatio = before > 0 ? (before - after) / before : 0;
  const dropMs = last.ts - speeds.find((s) => s.v >= before * 0.9)?.ts || 0;

  if (before < cfg.minSpeedBeforeMps) {
    guards.push(`kecepatan sebelum kejadian hanya ${(before * 3.6).toFixed(1)} km/jam — berhenti pelan bukan ciri kecelakaan`);
  } else if (dropRatio >= cfg.speedDropRatio) {
    const sudden = dropMs <= 12_000;
    signals.push({
      name: sudden ? 'sudden_deceleration' : 'gradual_deceleration',
      weight: sudden ? 0.34 : 0.12,
      detail: `kecepatan turun dari ${(before * 3.6).toFixed(0)} ke ${(after * 3.6).toFixed(0)} km/jam dalam ${(dropMs / 1000).toFixed(1)} detik`,
    });
    if (!sudden) guards.push('penurunan kecepatan bertahap — ciri pengereman biasa');
  } else if (dropRatio > 0.35) {
    guards.push('kecepatan turun sebagian — belum termasuk pengereman darurat');
  }

  // ---- impact & rotation (only with real sensor data) ----------------------
  const impact = peakImpact(motion, 20_000, now);
  if (impact.peak != null && impact.peak >= cfg.impactG) {
    signals.push({
      name: 'impact',
      weight: impact.peak >= 5 ? 0.5 : 0.4,
      detail: `benturan terdeteksi dari akselerometer: ${impact.peak.toFixed(2)} g (ambang ${cfg.impactG} g)`,
    });
  } else if (impact.peak != null && impact.peak >= cfg.impactG * 0.75) {
    signals.push({ name: 'impact_borderline', weight: 0.18, detail: `getaran kuat ${impact.peak.toFixed(2)} g` });
  }
  const rot = peakRotation(motion, 20_000, now);
  if (rot.peak != null && rot.peak >= cfg.rotationDps) {
    signals.push({ name: 'abrupt_rotation', weight: 0.16, detail: `perubahan orientasi cepat ${Math.round(rot.peak)} °/s` });
  }

  // ---- stillness after the anomaly ----------------------------------------
  const stillness = Number.isFinite(input.stillnessMs) ? input.stillnessMs : 0;
  if (stillness >= cfg.stillnessMs && (signals.length > 0)) {
    signals.push({ name: 'post_event_stillness', weight: 0.22, detail: `perangkat diam ${Math.round(stillness / 60000)} menit setelah anomali` });
  }

  // ---- place guard ---------------------------------------------------------
  const place = input.place;
  if (place && place.kind && place.kind !== 'unknown' && (place.confidence ?? 0) >= 0.5) {
    const safeKinds = new Set(['home', 'fuel', 'parking', 'office', 'mall', 'minimarket', 'food', 'workshop', 'campus']);
    if (safeKinds.has(place.kind)) {
      guards.push(`berhenti di lokasi yang dikenal (${place.label || place.kind}) — kemungkinan besar parkir atau berhenti normal`);
    }
  }

  // ---- score ---------------------------------------------------------------
  let score = clamp01(signals.reduce((a, s) => a + s.weight, 0));
  const independent = signals.filter((s) => s.name !== 'impact_borderline').length;
  if (guards.some((g) => g.includes('jeda data'))) score *= 0.7;
  if (guards.some((g) => g.startsWith('kecepatan sebelum'))) score = Math.min(score, 0.25);
  if (guards.some((g) => g.startsWith('berhenti di lokasi yang dikenal'))) score *= 0.5;
  if (!sensorAvailable) {
    // Honest cap: without a live sensor feed this is at most "worth asking about".
    score = Math.min(score, 0.45);
    guards.push('tidak ada data akselerometer/giroskop dari perangkat — deteksi benturan tidak dapat dilakukan, hanya pola gerak GPS');
  }
  if (independent < 2) {
    score = Math.min(score, 0.42);
    if (signals.length > 0) guards.push('hanya satu sinyal terdeteksi — belum cukup untuk menyimpulkan kecelakaan');
  }

  const level = score >= 0.7 ? 'high' : score >= cfg.threshold ? 'suspected' : score >= 0.3 ? 'watch' : 'none';
  const confidence = clamp01(
    (sensorAvailable ? 0.5 : 0.25) +
    Math.min(0.3, independent * 0.15) +
    (maxGap <= cfg.maxGapMs ? 0.2 : 0)
  );

  const summary = level === 'none'
    ? 'Tidak ada indikasi anomali gerak.'
    : level === 'watch'
      ? 'Ada perubahan gerak yang tidak biasa, risikonya rendah.'
      : level === 'suspected'
        ? 'Ada indikasi anomali gerak yang perlu dikonfirmasi ke pemilik perangkat. Bukan berarti kecelakaan sudah terjadi.'
        : 'Beberapa sinyal anomali kuat terdeteksi bersamaan. Perlu konfirmasi segera; ini belum terkonfirmasi sebagai kecelakaan.';

  return { score: Number(score.toFixed(3)), level, signals, guards, sensorAvailable, confidence: Number(confidence.toFixed(2)), summary };
}

/**
 * Default escalation message, exactly as agreed with the owner, with the map
 * link and the honest distinction between "current" and "last known".
 */
export function buildEmergencyMessage({ ownerName = 'Wisnu', location = null, event = null, baseUrl = null, callName = null } = {}) {
  const when = new Date(event?.ts || Date.now());
  const stamp = when.toLocaleString('id-ID', { timeZone: process.env.WORKLOG_TZ || 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'medium' });
  const ageMs = location?.ts ? Date.now() - location.ts : null;
  const isStale = ageMs != null && ageMs > 3 * 60_000;
  const acc = Number.isFinite(location?.accuracy) ? `±${Math.round(location.accuracy)} m` : 'tidak dilaporkan perangkat';
  const coords = Number.isFinite(location?.lat) && Number.isFinite(location?.lon)
    ? `${location.lat.toFixed(5)}, ${location.lon.toFixed(5)}`
    : 'tidak tersedia';
  const mapLink = Number.isFinite(location?.lat) && Number.isFinite(location?.lon)
    ? `https://www.openstreetmap.org/?mlat=${location.lat.toFixed(6)}&mlon=${location.lon.toFixed(6)}#map=17/${location.lat.toFixed(6)}/${location.lon.toFixed(6)}`
    : null;
  const status = isStale
    ? `lokasi terakhir yang diketahui (diterima ${Math.round(ageMs / 60000)} menit lalu — bukan posisi live)`
    : 'posisi terakhir yang diterima perangkat';

  const lines = [
    `Sistem mendeteksi kemungkinan keadaan darurat pada ${ownerName}. Mohon segera mencoba menghubunginya dan memeriksa kondisinya.`,
    `Lokasi terakhir: ${mapLink || 'tidak tersedia'}${mapLink ? ` (${coords})` : ''}`,
    `Waktu: ${stamp}`,
    `Akurasi GPS: ${acc}`,
    `Status terakhir: ${status}`,
  ];
  if (event?.trigger?.level) lines.push(`Tingkat keyakinan sistem: ${event.trigger.level} (skor ${event.trigger.score ?? '—'}) — ini perkiraan sistem, bukan konfirmasi kecelakaan.`);
  if (baseUrl) lines.push(`Peta riwayat: ${String(baseUrl).replace(/\/+$/, '')}/tracking`);
  if (callName) lines.push(`Coba juga telepon langsung: ${callName}`);
  return lines.join('\n');
}
