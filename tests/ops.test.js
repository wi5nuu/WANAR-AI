/**
 * Test Suite: manajer operasional — pemeriksaan kesehatan tiap bagian, pengawas yang memberi tahu pemilik
 * SEKALI per masalah (dan saat pulih), tidak di jam tenang, dan "status sistem" dijawab dari hasil nyata.
 */
import { describe, it, expect, vi } from 'vitest';
import { OpsManager, buildChecks, quickOps } from '../src/ops/manager.js';

const H = 3_600_000;
let clock = Date.parse('2026-10-17T05:00:00Z');
const now = () => clock;

function mk(levelOf) {
  const state = { tg: 'ok', ai: 'ok' };
  const notify = vi.fn(async () => {});
  const logs = [];
  const ops = new OpsManager({
    now, notify, log: (e) => logs.push(e),
    checks: [
      { id: 'tg', label: 'Telegram', run: () => ({ level: state.tg, detail: state.tg === 'ok' ? 'membaca' : 'tidak membaca' }) },
      { id: 'ai', label: 'Model AI', run: () => { if (state.ai === 'crash') throw new Error('boom'); return { level: state.ai, detail: 'x' }; } },
    ],
    ...(levelOf || {}),
  });
  return { ops, state, notify, logs };
}

describe('OpsManager', () => {
  it('semua sehat: ringkasan normal, tidak ada pemberitahuan', async () => {
    const { ops, notify } = mk();
    expect(ops.summary().ok).toBe(true);
    expect(ops.text()).toMatch(/^Semua 2 bagian berjalan normal/);
    expect(await ops.tick()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('masalah baru diberitahukan SEKALI, bukan tiap pengecekan; pulih diberitahukan sekali', async () => {
    const { ops, state, notify, logs } = mk();
    state.tg = 'down';
    const a = await ops.tick();
    expect(a).toHaveLength(1);
    expect(notify.mock.calls[0][0]).toBe('Peringatan sistem: Telegram — tidak membaca.');
    clock += 10 * 60_000;
    expect(await ops.tick()).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    state.tg = 'ok';
    clock += 10 * 60_000;
    expect((await ops.tick())[0].text).toContain('Telegram sudah kembali normal');
    expect(await ops.tick()).toEqual([]);
    expect(logs.map((l) => l.kind)).toEqual(['problem', 'recovered']);
  });

  it('masalah yang belum selesai diingatkan lagi setelah masa tunggu (6 jam)', async () => {
    const { ops, state, notify } = mk();
    state.ai = 'warn';
    await ops.tick();
    clock += 5 * H; await ops.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    clock += 2 * H; await ops.tick();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('jam tenang: dicatat tetapi tidak dikirim; setelah jam tenang baru diberitahukan', async () => {
    let quiet = true;
    const { ops, state, notify, logs } = mk({ quiet: () => quiet });
    state.tg = 'down';
    expect(await ops.tick()).toEqual([]);
    expect(logs).toHaveLength(1);
    quiet = false;
    clock += 10 * 60_000;
    expect(await ops.tick()).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('pemeriksaan yang crash dihitung sebagai masalah, bukan melempar', async () => {
    const { ops, state } = mk();
    state.ai = 'crash';
    const s = ops.summary();
    expect(s.ok).toBe(false);
    expect(s.problems[0]).toMatchObject({ id: 'ai', level: 'down' });
    expect(s.problems[0].detail).toContain('pemeriksaan gagal: boom');
    expect(ops.text()).toMatch(/1 dari 2 bagian perlu perhatian/);
  });

  it('notifikasi yang gagal terkirim tidak merusak pengawas', async () => {
    const { ops, state, notify } = mk();
    notify.mockRejectedValue(new Error('down'));
    state.tg = 'down';
    await expect(ops.tick()).resolves.toHaveLength(1);
  });
});

describe('buildChecks (komponen nyata)', () => {
  const base = () => ({
    automation: { inbox: { status: () => ({ wanted: true, running: true }) }, channels: { has: () => true, get: () => ({ mode: 'live' }) } },
    aiManager: { getConfiguredProviders: () => ['clouvia'], getProvider: () => 'clouvia', failover: { skipReason: () => null } },
    emailDesk: { live: true },
    career: { enabled: true, intervalMs: 6 * H, store: { lastGoodScan: () => clock - 2 * H } },
    sales: {
      prospects: { enabled: true, _lastRun: () => clock - 3 * H },
      store: { stats: () => ({ open: 2, needsOwner: 1 }) },
      catalog: () => ({ services: [{ price: { approved: true } }] }),
    },
    env: { DEFAULT_PROVIDER: 'clouvia' }, now,
  });
  const run = (c) => Object.fromEntries(new OpsManager({ checks: buildChecks(c), now }).run().map((r) => [r.id, r]));

  it('semuanya sehat', () => {
    const r = run(base());
    expect(Object.values(r).every((x) => x.level === 'ok')).toBe(true);
    expect(r.career.detail).toBe('pemindaian terakhir 2 jam lalu');
    expect(r.sales.detail).toBe('2 calon klien aktif, 1 menunggu Mas');
  });

  it('mendeteksi bot tuli, AI utama ditolak, email simulasi, radar berhenti, harga belum disetujui', () => {
    const c = base();
    c.automation.inbox.status = () => ({ wanted: false, running: false });
    c.aiManager.failover.skipReason = () => ({ why: 'auth' });
    c.emailDesk.live = false;
    c.career.store.lastGoodScan = () => clock - 20 * H;
    c.sales.prospects._lastRun = () => clock - 30 * H;
    c.sales.catalog = () => ({ services: [{ price: { approved: false } }, { price: { approved: true } }] });
    const r = run(c);
    expect(r.telegram).toMatchObject({ level: 'down' });
    expect(r.telegram.detail).toContain('TELEGRAM_POLLING');
    expect(r.ai).toMatchObject({ level: 'warn' });
    expect(r.ai.detail).toContain('ditolak (auth)');
    expect(r.email).toMatchObject({ level: 'down' });
    expect(r.career).toMatchObject({ level: 'down' });
    expect(r.clients).toMatchObject({ level: 'down' });
    expect(r.sales).toMatchObject({ level: 'warn' });
    expect(r.sales.detail).toContain('1 harga layanan belum disetujui');
  });

  it('komponen yang tidak ada dilewati; memori berlebih jadi peringatan', () => {
    expect(new OpsManager({ checks: buildChecks({ now }), now }).run().map((r) => r.id)).toEqual(['memory']);
    expect(run({ memoryLimitMb: 1, now }).memory.level).toBe('warn');
  });
});

describe('quickOps', () => {
  const ops = { text: () => 'LAPORAN' };
  it('menjawab pertanyaan status, tidak membajak kalimat lain', () => {
    for (const q of ['status sistem', 'cek status agent', 'Status sistem kamu', 'kondisi agen', 'ada yang rusak?', 'apa yang error', 'semua agen jalan?']) expect(quickOps(ops, q), q).toBe('LAPORAN');
    for (const q of ['status lamaran', 'status pembayaran invoice', 'bagaimana kondisi cuaca', 'rusak', 'ada masalah apa dengan hidupku']) expect(quickOps(ops, q), q).toBeNull();
    expect(quickOps(null, 'status sistem')).toBeNull();
  });
});
