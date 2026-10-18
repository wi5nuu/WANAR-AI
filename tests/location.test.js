/**
 * Test Suite: src/location/*
 * In-memory SQLite, injected clock, stub geocoder. No network.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';

import {
  haversineM, bearingDeg, geohash, filterSamples, validateSample, movementState,
  pathLengthM, speedStats, formatDistance, formatSpeed, distanceToFenceM,
} from '../src/location/geo.js';
import { classifyStop, fenceConfidence, shouldKeepStop, KIND_LABELS } from '../src/location/classify.js';
import { createLocationStore, hashToken, tokenMatches, DEFAULT_SETTINGS } from '../src/location/store.js';
import { LocationService, LocationError } from '../src/location/service.js';
import { createLocationRouter, sanitizeLocationSettings, makeSimulatedRide } from '../src/location/routes.js';
import { quickLocation, quickLocationPin, listPlacesText } from '../src/location/quick.js';
import { localDate } from '../src/worklog/time.js';

const T0 = Date.parse('2026-10-12T01:00:00Z'); // 08:00 WIB
const BASE = { lat: -6.2383, lon: 106.9756 };

/** ~metres east of BASE. */
const move = (lat, lon, m, dir = 'east') => {
  const dLat = dir === 'north' ? m / 111_320 : 0;
  const dLon = dir === 'east' ? m / (111_320 * Math.cos((lat * Math.PI) / 180)) : 0;
  return { lat: lat + dLat, lon: lon + dLon };
};

function build({ geocoder = null, geocodeEnabled = true } = {}) {
  const db = new Database(':memory:');
  let clock = T0;
  const now = () => clock;
  const store = createLocationStore(db);
  store.settings.set({ geocode: { enabled: geocodeEnabled } });
  const svc = new LocationService({ store, geocoder, now, env: {} });
  const session = svc.startSession({ label: 'test' });
  return { db, store, svc, session, now, set: (ms) => { clock = ms; }, advance: (ms) => { clock += ms; } };
}

/** Feed a straight ride: n points, each `stepM` metres east, one every `dtS` seconds. */
function ride({ n = 12, stepM = 120, dtS = 8, startAt = T0, start = BASE } = {}) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p = i === 0 ? p : move(p.lat, p.lon, stepM);
    out.push({ ts: startAt + i * dtS * 1000, lat: p.lat, lon: p.lon, accuracy: 10, speed: i === 0 ? 0 : 8 });
  }
  return out;
}

// ================================================================ geo math

