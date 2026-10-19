/**
 * Test Suite: tests/vehicle-telegram.test.js
 * Tests Telegram vehicle commands, notice formatting, and briefing integration.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createVehicleStore } from '../src/vehicle/store.js';
import { VehicleService, formatVehicleNotice } from '../src/vehicle/service.js';
import { vehicleTelegramCommands } from '../src/vehicle/telegram.js';
import { createBriefing } from '../src/briefing.js';

const T0 = Date.parse('2026-10-19T06:00:00Z'); // 13:00 WIB
const DAY = 86_400_000;

function setup() {
  const db = new Database(':memory:');
  let clock = T0;
  const store = createVehicleStore(db);
  const svc = new VehicleService({ store, now: () => clock, env: {} });
  return {
    db,
    store,
    svc,
    cmds: vehicleTelegramCommands(svc),
    set: (ms) => { clock = ms; },
    advance: (ms) => { clock += ms; },
  };
}

describe('Telegram commands for motorcycle care', () => {
  it('/motor returns complete status including plate, odometer, fuel and AHASS service', async () => {
    const { svc, cmds } = setup();
    svc.updateVehicle({ plate: 'B 4780 UDM', name: 'Honda Vario 160 CBS', tank_liters: 5.5, baseline_kmpl: 50 });
    svc.addReading({ odoKm: 12000 });
    svc.addFill({ liters: 5, odoKm: 12000, fullTank: true });
    svc.logService({
      itemKey: 'servis_berkala',
      ts: T0 - 16 * DAY,
      odoKm: 12000,
      workshop: 'AHASS Mitra Jaya Bekasi',
      cost: 892500,
      notes: 'Tune Up Vario 160, Ganti Ban Belakang, Ganti Kampas Rem',
      evidence: { invoiceNo: 'INV.26.002.00015196', refNo: 'WO.26.002.00013906' },
    });

    const res = await cmds.motor.run({ chatId: '123' });
    expect(res).toContain('HONDA VARIO 160 CBS (B 4780 UDM)');
    expect(res).toContain('12.000 km');
    expect(res).toContain('AHASS Mitra Jaya Bekasi');
    expect(res).toContain('INV.26.002.00015196');
    expect(res).toContain('Rp892.500');
    expect(res).toContain('Jadwal Servis Berkala:');
  });

  it('/servis lists component status and recent service history', async () => {
    const { svc, cmds } = setup();
    svc.updateItem('rem', { intervalKm: 8000, intervalMonths: 6, verified: true });
    svc.logService({
      itemKey: 'rem',
      ts: T0 - 16 * DAY,
      workshop: 'AHASS Mitra Jaya Bekasi',
      cost: 189500,
      notes: 'Ganti kampas rem depan & belakang',
    });

    const res = await cmds.servis.run({ chatId: '123' });
    expect(res).toContain('JADWAL PERAWATAN MOTOR');
    expect(res).toContain('Riwayat Servis Bengkel:');
    expect(res).toContain('AHASS Mitra Jaya Bekasi');
    expect(res).toContain('Ganti kampas rem depan & belakang');
  });

  it('/odometer reads status when empty and updates when number provided', async () => {
    const { svc, cmds } = setup();
    const empty = await cmds.odometer.run({ arg: '' });
    expect(empty).toContain('Belum ada catatan odometer');

    const updated = await cmds.odometer.run({ arg: '12500' });
    expect(updated).toContain('12.500 km');

    const check = await cmds.odometer.run({ arg: '' });
    expect(check).toContain('12.500 km');

    const delta = await cmds.odometer.run({ arg: '12750' });
    expect(delta).toContain('+250 km');
  });

  it('/bensin reads status when empty and records fill-up with args', async () => {
    const { svc, cmds } = setup();
    const empty = await cmds.bensin.run({ arg: '' });
    expect(empty).toContain('Status Bahan Bakar:');

    const recorded = await cmds.bensin.run({ arg: '4.5 12500' });
    expect(recorded).toContain('4.5 Liter');
    expect(recorded).toContain('12.500 km');
  });
});

describe('formatVehicleNotice formatting', () => {
  it('formats professional executive alerts for Telegram', () => {
    const v = { name: 'Honda Vario 160 CBS', plate: 'B 4780 UDM' };
    const overdue = formatVehicleNotice({
      kind: 'maintenance_overdue',
      item: { name: 'Servis Berkala Bengkel (AHASS)', safetyCritical: false },
      reason: 'sudah melewati batas 2 bulan',
      vehicle: v,
    });
    expect(overdue).toContain('PENGINGAT PERAWATAN MOTOR — HONDA VARIO 160 CBS (B 4780 UDM)');
    expect(overdue).toContain('STATUS: JATUH TEMPO');
    expect(overdue).toContain('Servis Berkala Bengkel (AHASS)');

    const soon = formatVehicleNotice({
      kind: 'maintenance_soon',
      item: { name: 'Sistem rem & kampas', safetyCritical: true },
      reason: 'sisa 5 hari lagi',
      vehicle: v,
    });
    expect(soon).toContain('STATUS: MENDEKATI JADWAL SERVIS');
    expect(soon).toContain('Sistem rem & kampas');

    const odo = formatVehicleNotice({
      kind: 'odometer_stale',
      vehicle: v,
      reason: 'Catatan odometer belum diperbarui 14 hari',
    });
    expect(odo).toContain('PENGINGAT ODOMETER');
    expect(odo).toContain('/odometer');
  });
});

describe('Briefing integration with vehicle', () => {
  it('includes vehicle status in morning briefing when periodic service is tracked', () => {
    const { svc } = setup();
    svc.updateVehicle({ plate: 'B 4780 UDM', name: 'Honda Vario 160 CBS' });
    svc.updateItem('servis_berkala', { intervalKm: 2000, intervalMonths: 2, verified: true });
    svc.logService({
      itemKey: 'servis_berkala',
      ts: T0 - 16 * DAY,
      workshop: 'AHASS Mitra Jaya Bekasi',
    });

    const fakeWorklog = {
      getSettings: () => ({ workdays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '17:00' }),
      listReminders: () => [],
      day: () => ({ taskList: [], workedMin: 0, tasks: { done: 0, total: 0 }, money: { income: 0, expense: 0, net: 0 } }),
    };

    const briefing = createBriefing({
      worklog: fakeWorklog,
      vehicle: svc,
      now: () => T0,
      env: {},
    });

    const text = briefing.build(T0);
    expect(text).toContain('Motor Honda Vario 160 CBS (B 4780 UDM):');
    expect(text).toContain('Servis berkala: sisa');
  });
});
