/**
 * src/location/classify.js
 *
 * Place classification for a dwell ("saya berhenti di sini"). Pure function:
 * all evidence comes in as arguments, so every rule can be reasoned about and
 * tested without a database or network.
 *
 * Evidence, in the order it is trusted:
 *   1. A geofence the owner confirmed (home, office, "warung Bu Yati") — the
 *      only source that names a place without external data.
 *   2. A place learned from repeated visits and confirmed by history.
 *   3. Reverse geocoding (address/area) — good for "a street in Bekasi", weak
 *      for shops.
 *   4. Nearby POI from OpenStreetMap — names SPBU/minimarket/mal when the data
 *      exists, with confidence falling as distance and GPS error grow.
 *   5. Nothing: "berhenti di lokasi yang belum teridentifikasi".
 *
 * A rule is only trusted when GPS accuracy allows it: a 150 m fix inside a 120 m
 * geofence proves nothing, so such a match is reported as uncertain instead of a
 * confident "you are home".
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { distanceToFenceM } from './geo.js';

export const PLACE_KINDS = [
  'home', 'office', 'mall', 'fuel', 'food', 'minimarket', 'workshop', 'campus',
  'parking', 'road', 'pharmacy', 'bank', 'clinic', 'worship', 'laundry',
  'public', 'vacant', 'unknown',
];

export const KIND_LABELS = {
  home: 'Rumah',
  office: 'Kantor',
  mall: 'Mal / pusat perbelanjaan',
  fuel: 'SPBU',
  food: 'Tempat makan',
  minimarket: 'Minimarket',
  workshop: 'Bengkel',
  campus: 'Kampus / sekolah',
  parking: 'Parkiran',
  road: 'Jalan raya',
  pharmacy: 'Apotek',
  bank: 'Bank / ATM',
  clinic: 'Klinik / rumah sakit',
  worship: 'Tempat ibadah',
  laundry: 'Laundry',
  public: 'Area publik',
  vacant: 'Lahan kosong / area terbuka',
  unknown: 'Belum teridentifikasi',
};

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * How much a geofence match can be trusted, given GPS error and fence radius.
 * The device accuracy is a 68% radius, so we require the reported accuracy to be
 * a minority of the fence radius before calling it a confident match.
 */
export function fenceConfidence(distanceM, fenceRadiusM, accuracyM) {
  const acc = Number.isFinite(accuracyM) && accuracyM > 0 ? accuracyM : 25;
  const ratio = Math.max(0, distanceM) / Math.max(25, fenceRadiusM);
  const slack = acc / Math.max(25, fenceRadiusM);          // >1 means the fix is wider than the fence
  let c = 0.95 - 0.5 * ratio - 0.25 * clamp01(slack - 0.5);
  if (slack > 1.5) c = Math.min(c, 0.45);                  // GPS too coarse for this fence
  return clamp01(c);
}

/**
 * Classifies a stop.
 *
 * @param {object} stop      { lat, lon, accuracy, durationMs, startedAt }
 * @param {object} evidence
 * @param {Array}  evidence.places   candidate geofences (any list; distances are computed here)
 * @param {Array}  [evidence.poi]    nearby POIs: [{ name, kind, brand, distanceM }]
 * @param {object} [evidence.reverse] reverse-geocode result: { label, kind, category, type, displayName }
 * @param {object} [evidence.history] { visitedKinds: {kind: n}, visitedNames: {name: n} }
 * @param {object} [settings]        { maxAccuracyM, classifyMinMs }
 * @returns {{kind:string, label:string|null, confidence:number, source:string, uncertain:boolean, reasons:string[], alternatives:Array}}
 */
