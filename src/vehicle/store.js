/**
 * src/vehicle/store.js
 *
 * Persistence for the motorcycle care module: the vehicle, fuel fill-ups,
 * odometer readings, maintenance items and service history.
 *
 *   veh_vehicles        one bike (Honda Vario 160 CBS by default)
 *   veh_fuel_logs       every fill-up, with the maths stored next to the raw data
 *   veh_odo_readings    manual odometer readings (never GPS-derived)
 *   veh_maint_items     maintenance schedule per component
 *   veh_service_records what was actually done, when, where, how much
 *   veh_notices         anti-spam ledger for reminders
 *
 * @author Wisnu Alfian Nur Ashar
 */

import crypto from 'node:crypto';

const id = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const parse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

export const DEFAULT_VEHICLE = Object.freeze({
  name: 'Honda Vario 160 CBS',
  model: 'Vario 160 CBS',
  plate: null,
  fuelType: 'Pertamax',
  baselineKmpl: 50,          // the owner's stated assumption — configurable, never silently changed
  tankLiters: null,          // unknown until the owner fills it in (no fuel sensor exists)
  reserveKm: 60,             // warn when the modelled range drops under this
  pricePerLiter: null,       // the owner sets the real purchase price
  warnLiterThresholdL: 2,    // modelled remaining fuel warning
});

