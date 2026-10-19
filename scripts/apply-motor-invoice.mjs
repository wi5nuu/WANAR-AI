/**
 * scripts/apply-motor-invoice.mjs
 *
 * Applies the official AHASS Mitra Jaya Bekasi invoice (INV.26.002.00015196)
 * to the vehicle system:
 *   - Vehicle metadata (Honda Vario 160 CBS, B 4780 UDM, 5.5L tank, Pertamax)
 *   - Service records (Tune Up, Ban Luar RR 120/70-14, Kampas Rem FR & RR)
 *   - Maintenance schedule (Servis berkala interval 2 bulan / 2000 km per AHASS)
 *   - Personal memory facts for AI assistant context
 *   - Scheduled reminders in worklog for upcoming due date (03 Des 2026)
 *
 * @author Wisnu Alfian Nur Ashar
 */

import sqliteDb from '../src/database.js';
import { initVehicle } from '../src/vehicle/index.js';
import { initMemory } from '../src/memory/index.js';
import { initWorklog } from '../src/worklog/index.js';

console.log('[MOTOR] Applying invoice INV.26.002.00015196...');

const vModule = initVehicle({ db: sqliteDb });
const memModule = initMemory({ db: sqliteDb });
const wlModule = initWorklog({ db: sqliteDb });

const svc = vModule.service;
const store = vModule.store;

// 1. Update vehicle record
const v = svc.vehicle();
svc.updateVehicle({
  name: 'Honda Vario 160 CBS',
  model: 'Vario 160 CBS',
  plate: 'B 4780 UDM',
  fuel_type: 'Pertamax',
  tank_liters: 5.5,
  baseline_kmpl: 50,
  reserve_km: 60,
  price_per_liter: 12500,
});
console.log('✓ Vehicle updated:', svc.vehicle().name, 'Plat:', svc.vehicle().plate);

// 2. Add service record from AHASS invoice
const invoiceTs = new Date('2026-10-03T15:27:55+07:00').getTime();

// Check if this invoice is already logged
const existing = store.services.recent(v.id, 50).find(
  (r) => r.evidence?.invoiceNo === 'INV.26.002.00015196'
);

let serviceRecord;
if (!existing) {
  serviceRecord = store.services.add({
    vehicleId: v.id,
    itemKey: 'servis_berkala',
    ts: invoiceTs,
    odoKm: null,
    workshop: 'AHASS MITRA JAYA BEKASI (Jl. Jendral Sudirman No. 99 Kranji, Telp: 021-88854053)',
    cost: 892500,
    parts: [
      { code: '06455K59A71', name: 'PAD SET, FR BRAKE', qty: 1, price: 86486, ppn: 9514, subtotal: 96000 },
      { code: '43130KZL930', name: 'SHOE PAIR, BRAKE', qty: 1, price: 52703, ppn: 5797, subtotal: 58500 },
      { code: '42711K2SN01', name: 'TIRE, RR(SRI) (120/70-14M/C 61P)', qty: 1, price: 421622, ppn: 46378, subtotal: 468000 },
      { code: 'LR-0055', name: 'GANTI BAN LUAR MATIC', qty: 1, price: 36036, ppn: 3964, subtotal: 40000 },
      { code: 'LR-0053', name: 'GANTI PAD SET', qty: 1, price: 31532, ppn: 3468, subtotal: 35000 },
      { code: 'CS-0101', name: 'TUNE UP VARIO 160', qty: 1, price: 175676, ppn: 19324, subtotal: 195000 },
    ],
    notes: 'Tune Up Vario 160 (CS-0101), Ganti Ban Luar Belakang Tubeless 120/70-14 SRI (42711K2SN01), Ganti Pad Set Rem Depan (06455K59A71), Ganti Kampas Rem Belakang Tromol (43130KZL930). Rekomendasi AHASS: kembali servis setelah 2.000 km atau 2 bulan (jatuh tempo: 03 Desember 2026). Garansi perbaikan: 1 minggu / 500 km.',
    evidence: {
      invoiceNo: 'INV.26.002.00015196',
      refNo: 'WO.26.002.00013906',
      refDate: '03/10/2026',
      customerNo: 'CS.24.007.00003169',
      customerName: 'ASHAR',
      phone: '081394882490',
      plate: 'B4780UDM',
      mechanic: 'MUHAMMAD ROBBANI',
      sa: 'DDMS205',
      dppService: 243244,
      dppSparepart: 560811,
      ppn: 88445,
      total: 892500,
      paymentStatus: 'LUNAS',
    },
    source: 'invoice_ahass',
  });
  console.log('✓ Service record logged with ID:', serviceRecord.id);
} else {
  serviceRecord = existing;
  console.log('✓ Service record already present with ID:', existing.id);
}

// 3. Update maintenance items (servis_berkala, rem, ban)
svc.updateItem('servis_berkala', {
  intervalKm: 2000,
  intervalMonths: 2,
  verified: true,
  source: 'AHASS Mitra Jaya Bekasi (INV.26.002.00015196)',
  notes: 'Rekomendasi resmi AHASS Mitra Jaya Bekasi: kembali servis setelah 2.000 km atau 2 bulan (jatuh tempo 03 Des 2026). Tune Up Vario 160.',
});
store.items.update(v.id, 'servis_berkala', {
  last_service_at: invoiceTs,
  verified: 1,
  source: 'AHASS Mitra Jaya Bekasi (INV.26.002.00015196)',
});

