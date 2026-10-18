/**
 * src/location/routes.js
 *
 * REST + realtime (SSE) API for tracking.
 *
 * Two different access rules live in this one router, and the ORDER matters:
 *
 *   1. /device/* — the phone tracker. Authenticated with a per-device token
 *      (X-Device-Token), NOT with AUTOMATION_TOKEN: the phone is not on
 *      localhost, and the owner's automation token must never be embedded in a
 *      phone app. Registered BEFORE the guard below.
 *   2. Everything else — the owner's dashboard. localhost, or AUTOMATION_TOKEN
 *      over the network (createAccessGuard), same as every other module. Raw
 *      coordinates are personal data.
 *
 *   GET    /overview  /status  /day  /range  /stops  /places  /devices  /privacy
 *   GET    /events                      SSE (live position, trips, stops, notices)
 *   POST   /session/start|pause|resume|stop
 *   POST   /stops/:id/correct           "ini warung Bu Yati"
 *   POST   /places            PATCH /places/:id    DELETE /places/:id
 *   POST   /devices           DELETE /devices/:id  (revoke token)
 *   GET/PUT /settings
 *   POST   /privacy/purge               delete data ranges (confirm: "HAPUS")
 *   POST   /simulate/ride               deterministic synthetic ride, source "sim"
 *
 * @author Wisnu Alfian Nur Ashar
 */

import express from 'express';
import crypto from 'node:crypto';
import { createAccessGuard, issueStreamTicket } from '../automation/routes.js';
import { LocationError } from './service.js';
import { hashToken } from './store.js';
import { PLACE_KINDS } from './classify.js';

const STATUS_FOR_CODE = {
  not_found: 404,
  bad_state: 409,
  disabled: 403,
  bad_request: 400,
};

const BOOL = (v) => (v === true || v === 'true' || v === 1 || v === '1');
const INT = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(max, Math.max(min, n)));
};

/** Whitelist + clamp every settings key: a typo must never disable a privacy switch by accident. */
export function sanitizeLocationSettings(patch = {}) {
  const out = {};
  const allowedInts = {
    adaptiveIntervalMs: [3_000, 600_000],
    idleIntervalMs: [5_000, 3_600_000],
    minMoveM: [0, 500],
    maxAccuracyM: [10, 5_000],
    accuracyWarnM: [5, 2_000],
    staleAfterMs: [30_000, 86_400_000],
    tripStartMoveM: [50, 10_000],
    stopMinMs: [30_000, 6 * 3_600_000],
    tripEndStopMs: [60_000, 6 * 3_600_000],
    sampleRetentionDays: [0, 3650],
    tripRetentionDays: [0, 3650],
  };
  for (const [k, [min, max]] of Object.entries(allowedInts)) {
    if (patch[k] !== undefined) {
      const n = INT(patch[k], min, max);
      if (n == null) throw new LocationError(`Nilai ${k} tidak valid.`, 'bad_request');
      out[k] = n;
    }
  }
  if (patch.tripStartSpeedMps !== undefined) {
    const n = Number(patch.tripStartSpeedMps);
    if (!Number.isFinite(n) || n < 0 || n > 30) throw new LocationError('tripStartSpeedMps tidak valid.', 'bad_request');
    out.tripStartSpeedMps = n;
  }
  if (patch.enabled !== undefined) out.enabled = BOOL(patch.enabled);
  if (patch.notify && typeof patch.notify === 'object') {
    const n = {};
    for (const key of ['tripStart', 'tripEnd', 'arrival', 'unknownStop', 'longStop', 'quietHours']) {
      if (patch.notify[key] !== undefined) n[key] = BOOL(patch.notify[key]);
    }
    if (patch.notify.maxPerHour !== undefined) {
      const v = INT(patch.notify.maxPerHour, 0, 60);
      if (v == null) throw new LocationError('maxPerHour tidak valid.', 'bad_request');
      n.maxPerHour = v;
    }
    out.notify = n;
  }
  if (patch.geocode && typeof patch.geocode === 'object') {
    const g = {};
    if (patch.geocode.enabled !== undefined) g.enabled = BOOL(patch.geocode.enabled);
    if (patch.geocode.poiSearch !== undefined) g.poiSearch = BOOL(patch.geocode.poiSearch);
    if (patch.geocode.minIntervalMs !== undefined) {
      const v = INT(patch.geocode.minIntervalMs, 1_000, 60_000);
      if (v == null) throw new LocationError('minIntervalMs tidak valid.', 'bad_request');
      g.minIntervalMs = v;
    }
    if (patch.geocode.cacheDays !== undefined) {
      const v = INT(patch.geocode.cacheDays, 1, 365);
      if (v == null) throw new LocationError('cacheDays tidak valid.', 'bad_request');
      g.cacheDays = v;
    }
    out.geocode = g;
  }
  return out;
}

