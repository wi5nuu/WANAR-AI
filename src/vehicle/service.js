/**
 * src/vehicle/service.js
 *
 * Motorcycle care: fuel consumption, odometer bookkeeping and the maintenance
 * schedule. The rules that keep this honest, in one place:
 *
 *   - GPS distance is a trajectory estimate. It is never added to the odometer
 *     automatically; an odometer number only ever comes from a real reading.
 *   - Fuel "remaining" is always a model estimate derived from the last full
 *     fill-up, clearly separated from "litres used" and from a sensor reading —
 *     because this motorcycle has no fuel sensor connected to the system.
 *   - A consumption calibration is PROPOSED from full-to-full fill-ups; the
 *     baseline changes only when the owner accepts the proposal.
 *   - Maintenance intervals that the owner has not verified are labelled as
 *     such in every reminder (see intervals.js).
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { EventEmitter } from 'node:events';
import { DEFAULT_VEHICLE } from './store.js';
import { seedItems, dueStatus, consumptionFromFill, estimateFuel, UNVERIFIED_NOTE } from './intervals.js';
import { localDate, localTime } from '../worklog/time.js';

export class VehicleError extends Error {
  constructor(message, code = 'bad_request') {
    super(message);
    this.name = 'VehicleError';
    this.code = code;
  }
}

const round = (n, d = 2) => (n == null ? null : Number(Number(n).toFixed(d)));
const NUM = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

export function formatVehicleNotice({ kind, item = null, reason = '', vehicle = {}, note = null, raw = null }) {
  const plate = vehicle?.plate ? ` (${vehicle.plate})` : '';
  const vname = (vehicle?.name || 'Honda Vario 160').toUpperCase();
  if (kind === 'maintenance_overdue') {
    return [
      `🛵 <b>PENGINGAT PERAWATAN MOTOR — ${vname}${plate}</b>`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `⚠️ <b>STATUS: JATUH TEMPO</b>`,
      `Komponen: <b>${item?.name || 'Komponen'}</b>`,
      `Keterangan: ${item?.name || 'Komponen'} sudah jatuh tempo: ${reason}.${note ? ` ${note}` : ''}`,
      item?.safetyCritical ? 'PENTING: Komponen ini berkaitan langsung dengan keselamatan berkendara — prioritaskan pemeriksaan di bengkel resmi AHASS.' : 'Disarankan segera melakukan servis berkala.',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');
  }
  if (kind === 'maintenance_soon') {
    return [
      `🛵 <b>PENGINGAT PERAWATAN MOTOR — ${vname}${plate}</b>`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `⏳ <b>STATUS: MENDEKATI JADWAL SERVIS</b>`,
      `Komponen: <b>${item?.name || 'Komponen'}</b>`,
      `Keterangan: ${item?.name || 'Komponen'} mendekati jadwal: ${reason}.${note ? ` ${note}` : ''}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');
  }
  if (kind === 'odometer_stale') {
    return [
      `🛵 <b>PENGINGAT ODOMETER — ${vname}${plate}</b>`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `ℹ️ ${reason}`,
      'Kirim /odometer <angka> di Telegram untuk memperbarui angka aktual.',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');
  }
  if (kind === 'fuel_warning') {
    return [
      `⛽ <b>PENGINGAT BAHAN BAKAR — ${vname}${plate}</b>`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `⚠️ ${reason}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');
  }
  return raw || reason;
}

export class VehicleService extends EventEmitter {
  constructor({ store, location = null, now = () => Date.now(), env = process.env, deliver = null, memory = null }) {
    super();
    this.store = store;
    this.location = location;
    this.now = now;
    this.env = env;
    this.deliver = deliver;
    this.memory = memory;
    this._timer = null;
    this._ticking = false;
    this.ensureVehicle();
  }

  /** Creates the owner's motorcycle and the maintenance catalogue once. */
  ensureVehicle() {
    let v = this.store.vehicles.active();
    if (!v) {
      v = this.store.vehicles.create({
        name: this.env.VEHICLE_NAME || DEFAULT_VEHICLE.name,
        model: DEFAULT_VEHICLE.model,
        fuelType: this.env.VEHICLE_FUEL || DEFAULT_VEHICLE.fuelType,
        baselineKmpl: NUM(this.env.FUEL_BASELINE_KMPL) || DEFAULT_VEHICLE.baselineKmpl,
        tankLiters: NUM(this.env.VEHICLE_TANK_LITERS),
        reserveKm: NUM(this.env.FUEL_RESERVE_KM) || DEFAULT_VEHICLE.reserveKm,
        pricePerLiter: NUM(this.env.FUEL_PRICE_PER_LITER),
        warnLiterThreshold: DEFAULT_VEHICLE.warnLiterThresholdL,
      });
      for (const item of seedItems(v.id)) this.store.items.upsert(item);
    }
    return v;
  }

  vehicle() { return this.store.vehicles.active() || this.ensureVehicle(); }

  updateVehicle(patch = {}) {
    const v = this.vehicle();
    const clean = {};
    for (const [k, val] of Object.entries(patch)) {
      if (['name', 'model', 'plate', 'fuel_type'].includes(k)) clean[k] = val == null ? null : String(val);
      else if (['baseline_kmpl', 'tank_liters', 'reserve_km', 'price_per_liter', 'warn_liter_threshold'].includes(k)) {
        const n = NUM(val);
        if (n != null && (n < 0 || !Number.isFinite(n))) throw new VehicleError(`Nilai ${k} tidak valid.`, 'bad_request');
        clean[k] = n;
      }
    }
    if (clean.baseline_kmpl != null && clean.baseline_kmpl <= 0) throw new VehicleError('Konsumsi acuan harus lebih dari 0 km/liter.', 'bad_request');
    const updated = this.store.vehicles.update(v.id, clean);
    if (clean.baseline_kmpl != null) {
      this.store.notices.claim({
        kind: 'baseline_changed',
        dedupKey: `baseline:${v.id}:${this.now()}`,
        text: `Konsumsi acuan diubah manual menjadi ${clean.baseline_kmpl} km/liter.`,
      });
    }
    this._changed('vehicle');
    return updated;
  }

  _changed(kind, data = {}) { try { this.emit('change', { kind, ts: this.now(), ...data }); } catch { /* optional */ } }

  /** GPS distance (metres) travelled since an instant, from the location module. */
  gpsDistanceSince(ts) {
    if (!this.location || !ts) return null;
    try {
      const rows = this.location.store.trips.recent(500).filter((t) => t.started_at >= ts);
      return Math.round(rows.reduce((a, t) => a + (t.distance_m || 0), 0));
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------- fuel

  /**
   * Records a fill-up. Every number the owner typed is stored as typed; the
   * maths is stored next to it so a wrong assumption can be re-derived later.
   */
  addFill({ ts = this.now(), odoKm = null, liters, pricePerLiter = null, totalCost = null, fullTank = null, station = null, placeId = null, fuelType = null, source = 'manual', note = null } = {}) {
    const v = this.vehicle();
    const l = NUM(liters);
    if (!(l > 0)) throw new VehicleError('Jumlah liter harus lebih dari 0.', 'bad_request');
    if (l > 30) throw new VehicleError('Jumlah liter tidak masuk akal untuk motor ini (>30 L). Periksa kembali.', 'bad_request');
    const price = NUM(pricePerLiter ?? v.price_per_liter);
    if (price != null && price < 0) throw new VehicleError('Harga per liter tidak valid.', 'bad_request');
    const odo = NUM(odoKm);
    const prev = this.store.fuel.last(v.id);
    let kmSincePrev = null;
    let consumptionNote = 'jarak sejak pengisian sebelumnya belum bisa dihitung (butuh pembacaan odometer)';
    if (odo != null && prev?.odo_km != null) {
      kmSincePrev = round(odo - prev.odo_km, 1);
      if (kmSincePrev != null && kmSincePrev < 0) {
        throw new VehicleError('Odometer lebih kecil dari pengisian sebelumnya. Periksa angkanya (atau ganti odometer tercatat).', 'bad_range');
      }
    }
    const consumption = consumptionFromFill({ kmSincePrev, liters: l, fullTank: Boolean(fullTank), prevFullTank: Boolean(prev?.full_tank) });
    consumptionNote = consumption.kmpl != null ? consumption.reason : (kmSincePrev == null ? consumptionNote : consumption.reason);

    const fill = this.store.fuel.add({
      vehicleId: v.id, ts, odoKm: odo, liters: l, pricePerLiter: price,
      totalCost: totalCost != null ? NUM(totalCost) : (price != null ? round(l * price, 0) : null),
      fuelType: fuelType || v.fuel_type, fullTank: Boolean(fullTank), station, placeId,
      kmSincePrev, consumptionKmpl: consumption.kmpl, consumptionNote, source, note,
    });
    // Remember the last price the owner actually paid, so the next estimate uses reality.
    if (price != null && price !== v.price_per_liter) this.store.vehicles.update(v.id, { price_per_liter: price });
    this._changed('fuel_added', { fillId: fill.id });
    return fill;
  }

  fuelStatus({ sinceTs = null } = {}) {
    const v = this.vehicle();
    const lastFull = this.store.fuel.lastFull(v.id);
    const last = this.store.fuel.last(v.id);
    const consumptions = this.store.fuel.consumptions(v.id, 10).map((c) => c.consumption_kmpl).filter((n) => n > 0);
    const actualAvg = consumptions.length ? round(consumptions.reduce((a, b) => a + b, 0) / consumptions.length, 2) : null;
    const workingKmpl = actualAvg || v.baseline_kmpl;

    // Distance since the last FULL tank: prefer the odometer (real), fall back to GPS (estimate).
    let kmSince = null;
    let kmSource = null;
    if (lastFull) {
      const odo = this.store.odometer.last(v.id);
      if (odo && lastFull.odo_km != null && odo.ts >= lastFull.ts && odo.odo_km >= lastFull.odo_km) {
        kmSince = round(odo.odo_km - lastFull.odo_km, 1);
        kmSource = 'odometer (pembacaan manual)';
      } else {
        const gps = this.gpsDistanceSince(lastFull.ts);
        if (gps != null) { kmSince = round(gps / 1000, 2); kmSource = 'jarak lintasan GPS (perkiraan, bukan odometer)'; }
      }
    }
    const used = kmSince != null ? estimateFuel({ km: kmSince, kmpl: workingKmpl }) : { liters: null, reason: 'belum ada pengisian penuh sebagai titik awal' };
    const remainingL = v.tank_liters != null && used.liters != null ? round(Math.max(0, v.tank_liters - used.liters), 2) : null;
    const remainingKm = remainingL != null && workingKmpl ? round(remainingL * workingKmpl) : null;

    const warnings = [];
    if (remainingKm != null && remainingKm < (v.reserve_km || 60)) {
      warnings.push({
        level: 'warn',
        text: `Perkiraan jangkauan berbasis model tinggal sekitar ${remainingKm} km (acuan ${workingKmpl} km/L, sejak pengisian penuh di ${localTime(lastFull.ts)}). Ini estimasi model, bukan pembacaan sensor bensin.`,
      });
    } else if (remainingL != null && remainingL <= (v.warn_liter_threshold || 2)) {
      warnings.push({
        level: 'warn',
        text: `Perkiraan sisa bahan bakar sekitar ${remainingL} L (model, bukan sensor). Sebaiknya isi sebelum perjalanan jauh.`,
      });
    }
    if (consumptions.length >= 3 && v.baseline_kmpl && Math.abs(actualAvg - v.baseline_kmpl) / v.baseline_kmpl > 0.1) {
      warnings.push({
        level: 'info',
        text: `Konsumsi aktual (${actualAvg} km/L dari ${consumptions.length} pengisian penuh) berbeda dari acuan ${v.baseline_kmpl} km/L. Kalibrasi tersedia sebagai usulan.`,
      });
    }

    return {
      vehicle: { id: v.id, name: v.name, fuelType: v.fuel_type, baselineKmpl: v.baseline_kmpl, tankLiters: v.tank_liters, pricePerLiter: v.price_per_liter, reserveKm: v.reserve_km },
      lastFill: last,
      lastFullFill: lastFull,
      sinceFull: { km: kmSince, kmSource, windowStart: lastFull?.ts || null },
      estimate: {
        litersUsed: used.liters,
        method: used.reason,
        workingKmpl,
        workingKmplSource: actualAvg ? `rata-rata aktual dari ${consumptions.length} pengisian penuh` : 'konsumsi acuan (baseline) yang dikonfigurasi',
        remainingL,
        remainingKm,
        labels: {
          used: 'estimasi liter terpakai sejak pengisian penuh',
          remaining: remainingL != null ? 'perkiraan sisa berdasarkan model (bukan sensor)' : 'perkiraan sisa tidak tersedia (kapasitas tangki belum diisi)',
          sensor: 'level bahan bakar aktual dari sensor: TIDAK TERSEDIA (motor ini tidak punya sensor yang terhubung ke sistem)',
        },
      },
      actualConsumption: { samples: consumptions.length, kmpl: actualAvg },
      warnings,
      honesty: [
        'Angka "terpakai" dan "sisa" dihitung dari jarak dan konsumsi acuan; keduanya bukan pembacaan sensor bensin.',
        'Konsumsi aktual hanya dihitung dari pengisian penuh ke penuh. Pengisian sebagian tidak menghasilkan angka konsumsi yang sahih.',
      ],
    };
  }

  /** "Kalau saya pergi X km, berapa liter dan berapa rupiah?" */
  estimateTrip(km, { kmpl = null, pricePerLiter = null } = {}) {
    const v = this.vehicle();
    const st = this.fuelStatus();
    const useKmpl = NUM(kmpl) || st.estimate.workingKmpl || v.baseline_kmpl;
    const price = NUM(pricePerLiter) ?? v.price_per_liter;
    const out = estimateFuel({ km, kmpl: useKmpl });
    return {
      km: Number(km) || 0,
      kmpl: useKmpl,
      liters: out.liters,
      cost: out.liters != null && price != null ? round(out.liters * price, 0) : null,
      pricePerLiter: price,
      note: out.liters == null ? out.reason : 'estimasi berdasarkan konsumsi acuan; bukan pembacaan sensor',
    };
  }

  /** Proposes a baseline calibration from real full-to-full fill-ups. Never applies it silently. */
  calibrationProposal() {
    const v = this.vehicle();
    const consumptions = this.store.fuel.consumptions(v.id, 10).map((c) => c.consumption_kmpl).filter((n) => n > 0);
    if (consumptions.length < 3) {
      return { available: false, reason: `butuh minimal 3 pengisian penuh-ke-penuh dengan odometer; baru ada ${consumptions.length}`, samples: consumptions };
    }
    const avg = round(consumptions.reduce((a, b) => a + b, 0) / consumptions.length, 2);
    const change = v.baseline_kmpl ? round(((avg - v.baseline_kmpl) / v.baseline_kmpl) * 100, 1) : null;
    return {
      available: true,
      currentKmpl: v.baseline_kmpl,
      proposedKmpl: avg,
      changePct: change,
      samples: consumptions,
      message: `Dari ${consumptions.length} pengisian penuh, konsumsi aktual rata-rata ${avg} km/L (acuan sekarang ${v.baseline_kmpl} km/L). Setujui untuk memakai angka aktual sebagai acuan.`,
    };
  }

  /** Owner accepts the calibration — this is the ONLY way the baseline changes from data. */
  applyCalibration() {
    const p = this.calibrationProposal();
    if (!p.available) throw new VehicleError(p.reason, 'bad_state');
    const v = this.vehicle();
    this.store.vehicles.update(v.id, { baseline_kmpl: p.proposedKmpl });
    this.store.notices.claim({
      kind: 'calibration_applied',
      dedupKey: `calib:${v.id}:${p.proposedKmpl}:${localDate(this.now())}`,
      text: `Konsumsi acuan diperbarui dari ${p.currentKmpl} menjadi ${p.proposedKmpl} km/L berdasarkan ${p.samples.length} pengisian penuh.`,
    });
    try {
      this.memory?.({ kind: 'fuel_calibration', current: p.currentKmpl, proposed: p.proposedKmpl, samples: p.samples.length, at: this.now() });
    } catch { /* optional */ }
    this._changed('calibration');
    return { ...p, applied: true };
  }

  // ----------------------------------------------------------------- odometer

  /**
   * Records a real odometer reading. `allowRegression` is an explicit override
   * (replaced panel) — otherwise a lower number is refused instead of stored.
   */
  addReading({ ts = this.now(), odoKm, note = null, source = 'manual', confidence = 'high', allowRegression = false } = {}) {
    const v = this.vehicle();
    const odo = NUM(odoKm);
    if (!(odo >= 0)) throw new VehicleError('Angka odometer tidak valid.', 'bad_request');
    const prev = this.store.odometer.last(v.id);
    if (prev && odo < prev.odo_km && !allowRegression) {
      throw new VehicleError(
        `Odometer ${odo} km lebih kecil dari pembacaan sebelumnya ${prev.odo_km} km. Kalau panel/speedometer baru diganti, kirim ulang dengan allowRegression=true.`,
        'lower_than_previous'
      );
    }
    const gpsM = prev ? this.gpsDistanceSince(prev.ts) : null;
    const reading = this.store.odometer.add({
      vehicleId: v.id, ts, odoKm: odo, source, confidence,
      gpsDistanceSincePrevKm: gpsM != null ? round(gpsM / 1000, 2) : null,
      note,
    });
    this._changed('odometer_added', { readingId: reading.id });
    return {
      reading,
      gpsSincePrevious: gpsM != null
        ? {
          km: round(gpsM / 1000, 2),
          note: 'Jarak ini berasal dari lintasan GPS dan hanya sebagai pembanding. Total odometer tidak pernah dihitung otomatis dari GPS.',
        }
        : null,
      delta: prev ? round(odo - prev.odo_km, 1) : null,
    };
  }

  odometerStatus() {
    const v = this.vehicle();
    const last = this.store.odometer.last(v.id);
    const now = this.now();
    const ageDays = last ? Math.floor((now - last.ts) / 86_400_000) : null;
    const gpsM = last ? this.gpsDistanceSince(last.ts) : null;
    const suggested = !last || (ageDays != null && ageDays >= 14);
    return {
      lastReading: last,
      ageDays,
      gpsDistanceSinceKm: gpsM != null ? round(gpsM / 1000, 2) : null,
      gpsNote: 'GPS hanya memperkirakan jarak tempuh; total odometer butuh pembacaan langsung pada panel motor.',
      needsUpdate: suggested,
      suggestion: suggested
        ? (last
          ? `Catatan odometer belum diperbarui ${ageDays} hari. Periksa angka aktual pada panel motor untuk meningkatkan akurasi.`
          : 'Belum ada catatan odometer sama sekali. Catat angka pada panel motor sekali agar jadwal servis berbasis km bisa dihitung.')
        : null,
      readings: this.store.odometer.recent(v.id, 10),
    };
  }

  // -------------------------------------------------------------- maintenance

  /** Current odometer estimate for schedule maths, with its provenance. */
  _currentOdo() {
    const v = this.vehicle();
    const last = this.store.odometer.last(v.id);
    if (last) return { km: last.odo_km, estimated: false, source: `pembacaan odometer ${localDate(last.ts)}` };
    // No odometer at all: an anchor from the last service record, plus GPS — flagged as estimate.
    const svc = this.store.services.recent(v.id, 1)[0];
    if (svc?.odo_km != null) {
      const gps = this.gpsDistanceSince(svc.ts);
      return { km: svc.odo_km + (gps ? gps / 1000 : 0), estimated: true, source: `perkiraan: odometer servis ${svc.odo_km} km + jarak GPS (bukan odometer aktual)` };
    }
    return { km: null, estimated: true, source: 'tidak ada odometer' };
  }

  status() {
    const v = this.vehicle();
    const odo = this._currentOdo();
    const items = this.store.items.list(v.id, { activeOnly: true }).map((item) => {
      const due = dueStatus(item, { odoKm: odo.km, odoEstimated: odo.estimated, nowMs: this.now() });
      return {
        key: item.key,
        name: item.name,
        intervalKm: item.interval_km,
        intervalMonths: item.interval_months,
        suggested: { km: item.suggested_km, months: item.suggested_months },
        verified: Boolean(item.verified),
        source: item.source,
        safetyCritical: Boolean(item.safety_critical),
        notes: item.notes,
        lastServiceAt: item.last_service_at,
        lastServiceOdoKm: item.last_service_odo_km,
        ...due,
        intervalNote: item.verified ? null : UNVERIFIED_NOTE,
      };
    });
    const byStatus = { overdue: [], due_soon: [], ok: [], no_data: [] };
    for (const it of items) {
      if (it.status === 'overdue' || it.status === 'due') byStatus.overdue.push(it);
      else if (it.status === 'due_soon') byStatus.due_soon.push(it);
      else if (it.status === 'no_data') byStatus.no_data.push(it);
      else byStatus.ok.push(it);
    }
    return {
      vehicle: { id: v.id, name: v.name, model: v.model, plate: v.plate },
      odometer: { ...odo, lastReading: this.store.odometer.last(v.id) },
      items,
      byStatus: {
        overdue: byStatus.overdue.map((i) => i.key),
        due_soon: byStatus.due_soon.map((i) => i.key),
        ok: byStatus.ok.map((i) => i.key),
        no_data: byStatus.no_data.map((i) => i.key),
      },
      note: 'Status ini dihitung dari catatan Anda. Ini bukan pengganti pemeriksaan mekanik oleh teknisi.',
    };
  }

  logService({ itemKey = null, ts = this.now(), odoKm = null, workshop = null, cost = null, parts = null, notes = null, evidence = null, source = 'manual' } = {}) {
    const v = this.vehicle();
    const odo = NUM(odoKm) ?? this._currentOdo().km;
    const record = this.store.services.add({ vehicleId: v.id, itemKey, ts, odoKm: odo, workshop, cost: NUM(cost), parts, notes, evidence: evidence || { source } });
    if (itemKey) {
      const item = this.store.items.get(v.id, itemKey);
      if (!item) throw new VehicleError(`Komponen "${itemKey}" tidak dikenal.`, 'not_found');
      this.store.items.update(v.id, itemKey, { last_service_at: ts, last_service_odo_km: odo });
      this.store.notices.claim({
        kind: 'service_logged',
        dedupKey: `svc:${v.id}:${itemKey}:${ts}`,
        text: `Servis ${item.name} tercatat pada ${localDate(ts)}.`,
      });
    }
    this._changed('service_logged', { itemKey });
    if (this.memory) {
      try { this.memory({ kind: 'service_record', itemKey, ts, odoKm: odo, workshop, at: this.now() }); } catch { /* optional */ }
    }
    return record;
  }

  /**
   * Updates a maintenance item. Any change to the intervals marks the item as
   * owner-provided (verified by the owner's own action of typing them in).
   */
  updateItem(key, patch = {}) {
    const v = this.vehicle();
    const item = this.store.items.get(v.id, key);
    if (!item) throw new VehicleError(`Komponen "${key}" tidak dikenal.`, 'not_found');
    const clean = {};
    if (patch.intervalKm !== undefined) {
      const n = NUM(patch.intervalKm);
      if (n != null && n < 0) throw new VehicleError('Interval km tidak valid.', 'bad_request');
      clean.interval_km = n;
    }
    if (patch.intervalMonths !== undefined) {
      const n = NUM(patch.intervalMonths);
      if (n != null && n < 0) throw new VehicleError('Interval bulan tidak valid.', 'bad_request');
      clean.interval_months = n;
    }
    if (patch.notes !== undefined) clean.notes = String(patch.notes || '');
    if (patch.active !== undefined) clean.active = Boolean(patch.active);
    if (Object.keys(clean).length) {
      clean.verified = patch.verified !== undefined ? Boolean(patch.verified) : false;
      clean.source = patch.source || 'pemilik';
    } else if (patch.verified !== undefined) {
      clean.verified = Boolean(patch.verified);
      if (clean.verified) clean.source = 'dikonfirmasi pemilik';
    }
    const updated = this.store.items.update(v.id, key, clean);
    this._changed('maintenance_item', { key });
    return updated;
  }

  /** The vehicle health report the spec asks for. */
  healthReport() {
    const st = this.status();
    const { overdue, due_soon, no_data } = st.byStatus;
    const items = st.items;
    const find = (k) => items.find((i) => i.key === k);
    const recommendations = [];
    for (const k of overdue) {
      const it = find(k);
      recommendations.push({
        priority: it.safetyCritical ? 'tinggi (keselamatan)' : 'normal',
        text: `${it.name}: jatuh tempo (${it.reason}).${it.intervalNote ? ` ${it.intervalNote}` : ''}`,
      });
    }
    for (const k of due_soon) {
      const it = find(k);
      recommendations.push({ priority: 'menengah', text: `${it.name}: mendekati jadwal (${it.reason}).` });
    }
    for (const k of no_data) {
      const it = find(k);
      recommendations.push({ priority: 'data', text: `${it.name}: belum ada riwayat servis/odometer — jadwal tidak dapat dihitung.` });
    }
    const safety = items.filter((i) => i.safetyCritical && ['overdue', 'due_soon'].includes(i.status));
    return {
      vehicle: st.vehicle,
      generatedAt: this.now(),
      odometer: st.odometer,
      due: overdue,
      upcoming: due_soon,
      ok: st.byStatus.ok,
      missingData: no_data,
      safetyWarnings: safety.map((i) => `${i.name} berkaitan langsung dengan keselamatan dan statusnya "${i.status}".`),
      recommendations,
      honesty: [
        'Sistem ini mengelola catatan dan pengingat; ia tidak memeriksa kondisi fisik motor.',
        'Komponen tidak pernah dinyatakan aman hanya karena jadwal digital belum jatuh tempo.',
        st.odometer.estimated ? `Odometer saat ini adalah PERKIRAAN (${st.odometer.source}).` : 'Odometer saat ini berasal dari pembacaan manual terakhir.',
      ],
    };
  }

  // -------------------------------------------------------------- reminders

  /** Called by the periodic tick: reminds once per threshold, never in a loop. */
  checkReminders() {
    const v = this.vehicle();
    const st = this.status();
    const out = [];
    const dayKey = localDate(this.now());
    const weekKey = `${dayKey.slice(0, 8)}W${Math.floor(Number(dayKey.slice(8)) / 7)}`;
    for (const it of st.items) {
      if (it.status === 'overdue') {
        const key = `maint:${v.id}:${it.key}:overdue:${weekKey}`;
        const raw = `${it.name} sudah jatuh tempo: ${it.reason}.${it.intervalNote ? ` ${it.intervalNote}` : ''}${it.safetyCritical ? ' Komponen ini berkaitan dengan keselamatan — prioritaskan pemeriksaan.' : ''}`;
        const text = formatVehicleNotice({ kind: 'maintenance_overdue', item: it, reason: it.reason, vehicle: v, note: it.intervalNote, raw });
        if (this.store.notices.claim({ kind: 'maintenance_overdue', dedupKey: key, text })) out.push({ kind: 'maintenance_overdue', text, key });
      } else if (it.status === 'due_soon') {
        const key = `maint:${v.id}:${it.key}:soon:${weekKey}`;
        const raw = `${it.name} mendekati jadwal: ${it.reason}.${it.intervalNote ? ` ${it.intervalNote}` : ''}`;
        const text = formatVehicleNotice({ kind: 'maintenance_soon', item: it, reason: it.reason, vehicle: v, note: it.intervalNote, raw });
        if (this.store.notices.claim({ kind: 'maintenance_soon', dedupKey: key, text })) out.push({ kind: 'maintenance_soon', text, key });
      }
    }
    // Odometer staleness (once every two weeks).
    const odo = this.odometerStatus();
    if (odo.needsUpdate) {
      const key = `odo:${v.id}:stale:${weekKey}`;
      const text = formatVehicleNotice({ kind: 'odometer_stale', vehicle: v, reason: odo.suggestion, raw: odo.suggestion });
      if (this.store.notices.claim({ kind: 'odometer_stale', dedupKey: key, text })) {
        out.push({ kind: 'odometer_stale', text, key });
      }
    }
    // Fuel warned repeatedly? The owner asked not to spam: maximum once per day per level.
    const fuel = this.fuelStatus();
    for (const w of fuel.warnings.filter((x) => x.level === 'warn')) {
      const key = `fuel:${v.id}:warn:${dayKey}`;
      const text = formatVehicleNotice({ kind: 'fuel_warning', vehicle: v, reason: w.text, raw: w.text });
      if (this.store.notices.claim({ kind: 'fuel_warning', dedupKey: key, text })) out.push({ kind: 'fuel_warning', text, key });
    }
    for (const notice of out) this._deliver(notice);
    return out;
  }

  _deliver(notice) {
    if (!this.deliver) { this.emit('notice', notice); return; }
    Promise.resolve()
      .then(() => this.deliver(notice))
      .then((r) => {
        const row = this.store.notices.list(1).find((n) => n.dedup_key === notice.key);
        if (row) this.store.notices.mark(row.id, { delivered: r?.ok !== false, error: r?.error || null });
      })
      .catch((e) => this.emit('notice_error', { ...notice, error: e?.message }))
      .finally(() => this.emit('notice', notice));
  }

  /** A compact line for the AI chat / Telegram quick answers. */
  summaryLine() {
    const st = this.status();
    const fuel = this.fuelStatus();
    const parts = [];
    parts.push(`${st.vehicle.name}: odometer ${st.odometer.km != null ? `${Math.round(st.odometer.km)} km` : 'belum dicatat'}${st.odometer.estimated ? ' (perkiraan)' : ''}`);
    parts.push(`konsumsi acuan ${fuel.vehicle.baselineKmpl} km/L${fuel.actualConsumption.kmpl ? `, aktual ${fuel.actualConsumption.kmpl} km/L dari ${fuel.actualConsumption.samples} pengisian penuh` : ''}`);
    if (st.byStatus.overdue.length) parts.push(`jatuh tempo: ${st.byStatus.overdue.join(', ')}`);
    if (st.byStatus.due_soon.length) parts.push(`mendekati jadwal: ${st.byStatus.due_soon.join(', ')}`);
    return parts.join('; ');
  }

  start() {
    if (this._timer) return false;
    this._timer = setInterval(() => {
      if (this._ticking) return;
      this._ticking = true;
      try { this.checkReminders(); } catch { /* reminders must never crash the loop */ } finally { this._ticking = false; }
    }, 15 * 60_000);
    if (this._timer.unref) this._timer.unref();
    return true;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}
