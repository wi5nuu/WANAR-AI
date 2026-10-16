/**
 * Test Suite: Sales desk — penyaringan calon klien (aturan tertulis), keputusan "perlu pemilik",
 * balasan yang hanya memakai katalog & fakta pemilik, harga yang belum disetujui TIDAK boleh disebut,
 * spam/banjir pesan, deduplikasi kontak, pemberitahuan pemilik, rute HTTP, dan perintah Telegram.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

import { detectLanguage, matchService, parseBudget, parseDeadlineDays, looksLikeSpam, qualify } from '../src/sales/qualify.js';
import { defaultCatalog, priceRange, proofLines } from '../src/sales/catalog.js';
import { decide, buildReply, buildFollowUp } from '../src/sales/reply.js';
import { SalesStore } from '../src/sales/store.js';
import { createSales, normalizeContact } from '../src/sales/service.js';
import { createSalesRouter, createInquiryRouter } from '../src/sales/routes.js';
import { quickSales } from '../src/sales/quick.js';

const CAT = defaultCatalog();
const FACTS = { en: {
  personalInfo: { name: 'Wisnu Alfian Nur Ashar', website: 'https://contoh.my.id', email: 'wisnu@contoh.id' },
  projects: [{ title: 'Ashar Grosir Parfum', status: 'Production', description: 'Official E-Commerce platform for a perfume wholesaler serving 15,000+ partners. Optimized for scale.' }],
} };
const NOON = Date.parse('2026-10-16T05:00:00Z'); // 12.00 WIB
const NIGHT = Date.parse('2026-10-16T18:00:00Z'); // 01.00 WIB
const FORBIDDEN = /(dijamin|pasti\s+(?:selesai|jadi|untung)|garansi|guarantee|100\s*%|diskon)/i;

// ------------------------------------------------------------------ qualify

describe('qualify: layanan, anggaran, tenggat', () => {
  it('mengenali layanan dari kalimat biasa; yang spesifik menang atas kata umum', () => {
    const id = (t) => matchService(t, CAT.services).service?.id;
    expect(id('Saya butuh website toko online untuk jualan parfum')).toBe('ecommerce');
    expect(id('mau bikin company profile perusahaan')).toBe('landing');
    expect(id('butuh sistem kasir dan stok untuk toko')).toBe('webapp');
    expect(id('bisa pentest website saya?')).toBe('security');
    expect(id('butuh chatbot whatsapp untuk balas pelanggan')).toBe('automation');
    expect(id('tolong maintenance website yang sering error')).toBe('maintenance');
    expect(id('aplikasi toko online dengan keranjang')).toBe('ecommerce'); // "aplikasi" generik kalah
    expect(matchService('halo', CAT.services)).toMatchObject({ service: null, confidence: 'none' });
    expect(matchService('mau bikin website', CAT.services)).toMatchObject({ confidence: 'low' });
  });

  it('parseBudget: satuan, rentang, dan angka yang bukan uang', () => {
    expect(parseBudget('budget saya 5 juta')).toEqual({ min: 5_000_000, max: 5_000_000 });
    expect(parseBudget('anggaran 3-5 juta')).toEqual({ min: 3_000_000, max: 5_000_000 });
    expect(parseBudget('biaya sekitar Rp 2.500.000')).toEqual({ min: 2_500_000, max: 2_500_000 });
    expect(parseBudget('dana kira-kira 500rb')).toEqual({ min: 500_000, max: 500_000 });
    expect(parseBudget('saya buka usaha sejak tahun 2024 dengan 5 karyawan')).toBeNull();
    expect(parseBudget('halo')).toBeNull();
  });

  it('parseDeadlineDays', () => {
    expect(parseDeadlineDays('butuh selesai dalam 2 minggu')).toBe(14);
    expect(parseDeadlineDays('harus jadi besok')).toBe(2);
    expect(parseDeadlineDays('urgent ya')).toBe(3);
    expect(parseDeadlineDays('target tayang bulan depan')).toBe(30);
    expect(parseDeadlineDays('saya punya 3 hari libur')).toBeNull(); // bukan tenggat proyek
    expect(parseDeadlineDays('halo')).toBeNull();
  });

  it('detectLanguage', () => {
    expect(detectLanguage('Hi, I need a website for my shop. How much would it cost?')).toBe('en');
    expect(detectLanguage('Halo, saya butuh website untuk toko saya')).toBe('id');
    expect(detectLanguage('ok')).toBe('id');
  });

  it('spam: tawaran SEO/backlink, judi, banyak tautan, tautan kosong', () => {
    for (const t of [
      'Kami menawarkan backlink murah dan SEO dijamin ranking 1 google',
      'slot gacor hari ini daftar sekarang',
      'cek https://a.com https://b.com https://c.com',
      'https://scam.example/promo',
      'Selamat Anda menang hadiah, klik link ini',
      'We offer guest post services for your site',
    ]) expect(looksLikeSpam(t), t).toBe(true);
    for (const t of ['Saya butuh website, referensi saya https://contoh.com/desain', 'halo, bisa bikin toko online?']) expect(looksLikeSpam(t), t).toBe(false);
  });

  it('skor: permintaan jelas + anggaran + tenggat panas; spam nol', () => {
    const hot = qualify('Halo, saya butuh website toko online untuk jualan parfum, budget 6 juta, target 3 minggu. WA 081234567890. Katalog sekitar 200 produk dan perlu pembayaran online.', CAT.services);
    expect(hot.score).toBeGreaterThanOrEqual(60);
    expect(hot.service.id).toBe('ecommerce');
    expect(qualify('halo', CAT.services).score).toBeLessThan(20);
    expect(qualify('Kami menawarkan backlink murah', CAT.services)).toMatchObject({ spam: true, score: 0 });
  });
});

// ------------------------------------------------------------------ decide + reply

describe('decide: kapan pemilik harus turun tangan', () => {
  const svc = CAT.services.find((s) => s.id === 'webapp'); // 8jt - 35jt
  const q = (extra) => ({ service: svc, score: 40, spam: false, complaint: false, legal: false, wantsHuman: false, urgent: false, budget: null, ...extra });

  it('komplain, kontrak, minta telepon, tenggat mepet', () => {
    expect(decide(q({ complaint: true })).reasons).toContain('komplain');
    expect(decide(q({ legal: true })).reasons).toContain('kontrak/administrasi');
    expect(decide(q({ wantsHuman: true })).reasons).toContain('minta bicara langsung');
    expect(decide(q({ urgent: true })).escalate).toBe(true);
  });
  it('anggaran jauh di bawah kisaran atau proyek besar -> pemilik; wajar -> agent sendiri', () => {
    expect(decide(q({ budget: { min: 1_000_000, max: 1_000_000 } })).escalate).toBe(true);
    expect(decide(q({ budget: { min: 80_000_000, max: 80_000_000 } })).reasons[0]).toMatch(/proyek besar/);
    expect(decide(q({ budget: { min: 10_000_000, max: 10_000_000 } })).escalate).toBe(false);
  });
  it('panas = skor >= 60 dan bukan spam', () => {
    expect(decide(q({ score: 65 })).hot).toBe(true);
    expect(decide(q({ score: 65, spam: true })).hot).toBe(false);
    expect(decide(q({ score: 40 })).hot).toBe(false);
  });
});

describe('buildReply: hanya katalog & fakta pemilik, tanpa janji', () => {
  const ask = 'Halo, saya Budi. Butuh website toko online untuk jualan parfum, budget 6 juta.';

  it('harga BELUM disetujui: tidak ada satu pun angka rupiah di balasan', () => {
    const cat = defaultCatalog();
    const r = buildReply(qualify(ask, cat.services), cat, FACTS, { name: 'Budi' });
    expect(r).not.toMatch(/Rp\s?\d/);
    expect(r).not.toMatch(/\d+\s*(?:-|sampai)\s*\d+\s*hari/); // estimasi waktu juga ikut harga
    expect(r).toContain('asisten AI');
    expect(r).toContain('Estimasi biaya dan waktu saya sampaikan setelah kebutuhannya jelas');
    expect(r).toContain('Halo Budi');
    expect(r).not.toMatch(FORBIDDEN);
  });

  it('harga disetujui: kisaran & estimasi disebut persis dari katalog', () => {
    const cat = defaultCatalog();
    cat.services.find((s) => s.id === 'ecommerce').price.approved = true;
    const r = buildReply(qualify(ask, cat.services), cat, FACTS, { name: 'Budi' });
    expect(r).toContain(priceRange(cat.services.find((s) => s.id === 'ecommerce').price));
    expect(r).toMatch(/14-35 hari kerja/);
    expect(r).not.toContain('Revisi'); // syarat pembayaran belum disetujui -> tidak disebut
    cat.terms.approved = true;
    expect(buildReply(qualify(ask, cat.services), cat, FACTS, {})).toContain('Revisi 2x');
  });

  it('bukti karya diambil dari lembar fakta; tanpa fakta tidak ada klaim', () => {
    const cat = defaultCatalog();
    const withFacts = buildReply(qualify(ask, cat.services), cat, FACTS, {});
    expect(withFacts).toContain('Ashar Grosir Parfum (Production): Official E-Commerce platform for a perfume wholesaler serving 15,000+ partners.');
    expect(withFacts).toContain('https://contoh.my.id');
    const none = buildReply(qualify(ask, cat.services), cat, null, {});
    expect(none).not.toContain('15,000');
    expect(proofLines({ proofProjects: ['Tidak Ada'] }, FACTS)).toEqual([]);
  });

  it('kebutuhan belum jelas: menanyakan balik & menampilkan daftar layanan', () => {
    const cat = defaultCatalog();
    const r = buildReply(qualify('halo', cat.services), cat, FACTS, {});
    expect(r).toContain('Layanan yang tersedia');
    expect(r).toContain('1. Landing page');
  });

  it('eskalasi: menyebut sudah diteruskan ke pemilik; anggaran rendah dijelaskan sopan bila harga disetujui', () => {
    const cat = defaultCatalog();
    cat.services.find((s) => s.id === 'webapp').price.approved = true;
    const q = qualify('butuh sistem kasir dan stok, budget 1 juta', cat.services);
    const d = decide(q);
    const r = buildReply(q, cat, FACTS, { escalate: d.escalate, reasons: d.reasons });
    expect(d.escalate).toBe(true);
    expect(r).toContain('sudah meneruskan ini ke Wisnu');
    expect(r).toContain('di bawah kisaran biasa');
  });

  it('bahasa Inggris dijawab bahasa Inggris', () => {
    const cat = defaultCatalog();
    const q = qualify('Hi, I need a website for my online shop. How much would it cost?', cat.services);
    const r = buildReply(q, cat, FACTS, {});
    expect(q.lang).toBe('en');
    expect(r).toMatch(/AI assistant/);
    expect(r).not.toMatch(/Halo|terima kasih/i);
  });

  it('tidak pernah mengandung janji/jaminan, apa pun masukannya', () => {
    const cat = defaultCatalog();
    cat.services.forEach((s) => { s.price.approved = true; });
    cat.terms.approved = true;
    for (const t of ['butuh website dijamin cepat dan pasti jadi', 'toko online murah diskon', 'sistem kasir, garansi?', 'chatbot whatsapp']) {
      const q = qualify(t, cat.services);
      const r = buildReply(q, cat, FACTS, {});
      expect(r, t).not.toMatch(FORBIDDEN);
      expect(buildFollowUp('id', true)).not.toMatch(FORBIDDEN);
    }
  });
});

// ------------------------------------------------------------------ service

function make({ env = {}, now = NOON, notify = vi.fn(async () => {}), senders = {} } = {}) {
  let clock = now;
  const store = new SalesStore(new Database(':memory:'), { now: () => clock });
  const logs = [];
  const svc = createSales({ store, getFacts: () => FACTS, notify, ownerChat: () => '55555', log: (e) => logs.push(e), senders, now: () => clock, env: { CAREER_TELEGRAM: 'on', ...env } });
  return { svc, store, notify, logs, senders, tick: (ms) => { clock += ms; } };
}

const HOT = 'Halo, saya Budi. Butuh website toko online untuk jualan parfum, budget 6 juta, target 3 minggu. WA 081234567890. Katalog sekitar 200 produk dan perlu pembayaran online.';

describe('SalesService.intake', () => {
  it('prospek baru: dicatat, dinilai, dibalas, pemilik diberi tahu SEKALI', async () => {
    const { svc, store, notify } = make({ env: { SALES_AUTO_REPLY: 'on' } });
    const r = await svc.intake({ source: 'whatsapp', contact: '081234567890', name: 'Budi', text: HOT });
    expect(r).toMatchObject({ created: true, autoSend: true, hot: true, spam: false });
    expect(r.reply).toContain('asisten AI');
    const lead = store.getLead(r.leadId);
    expect(lead).toMatchObject({ source: 'whatsapp', contact: '6281234567890', service_id: 'ecommerce', budget_min: 6_000_000, status: 'contacted' });
    expect(store.messages(lead.id).map((m) => m.direction)).toEqual(['in', 'out']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toMatch(/Prospek panas #1/);
    expect(notify.mock.calls[0][1]).toContain('prospek 1');
    // pesan berikutnya dari orang yang sama: lead sama, pemilik tidak dibombardir
    await svc.intake({ source: 'whatsapp', contact: '+62 812-3456-7890', text: 'Oke, terima kasih infonya.' });
    expect(store.listLeads().total).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('kanal WhatsApp: balasan tidak dikirim otomatis bila SALES_AUTO_REPLY mati; website tetap mendapat jawaban', async () => {
    const off = make();
    const wa = await off.svc.intake({ source: 'whatsapp', contact: '081111111111', text: 'butuh website company profile' });
    expect(wa).toMatchObject({ autoSend: false });
    expect(wa.reply).toBeTruthy(); // draf tersedia untuk pemilik
    expect(off.store.messages(wa.leadId).map((m) => m.direction)).toEqual(['in']);
    const site = await off.svc.intake({ source: 'site', contact: 'budi@contoh.id', text: 'butuh website company profile' });
    expect(site.autoSend).toBe(true);
  });

  it('balasan lanjutan menjawab isi pesan (bukan basa-basi), dan setelah 6 balasan otomatis berhenti & minta pemilik', async () => {
    const { svc, store } = make({ env: { SALES_AUTO_REPLY: 'on' } });
    const first = await svc.intake({ source: 'whatsapp', contact: '081200000001', text: 'butuh website toko online' });
    expect(first.reply.length).toBeGreaterThan(200);
    const second = await svc.intake({ source: 'whatsapp', contact: '081200000001', text: 'katalognya sekitar 200 produk dengan pembayaran online' });
    expect(second.reply).toContain('sudah saya catat');
    expect(second.reply).toMatch(/\?|mohon dijawab/); // selalu ada langkah berikutnya yang jelas
    for (let i = 0; i < 4; i += 1) await svc.intake({ source: 'whatsapp', contact: '081200000001', text: `tambahan informasi nomor ${i} tentang desain` });
    const seventh = await svc.intake({ source: 'whatsapp', contact: '081200000001', text: 'halo?' });
    expect(seventh.reply).toBeNull();
    expect(seventh.escalate).toBe(true);
    expect(store.getLead(first.leadId).escalate_reason.join()).toMatch(/percakapan sudah panjang/);
  });

  it('anggaran yang disebut di pesan kedua tetap dihitung (percakapan digabung)', async () => {
    const { svc, store } = make({ env: { SALES_AUTO_REPLY: 'on' } });
    const a = await svc.intake({ source: 'whatsapp', contact: '081200000002', text: 'butuh sistem kasir dan stok' });
    await svc.intake({ source: 'whatsapp', contact: '081200000002', text: 'anggaran saya 1 juta' });
    const lead = store.getLead(a.leadId);
    expect(lead).toMatchObject({ budget_max: 1_000_000, escalated: true });
  });

  it('spam: tidak dijawab, tidak dilaporkan, dan kontak itu dibisukan selamanya', async () => {
    const { svc, store, notify } = make({ env: { SALES_AUTO_REPLY: 'on' } });
    const s = await svc.intake({ source: 'whatsapp', contact: '081300000000', text: 'Kami menawarkan backlink murah dan seo dijamin' });
    expect(s).toMatchObject({ spam: true, reply: null, autoSend: false });
    expect(store.getLead(s.leadId).status).toBe('spam');
    const later = await svc.intake({ source: 'whatsapp', contact: '081300000000', text: 'halo saya butuh website toko online' });
    expect(later).toMatchObject({ spam: true, reply: null });
    expect(notify).not.toHaveBeenCalled();
    expect(store.stats().newToday).toBe(0); // spam tidak dihitung sebagai prospek
  });

  it('banjir pesan dari satu kontak: dibatasi', async () => {
    const { svc } = make({ env: { SALES_AUTO_REPLY: 'on' } });
    let last;
    for (let i = 0; i < 15; i += 1) last = await svc.intake({ source: 'whatsapp', contact: '081400000000', text: `butuh website ${i}` });
    expect(last).toMatchObject({ rateLimited: true, reply: null });
  });

  it('kosong / tanpa kontak diabaikan', async () => {
    const { svc } = make();
    expect((await svc.intake({ source: 'site', contact: 'a@b.c', text: '   ' })).leadId).toBeNull();
    expect((await svc.intake({ source: 'site', contact: '', text: 'butuh website' })).leadId).toBeNull();
  });

  it('jam tenang menahan pemberitahuan; flush mengirimnya pagi hari, sekali', async () => {
    const { svc, notify, tick } = make({ env: { SALES_AUTO_REPLY: 'on' }, now: NIGHT });
    await svc.intake({ source: 'whatsapp', contact: '081500000000', text: HOT });
    expect(notify).not.toHaveBeenCalled();
    tick(8 * 3_600_000); // 09.00 WIB
    expect(await svc.flush()).toBe(1);
    expect(await svc.flush()).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('instance tanpa CAREER_TELEGRAM=on (laptop) tidak mengirim apa pun ke pemilik', async () => {
    const { svc, notify } = make({ env: { CAREER_TELEGRAM: '', SALES_AUTO_REPLY: 'on' } });
    await svc.intake({ source: 'whatsapp', contact: '081600000000', text: HOT });
    expect(notify).not.toHaveBeenCalled();
  });

  it('Telegram gagal: tidak ditandai terkirim, dicoba lagi lewat flush', async () => {
    const notify = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined);
    const { svc } = make({ env: { SALES_AUTO_REPLY: 'on' }, notify });
    await svc.intake({ source: 'whatsapp', contact: '081700000000', text: HOT });
    expect(await svc.flush()).toBe(1);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe('katalog & persetujuan harga (keputusan pemilik)', () => {
  it('bawaan: semua harga BELUM disetujui', () => {
    const { svc } = make();
    expect(svc.catalog().services.every((s) => s.price.approved === false)).toBe(true);
    expect(svc.catalog().terms.approved).toBe(false);
  });

  it('mengubah harga membatalkan persetujuan, kecuali disetujui di panggilan yang sama; harga ngawur ditolak', () => {
    const { svc } = make();
    svc.approvePrices();
    expect(svc.catalog().services.every((s) => s.price.approved)).toBe(true);
    const s = svc.updateService('webapp', { price: { min: 9_000_000, max: 30_000_000 } });
    expect(s.price).toMatchObject({ min: 9_000_000, max: 30_000_000, approved: false });
    expect(svc.updateService('webapp', { price: { min: 9_000_000, max: 30_000_000, approved: true } }).price.approved).toBe(true);
    expect(() => svc.updateService('webapp', { price: { min: 10, max: 5 } })).toThrow(/tidak valid/);
    expect(() => svc.updateService('webapp', { price: { min: 1_000_000, max: 2_000_000, unit: 'kg' } })).toThrow(/satuan/);
    expect(() => svc.updateService('tidak-ada', {})).toThrow(/tidak ditemukan/);
  });

  it('setelah disetujui, balasan baru memuat angka; sebelumnya tidak', async () => {
    const { svc } = make({ env: { SALES_AUTO_REPLY: 'on' } });
    const before = await svc.intake({ source: 'whatsapp', contact: '081800000001', text: 'butuh website toko online' });
    expect(before.reply).not.toMatch(/Rp\s?\d/);
    svc.approvePrices({ ids: ['ecommerce'] });
    const after = await svc.intake({ source: 'whatsapp', contact: '081800000002', text: 'butuh website toko online' });
    expect(after.reply).toContain('Rp4 juta - Rp12 juta');
    const other = await svc.intake({ source: 'whatsapp', contact: '081800000003', text: 'butuh sistem kasir' });
    expect(other.reply).not.toMatch(/Rp\s?\d/); // layanan lain tetap belum disetujui
  });

  it('katalog tersimpan menggabungkan layanan baru dari bawaan', () => {
    const { svc, store } = make();
    svc.updateService('landing', { summary: 'Ringkasan baru' });
    const cat = store.catalog();
    expect(cat.services.find((s) => s.id === 'landing').summary).toBe('Ringkasan baru');
    expect(cat.services.find((s) => s.id === 'landing').match).toBeInstanceOf(RegExp);
    expect(cat.services).toHaveLength(6);
  });
});

describe('sisi pemilik', () => {
  it('ownerReply mengirim lewat kanal yang bisa mengirim, mencatat, dan menurunkan "perlu pemilik"', async () => {
    const sender = vi.fn(async () => {});
    const { svc, store } = make({ env: { SALES_AUTO_REPLY: 'on' }, senders: { whatsapp: sender } });
    const r = await svc.intake({ source: 'whatsapp', contact: '081900000000', text: 'butuh sistem kasir dan stok, budget 1 juta' });
    expect(store.getLead(r.leadId).escalated).toBe(true);
    expect(await svc.ownerReply(r.leadId, 'Halo, saya Wisnu. Boleh telepon?')).toEqual({ sent: true });
    expect(sender).toHaveBeenCalledWith('6281900000000', 'Halo, saya Wisnu. Boleh telepon?');
    expect(store.getLead(r.leadId).escalated).toBe(false);
    expect(store.messages(r.leadId).at(-1)).toMatchObject({ direction: 'out', auto: false });
    await expect(svc.ownerReply(999, 'x')).rejects.toThrow(/tidak ditemukan/);
    await expect(svc.ownerReply(r.leadId, ' ')).rejects.toThrow(/kosong/);
  });

  it('kanal yang belum bisa mengirim: dicatat, bukan error', async () => {
    const { svc } = make();
    const r = await svc.intake({ source: 'site', contact: 'a@b.co', text: 'butuh website' });
    expect(await svc.ownerReply(r.leadId, 'Halo')).toEqual({ sent: false });
  });

  it('setStatus: menang dengan nilai dicatat dan masuk laporan harian', async () => {
    const { svc, store } = make({ env: { SALES_AUTO_REPLY: 'on' } });
    const r = await svc.intake({ source: 'whatsapp', contact: '081910000000', text: HOT });
    expect(svc.reportLines({ since: NOON - 86_400_000 })).toEqual(['Klien: 1 prospek baru']);
    svc.setStatus(r.leadId, 'won', { value: 6_500_000 });
    expect(store.getLead(r.leadId)).toMatchObject({ status: 'won', value_idr: 6_500_000, escalated: false });
    expect(svc.reportLines({ since: NOON - 86_400_000 })).toEqual(['Klien: 1 prospek baru', 'Deal: 1 proyek (Rp6.500.000)']);
    expect(make().svc.reportLines({ since: 0 })).toEqual([]); // hari sepi = tidak ada baris
  });

  it('normalizeContact', () => {
    expect(normalizeContact('0812-3456-7890')).toBe('6281234567890');
    expect(normalizeContact('+62 812 3456 7890')).toBe('6281234567890');
    expect(normalizeContact('Budi@Contoh.ID')).toBe('budi@contoh.id');
  });
});

// ------------------------------------------------------------------ HTTP

describe('HTTP /api/sales (pemilik)', () => {
  async function app() {
    const m = make({ env: { SALES_AUTO_REPLY: 'on' } });
    await m.svc.intake({ source: 'whatsapp', contact: '082000000000', name: 'Sari', text: HOT });
    return { ...m, http: express().use('/api/sales', createSalesRouter({ sales: m.svc })) };
  }

  it('ringkasan, daftar, detail, status, balas', async () => {
    const { http, svc } = await app();
    const sum = (await request(http).get('/api/sales/summary')).body;
    expect(sum).toMatchObject({ autoReply: true, catalog: { services: 6, pricesApproved: 0, termsApproved: false } });
    expect(sum.stats.open).toBe(1);
    const list = (await request(http).get('/api/sales/leads').query({ open: '1' })).body;
    expect(list.total).toBe(1);
    const id = list.leads[0].id;
    const detail = (await request(http).get(`/api/sales/leads/${id}`)).body;
    expect(detail.messages).toHaveLength(2);
    expect((await request(http).get('/api/sales/leads/9999')).status).toBe(404);
    expect((await request(http).get('/api/sales/leads').query({ status: 'hack' })).status).toBe(400);
    expect((await request(http).post(`/api/sales/leads/${id}/status`).send({ status: 'pwned' })).status).toBe(400);
    expect((await request(http).post(`/api/sales/leads/${id}/status`).send({ status: 'proposal', notes: 'kirim penawaran' })).body.lead.status).toBe('proposal');
    expect((await request(http).post(`/api/sales/leads/${id}/reply`).send({ text: 'Halo' })).body).toMatchObject({ ok: true, sent: false });
    expect((await request(http).post(`/api/sales/leads/${id}/reply`).send({ text: '' })).status).toBe(400);
    void svc;
  });

  it('katalog: lihat, ubah, setujui', async () => {
    const { http } = await app();
    const cat = (await request(http).get('/api/sales/catalog')).body;
    expect(cat.services[0].match).toBeUndefined(); // regex tidak bocor ke klien
    expect((await request(http).put('/api/sales/catalog/landing').send({ price: { min: 2_000_000, max: 5_000_000 } })).body.service.price.approved).toBe(false);
    expect((await request(http).put('/api/sales/catalog/landing').send({ price: { min: 1, max: 2 } })).status).toBe(400);
    expect((await request(http).post('/api/sales/catalog/approve').send({ ids: ['landing'] })).body).toMatchObject({ ok: true, approved: 1 });
  });

  it('lewat proxy tanpa token ditolak', async () => {
    const { svc } = make();
    const guarded = express().use('/api/sales', createSalesRouter({ sales: svc, env: { AUTOMATION_TOKEN: 'rahasia-uji-123456' } }));
    expect((await request(guarded).get('/api/sales/summary').set('X-Forwarded-For', '203.0.113.9')).status).toBe(401);
    expect((await request(guarded).get('/api/sales/summary').set('X-Forwarded-For', '203.0.113.9').set('X-Automation-Token', 'rahasia-uji-123456')).status).toBe(200);
  });
});

describe('HTTP /webhook/inquiry (formulir di situs pemilik)', () => {
  const SECRET = 'intake-secret-uji-123456';
  const sig = (raw, secret = SECRET, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
  const build = (env = { SALES_INTAKE_SECRET: SECRET }, now = Date.now) => {
    const m = make();
    return { ...m, http: express().use('/webhook/inquiry', createInquiryRouter({ sales: m.svc, env, now })) };
  };
  const post = (http, body, s) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return request(http).post('/webhook/inquiry').set('Content-Type', 'application/json').set('x-wanar-signature', s ?? sig(raw)).send(raw);
  };

  it('tanpa rahasia = 503; tanda tangan salah/basi = 401', async () => {
    const off = build({});
    expect((await post(off.http, { contact: 'a@b.co', message: 'butuh website' })).status).toBe(503);
    const { http } = build();
    const body = { contact: 'a@b.co', message: 'butuh website' };
    expect((await post(http, body, 't=1,v1=00')).status).toBe(401);
    expect((await post(http, body, sig(JSON.stringify(body), 'rahasia-lain'))).status).toBe(401);
    expect((await post(http, body, sig(JSON.stringify(body), SECRET, 1700000000))).status).toBe(401);
  });

  it('permintaan sah: dibalas langsung & tercatat sebagai prospek', async () => {
    const { http, store } = build();
    const res = await post(http, { name: 'Budi', contact: 'budi@contoh.id', message: 'Halo, butuh website toko online untuk jualan parfum, budget 6 juta' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, escalate: false });
    expect(res.body.reply).toContain('asisten AI');
    expect(store.listLeads().total).toBe(1);
    expect(Object.keys(res.body).sort()).toEqual(['escalate', 'ok', 'reply']); // tidak membocorkan data internal
  });

  it('honeypot terisi: pura-pura berhasil tetapi tidak membuat prospek', async () => {
    const { http, store } = build();
    const res = await post(http, { contact: 'bot@spam.co', message: 'butuh website', website: 'http://spam.co' });
    expect(res.body).toMatchObject({ ok: true, reply: null });
    expect(store.listLeads().total).toBe(0);
  });

  it('input tidak lengkap/rusak = 400; terlalu sering dari satu IP = 429', async () => {
    const { http } = build();
    expect((await post(http, { contact: '', message: 'butuh website' })).status).toBe(400);
    expect((await post(http, { contact: 'a@b.co', message: 'hai' })).status).toBe(400);
    expect((await post(http, '{ bukan json')).status).toBe(400);
    let last;
    for (let i = 0; i < 14; i += 1) last = await post(http, { contact: `x${i}@b.co`, message: 'butuh website toko online' });
    expect(last.status).toBe(429);
  });
});

// ------------------------------------------------------------------ Telegram

describe('quickSales (perintah pemilik)', () => {
  async function seeded() {
    const m = make({ env: { SALES_AUTO_REPLY: 'on' }, senders: { whatsapp: vi.fn(async () => {}) } });
    const r = await m.svc.intake({ source: 'whatsapp', contact: '082100000000', name: 'Sari', text: HOT });
    return { ...m, id: r.leadId };
  }

  it('daftar kosong lalu terisi, dan detail dengan percakapan', async () => {
    const empty = make();
    expect(await quickSales(empty.svc, 'prospek')).toMatch(/Belum ada prospek/);
    const { svc, id } = await seeded();
    const list = await quickSales(svc, 'prospek');
    expect(list).toContain(`#${id}`);
    expect(list).toContain('Website toko online');
    const detail = await quickSales(svc, `prospek ${id}`);
    expect(detail).toContain('Sari');
    expect(detail).toContain('Anggaran: Rp6.000.000');
    expect(detail).toContain('Calon klien');
    expect(detail).toContain('Agent');
    expect(await quickSales(svc, 'prospek 999')).toMatch(/tidak ditemukan/);
  });

  it('mengubah status, menang dengan nilai, dan membalas prospek', async () => {
    const { svc, store, id, senders } = await seeded();
    expect(await quickSales(svc, `prospek ${id} nego`)).toMatch(/negosiasi/);
    expect(await quickSales(svc, `prospek ${id} menang 6,5jt`)).toMatch(/menang, nilai Rp6\.500\.000/);
    expect(store.getLead(id).value_idr).toBe(6_500_000);
    expect(await quickSales(svc, `balas prospek ${id}: Halo Sari, terima kasih. Kita mulai Senin ya`)).toBe(`Terkirim ke prospek #${id}.`);
    expect(senders.whatsapp).toHaveBeenCalledWith('6282100000000', 'Halo Sari, terima kasih. Kita mulai Senin ya');
  });

  it('setujui harga, atur harga, daftar layanan', async () => {
    const { svc } = make();
    expect(await quickSales(svc, 'daftar layanan')).toMatch(/BELUM disetujui/);
    expect(await quickSales(svc, 'atur harga webapp 10jt - 30jt')).toMatch(/Rp10 juta - Rp30 juta dan disetujui/);
    expect(svc.catalog().services.find((s) => s.id === 'webapp').price).toMatchObject({ min: 10_000_000, max: 30_000_000, approved: true });
    expect(await quickSales(svc, 'atur harga toko 5jt sampai 15jt')).toMatch(/Website toko online/);
    expect(await quickSales(svc, 'atur harga webapp abc - xyz')).toMatch(/belum terbaca/);
    expect(await quickSales(svc, 'setujui harga dan syarat pembayaran')).toMatch(/beserta syarat pembayaran/);
    expect(svc.catalog().terms.approved).toBe(true);
    expect(await quickSales(svc, 'setujui harga')).toMatch(/sudah disetujui sebelumnya/);
    expect(await quickSales(svc, 'daftar layanan')).not.toMatch(/BELUM disetujui/);
  });

  it('kalimat biasa TIDAK dibajak', async () => {
    const { svc } = await seeded();
    for (const q of [
      'buatkan website toko online untuk saya', 'harga bitcoin hari ini', 'prospek cerah tahun ini', 'klien saya minta revisi desain',
      'balas email dari klien itu', 'halo', '', 'layanan pelanggan jelek banget', 'setujui saja proposalnya', 'x'.repeat(2000),
    ]) expect(await quickSales(svc, q), q).toBeNull();
  });
});
