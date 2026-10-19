/**
 * src/location/geo.js
 *
 * Pure geospatial maths for location tracking: distances, bearings, GPS sample
 * validation and filtering. No database, no network, no clock of its own — so
 * every rule here is unit-testable with fixed inputs.
 *
 * Honesty notes that shape these rules:
 *   - GPS points are noisy; a raw "distance travelled" over-counts. We only
 *     accumulate distance between points that passed validation.
 *   - Accuracy reported by the device is a 68% confidence radius. A point with
 *     accuracy 100 m can be 200 m away from the truth, so it must never turn a
 *     green light into "you left home".
 *   - Teleporting (implied speed beyond plausibility) means a bad fix, not a
 *     fast motorcycle. Such points are dropped, not smoothed.
 *
 * @author Wisnu Alfian Nur Ashar
 */

export const EARTH_R = 6371008.8; // mean Earth radius, metres (IUGG)

const rad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in metres between two WGS84 points. */
export function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing (degrees, 0 = north) from point 1 to point 2. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = rad(lat1);
  const φ2 = rad(lat2);
  const Δλ = rad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Implied ground speed in m/s between two fixes. `null` when the clock did not advance. */
export function impliedSpeedMps(a, b) {
  const dt = (b.ts - a.ts) / 1000;
  if (!(dt > 0)) return null;
  return haversineM(a.lat, a.lon, b.lat, b.lon) / dt;
}

/** Coordinates rounded to ~1.1 km cells — used for privacy-preserving "cells", never exact points. */
export function cellKey(lat, lon, precision = 2) {
  return `${Number(lat).toFixed(precision)}:${Number(lon).toFixed(precision)}`;
}

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Geohash of a point (standard base-32). Used as a stable key for learned places. */
export function geohash(lat, lon, precision = 7) {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let hash = '';
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon > mid) { ch = (ch << 1) + 1; lonMin = mid; } else { ch <<= 1; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat > mid) { ch = (ch << 1) + 1; latMin = mid; } else { ch <<= 1; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) {
      hash += B32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

/** Total trajectory length in metres over an ordered list of accepted samples. */
export function pathLengthM(samples) {
  let d = 0;
  for (let i = 1; i < samples.length; i++) {
    d += haversineM(samples[i - 1].lat, samples[i - 1].lon, samples[i].lat, samples[i].lon);
  }
  return d;
}

/** Max and average speed (m/s) from consecutive samples that carry a valid timestamp. */
export function speedStats(samples) {
  let max = 0;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < samples.length; i++) {
    const v = impliedSpeedMps(samples[i - 1], samples[i]);
    if (v == null || !Number.isFinite(v)) continue;
    if (v > max) max = v;
    sum += v;
    n++;
  }
  return { maxMps: max, avgMps: n ? sum / n : 0, segments: n };
}

/** Haversine distance of a point to a circle centre, minus radius: <0 means inside. */
export function distanceToFenceM(lat, lon, fenceLat, fenceLon, radiusM) {
  return haversineM(lat, lon, fenceLat, fenceLon) - Number(radiusM || 0);
}

/**
 * Validates one incoming sample.
 * @returns {{ok:true, sample:object}|{ok:false, reason:string}}
 */
export function validateSample(raw, opts = {}) {
  const { maxAccuracyM = 200, minAccuracyM = 0 } = opts;
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not_an_object' };
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, reason: 'bad_coordinates' };
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { ok: false, reason: 'out_of_range' };
  // (0,0) is a classic "GPS never fixed" placeholder, never a real ride in Indonesia.
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return { ok: false, reason: 'null_island' };

  const ts = Number(raw.ts);
  if (!Number.isFinite(ts) || ts <= 0) return { ok: false, reason: 'bad_timestamp' };
  const now = Number(opts.now || Date.now());
  if (ts > now + 10 * 60_000) return { ok: false, reason: 'future_timestamp' };
  if (ts < now - 30 * 24 * 3600_000) return { ok: false, reason: 'too_old' };

  const accuracy = Number.isFinite(Number(raw.accuracy)) ? Math.max(0, Number(raw.accuracy)) : null;
  if (accuracy != null && accuracy > maxAccuracyM) return { ok: false, reason: 'poor_accuracy', accuracy };
  if (accuracy != null && accuracy < minAccuracyM) return { ok: false, reason: 'impossible_accuracy', accuracy };

  const out = {
    ts,
    lat,
    lon,
    accuracy,
    speed: Number.isFinite(Number(raw.speed)) && Number(raw.speed) >= 0 ? Number(raw.speed) : null,
    heading: Number.isFinite(Number(raw.heading)) && Number(raw.heading) >= 0 ? Number(raw.heading) % 360 : null,
    altitude: Number.isFinite(Number(raw.altitude)) ? Number(raw.altitude) : null,
    battery: Number.isFinite(Number(raw.battery)) ? Number(raw.battery) : null,
    source: ['gps', 'network', 'manual', 'device', 'sim', 'browser'].includes(raw.source) ? raw.source : 'gps',
    motion: raw.motion && typeof raw.motion === 'object' ? raw.motion : null,
  };
  return { ok: true, sample: out };
}

