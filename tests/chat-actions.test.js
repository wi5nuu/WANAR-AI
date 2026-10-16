/**
 * Test Suite: "YA" flow — aplikasikan aksi berisiko dari chat hanya setelah
 * pemilik membalas YA di chat yang sama. v1: kirim kampanye.
 *
 * Yang dijamin di sini:
 *  - usulan menyebutkan penerima + mode dan TIDAK mengirim apa pun;
 *  - tanpa approval, tool-nya tetap diblokir action gate (bukti gerbang);
 *  - YA menjalankan lewat registry (gate menyetujui + sekali pakai);
 *  - TIDAK membatalkan; kedaluwarsa tidak menjalankan apa pun;
 *  - chat lain tidak bisa mengonfirmasi usulan milik chat kita.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { initAutomation, _resetAutomation } from '../src/automation/runtime.js';
import { createChatActions } from '../src/automation/chat-actions.js';
import { executeTool } from '../src/tools/registry.js';
import { mintApproval, revokeAll } from '../src/security/action-gate.js';

const CHAT = 'wa:628111222333';
const OTHER_CHAT = 'wa:628999888777';

function setup({ env = {}, now = () => Date.now() } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const a = initAutomation({
    db,
    aiManager: { async *chatStream() { yield { type: 'content', content: 'ok' }; yield { type: 'done' }; } },
    env: { EMAIL_THROTTLE_MS: '0', TELEGRAM_THROTTLE_MS: '0', ...env },
    transport: { sendMail: vi.fn(async (m) => ({ messageId: `<${m.to}>`, accepted: [m.to] })) },
    engineOptions: { backoffBaseMs: 1 },
    attachmentsDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wanar-ca-')),
  });
  const chatActions = createChatActions({ automation: a, executeTool, mintApproval, now, ttlMs: 10 * 60_000 });
  return { a, db, chatActions };
}

const draftCampaign = (a, name = 'Promo Juli', channel = 'telegram') =>
  a.engine.create({ name, channel, bodyText: 'Halo {{nama}}', recipients: '55555\n66666' }).campaign;

beforeEach(() => revokeAll());
afterEach(() => { _resetAutomation(); revokeAll(); });

describe('chat-actions — usulan (propose)', () => {
  it('menyebut kampanye, jumlah penerima & mode, tanpa mengirim apa pun', async () => {
    const { a, chatActions } = setup();
    const c = draftCampaign(a);
    const reply = await chatActions.propose('kirim kampanye Promo Juli', CHAT);

    expect(reply).toContain('Promo Juli');
    expect(reply).toContain('2 penerima');
    expect(reply).toMatch(/Balas YA/i);
    expect(a.store.campaigns.get(c.id).status).toBe('draft'); // belum bergerak
    expect(a.store.proposals.latest(CHAT)).toMatchObject({ kind: 'send_campaign', status: 'pending' });
  });

  it('satu draf + tanpa nama = usul draf itu; nama tak dikenal = daftar, tanpa usulan', async () => {
    const { a, chatActions } = setup();
    draftCampaign(a, 'Promo Juli');
    expect(await chatActions.propose('kirim kampanye', CHAT)).toContain('Promo Juli');

    const reply = await chatActions.propose('kirim kampanye Zzz Tidak Ada', OTHER_CHAT);
    expect(reply).toContain('tidak ketemu');
    expect(a.store.proposals.latest(OTHER_CHAT)).toBeNull();
  });

  it('pesan biasa tidak memicu usulan', async () => {
    const { chatActions } = setup();
    expect(await chatActions.propose('halo, apa kabar?', CHAT)).toBeNull();
    expect(await chatActions.propose('kirim email ke klien', CHAT)).toBeNull();
  });
});

describe('chat-actions — konfirmasi (confirm)', () => {
  it('tanpa approval manusia, tool-nya tetap diblokir action gate', async () => {
    const { a } = setup();
    const c = draftCampaign(a);
    const res = await executeTool('automation_send_campaign', { campaign_id: c.id });
    expect(res.blocked).toBe(true);
    expect(res.code).toBe('approval_required');
    expect(a.store.campaigns.get(c.id).status).toBe('draft');
  });

  it('YA menjalankan lewat registry + gate, dan sekali saja', async () => {
    const { a, chatActions } = setup();
    const c = draftCampaign(a);
    await chatActions.propose('kirim kampanye Promo Juli', CHAT);
    const p = a.store.proposals.latest(CHAT);

    const reply = await chatActions.confirm('YA', CHAT);
    expect(reply).toMatch(/mulai dikirim/i);
    expect(['running', 'completed']).toContain(a.store.campaigns.get(c.id).status);
    expect(a.store.proposals.get(p.id).status).toBe('done');

    // YA kedua: tidak ada usulan lagi → tidak terjadi apa-apa.
    expect(await chatActions.confirm('YA', CHAT)).toBeNull();
  });

  it('TIDAK membatalkan; kampanye tetap draf', async () => {
    const { a, chatActions } = setup();
    const c = draftCampaign(a);
    await chatActions.propose('kirim kampanye Promo Juli', CHAT);
    const p = a.store.proposals.latest(CHAT);

    const reply = await chatActions.confirm('tidak', CHAT);
    expect(reply).toMatch(/dibatalkan/i);
    expect(a.store.campaigns.get(c.id).status).toBe('draft');
    expect(a.store.proposals.get(p.id).status).toBe('cancelled');
  });

  it('usulan kedaluwarsa tidak pernah dijalankan', async () => {
    let t = 1_000_000;
    const { a, chatActions } = setup({ now: () => t });
    const c = draftCampaign(a);
    await chatActions.propose('kirim kampanye Promo Juli', CHAT);

    t += 10 * 60_000 + 1; // lewat 1 menit dari TTL
    const reply = await chatActions.confirm('YA', CHAT);
    expect(reply).toMatch(/kedaluwarsa/i);
    expect(a.store.campaigns.get(c.id).status).toBe('draft');
    expect(a.store.proposals.latest(CHAT)).toBeNull();
  });

  it('chat lain tidak bisa mengonfirmasi usulan milik chat kita', async () => {
    const { a, chatActions } = setup();
    const c = draftCampaign(a);
    await chatActions.propose('kirim kampanye Promo Juli', CHAT);

    expect(await chatActions.confirm('YA', OTHER_CHAT)).toBeNull();
    expect(a.store.campaigns.get(c.id).status).toBe('draft');
    expect(a.store.proposals.latest(CHAT).status).toBe('pending');
  });

  it('usulan baru menggantikan usulan lama (tidak ada YA yang basi)', async () => {
    const { a, chatActions } = setup();
    draftCampaign(a, 'Promo Juli');
    draftCampaign(a, 'Info Harga');
    await chatActions.propose('kirim kampanye Promo Juli', CHAT);
    const first = a.store.proposals.latest(CHAT);
    await chatActions.propose('kirim kampanye Info Harga', CHAT);

    expect(a.store.proposals.get(first.id).status).toBe('superseded');
    const reply = await chatActions.confirm('YA', CHAT);
    expect(reply).toContain('Info Harga');
    expect(a.store.campaigns.get(first.payload.campaignId).status).toBe('draft');
  });
});