export function classifyStop(stop = {}, evidence = {}, settings = {}) {
  const { classifyMinMs = 3 * 60_000, maxAccuracyM = 120 } = settings;
  const reasons = [];
  const alternatives = [];
  const accuracy = Number.isFinite(stop.accuracy) ? stop.accuracy : null;
  const durationMs = Math.max(0, Number(stop.durationMs || 0));
  const lat = Number(stop.lat);
  const lon = Number(stop.lon);

  const unknown = (why, extra = {}) => ({
    kind: 'unknown',
    label: null,
    confidence: extra.confidence ?? 0.15,
    source: 'unknown',
    uncertain: true,
    reasons: [...reasons, why],
    alternatives,
  });

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return unknown('koordinat tidak valid');

  // 1 — geofences -----------------------------------------------------------
  const places = Array.isArray(evidence.places) ? evidence.places : [];
  let bestFence = null;
  for (const p of places) {
    const d = distanceToFenceM(lat, lon, p.lat, p.lon, p.radius_m ?? p.radiusM ?? 120);
    if (bestFence == null || d < bestFence.d) bestFence = { place: p, d };
  }
  if (bestFence && bestFence.d <= 0) {
    const p = bestFence.place;
    const radius = p.radius_m ?? p.radiusM ?? 120;
    // Confidence is about the distance to the CENTRE (0 when standing on it),
    // then degraded when the reported accuracy is coarse relative to the fence.
    const distToCentre = Math.max(0, bestFence.d + radius);
    const conf = fenceConfidence(distToCentre, radius, accuracy);
    reasons.push(`berada di dalam geofence "${p.name}"`);
    alternatives.push({ kind: p.kind, label: p.name, confidence: conf, source: 'geofence' });
    if (conf >= 0.6) {
      return {
        kind: p.kind || 'unknown',
        label: p.name || KIND_LABELS[p.kind] || null,
        confidence: Number(conf.toFixed(2)),
        source: 'geofence',
        uncertain: false,
        reasons,
        alternatives,
      };
    }
    reasons.push(`geofence cocok tetapi akurasi GPS ±${Math.round(accuracy ?? 0)} m terlalu kasar untuk geofence ${Math.round(radius)} m ini`);
    return {
      kind: p.kind || 'unknown',
      label: p.name || null,
      confidence: Number(conf.toFixed(2)),
      source: 'geofence',
      uncertain: true,
      reasons,
      alternatives,
    };
  }

  // Dwell too short to be an activity (traffic light, stopping to buy water).
  if (durationMs > 0 && durationMs < classifyMinMs) {
    return unknown(`durasi berhenti ${Math.round(durationMs / 60000)} menit — belum cukup untuk disebut aktivitas`, { confidence: 0.2 });
  }

  // 2 — nearby POI from OpenStreetMap ---------------------------------------
  const poi = Array.isArray(evidence.poi) ? evidence.poi : [];
  const scored = poi
    .filter((p) => p && (p.kind || p.brand))
    .map((p) => {
      const dist = Number(p.distanceM ?? 9999);
      // A POI is only believable at roughly the same scale as the GPS error.
      const tol = Math.max(80, (accuracy || 30) * 1.5);
      const base = dist <= tol ? 0.62 - (dist / tol) * 0.2 : 0.25;
      return { ...p, score: clamp01(base) };
    })
    .sort((a, b) => b.score - a.score);
  for (const p of scored.slice(0, 3)) {
    alternatives.push({ kind: p.kind || 'unknown', label: p.brand || p.name || null, confidence: Number(p.score.toFixed(2)), source: 'poi' });
  }
  const topPoi = scored[0];
  if (topPoi && topPoi.score >= 0.4 && (topPoi.kind || topPoi.brand)) {
    reasons.push(`POI OpenStreetMap terdekat: ${topPoi.brand || topPoi.name || 'tanpa nama'} (±${Math.round(topPoi.distanceM)} m)`);
    return {
      kind: topPoi.kind || 'public',
      label: topPoi.brand || topPoi.name || KIND_LABELS[topPoi.kind] || null,
      confidence: Number(topPoi.score.toFixed(2)),
      source: 'poi',
      uncertain: topPoi.score < 0.55,
      reasons,
      alternatives,
    };
  }

  // 3 — reverse geocode (address/area only) ---------------------------------
  const rev = evidence.reverse;
  if (rev) {
    const brand = rev.brandKind ? null : null; // reserved: brand extraction already happens in geocode.js
    const kind = rev.kind || brand;
    const label = rev.label || (rev.displayName ? String(rev.displayName).split(',').slice(0, 3).join(',').trim() : null);
    if (kind && kind !== 'home') {
      reasons.push(`kategori OSM dari reverse geocoding: ${kind}`);
      return {
        kind,
        label: label || KIND_LABELS[kind] || null,
        confidence: 0.5,
        source: 'poi',
        uncertain: false,
        reasons,
        alternatives,
      };
    }
    if (label) {
      reasons.push('hanya alamat/area yang bisa dipastikan dari data peta, bukan nama tempat');
      return {
        kind: 'public',
        label,
        confidence: 0.35,
        source: 'address',
        uncertain: true,
        reasons,
        alternatives,
      };
    }
  }

  // 4 — history (learned, not guessed) --------------------------------------
  const hist = evidence.history || {};
  const names = Object.entries(hist.visitedNames || {}).sort((a, b) => b[1] - a[1]);
  const kinds = Object.entries(hist.visitedKinds || {}).sort((a, b) => b[1] - a[1]);
  if (names.length && names[0][1] >= 3) {
    reasons.push(`tempat yang sama pernah dikunjungi ${names[0][1]}x dan diberi nama sebelumnya`);
    return {
      kind: (kinds[0]?.[0]) || 'unknown',
      label: names[0][0],
      confidence: 0.55,
      source: 'history',
      uncertain: false,
      reasons,
      alternatives,
    };
  }

  return unknown(
    poi.length
      ? 'ada POI di sekitar, tetapi terlalu jauh atau akurasi GPS terlalu kasar untuk dipastikan'
      : (accuracy != null && accuracy > maxAccuracyM
        ? `akurasi GPS ±${Math.round(accuracy)} m terlalu kasar untuk menentukan nama tempat`
        : 'tidak ada geofence, POI, atau riwayat yang cocok — tidak dikarang'),
    { confidence: 0.18 }
  );
}

/**
 * Whether a classification should be stored as a "stop" the owner will see, or
 * silently kept as a traffic pause.
 * @returns {{kept:boolean, reason:string}}
 */
export function shouldKeepStop(stop, classification, settings = {}) {
  const { stopMinMs = 3 * 60_000 } = settings;
  const duration = Number(stop.durationMs || 0);
  if (duration < stopMinMs) return { kept: false, reason: 'durasi terlalu singkat (lalu lintas / lampu merah)' };
  if (classification?.kind === 'road') return { kept: false, reason: 'berhenti di jalan raya' };
  return { kept: true, reason: classification?.kind === 'unknown' ? 'berhenti lama di lokasi belum teridentifikasi' : 'kunjungan tercatat' };
}
