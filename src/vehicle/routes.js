/**
 * src/vehicle/routes.js
 *
 * REST + SSE for motorcycle care: fuel log, odometer, maintenance schedule and
 * service history. Owner dashboard only (localhost or AUTOMATION_TOKEN).
 *
 *   GET    /overview  /status  /fuel  /odometer  /maintenance  /services  /health
 *   GET    /events                     SSE
 *   PUT    /                           the vehicle itself (mounted at /api/vehicle)
 *   POST   /fuel          DELETE /fuel/:id
 *   POST   /odometer
 *   PATCH  /maintenance/:key
 *   POST   /maintenance/:key/log       record a service done
 *   GET    /calibration   POST /calibration/apply
 *
 * @author Wisnu Alfian Nur Ashar
 */

import express from 'express';
import { createAccessGuard, issueStreamTicket } from '../automation/routes.js';
import { VehicleError } from './service.js';
import { DEFAULT_MAINTENANCE } from './intervals.js';

const STATUS_FOR_CODE = {
  not_found: 404,
  bad_state: 409,
  bad_range: 400,
  lower_than_previous: 409,
  bad_request: 400,
};

export function createVehicleRouter({ vehicle, rateLimiters = {}, env = process.env }) {
  const svc = vehicle.service;
  const store = vehicle.store;
  const router = express.Router();
  router.use(createAccessGuard(env));
  const noop = (req, res, next) => next();
  const act = rateLimiters.automation || noop;

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof VehicleError) {
        return res.status(STATUS_FOR_CODE[err.code] || 400).json({ success: false, error: err.message, code: err.code });
      }
      console.error('[VEHICLE] route error:', err);
      return res.status(500).json({ success: false, error: 'Kesalahan internal modul kendaraan' });
    }
  };

  router.get('/stream-ticket', (req, res) => {
    const secret = String(env.AUTOMATION_TOKEN || '');
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ticket: secret ? issueStreamTicket(secret) : null });
  });

  router.get('/status', wrap((req, res) => res.json({ success: true, status: svc.status() })));

  router.get('/overview', wrap((req, res) => {
    const v = svc.vehicle();
    res.json({
      success: true,
      vehicle: v,
      fuel: svc.fuelStatus(),
      odometer: svc.odometerStatus(),
      maintenance: svc.status(),
      fuelLogs: store.fuel.recent(v.id, 20),
      serviceRecords: store.services.recent(v.id, 20),
      calibration: svc.calibrationProposal(),
      honesty: [
        'Tidak ada sensor bensin di sistem ini: semua angka sisa adalah estimasi model.',
        'Odometer hanya berubah dari pembacaan manual Anda, tidak pernah ditambah otomatis dari GPS.',
      ],
    });
  }));

  router.put('/', act, wrap((req, res) => {   // full path: PUT /api/vehicle
    const updated = svc.updateVehicle(req.body || {});
    res.json({ success: true, vehicle: updated });
  }));

  // -------------------------------------------------------------------- fuel

  router.get('/fuel', wrap((req, res) => {
    const v = svc.vehicle();
    res.json({ success: true, logs: store.fuel.recent(v.id, 100), estimate: svc.fuelStatus(), calibration: svc.calibrationProposal() });
  }));

  router.post('/fuel', act, wrap((req, res) => {
    const b = req.body || {};
    const fill = svc.addFill({
      ts: Number.isFinite(Number(b.ts)) ? Number(b.ts) : Date.now(),
      odoKm: b.odoKm ?? b.odo_km ?? null,
      liters: b.liters ?? b.liter,
      pricePerLiter: b.pricePerLiter ?? b.price_per_liter ?? null,
      totalCost: b.totalCost ?? null,
      fullTank: b.fullTank ?? b.full_tank ?? false,
      station: b.station || null,
      placeId: b.placeId || null,
      fuelType: b.fuelType || null,
      note: b.note || null,
    });
    res.status(201).json({ success: true, fill, estimate: svc.fuelStatus() });
  }));

  router.delete('/fuel/:id', act, wrap((req, res) => {
    const ok = store.fuel.remove(req.params.id);
    if (!ok) throw new VehicleError('Catatan pengisian tidak ditemukan.', 'not_found');
    res.json({ success: true });
  }));

  // ---------------------------------------------------------------- odometer

  router.get('/odometer', wrap((req, res) => res.json({ success: true, ...svc.odometerStatus() })));

  router.post('/odometer', act, wrap((req, res) => {
    const b = req.body || {};
    const out = svc.addReading({
      ts: Number.isFinite(Number(b.ts)) ? Number(b.ts) : Date.now(),
      odoKm: b.odoKm ?? b.odo_km,
      note: b.note || null,
      source: b.source || 'manual',
      confidence: b.confidence || 'high',
      allowRegression: b.allowRegression === true,
    });
    res.status(201).json({ success: true, ...out, odometer: svc.odometerStatus() });
  }));

  // ------------------------------------------------------------- maintenance

  router.get('/maintenance', wrap((req, res) => {
    res.json({ success: true, ...svc.status(), catalogue: DEFAULT_MAINTENANCE.map((i) => i.key) });
  }));

  router.patch('/maintenance/:key', act, wrap((req, res) => {
    const item = svc.updateItem(req.params.key, req.body || {});
    res.json({ success: true, item });
  }));

  router.post('/maintenance/:key/log', act, wrap((req, res) => {
    const b = req.body || {};
    const record = svc.logService({
      itemKey: req.params.key,
      ts: Number.isFinite(Number(b.ts)) ? Number(b.ts) : Date.now(),
      odoKm: b.odoKm ?? null,
      workshop: b.workshop || null,
      cost: b.cost ?? null,
      parts: Array.isArray(b.parts) ? b.parts : null,
      notes: b.notes || null,
      evidence: b.evidence || null,
    });
    res.status(201).json({ success: true, record, maintenance: svc.status() });
  }));

  router.get('/services', wrap((req, res) => {
    const v = svc.vehicle();
    res.json({ success: true, services: store.services.recent(v.id, 100) });
  }));

  router.post('/services', act, wrap((req, res) => {
    const b = req.body || {};
    const record = svc.logService({
      itemKey: b.itemKey || null,
      ts: Number.isFinite(Number(b.ts)) ? Number(b.ts) : Date.now(),
      odoKm: b.odoKm ?? null,
      workshop: b.workshop || null,
      cost: b.cost ?? null,
      parts: Array.isArray(b.parts) ? b.parts : null,
      notes: b.notes || null,
      evidence: b.evidence || null,
    });
    res.status(201).json({ success: true, record });
  }));

  router.delete('/services/:id', act, wrap((req, res) => {
    const ok = store.services.remove(req.params.id);
    if (!ok) throw new VehicleError('Catatan servis tidak ditemukan.', 'not_found');
    res.json({ success: true });
  }));

  // ------------------------------------------------------------------ health

  router.get('/health', wrap((req, res) => res.json({ success: true, report: svc.healthReport() })));

  router.get('/calibration', wrap((req, res) => res.json({ success: true, proposal: svc.calibrationProposal() })));
  router.post('/calibration/apply', act, wrap((req, res) => {
    res.json({ success: true, result: svc.applyCalibration() });
  }));

  // ---------------------------------------------------------------- realtime

  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 5000\n\n');
    const send = (e) => { try { res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`); } catch { /* closed */ } };
    svc.on('change', send);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);
    req.on('close', () => { clearInterval(hb); svc.off('change', send); });
  });

  return router;
}