svc.updateItem('rem', {
  intervalKm: 8000,
  intervalMonths: 6,
  verified: true,
  source: 'AHASS Mitra Jaya Bekasi (INV.26.002.00015196)',
  notes: 'Penggantian Pad Set Rem Depan (06455K59A71) dan Kampas Rem Belakang Tromol (43130KZL930) di AHASS.',
});
store.items.update(v.id, 'rem', {
  last_service_at: invoiceTs,
  verified: 1,
  source: 'AHASS Mitra Jaya Bekasi (INV.26.002.00015196)',
});

svc.updateItem('ban', {
  intervalKm: 4000,
  intervalMonths: 1,
  verified: true,
  source: 'AHASS Mitra Jaya Bekasi (INV.26.002.00015196)',
  notes: 'Penggantian Ban Luar Belakang Tubeless 120/70-14 SRI (42711K2SN01) & jasa ganti ban matic (LR-0055) di AHASS.',
});
store.items.update(v.id, 'ban', {
  last_service_at: invoiceTs,
  verified: 1,
  source: 'AHASS Mitra Jaya Bekasi (INV.26.002.00015196)',
});

console.log('✓ Maintenance items verified and schedule updated to 2 months / 2.000 km.');

// 4. Ingest memory items
memModule.service.remember({
  kind: 'fact',
  key: 'motor:profil',
  value: 'Sepeda motor Mas Wisnu: Honda Vario 160 CBS, nomor polisi B 4780 UDM, kapasitas tangki 5.5 Liter, bahan bakar Pertamax.',
  tags: ['motor', 'kendaraan', 'profil'],
  source: 'invoice_ahass',
  confidence: 1,
});

memModule.service.remember({
  kind: 'note',
  key: 'motor:servis:2026-10-03',
  value: 'Servis resmi di AHASS Mitra Jaya Bekasi (Kranji) tanggal 03 Oktober 2026 (INV.26.002.00015196). Pekerjaan: Tune Up Vario 160, Ganti Ban Belakang 120/70-14 SRI, Ganti Kampas Rem Depan & Belakang. Mekanik: Muhammad Robbani, SA: DDMS205. Total biaya: Rp 892.500 (Lunas). Rekomendasi AHASS: kembali servis setelah 2.000 km atau 2 bulan (03 Desember 2026).',
  tags: ['motor', 'servis', 'ahass'],
  source: 'invoice_ahass',
  confidence: 1,
});

memModule.service.remember({
  kind: 'fact',
  key: 'motor:jadwal:servis_berkala',
  value: 'Jadwal servis berkala berikutnya untuk Honda Vario 160 (B 4780 UDM) adalah 03 Desember 2026 atau setelah 2.000 km dari servis terakhir di AHASS Mitra Jaya Bekasi.',
  tags: ['motor', 'jadwal', 'servis'],
  source: 'invoice_ahass',
  confidence: 1,
});
console.log('✓ Personal memory ingested for AI assistant context.');

// 5. Schedule proactive Telegram reminders in worklog
const ownerChat = String(process.env.TELEGRAM_AI_CHAT_IDS || '1811580954').split(',')[0].trim() || '1811580954';
try {
  wlModule.service.addReminder({
    at: '2026-11-26 09:00',
    chatId: ownerChat,
    text: '🛵 Pengingat Servis Motor (H-7): 7 hari lagi menuju batas 2 bulan jadwal servis berkala Honda Vario 160 (B 4780 UDM) di AHASS Mitra Jaya Bekasi (jatuh tempo 03 Desember 2026). Hubungi AHASS di 021-88854053 untuk booking servis.',
    source: 'vehicle_module',
  });
  console.log('✓ Scheduled H-7 reminder: 2026-11-26 09:00 WIB');
} catch (e) {
  console.warn('H-7 reminder:', e.message);
}

try {
  wlModule.service.addReminder({
    at: '2026-12-02 09:00',
    chatId: ownerChat,
    text: '🛵 Pengingat Servis Motor (H-1): Besok (03 Desember 2026) adalah batas rekomendasi servis berkala 2 bulan Honda Vario 160 (B 4780 UDM) di AHASS Mitra Jaya Bekasi. Pastikan kondisi oli, rem, dan ban siap diservis.',
    source: 'vehicle_module',
  });
  console.log('✓ Scheduled H-1 reminder: 2026-12-02 09:00 WIB');
} catch (e) {
  console.warn('H-1 reminder:', e.message);
}

try {
  wlModule.service.addReminder({
    at: '2026-12-03 08:30',
    chatId: ownerChat,
    text: '🛵 Hari Ini Batas Jadwal Servis AHASS: Honda Vario 160 (B 4780 UDM) genap 2 bulan sejak servis sebelumnya di AHASS Mitra Jaya Bekasi (03 Okt 2026). Segera lakukan servis berkala dan tune up di bengkel resmi AHASS.',
    source: 'vehicle_module',
  });
  console.log('✓ Scheduled Hari H reminder: 2026-12-03 08:30 WIB');
} catch (e) {
  console.warn('Hari H reminder:', e.message);
}

sqliteDb.prepare("UPDATE wl_reminders SET chat_id = ? WHERE (chat_id IS NULL OR chat_id = '') AND source = 'vehicle_module'").run(ownerChat);

// 6. Print final status
const status = svc.status();
console.log('\n=== STATUS MOTOR TERKINI ===');
console.log('Kendaraan :', status.vehicle.name, status.vehicle.plate);
for (const it of status.items) {
  console.log(`- ${it.name}: ${it.status.toUpperCase()} (${it.reason}) [Verified: ${it.verified}]`);
}
console.log('============================\n');
