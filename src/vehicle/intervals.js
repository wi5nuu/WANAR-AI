/**
 * src/vehicle/intervals.js
 *
 * The maintenance catalogue for the owner's motorcycle (Honda Vario 160 CBS,
 * Pertamax). **Read this before trusting any number here.**
 *
 * The owner's instruction was explicit: do not invent service intervals. While
 * implementing this, the Honda owner's-manual page for the Vario 160 could not
 * be fetched from this machine (no reachable official source), so no interval in
 * this file is labelled as verified. Every item ships as `verified: false`
 * together with the values commonly quoted by Indonesian Honda dealers as a
 * STARTING SUGGESTION. The system:
 *
 *   - never presents an unverified interval as official,
 *   - says so inside every reminder it sends,
 *   - switches to normal wording only after the owner confirms the numbers
 *     against his own owner's manual (Pelacakan → Kendaraan → Konfirmasi).
 *
 * The formula "km interval OR months interval, whichever comes first" follows
 * the standard periodic-maintenance convention and is applied only once the
 * owner has entered (or confirmed) both numbers for an item.
 *
 * @author Wisnu Alfian Nur Ashar
 */

/** Reasons shown wherever an unverified interval is used. */
export const UNVERIFIED_NOTE =
  'Interval ini usulan awal, belum diverifikasi dari buku pedoman pemilik Honda Vario 160. Konfirmasi angkanya di halaman Kendaraan agar pengingat memakai jadwal resmi.';

/**
 * `suggestedKm` / `suggestedMonths` are starting points, not facts.
 * `appliesIf` documents a condition the owner must check on his own bike.
 */
export const DEFAULT_MAINTENANCE = [
  { key: 'oli_mesin', name: 'Oli mesin', intervalKm: 4000, intervalMonths: 3, safetyCritical: false, unitNote: 'termasuk filter oli pada penggantian berkala', appliesIf: null },
  { key: 'oli_gardan', name: 'Oli gardan (final gear)', intervalKm: 8000, intervalMonths: 8, safetyCritical: false, unitNote: 'volume dan spesifikasi oli mengikuti buku manual', appliesIf: null },
  { key: 'cvt', name: 'CVT (roller, v-belt, grease)', intervalKm: 8000, intervalMonths: 12, safetyCritical: true, unitNote: 'pemeriksaan tiap interval; penggantian bagian mengikuti hasil pemeriksaan', appliesIf: null },
  { key: 'filter_udara', name: 'Filter udara', intervalKm: 12000, intervalMonths: 12, safetyCritical: false, unitNote: 'pembersihan tiap interval, penggantian bila kotor/rusak', appliesIf: null },
  { key: 'busi', name: 'Busi', intervalKm: 18000, intervalMonths: 12, safetyCritical: false, unitNote: 'sesuaikan tipe busi dengan rekomendasi buku manual', appliesIf: null },
  { key: 'rem', name: 'Sistem rem & kampas', intervalKm: 8000, intervalMonths: 6, safetyCritical: true, unitNote: 'pemeriksaan kampas, kaliper, dan fungsi rem', appliesIf: null },
  { key: 'minyak_rem', name: 'Minyak rem', intervalKm: null, intervalMonths: 24, safetyCritical: true, unitNote: 'penggantian berkala', appliesIf: null },
  { key: 'ban', name: 'Ban & tekanan angin', intervalKm: 4000, intervalMonths: 1, safetyCritical: true, unitNote: 'periksa tekanan dan keausan tapak; ban adalah komponen keselamatan', appliesIf: null },
  { key: 'aki', name: 'Aki', intervalKm: null, intervalMonths: 24, safetyCritical: false, unitNote: 'pemeriksaan tegangan & terminal; penggantian sesuai kondisi', appliesIf: null },
  { key: 'coolant', name: 'Coolant & sistem pendingin', intervalKm: 24000, intervalMonths: 24, safetyCritical: false, unitNote: 'periksa level dan kondisi cairan pendingin', appliesIf: 'Hanya berlaku bila motor Anda berpendingin cair — periksa buku manual/unit Anda.' },
  { key: 'kelistrikan', name: 'Lampu & kelistrikan', intervalKm: 12000, intervalMonths: 12, safetyCritical: false, unitNote: 'lampu utama, sein, klakson, dan soket', appliesIf: null },
  { key: 'servis_berkala', name: 'Servis berkala bengkel (AHASS)', intervalKm: 4000, intervalMonths: 3, safetyCritical: false, unitNote: 'pemeriksaan menyeluruh sesuai buku servis', appliesIf: null },
];

/** Builds the per-vehicle item rows. Intervals stay unverified until the owner confirms. */
export function seedItems(vehicleId, defaults = DEFAULT_MAINTENANCE) {
  return defaults.map((d) => ({
    vehicleId,
    key: d.key,
    name: d.name,
    intervalKm: d.intervalKm,
    intervalMonths: d.intervalMonths,
    suggestedKm: d.intervalKm,
    suggestedMonths: d.intervalMonths,
    verified: false,
    source: 'usulan-awal',
    safetyCritical: Boolean(d.safetyCritical),
    notes: [d.unitNote, d.appliesIf].filter(Boolean).join(' · '),
    active: true,
  }));
}