describe('location geo math', () => {
  it('measures distance and bearing', () => {
    const d = haversineM(-6.2, 106.8, -6.2, 106.9);
    expect(d).toBeGreaterThan(11_000);
    expect(d).toBeLessThan(11_200);
    expect(Math.round(bearingDeg(-6.2, 106.8, -6.3, 106.8))).toBe(180);
    expect(haversineM(0, 0, 0, 0)).toBe(0);
  });

  it('rejects impossible fixes honestly', () => {
    expect(validateSample({ lat: 0, lon: 0, ts: Date.now() }).reason).toBe('null_island');
    expect(validateSample({ lat: 91, lon: 10, ts: Date.now() }).reason).toBe('out_of_range');
    expect(validateSample({ lat: -6.2, lon: 106.8, ts: Date.now() + 30 * 60_000 }).reason).toBe('future_timestamp');
    expect(validateSample({ lat: -6.2, lon: 106.8, ts: Date.now() - 40 * 86_400_000 }).reason).toBe('too_old');
    expect(validateSample({ lat: -6.2, lon: 106.8, ts: Date.now(), accuracy: 500 }).reason).toBe('poor_accuracy');
    expect(validateSample({ lat: -6.2, lon: 106.8, ts: Date.now() }).ok).toBe(true);
  });

  it('filters jitter, duplicates and teleports instead of storing them', () => {
    const prev = { lat: BASE.lat, lon: BASE.lon, ts: T0 };
    const batch = [
      { ts: T0 + 1000, lat: BASE.lat, lon: BASE.lon },                                   // same fix, same second
      { ts: T0 + 8000, lat: BASE.lat, lon: BASE.lon },                                   // heartbeat (not moved)
      { ts: T0 + 16_000, ...move(BASE.lat, BASE.lon, 100) },                             // real movement
      { ts: T0 + 24_000, lat: -6.9, lon: 110.4 },                                        // teleport
    ];
    const r = filterSamples(batch, prev, { now: T0 + 60_000 });
    expect(r.dropped.duplicate).toBe(1);
    expect(r.dropped.implausible_speed).toBe(1);
    expect(r.accepted.map((s) => s.moved)).toEqual([false, true]);
  });

  it('computes path length and speed stats', () => {
    const pts = ride({ n: 5, stepM: 100, dtS: 10 });
    const len = pathLengthM(pts);
    expect(len).toBeGreaterThan(350);
    expect(len).toBeLessThan(450);
    const st = speedStats(pts);
    expect(st.maxMps).toBeGreaterThan(8);
    expect(st.maxMps).toBeLessThan(12);
  });

  it('reports movement state, including honest "unknown"', () => {
    expect(movementState([]).state).toBe('unknown');
    const moving = ride({ n: 6, stepM: 60, dtS: 8 });
    expect(movementState(moving).state).toBe('moving');
    const parked = [];
    for (let i = 0; i < 12; i++) parked.push({ ts: T0 + i * 60_000, lat: BASE.lat, lon: BASE.lon, speed: 0 });
    expect(movementState(parked).state).toBe('stopped_long');
    expect(movementState(parked).stoppedForMs).toBeGreaterThan(10 * 60_000);
  });

  it('geohashes neighbours to a shared cell and formats numbers', () => {
    expect(geohash(BASE.lat, BASE.lon, 5)).toBe(geohash(BASE.lat + 0.0005, BASE.lon + 0.0005, 5));
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(12_345)).toMatch(/12,3 km|12\.3 km/);
    expect(formatSpeed(13.9)).toMatch(/50/);
  });
});

// ============================================================== classify

describe('place classification (no invented names)', () => {
  const home = { id: 'p1', name: 'Rumah', kind: 'home', lat: BASE.lat, lon: BASE.lon, radius_m: 120 };

  it('trusts a geofence only when GPS accuracy allows it', () => {
    const good = classifyStop({ lat: BASE.lat, lon: BASE.lon, accuracy: 10, durationMs: 30 * 60_000 }, { places: [home] });
    expect(good).toMatchObject({ kind: 'home', label: 'Rumah', source: 'geofence', uncertain: false });
    const coarse = classifyStop({ lat: BASE.lat + 0.0005, lon: BASE.lon, accuracy: 400, durationMs: 30 * 60_000 }, { places: [home] });
    expect(coarse.source).toBe('geofence');
    expect(coarse.uncertain).toBe(true);
    expect(fenceConfidence(0, 120, 400)).toBeLessThan(0.6);
  });

  it('never claims a place from a short stop or weak evidence', () => {
    const short = classifyStop({ lat: BASE.lat, lon: BASE.lon, accuracy: 10, durationMs: 60_000 }, {}, {});
    expect(short.kind).toBe('unknown');
    expect(short.confidence).toBeLessThan(0.35);
    const empty = classifyStop({ lat: BASE.lat, lon: BASE.lon, accuracy: 10, durationMs: 20 * 60_000 }, { poi: [], reverse: null });
    expect(empty.kind).toBe('unknown');
    expect(empty.source).toBe('unknown');
    expect(empty.reasons.join(' ')).toMatch(/tidak ada geofence/);
  });

  it('uses a nearby POI with confidence scaled by distance', () => {
    const poi = [{ name: 'Alfamart Melati', kind: 'minimarket', brand: 'Alfamart', distanceM: 30 }];
    const r = classifyStop({ lat: BASE.lat, lon: BASE.lon, accuracy: 15, durationMs: 15 * 60_000 }, { poi });
    expect(r.kind).toBe('minimarket');
    expect(r.label).toBe('Alfamart');
    expect(r.source).toBe('poi');
    const far = classifyStop({ lat: BASE.lat, lon: BASE.lon, accuracy: 15, durationMs: 15 * 60_000 }, { poi: [{ ...poi[0], distanceM: 900 }] });
    expect(far.kind).toBe('unknown');
  });

  it('keeps only real dwells, and says why the others were dropped', () => {
    expect(shouldKeepStop({ durationMs: 60_000 }, { kind: 'food' }, {}).kept).toBe(false);
    expect(shouldKeepStop({ durationMs: 10 * 60_000 }, { kind: 'food' }, {}).kept).toBe(true);
    expect(shouldKeepStop({ durationMs: 10 * 60_000 }, { kind: 'road' }, {}).kept).toBe(false);
    expect(KIND_LABELS.unknown).toBe('Belum teridentifikasi');
  });
});

