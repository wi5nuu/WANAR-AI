/**
 * src/vehicle/telegram.js
 *
 * Owner-only Telegram commands for motorcycle care (Honda Vario 160 CBS).
 * Registered on TelegramInbox, restricted to TELEGRAM_AI_CHAT_IDS.
 *
 *   /motor              laporan status lengkap kendaraan, jadwal, & BBM
 *   /servis             status pemeliharaan komponen & riwayat AHASS
 *   /odometer <km>      catat / periksa pembacaan odometer
 *   /bensin <L> [km]    catat / periksa pengisian bahan bakar
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { formatDateId, formatRupiah } from '../worklog/time.js';

const expose = (message) => Object.assign(new Error(message), { expose: true });

function formatStatusEmoji(status) {
  switch (status) {
    case 'overdue': return '⚠️';
    case 'due_soon': return '⏳';
    case 'ok': return '✅';
    case 'no_data': return 'ℹ️';
    default: return '•';
  }
}

export function vehicleTelegramCommands(vehicleService) {
  const guard = (fn) => async (ctx) => {
    try {
      return await fn(ctx);
    } catch (e) {
      throw expose(e.message || 'Gagal memproses perintah motor');
    }
  };

  return {
    motor: {
      description: 'status lengkap motor (Honda Vario 160 CBS, B 4780 UDM)',
      run: guard(async () => {
        const v = vehicleService.vehicle();
        const st = vehicleService.status();
        const fuel = vehicleService.fuelStatus();
        const lastSvc = vehicleService.store.services.recent(v.id, 1)[0];
        const plate = v.plate ? ` (${v.plate})` : '';

        const lines = [
          `🛵 <b>STATUS KENDARAAN — ${(v.name || 'Honda Vario 160').toUpperCase()}${plate}</b>`,
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        ];

        // Odometer & BBM
        const odoText = st.odometer.km != null
          ? `${Math.round(st.odometer.km).toLocaleString('id-ID')} km${st.odometer.estimated ? ' (estimasi)' : ''}`
          : 'belum dicatat';
        lines.push(`📍 <b>Odometer:</b> ${odoText}`);

        if (fuel.estimate.remainingL != null) {
          lines.push(`⛽ <b>Bahan Bakar:</b> ±${fuel.estimate.remainingL} L (±${fuel.estimate.remainingKm} km jangkauan) · ${v.fuel_type || 'Pertamax'}`);
        } else {
          lines.push(`⛽ <b>Bahan Bakar:</b> ${v.fuel_type || 'Pertamax'} (acuan ${v.baseline_kmpl || 50} km/L)`);
        }

        // Servis Terakhir
        if (lastSvc) {
          const svcDate = new Date(lastSvc.ts).toLocaleDateString('id-ID', {
            timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric',
          });
          lines.push('');
          lines.push(`🔧 <b>Servis Terakhir:</b> ${svcDate}`);
          if (lastSvc.workshop) lines.push(`   Bengkel: ${lastSvc.workshop}`);
          if (lastSvc.cost) lines.push(`   Biaya: ${formatRupiah(lastSvc.cost)}`);
          if (lastSvc.notes) lines.push(`   Pekerjaan: ${lastSvc.notes}`);
          if (lastSvc.evidence?.invoiceNo) {
            lines.push(`   Invoice: <code>${lastSvc.evidence.invoiceNo}</code>${lastSvc.evidence.refNo ? ` (WO: ${lastSvc.evidence.refNo})` : ''}`);
          }
        }

        // Jadwal Servis Berkala (AHASS)
        const berkala = st.items.find((i) => i.key === 'servis_berkala');
        if (berkala) {
          lines.push('');
          lines.push(`📅 <b>Jadwal Servis Berkala:</b>`);
          const daysLeft = berkala.daysRemaining;
          if (daysLeft != null) {
            if (daysLeft < 0) {
              lines.push(`   ⚠️ Terlewat ${Math.abs(daysLeft)} hari dari interval ${berkala.intervalMonths} bulan`);
            } else {
              lines.push(`   ⏳ Sisa ${daysLeft} hari lagi (interval ${berkala.intervalMonths} bulan / ${berkala.intervalKm || 2000} km)`);
            }
          }
          if (berkala.lastServiceAt) {
            const nextMs = berkala.lastServiceAt + (berkala.intervalMonths || 2) * 30.44 * 86_400_000;
            const nextDate = new Date(nextMs).toLocaleDateString('id-ID', {
              timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric',
            });
            lines.push(`   Batas Maksimal: <b>${nextDate}</b> atau +${berkala.intervalKm || 2000} km`);
          }
        }

        // Komponen Kritis (Rem, Ban, CVT)
        const critical = st.items.filter((i) => i.safetyCritical || i.key === 'oli_mesin');
        if (critical.length) {
          lines.push('');
          lines.push('🛡️ <b>Status Komponen Utama:</b>');
          for (const c of critical) {
            const icon = formatStatusEmoji(c.status);
            lines.push(`   ${icon} <b>${c.name}:</b> ${c.reason || 'terpantau'}`);
          }
        }

        lines.push('');
        lines.push('Perintah: /servis · /odometer &lt;angka&gt; · /bensin &lt;liter&gt;');
        return lines.join('\n');
      }),
    },

    servis: {
      description: 'jadwal pemeliharaan dan riwayat servis berkala',
      run: guard(async () => {
        const v = vehicleService.vehicle();
        const st = vehicleService.status();
        const plate = v.plate ? ` (${v.plate})` : '';

        const lines = [
          `🔧 <b>JADWAL PERAWATAN MOTOR — ${(v.name || 'Honda Vario 160').toUpperCase()}${plate}</b>`,
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        ];

        const overdue = st.items.filter((i) => i.status === 'overdue' || i.status === 'due');
        const soon = st.items.filter((i) => i.status === 'due_soon');
        const ok = st.items.filter((i) => i.status === 'ok');

        if (overdue.length) {
          lines.push('⚠️ <b>JATUH TEMPO:</b>');
          for (const it of overdue) {
            lines.push(`• <b>${it.name}:</b> ${it.reason}${it.safetyCritical ? ' <i>(Kritis Keselamatan)</i>' : ''}`);
          }
          lines.push('');
        }

        if (soon.length) {
          lines.push('⏳ <b>MENDEKATI JADWAL:</b>');
          for (const it of soon) {
            lines.push(`• <b>${it.name}:</b> ${it.reason}`);
          }
          lines.push('');
        }

        lines.push('✅ <b>KOMPONEN TERPANTAU:</b>');
        for (const it of ok.slice(0, 6)) {
          lines.push(`• ${it.name}: ${it.reason}`);
        }

        const records = vehicleService.store.services.recent(v.id, 3);
        if (records.length) {
          lines.push('');
          lines.push('📋 <b>Riwayat Servis Bengkel:</b>');
          for (const r of records) {
            const d = new Date(r.ts).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric' });
            lines.push(`- ${d}: ${r.workshop || 'Bengkel'} (${r.cost ? formatRupiah(r.cost) : '-'})`);
            if (r.notes) lines.push(`  <i>${r.notes}</i>`);
          }
        }

        return lines.join('\n');
      }),
    },

    odometer: {
      description: 'catat / periksa odometer motor: /odometer 12500',
      run: guard(async ({ arg }) => {
        const num = String(arg || '').replace(/[^0-9.]/g, '').trim();
        if (!num) {
          const status = vehicleService.odometerStatus();
          const last = status.lastReading;
          if (!last) return 'Belum ada catatan odometer. Catat pembacaan saat ini dengan perintah:\n/odometer <angka>';
          const date = new Date(last.ts).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short' });
          return `Odometer terakhir: ${last.odo_km.toLocaleString('id-ID')} km (dicatat ${date}, ${status.ageDays} hari lalu).\n\nPerbarui dengan: /odometer <angka>`;
        }

        const km = Number(num);
        if (!Number.isFinite(km) || km <= 0) return 'Format angka odometer tidak valid. Contoh: /odometer 12500';

        const result = vehicleService.addReading({ odoKm: km, source: 'telegram' });
        const delta = result.delta != null ? ` (+${result.delta} km)` : '';
        return `✅ Odometer berhasil diperbarui: <b>${km.toLocaleString('id-ID')} km</b>${delta}.\nJadwal servis berkala telah diperbarui.`;
      }),
    },

    bensin: {
      description: 'catat / periksa pengisian BBM: /bensin 4.5 atau /bensin 4.5 12500',
      run: guard(async ({ arg }) => {
        const text = String(arg || '').trim();
        if (!text) {
          const fuel = vehicleService.fuelStatus();
          const lines = [`⛽ <b>Status Bahan Bakar:</b> ${fuel.vehicle.fuelType || 'Pertamax'}`];
          if (fuel.estimate.remainingL != null) {
            lines.push(`Perkiraan Sisa: ±${fuel.estimate.remainingL} L (jangkauan ±${fuel.estimate.remainingKm} km).`);
          }
          if (fuel.lastFill) {
            const d = new Date(fuel.lastFill.ts).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short' });
            lines.push(`Pengisian Terakhir: ${d} (${fuel.lastFill.liters} L${fuel.lastFill.odo_km ? ` pada ${fuel.lastFill.odo_km} km` : ''}).`);
          }
          lines.push('\nCatat pengisian baru: /bensin <liter> [odometer]');
          return lines.join('\n');
        }

        const parts = text.split(/\s+/);
        const liters = parseFloat(parts[0]?.replace(',', '.'));
        const odo = parts[1] ? parseFloat(parts[1].replace(/[^0-9.]/g, '')) : null;

        if (!Number.isFinite(liters) || liters <= 0) {
          return 'Format jumlah liter tidak valid. Contoh: /bensin 4.5 atau /bensin 4.5 12500';
        }

        const fill = vehicleService.addFill({
          liters,
          odoKm: odo,
          fullTank: true,
          source: 'telegram',
        });

        const odoBit = fill.odo_km ? ` pada odometer ${fill.odo_km.toLocaleString('id-ID')} km` : '';
        const kmplBit = fill.consumption_kmpl ? ` (konsumsi aktual: ${fill.consumption_kmpl} km/L)` : '';
        return `✅ Pengisian BBM tercatat: <b>${liters} Liter</b>${odoBit}${kmplBit}.`;
      }),
    },
  };
}
