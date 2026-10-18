/**
 * src/location/store.js
 *
 * Persistence for real-time location tracking, trips, places (geofences) and the
 * geocode cache. Same SQLite database as the rest of Wanar AI (injectable, so
 * tests use an in-memory database).
 *
 *   loc_settings        single JSON document (tracking & privacy preferences)
 *   loc_devices         device tokens used by phone clients to POST fixes
 *   loc_sessions        one tracking session: start / pause / resume / stop
 *   loc_samples         raw accepted GPS fixes (deduplicated per session+timestamp)
 *   loc_trips           a trip between two dwell points
 *   loc_trip_stops      stops inside/after a trip, with classification & evidence
 *   loc_places          geofences known by the owner ("confirmed") or learned
 *   loc_geocode_cache   reverse-geocode answers, never queried twice for the same cell
 *   loc_events          audit trail (tracking started, history deleted, correction made…)
 *
 * Raw coordinates are personal data: they live here and are served only to the
 * owner's own dashboard (see routes.js). They are never sent to third parties
 * except reverse geocoding, which is switchable off.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import crypto from 'node:crypto';

const id = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const parse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,                    // master switch for collecting location
  adaptiveIntervalMs: 8000,         // hint for the phone while moving (5–15 s per spec)
  idleIntervalMs: 60_000,           // hint while standing still
  minMoveM: 8,                      // jitter gate
  maxAccuracyM: 120,                // fixes worse than this are flagged, not used to classify places
  accuracyWarnM: 60,
  staleAfterMs: 3 * 60_000,         // older than this and the dashboard shows "last known", not "live"
  tripStartMoveM: 250,              // moved this far from the dwell point => trip began
  tripStartSpeedMps: 2.5,           // and/or sustained speed ~9 km/h
  stopMinMs: 3 * 60_000,            // a stop shorter than this is traffic, not an activity
  tripEndStopMs: 5 * 60_000,        // stand still this long => trip closed
  classifyMinMs: 3 * 60_000,        // dwell needed before a place is classified at all
  sampleRetentionDays: 90,          // raw samples
  tripRetentionDays: 730,
  notify: {
    tripStart: true,
    tripEnd: true,
    arrival: true,
    unknownStop: true,
    longStop: true,
    quietHours: true,               // hold routine notices 22:00–06:00 WIB
    maxPerHour: 6,                  // hard anti-spam brake for routine notices
  },
  geocode: {
    enabled: true,                  // reverse geocoding (Nominatim, OpenStreetMap)
    poiSearch: true,                // look up nearby POIs when classifying a stop
    minIntervalMs: 3000,            // politeness: at most one Nominatim call per 3 s
    cacheDays: 30,
    timeoutMs: 6000,
  },
});

function mergeSettings(base, patch) {
  const out = { ...base, ...(patch || {}) };
  out.notify = { ...base.notify, ...((patch || {}).notify || {}) };
  out.geocode = { ...base.geocode, ...((patch || {}).geocode || {}) };
  return out;
}

export function createLocationStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loc_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loc_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      os TEXT,
      note TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS loc_sessions (
      id TEXT PRIMARY KEY,
      device_id TEXT REFERENCES loc_devices(id) ON DELETE SET NULL,
      label TEXT,
      status TEXT NOT NULL CHECK (status IN ('active','paused','stopped')) DEFAULT 'active',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      paused_at INTEGER,
      consent TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loc_sessions_status ON loc_sessions(status, started_at DESC);

    CREATE TABLE IF NOT EXISTS loc_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES loc_sessions(id) ON DELETE CASCADE,
      device_id TEXT,
      ts INTEGER NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      accuracy REAL,
      speed REAL,
      heading REAL,
      altitude REAL,
      battery REAL,
      source TEXT NOT NULL DEFAULT 'gps',
      moved INTEGER NOT NULL DEFAULT 1,
      motion TEXT,
      received_at INTEGER NOT NULL,
      UNIQUE(session_id, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_loc_samples_ts ON loc_samples(ts);
    CREATE INDEX IF NOT EXISTS idx_loc_samples_session_ts ON loc_samples(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_loc_samples_received ON loc_samples(received_at);

    CREATE TABLE IF NOT EXISTS loc_trips (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      distance_m REAL NOT NULL DEFAULT 0,
      moving_s INTEGER NOT NULL DEFAULT 0,
      duration_s INTEGER NOT NULL DEFAULT 0,
      max_speed_mps REAL NOT NULL DEFAULT 0,
      avg_speed_mps REAL NOT NULL DEFAULT 0,
      start_lat REAL, start_lon REAL, end_lat REAL, end_lon REAL,
      start_label TEXT, end_label TEXT,
      status TEXT NOT NULL CHECK (status IN ('open','closed')) DEFAULT 'open',
      sample_count INTEGER NOT NULL DEFAULT 0,
      quality TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loc_trips_date ON loc_trips(date, started_at);
    CREATE INDEX IF NOT EXISTS idx_loc_trips_status ON loc_trips(status);

    CREATE TABLE IF NOT EXISTS loc_trip_stops (
      id TEXT PRIMARY KEY,
      trip_id TEXT REFERENCES loc_trips(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      place_id TEXT,
      kind TEXT NOT NULL DEFAULT 'unknown',
      label TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      accuracy REAL,
      confidence REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'unknown',
      evidence TEXT,
      kept INTEGER NOT NULL DEFAULT 0,
      corrected_at INTEGER,
      corrected_kind TEXT,
      corrected_label TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loc_stops_date ON loc_trip_stops(date, started_at);
    CREATE INDEX IF NOT EXISTS idx_loc_stops_open ON loc_trip_stops(ended_at);
    CREATE INDEX IF NOT EXISTS idx_loc_stops_place ON loc_trip_stops(place_id);

    CREATE TABLE IF NOT EXISTS loc_places (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'unknown',
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      radius_m INTEGER NOT NULL DEFAULT 120,
      source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','learned','poi')),
      confirm_state TEXT NOT NULL DEFAULT 'confirmed' CHECK (confirm_state IN ('confirmed','suggested','rejected')),
      aliases TEXT,
      visits INTEGER NOT NULL DEFAULT 0,
      last_visit_at INTEGER,
      geohash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_loc_places_active ON loc_places(active, confirm_state);
    CREATE INDEX IF NOT EXISTS idx_loc_places_geohash ON loc_places(geohash);

    CREATE TABLE IF NOT EXISTS loc_geocode_cache (
      key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loc_geocode_expiry ON loc_geocode_cache(expires_at);

    CREATE TABLE IF NOT EXISTS loc_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      session_id TEXT,
      device_id TEXT,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_loc_events_ts ON loc_events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_loc_events_kind ON loc_events(kind, ts DESC);

    CREATE TABLE IF NOT EXISTS loc_notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      dedup_key TEXT NOT NULL UNIQUE,
      text TEXT NOT NULL,
      channel TEXT,
      delivered INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_loc_notices_ts ON loc_notices(ts DESC);
  `);

  const now = () => Date.now();

  const settings = {
    get() {
      const row = db.prepare('SELECT data FROM loc_settings WHERE id = 1').get();
      return mergeSettings(DEFAULT_SETTINGS, parse(row?.data, {}));
    },
    set(patch) {
      const merged = mergeSettings(settings.get(), patch);
      db.prepare('INSERT INTO loc_settings (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .run(JSON.stringify(merged), now());
      return merged;
    },
  };

  const devices = {
    /** Creates a device and returns the ONE-TIME plaintext token (only a hash is stored). */
    create({ name, os = null, note = null }) {
      const token = `loc_${crypto.randomBytes(24).toString('base64url')}`;
      const did = id('dev');
      db.prepare('INSERT INTO loc_devices (id, name, token_hash, token_prefix, os, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(did, String(name || 'Perangkat'), hashToken(token), token.slice(0, 12), os, note, now());
      return { device: devices.get(did), token };
    },
    get: (did) => db.prepare('SELECT id, name, token_hash, token_prefix, os, note, created_at, last_seen_at, revoked_at FROM loc_devices WHERE id = ?').get(did) || null,
    byTokenHash: (h) => db.prepare('SELECT * FROM loc_devices WHERE token_hash = ? AND revoked_at IS NULL').get(h) || null,
    list: () => db.prepare('SELECT id, name, token_prefix, os, note, created_at, last_seen_at, revoked_at FROM loc_devices ORDER BY created_at DESC').all(),
    revoke(did) {
      db.prepare('UPDATE loc_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), did);
      return devices.get(did);
    },
    touch(did, ts = now()) {
      db.prepare('UPDATE loc_devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)').run(ts, did, ts - 3600_000);
    },
    count: () => db.prepare('SELECT COUNT(*) AS n FROM loc_devices WHERE revoked_at IS NULL').get().n,
  };

  const sessions = {
    create({ deviceId = null, label = null, consent = null, startedAt = now(), status = 'active' }) {
      const sid = id('trk');
      db.prepare('INSERT INTO loc_sessions (id, device_id, label, status, started_at, consent, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sid, deviceId, label, status, startedAt, consent ? JSON.stringify(consent) : null, now());
      return sessions.get(sid);
    },
    get: (sid) => {
      const row = db.prepare('SELECT * FROM loc_sessions WHERE id = ?').get(sid);
      if (!row) return null;
      return { ...row, consent: parse(row.consent, null) };
    },
    active: () => {
      const row = db.prepare("SELECT * FROM loc_sessions WHERE status IN ('active','paused') ORDER BY started_at DESC LIMIT 1").get();
      return row ? { ...row, consent: parse(row.consent, null) } : null;
    },
    latest: () => {
      const row = db.prepare('SELECT * FROM loc_sessions ORDER BY started_at DESC LIMIT 1').get();
      return row ? { ...row, consent: parse(row.consent, null) } : null;
    },
    list: (limit = 50) => db.prepare('SELECT * FROM loc_sessions ORDER BY started_at DESC LIMIT ?').all(limit)
      .map((r) => ({ ...r, consent: parse(r.consent, null) })),
    setStatus(sid, status, { at = now() } = {}) {
      if (status === 'paused') db.prepare('UPDATE loc_sessions SET status = ?, paused_at = ?, updated_at = ? WHERE id = ?').run(status, at, now(), sid);
      else if (status === 'stopped') db.prepare('UPDATE loc_sessions SET status = ?, ended_at = ?, paused_at = NULL, updated_at = ? WHERE id = ?').run(status, at, now(), sid);
      else db.prepare('UPDATE loc_sessions SET status = ?, paused_at = NULL, ended_at = NULL, updated_at = ? WHERE id = ?').run(status, now(), sid);
      return sessions.get(sid);
    },
    openCount: () => db.prepare("SELECT COUNT(*) AS n FROM loc_sessions WHERE status IN ('active','paused')").get().n,
  };

  const samples = {
    /**
     * Inserts a batch. Duplicate (session, timestamp) rows are ignored silently —
     * the phone retries after a network gap, and retrying must never double a trip.
     * @returns {{inserted:number, duplicates:number}}
     */
    insertMany(sessionId, deviceId, list) {
      const stmt = db.prepare(`INSERT OR IGNORE INTO loc_samples
        (session_id, device_id, ts, lat, lon, accuracy, speed, heading, altitude, battery, source, moved, motion, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      let inserted = 0;
      let duplicates = 0;
      const t = now();
      const tx = db.transaction((rows) => {
        for (const s of rows) {
          const r = stmt.run(sessionId, deviceId, s.ts, s.lat, s.lon, s.accuracy ?? null, s.speed ?? null,
            s.heading ?? null, s.altitude ?? null, s.battery ?? null, s.source || 'gps', s.moved === false ? 0 : 1,
            s.motion ? JSON.stringify(s.motion) : null, t);
          if (r.changes) inserted++;
          else duplicates++;
        }
      });
      tx(list);
      return { inserted, duplicates };
    },
    last: (sessionId = null) => {
      const row = sessionId
        ? db.prepare('SELECT * FROM loc_samples WHERE session_id = ? ORDER BY ts DESC LIMIT 1').get(sessionId)
        : db.prepare('SELECT * FROM loc_samples ORDER BY ts DESC LIMIT 1').get();
      return row ? { ...row, motion: parse(row.motion, null) } : null;
    },
    lastBefore: (sessionId, ts) => {
      const row = db.prepare('SELECT * FROM loc_samples WHERE session_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1').get(sessionId, ts);
      return row ? { ...row, motion: parse(row.motion, null) } : null;
    },
    range(sessionId, fromMs, toMs, limit = 5000) {
      return db.prepare('SELECT * FROM loc_samples WHERE session_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT ?')
        .all(sessionId, fromMs, toMs, limit).map((r) => ({ ...r, motion: parse(r.motion, null) }));
    },
    inWindow(fromMs, toMs, limit = 20000) {
      return db.prepare('SELECT * FROM loc_samples WHERE ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT ?')
        .all(fromMs, toMs, limit).map((r) => ({ ...r, motion: parse(r.motion, null) }));
    },
    countIn(sessionId, fromMs, toMs) {
      return db.prepare('SELECT COUNT(*) AS n FROM loc_samples WHERE session_id = ? AND ts >= ? AND ts <= ?').get(sessionId, fromMs, toMs).n;
    },
    count: () => db.prepare('SELECT COUNT(*) AS n FROM loc_samples').get().n,
    purgeBefore(ts) {
      return db.prepare('DELETE FROM loc_samples WHERE ts < ?').run(ts).changes;
    },
  };

  const trips = {
    open({ startedAt, lat, lon, date, label = null }) {
      const tid = id('trip');
      db.prepare(`INSERT INTO loc_trips (id, date, started_at, start_lat, start_lon, start_label, status, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`).run(tid, date, startedAt, lat, lon, label, now());
      return trips.get(tid);
    },
    get: (tid) => {
      const row = db.prepare('SELECT * FROM loc_trips WHERE id = ?').get(tid);
      return row ? { ...row, quality: parse(row.quality, null) } : null;
    },
    openTrip: () => {
      const row = db.prepare("SELECT * FROM loc_trips WHERE status = 'open' ORDER BY started_at DESC LIMIT 1").get();
      return row ? { ...row, quality: parse(row.quality, null) } : null;
    },
    update(tid, patch) {
      const cur = trips.get(tid);
      if (!cur) return null;
      const f = { ...cur, ...patch };
      db.prepare(`UPDATE loc_trips SET ended_at = ?, distance_m = ?, moving_s = ?, duration_s = ?, max_speed_mps = ?,
                  avg_speed_mps = ?, end_lat = ?, end_lon = ?, end_label = ?, status = ?, sample_count = ?, quality = ?, updated_at = ?
                  WHERE id = ?`).run(
        f.ended_at ?? null, f.distance_m || 0, f.moving_s || 0, f.duration_s || 0, f.max_speed_mps || 0,
        f.avg_speed_mps || 0, f.end_lat ?? null, f.end_lon ?? null, f.end_label ?? null, f.status || 'open',
        f.sample_count || 0, f.quality ? JSON.stringify(f.quality) : null, now(), tid);
      return trips.get(tid);
    },
    forDate: (date) => db.prepare('SELECT * FROM loc_trips WHERE date = ? ORDER BY started_at ASC').all(date)
      .map((r) => ({ ...r, quality: parse(r.quality, null) })),
    range: (from, to, limit = 100) => db.prepare('SELECT * FROM loc_trips WHERE date >= ? AND date <= ? ORDER BY started_at DESC LIMIT ?').all(from, to, limit)
      .map((r) => ({ ...r, quality: parse(r.quality, null) })),
    recent: (limit = 20) => db.prepare('SELECT * FROM loc_trips ORDER BY started_at DESC LIMIT ?').all(limit)
      .map((r) => ({ ...r, quality: parse(r.quality, null) })),
    openTrips: () => db.prepare("SELECT * FROM loc_trips WHERE status = 'open' ORDER BY started_at ASC").all()
      .map((r) => ({ ...r, quality: parse(r.quality, null) })),
    count: () => db.prepare('SELECT COUNT(*) AS n FROM loc_trips').get().n,
    purgeBefore(date) {
      const ids = db.prepare('SELECT id FROM loc_trips WHERE date < ?').all(date).map((r) => r.id);
      let n = 0;
      for (const tid of ids) {
        db.prepare('DELETE FROM loc_trip_stops WHERE trip_id = ?').run(tid);
        n += db.prepare('DELETE FROM loc_trips WHERE id = ?').run(tid).changes;
      }
      return n;
    },
  };

  const stops = {
    create({ tripId = null, date, placeId = null, kind = 'unknown', label = null, startedAt, lat, lon, accuracy = null, confidence = 0, source = 'unknown', evidence = null, kept = false }) {
      const sid = id('stop');
      db.prepare(`INSERT INTO loc_trip_stops (id, trip_id, date, place_id, kind, label, started_at, lat, lon, accuracy,
                  confidence, source, evidence, kept, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(sid, tripId, date, placeId, kind, label, startedAt, lat, lon, accuracy, confidence, source,
          evidence ? JSON.stringify(evidence) : null, kept ? 1 : 0, now(), now());
      return stops.get(sid);
    },
    get: (sid) => {
      const row = db.prepare('SELECT * FROM loc_trip_stops WHERE id = ?').get(sid);
      return row ? { ...row, evidence: parse(row.evidence, null), kept: Boolean(row.kept) } : null;
    },
    open: () => {
      const row = db.prepare('SELECT * FROM loc_trip_stops WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get();
      return row ? { ...row, evidence: parse(row.evidence, null), kept: Boolean(row.kept) } : null;
    },
    update(sid, patch) {
      const cur = stops.get(sid);
      if (!cur) return null;
      const f = { ...cur, ...patch };
      db.prepare(`UPDATE loc_trip_stops SET trip_id = ?, place_id = ?, kind = ?, label = ?, ended_at = ?, accuracy = ?,
                  confidence = ?, source = ?, evidence = ?, kept = ?, corrected_at = ?, corrected_kind = ?,
                  corrected_label = ?, updated_at = ? WHERE id = ?`)
        .run(f.trip_id ?? null, f.place_id ?? null, f.kind, f.label ?? null, f.ended_at ?? null, f.accuracy ?? null,
          f.confidence ?? 0, f.source, f.evidence ? JSON.stringify(f.evidence) : null, f.kept ? 1 : 0,
          f.corrected_at ?? null, f.corrected_kind ?? null, f.corrected_label ?? null, now(), sid);
      return stops.get(sid);
    },
    forTrip: (tripId) => db.prepare('SELECT * FROM loc_trip_stops WHERE trip_id = ? ORDER BY started_at ASC').all(tripId)
      .map((r) => ({ ...r, evidence: parse(r.evidence, null), kept: Boolean(r.kept) })),
    forDate: (date) => db.prepare('SELECT * FROM loc_trip_stops WHERE date = ? ORDER BY started_at ASC').all(date)
      .map((r) => ({ ...r, evidence: parse(r.evidence, null), kept: Boolean(r.kept) })),
    recentReal: (limit = 30) => db.prepare("SELECT * FROM loc_trip_stops WHERE kept = 1 ORDER BY started_at DESC LIMIT ?").all(limit)
      .map((r) => ({ ...r, evidence: parse(r.evidence, null), kept: Boolean(r.kept) })),
    count: () => db.prepare('SELECT COUNT(*) AS n FROM loc_trip_stops').get().n,
    deleteForDate(date) {
      return db.prepare('DELETE FROM loc_trip_stops WHERE date = ?').run(date).changes;
    },
  };

  const places = {
    create({ name, kind = 'unknown', lat, lon, radiusM = 120, source = 'user', confirmState = 'confirmed', aliases = null, geohash: gh = null }) {
      const pid = id('place');
      db.prepare(`INSERT INTO loc_places (id, name, kind, lat, lon, radius_m, source, confirm_state, aliases, geohash, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(pid, name, kind, lat, lon, Math.max(25, Math.round(radiusM)), source, confirmState,
          aliases ? JSON.stringify(aliases) : null, gh, now(), now());
      return places.get(pid);
    },
    get: (pid) => {
      const row = db.prepare('SELECT * FROM loc_places WHERE id = ?').get(pid);
      return row ? { ...row, aliases: parse(row.aliases, []) } : null;
    },
    list: ({ includeInactive = false } = {}) => {
      const sql = includeInactive
        ? 'SELECT * FROM loc_places ORDER BY visits DESC, name ASC'
        : 'SELECT * FROM loc_places WHERE active = 1 ORDER BY visits DESC, name ASC';
      return db.prepare(sql).all().map((r) => ({ ...r, aliases: parse(r.aliases, []) }));
    },
    byGeohash: (gh) => db.prepare('SELECT * FROM loc_places WHERE geohash = ? AND active = 1').all(gh)
      .map((r) => ({ ...r, aliases: parse(r.aliases, []) })),
    byKind: (kind) => db.prepare('SELECT * FROM loc_places WHERE kind = ? AND active = 1').all(kind)
      .map((r) => ({ ...r, aliases: parse(r.aliases, []) })),
    update(pid, patch) {
      const cur = places.get(pid);
      if (!cur) return null;
      const f = { ...cur, ...patch };
      db.prepare(`UPDATE loc_places SET name = ?, kind = ?, radius_m = ?, confirm_state = ?, aliases = ?, active = ?, updated_at = ? WHERE id = ?`)
        .run(f.name, f.kind, Math.max(25, Math.round(f.radius_m)), f.confirm_state,
          f.aliases ? JSON.stringify(f.aliases) : null, f.active ? 1 : 0, now(), pid);
      return places.get(pid);
    },
    visit(pid, at = now()) {
      db.prepare('UPDATE loc_places SET visits = visits + 1, last_visit_at = ? WHERE id = ?').run(at, pid);
    },
    remove: (pid) => db.prepare('DELETE FROM loc_places WHERE id = ?').run(pid).changes > 0,
    count: () => db.prepare('SELECT COUNT(*) AS n FROM loc_places WHERE active = 1').get().n,
  };

  const geocodeCache = {
    get(key) {
      const row = db.prepare('SELECT * FROM loc_geocode_cache WHERE key = ?').get(key);
      if (!row) return null;
      if (row.expires_at < now()) {
        db.prepare('DELETE FROM loc_geocode_cache WHERE key = ?').run(key);
        return null;
      }
      return { ...row, payload: parse(row.payload, null) };
    },
    put(key, provider, lat, lon, payload, ttlMs) {
      const t = now();
      db.prepare(`INSERT INTO loc_geocode_cache (key, provider, lat, lon, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at, expires_at = excluded.expires_at`)
        .run(key, provider, lat, lon, JSON.stringify(payload), t, t + ttlMs);
    },
    purgeExpired: () => db.prepare('DELETE FROM loc_geocode_cache WHERE expires_at < ?').run(now()).changes,
    count: () => db.prepare('SELECT COUNT(*) AS n FROM loc_geocode_cache').get().n,
  };

  const events = {
    log({ kind, sessionId = null, deviceId = null, data = null, ts = now() }) {
      db.prepare('INSERT INTO loc_events (ts, kind, session_id, device_id, data) VALUES (?, ?, ?, ?, ?)')
        .run(ts, kind, sessionId, deviceId, data ? JSON.stringify(data) : null);
    },
    recent: (limit = 100) => db.prepare('SELECT * FROM loc_events ORDER BY ts DESC LIMIT ?').all(limit)
      .map((r) => ({ ...r, data: parse(r.data, null) })),
    purgeBefore: (ts) => db.prepare('DELETE FROM loc_events WHERE ts < ?').run(ts).changes,
  };

  /**
   * Routine notice ledger. The UNIQUE dedup_key is the anti-spam mechanism: a
   * notice about "trip X started" can physically be recorded only once, no
   * matter how many ticks run.
   */
  const notices = {
    /** @returns {boolean} true when this notice is new (i.e. should be sent) */
    claim({ kind, dedupKey, text, ts = now() }) {
      const r = db.prepare('INSERT OR IGNORE INTO loc_notices (ts, kind, dedup_key, text) VALUES (?, ?, ?, ?)')
        .run(ts, kind, dedupKey, text);
      return r.changes > 0;
    },
    mark(id, { delivered, channel = null, error = null }) {
      db.prepare('UPDATE loc_notices SET delivered = ?, channel = ?, error = ? WHERE id = ?').run(delivered ? 1 : 0, channel, error, id);
    },
    list: (limit = 100) => db.prepare('SELECT * FROM loc_notices ORDER BY ts DESC LIMIT ?').all(limit),
    countSince(kind, since) {
      return db.prepare('SELECT COUNT(*) AS n FROM loc_notices WHERE kind = ? AND ts >= ?').get(kind, since).n;
    },
    purgeBefore: (ts) => db.prepare('DELETE FROM loc_notices WHERE ts < ?').run(ts).changes,
  };

  /** Everything the privacy controls need: counts + hard deletes. */
  const privacy = {
    stats() {
      return {
        samples: samples.count(),
        trips: trips.count(),
        stops: stops.count(),
        places: places.count(),
        devices: devices.count(),
        geocodeCache: geocodeCache.count(),
        oldestSample: db.prepare('SELECT MIN(ts) AS ts FROM loc_samples').get()?.ts || null,
        newestSample: db.prepare('SELECT MAX(ts) AS ts FROM loc_samples').get()?.ts || null,
      };
    },
    deleteSamplesBefore: (ts) => samples.purgeBefore(ts),
    deleteTripsBefore: (date) => trips.purgeBefore(date),
    deleteTripsRange(fromDate, toDate) {
      const ids = db.prepare('SELECT id FROM loc_trips WHERE date >= ? AND date <= ?').all(fromDate, toDate).map((r) => r.id);
      let n = 0;
      for (const tid of ids) {
        db.prepare('DELETE FROM loc_trip_stops WHERE trip_id = ?').run(tid);
        n += db.prepare('DELETE FROM loc_trips WHERE id = ?').run(tid).changes;
      }
      n += db.prepare('DELETE FROM loc_trip_stops WHERE date >= ? AND date <= ?').run(fromDate, toDate).changes;
      return n;
    },
    deleteSamplesRange(fromMs, toMs) {
      return db.prepare('DELETE FROM loc_samples WHERE ts >= ? AND ts <= ?').run(fromMs, toMs).changes;
    },
    reset() {
      db.prepare('DELETE FROM loc_trip_stops').run();
      db.prepare('DELETE FROM loc_trips').run();
      db.prepare('DELETE FROM loc_samples').run();
      db.prepare('DELETE FROM loc_events').run();
      db.prepare('DELETE FROM loc_notices').run();
      db.prepare('DELETE FROM loc_sessions').run();
    },
  };

  return { db, settings, devices, sessions, samples, trips, stops, places, geocodeCache, events, notices, privacy, now };
}

/** SHA-256 of a device token. Only the hash is ever stored. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Constant-time comparison of two hex digests, used by the ingest route.
 * Returns false (never throws) for malformed input.
 */
export function tokenMatches(expectedHex, token) {
  try {
    const given = hashToken(token);
    const a = Buffer.from(given, 'hex');
    const b = Buffer.from(String(expectedHex || ''), 'hex');
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
