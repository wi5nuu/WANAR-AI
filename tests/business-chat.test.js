/**
 * Test Suite: obrolan Telegram yang MENGENAL bisnis — pemilik bertanya "hasil pencarian?", "lanjut cari klien",
 * "Asmi laundry nanya tarif" dan jawabannya harus dari data nyata radar, bukan "saya tidak bisa keliling internet"
 * atau harga karangan. Termasuk: blok bisnis di prompt model, pencarian nama usaha (toleran satu salah ketik),
 * "peluang lagi", dan tidak membajak kalimat biasa.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

import { normOsm } from '../src/sales/prospects/sources.js';
import { scoreProspect } from '../src/sales/prospects/score.js';
import { ProspectStore, createProspects } from '../src/sales/prospects/service.js';
import { defaultCatalog } from '../src/sales/catalog.js';
import { SalesStore } from '../src/sales/store.js';
import { createSales } from '../src/sales/service.js';
import { quickSales } from '../src/sales/quick.js';
import { salesPromptLines } from '../src/sales/prompt.js';
import { makeAssistantResponder } from '../src/worklog/assistant.js';

const NOON = Date.parse('2026-10-17T05:00:00Z'); // 12.00 WIB
const FACTS = { en: { personalInfo: { name: 'Wisnu Alfian Nur Ashar', location: 'Bekasi, Indonesia', website: 'https://contoh.my.id', github: 'https://github.com/wi5nuu' }, skills: { programming: ['PHP'], webTech: ['React'], aiMl: [], securityCloud: [], tools: [], soft: [] }, experience: [], projects: [] }, id: null };
const bad = (re, s) => !re.test(s);

function make({ approve = false } = {}) {
  let clock = NOON;
  const db = new Database(':memory:');
  db.exec('CREATE TABLE agent_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL DEFAULT \'info\', title TEXT NOT NULL, detail TEXT, ref TEXT)');
  const log = (e) => db.prepare('INSERT INTO agent_activity (ts, agent, kind, level, title, detail, ref) VALUES (?,?,?,?,?,?,?)').run(clock, e.agent || 'system', e.kind || 'info', e.level || 'info', e.title, e.detail || null, e.ref || null);
  const notify = vi.fn(async () => {});
  const store = new ProspectStore(db, { now: () => clock });
  const pr = createProspects({ store, getCatalog: defaultCatalog, getFacts: () => FACTS, notify, ownerChat: () => '55555', log, now: () => clock, env: { CAREER_TELEGRAM: 'on', SALES_LOCAL_AREAS: 'Bekasi', SALES_OSM_DELAY_MS: '0' } });
  const sales = createSales({ store: new SalesStore(db, { now: () => clock }), getFacts: () => FACTS, log, env: {}, now: () => clock });
  if (approve) sales.approvePrices();
  sales.prospects = pr;
  const add = (name, o = {}) => {
    const p = normOsm({ type: 'node', id: Math.floor(Math.random() * 1e9), tags: { name, amenity: 'restaurant', phone: '0812 3456 7890', ...o } });
    const s = scoreProspect(p, defaultCatalog(), FACTS, { now: clock });
    return store.upsert(p, s).id;
  };
  return { db, pr, sales, store, notify, add, log, tick: (ms) => { clock += ms; } };
}

// ------------------------------------------------------------------ pencarian nama usaha

describe('ProspectService.findByName', () => {
  it('menemukan usaha yang sudah dikirim ke pemilik, toleran satu salah ketik (Asmi ~ Azmi)', () => {
    const { pr, add, store } = make();
    const id = add('Azmi Laundry Harapan Indah Bekasi (Bisa Kiloan - Antar Jemput)', { amenity: undefined, shop: 'laundry' });
    store.markPushed([id]);
    expect(pr.findByName('Eh asmi laundry tadi nanyain tarifnya berapa?')?.id).toBe(id);
    expect(pr.findByName('azmi bilang mau lihat contoh')?.id).toBe(id);
  });

  it('kata umum saja (laundry, toko, Bekasi) tidak cukup untuk mengenali usaha', () => {
    const { pr, add, store } = make();
    store.markPushed([add('Azmi Laundry Bekasi', { amenity: undefined, shop: 'laundry' }), add('Sinar Laundry Bekasi', { amenity: undefined, shop: 'laundry' })]);
    expect(pr.findByName('laundry di bekasi tadi nanya harga')).toBeNull();
  });

  it('dua usaha sama-sama cocok = ragu (null), bukan menebak; usaha yang belum pernah dikirim tidak dikenali', () => {
    const { pr, add, store } = make();
    store.markPushed([add('Kedai Mawar Sejahtera'), add('Warung Mawar Indah')]);
    expect(pr.findByName('mawar nanya tarif')).toBeNull();
    add('Bakmi Kenanga'); // belum dikirim ke pemilik (status baru, tanpa pushed_at)
    expect(pr.findByName('kenanga nanya tarif')).toBeNull();
  });

  it('kata di bawah 4 huruf diabaikan; nama yang tidak ada = null', () => {
    const { pr, add, store } = make();
    store.markPushed([add('Dapur Ibu Ani')]);
    expect(pr.findByName('ani nanya')).toBeNull();
    expect(pr.findByName('budi nanya tarif')).toBeNull();
    expect(pr.findByName('')).toBeNull();
  });
});

// ------------------------------------------------------------------ ringkasan & peluang lagi

describe('overview & peluang lagi', () => {
  it('overviewText: angka nyata, jadwal otomatis, dan pernyataan bahwa agent tidak menghubungi klien', () => {
    const { pr, add } = make();
    add('Kedai Satu'); add('Kafe Dua', { amenity: 'cafe' });
    const t = pr.overviewText();
    expect(t).toContain('jalan otomatis setiap hari');
    expect(t).toMatch(/2 peluang terdata: 2 usaha lokal/);
    expect(t).toContain('Freelancer.com dipindai tiap 6 jam');
    expect(t).toContain('Bekasi');
    expect(t).toContain('tidak menghubungi calon klien sendiri');
    expect(t).toContain('"peluang lagi"');
  });

  it('morningBatch dipaksa + jumlah: mengirim sebanyak diminta (maks 15), tidak menandai "hari ini sudah"', async () => {
    const { pr, add, notify } = make();
    for (let i = 0; i < 20; i += 1) add(`Usaha Nomor ${i}`);
    expect(await pr.morningBatch({ force: true, count: 3 })).toBe(3);
    expect(notify.mock.calls[0][1]).toMatch(/^Siap, Mas\. Ini 3 usaha lokal/);
    expect(notify.mock.calls[0][1]).toContain('(tambahan)');
    expect(await pr.morningBatch({ force: true, count: 99 })).toBe(15); // batas keras
    // paket pagi terjadwal tidak terganggu: aktivitas tambahan tidak dihitung sebagai paket pagi
    expect(pr._doneToday('outreach_batch')).toBe(false);
    expect(pr._doneToday('outreach_extra')).toBe(true);
  });
});

// ------------------------------------------------------------------ perintah bahasa biasa

describe('quickSales: bahasa sehari-hari', () => {
  it('"lanjut cari klien": memindai sekarang DAN menjelaskan bahwa radar sudah jalan tiap hari (bukan "tidak bisa cari")', async () => {
    const m = make();
    m.add('Kedai Satu');
    const scan = vi.spyOn(m.pr, 'scan').mockResolvedValue({});
    for (const q of ['tolong lanjut cari orang yang butuh website', 'lanjut cari ratusan klien tanpa stop', 'cari klien', 'carikan calon klien untuk saya', 'cari orang yang butuh web']) {
      scan.mockClear();
      const r = await quickSales(m.sales, q);
      expect(r, q).toContain('sudah mencari sendiri setiap hari');
      expect(r, q).toMatch(/1 peluang terdata/);
      expect(scan, q).toHaveBeenCalledTimes(1);
      expect(r, q).not.toMatch(/tidak bisa (?:mencari|keliling)/i);
    }
  });

  it('"hasilnya mana?": angka nyata radar + daftar terbaik', async () => {
    const m = make();
    m.add('Kedai Satu'); m.add('Kafe Dua', { amenity: 'cafe' });
    for (const q of ['hasil pencarian kamu mana?', 'apa yang kamu temukan?', 'sudah dapat berapa klien', 'berapa klien yang kamu temukan', 'mana hasil radar']) {
      const r = await quickSales(m.sales, q);
      expect(r, q).toMatch(/2 peluang terdata: 2 usaha lokal/);
      expect(r, q).toContain('Usaha lokal tanpa website:');
    }
  });

  it('"peluang lagi" / "kirim 5 peluang": mengirim tambahan sekarang dan mengonfirmasi', async () => {
    const m = make();
    for (let i = 0; i < 7; i += 1) m.add(`Usaha Nomor ${i}`);
    const r = await quickSales(m.sales, 'kirim 5 peluang');
    expect(r).toMatch(/^Itu 5 usaha tambahan/);
    expect(m.notify.mock.calls.length).toBe(6); // 1 pengantar + 5 pesan
    expect(await quickSales(m.sales, 'peluang lagi')).toMatch(/^Itu 2 usaha tambahan/);
    expect(await quickSales(m.sales, 'peluang lagi')).toMatch(/Belum ada usaha lokal baru/);
  });

  it('"Asmi laundry tadi nanyain tarifnya": menandai membalas, maksud harga, saran dari katalog — TANPA angka bila harga belum disetujui', async () => {
    const m = make();
    const id = m.add('Azmi Laundry Harapan Indah Bekasi', { amenity: undefined, shop: 'laundry' });
    m.store.markPushed([id]);
    const r = await quickSales(m.sales, 'Eh asmi laundry tadi nanyain tarifnya berapa?');
    expect(r).toContain(`Itu Peluang #${id}: Azmi Laundry Harapan Indah Bekasi.`);
    expect(r).toContain('Maksud pesannya: bertanya harga');
    expect(r).toContain('Saran balasan:');
    expect(r).toContain('Angka pastinya bergantung');
    expect(bad(/Rp\s?\d/, r)).toBe(true); // tidak mengarang angka
    expect(m.store.get(id).status).toBe('replied');
  });

  it('harga disetujui: saran memuat kisaran dari katalog dan petunjuk menurunkan tarif untuk usaha kecil', async () => {
    const m = make({ approve: true });
    const id = m.add('Azmi Laundry Bekasi', { amenity: undefined, shop: 'laundry' });
    m.store.markPushed([id]);
    const r = await quickSales(m.sales, 'azmi laundry nanya tarif');
    expect(r).toContain('Rp1,5 juta - Rp4 juta');
    expect(r).toContain('atur harga landing 750rb - 2jt');
    // pemilik mengatur tarif sendiri -> saran berikutnya memakai angka baru
    await quickSales(m.sales, 'atur harga landing 750rb - 2jt');
    m.store.setStatus(id, 'contacted');
    expect(await quickSales(m.sales, 'azmi laundry nanya tarif')).toContain('Rp750 ribu - Rp2 juta');
  });

  it('usaha yang minta menawar harga: ditandai perlu pemilik', async () => {
    const m = make({ approve: true });
    const id = m.add('Azmi Laundry Bekasi', { amenity: undefined, shop: 'laundry' });
    m.store.markPushed([id]);
    const r = await quickSales(m.sales, 'azmi laundry bilang terlalu mahal, minta nego');
    expect(r).toContain('Maksud pesannya: menawar harga');
    expect(r).toContain('Mas sendiri yang menjawab');
  });

  it('kalimat biasa TIDAK dibajak (diteruskan ke model)', async () => {
    const m = make();
    const id = m.add('Azmi Laundry Bekasi', { amenity: undefined, shop: 'laundry' });
    m.store.markPushed([id]);
    for (const q of [
      'cari orang tua saya di rumah sakit', 'cari resep nasi goreng', 'cari lowongan kerja', 'carikan saya hotel di Bandung',
      'azmi laundry itu di jalan apa ya', 'tadi saya nanya tarif parkir ke satpam', 'berapa harga bitcoin sekarang', 'hasil pertandingan semalam',
      'budi nanya tarif website', 'peluang bisnis apa yang bagus', 'apa yang kamu pikirkan',
    ]) expect(await quickSales(m.sales, q), q).toBeNull();
  });
});

// ------------------------------------------------------------------ prompt model

describe('salesPromptLines (apa yang diketahui model obrolan)', () => {
  it('memuat fakta radar, larangan mengarang harga, dan hanya harga yang disetujui', () => {
    const m = make({ approve: true });
    const id = m.add('Azmi Laundry Bekasi', { amenity: undefined, shop: 'laundry' });
    m.store.markPushed([id]);
    const p = salesPromptLines({ sales: m.sales }).join('\n');
    expect(p).toContain('BISNIS & KLIEN');
    expect(p).toContain('BEKERJA OTOMATIS setiap hari');
    expect(p).toContain('JANGAN pernah bilang kamu tidak bisa mencari klien');
    expect(p).toContain('BUKAN terkirim ke klien');
    expect(p).toContain(`#${id} Azmi Laundry Bekasi (new)`);
    expect(p).toContain('Landing page / Company profile: Rp1,5 juta - Rp4 juta');
    expect(p).toContain('JANGAN mengarang angka pasar sendiri');
    expect(p).toContain('atur harga landing 750rb - 2jt');
  });

  it('tanpa harga disetujui: dilarang menyebut angka; tanpa meja penjualan: kosong; rusak: tidak melempar', () => {
    const m = make();
    expect(salesPromptLines({ sales: m.sales }).join('\n')).toContain('Belum ada harga yang disetujui pemilik. JANGAN menyebut angka harga');
    expect(salesPromptLines({ sales: null })).toEqual([]);
    m.pr.overview = () => { throw new Error('boom'); };
    expect(() => salesPromptLines({ sales: m.sales })).not.toThrow();
  });
});

describe('asisten Telegram (model) mengenal bisnis', () => {
  const worklog = {
    today: () => '2026-10-17', getSettings: () => ({ workStart: '08:00', workEnd: '17:00', breakStart: '12:00', breakEnd: '13:00', workdays: [1, 2, 3, 4, 5] }),
    listReminders: () => [],
  };
  const ai = (reply = 'Siap, Mas.') => {
    const calls = [];
    return { calls, async *chatStream(messages, opts) { calls.push({ messages, opts }); yield { type: 'content', content: JSON.stringify({ reply, actions: [] }) }; yield { type: 'done' }; } };
  };

  it('pertanyaan umum ke model: prompt memuat blok bisnis nyata (bukan "saya tidak bisa mencari")', async () => {
    const m = make({ approve: true });
    m.add('Kedai Satu');
    const model = ai('Radar sudah mencari sendiri, Mas.');
    const respond = makeAssistantResponder({ aiManager: model, worklog, sales: m.sales });
    const out = await respond({ text: 'kenapa kamu tidak bekerja mencari klien setiap hari?', chatId: '55555' });
    expect(out).toContain('Radar sudah mencari sendiri');
    expect(model.calls).toHaveLength(1);
    const sys = model.calls[0].opts.systemPrompt;
    expect(sys).toContain('BISNIS & KLIEN');
    expect(sys).toMatch(/1 peluang \(1 usaha lokal cocok/);
    expect(sys).toContain('JANGAN mengarang angka pasar sendiri');
  });

  it('"hasilnya mana?" dan "Asmi laundry nanya tarif" dijawab KODE: model tidak dipanggil sama sekali', async () => {
    const m = make({ approve: true });
    const id = m.add('Azmi Laundry Bekasi', { amenity: undefined, shop: 'laundry' });
    m.store.markPushed([id]);
    const model = { chatStream() { throw new Error('model tidak boleh dipanggil'); } };
    const respond = makeAssistantResponder({ aiManager: model, worklog, sales: m.sales });
    expect(await respond({ text: 'hasil pencarian kamu mana?', chatId: '55555' })).toMatch(/1 peluang terdata/);
    expect(await respond({ text: 'Eh asmi laundry tadi nanyain tarifnya berapa?', chatId: '55555' })).toContain(`Peluang #${id}`);
  });
});
