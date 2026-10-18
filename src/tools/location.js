/**
 * src/tools/location.js
 *
 * Agent tools for tracking, motorcycle care and personal memory, so the chat can
 * answer "posisi saya di mana?", "kapan servis berikutnya?", "catat isi bensin
 * 3,4 liter" — and remember things the owner asks.
 *
 * Safety line: there is deliberately NO emergency tool here. The AI must never
 * be able to trigger, escalate or cancel an emergency — that path belongs to the
 * deterministic detector and to the owner's own buttons (see src/emergency/*).
 *
 * All of these read from or append to the operator's own records (no network,
 * no messages to third parties), so they are not action-gated, like worklog.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { getLocation } from '../location/index.js';
import { getVehicle } from '../vehicle/index.js';
import { getMemory } from '../memory/index.js';
import { formatDistance } from '../location/geo.js';
import { KIND_LABELS } from '../location/classify.js';
import { formatMinutes } from '../worklog/time.js';

const OFFLINE = { error: 'Modul lokasi/kendaraan belum aktif. Jalankan server web (npm run web).' };

export const locationTools = [
  {
    type: 'function',
    function: {
      name: 'location_status',
      description:
        'Posisi terkini atau terakhir yang diketahui dari pelacakan: koordinat, akurasi, umur data (live atau lokasi terakhir), tempat yang dikenal, ' +
        'status bergerak/diam, dan ringkasan jarak hari ini (lintasan GPS). Jujur soal kesegaran data.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'location_history',
      description: 'Riwayat perjalanan dan tempat berhenti: ringkasan satu hari (default hari ini) atau rentang tanggal, termasuk perjalanan, kunjungan, dan jarak lintasan GPS.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD (opsional, default hari ini)' },
          from: { type: 'string', description: 'YYYY-MM-DD awal rentang (opsional)' },
          to: { type: 'string', description: 'YYYY-MM-DD akhir rentang (opsional)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'location_name_place',
      description: 'Memberi nama tempat berhenti terakhir ("tempat tadi namanya warung Bu Yati") dan membuat geofence agar kunjungan berikutnya dikenali. Gunakan hanya bila pengguna memintanya.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nama tempat' },
          kind: { type: 'string', description: 'Kategori opsional: home, office, food, minimarket, fuel, workshop, dll.' },
          radiusM: { type: 'number', description: 'Radius geofence dalam meter (default 120)' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vehicle_status',
      description: 'Status motor: odometer terakhir (atau perkiraan GPS bila belum ada pembacaan), perkiraan sisa bahan bakar (model, bukan sensor), konsumsi acuan vs aktual, dan jadwal servis jatuh tempo.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fuel_log',
      description: 'Mencatat pengisian bahan bakar. Contoh: 3,4 liter full tank di odometer 12.450 km. Gunakan hanya bila pengguna memintanya.',
      parameters: {
        type: 'object',
        properties: {
          liters: { type: 'number', description: 'Jumlah liter' },
          odoKm: { type: 'number', description: 'Angka odometer saat mengisi (opsional)' },
          fullTank: { type: 'boolean', description: 'true bila diisi sampai penuh' },
          pricePerLiter: { type: 'number', description: 'Harga per liter (opsional)' },
          station: { type: 'string', description: 'Nama SPBU (opsional)' },
          note: { type: 'string', description: 'Catatan (opsional)' },
        },
        required: ['liters'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'odometer_read',
      description: 'Mencatat pembacaan odometer dari panel motor. Gunakan hanya bila pengguna memintanya.',
      parameters: {
        type: 'object',
        properties: {
          odoKm: { type: 'number', description: 'Angka odometer pada panel' },
          allowRegression: { type: 'boolean', description: 'true hanya bila panel diganti sehingga angka bisa lebih kecil' },
          note: { type: 'string', description: 'Catatan (opsional)' },
        },
        required: ['odoKm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'maintenance_status',
      description: 'Jadwal servis motor: komponen jatuh tempo, mendekati jadwal, dan yang belum punya data. Menyebutkan mana interval yang masih usulan (belum diverifikasi dari manual resmi).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'maintenance_log',
      description: 'Mencatat servis yang sudah dilakukan (mis. ganti oli di 12.500 km). Gunakan hanya bila pengguna memintanya.',
      parameters: {
        type: 'object',
        properties: {
          itemKey: { type: 'string', description: 'Kunci komponen (mis. oli-mesin, ban-depan). Lihat maintenance_status.' },
          odoKm: { type: 'number', description: 'Odometer saat servis (opsional)' },
          workshop: { type: 'string', description: 'Nama bengkel (opsional)' },
          cost: { type: 'number', description: 'Biaya (opsional)' },
          notes: { type: 'string', description: 'Catatan (opsional)' },
        },
        required: ['itemKey'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_remember',
      description: 'Menyimpan hal ke memori pribadi pengguna (kesukaan, rutinitas, orang, tempat, catatan) atas permintaannya. Contoh: "ingat ya, kopi saya tanpa gula".',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['preference', 'fact', 'place', 'person', 'routine', 'note'] },
          key: { type: 'string', description: 'Kata kunci singkat (mis. "kopi")' },
          value: { type: 'string', description: 'Isi memori' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tag (opsional)' },
        },
        required: ['kind', 'key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description: 'Mencari di memori pribadi pengguna (tempat yang dia beri nama, kesukaan, rutinitas, catatan).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
];

export async function executeLocationTool(name, args = {}) {
  const loc = getLocation();
  const veh = getVehicle();
  const mem = getMemory();
  try {
    switch (name) {
      case 'location_status': {
        if (!loc) return OFFLINE;
        const st = loc.service.currentStatus();
        if (!st.position) {
          return { tracking: st.tracking, position: null, note: 'Belum ada data lokasi. Pelacakan mati atau HP belum mengirim titik.' };
        }
        return {
          tracking: st.tracking,
          position: {
            lat: st.position.lat, lon: st.position.lon, accuracyM: st.position.accuracy,
            fresh: st.position.fresh, ageMinutes: Math.round(st.position.ageMs / 60000),
            label: st.position.label, battery: st.position.battery,
          },
          place: st.place ? { name: st.place.label, kind: st.place.kind } : null,
          movement: st.movement.state,
          today: { distance: formatDistance(st.today.distanceM), trips: st.today.trips, stops: st.today.stops },
          honesty: 'Jarak adalah lintasan GPS, bukan odometer. "Lokasi terakhir" bukan posisi live bila data sudah lama.',
        };
      }
      case 'location_history': {
        if (!loc) return OFFLINE;
        if (args.from || args.to) {
          const r = loc.service.rangeSummary(args.from || args.to, args.to || args.from);
          return { ...r, note: 'Jarak lintasan GPS (bukan odometer).' };
        }
        const d = loc.service.daySummary(args.date || loc.service.today());
        return {
          date: d.date,
          distance: formatDistance(d.distanceM),
          moving: formatMinutes(Math.round(d.movingS / 60)),
          trips: d.trips.map((t) => ({ from: t.start_label || 'titik awal', at: t.started_at, distance: formatDistance(t.distance_m), endedAt: t.ended_at })),
          stops: d.stops.map((s) => ({
            at: s.started_at, label: s.corrected_label || s.label || KIND_LABELS[s.corrected_kind || s.kind] || 'belum teridentifikasi',
            durationMin: Math.round(((s.ended_at || Date.now()) - s.started_at) / 60000),
            confidence: s.confidence,
          })),
          dataQuality: d.dataQuality,
        };
      }
      case 'location_name_place': {
        if (!loc) return OFFLINE;
        const w = loc.service.whereWasI();
        const lastStop = w.stops[w.stops.length - 1];
        if (!lastStop) return { error: 'Belum ada tempat berhenti yang bisa diberi nama.' };
        const updated = loc.service.correctStop(lastStop.id, {
          label: String(args.name || '').slice(0, 120),
          kind: args.kind || null,
          savePlace: true,
          radiusM: Number(args.radiusM) || 120,
          note: 'diberi nama lewat asisten',
        });
        return { success: true, stop: { id: updated.id, label: updated.corrected_label, kind: updated.corrected_kind } };
      }
      case 'vehicle_status': {
        if (!veh) return OFFLINE;
        const st = veh.service.status();
        const fuel = veh.service.fuelStatus();
        return {
          vehicle: st.vehicle,
          odometer: { km: st.odometer.km, estimated: st.odometer.estimated, source: st.odometer.source },
          fuel: {
            baselineKmpl: fuel.vehicle.baselineKmpl,
            actualKmpl: fuel.actualConsumption.kmpl,
            sinceFullKm: fuel.sinceFull.km,
            sinceFullSource: fuel.sinceFull.kmSource,
            remainingL: fuel.estimate.remainingL,
            remainingKm: fuel.estimate.remainingKm,
            label: fuel.estimate.labels.remaining,
            sensor: fuel.estimate.labels.sensor,
          },
          maintenance: {
            overdue: st.byStatus.overdue, due_soon: st.byStatus.due_soon, no_data: st.byStatus.no_data,
            items: st.items.map((i) => ({ key: i.key, name: i.name, status: i.status, reason: i.reason, verified: i.verified })),
          },
          honesty: st.note,
        };
      }
      case 'fuel_log': {
        if (!veh) return OFFLINE;
        const fill = veh.service.addFill({
          liters: args.liters,
          odoKm: args.odoKm ?? null,
          fullTank: args.fullTank === true,
          pricePerLiter: args.pricePerLiter ?? null,
          station: args.station || null,
          note: args.note || 'dicatat lewat asisten',
        });
        return { success: true, fill: { id: fill.id, liters: fill.liters, odoKm: fill.odo_km, fullTank: Boolean(fill.full_tank) }, estimate: veh.service.fuelStatus().estimate };
      }
      case 'odometer_read': {
        if (!veh) return OFFLINE;
        const out = veh.service.addReading({ odoKm: args.odoKm, allowRegression: args.allowRegression === true, note: args.note || 'dicatat lewat asisten' });
        return { success: true, odometerKm: out.reading.odo_km, delta: out.delta, gpsSincePrevious: out.gpsSincePrevious?.km ?? null };
      }
      case 'maintenance_status': {
        if (!veh) return OFFLINE;
        const st = veh.service.status();
        return {
          odometer: { km: st.odometer.km, estimated: st.odometer.estimated },
          overdue: st.items.filter((i) => i.status === 'overdue' || i.status === 'due').map((i) => ({ key: i.key, name: i.name, reason: i.reason, verified: i.verified })),
          dueSoon: st.items.filter((i) => i.status === 'due_soon').map((i) => ({ key: i.key, name: i.name, reason: i.reason })),
          noData: st.items.filter((i) => i.status === 'no_data').map((i) => ({ key: i.key, name: i.name })),
          note: st.note,
        };
      }
      case 'maintenance_log': {
        if (!veh) return OFFLINE;
        const rec = veh.service.logService({
          itemKey: args.itemKey,
          odoKm: args.odoKm ?? null,
          workshop: args.workshop || null,
          cost: args.cost ?? null,
          notes: args.notes || null,
        });
        return { success: true, record: { id: rec.id, itemKey: rec.item_key, odoKm: rec.odo_km } };
      }
      case 'memory_remember': {
        if (!mem) return OFFLINE;
        const item = mem.service.remember({
          kind: args.kind || 'fact',
          key: args.key,
          value: args.value,
          tags: args.tags || [],
          source: 'owner',
        });
        return { success: true, item: { id: item.id, kind: item.kind, key: item.key, value: item.value }, note: 'Bisa diubah/dihapus kapan saja di halaman Memori.' };
      }
      case 'memory_search': {
        if (!mem) return OFFLINE;
        const items = mem.service.search(args.query, { limit: 10 });
        return { query: args.query, count: items.length, items: items.map((i) => ({ kind: i.kind, key: i.key, value: i.value })) };
      }
      default:
        return { error: `Unknown location tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}
