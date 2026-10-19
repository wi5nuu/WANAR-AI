/**
 * src/location/service.js
 *
 * The tracking engine: it turns a stream of GPS fixes into trips, stops and
 * daily activity that the rest of the system (AI chat, dashboard, notices) can
 * ask about. Everything is deterministic code — the AI never computes a
 * distance, it reads one.
 *
 * Pipeline per incoming batch (all of it inside `ingest`):
 *   validate → filter jitter/duplicates → store → run the trip state machine
 *   → close/open stops → emit realtime changes → (async) classify closed stops
 *   → emit (deduplicated) notices the owner asked for.
 *
 * Deliberate behaviours:
 *   - A trip is a movement between two dwell points, not "anything with speed".
 *   - A stop shorter than `stopMinMs` is traffic, not an activity.
 *   - Classification never invents a place: unknown stays unknown, with the
 *     coordinates, accuracy and duration stored next to it.
 *   - Distance here is GPS trajectory distance. It is NOT the odometer, and
 *     both numbers are presented as different things everywhere.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { EventEmitter } from 'node:events';
import {
  filterSamples, haversineM, movementState, pathLengthM, speedStats, geohash, formatDistance,
} from './geo.js';
import { classifyStop, shouldKeepStop, KIND_LABELS } from './classify.js';
import { localDate, localTime, dayBounds, addDays } from '../worklog/time.js';
import { inQuietHours } from '../career/service.js';

/** Never let one batch create an unbounded transaction. */
const MAX_BATCH = 500;
const RECENT_WINDOW = 150;        // samples used to rebuild state after a restart
const PENDING_PIN_TTL_MS = 15 * 60_000; // a shared chat pin waits this long to be named

export class LocationError extends Error {
  constructor(message, code = 'bad_request') {
    super(message);
    this.name = 'LocationError';
    this.code = code;
  }
}