export function createVehicleStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS veh_vehicles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model TEXT,
      plate TEXT,
      fuel_type TEXT NOT NULL DEFAULT 'Pertamax',
      baseline_kmpl REAL,
      tank_liters REAL,
      reserve_km REAL,
      price_per_liter REAL,
      warn_liter_threshold REAL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS veh_fuel_logs (
      id TEXT PRIMARY KEY,
      vehicle_id TEXT NOT NULL REFERENCES veh_vehicles(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      odo_km REAL,
      liters REAL NOT NULL,
      price_per_liter REAL,
      total_cost REAL,
      fuel_type TEXT NOT NULL DEFAULT 'Pertamax',
      full_tank INTEGER NOT NULL DEFAULT 0,
      station TEXT,
      place_id TEXT,
      km_since_prev REAL,
      consumption_kmpl REAL,
      consumption_note TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_veh_fuel_ts ON veh_fuel_logs(vehicle_id, ts DESC);

    CREATE TABLE IF NOT EXISTS veh_odo_readings (
      id TEXT PRIMARY KEY,
      vehicle_id TEXT NOT NULL REFERENCES veh_vehicles(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      odo_km REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      confidence TEXT NOT NULL DEFAULT 'high',
      gps_distance_since_prev_km REAL,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_veh_odo_ts ON veh_odo_readings(vehicle_id, ts DESC);

    CREATE TABLE IF NOT EXISTS veh_maint_items (
      id TEXT PRIMARY KEY,
      vehicle_id TEXT NOT NULL REFERENCES veh_vehicles(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      interval_km REAL,
      interval_months REAL,
      suggested_km REAL,
      suggested_months REAL,
      last_service_at INTEGER,
      last_service_odo_km REAL,
      verified INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      safety_critical INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      UNIQUE(vehicle_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_veh_items_active ON veh_maint_items(vehicle_id, active);

    CREATE TABLE IF NOT EXISTS veh_service_records (
      id TEXT PRIMARY KEY,
      vehicle_id TEXT NOT NULL REFERENCES veh_vehicles(id) ON DELETE CASCADE,
      item_key TEXT,
      ts INTEGER NOT NULL,
      odo_km REAL,
      workshop TEXT,
      cost REAL,
      parts TEXT,
      notes TEXT,
      evidence TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_veh_service_ts ON veh_service_records(vehicle_id, ts DESC);

    CREATE TABLE IF NOT EXISTS veh_notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      dedup_key TEXT NOT NULL UNIQUE,
      text TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
  `);

  const now = () => Date.now();

  const vehicles = {
    create({ name, model = null, plate = null, fuelType = 'Pertamax', baselineKmpl = 50, tankLiters = null, reserveKm = 60, pricePerLiter = null, warnLiterThreshold = 2 }) {
      const vid = id('veh');
      db.prepare(`INSERT INTO veh_vehicles (id, name, model, plate, fuel_type, baseline_kmpl, tank_liters, reserve_km, price_per_liter, warn_liter_threshold, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(vid, name, model, plate, fuelType, baselineKmpl, tankLiters, reserveKm, pricePerLiter, warnLiterThreshold, now(), now());
      return vehicles.get(vid);
    },
    get: (vid) => db.prepare('SELECT * FROM veh_vehicles WHERE id = ?').get(vid) || null,
    active: () => db.prepare('SELECT * FROM veh_vehicles WHERE active = 1 ORDER BY created_at ASC LIMIT 1').get() || null,
    list: () => db.prepare('SELECT * FROM veh_vehicles ORDER BY created_at ASC').all(),
    update(vid, patch) {
      const cur = vehicles.get(vid);
      if (!cur) return null;
      const f = { ...cur, ...patch };
      db.prepare(`UPDATE veh_vehicles SET name = ?, model = ?, plate = ?, fuel_type = ?, baseline_kmpl = ?, tank_liters = ?,
                  reserve_km = ?, price_per_liter = ?, warn_liter_threshold = ?, active = ?, updated_at = ? WHERE id = ?`)
        .run(f.name, f.model, f.plate, f.fuel_type, f.baseline_kmpl, f.tank_liters, f.reserve_km, f.price_per_liter,
          f.warn_liter_threshold, f.active ? 1 : 0, now(), vid);
      return vehicles.get(vid);
    },
  };

  const fuel = {
    add(row) {
      const fid = id('fuel');
      db.prepare(`INSERT INTO veh_fuel_logs (id, vehicle_id, ts, odo_km, liters, price_per_liter, total_cost, fuel_type, full_tank,
                  station, place_id, km_since_prev, consumption_kmpl, consumption_note, source, note, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(fid, row.vehicleId, row.ts, row.odoKm ?? null, row.liters, row.pricePerLiter ?? null, row.totalCost ?? null,
          row.fuelType || 'Pertamax', row.fullTank ? 1 : 0, row.station ?? null, row.placeId ?? null,
          row.kmSincePrev ?? null, row.consumptionKmpl ?? null, row.consumptionNote ?? null, row.source || 'manual', row.note ?? null, now());
      return fuel.get(fid);
    },
    get: (fid) => db.prepare('SELECT * FROM veh_fuel_logs WHERE id = ?').get(fid) || null,
    last: (vid) => db.prepare('SELECT * FROM veh_fuel_logs WHERE vehicle_id = ? ORDER BY ts DESC LIMIT 1').get(vid) || null,
    lastFull: (vid) => db.prepare('SELECT * FROM veh_fuel_logs WHERE vehicle_id = ? AND full_tank = 1 ORDER BY ts DESC LIMIT 1').get(vid) || null,
    forRange: (vid, from, to) => db.prepare('SELECT * FROM veh_fuel_logs WHERE vehicle_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC').all(vid, from, to),
    recent: (vid, limit = 50) => db.prepare('SELECT * FROM veh_fuel_logs WHERE vehicle_id = ? ORDER BY ts DESC LIMIT ?').all(vid, limit),
    /** Fill-ups that produced a real full-to-full consumption figure. */
    consumptions: (vid, limit = 20) => db.prepare('SELECT ts, consumption_kmpl FROM veh_fuel_logs WHERE vehicle_id = ? AND consumption_kmpl IS NOT NULL ORDER BY ts DESC LIMIT ?').all(vid, limit),
    remove: (fid) => db.prepare('DELETE FROM veh_fuel_logs WHERE id = ?').run(fid).changes > 0,
    count: (vid) => db.prepare('SELECT COUNT(*) AS n FROM veh_fuel_logs WHERE vehicle_id = ?').get(vid).n,
  };

  const odometer = {
    add(row) {
      const rid = id('odo');
      db.prepare(`INSERT INTO veh_odo_readings (id, vehicle_id, ts, odo_km, source, confidence, gps_distance_since_prev_km, note, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(rid, row.vehicleId, row.ts, row.odoKm, row.source || 'manual', row.confidence || 'high',
          row.gpsDistanceSincePrevKm ?? null, row.note ?? null, now());
      return odometer.get(rid);
    },
    get: (rid) => db.prepare('SELECT * FROM veh_odo_readings WHERE id = ?').get(rid) || null,
    last: (vid) => db.prepare('SELECT * FROM veh_odo_readings WHERE vehicle_id = ? ORDER BY ts DESC LIMIT 1').get(vid) || null,
    previous: (vid, ts) => db.prepare('SELECT * FROM veh_odo_readings WHERE vehicle_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1').get(vid, ts) || null,
    recent: (vid, limit = 50) => db.prepare('SELECT * FROM veh_odo_readings WHERE vehicle_id = ? ORDER BY ts DESC LIMIT ?').all(vid, limit),
    remove: (rid) => db.prepare('DELETE FROM veh_odo_readings WHERE id = ?').run(rid).changes > 0,
    count: (vid) => db.prepare('SELECT COUNT(*) AS n FROM veh_odo_readings WHERE vehicle_id = ?').get(vid).n,
  };

  const items = {
    upsert(row) {
      db.prepare(`INSERT INTO veh_maint_items (id, vehicle_id, key, name, interval_km, interval_months, suggested_km, suggested_months,
                  last_service_at, last_service_odo_km, verified, source, safety_critical, notes, active, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(vehicle_id, key) DO UPDATE SET name = excluded.name, interval_km = excluded.interval_km,
                    interval_months = excluded.interval_months, suggested_km = excluded.suggested_km, suggested_months = excluded.suggested_months,
                    verified = excluded.verified, source = excluded.source, safety_critical = excluded.safety_critical,
                    notes = excluded.notes, active = excluded.active, updated_at = excluded.updated_at`)
        .run(row.id || id('mi'), row.vehicleId, row.key, row.name, row.intervalKm ?? null, row.intervalMonths ?? null,
          row.suggestedKm ?? null, row.suggestedMonths ?? null, row.lastServiceAt ?? null, row.lastServiceOdoKm ?? null,
          row.verified ? 1 : 0, row.source ?? null, row.safetyCritical ? 1 : 0, row.notes ?? null, row.active === false ? 0 : 1, now());
      return items.get(row.vehicleId, row.key);
    },
    get: (vid, key) => db.prepare('SELECT * FROM veh_maint_items WHERE vehicle_id = ? AND key = ?').get(vid, key) || null,
    list: (vid, { activeOnly = false } = {}) => {
      const sql = activeOnly
        ? 'SELECT * FROM veh_maint_items WHERE vehicle_id = ? AND active = 1 ORDER BY key'
        : 'SELECT * FROM veh_maint_items WHERE vehicle_id = ? ORDER BY key';
      return db.prepare(sql).all(vid);
    },
    update(vid, key, patch) {
      const cur = items.get(vid, key);
      if (!cur) return null;
      const f = { ...cur, ...patch };
      db.prepare(`UPDATE veh_maint_items SET name = ?, interval_km = ?, interval_months = ?, last_service_at = ?, last_service_odo_km = ?,
                  verified = ?, source = ?, safety_critical = ?, notes = ?, active = ?, updated_at = ? WHERE vehicle_id = ? AND key = ?`)
        .run(f.name, f.interval_km ?? null, f.interval_months ?? null, f.last_service_at ?? null, f.last_service_odo_km ?? null,
          f.verified ? 1 : 0, f.source ?? null, f.safety_critical ? 1 : 0, f.notes ?? null, f.active ? 1 : 0, now(), vid, key);
      return items.get(vid, key);
    },
  };

  const services = {
    add(row) {
      const sid = id('svc');
      db.prepare(`INSERT INTO veh_service_records (id, vehicle_id, item_key, ts, odo_km, workshop, cost, parts, notes, evidence, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(sid, row.vehicleId, row.itemKey ?? null, row.ts, row.odoKm ?? null, row.workshop ?? null, row.cost ?? null,
          row.parts ? JSON.stringify(row.parts) : null, row.notes ?? null, row.evidence ? JSON.stringify(row.evidence) : null, now());
      return services.get(sid);
    },
    get: (sid) => {
      const row = db.prepare('SELECT * FROM veh_service_records WHERE id = ?').get(sid);
      return row ? { ...row, parts: parse(row.parts, null), evidence: parse(row.evidence, null) } : null;
    },
    recent: (vid, limit = 50) => db.prepare('SELECT * FROM veh_service_records WHERE vehicle_id = ? ORDER BY ts DESC LIMIT ?').all(vid, limit)
      .map((r) => ({ ...r, parts: parse(r.parts, null), evidence: parse(r.evidence, null) })),
    forItem: (vid, key, limit = 20) => db.prepare('SELECT * FROM veh_service_records WHERE vehicle_id = ? AND item_key = ? ORDER BY ts DESC LIMIT ?').all(vid, key, limit)
      .map((r) => ({ ...r, parts: parse(r.parts, null), evidence: parse(r.evidence, null) })),
    remove: (sid) => db.prepare('DELETE FROM veh_service_records WHERE id = ?').run(sid).changes > 0,
    lastFor: (vid, key) => {
      const row = db.prepare('SELECT * FROM veh_service_records WHERE vehicle_id = ? AND item_key = ? ORDER BY ts DESC LIMIT 1').get(vid, key);
      return row ? { ...row, parts: parse(row.parts, null), evidence: parse(row.evidence, null) } : null;
    },
  };

  const notices = {
    claim({ kind, dedupKey, text, ts = now() }) {
      return db.prepare('INSERT OR IGNORE INTO veh_notices (ts, kind, dedup_key, text) VALUES (?, ?, ?, ?)').run(ts, kind, dedupKey, text).changes > 0;
    },
    list: (limit = 100) => db.prepare('SELECT * FROM veh_notices ORDER BY ts DESC LIMIT ?').all(limit),
    mark(idRow, { delivered, error = null }) {
      db.prepare('UPDATE veh_notices SET delivered = ?, error = ? WHERE id = ?').run(delivered ? 1 : 0, error, idRow);
    },
    purgeBefore: (ts) => db.prepare('DELETE FROM veh_notices WHERE ts < ?').run(ts).changes,
  };

  return { db, vehicles, fuel, odometer, items, services, notices, now };
}