/**
 * Filters a batch against the previous accepted point.
 * Returns the points worth storing plus a summary of why the others were dropped —
 * the drop reasons are surfaced to the dashboard so "no data" is explained, never hidden.
 */
export function filterSamples(batch = [], prev = null, opts = {}) {
  const {
    minMoveM = 8,          // closer than this is GPS jitter, not movement
    minIntervalMs = 1500,  // same-fix resend window
    maxSpeedMps = 60,      // ~216 km/h: faster than any Vario, so it is a bad fix
    now = Date.now(),
  } = opts;

  const accepted = [];
  const dropped = {};
  let last = prev ? { ...prev } : null;
  for (const raw of batch) {
    const v = validateSample(raw, { ...opts, now });
    if (!v.ok) {
      dropped[v.reason] = (dropped[v.reason] || 0) + 1;
      continue;
    }
    const s = v.sample;
    if (last) {
      if (s.ts < last.ts) { dropped.out_of_order = (dropped.out_of_order || 0) + 1; continue; }
      const dt = s.ts - last.ts;
      const d = haversineM(last.lat, last.lon, s.lat, s.lon);
      if (dt < minIntervalMs && d < minMoveM) { dropped.duplicate = (dropped.duplicate || 0) + 1; continue; }
      if (dt > 0 && d / (dt / 1000) > maxSpeedMps) { dropped.implausible_speed = (dropped.implausible_speed || 0) + 1; continue; }
      if (dt >= minIntervalMs && d < minMoveM) {
        // Still a valid "I am parked here" heartbeat: keep it, but it carries no movement.
        accepted.push({ ...s, moved: false });
        last = s;
        continue;
      }
    }
    accepted.push({ ...s, moved: true });
    last = s;
  }
  return { accepted, dropped };
}

/** Accuracy-weighted average of the last points (a light smoother, not a filter that hides the truth). */
export function weightedPosition(points = []) {
  const usable = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (usable.length === 0) return null;
  let wSum = 0;
  let lat = 0;
  let lon = 0;
  for (const p of usable) {
    const acc = Number.isFinite(p.accuracy) && p.accuracy > 0 ? p.accuracy : 30;
    const w = 1 / (acc * acc);
    wSum += w;
    lat += p.lat * w;
    lon += p.lon * w;
  }
  return { lat: lat / wSum, lon: lon / wSum, points: usable.length };
}

/**
 * Movement state from the last fixes.
 * "unknown" is a first-class answer: without enough points we do not guess.
 */
export function movementState(samples = [], opts = {}) {
  const {
    stopSpeedMps = 0.8,        // below ~3 km/h counts as standing
    movingWindowMs = 60_000,   // how far back we look
    longStopMs = 10 * 60_000,  // "diam dalam waktu lama"
  } = opts;
  if (!Array.isArray(samples) || samples.length === 0) return { state: 'unknown', speedMps: null, since: null };
  const last = samples[samples.length - 1];
  const lastTs = last.ts;
  const window = samples.filter((s) => lastTs - s.ts <= movingWindowMs);
  const stats = speedStats(window.length >= 2 ? window : samples.slice(-2));
  const reported = Number.isFinite(last.speed) ? last.speed : null;
  const speed = reported != null ? Math.min(reported, stats.maxMps || reported) : stats.maxMps;
  const moving = speed != null && speed > stopSpeedMps;

  // How long has the current (moving/stopped) state lasted? Walk the full
  // history (not just the speed window) so a 20-minute stand-still is reported
  // as such instead of "we don't know".
  let since = samples[0]?.ts ?? lastTs;
  for (let i = samples.length - 1; i > 0; i--) {
    const v = impliedSpeedMps(samples[i - 1], samples[i]);
    const wasMoving = v != null && v > stopSpeedMps;
    if (wasMoving !== moving) { since = samples[i].ts; break; }
  }
  if (moving) return { state: 'moving', speedMps: speed, since };
  const stoppedFor = lastTs - since;
  return {
    state: stoppedFor >= longStopMs ? 'stopped_long' : 'stopped',
    speedMps: speed ?? 0,
    since,
    stoppedForMs: stoppedFor,
  };
}

/** Formats metres for humans ("1,2 km" / "850 m"). */
export function formatDistance(m, locale = 'id-ID') {
  const n = Number(m || 0);
  if (n < 1000) return `${Math.round(n)} m`;
  return `${(n / 1000).toLocaleString(locale, { maximumFractionDigits: n < 10_000 ? 2 : 1 })} km`;
}

/** Formats m/s as km/h. */
export function formatSpeed(mps, locale = 'id-ID') {
  if (!Number.isFinite(mps)) return '—';
  return `${(mps * 3.6).toLocaleString(locale, { maximumFractionDigits: 1 })} km/jam`;
}
