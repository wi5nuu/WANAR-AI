/**
 * Test Suite: mesin percakapan penjualan — membaca maksud pesan calon klien dan menjawabnya dengan
 * kalimat tetap dari katalog yang disetujui pemilik. Yang diuji terutama: tidak pernah menjanjikan,
 * tidak pernah menyebut harga yang belum disetujui, tidak pernah menawarkan diskon, dan menyerahkan ke
 * pemilik tepat di momen yang menentukan penjualan.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

import { classifyReply, converse } from '../src/sales/intent.js';
import { defaultCatalog } from '../src/sales/catalog.js';
import { SalesStore } from '../src/sales/store.js';
import { createSales } from '../src/sales/service.js';

const FACTS = { en: {
  personalInfo: { name: 'Wisnu Alfian Nur Ashar', website: 'https://contoh.my.id', github: 'https://github.com/wi5nuu', email: 'wisnu@contoh.id' },
  projects: [{ title: 'Ashar Grosir Parfum', status: 'Production', description: 'Official E-Commerce platform serving 15,000+ partners. Optimized for scale.' }],
} };
const NOON = Date.parse('2026-10-16T05:00:00Z');
const FORBIDDEN = /(dijamin|pasti\s+(?:selesai|jadi|untung)|garansi\s+(?:uang|100)|100\s*%|diskon\s+\d|potongan|gratis)/i;

const cat = (approve = false) => {
  const c = defaultCatalog();
  if (approve) { c.services.forEach((s) => { s.price.approved = true; }); c.terms.approved = true; }
  return c;
};
const ecommerce = (c) => c.services.find((s) => s.id === 'ecommerce');
const talk = (text, o = {}) => { const c = o.catalog || cat(o.approved); return converse({ text, name: o.name || '', service: o.service === undefined ? ecommerce(c) : o.service, catalog: c, facts: FACTS, repliesSoFar: o.n || 0 }); };

describe('classifyReply', () => {
  it('maksud utama dikenali dari kalimat sehari-hari', () => {
    const cases = {
      stop: ['stop', 'maaf tidak tertarik', 'nggak jadi deh', 'jangan hubungi saya lagi', 'no thanks', 'batalkan saja'],
      ready: ['deal, lanjut', 'oke setuju', 'kapan bisa mulai?', 'saya mau order', 'boleh mulai besok', 'rekening nya mana?', "let's go", 'siap lanjut kak'],
      haggle: ['terlalu mahal nih', 'bisa nego?', 'ada diskon?', 'budget saya cuma 2 juta', 'too expensive', 'bisa kurang ga?'],
      call: ['bisa telepon?', 'kita zoom aja', 'bisa ketemu minggu ini', 'hubungi saya ya'],
      trust: ['ada garansi?', 'ini aman ga?', 'jangan-jangan penipuan', 'is this a scam', 'bisa refund?'],
      price: ['berapa harganya?', 'estimasi biayanya?', 'kisaran tarif berapa', 'how much would it cost'],
      timeline: ['berapa lama pengerjaannya?', 'kapan selesai?', 'how long does it take'],
      proof: ['ada contoh karya?', 'boleh lihat portofolio', 'pernah bikin yang mirip?', 'any previous work'],
      ack: ['ok', 'siap', 'terima kasih', 'thanks', 'noted', '👍'],
      brief: ['katalognya sekitar 200 produk dan perlu pembayaran online', 'saya punya toko parfum di Bekasi'],
    };
    for (const [want, list] of Object.entries(cases)) for (const t of list) expect(classifyReply(t), `${want}: ${t}`).toBe(want);
  });

  it('prioritas: stop mengalahkan segalanya; menawar mengalahkan bertanya harga', () => {
    expect(classifyReply('tidak jadi, terlalu mahal')).toBe('stop');
    expect(classifyReply('harganya terlalu mahal, bisa nego?')).toBe('haggle');
  });

  it('"kapan mulai" di tengah brief panjang bukan lampu hijau pembayaran', () => {
    const long = 'Saya punya toko parfum dengan 200 produk, ingin katalog online dan pembayaran, referensi saya mirip toko-toko besar, desain yang bersih dan modern dengan warna emas, dan kapan mulai itu belum saya pikirkan karena saya masih membandingkan beberapa penyedia jasa dulu';
    expect(long.length).toBeGreaterThan(160);
    expect(classifyReply(long)).not.toBe('ready');
    expect(classifyReply(`${long} jadi deal saja`)).toBe('ready'); // sinyal eksplisit tetap dikenali
  });

  it('kosong = ack', () => { expect(classifyReply('')).toBe('ack'); expect(classifyReply('   ')).toBe('ack'); });
});

describe('converse: jawaban per maksud', () => {
  it('siap lanjut: diserahkan ke pemilik SEKARANG, panas, dan meminta ringkasan kebutuhan', () => {
    const r = talk('oke deal, kapan bisa mulai?');
    expect(r).toMatchObject({ intent: 'ready', escalate: true, hot: true, close: false });
    expect(r.reasons[0]).toMatch(/siap lanjut/);
    expect(r.text).toContain('Saya teruskan ke Wisnu sekarang');
    expect(r.text).toMatch(/ringkasan kebutuhan/);
  });

  it('menawar harga: tidak pernah menawarkan diskon atau angka; hanya pemilik yang memutuskan', () => {
    const r = talk('terlalu mahal, bisa nego?', { approved: true });
    expect(r).toMatchObject({ intent: 'haggle', escalate: true, hot: true });
    expect(r.text).toContain('diputuskan langsung oleh Wisnu');
    expect(r.text).not.toMatch(/Rp\s?\d/);
    expect(r.text).not.toMatch(FORBIDDEN);
  });

  it('stop: menutup dengan sopan, tidak lagi menghubungi, tidak meminta apa pun', () => {
    const r = talk('maaf tidak tertarik');
    expect(r).toMatchObject({ intent: 'stop', close: true, escalate: false });
    expect(r.text).toContain('tidak akan menghubungi lagi');
    expect(r.text).not.toContain('?');
  });

  it('harga: kisaran bila disetujui; bila belum, TIDAK ada angka rupiah dan meminta kebutuhan', () => {
    const no = talk('berapa harganya?');
    expect(no.text).not.toMatch(/Rp\s?\d/);
    expect(no.text).toContain('Angka pastinya bergantung');
    expect(no.text).toContain('Supaya penawarannya tepat');
    const yes = talk('berapa harganya?', { approved: true });
    expect(yes.text).toContain('Rp4 juta - Rp12 juta');
    expect(yes.text).toContain('Pembayaran: DP di awal');
    expect(yes.text).not.toMatch(FORBIDDEN);
  });

  it('lama pengerjaan: rentang hari bila disetujui, kalau belum "bergantung lingkup"', () => {
    expect(talk('berapa lama pengerjaannya?', { approved: true }).text).toContain('14-35 hari kerja');
    const no = talk('berapa lama pengerjaannya?');
    expect(no.text).not.toMatch(/\d+-\d+ hari/);
    expect(no.text).toContain('bergantung pada lingkup');
  });

  it('contoh karya: dikutip dari portofolio pemilik, plus tautan', () => {
    const r = talk('boleh lihat contoh karya?');
    expect(r.text).toContain('Ashar Grosir Parfum (Production): Official E-Commerce platform serving 15,000+ partners.');
    expect(r.text).toContain('https://contoh.my.id');
    expect(r.text).toContain('GitHub: https://github.com/wi5nuu');
  });

  it('keraguan/garansi: jujur tanpa janji; hanya tuduhan penipuan yang diteruskan ke pemilik', () => {
    const g = talk('ada garansi nggak?');
    expect(g.text).toContain('tidak bisa menjanjikan hasil tertentu');
    expect(g.escalate).toBe(false);
    expect(g.text).not.toMatch(FORBIDDEN);
    expect(talk('jangan-jangan ini penipuan').escalate).toBe(true);
  });

  it('minta telepon: diteruskan, menanyakan waktu dan kanal', () => {
    const r = talk('bisa telepon sebentar?');
    expect(r).toMatchObject({ intent: 'call', escalate: true });
    expect(r.text).toMatch(/Kapan waktu yang nyaman/);
  });

  it('berbagi detail: berterima kasih lalu menanyakan SATU pertanyaan berikutnya yang berbeda tiap giliran, dan di giliran kedua menyebut Wisnu akan menghubungi', () => {
    const q = ecommerce(cat()).questions;
    const first = talk('katalognya sekitar 200 produk', { n: 0 });
    const second = talk('pembayarannya transfer bank saja', { n: 1 });
    expect(first.text).toContain('sudah saya catat');
    expect(first.text).toContain(q[0]);
    expect(second.text).toContain(q[1]);
    expect(first.text).not.toContain('Wisnu akan meninjau');
    expect(second.text).toContain('Wisnu akan meninjau dan menghubungi Anda langsung');
    expect(first.escalate).toBe(false);
  });

  it('ack singkat; tanpa layanan yang dikenali tetap bertanya balik, tidak error', () => {
    expect(talk('ok').text.length).toBeLessThan(120);
    const r = talk('saya mau tanya soal usaha saya', { service: null });
    expect(r.text).toContain('Boleh ceritakan');
  });

  it('bahasa Inggris dijawab bahasa Inggris', () => {
    const r = talk('How much would it cost? We need an online shop for our products.', { approved: true });
    expect(r.intent).toBe('price');
    expect(r.text).toMatch(/typical range is Rp4 juta - Rp12 juta/);
    expect(r.text).not.toMatch(/Terima kasih|Pembayaran/);
  });

  it('tidak satu pun jawaban mengandung janji/jaminan/diskon, dari semua maksud', () => {
    const msgs = ['deal lanjut', 'terlalu mahal', 'stop', 'berapa harganya', 'berapa lama', 'ada contoh', 'ada garansi?', 'bisa telepon', 'ok', 'saya punya toko parfum'];
    for (const approved of [false, true]) for (const m of msgs) expect(talk(m, { approved }).text, m).not.toMatch(FORBIDDEN);
  });

  it('jawaban tanpa harga disetujui tidak pernah memuat angka rupiah, apa pun maksudnya', () => {
    for (const m of ['deal lanjut', 'terlalu mahal', 'berapa harganya', 'berapa lama', 'ada contoh', 'ada garansi?', 'bisa telepon', 'saya punya toko parfum']) {
      expect(talk(m).text, m).not.toMatch(/Rp\s?\d/);
    }
  });
});

// ------------------------------------------------------------------ dalam alur penerimaan pesan

function make({ env = {}, notify = vi.fn(async () => {}) } = {}) {
  let clock = NOON;
  const store = new SalesStore(new Database(':memory:'), { now: () => clock });
  const svc = createSales({ store, getFacts: () => FACTS, notify, ownerChat: () => '55555', log: () => {}, now: () => clock, env: { CAREER_TELEGRAM: 'on', SALES_AUTO_REPLY: 'on', ...env } });
  return { svc, store, notify, tick: (ms) => { clock += ms; } };
}
const say = (svc, text, who = '081555000111') => svc.intake({ source: 'whatsapp', contact: who, name: 'Rina', text });

describe('percakapan sampai deal (lewat SalesService.intake)', () => {
  it('perjalanan penuh: tanya -> brief -> tanya harga -> siap lanjut; pemilik diberi tahu tepat saat siap', async () => {
    const { svc, store, notify } = make();
    const a = await say(svc, 'Halo, saya butuh website toko online untuk jualan parfum');
    expect(a.reply).toContain('asisten AI');
    const b = await say(svc, 'katalognya sekitar 200 produk, bayar lewat transfer');
    expect(b.reply).toContain('sudah saya catat');
    const c = await say(svc, 'kira-kira berapa biayanya?');
    expect(c.reply).toContain('Angka pastinya bergantung'); // harga belum disetujui
    const notifiedBefore = notify.mock.calls.length;
    const d = await say(svc, 'oke deal, kapan bisa mulai?');
    expect(d).toMatchObject({ escalate: true, hot: true });
    expect(d.reply).toContain('Saya teruskan ke Wisnu sekarang');
    expect(notify.mock.calls.length).toBe(notifiedBefore + 1); // diberi tahu SAAT siap, walau sebelumnya sudah pernah
    expect(notify.mock.calls.at(-1)[1]).toMatch(/siap lanjut/);
    const lead = store.getLead(d.leadId);
    expect(lead).toMatchObject({ escalated: true, status: 'contacted' });
    expect(store.messages(lead.id).filter((m) => m.direction === 'out').length).toBe(4);
  });

  it('menawar harga: pemilik langsung diberi tahu, agent tidak menawarkan diskon', async () => {
    const { svc, notify } = make();
    await say(svc, 'butuh website company profile, budget 3 juta');
    const r = await say(svc, 'terlalu mahal, bisa kurang?');
    expect(r.escalate).toBe(true);
    expect(r.reply).not.toMatch(/Rp\s?\d|diskon \d|potongan/i);
    expect(notify.mock.calls.at(-1)[1]).toMatch(/menawar harga/);
  });

  it('"tidak tertarik": prospek ditutup (kalah), tidak ada pemberitahuan ke pemilik; pesan baru kemudian membukanya lagi', async () => {
    const { svc, store, notify } = make();
    const a = await say(svc, 'butuh website company profile');
    const before = notify.mock.calls.length;
    const s = await say(svc, 'maaf tidak tertarik');
    expect(s.reply).toContain('tidak akan menghubungi lagi');
    expect(store.getLead(a.leadId)).toMatchObject({ status: 'lost', escalated: false });
    expect(notify.mock.calls.length).toBe(before);
    const back = await say(svc, 'sebenarnya saya jadi butuh landing page, berapa biayanya?');
    expect(store.getLead(a.leadId).status).toBe('contacted');
    expect(back.reply).toMatch(/Angka pastinya|kisaran/);
  });

  it('harga disetujui pemilik: balasan harga memuat kisaran dari katalog', async () => {
    const { svc } = make();
    svc.approvePrices({ ids: ['ecommerce'] });
    await say(svc, 'butuh website toko online');
    const r = await say(svc, 'berapa biayanya kira-kira?');
    expect(r.reply).toContain('Rp4 juta - Rp12 juta');
  });
});