/** Deterministic synthetic ride used by the "Uji pelacakan" button and tests. */
export function makeSimulatedRide({ startLat = -6.2383, startLon = 106.9756, points = 60, stepS = 8, speedMps = 7.5 } = {}) {
  const out = [];
  const end = Date.now();
  const start = end - (points - 1) * stepS * 1000;
  for (let i = 0; i < points; i++) {
    // ~0.00001 deg lon ≈ 1.1 m at the equator; move east, then a gentle arc.
    const t = i / Math.max(1, points - 1);
    out.push({
      ts: start + i * stepS * 1000,
      lat: startLat + t * 0.006 * Math.sin(t * Math.PI),   // a curved track
      lon: startLon + t * 0.012,
      accuracy: 12,
      speed: i === 0 || i === points - 1 ? 0 : speedMps,
      heading: 90,
      battery: 78 - Math.round(t * 6),
      source: 'sim',
    });
  }
  return out;
}

export function createLocationRouter({ location, emergency = null, rateLimiters = {}, env = process.env }) {
  const store = location.store;
  const svc = location.service;
  const router = express.Router();

  const fail = (res, err) => {
    if (err instanceof LocationError) {
      return res.status(STATUS_FOR_CODE[err.code] || 400).json({ success: false, error: err.message, code: err.code });
    }
    console.error('[LOCATION] route error:', err);
    return res.status(500).json({ success: false, error: 'Kesalahan internal modul lokasi' });
  };
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) { fail(res, err); }
  };

  // ============================ DEVICE (token) ==============================
  // The phone client authenticates with its own token. This must be registered
  // BEFORE the owner guard, or a phone on mobile data would be locked out.

  const deviceOf = (req) => {
    const token = String(req.headers['x-device-token'] || req.query?.token || '');
    if (!token) return null;
    return store.devices.byTokenHash(hashToken(token));
  };

  const deviceAuth = (req, res, next) => {
    const device = deviceOf(req);
    if (!device) {
      return res.status(401).json({ success: false, code: 'device_token_required', error: 'Token perangkat tidak dikenal atau sudah dicabut.' });
    }
    req.device = device;
    return next();
  };

  router.post('/device/ingest', deviceAuth, wrap((req, res) => {
    const body = req.body || {};
    const samples = Array.isArray(body.samples) ? body.samples : (body.sample ? [body.sample] : []);
    if (!samples.length) throw new LocationError('Tidak ada titik lokasi yang dikirim.', 'bad_request');
    const result = svc.ingest(samples, {
      sessionId: body.sessionId || body.session_id || null,
      deviceId: req.device.id,
      label: body.label || req.device.name,
    });
    res.json({ success: true, ...result, hint: svc.currentStatus().hint });
  }));

  router.get('/device/hint', deviceAuth, wrap((req, res) => {
    const st = svc.currentStatus();
    res.json({ success: true, hint: st.hint, tracking: st.tracking, device: { id: req.device.id, name: req.device.name } });
  }));

  // Everything the phone tracker needs in one poll: sampling hint, tracking
  // state, and whether an emergency is waiting for the owner's answer on this
  // device (so the countdown can be answered from the phone itself).
  router.get('/device/status', deviceAuth, wrap((req, res) => {
    const st = svc.currentStatus();
    const open = emergency ? emergency.service.store.events.openOne() : null;
    res.json({
      success: true,
      hint: st.hint,
      tracking: st.tracking,
      device: { id: req.device.id, name: req.device.name },
      emergency: open
        ? {
          eventId: open.id,
          status: open.status,
          mode: emergency.service.effectiveMode(),
          confirmDeadline: open.confirm_deadline,
          trigger: open.trigger?.summary || null,
        }
        : null,
    });
  }));

  router.post('/device/sos', deviceAuth, wrap((req, res) => {
    if (!emergency) throw new LocationError('Modul darurat tidak aktif di server ini.', 'bad_state');
    const event = emergency.service.sos({
      note: req.body?.note || 'tombol darurat dari perangkat',
      deviceId: req.device.id,
      sessionId: req.body?.sessionId || null,
    });
    res.status(201).json({ success: true, event: emergency.service.store.events.get(event.id) });
  }));

  router.post('/device/respond', deviceAuth, wrap((req, res) => {
    if (!emergency) throw new LocationError('Modul darurat tidak aktif di server ini.', 'bad_state');
    const open = emergency.service.store.events.openOne();
    if (!open) throw new LocationError('Tidak ada kejadian darurat yang menunggu jawaban.', 'not_found');
    const updated = emergency.service.respond(open.id, req.body?.answer);
    res.json({ success: true, event: updated });
  }));

  // ========================== OWNER DASHBOARD ==============================

  router.use(createAccessGuard(env));
  const noop = (req, res, next) => next();
  const act = rateLimiters.automation || noop;

  router.get('/stream-ticket', (req, res) => {
    const secret = String(env.AUTOMATION_TOKEN || '');
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ticket: secret ? issueStreamTicket(secret) : null });
  });

  router.get('/status', wrap((req, res) => res.json({ success: true, status: svc.currentStatus() })));

  router.get('/overview', wrap((req, res) => {
    const st = svc.currentStatus();
    const day = svc.daySummary(req.query.date || svc.today());
    res.json({
      success: true,
      status: st,
      day: {
        date: day.date,
        distanceM: day.distanceM,
        trips: day.trips.length,
        stops: day.stops.length,
        movingS: day.movingS,
        timeline: day.timeline,
        dataQuality: day.dataQuality,
      },
      settings: svc.settings(),
      places: store.places.list(),
      devices: store.devices.list(),
      geocoder: { configured: Boolean(svc.geocoder), provider: 'OpenStreetMap (Nominatim + Overpass), gratis tanpa kunci API' },
      emergency: emergency ? emergency.service.status() : null,
      counts: store.privacy.stats(),
      notices: store.notices.list(8),
    });
  }));

  router.get('/day', wrap((req, res) => res.json({ success: true, day: svc.daySummary(req.query.date || svc.today()) })));
  router.get('/range', wrap((req, res) => {
    const to = req.query.to || svc.today();
    const from = req.query.from || to;
    res.json({ success: true, ...svc.rangeSummary(from, to) });
  }));
  router.get('/where-was-i', wrap((req, res) => res.json({ success: true, ...svc.whereWasI(req.query.date || svc.today()) })));

  router.get('/trips', wrap((req, res) => {
    const limit = INT(req.query.limit, 1, 500) || 50;
    res.json({ success: true, trips: store.trips.recent(limit) });
  }));

  router.get('/trips/:id', wrap((req, res) => {
    const trip = store.trips.get(req.params.id);
    if (!trip) throw new LocationError('Perjalanan tidak ditemukan.', 'not_found');
    const samples = store.samples.inWindow(trip.started_at, trip.ended_at || Date.now(), 20000)
      .map((s) => ({ ts: s.ts, lat: s.lat, lon: s.lon, accuracy: s.accuracy, speed: s.speed }));
    res.json({ success: true, trip, samples, stops: store.stops.forTrip(trip.id) });
  }));

  router.get('/stops', wrap((req, res) => {
    const rows = req.query.date ? store.stops.forDate(req.query.date) : store.stops.recentReal(100);
    res.json({ success: true, stops: rows });
  }));

  router.post('/stops/:id/correct', act, wrap((req, res) => {
    const b = req.body || {};
    if (b.kind && !PLACE_KINDS.includes(b.kind)) throw new LocationError(`Kategori "${b.kind}" tidak dikenal.`, 'bad_request');
    const updated = svc.correctStop(req.params.id, {
      kind: b.kind || null,
      label: b.label ? String(b.label).slice(0, 120) : null,
      savePlace: BOOL(b.savePlace),
      radiusM: INT(b.radiusM, 25, 2000) || 120,
      note: b.note || null,
    });
    res.json({ success: true, stop: updated });
  }));

  // --------------------------------------------------------------- sessions
  router.post('/session/start', act, wrap((req, res) => {
    const s = svc.startSession({ label: req.body?.label || 'dinyalakan dari dashboard', consent: req.body?.consent || null });
    res.status(201).json({ success: true, session: s });
  }));
  router.post('/session/pause', act, wrap((req, res) => res.json({ success: true, session: svc.pauseSession(req.body?.id || null) })));
  router.post('/session/resume', act, wrap((req, res) => res.json({ success: true, session: svc.resumeSession(req.body?.id || null) })));
  router.post('/session/stop', act, wrap((req, res) => res.json({ success: true, session: svc.stopSession(req.body?.id || null, { reason: 'dashboard' }) })));
  router.get('/sessions', wrap((req, res) => res.json({ success: true, sessions: store.sessions.list(INT(req.query.limit, 1, 200) || 50) })));

  // ----------------------------------------------------------------- places
  router.get('/places', wrap((req, res) => res.json({ success: true, places: store.places.list({ includeInactive: BOOL(req.query.all) }) })));
  router.post('/places', act, wrap((req, res) => {
    const b = req.body || {};
    const lat = Number(b.lat);
    const lon = Number(b.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new LocationError('Koordinat tempat tidak valid.', 'bad_request');
    }
    if (!b.name) throw new LocationError('Nama tempat wajib diisi.', 'bad_request');
    if (b.kind && !PLACE_KINDS.includes(b.kind)) throw new LocationError(`Kategori "${b.kind}" tidak dikenal.`, 'bad_request');
    const place = store.places.create({
      name: String(b.name).slice(0, 120),
      kind: b.kind || 'public',
      lat,
      lon,
      radiusM: INT(b.radiusM, 25, 2000) || 120,
      source: 'user',
      confirmState: b.confirmState === 'suggested' ? 'suggested' : 'confirmed',
      aliases: Array.isArray(b.aliases) ? b.aliases.slice(0, 10).map((a) => String(a).slice(0, 60)) : null,
      geohash: null,
    });
    res.status(201).json({ success: true, place });
  }));
  router.patch('/places/:id', act, wrap((req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) patch.name = String(b.name).slice(0, 120);
    if (b.kind !== undefined) {
      if (!PLACE_KINDS.includes(b.kind)) throw new LocationError(`Kategori "${b.kind}" tidak dikenal.`, 'bad_request');
      patch.kind = b.kind;
    }
    if (b.radiusM !== undefined) patch.radius_m = INT(b.radiusM, 25, 2000) || 120;
    if (b.confirmState !== undefined && ['confirmed', 'suggested', 'rejected'].includes(b.confirmState)) patch.confirm_state = b.confirmState;
    if (b.active !== undefined) patch.active = BOOL(b.active) ? 1 : 0;
    const place = store.places.update(req.params.id, patch);
    if (!place) throw new LocationError('Tempat tidak ditemukan.', 'not_found');
    res.json({ success: true, place });
  }));
  router.delete('/places/:id', act, wrap((req, res) => {
    const ok = store.places.remove(req.params.id);
    if (!ok) throw new LocationError('Tempat tidak ditemukan.', 'not_found');
    res.json({ success: true });
  }));

  // ---------------------------------------------------------------- devices
  router.get('/devices', wrap((req, res) => res.json({ success: true, devices: store.devices.list() })));
  router.post('/devices', act, wrap((req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) throw new LocationError('Beri nama perangkat (mis. "HP Vivo Y17s").', 'bad_request');
    const created = store.devices.create({ name, os: req.body?.os || null, note: req.body?.note || null });
    // The plaintext token is returned exactly once; only its SHA-256 is stored.
    res.status(201).json({
      success: true,
      device: created.device,
      token: created.token,
      warning: 'Token ini hanya ditampilkan sekali. Simpan di aplikasi pelacak; server hanya menyimpan hash-nya.',
    });
  }));
  router.delete('/devices/:id', act, wrap((req, res) => {
    const device = store.devices.revoke(req.params.id);
    if (!device) throw new LocationError('Perangkat tidak ditemukan.', 'not_found');
    res.json({ success: true, device });
  }));

  // --------------------------------------------------------------- settings
  router.get('/settings', wrap((req, res) => res.json({ success: true, settings: svc.settings() })));
  router.put('/settings', act, wrap((req, res) => {
    const clean = sanitizeLocationSettings(req.body || {});
    res.json({ success: true, settings: svc.updateSettings(clean) });
  }));

  // ---------------------------------------------------------------- privacy
  router.get('/privacy', wrap((req, res) => {
    res.json({ success: true, stats: store.privacy.stats(), settings: svc.settings(), events: store.events.recent(30) });
  }));
  router.post('/privacy/purge', act, wrap((req, res) => {
    if (req.body?.confirm !== 'HAPUS') throw new LocationError('Konfirmasi diperlukan: kirim {"confirm":"HAPUS"}.', 'bad_request');
    const days = INT(req.body?.olderThanDays, 1, 36500);
    if (!days) throw new LocationError('olderThanDays tidak valid.', 'bad_request');
    const ts = Date.now() - days * 86_400_000;
    const samples = store.privacy.deleteSamplesBefore(ts);
    const trips = store.privacy.deleteTripsBefore(new Date(ts).toLocaleDateString('en-CA'));
    store.events.log({ kind: 'privacy_purge', data: { olderThanDays: days, samples, trips } });
    res.json({ success: true, removed: { samples, trips } });
  }));
  router.post('/privacy/reset', act, wrap((req, res) => {
    if (req.body?.confirm !== 'HAPUS SEMUA') throw new LocationError('Konfirmasi diperlukan: kirim {"confirm":"HAPUS SEMUA"}.', 'bad_request');
    store.privacy.reset();
    store.events.log({ kind: 'privacy_reset' });
    res.json({ success: true, removed: 'seluruh riwayat lokasi dihapus (pengaturan, tempat, dan perangkat dipertahankan)' });
  }));

  // -------------------------------------------------------------- simulation
  router.post('/simulate/ride', act, wrap((req, res) => {
    if (store.sessions.active()?.status === 'active') {
      throw new LocationError('Ada sesi pelacakan aktif. Hentikan dulu agar data simulasi tidak tercampur data nyata.', 'bad_state');
    }
    const ride = makeSimulatedRide({
      startLat: Number.isFinite(Number(req.body?.lat)) ? Number(req.body.lat) : -6.2383,
      startLon: Number.isFinite(Number(req.body?.lon)) ? Number(req.body.lon) : 106.9756,
      points: INT(req.body?.points, 20, 400) || 60,
    });
    const session = svc.startSession({ label: 'simulasi (data sintetis, bukan GPS nyata)' });
    // Feed in two batches so the trip state machine sees a start and a movement.
    const half = Math.ceil(ride.length / 2);
    const first = svc.ingest(ride.slice(0, half), { sessionId: session.id });
    const r = svc.ingest(ride.slice(half), { sessionId: session.id });
    res.json({
      success: true,
      sessionId: session.id,
      inserted: first.inserted + r.inserted,
      note: 'Titik ini data sintetis (source "sim") untuk menguji alur; bukan pelacakan GPS nyata.',
      status: svc.currentStatus(),
    });
  }));

  // ---------------------------------------------------------------- realtime
  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    const send = (e) => { try { res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`); } catch { /* client closed */ } };
    svc.on('change', send);
    const hb = setInterval(() => { try { res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`); } catch { /* closed */ } }, 20_000);
    req.on('close', () => { clearInterval(hb); svc.off('change', send); });
  });

  return router;
}

/** Tests: a stable way to build a unique-ish ingest payload without a live device. */
export function simulateDeviceToken() {
  return `loc_${crypto.randomBytes(6).toString('base64url')}`;
}