// ============================================================ store/service

describe('location store + service pipeline', () => {
  it('stores only token hashes and compares in constant time', () => {
    const db = new Database(':memory:');
    const store = createLocationStore(db);
    const { device, token } = store.devices.create({ name: 'HP uji' });
    expect(store.devices.byTokenHash(hashToken(token)).id).toBe(device.id);
    expect(JSON.stringify(store.devices.list())).not.toContain(token);
    expect(tokenMatches(device.token_hash, token)).toBe(true);
    expect(tokenMatches(device.token_hash, `${token}x`)).toBe(false);
    expect(tokenMatches('zzz', token)).toBe(false);
  });

  it('ingests a batch, opens a trip when actually moving, and deduplicates retries', () => {
    const t = build();
    const points = ride({ n: 6, stepM: 150, dtS: 8 });
    t.set(points[points.length - 1].ts + 8000);
    const r1 = t.svc.ingest(points, { sessionId: t.session.id });
    expect(r1.inserted).toBe(6);
    expect(r1.tripId).toBeTruthy();
    const trip = t.store.trips.get(r1.tripId);
    expect(trip.distance_m).toBeGreaterThan(600);
    expect(trip.status).toBe('open');
    // Phone retries the same batch after a network gap: no duplicate rows, no double trips.
    const r2 = t.svc.ingest(points, { sessionId: t.session.id });
    expect(r2.inserted).toBe(0);
    expect(r2.duplicates).toBeGreaterThan(0);
    expect(t.store.samples.count()).toBe(6);
  });

  it('closes the trip after a stand-still and opens a classified stop', async () => {
    const geocoder = {
      reverse: async () => ({ label: 'Jalan Melati, Bekasi', kind: 'road', displayName: 'Jalan Melati, Bekasi' }),
      nearbyPoi: async () => [{ name: 'Warung Bu Yati', kind: 'food', distanceM: 35 }],
    };
    const t = build({ geocoder });
    const points = ride({ n: 6, stepM: 150, dtS: 8 });
    t.set(points[points.length - 1].ts + 8000);
    const r1 = t.svc.ingest(points, { sessionId: t.session.id });
    expect(r1.tripId).toBeTruthy();
    // Now stand still for 6 minutes (heartbeat samples, moved=false).
    const last = points[points.length - 1];
    const dwellStart = last.ts + 8_000;
    for (let i = 1; i <= 4; i++) {
      t.set(dwellStart + i * 90_000);
      t.svc.ingest([{ ts: t.now(), lat: last.lat, lon: last.lon, accuracy: 8, speed: 0 }], { sessionId: t.session.id });
    }
    const closedTrip = t.store.trips.get(r1.tripId);
    expect(closedTrip.status).toBe('closed');
    const openStop = t.store.stops.open();
    expect(openStop).toBeTruthy();
    const classified = await t.svc.classifyStopById(openStop.id);
    expect(classified.kind).toBe('food');
    expect(classified.label).toBe('Warung Bu Yati');
    expect(classified.kept).toBe(true);
  });

  it('still sees a sample whose phone clock runs slightly ahead of the server', () => {
    const t = build();
    const points = ride({ n: 6, stepM: 150, dtS: 8 });
    t.set(points[points.length - 1].ts + 8000);
    const r1 = t.svc.ingest(points, { sessionId: t.session.id });
    expect(r1.tripId).toBeTruthy();
    const last = points[points.length - 1];
    // Stand still for 7.5 minutes → the trip closes and a stop opens.
    for (let i = 1; i <= 5; i++) {
      t.set(last.ts + i * 90_000);
      t.svc.ingest([{ ts: t.now(), lat: last.lat, lon: last.lon, accuracy: 8, speed: 0 }], { sessionId: t.session.id });
    }
    const openStop = t.store.stops.open();
    expect(openStop).toBeTruthy();
    // Movement resumes, but the fix's timestamp is 30 s ahead of the server
    // clock (skewed phone clock). The stop must close at the real last-moved
    // time, not with zero duration.
    t.svc.ingest([{ ts: t.now() + 30_000, ...move(last.lat, last.lon, 200), accuracy: 8, speed: 2 }], { sessionId: t.session.id });
    const closed = t.store.stops.get(openStop.id);
    expect(closed.ended_at).toBeGreaterThan(closed.started_at);
    expect(closed.ended_at - closed.started_at).toBeGreaterThanOrEqual(6 * 60_000);
  });

  it('classifies a named home instantly with no network at all', async () => {
    const t = build({ geocoder: null });
    t.store.places.create({ name: 'Rumah', kind: 'home', lat: BASE.lat, lon: BASE.lon, radiusM: 120, source: 'user', confirmState: 'confirmed', geohash: geohash(BASE.lat, BASE.lon, 6) });
    const stop = t.store.stops.create({ date: t.svc.today(), startedAt: t.now() - 30 * 60_000, lat: BASE.lat, lon: BASE.lon, accuracy: 12, ended_at: t.now() });
    const out = await t.svc.classifyStopById(stop.id);
    expect(out).toMatchObject({ kind: 'home', label: 'Rumah', source: 'geofence', kept: true });
  });

  it('owner correction creates a geofence and offers it to personal memory', () => {
    const t = build();
    const seen = [];
    t.svc.memory = (e) => seen.push(e);
    const stop = t.store.stops.create({ date: t.svc.today(), startedAt: t.now() - 20 * 60_000, lat: BASE.lat, lon: BASE.lon, accuracy: 10, ended_at: t.now() });
    const updated = t.svc.correctStop(stop.id, { label: 'Warung Bu Yati', kind: 'food', savePlace: true });
    expect(updated.corrected_label).toBe('Warung Bu Yati');
    expect(t.store.places.list().some((p) => p.name === 'Warung Bu Yati')).toBe(true);
    expect(seen[0].kind).toBe('place_correction');
    expect(seen[0].place.name).toBe('Warung Bu Yati');
  });

  it('reports live vs last-known position honestly', () => {
    const t = build();
    const points = ride({ n: 3, stepM: 40, dtS: 8 });
    t.set(points[2].ts + 5_000);
    t.svc.ingest(points, { sessionId: t.session.id });
    let st = t.svc.currentStatus();
    expect(st.position.fresh).toBe(true);
    expect(st.position.label).toBe('posisi terkini');
    // 30 minutes later the same stored point is NOT live any more.
    t.set(points[2].ts + 30 * 60_000);
    st = t.svc.currentStatus();
    expect(st.position.fresh).toBe(false);
    expect(st.position.label).toMatch(/lokasi terakhir/);
  });

  it('answers day questions from data, with GPS-distance honesty', () => {
    const t = build();
    const points = ride({ n: 5, stepM: 200, dtS: 8 });
    t.set(points[4].ts + 8000);
    t.svc.ingest(points, { sessionId: t.session.id });
    const d = t.svc.daySummary(localDate(T0));
    expect(d.trips.length).toBe(1);
    expect(d.distanceM).toBeGreaterThan(700);
    expect(quickLocation(t.svc, 'posisi saya di mana?')).toMatch(/Posisi terkini|Lokasi terakhir/);
    expect(quickLocation(t.svc, 'hari ini saya ke mana saja?')).toMatch(/lintasan GPS/);
    expect(quickLocation(t.svc, 'berapa km hari ini?')).toMatch(/km|m/);
  });

  it('respects the privacy switches: tracking off refuses ingest', () => {
    const t = build();
    t.svc.updateSettings({ enabled: false });
    expect(() => t.svc.ingest(ride({ n: 2 }), {})).toThrowError(LocationError);
    t.svc.updateSettings({ enabled: true });
    expect(() => t.svc.ingest([], {})).toThrowError(/Tidak ada titik/);
  });
});

