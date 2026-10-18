/**
 * Test Suite: src/vehicle/*
 * In-memory SQLite, injected clock, no network. The honesty rules under test:
 * fuel remaining is a model estimate, only full-to-full fills produce km/L,
 * GPS never moves the odometer, and unverified intervals stay labelled.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';

import { dueStatus, consumptionFromFill, estimateFuel, seedItems, DEFAULT_MAINTENANCE, UNVERIFIED_NOTE } from '../src/vehicle/intervals.js';
import { createVehicleStore, DEFAULT_VEHICLE } from '../src/vehicle/store.js';
import { VehicleService, VehicleError } from '../src/vehicle/service.js';
import { createVehicleRouter } from '../src/vehicle/routes.js';
import { quickVehicle } from '../src/vehicle/quick.js';

const T0 = Date.parse('2026-10-12T01:00:00Z'); // 08:00 WIB
const DAY = 86_400_000;

function build({ env = {}, deliver = null, location = null, memory = null } = {}) {
  const db = new Database(':memory:');
  let clock = T0;
  const store = createVehicleStore(db);
  const svc = new VehicleService({ store, location, now: () => clock, env, deliver, memory });
  return { db, store, svc, set: (ms) => { clock = ms; }, advance: (ms) => { clock += ms; } };
}

function makeApp(module, env = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/vehicle', createVehicleRouter({ vehicle: module, env }));
  return app;
}

// ====================================================== maintenance intervals

describe('maintenance due maths (km OR months, never "safe" without data)', () => {
  const item = (p) => ({ interval_km: null, interval_months: null, last_service_at: null, last_service_odo_km: null, ...p });

  it('says "no_data" instead of guessing', () => {
    expect(dueStatus(item({ interval_km: 4000 }), { odoKm: 1000 }).status).toBe('no_data');
    expect(dueStatus(item({}), {}).status).toBe('no_data');
    expect(dueStatus(item({ interval_km: 4000 }), { odoKm: 1000 }).reason).toMatch(/riwayat servis/);
  });

  it('uses whichever trigger comes first', () => {
    const base = { interval_km: 4000, interval_months: 3, last_service_at: T0, last_service_odo_km: 10_000 };
    const ok = dueStatus(base, { odoKm: 11_000, nowMs: T0 + 10 * DAY });
    expect(ok.status).toBe('ok');
    expect(ok.kmRemaining).toBe(3000);

    const soonKm = dueStatus(base, { odoKm: 13_500, nowMs: T0 + 10 * DAY });
    expect(soonKm.status).toBe('due_soon');
    expect(soonKm.trigger).toBe('km');

    const overKm = dueStatus(base, { odoKm: 14_100, nowMs: T0 + 10 * DAY });
    expect(overKm.status).toBe('overdue');
    expect(overKm.trigger).toBe('km');

    const overMonths = dueStatus(base, { odoKm: 10_100, nowMs: T0 + 100 * DAY });
    expect(overMonths.status).toBe('overdue');
    expect(overMonths.trigger).toBe('months');
  });

  it('ships every catalogue interval as unverified with a visible note', () => {
    const items = seedItems('veh_test');
    expect(items).toHaveLength(DEFAULT_MAINTENANCE.length);
    expect(items.every((i) => i.verified === false && i.source === 'usulan-awal')).toBe(true);
    expect(UNVERIFIED_NOTE).toMatch(/belum diverifikasi/);
  });

  it('only computes consumption from a full-to-full pair', () => {
    expect(consumptionFromFill({ kmSincePrev: 200, liters: 4, fullTank: true, prevFullTank: true })).toMatchObject({ kmpl: 50 });
    expect(consumptionFromFill({ kmSincePrev: 200, liters: 4, fullTank: false, prevFullTank: true }).kmpl).toBeNull();
    expect(consumptionFromFill({ kmSincePrev: 0, liters: 4, fullTank: true, prevFullTank: true }).kmpl).toBeNull();
    expect(estimateFuel({ km: 150, kmpl: 50 }).liters).toBe(3);
    expect(estimateFuel({ km: 150, kmpl: null }).liters).toBeNull();
  });
});

// ============================================================ fuel bookkeeping

describe('fuel log and estimates', () => {
  it('stores the owner\'s numbers and derives km/L only when both fills were full', () => {
    const t = build();
    t.svc.addFill({ ts: T0, odoKm: 1000, liters: 4, fullTank: true });
    const f2 = t.svc.addFill({ ts: T0 + DAY, odoKm: 1200, liters: 4, fullTank: true, pricePerLiter: 12_000 });
    expect(f2.km_since_prev).toBe(200);
    expect(f2.consumption_kmpl).toBe(50);
    expect(f2.consumption_note).toMatch(/penuh ke penuh/);
    expect(f2.total_cost).toBe(48_000);
    // The last real price becomes the new default for estimates.
    expect(t.store.vehicles.active().price_per_liter).toBe(12_000);

    const partial = t.svc.addFill({ ts: T0 + 2 * DAY, odoKm: 1300, liters: 2, fullTank: false });
    expect(partial.consumption_kmpl).toBeNull();
    expect(partial.consumption_note).toMatch(/sebagian/);
  });

  it('refuses nonsense instead of storing it', () => {
    const t = build();
    expect(() => t.svc.addFill({ liters: 0 })).toThrowError(VehicleError);
    expect(() => t.svc.addFill({ liters: 40 })).toThrowError(/masuk akal/);
    t.svc.addFill({ ts: T0, odoKm: 1000, liters: 4, fullTank: true });
    expect(() => t.svc.addFill({ ts: T0 + 1000, odoKm: 900, liters: 4 })).toThrowError(/lebih kecil/);
    expect(t.store.fuel.count(t.svc.vehicle().id)).toBe(1);
  });

  it('estimates fuel left from the odometer window and labels it as a model', () => {
    const t = build();
    t.svc.updateVehicle({ tank_liters: 5.5, price_per_liter: 12_000 });
    t.svc.addFill({ ts: T0, odoKm: 1000, liters: 4.8, fullTank: true });
    t.set(T0 + 3 * DAY);
    t.svc.addReading({ odoKm: 1250 });
    const st = t.svc.fuelStatus();
    expect(st.sinceFull.km).toBe(250);
    expect(st.sinceFull.kmSource).toMatch(/odometer/);
    expect(st.estimate.litersUsed).toBe(5); // 250 km ÷ 50 km/L
    expect(st.estimate.remainingL).toBe(0.5);
    expect(st.estimate.remainingKm).toBe(25);
    expect(st.estimate.labels.sensor).toMatch(/TIDAK TERSEDIA/);
    expect(st.warnings.some((w) => /jangkauan/.test(w.text))).toBe(true);
    expect(st.honesty.join(' ')).toMatch(/bukan pembacaan sensor/);
  });

  it('falls back to the GPS track when no odometer exists, and says so', () => {
    const location = {
      store: { trips: { recent: () => [{ started_at: T0 + 1000, distance_m: 12_000 }] } },
    };
    const t = build({ location });
    t.svc.updateVehicle({ tank_liters: 5.5 });
    t.svc.addFill({ ts: T0, odoKm: null, liters: 4.5, fullTank: true });
    t.set(T0 + 2 * DAY);
    const st = t.svc.fuelStatus();
    expect(st.sinceFull.km).toBe(12); // 12,000 m of GPS track
    expect(st.sinceFull.kmSource).toMatch(/GPS/);
    expect(st.sinceFull.kmSource).toMatch(/bukan odometer/);
    expect(st.estimate.litersUsed).toBe(0.24); // 12 km ÷ 50 km/L
  });

  it('estimates a trip cost from the configured baseline, marked as an estimate', () => {
    const t = build();
    t.svc.updateVehicle({ price_per_liter: 12_000 });
    const e = t.svc.estimateTrip(120);
    expect(e.liters).toBe(2.4);
    expect(e.cost).toBe(28_800);
    expect(e.note).toMatch(/bukan pembacaan sensor/);
    expect(t.svc.estimateTrip(100, { kmpl: 40 }).liters).toBe(2.5);
  });

  it('proposes a calibration from real fills but never applies it silently', () => {
    const t = build();
    expect(t.svc.calibrationProposal().available).toBe(false);
    expect(() => t.svc.applyCalibration()).toThrowError(/minimal 3/);

    t.svc.addFill({ ts: T0, odoKm: 1000, liters: 5, fullTank: true });
    t.svc.addFill({ ts: T0 + 1, odoKm: 1200, liters: 5, fullTank: true });
    t.svc.addFill({ ts: T0 + 2, odoKm: 1400, liters: 5, fullTank: true });
    t.svc.addFill({ ts: T0 + 3, odoKm: 1600, liters: 5, fullTank: true });
    const p = t.svc.calibrationProposal();
    expect(p.available).toBe(true);
    expect(p.proposedKmpl).toBe(40);
    expect(p.changePct).toBe(-20);
    // Nothing moved until the owner accepts.
    expect(t.store.vehicles.active().baseline_kmpl).toBe(50);
    const applied = t.svc.applyCalibration();
    expect(applied.applied).toBe(true);
    expect(t.store.vehicles.active().baseline_kmpl).toBe(40);
  });

  it('honours FUEL_BASELINE_KMPL from the environment without inventing a new default', () => {
    const t = build({ env: { FUEL_BASELINE_KMPL: '45' } });
    expect(t.svc.vehicle().baseline_kmpl).toBe(45);
    const t2 = build();
    expect(t2.svc.vehicle().baseline_kmpl).toBe(DEFAULT_VEHICLE.baselineKmpl);
  });
});

// ================================================================= odometer

describe('odometer bookkeeping', () => {
  it('refuses a lower reading unless the panel was replaced', () => {
    const t = build();
    const first = t.svc.addReading({ odoKm: 1000 });
    expect(first.delta).toBeNull();
    t.set(T0 + DAY);
    const err = (() => { try { t.svc.addReading({ odoKm: 900 }); return null; } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(VehicleError);
    expect(err.code).toBe('lower_than_previous');
    const replaced = t.svc.addReading({ odoKm: 900, allowRegression: true, note: 'ganti panel' });
    expect(replaced.delta).toBe(-100);
    const o = t.svc.odometerStatus();
    expect(o.lastReading.odo_km).toBe(900);
    expect(o.needsUpdate).toBe(false);
    expect(o.gpsNote).toMatch(/panel motor/);
  });

  it('nudges the owner when the reading is old — and never converts GPS into odometer', () => {
    const t = build();
    t.svc.addReading({ odoKm: 1000 });
    t.set(T0 + 20 * DAY);
    const o = t.svc.odometerStatus();
    expect(o.needsUpdate).toBe(true);
    expect(o.suggestion).toMatch(/20 hari/);
    expect(o.readings).toHaveLength(1);
  });
});

// ============================================================== maintenance

describe('maintenance tracking', () => {
  it('labels every unverified item and clears the label only on owner confirmation', () => {
    const t = build();
    const items = t.svc.status().items;
    expect(items).toHaveLength(DEFAULT_MAINTENANCE.length);
    expect(items.every((i) => i.verified === false)).toBe(true);
    expect(items[0].intervalNote).toMatch(/usulan awal|belum diverifikasi/);

    const updated = t.svc.updateItem('oli_mesin', { intervalKm: 4500, intervalMonths: 4, verified: true, source: 'buku manual pemilik' });
    expect(updated.verified).toBe(1);
    expect(updated.interval_km).toBe(4_500);
    const st = t.svc.status().items.find((i) => i.key === 'oli_mesin');
    expect(st.intervalNote).toBeNull();
    expect(st.suggested.km).toBe(4000); // the original suggestion stays visible
    expect(() => t.svc.updateItem('tidak_ada', {})).toThrowError(/tidak dikenal/);
  });

  it('resets the schedule when a service is logged and records the memory hook', () => {
    const remembered = [];
    const t = build({ memory: (e) => remembered.push(e) });
    t.svc.addReading({ ts: T0, odoKm: 5000 });
    t.svc.logService({ itemKey: 'oli_mesin', ts: T0 + 1000, odoKm: 5000, workshop: 'AHASS' });
    const after = t.svc.status().items.find((i) => i.key === 'oli_mesin');
    expect(after.lastServiceOdoKm).toBe(5000);
    expect(after.status).toBe('ok');
    expect(after.kmRemaining).toBe(4000);
    expect(remembered[0].kind).toBe('service_record');
    expect(remembered[0].workshop).toBe('AHASS');
  });

  it('reports health with honest caveats and safety warnings', () => {
    const t = build();
    t.svc.updateItem('rem', { intervalKm: 1000, intervalMonths: null });
    t.svc.addReading({ ts: T0, odoKm: 2000 });
    t.svc.logService({ itemKey: 'rem', ts: T0, odoKm: 500 });
    const report = t.svc.healthReport();
    expect(report.due).toContain('rem');
    expect(report.safetyWarnings.join(' ')).toMatch(/keselamatan/);
    expect(report.honesty.join(' ')).toMatch(/tidak memeriksa kondisi fisik/);
  });

  it('claims each reminder once — repeated ticks never spam', async () => {
    const delivered = [];
    const t = build({ deliver: (n) => { delivered.push(n); return { ok: true }; } });
    t.svc.updateItem('ban', { intervalKm: 100, intervalMonths: null });
    t.svc.addReading({ ts: T0, odoKm: 1000 });
    t.svc.logService({ itemKey: 'ban', ts: T0, odoKm: 1000 });
    t.set(T0 + 1000);
    t.svc.addReading({ odoKm: 1200 }); // 200 km > 100 km interval → overdue
    const first = t.svc.checkReminders();
    const second = t.svc.checkReminders();
    await new Promise((r) => setImmediate(r));
    expect(first.some((n) => n.kind === 'maintenance_overdue' && /Ban/.test(n.text))).toBe(true);
    expect(second.filter((n) => n.kind.startsWith('maint'))).toHaveLength(0);
    expect(delivered.length).toBeGreaterThan(0);
  });
});

// =============================================================== quick chat

describe('quick vehicle intents (code, no model)', () => {
  it('answers fuel questions with model-vs-sensor honesty', () => {
    const t = build();
    expect(quickVehicle(t.svc, 'sisa bensin masih berapa?')).toMatch(/kapasitas tangki belum diisi/);
    t.svc.updateVehicle({ tank_liters: 5, price_per_liter: 12_000 });
    t.svc.addFill({ ts: T0, odoKm: 1000, liters: 4, fullTank: true });
    t.set(T0 + DAY);
    t.svc.addReading({ odoKm: 1200 });
    const ans = quickVehicle(t.svc, 'masih ada berapa liter bensin?');
    expect(ans).toMatch(/±1 liter/);
    expect(ans).toMatch(/estimasi model/);
    const cons = quickVehicle(t.svc, 'berapa km/l bensin motor saya?');
    expect(cons).toMatch(/Konsumsi acuan: 50 km\/L/);
  });

  it('answers odometer and maintenance questions from the records', () => {
    const t = build();
    expect(quickVehicle(t.svc, 'odometer motor saya berapa?')).toMatch(/Belum ada catatan odometer/);
    t.svc.addReading({ ts: T0, odoKm: 5321 });
    t.set(T0 + DAY);
    expect(quickVehicle(t.svc, 'odometer motor saya berapa?')).toMatch(/5321 km/);
    const service = quickVehicle(t.svc, 'kapan jadwal servis motor?');
    expect(service).toMatch(/usulan/);
    expect(service).toMatch(/bukan pemeriksaan fisik/);
  });

  it('estimates a ride cost and ignores unrelated text', () => {
    const t = build();
    t.svc.updateVehicle({ price_per_liter: 12_000 });
    const trip = quickVehicle(t.svc, 'kalau perjalanan 30 km butuh berapa liter bensin?');
    expect(trip).toMatch(/Estimasi 30 km/);
    expect(trip).toMatch(/perkiraan model/);
    expect(quickVehicle(t.svc, 'tolong buatkan puisi tentang hujan')).toBeNull();
  });
});

// ================================================================== routes

describe('vehicle routes', () => {
  it('serves the overview on loopback and refuses nonsense input', async () => {
    const t = build();
    const app = makeApp({ store: t.store, service: t.svc });
    const ov = await request(app).get('/api/vehicle/overview');
    expect(ov.status).toBe(200);
    expect(ov.body.vehicle.name).toBe('Honda Vario 160 CBS');
    expect(ov.body.honesty.join(' ')).toMatch(/sensor bensin/);
    const bad = await request(app).post('/api/vehicle/fuel').send({ liters: 0 });
    expect(bad.status).toBe(400);
    const ok = await request(app).post('/api/vehicle/fuel').send({ odoKm: 1000, liters: 4, fullTank: true, pricePerLiter: 12_000 });
    expect(ok.status).toBe(201);
    expect(ok.body.estimate.vehicle.baselineKmpl).toBe(50);
  });

  it('answers 409 for a lower odometer and accepts the explicit override', async () => {
    const t = build();
    const app = makeApp({ store: t.store, service: t.svc });
    await request(app).post('/api/vehicle/odometer').send({ odoKm: 1000 });
    const conflict = await request(app).post('/api/vehicle/odometer').send({ odoKm: 900 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('lower_than_previous');
    const override = await request(app).post('/api/vehicle/odometer').send({ odoKm: 900, allowRegression: true });
    expect(override.status).toBe(201);
    expect(override.body.delta).toBe(-100);
  });

  it('updates maintenance items and records services through the routes', async () => {
    const t = build();
    const app = makeApp({ store: t.store, service: t.svc });
    const notFound = await request(app).patch('/api/vehicle/maintenance/tidak_ada').send({ intervalKm: 10 });
    expect(notFound.status).toBe(404);
    const patched = await request(app).patch('/api/vehicle/maintenance/oli_mesin').send({ intervalKm: 4500, intervalMonths: 4, verified: true });
    expect(patched.status).toBe(200);
    expect(patched.body.item.interval_km).toBe(4_500);
    expect(patched.body.item.verified).toBe(1);
    const logged = await request(app).post('/api/vehicle/maintenance/oli_mesin/log').send({ odoKm: 1500, workshop: 'AHASS Bekasi' });
    expect(logged.status).toBe(201);
    const item = logged.body.maintenance.items.find((i) => i.key === 'oli_mesin');
    expect(item.lastServiceOdoKm).toBe(1500);
    const services = await request(app).get('/api/vehicle/services');
    expect(services.body.services).toHaveLength(1);
  });

  it('exposes calibration as a proposal and refuses to apply it too early', async () => {
    const t = build();
    const app = makeApp({ store: t.store, service: t.svc });
    const proposal = await request(app).get('/api/vehicle/calibration');
    expect(proposal.body.proposal.available).toBe(false);
    const early = await request(app).post('/api/vehicle/calibration/apply');
    expect(early.status).toBe(409);
    for (const odo of [1000, 1200, 1400, 1600]) {
      await request(app).post('/api/vehicle/fuel').send({ ts: T0 + odo, odoKm: odo, liters: 5, fullTank: true });
    }
    const applied = await request(app).post('/api/vehicle/calibration/apply');
    expect(applied.status).toBe(200);
    expect(applied.body.result.proposedKmpl).toBe(40);
  });

  it('accepts owner configuration and rejects impossible values', async () => {
    const t = build();
    const app = makeApp({ store: t.store, service: t.svc });
    const ok = await request(app).put('/api/vehicle').send({ tank_liters: 5.5, price_per_liter: 12_000, baseline_kmpl: 48 });
    expect(ok.status).toBe(200);
    expect(ok.body.vehicle.tank_liters).toBe(5.5);
    expect(ok.body.vehicle.baseline_kmpl).toBe(48);
    const bad = await request(app).put('/api/vehicle').send({ baseline_kmpl: 0 });
    expect(bad.status).toBe(400);
    const badRange = await request(app).put('/api/vehicle').send({ reserve_km: 'jauh' });
    expect(badRange.status).toBe(400);
  });

  it('serves the health report and the fuel log', async () => {
    const t = build();
    const app = makeApp({ store: t.store, service: t.svc });
    const health = await request(app).get('/api/vehicle/health');
    expect(health.status).toBe(200);
    expect(health.body.report.honesty.length).toBeGreaterThan(0);
    await request(app).post('/api/vehicle/fuel').send({ odoKm: 1000, liters: 4, fullTank: true });
    const fuel = await request(app).get('/api/vehicle/fuel');
    expect(fuel.body.logs).toHaveLength(1);
    expect(fuel.body.calibration.available).toBe(false);
  });
});
