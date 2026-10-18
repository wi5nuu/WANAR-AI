/**
 * src/vehicle/quick.js
 *
 * Deterministic answers for motorcycle questions in chat — fuel, odometer and
 * maintenance, straight from the records, with the model-vs-sensor distinction
 * kept visible in every answer that involves an estimate.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { UNVERIFIED_NOTE } from './intervals.js';

const FUEL_ASK = /\b(bensin|bbm|bahan bakar|pertamax|pertalite|pertamina)\b/i;
const FUEL_LEFT = /\b(masih|sisa|tersisa|berapa)\b/i;
const CONSUMPTION_ASK = /\b(km\/l|km per liter|konsumsi|boros|irit)\b/i;
const ODO_ASK = /\b(odometer|kilometer motor|km motor|speedometer)\b/i;
const SERVICE_ASK = /\b(servis|service|ganti oli|oli|kanvas|kampas|ban|rantai|tune up|tune-up|perawatan)\b/i;
const TRIP_COST = /\b(kalau|perjalanan|trip|pp|pergi|ke)\b.{0,30}\b(\d+(?:[.,]\d+)?)\s*km\b/i;

const fmtRp = (n) => (n == null ? '—' : `Rp${Math.round(n).toLocaleString('id-ID')}`);

/**
 * @param {object} vehicle  the vehicle service
 * @param {string} text
 * @returns {string|null}
 */
export function quickVehicle(vehicle, text) {
  if (!vehicle) return null;
  const t = String(text || '').trim();
  if (!t || t.length > 240) return null;

  // "kalau perjalanan 30 km, butuh berapa liter?"
  const trip = TRIP_COST.exec(t);
  if (trip && (FUEL_ASK.test(t) || /\b(berapa|butuh|habis)\b/i.test(t)) && !/\b(isi|catat|log)\b/i.test(t)) {
    const km = Number(String(trip[2]).replace(',', '.'));
    if (Number.isFinite(km) && km > 0 && km < 2000) {
      const e = vehicle.estimateTrip(km);
      return `Estimasi ${km} km: sekitar ${e.liters} liter${e.cost != null ? ` (${fmtRp(e.cost)} dengan harga ${fmtRp(e.pricePerLiter)}/L)` : ''}. Dihitung dari konsumsi acuan ${e.kmpl} km/L — ini perkiraan model, bukan pembacaan sensor.`;
    }
  }

  if (FUEL_ASK.test(t) && (FUEL_LEFT.test(t) || CONSUMPTION_ASK.test(t))) {
    const st = vehicle.fuelStatus();
    const lines = [];
    if (CONSUMPTION_ASK.test(t)) {
      lines.push(`Konsumsi acuan: ${st.vehicle.baselineKmpl} km/L (angka Anda, tidak diubah diam-diam).`);
      if (st.actualConsumption.kmpl) {
        lines.push(`Konsumsi aktual dari ${st.actualConsumption.samples} pengisian penuh-ke-penuh: ${st.actualConsumption.kmpl} km/L.`);
      } else {
        lines.push('Belum ada angka konsumsi aktual — butuh minimal satu pengisian penuh ke penuh dengan odometer.');
      }
    }
    if (FUEL_LEFT.test(t)) {
      if (st.estimate.remainingL == null) {
        lines.push(st.vehicle.tankLiters == null
          ? 'Perkiraan sisa bahan bakar belum bisa dihitung: kapasitas tangki belum diisi di halaman Kendaraan.'
          : `Perkiraan sisa belum bisa dihitung: ${st.estimate.method}.`);
      } else {
        lines.push(`Perkiraan sisa: ±${st.estimate.remainingL} liter ±${st.estimate.remainingKm} km, dihitung dari ${st.sinceFull.km} km sejak pengisian penuh (${st.sinceFull.kmSource}).`);
        lines.push('Ini estimasi model, bukan sensor bensin — motor ini tidak punya sensor yang terhubung.');
      }
    }
    if (st.lastFill) lines.push(`Pengisian terakhir: ${new Date(st.lastFill.ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} sebanyak ${st.lastFill.liters} L.`);
    return lines.join(' ');
  }

  if (ODO_ASK.test(t) && !/\b(catat|isi|update)\b/i.test(t)) {
    const o = vehicle.odometerStatus();
    if (!o.lastReading) return 'Belum ada catatan odometer. Catat angka pada panel motor sekali supaya jadwal servis berbasis km bisa dihitung.';
    const when = new Date(o.lastReading.ts).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short' });
    return `Odometer terakhir: ${o.lastReading.odo_km} km (dicatat ${when}, ${o.ageDays} hari lalu). ${o.needsUpdate ? o.suggestion : 'Catatan masih cukup baru.'} Jarak GPS sejak itu: ${o.gpsDistanceSinceKm ?? '—'} km (perkiraan, bukan odometer).`;
  }

  if (SERVICE_ASK.test(t) && !/\b(catat|sudah|baru)\b.{0,15}\b(servis|ganti|oli)\b/i.test(t)) {
    const st = vehicle.status();
    const overdue = st.items.filter((i) => i.status === 'overdue' || i.status === 'due');
    const soon = st.items.filter((i) => i.status === 'due_soon');
    const lines = [];
    if (overdue.length) {
      lines.push(...overdue.slice(0, 5).map((i) => `⚠ ${i.name}: jatuh tempo (${i.reason}).${i.safetyCritical ? ' Berhubungan dengan keselamatan.' : ''}`));
    }
    if (soon.length) lines.push(...soon.slice(0, 5).map((i) => `• ${i.name}: mendekati jadwal (${i.reason}).`));
    if (!overdue.length && !soon.length) lines.push('Tidak ada komponen yang jatuh tempo menurut catatan.');
    const unverified = st.items.filter((i) => !i.verified).length;
    if (unverified) lines.push(`${unverified} interval masih berstatus usulan (belum diverifikasi dari manual resmi) — periksa dan simpan angka yang benar di halaman Kendaraan.`);
    lines.push('Catatan digital ini pengingat, bukan pemeriksaan fisik.');
    return lines.join('\n');
  }

  return null;
}

export { UNVERIFIED_NOTE };