// ================================================================== routes

function makeApp(module) {
  const app = express();
  app.use(express.json());
  app.use('/api/location', createLocationRouter({ location: module }));
  return app;
}

describe('location routes', () => {
  it('rejects an unknown device token and accepts the real one', async () => {
    const db = new Database(':memory:');
    const store = createLocationStore(db);
    let clock = T0;
    const svc = new LocationService({ store, now: () => clock, env: {} });
    const module = { store, service: svc };
    const { device, token } = store.devices.create({ name: 'HP uji' });
    const app = makeApp(module);

    const denied = await request(app).post('/api/location/device/ingest').send({ samples: ride({ n: 2 }) });
    expect(denied.status).toBe(401);

    clock = T0 + 60_000;
    const okRes = await request(app)
      .post('/api/location/device/ingest')
      .set('X-Device-Token', token)
      .send({ samples: ride({ n: 2, startAt: T0 + 30_000 }) });
    expect(okRes.status).toBe(200);
    expect(okRes.body.success).toBe(true);
    expect(store.samples.count()).toBe(2);

    const hint = await request(app).get('/api/location/device/hint').set('X-Device-Token', token);
    expect(hint.body.hint.intervalMs).toBeGreaterThan(0);
    expect(hint.body.device.id).toBe(device.id);
  });

  it('serves the dashboard on loopback (no token needed) and never leaks raw tokens', async () => {
    const db = new Database(':memory:');
    const store = createLocationStore(db);
    const svc = new LocationService({ store, now: () => T0, env: {} });
    const module = { store, service: svc };
    const app = makeApp(module);
    const created = await request(app).post('/api/location/devices').send({ name: 'HP baru' });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^loc_/);
    const listing = await request(app).get('/api/location/devices');
    expect(JSON.stringify(listing.body)).not.toContain(created.body.token);
    const status = await request(app).get('/api/location/status');
    expect(status.body.status.tracking.enabled).toBe(true);
  });

  it('runs the simulated ride without mixing it into a live session', async () => {
    const db = new Database(':memory:');
    const store = createLocationStore(db);
    const svc = new LocationService({ store, now: () => Date.now(), env: {} });
    const module = { store, service: svc };
    const app = makeApp(module);
    const res = await request(app).post('/api/location/simulate/ride').send({ points: 40 });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBeGreaterThan(30);
    expect(res.body.note).toMatch(/sintetis/);
    const rows = store.privacy.stats();
    expect(rows.samples).toBeGreaterThan(30);
    // While that simulated session is open, a second ride is refused (no mixing).
    const again = await request(app).post('/api/location/simulate/ride').send({});
    expect(again.status).toBe(409);
  });

  it('validates settings and requires confirmation before deleting history', async () => {
    const db = new Database(':memory:');
    const store = createLocationStore(db);
    const svc = new LocationService({ store, now: () => Date.now(), env: {} });
    const app = makeApp({ store, service: svc });
    // Out-of-range values are clamped to the safe window, never accepted raw.
    const clamped = await request(app).put('/api/location/settings').send({ adaptiveIntervalMs: 1 });
    expect(clamped.status).toBe(200);
    expect(clamped.body.settings.adaptiveIntervalMs).toBe(3_000);
    // A non-numeric value is refused.
    const bad = await request(app).put('/api/location/settings').send({ maxAccuracyM: 'kasar' });
    expect(bad.status).toBe(400);
    const good = await request(app).put('/api/location/settings').send({ adaptiveIntervalMs: 10000, notify: { maxPerHour: 3 } });
    expect(good.body.settings.adaptiveIntervalMs).toBe(10_000);
    expect(good.body.settings.notify.maxPerHour).toBe(3);
    const purge = await request(app).post('/api/location/privacy/purge').send({ olderThanDays: 30 });
    expect(purge.status).toBe(400);
  });

  it('sanitizes settings instead of trusting the request body', () => {
    expect(sanitizeLocationSettings({ maxAccuracyM: 99_999 }).maxAccuracyM).toBe(5_000);
    expect(() => sanitizeLocationSettings({ minMoveM: 'abc' })).toThrow();
    expect(sanitizeLocationSettings({ notify: { tripStart: false } }).notify.tripStart).toBe(false);
    expect(DEFAULT_SETTINGS.adaptiveIntervalMs).toBe(8_000);
  });
});