/**
 * Due calculation: whichever of the two triggers is reached first, exactly as
 * periodic maintenance works. With only one interval configured, only that one
 * is used. Missing service history = "no data", never "safe".
 *
 * @param {object} item    { interval_km, interval_months, last_service_at, last_service_odo_km, verified }
 * @param {object} now     { odoKm, odoEstimated, nowMs }
 * @returns {{status:'ok'|'due_soon'|'due'|'overdue'|'no_data', kmRemaining:number|null, daysRemaining:number|null, trigger:'km'|'months'|null, reason:string}}
 */
export function dueStatus(item, { odoKm = null, odoEstimated = false, nowMs = Date.now() } = {}) {
  const hasKm = Number.isFinite(item.interval_km) && item.interval_km > 0;
  const hasMonths = Number.isFinite(item.interval_months) && item.interval_months > 0;
  if (!hasKm && !hasMonths) {
    return { status: 'no_data', kmRemaining: null, daysRemaining: null, trigger: null, reason: 'interval belum diisi' };
  }
  const lastAt = Number.isFinite(item.last_service_at) ? item.last_service_at : null;
  const lastOdo = Number.isFinite(item.last_service_odo_km) ? item.last_service_odo_km : null;
  if (!lastAt && !lastOdo) {
    return { status: 'no_data', kmRemaining: null, daysRemaining: null, trigger: null, reason: 'belum ada riwayat servis untuk komponen ini' };
  }

  let kmRemaining = null;
  let monthsElapsed = null;
  if (hasKm) {
    const base = lastOdo ?? null;
    if (base != null && Number.isFinite(odoKm)) kmRemaining = item.interval_km - (odoKm - base);
    else if (base == null) kmRemaining = null;                  // no odometer anchor at all
  }
  if (hasMonths && lastAt) {
    const months = (nowMs - lastAt) / (30.44 * 86_400_000);
    monthsElapsed = months;
  }

  const daysRemaining = hasMonths && lastAt ? Math.round(item.interval_months * 30.44 - (nowMs - lastAt) / 86_400_000) : null;
  const kmTrigger = kmRemaining != null && kmRemaining <= 0;
  const timeTrigger = daysRemaining != null && daysRemaining <= 0;
  if (kmTrigger || timeTrigger) {
    return {
      status: 'overdue',
      kmRemaining,
      daysRemaining,
      trigger: kmTrigger ? 'km' : 'months',
      reason: kmTrigger
        ? `sudah melewati interval ${item.interval_km} km sejak servis terakhir`
        : `sudah melewati interval ${item.interval_months} bulan sejak servis terakhir`,
    };
  }
  const soonKm = hasKm && kmRemaining != null && kmRemaining <= Math.max(500, item.interval_km * 0.2);
  const soonDays = daysRemaining != null && daysRemaining <= Math.max(14, item.interval_months * 30.44 * 0.15);
  if (soonKm || soonDays) {
    return {
      status: 'due_soon',
      kmRemaining,
      daysRemaining,
      trigger: soonKm ? 'km' : 'months',
      reason: soonKm
        ? `sisa sekitar ${Math.max(0, Math.round(kmRemaining))} km lagi menuju interval ${item.interval_km} km`
        : `sekitar ${Math.max(0, daysRemaining)} hari lagi menuju interval ${item.interval_months} bulan`,
    };
  }
  return {
    status: 'ok',
    kmRemaining,
    daysRemaining,
    trigger: null,
    reason: [
      kmRemaining != null ? `sisa ${Math.round(kmRemaining)} km` : null,
      daysRemaining != null ? `sisa ${daysRemaining} hari` : null,
    ].filter(Boolean).join(', ') || 'terpantau',
    odoEstimated,
    monthsElapsed: monthsElapsed != null ? Number(monthsElapsed.toFixed(1)) : null,
  };
}

/** Fuel maths — pure and unit-tested. */
export function consumptionFromFill({ kmSincePrev, liters, fullTank, prevFullTank }) {
  if (!fullTank || !prevFullTank) {
    return { kmpl: null, reason: 'pengisian sebagian atau pengisian sebelumnya tidak penuh — konsumsi aktual belum dapat dipastikan' };
  }
  const km = Number(kmSincePrev);
  const l = Number(liters);
  if (!(km > 0) || !(l > 0)) return { kmpl: null, reason: 'jarak atau jumlah liter tidak valid' };
  return { kmpl: Number((km / l).toFixed(2)), reason: 'pengisian penuh ke penuh' };
}

export function estimateFuel({ km, kmpl }) {
  const k = Math.max(0, Number(km) || 0);
  const base = Number(kmpl) > 0 ? Number(kmpl) : null;
  if (!base) return { liters: null, reason: 'konsumsi acuan belum diisi' };
  return { liters: Number((k / base).toFixed(3)), reason: 'estimasi dari jarak lintasan GPS dibagi konsumsi acuan' };
}