export class LocationService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.store
   * @param {object} [deps.geocoder]
   * @param {Function} [deps.now]
   * @param {object} [deps.env]
   * @param {Function} [deps.deliver] async ({kind, text, priority}) => {channel, ok, error}
   * @param {Function} [deps.memory]  hook: (correction) => void  (personal memory)
   * @param {Function} [deps.onSamples] hook for the emergency detector
   */
  constructor({ store, geocoder = null, now = () => Date.now(), env = process.env, deliver = null, memory = null, onSamples = null }) {
    super();
    this.store = store;
    this.geocoder = geocoder;
    this.now = now;
    this.env = env;
    this.deliver = deliver;
    this.memory = memory;
    this.onSamples = onSamples;
    this._timer = null;
    this._ticking = false;
    this._enrichQueue = new Set();
    // Location pins shared in chat, waiting for the owner to name them. Kept in
    // memory only: nothing is written until the place has a name.
    this._pendingPins = new Map();
  }

  settings() { return this.store.settings.get(); }
  updateSettings(patch) {
    const s = this.store.settings.set(patch || {});
    this._changed('settings');
    this.store.events.log({ kind: 'settings_updated', data: { keys: Object.keys(patch || {}) } });
    return s;
  }

  _changed(kind, data = {}) {
    try { this.emit('change', { kind, ts: this.now(), ...data }); } catch { /* listeners are optional */ }
  }

  today() { return localDate(this.now()); }

  // ------------------------------------------------------------------ sessions

  startSession({ deviceId = null, label = null, consent = null, startedAt = null } = {}) {
    const s = this.settings();
    if (!s.enabled) throw new LocationError('Pelacakan lokasi sedang dimatikan di pengaturan privasi.', 'disabled');
    const open = this.store.sessions.active();
    if (open) {
      if (open.status === 'paused') return this.resumeSession(open.id);
      return open; // one open session at a time; starting again is a no-op, not a duplicate
    }
    const session = this.store.sessions.create({
      deviceId, label, startedAt: startedAt || this.now(),
      consent: consent || {
        at: this.now(),
        text: 'Pengguna menyalakan pelacakan lokasi dari aplikasi Wanar AI (persetujuan eksplisit per sesi).',
      },
    });
    this.store.events.log({ kind: 'session_started', sessionId: session.id, deviceId, data: { label } });
    this._changed('session', { sessionId: session.id, status: session.status });
    return session;
  }

  pauseSession(id = null) {
    const s = this.store.sessions.active();
    const target = id ? this.store.sessions.get(id) : s;
    if (!target) throw new LocationError('Tidak ada sesi pelacakan yang aktif.', 'not_found');
    const out = this.store.sessions.setStatus(target.id, 'paused');
    this.store.events.log({ kind: 'session_paused', sessionId: target.id });
    this._changed('session', { sessionId: target.id, status: 'paused' });
    return out;
  }

  resumeSession(id = null) {
    const target = id ? this.store.sessions.get(id) : this.store.sessions.active();
    if (!target) throw new LocationError('Tidak ada sesi pelacakan untuk dilanjutkan.', 'not_found');
    if (target.status === 'stopped') throw new LocationError('Sesi ini sudah dihentikan. Mulai sesi baru.', 'bad_state');
    const out = this.store.sessions.setStatus(target.id, 'active');
    this.store.events.log({ kind: 'session_resumed', sessionId: target.id });
    this._changed('session', { sessionId: target.id, status: 'active' });
    return out;
  }

  stopSession(id = null, { reason = 'user' } = {}) {
    const target = id ? this.store.sessions.get(id) : this.store.sessions.active();
    if (!target) throw new LocationError('Tidak ada sesi pelacakan yang aktif.', 'not_found');
    this.closeOpenStop(target.id, { at: this.now(), reason: 'tracking berhenti' });
    const openTrip = this.store.trips.openTrip();
    if (openTrip) this.closeTrip(openTrip, { at: this.now(), reason: 'tracking berhenti' });
    const out = this.store.sessions.setStatus(target.id, 'stopped');
    this.store.events.log({ kind: 'session_stopped', sessionId: target.id, data: { reason } });
    this._changed('session', { sessionId: target.id, status: 'stopped' });
    return out;
  }

  // ------------------------------------------------------------------- ingest

  /**
   * Accepts a batch of fixes from a device.
   * @param {Array} batch
   * @param {object} ctx { sessionId, deviceId, source }
   */
  ingest(batch, ctx = {}) {
    const s = this.settings();
    if (!s.enabled) throw new LocationError('Pelacakan dimatikan; data tidak disimpan.', 'disabled');
    const list = Array.isArray(batch) ? batch.slice(0, MAX_BATCH) : [];
    if (!list.length) throw new LocationError('Tidak ada titik lokasi yang dikirim.', 'bad_request');

    let session = ctx.sessionId ? this.store.sessions.get(ctx.sessionId) : null;
    if (session && session.status !== 'active') throw new LocationError('Sesi pelacakan sedang dijeda atau sudah berhenti.', 'bad_state');
    if (!session) session = this.startSession({ deviceId: ctx.deviceId || null, label: ctx.label || null });

    const prev = this.store.samples.last(session.id);
    const { accepted, dropped } = filterSamples(list, prev, {
      minMoveM: s.minMoveM,
      maxAccuracyM: Math.max(s.maxAccuracyM, 500), // store the fix, but quality flags it (below)
      now: this.now(),
    });
    if (!accepted.length) {
      // The phone re-sent a batch we already hold (older timestamps / same
      // fixes). Report those as duplicates instead of silently "dropping" them.
      const already = (dropped.duplicate || 0) + (dropped.out_of_order || 0);
      this._changed('samples_dropped', { sessionId: session.id, dropped });
      return { inserted: 0, duplicates: already, dropped, sessionId: session.id, tripId: null, stopId: null };
    }

    const { inserted, duplicates } = this.store.samples.insertMany(session.id, ctx.deviceId || session.device_id, accepted);
    if (ctx.deviceId) this.store.devices.touch(ctx.deviceId);

    const machine = this._advance(session, { accepted });
    const last = this.store.samples.last(session.id);
    // Geofence transitions ("tiba di Kantor", "meninggalkan Rumah") are
    // recomputed from the stored history plus this batch, so a server restart
    // changes nothing and a phone retry (dropped as duplicates earlier) cannot
    // double-fire.
    try { this._detectPlaceTransitions(prev, accepted); } catch { /* notices are best effort */ }

    this._changed('samples', {
      sessionId: session.id,
      inserted,
      lastTs: last?.ts || null,
      tripId: machine.tripId,
      stopId: machine.stopId,
    });
    try { this.onSamples?.({ sessionId: session.id, samples: accepted, state: machine }); } catch { /* emergency detection is best effort here */ }

    return { inserted, duplicates, dropped, sessionId: session.id, tripId: machine.tripId, stopId: machine.stopId };
  }

  /**
   * The trip state machine. Uses only recent samples (indexed query) so it is
   * correct after a server restart, with no hidden in-memory state.
   */
  _advance(session, { accepted }) {
    const s = this.settings();
    const last = accepted[accepted.length - 1];
    const lastTs = last.ts;
    // The phone clock may run slightly ahead of the server (validation allows up
    // to +10 min). Bound the window by the newest accepted fix, never by the
    // server clock alone — otherwise the newest point is invisible to the
    // state machine and a stop can close with zero duration.
    const upper = Math.max(this.now(), lastTs) + 1;
    const recent = this.store.samples.range(session.id, 0, upper, RECENT_WINDOW).slice(-RECENT_WINDOW);

    // Stationary streak: how long has the vehicle not moved?
    let lastMovingTs = null;
    for (const smp of recent) if (smp.moved) lastMovingTs = smp.ts;

    const openStopRow = this.store.stops.open();
    const openTripRow = this.store.trips.openTrip();
    let tripId = openTripRow?.id || null;
    let stopId = openStopRow?.id || null;

    const stationaryFor = lastMovingTs ? lastTs - lastMovingTs : null;

    // 1) Movement resumed after a real stop → close the open stop and classify it.
    if (openStopRow && last.moved) {
      const closed = this.closeOpenStop(session.id, { at: lastMovingTs || openStopRow.started_at, reason: 'bergerak lagi' });
      stopId = null;
      if (closed) this.enqueueClassification(closed.id);
    }

    // 2) Trip open and the vehicle has stood still long enough → close the trip and DWELL.
    if (openTripRow && lastMovingTs && lastTs - lastMovingTs >= s.tripEndStopMs) {
      const closedTrip = this.closeTrip(openTripRow, { at: lastMovingTs });
      tripId = null;
      const stop = this.openStop({
        sessionId: session.id,
        tripId: closedTrip.id,
        at: lastMovingTs,
        lat: last.lat,
        lon: last.lon,
        accuracy: last.accuracy,
      });
      stopId = stop?.id || null;
      const dur = Math.round((lastTs - lastMovingTs) / 60000);
      this._notice('longStop', `Berhenti ${dur} menit di sekitar lokasi terakhir. Belum ada bukti tempat apa ini.`, `stop:${closedTrip.id}:${lastMovingTs}`);
    }

    // 3) No trip open and the vehicle is moving away → open a trip at the departure point.
    if (!tripId && (last.moved || (Number.isFinite(last.speed) && last.speed > s.tripStartSpeedMps))) {
      const from = this._departureReference(session.id, accepted);
      const far = from && haversineM(from.lat, from.lon, last.lat, last.lon) >= s.tripStartMoveM;
      if (far || (Number.isFinite(last.speed) && last.speed > s.tripStartSpeedMps && last.moved)) {
        if (openStopRow) { this.closeOpenStop(session.id, { at: from?.ts || last.ts, reason: 'berangkat' }); stopId = null; }
        const trip = this.store.trips.open({
          startedAt: from?.ts || last.ts,
          lat: from?.lat ?? last.lat,
          lon: from?.lon ?? last.lon,
          date: localDate(from?.ts || last.ts),
          label: this._placeLabelAt(from?.lat ?? last.lat, from?.lon ?? last.lon, from?.accuracy ?? last.accuracy)?.label || null,
        });
        tripId = trip.id;
        this._notice('tripStart', 'Perjalanan dimulai. Titik awal berhasil direkam.', `trip:${trip.id}:start`);
        this._changed('trip_open', { tripId: trip.id });
      }
    }

    // 4) Keep the open trip's totals up to date (distance, speeds, sample count).
    if (tripId) {
      const trip = this.store.trips.get(tripId);
      const rows = this.store.samples.range(session.id, trip.started_at, upper, 20000);
      const movedRows = rows.filter((r) => r.moved);
      const distance = pathLengthM(rows.length ? rows : accepted);
      const stats = speedStats(rows.length >= 2 ? rows : accepted);
      const movingS = movedRows.length >= 2
        ? Math.max(0, Math.round((movedRows[movedRows.length - 1].ts - movedRows[0].ts) / 1000))
        : 0;
      this.store.trips.update(tripId, {
        distance_m: Math.round(distance),
        moving_s: movingS,
        duration_s: Math.max(0, Math.round((lastTs - trip.started_at) / 1000)),
        max_speed_mps: Number(stats.maxMps.toFixed(2)),
        avg_speed_mps: Number(stats.avgMps.toFixed(2)),
        end_lat: last.lat,
        end_lon: last.lon,
        sample_count: rows.length || accepted.length,
      });
    }

    // 5) Sanity: a trip left open with no data for half a day is closed in tick().
    return { tripId, stopId };
  }

  /** The point a trip departed from: the dwell before the movement, or the first new fix. */
  _departureReference(sessionId, accepted) {
    const openStopRow = this.store.stops.open();
    if (openStopRow) return { lat: openStopRow.lat, lon: openStopRow.lon, ts: openStopRow.started_at, accuracy: openStopRow.accuracy };
    const prev = this.store.samples.lastBefore(sessionId, accepted[0].ts);
    if (prev) return { lat: prev.lat, lon: prev.lon, ts: prev.ts, accuracy: prev.accuracy };
    return { lat: accepted[0].lat, lon: accepted[0].lon, ts: accepted[0].ts, accuracy: accepted[0].accuracy };
  }

  openStop({ sessionId, tripId, at, lat, lon, accuracy }) {
    const existing = this.store.stops.open();
    if (existing) return existing;
    const stop = this.store.stops.create({
      tripId: tripId || this.store.trips.openTrip()?.id || null,
      date: localDate(at),
      startedAt: at,
      lat,
      lon,
      accuracy: accuracy ?? null,
      kind: 'unknown',
      label: null,
      confidence: 0,
      source: 'unknown',
      evidence: { sessionId, openedBy: 'state-machine' },
      kept: false,
    });
    this._changed('stop_open', { stopId: stop.id });
    return stop;
  }

  closeOpenStop(sessionId, { at, reason }) {
    const stop = this.store.stops.open();
    if (!stop) return null;
    const ev = stop.evidence || {};
    const closed = this.store.stops.update(stop.id, {
      ended_at: Math.max(stop.started_at, at),
      evidence: { ...ev, closedReason: reason },
    });
    this._changed('stop_closed', { stopId: closed.id });
    return closed;
  }

  closeTrip(trip, { at = null, reason = 'stop' } = {}) {
    const endAt = at || trip.ended_at || this.now();
    const samples = this.store.samples.inWindow(trip.started_at, endAt, 20000);
    const distance = pathLengthM(samples.length ? samples : []);
    const stats = speedStats(samples);
    const quality = this._quality(samples, trip.started_at, endAt);
    const closed = this.store.trips.update(trip.id, {
      ended_at: endAt,
      distance_m: Math.round(distance),
      moving_s: trip.moving_s || Math.round((endAt - trip.started_at) / 1000),
      duration_s: Math.max(0, Math.round((endAt - trip.started_at) / 1000)),
      max_speed_mps: Number((stats.maxMps || trip.max_speed_mps || 0).toFixed(2)),
      avg_speed_mps: Number((stats.avgMps || trip.avg_speed_mps || 0).toFixed(2)),
      end_lat: samples[samples.length - 1]?.lat ?? trip.end_lat,
      end_lon: samples[samples.length - 1]?.lon ?? trip.end_lon,
      sample_count: samples.length || trip.sample_count,
      status: 'closed',
      quality,
    });
    this.store.events.log({ kind: 'trip_closed', data: { tripId: trip.id, reason, distanceM: closed.distance_m } });
    this._changed('trip_closed', { tripId: trip.id, distanceM: closed.distance_m });
    this._notice(
      'tripEnd',
      `Perjalanan selesai: ${formatDistance(closed.distance_m)} dalam ${Math.round(closed.duration_s / 60)} menit (jarak lintasan GPS, bukan odometer).`,
      `trip:${trip.id}:end`
    );
    return closed;
  }

  _quality(samples, from, to) {
    if (samples.length < 2) return { samples: samples.length, gaps: 0, note: 'data GPS sangat sedikit' };
    let gaps = 0;
    let maxGap = 0;
    const accs = samples.map((s) => s.accuracy).filter((a) => Number.isFinite(a) && a > 0);
    for (let i = 1; i < samples.length; i++) {
      const gap = samples[i].ts - samples[i - 1].ts;
      if (gap > 60_000) gaps++;
      if (gap > maxGap) maxGap = gap;
    }
    const avgAcc = accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null;
    const expectedMs = Math.max(1000, this.settings().adaptiveIntervalMs * 2);
    const coverage = Math.min(1, (samples.length * expectedMs) / Math.max(1, to - from));
    return {
      samples: samples.length,
      gaps,
      maxGapMs: maxGap,
      avgAccuracyM: avgAcc ? Math.round(avgAcc) : null,
      coverage: Number(coverage.toFixed(2)),
      note: gaps > 0 ? `${gaps} jeda data GPS > 1 menit (sinyal hilang / ponsel tidak mengirim)` : 'data GPS lengkap',
    };
  }

  // ---------------------------------------------------------- classification

  /** Classify a closed stop asynchronously (network lookups are cached + throttled). */
  enqueueClassification(stopId) {
    if (this._enrichQueue.has(stopId)) return;
    this._enrichQueue.add(stopId);
    setTimeout(() => {
      this.classifyStopById(stopId).catch(() => {}).finally(() => this._enrichQueue.delete(stopId));
    }, 0);
  }

  /** Candidate geofences near a point (uses the index, not a full table scan of distances). */
  _nearbyPlaces(lat, lon, radiusM = 400) {
    const cells = new Set([geohash(lat, lon, 5), geohash(lat, lon, 6), geohash(lat, lon, 7)]);
    const all = this.store.places.list().filter((p) => p.confirm_state !== 'rejected');
    return all.filter((p) => {
      if (p.geohash && cells.has(p.geohash)) return true;
      return haversineM(lat, lon, p.lat, p.lon) <= Math.max(radiusM, p.radius_m + 100);
    });
  }

  /**
   * Fetches and stores the classification of one stop. Safe to call repeatedly:
   * results are cached, and a failed external lookup leaves the stop "unknown"
   * rather than blocking.
   */
  async classifyStopById(stopId, { forceLookup = false } = {}) {
    const stop = this.store.stops.get(stopId);
    if (!stop) return null;
    const s = this.settings();
    const endedAt = stop.ended_at || this.now();
    const durationMs = endedAt - stop.started_at;
    const places = this._nearbyPlaces(stop.lat, stop.lon);
    const history = this._historyFor(stop.lat, stop.lon);

    let poi = [];
    let reverse = null;
    // Geofence / rules that need no network first — a confirmed home/office is answered instantly.
    const quick = classifyStop(
      { lat: stop.lat, lon: stop.lon, accuracy: stop.accuracy, durationMs },
      { places, history },
      s
    );
    if (quick.source === 'geofence' && !quick.uncertain) {
      return this._saveClassification(stop, quick, { radiusM: places.find((p) => p.name === quick.label)?.radius_m });
    }
    if (this.geocoder && (s.geocode.enabled || forceLookup)) {
      try { reverse = await this.geocoder.reverse(stop.lat, stop.lon); } catch { reverse = null; }
      try { poi = await this.geocoder.nearbyPoi(stop.lat, stop.lon, 200); } catch { poi = []; }
    }
    const result = classifyStop(
      { lat: stop.lat, lon: stop.lon, accuracy: stop.accuracy, durationMs },
      { places, history, poi, reverse },
      s
    );
    const save = { ...result };
    if ((save.kind === 'unknown' || save.confidence < 0.35) && poi.length) {
      save.reasons = [...save.reasons, `${poi.length} POI ditemukan dalam radius 200 m tetapi tidak ada yang cukup dekat untuk diklaim`];
    }
    save.reasons = [...save.reasons, `durasi ${Math.round(durationMs / 60000)} menit, akurasi GPS ${stop.accuracy != null ? `±${Math.round(stop.accuracy)} m` : 'tidak dilaporkan'}`];
    return this._saveClassification(stop, save, { radiusM: places.find((p) => p.name === save.label)?.radius_m });
  }

  _saveClassification(stop, classification, { radiusM = null } = {}) {
    const s = this.settings();
    const endedAt = stop.ended_at || this.now();
    const durationMs = Math.max(0, endedAt - stop.started_at);
    const { kept, reason } = shouldKeepStop({ ...stop, durationMs }, classification, s);
    const place = classification.source === 'geofence' && classification.label
      ? this.store.places.list().find((p) => p.name === classification.label) || null
      : null;
    const updated = this.store.stops.update(stop.id, {
      kind: classification.kind,
      label: classification.label || null,
      confidence: classification.confidence,
      source: classification.source,
      place_id: place?.id || null,
      evidence: {
        ...(stop.evidence || {}),
        reasons: classification.reasons,
        alternatives: classification.alternatives,
        uncertain: classification.uncertain,
        keptReason: reason,
        radiusM,
      },
      kept,
    });
    if (place) this.store.places.visit(place.id, endedAt);
    this._changed('stop_classified', { stopId: stop.id, kind: updated.kind, kept });
    return updated;
  }

  /** History for a cell: names/kinds of stops within ~200 m that were kept. */
  _historyFor(lat, lon) {
    const visitedNames = {};
    const visitedKinds = {};
    try {
      const recent = this.store.stops.recentReal(200);
      for (const r of recent) {
        if (!r.label && !r.kind) continue;
        if (haversineM(lat, lon, r.lat, r.lon) > 200) continue;
        const label = r.corrected_label || r.label;
        const kind = r.corrected_kind || r.kind;
        if (label) visitedNames[label] = (visitedNames[label] || 0) + 1;
        if (kind) visitedKinds[kind] = (visitedKinds[kind] || 0) + 1;
      }
    } catch { /* history is an optimisation, never a hard dependency */ }
    return { visitedNames, visitedKinds };
  }

  /**
   * Public: the geofence (if any) covering a point, with no network call.
   * Used by the emergency path (a crash at home is treated differently) and by
   * the dashboard. Returns null when no confirmed place matches — never guesses.
   */
  placeAt(lat, lon, accuracy = null) { return this._placeLabelAt(lat, lon, accuracy); }

  /** Converts a known place into a candidate label without any network call (live UI). */
  _placeLabelAt(lat, lon, accuracy) {
    let best = null;
    for (const p of this._nearbyPlaces(lat, lon)) {
      const d = haversineM(lat, lon, p.lat, p.lon);
      if (d <= p.radius_m && (best == null || d - p.radius_m < best.slack)) best = { place: p, d, slack: d - p.radius_m };
    }
    if (!best) return null;
    return {
      label: best.place.name,
      kind: best.place.kind,
      confidence: 0.9,
      source: 'geofence',
      accuracy,
      placeId: best.place.id,
      distanceM: Math.round(best.d),
      radiusM: best.place.radius_m,
    };
  }

  /**
   * Which known place a fix is inside — with hysteresis so a single noisy GPS
   * point can never report "left home": while the previous fix was inside a
   * place, leaving requires being clearly outside it (radius + accuracy slack).
   * Entering a place whose fence is narrower than the GPS error is refused:
   * a ±200 m fix proves nothing about a 120 m area.
   */
  _fenceState(lat, lon, accuracy = null, prevPlaceId = null) {
    let best = null;
    for (const p of this._nearbyPlaces(lat, lon)) {
      const d = haversineM(lat, lon, p.lat, p.lon);
      if (d <= p.radius_m && (best == null || d - p.radius_m < best.slack)) best = { place: p, d, slack: d - p.radius_m };
    }
    if (best) {
      const acc = Number.isFinite(accuracy) ? accuracy : null;
      if (prevPlaceId !== best.place.id && acc != null && acc > best.place.radius_m * 2) return null;
      return { place: best.place, distanceM: Math.round(best.d), inside: true };
    }
    if (prevPlaceId) {
      const prev = this.store.places.get(prevPlaceId);
      if (prev) {
        const d = haversineM(lat, lon, prev.lat, prev.lon);
        const margin = Math.max(30, Number.isFinite(accuracy) ? accuracy : 0);
        if (d <= prev.radius_m + margin) return { place: prev, distanceM: Math.round(d), inside: true, hysteresis: true };
      }
    }
    return null;
  }

  /**
   * Emits "arrived at / left <place>" notices and events for one batch. The
   * starting fence state is rebuilt by replaying the previous 30 minutes of
   * stored fixes with the same hysteresis, so a restart — or an edge-of-fence
   * fix — can never flip the state. Pure function of the data: the same batch
   * always yields the same transitions (retried samples were already dropped
   * as duplicates, so nothing fires twice), and notices are deduplicated in
   * the ledger by place + timestamp anyway.
   */
  _detectPlaceTransitions(prevSample, accepted) {
    const s = this.settings();
    if (!s.notify.arrival && !s.notify.departure) return null;
    // A single "was the previous fix inside?" test would misread an
    // edge-of-fence fix (kept inside by hysteresis) as "outside" and silently
    // lose the next real departure — replay the stored fixes instead.
    let current = null;
    if (prevSample) {
      const history = this.store.samples.range(prevSample.session_id, prevSample.ts - 30 * 60_000, prevSample.ts, 400);
      for (const smp of history) current = this._fenceState(smp.lat, smp.lon, smp.accuracy, current?.place?.id || null);
    }
    let lastChange = null;
    for (const smp of accepted) {
      const next = this._fenceState(smp.lat, smp.lon, smp.accuracy, current?.place?.id || null);
      const from = current?.place || null;
      const to = next?.place || null;
      if ((from?.id || null) === (to?.id || null)) { current = next; continue; }
      const at = smp.ts;
      if (from && s.notify.departure) {
        const d = next?.distanceM ?? Math.round(haversineM(smp.lat, smp.lon, from.lat, from.lon));
        this._notice(
          'departure',
          `Meninggalkan ${from.name} pukul ${localTime(at)} — sekarang ±${formatDistance(d)} dari pusat area (radius ${from.radius_m} m).`,
          `place-exit:${from.id}:${at}`
        );
      }
      if (to && s.notify.arrival) {
        this._notice(
          'arrival',
          `Tiba di ${to.name} pukul ${localTime(at)} (±${formatDistance(next.distanceM)} dari pusat, radius ${to.radius_m} m).`,
          `place-enter:${to.id}:${at}`
        );
      }
      const subject = to || from;
      this.store.events.log({
        kind: to ? 'place_entered' : 'place_exited',
        data: { placeId: subject.id, name: subject.name, from: from?.name || null, to: to?.name || null, distanceM: next?.distanceM ?? null, at },
      });
      this._changed('place_change', {
        at,
        from: from ? { id: from.id, name: from.name } : null,
        to: to ? { id: to.id, name: to.name } : null,
      });
      lastChange = { at, from: from?.name || null, to: to?.name || null };
      current = next;
    }
    return lastChange;
  }

  /** The owner corrects a stop: "ini warung Bu Yati". Stored and offered to personal memory. */
  correctStop(stopId, { kind = null, label = null, savePlace = false, radiusM = 120, note = null } = {}) {
    const stop = this.store.stops.get(stopId);
    if (!stop) throw new LocationError('Titik berhenti tidak ditemukan.', 'not_found');
    const patch = {
      corrected_at: this.now(),
      corrected_kind: kind || stop.kind,
      corrected_label: label || stop.label || null,
      kept: true,
    };
    let updated = this.store.stops.update(stopId, patch);
    if (savePlace && (label || kind)) {
      const place = this.store.places.create({
        name: label || KIND_LABELS[kind] || 'Tempat',
        kind: kind || 'public',
        lat: stop.lat,
        lon: stop.lon,
        radiusM,
        source: 'user',
        confirmState: 'confirmed',
        geohash: geohash(stop.lat, stop.lon, 6),
      });
      updated = this.store.stops.update(stopId, { place_id: place.id });
      this._changed('place_created', { placeId: place.id, name: place.name });
      try {
        this.memory?.({ kind: 'place_correction', place, stopId, note, at: this.now() });
      } catch { /* personal memory is optional */ }
    } else {
      try {
        this.memory?.({ kind: 'place_correction', stop: updated, note, at: this.now() });
      } catch { /* optional */ }
    }
    this.store.events.log({ kind: 'stop_corrected', data: { stopId, kind, label, savePlace } });
    this._changed('stop_corrected', { stopId });
    return updated;
  }

  // --------------------------------------------------- places straight from chat

  /**
   * A Telegram/WhatsApp location pin ("kirim lokasi"). It waits in memory for the
   * owner to name it — nothing reaches the database until then — and expires on
   * its own so a forgotten pin can never be saved by a later message.
   */
  setPendingPin(chatId, { lat, lon, name = null, from = null } = {}) {
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
      throw new LocationError('Koordinat lokasi tidak valid.', 'bad_request');
    }
    this._pendingPins.set(String(chatId), {
      lat: la, lon: lo, name: name ? String(name).slice(0, 60) : null, from, at: this.now(),
    });
  }

  /** The pin this chat shared, or null when there is none (or it expired). */
  pendingPin(chatId) {
    const key = String(chatId);
    const pin = this._pendingPins.get(key);
    if (!pin) return null;
    if (this.now() - pin.at > PENDING_PIN_TTL_MS) {
      this._pendingPins.delete(key);
      return null;
    }
    return pin;
  }

  clearPendingPin(chatId) { this._pendingPins.delete(String(chatId)); }

  /**
   * Saves a named place the owner sent from chat. Same honesty rules as the
   * dashboard: coordinates required, names never invented, a repeated name is
   * reported instead of duplicated, and the memory feed gets the same event a
   * dashboard correction produces.
   */
  addPlace({ name, kind = null, lat, lon, radiusM = 120, source = 'user', note = null } = {}) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!clean) throw new LocationError('Nama tempat belum diisi. Contoh: simpan lokasi ini sebagai Rumah.', 'bad_request');
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
      throw new LocationError('Koordinat tempat tidak valid.', 'bad_request');
    }
    const dup = this.store.places.list().find((p) => p.name.toLowerCase() === clean.toLowerCase());
    if (dup) throw new LocationError(`Tempat "${dup.name}" sudah tersimpan (${Number(dup.lat).toFixed(5)}, ${Number(dup.lon).toFixed(5)}).`, 'exists');
    const place = this.store.places.create({
      name: clean,
      kind: kind || 'public',
      lat: la,
      lon: lo,
      radiusM,
      source,
      confirmState: 'confirmed',
      geohash: geohash(la, lo, 6),
    });
    this.store.events.log({ kind: 'place_created', data: { placeId: place.id, name: place.name, source } });
    this._changed('place_created', { placeId: place.id, name: place.name });
    try {
      this.memory?.({ kind: 'place_correction', place, note: note || 'dibuat dari chat pemilik', at: this.now() });
    } catch { /* personal memory is optional */ }
    return place;
  }

  // ------------------------------------------------------------------ queries

  /**
   * Live status for the dashboard and the AI. Explicit about freshness: the
   * caller can tell "live" from "last known 40 minutes ago".
   */
  currentStatus() {
    const s = this.settings();
    const session = this.store.sessions.active() || this.store.sessions.latest();
    const last = session ? this.store.samples.last(session.id) : this.store.samples.last();
    const now = this.now();
    const ageMs = last ? now - last.ts : null;
    const stale = ageMs == null || ageMs > s.staleAfterMs;
    const stored = last ? { lat: last.lat, lon: last.lon } : null;

    let movement = { state: 'unknown', speedMps: null, since: null };
    let place = null;
    let places = [];
    if (last) {
      const recent = this.store.samples.range(last.session_id, last.ts - 30 * 60_000, last.ts, 400);
      movement = movementState(recent);
      place = this._placeLabelAt(last.lat, last.lon, last.accuracy);
      // Distance from every saved place, nearest first — the "jarak dari rumah"
      // readout. Straight-line distance, computed here so no caller ever guesses.
      places = this.store.places.list().map((p) => {
        const d = haversineM(last.lat, last.lon, p.lat, p.lon);
        return {
          id: p.id,
          name: p.name,
          kind: p.kind,
          radiusM: p.radius_m,
          distanceM: Math.round(d),
          inside: d <= p.radius_m,
          visits: p.visits,
          lastVisitAt: p.last_visit_at,
        };
      }).sort((a, b) => a.distanceM - b.distanceM);
    }
    const openTrip = this.store.trips.openTrip();
    const openStop = this.store.stops.open();
    const today = this.daySummary(this.today());

    return {
      tracking: {
        enabled: s.enabled,
        sessionId: session?.id || null,
        status: session?.status || 'stopped',
        startedAt: session?.started_at || null,
        pausedAt: session?.paused_at || null,
        consent: session?.consent || null,
        deviceId: session?.device_id || null,
      },
      position: last
        ? {
          lat: last.lat,
          lon: last.lon,
          accuracy: last.accuracy,
          speedMps: Number.isFinite(last.speed) ? last.speed : movement.speedMps,
          heading: last.heading,
          altitude: last.altitude,
          battery: last.battery,
          source: last.source,
          ts: last.ts,
          ageMs,
          fresh: !stale,
          // The honesty flag the dashboard shows: "posisi terkini" vs "lokasi terakhir yang diketahui".
          label: stale ? 'lokasi terakhir yang diketahui (bukan live)' : 'posisi terkini',
        }
        : null,
      quality: last
        ? {
          accuracyM: last.accuracy,
          level: last.accuracy == null ? 'unknown' : last.accuracy <= 30 ? 'good' : last.accuracy <= s.accuracyWarnM ? 'fair' : 'poor',
          message: last.accuracy == null
            ? 'Perangkat tidak melaporkan akurasi GPS.'
            : last.accuracy > s.accuracyWarnM
              ? `Akurasi GPS kasar (±${Math.round(last.accuracy)} m) — nama tempat dari titik ini tidak dapat dipercaya.`
              : `Akurasi GPS ±${Math.round(last.accuracy)} m.`,
        }
        : { accuracyM: null, level: 'unknown', message: 'Belum ada data lokasi.' },
      movement,
      place,
      places,
      openTrip,
      openStop,
      today: {
        date: today.date,
        distanceM: today.distanceM,
        trips: today.trips.length,
        stops: today.stops.length,
        firstMoveAt: today.firstMoveAt,
        lastMoveAt: today.lastMoveAt,
      },
      // What the phone client should do next (adaptive sampling).
      hint: {
        intervalMs: movement.state === 'moving' ? s.adaptiveIntervalMs : s.idleIntervalMs,
        reason: movement.state === 'moving' ? 'sedang bergerak — interval rapat' : 'diam — interval jarang (hemat baterai)',
      },
      raw: stored,
    };
  }

  /** Daily activity report — the data behind "sejak pagi saya ke mana saja?". */
  daySummary(date = this.today()) {
    const trips = this.store.trips.forDate(date);
    const stops = this.store.stops.forDate(date).filter((st) => st.kept);
    const [from, to] = dayBounds(date);
    const samples = this.store.samples.inWindow(from, to, 20000);
    const distanceM = trips.reduce((a, t) => a + (t.distance_m || 0), 0);
    const movingS = trips.reduce((a, t) => a + (t.moving_s || 0), 0);
    const firstMoveAt = trips.length ? trips[0].started_at : null;
    const lastMoveAt = trips.length ? (trips[trips.length - 1].ended_at || trips[trips.length - 1].started_at) : null;
    const sessionIds = new Set(samples.map((x) => x.session_id));
    let gaps = 0;
    for (let i = 1; i < samples.length; i++) if (samples[i].ts - samples[i - 1].ts > 5 * 60_000) gaps++;
    return {
      date,
      trips,
      stops,
      distanceM,
      movingS,
      firstMoveAt,
      lastMoveAt,
      sessions: sessionIds.size,
      sampleCount: samples.length,
      dataQuality: {
        gaps,
        note: samples.length === 0
          ? 'Tidak ada data lokasi pada hari ini (pelacakan mati atau ponsel tidak mengirim).'
          : gaps
            ? `Ada ${gaps} jeda data lebih dari 5 menit; jarak dan durasi bisa lebih kecil dari sebenarnya.`
            : 'Data lokasi mengalir tanpa jeda besar.',
      },
      timeline: this._timeline(trips, stops),
    };
  }

  _timeline(trips, stops) {
    const rows = [];
    for (const t of trips) {
      rows.push({ kind: 'trip', at: t.started_at, endAt: t.ended_at, label: t.start_label || 'Titik awal', toLabel: t.end_label || null, distanceM: t.distance_m, tripId: t.id });
    }
    for (const st of stops) {
      const effKind = st.corrected_kind || st.kind;
      rows.push({
        kind: 'stop', at: st.started_at, endAt: st.ended_at, label: st.corrected_label || st.label || KIND_LABELS[effKind] || 'Belum teridentifikasi',
        stopKind: effKind, confidence: st.confidence, unknown: effKind === 'unknown', durationMs: (st.ended_at || this.now()) - st.started_at,
        stopId: st.id,
      });
    }
    return rows.sort((a, b) => a.at - b.at);
  }

  /** "Di mana saya tadi?" — last known position with its exact age. */
  whereWasI(date = this.today()) {
    const [from, to] = dayBounds(date);
    const rows = this.store.samples.inWindow(from, to, 20000);
    const last = rows[rows.length - 1] || null;
    const summary = this.daySummary(date);
    return {
      date,
      lastKnown: last
        ? { lat: last.lat, lon: last.lon, accuracy: last.accuracy, ts: last.ts, time: localTime(last.ts), label: this._placeLabelAt(last.lat, last.lon, last.accuracy)?.label || null }
        : null,
      stops: summary.stops.map((st) => ({
        id: st.id,
        label: st.corrected_label || st.label || null,
        kind: st.corrected_kind || st.kind,
        arrival: localTime(st.started_at),
        departure: st.ended_at ? localTime(st.ended_at) : null,
        durationMin: Math.round(((st.ended_at || this.now()) - st.started_at) / 60000),
        confidence: st.confidence,
      })),
      distanceM: summary.distanceM,
      trips: summary.trips.length,
      note: summary.dataQuality.note,
    };
  }

  /** Between two local dates (inclusive), for weekly questions. */
  rangeSummary(fromDate, toDate) {
    const days = [];
    let date = fromDate;
    let guard = 0;
    while (date <= toDate && guard++ < 400) {
      const d = this.daySummary(date);
      if (d.sampleCount || d.trips.length) days.push({ date, distanceM: d.distanceM, trips: d.trips.length, stops: d.stops.length });
      date = addDays(date, 1);
    }
    return {
      from: fromDate,
      to: toDate,
      days,
      totalDistanceM: days.reduce((a, d) => a + d.distanceM, 0),
      totalTrips: days.reduce((a, d) => a + d.trips, 0),
    };
  }

  // ------------------------------------------------------------------ notices

  /** Routine notices: deduplicated in the DB, quiet hours and hourly cap respected. */
  _notice(kind, text, dedupKey) {
    const s = this.settings();
    if (!s.notify[kind]) return false;
    if (s.notify.quietHours && inQuietHours(this.now()) && kind !== 'emergency') return false;
    const since = this.now() - 3600_000;
    if (this.store.notices.countSince('routine', since) >= s.notify.maxPerHour) return false;
    if (!this.store.notices.claim({ kind, dedupKey, text })) return false;
    this._dispatch({ kind, text, priority: 'routine' });
    return true;
  }

  /** Notices for the owner that must not be silenced by the hourly cap (still honour "off"). */
  notifyImportant(kind, text, dedupKey) {
    if (!this.store.notices.claim({ kind, dedupKey, text })) return false;
    this._dispatch({ kind, text, priority: 'important' });
    return true;
  }

  _dispatch(payload) {
    if (!this.deliver) {
      this.emit('notice', payload);
      return;
    }
    Promise.resolve()
      .then(() => this.deliver(payload))
      .then((r) => {
        const row = this.store.notices.list(1)[0];
        if (row && row.dedup_key) this.store.notices.mark(row.id, { delivered: r?.ok !== false, channel: r?.channel || null, error: r?.error || null });
      })
      .catch((e) => this.emit('notice_error', { ...payload, error: e?.message }))
      .finally(() => this.emit('notice', payload));
  }

  // --------------------------------------------------------------------- tick

  tick() {
    if (this._ticking) return;
    this._ticking = true;
    const now = this.now();
    try {
      // 1) A trip left open with nothing new for 6 hours was not a trip anymore.
      for (const trip of this.store.trips.openTrips()) {
        const last = this.store.samples.inWindow(trip.started_at, now, 5).pop();
        if (!last || now - last.ts > 6 * 3600_000) this.closeTrip(trip, { at: last?.ts || trip.started_at, reason: 'tidak ada data' });
      }
      // 2) A dwell left open forever (session ended without a resume) is closed.
      const openStop = this.store.stops.open();
      if (openStop && now - openStop.started_at > 12 * 3600_000) {
        this.closeOpenStop(null, { at: now, reason: 'kedaluwarsa' });
      }
      // 3) Classify stops that are still unknown (network may have been down earlier).
      const unknownRecent = this.store.stops.forDate(this.today())
        .filter((st) => st.ended_at && (st.source === 'unknown' || st.confidence < 0.3) && st.ended_at > now - 2 * 3600_000)
        .slice(0, 2);
      for (const st of unknownRecent) this.enqueueClassification(st.id);
      // 4) Retention & caches.
      this.purge();
    } finally {
      this._ticking = false;
    }
  }

  /** Retention: raw points and old trips are deleted on a schedule, per settings. */
  purge() {
    const s = this.settings();
    const now = this.now();
    const out = { samples: 0, trips: 0, cache: 0, events: 0, notices: 0 };
    try {
      if (s.sampleRetentionDays > 0) out.samples = this.store.samples.purgeBefore(now - s.sampleRetentionDays * 86_400_000);
      if (s.tripRetentionDays > 0) out.trips = this.store.trips.purgeBefore(localDate(now - s.tripRetentionDays * 86_400_000));
      out.cache = this.store.geocodeCache.purgeExpired();
      out.events = this.store.events.purgeBefore(now - 180 * 86_400_000);
      out.notices = this.store.notices.purgeBefore(now - 30 * 86_400_000);
    } catch { /* retention must never crash the tick */ }
    if (out.samples || out.trips) this.store.events.log({ kind: 'retention_purge', data: out });
    return out;
  }

  start() {
    if (this._timer) return false;
    this._timer = setInterval(() => { try { this.tick(); } catch { /* logged in tick */ } }, 60_000);
    if (this._timer.unref) this._timer.unref();
    return true;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}