// =============================================================== quick intents

describe('quick location intents (code, no model)', () => {
  it('controls the tracking session in plain Indonesian', () => {
    const t = build();
    expect(quickLocation(t.svc, 'matikan pelacakan lokasi')).toMatch(/✓/);
    expect(t.store.sessions.active()).toBeNull();
    expect(quickLocation(t.svc, 'nyalakan tracking')).toMatch(/menyala/);
    expect(t.store.sessions.active()).toBeTruthy();
    expect(quickLocation(t.svc, 'jeda pelacakan')).toMatch(/dijeda/);
    expect(quickLocation(t.svc, 'lanjut pelacakan')).toMatch(/dilanjutkan/);
  });

  it('returns null for unrelated messages', () => {
    const t = build();
    expect(quickLocation(t.svc, 'berapa jam saya kerja hari ini?')).toBeNull();
    expect(quickLocation(t.svc, 'tolong buatkan email')).toBeNull();
  });

  // ------------------------------------------------- places from chat (pins)

  it('saves a shared pin as a named place, feeds memory, and answers "di mana rumah?"', () => {
    const t = build();
    const mem = [];
    t.svc.memory = (e) => mem.push(e);

    const ask = quickLocationPin(t.svc, { chatId: '123', lat: BASE.lat, lon: BASE.lon, title: null });
    expect(ask).toMatch(/Lokasi diterima/);
    expect(ask).toMatch(/simpan lokasi ini sebagai/);

    const reply = quickLocation(t.svc, 'simpan lokasi ini sebagai Rumah', { chatId: '123' });
    expect(reply).toMatch(/✓ Tersimpan: "Rumah"/);
    expect(reply).toMatch(/kategori: Rumah/);

    const places = t.store.places.list();
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: 'Rumah', kind: 'home', source: 'user', confirm_state: 'confirmed' });
    expect(places[0].lat).toBeCloseTo(BASE.lat, 5);
    expect(places[0].lon).toBeCloseTo(BASE.lon, 5);
    expect(mem.some((e) => e.kind === 'place_correction' && e.place?.name === 'Rumah')).toBe(true);

    // The pin belongs to the chat that shared it, and only to that chat.
    expect(t.svc.pendingPin('123')).toBeNull();

    const where = quickLocation(t.svc, 'di mana rumah?');
    expect(where).toMatch(/📍 Rumah/);
    expect(where).toMatch(/-6\.23830, 106\.97560/);
    expect(where).toMatch(/Belum pernah tercatat dikunjungi/);
  });

  it('saves from typed coordinates and reports a repeated name instead of duplicating it', () => {
    const t = build();
    const reply = quickLocation(t.svc, 'simpan lokasi -6.24123, 106.97561 sebagai Warung Bu Tini');
    expect(reply).toMatch(/✓ Tersimpan: "Warung Bu Tini"/);
    expect(reply).toMatch(/kategori: Tempat makan/);
    expect(reply).toMatch(/dari koordinat di pesan ini/);

    const place = t.store.places.list()[0];
    expect(place.lat).toBeCloseTo(-6.24123, 5);
    expect(place.lon).toBeCloseTo(106.97561, 5);

    const again = quickLocation(t.svc, 'simpan lokasi -6.2383, 106.9756 sebagai Warung Bu Tini');
    expect(again).toMatch(/sudah tersimpan/);
    expect(t.store.places.list()).toHaveLength(1);
  });

  it('uses a venue title and the "wa:" chat prefix the same way the responder does', () => {
    const t = build();
    const ask = quickLocationPin(t.svc, { chatId: 'wa:628123', lat: -6.2, lon: 106.8, title: 'Wanar HQ' });
    expect(ask).toMatch(/Wanar HQ/);

    // Bare "simpan lokasi ini" adopts the venue title.
    const reply = quickLocation(t.svc, 'simpan lokasi ini', { chatId: 'wa:628123' });
    expect(reply).toMatch(/✓ Tersimpan: "Wanar HQ"/);
    expect(t.svc.pendingPin('wa:628123')).toBeNull();
    expect(t.store.places.list()[0]).toMatchObject({ name: 'Wanar HQ', kind: 'public' });
  });

  it('uses the last position only when it is fresh, and lists places on request', () => {
    const t = build();
    // Nothing tracked yet: saving "lokasi saat ini" must refuse, not invent.
    expect(quickLocation(t.svc, 'simpan lokasi saat ini sebagai Kantor')).toMatch(/Belum ada lokasi yang bisa disimpan/);

    t.svc.ingest([{ ts: t.now(), lat: BASE.lat, lon: BASE.lon, accuracy: 8, speed: 0 }], { sessionId: t.session.id });
    const reply = quickLocation(t.svc, 'simpan lokasi saat ini sebagai Kantor');
    expect(reply).toMatch(/✓ Tersimpan: "Kantor"/);
    expect(reply).toMatch(/dari posisi terakhir/);
    expect(t.store.places.list()[0]).toMatchObject({ kind: 'office' });

    const list = quickLocation(t.svc, 'daftar tempat');
    expect(list).toMatch(/Tempat tersimpan \(1\)/);
    expect(list).toMatch(/Kantor/);
    expect(listPlacesText(t.svc, 'kantor')).toMatch(/Kantor/);
    expect(listPlacesText(t.svc, 'zzz')).toMatch(/Tidak ada tempat yang cocok/);
  });

  it('never turns a memory note into a place, and says when a name is not saved yet', () => {
    const t = build();
    // No location reference: this belongs to the personal-memory intents.
    expect(quickLocation(t.svc, 'catat tempat parkir lantai 3')).toBeNull();
    expect(quickLocation(t.svc, 'simpan catatan rapat besok')).toBeNull();

    // Asking about an unsaved place explains how to save it — it is not guessed.
    const guidance = quickLocation(t.svc, 'di mana rumah?');
    expect(guidance).toMatch(/Belum ada tempat bernama "rumah" yang tersimpan/);
    expect(guidance).toMatch(/bagikan lokasi \(pin\)/);

    // A name is required: a valid source without a name asks for it.
    quickLocationPin(t.svc, { chatId: '9', lat: -6.2, lon: 106.8 });
    expect(quickLocation(t.svc, 'simpan lokasi ini', { chatId: '9' })).toMatch(/Namanya apa\?/);
    expect(t.store.places.list()).toHaveLength(0);
  });
});

describe('simulated ride generator', () => {
  it('produces a plausible, clearly-synthetic track', () => {
    const ride1 = makeSimulatedRide({ points: 30 });
    expect(ride1).toHaveLength(30);
    expect(ride1.every((p) => p.source === 'sim')).toBe(true);
    const len = pathLengthM(ride1);
    expect(len).toBeGreaterThan(300);
    expect(ride1[0].ts).toBeLessThan(ride1[29].ts);
    expect(distanceToFenceM(ride1[10].lat, ride1[10].lon, ride1[10].lat, ride1[10].lon, 100)).toBeLessThan(0);
  });
});
