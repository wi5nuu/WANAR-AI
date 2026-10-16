/**
 * Test Suite: radar klien — normalisasi sumber (Freelancer.com, OpenStreetMap), penilaian dengan aturan
 * tertulis, draf pesan yang dikirim PEMILIK sendiri, penjadwalan paket pagi & tindak lanjut, saran balasan,
 * rute dan perintah Telegram. Jaminan utama: agent tidak pernah menghubungi calon klien sendiri.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';

import { normFreelancer, normOsm, normalizePhone, fetchFreelancer, fetchOsmBusinesses } from '../src/sales/prospects/sources.js';
import { scoreProspect } from '../src/sales/prospects/score.js';
import { localOffer, followUpText, freelancerProposal, waLink } from '../src/sales/prospects/drafts.js';
import { ProspectStore, createProspects } from '../src/sales/prospects/service.js';
import { defaultCatalog } from '../src/sales/catalog.js';
import { SalesStore } from '../src/sales/store.js';
import { createSales } from '../src/sales/service.js';
import { createSalesRouter } from '../src/sales/routes.js';
import { quickSales } from '../src/sales/quick.js';

const NOON = Date.parse('2026-10-16T05:00:00Z');   // 12.00 WIB
const EARLY = Date.parse('2026-10-16T01:30:00Z');  // 08.30 WIB
const TEN = Date.parse('2026-10-16T03:30:00Z');    // 10.30 WIB
const NIGHT = Date.parse('2026-10-16T18:00:00Z');  // 01.00 WIB
const DAY = 86_400_000;

const FACTS = { en: {
  personalInfo: { name: 'Wisnu Alfian Nur Ashar', location: 'Bekasi, West Java, Indonesia', website: 'https://contoh.my.id', github: 'https://github.com/wi5nuu', email: 'w@contoh.id' },
  skills: { programming: ['PHP', 'Python'], webTech: ['React', 'Laravel', 'WordPress', 'Next.js', 'Node.js'], aiMl: [], securityCloud: [], tools: [], soft: [] },
  experience: [], projects: [{ title: 'Ashar Grosir Parfum', status: 'Production', description: 'Official E-Commerce platform serving 15,000+ partners. Optimized for scale.', techStack: ['React'] }],
}, id: null };

const rawFl = (o = {}) => ({
  id: 1001, seo_url: 'php/Build-a-Laravel-site', title: 'Build a Laravel website for my shop', status: 'active', type: 'fixed',
  description: '<p>We need a <b>Laravel</b> website with an admin panel and a MySQL database.</p>', currency: { code: 'USD', exchange_rate: 1 },
  budget: { minimum: 500, maximum: 900 }, bid_stats: { bid_count: 6 }, time_submitted: NOON / 1000 - 1800, jobs: [{ name: 'PHP' }, { name: 'Laravel' }, { name: 'MySQL' }], ...o,
});
const fl = (o) => normFreelancer(rawFl(o), { usdIdr: 16000 });
const osm = (tags = {}, id = 7) => normOsm({ type: 'node', id, tags: { name: 'Kedai Mie Inget', amenity: 'restaurant', phone: '+62 813-1234-5678', ...tags } });

// ------------------------------------------------------------------ sources

describe('sources', () => {
  it('normFreelancer: tautan, HTML dibersihkan, anggaran dikonversi ke rupiah, keahlian dari job_details', () => {
    const p = fl();
    expect(p).toMatchObject({ source: 'freelancer', extId: '1001', kind: 'marketplace', url: 'https://www.freelancer.com/projects/php/Build-a-Laravel-site', bids: 6, hourly: false, currency: 'USD', skills: ['PHP', 'Laravel', 'MySQL'] });
    expect(p.description).toBe('We need a Laravel website with an admin panel and a MySQL database.');
    expect(p.budgetIdrMin).toBe(500 * 16000);
    expect(p.budgetIdrMax).toBe(900 * 16000);
    expect(p.postedAt).toBe(NOON - 1_800_000);
  });
  it('mata uang lain memakai exchange_rate ke USD; per jam ditandai', () => {
    const p = fl({ currency: { code: 'INR', exchange_rate: 0.01 }, budget: { minimum: 10000, maximum: 20000 }, type: 'hourly' });
    expect(p.budgetIdrMax).toBe(Math.round(200 * 16000));
    expect(p.hourly).toBe(true);
  });

  it('normalizePhone: format Indonesia, ponsel vs telepon rumah', () => {
    expect(normalizePhone('+62 813-1234-5678')).toEqual({ digits: '6281312345678', mobile: true });
    expect(normalizePhone('0813 1234 5678')).toEqual({ digits: '6281312345678', mobile: true });
    expect(normalizePhone('(021) 884 4654')).toEqual({ digits: '62218844654', mobile: false });
    expect(normalizePhone('+6281808653200; +62 21 123')).toEqual({ digits: '6281808653200', mobile: true }); // nomor pertama
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone('+1 555 123 4567')).toBeNull(); // bukan Indonesia
    expect(normalizePhone('')).toBeNull();
  });

  it('normOsm: nama, kategori berbahasa Indonesia, alamat, tautan OSM', () => {
    const p = osm({ 'addr:street': 'Jl. Anyelir', 'addr:housenumber': '5' });
    expect(p).toMatchObject({ source: 'osm', extId: 'node/7', kind: 'local', title: 'Kedai Mie Inget', contact: '6281312345678', mobile: true, category: 'restaurant', url: 'https://www.openstreetmap.org/node/7' });
    expect(p.description).toBe('restoran · Jl. Anyelir 5');
  });

  it('fetch: Freelancer.com (hanya proyek aktif & publik) dan Overpass (nama area divalidasi)', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('freelancer.com')) return new Response(JSON.stringify({ status: 'success', result: { projects: [rawFl(), rawFl({ id: 2, status: 'closed' }), rawFl({ id: 3, nonpublic: true })] } }));
      return new Response(JSON.stringify({ elements: [{ type: 'node', id: 1, tags: { name: 'A', shop: 'clothes', phone: '0812 3456 7890' } }, { type: 'node', id: 2, tags: { phone: '0812 3456 7890' } }] }));
    });
    const projects = await fetchFreelancer(fetchImpl, { usdIdr: 16000 });
    expect(projects.map((p) => p.extId)).toEqual(['1001']);
    expect(calls[0].url).toContain('jobs%5B%5D=3');
    expect(calls[0].url).toContain('sort_field=time_submitted');
    const biz = await fetchOsmBusinesses(fetchImpl, { area: 'Bekasi' });
    expect(biz.map((b) => b.title)).toEqual(['A']); // tanpa nama dibuang
    expect(calls[1].init.method).toBe('POST');
    await expect(fetchOsmBusinesses(fetchImpl, { area: 'Bekasi"];drop' })).rejects.toThrow(/tidak valid/);
    const bad = vi.fn(async () => new Response('x', { status: 503 }));
    await expect(fetchFreelancer(bad)).rejects.toThrow('HTTP 503');
  });
});

// ------------------------------------------------------------------ scoring

describe('scoreProspect: usaha lokal', () => {
  const cat = defaultCatalog();
  it('restoran dengan ponsel = cocok, disarankan landing page; toko = toko online', () => {
    const r = scoreProspect(osm(), cat, FACTS, { now: NOON });
    expect(r).toMatchObject({ verdict: 'good', serviceId: 'landing' });
    expect(r.reasons.join(' ')).toMatch(/usaha restoran tanpa website/);
    expect(r.reasons.join(' ')).toMatch(/WhatsApp/);
    expect(scoreProspect(osm({ amenity: undefined, shop: 'clothes' }), cat, FACTS, { now: NOON }).serviceId).toBe('ecommerce');
  });
  it('telepon rumah: skor turun dan diberi catatan; tanpa nama/nomor = dilewati', () => {
    const landline = scoreProspect(osm({ phone: '(021) 884 4654' }), cat, FACTS, { now: NOON });
    expect(landline.score).toBeLessThan(scoreProspect(osm(), cat, FACTS, { now: NOON }).score);
    expect(landline.warnings.join(' ')).toMatch(/tidak bisa lewat WhatsApp/);
    expect(scoreProspect({ ...osm(), title: '' }, cat, FACTS, { now: NOON }).verdict).toBe('skip');
    expect(scoreProspect({ ...osm(), contact: null }, cat, FACTS, { now: NOON }).verdict).toBe('skip');
  });
});

describe('scoreProspect: proyek marketplace', () => {
  const cat = defaultCatalog();
  const sc = (o, c = cat) => scoreProspect(fl(o), c, FACTS, { now: NOON });

  it('proyek cocok, baru, sedikit penawar, anggaran memadai = cocok, dengan alasan tertulis', () => {
    const cat2 = defaultCatalog();
    cat2.services.find((s) => s.id === 'webapp').price.min = 8_000_000;
    const r = sc({ title: 'Build a Laravel admin panel and dashboard', description: 'Laravel backend with MySQL and a dashboard for inventory.' });
    expect(r.verdict).toBe('good');
    expect(r.reasons.join(' ')).toMatch(/cocok dengan layanan/);
    expect(r.reasons.join(' ')).toMatch(/keahlian cocok: .*laravel/);
    expect(r.reasons.join(' ')).toMatch(/baru 6 penawar|6 penawar/);
  });

  it('dilewati: bukan layanan Mas, mencurigakan/melanggar kebijakan, aplikasi seluler murni, anggaran/tarif terlalu kecil', () => {
    expect(sc({ title: 'Logo design for my brand', description: 'Need a logo and business cards.' }).verdict).toBe('skip');
    for (const d of ['Earn 15% commission by referring clients', 'DM me on WhatsApp for details', 'Bypass the captcha on the site', 'unpaid test task first', 'Fix Google Ads circumvention error']) {
      const r = sc({ title: 'WordPress website fix', description: d });
      expect(r.verdict, d).toBe('skip');
      expect(r.warnings[0], d).toMatch(/mencurigakan/);
    }
    const droid = { jobs: [{ name: 'Android' }, { name: 'Kotlin' }] }; // keahlian proyek ini seluler, bukan PHP/Laravel bawaan fixture
    expect(sc({ ...droid, title: 'Fix a bug in our Android app', description: 'Native Android app in Kotlin, one crash to fix.' }).warnings[0]).toMatch(/aplikasi seluler murni/);
    expect(sc({ ...droid, title: 'Android app for deliveries', description: 'Native Android app in Kotlin.' }).verdict).toBe('skip'); // tidak cocok layanan mana pun
    expect(sc({ budget: { minimum: 5, maximum: 20 } }).warnings[0]).toMatch(/anggaran jauh di bawah/);
    expect(sc({ type: 'hourly', budget: { minimum: 2, maximum: 6 } }).warnings[0]).toMatch(/tarif per jam terlalu rendah/);
  });

  it('kerumunan: di atas 100 penawar tidak pernah "cocok", 40-100 dibatasi', () => {
    const crowded = sc({ bid_stats: { bid_count: 338 }, title: 'Build a Laravel website', description: 'Laravel MySQL WordPress' });
    expect(crowded.verdict).not.toBe('good');
    expect(crowded.score).toBeLessThanOrEqual(54);
    expect(crowded.warnings.join(' ')).toMatch(/kompetisi sangat ketat: 338/);
    expect(sc({ bid_stats: { bid_count: 60 } }).score).toBeLessThanOrEqual(69);
  });

  it('tanpa keahlian yang disebut di portofolio: dibatasi (bukan cocok penuh)', () => {
    const r = scoreProspect(fl({ title: 'Build a Laravel website', description: 'website for a shop', jobs: [] }), cat, { en: { ...FACTS.en, skills: { programming: [], webTech: ['Go'], aiMl: [], securityCloud: [], tools: [], soft: [] }, projects: [], experience: [] } }, { now: NOON });
    expect(r.score).toBeLessThanOrEqual(45);
    expect(r.warnings.join(' ')).toMatch(/tidak ada keahlian/);
  });

  it('proyek lama (>2 hari) diturunkan', () => {
    const fresh = sc({ title: 'Build a Laravel website', description: 'Laravel MySQL', time_submitted: NOON / 1000 - 600 });
    const old = sc({ title: 'Build a Laravel website', description: 'Laravel MySQL', time_submitted: NOON / 1000 - 3 * 86400 });
    expect(fresh.score).toBeGreaterThan(old.score);
    expect(old.warnings.join(' ')).toMatch(/lebih dari 2 hari/);
  });
});

// ------------------------------------------------------------------ drafts

describe('drafts: pesan yang dikirim PEMILIK', () => {
  it('tawaran WhatsApp: spesifik per jenis usaha, tanpa harga, mudah ditolak, tautan wa.me berisi pesan', () => {
    const d = localOffer(osm(), FACTS);
    expect(d.text).toContain('Saya Wisnu, pembuat website dari Bekasi.');
    expect(d.text).toContain('Kedai Mie Inget belum memiliki website');
    expect(d.text).toContain('memajang menu, jam buka, dan lokasi');
    expect(d.text).toContain('https://contoh.my.id');
    expect(d.text).toContain('abaikan saja pesan ini');
    expect(d.text).not.toMatch(/Rp\s?\d|\d\s?juta|diskon|gratis|pasti/i);
    expect(d.link.startsWith('https://wa.me/6281312345678?text=')).toBe(true);
    expect(decodeURIComponent(d.link.split('?text=')[1])).toBe(d.text);
    expect(localOffer(osm({ amenity: undefined, shop: 'clothes' }), FACTS).text).toContain('katalog produk');
    expect(localOffer(osm({ phone: '(021) 884 4654' }), FACTS).link).toBeNull(); // telepon rumah: tidak ada tautan WhatsApp
  });

  it('tindak lanjut: dua versi saja, sopan, memberi jalan keluar', () => {
    const a = followUpText(osm(), FACTS, 1).text;
    const b = followUpText(osm(), FACTS, 2).text;
    expect(a).toContain('Kalau tidak, tidak apa-apa');
    expect(b).toContain('kabari saya saja');
    expect(a).not.toBe(b);
    for (const t of [a, b]) expect(t).not.toMatch(/Rp\s?\d|diskon|segera|terakhir kali|penawaran terbatas/i);
  });

  it('proposal Freelancer: memuat keahlian & bukti dari fakta pemilik; harga BELUM disetujui = tanpa saran angka', () => {
    const cat = defaultCatalog();
    const r = freelancerProposal({ ...fl(), serviceId: 'webapp', budgetMin: 500, budgetMax: 900 }, cat, FACTS, { serviceId: 'webapp' });
    expect(r.text).toContain('I read your project "Build a Laravel website for my shop"');
    expect(r.text).toMatch(/I work with .*Laravel/);
    expect(r.text).toContain('Ashar Grosir Parfum (Production): Official E-Commerce platform serving 15,000+ partners.');
    expect(r.text).not.toMatch(/\bRp|\$\d/);
    expect(r.bid).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/belum Mas setujui/);
  });

  it('proposal: harga disetujui -> saran angka di dalam irisan anggaran klien & harga pemilik, dalam mata uang proyek', () => {
    const cat = defaultCatalog();
    const svc = cat.services.find((s) => s.id === 'webapp');
    svc.price = { min: 8_000_000, max: 35_000_000, unit: 'proyek', approved: true };
    const p = { ...fl({ budget: { minimum: 1000, maximum: 3000 } }), serviceId: 'webapp', budgetMin: 1000, budgetMax: 3000 };
    const r = freelancerProposal(p, cat, FACTS, { serviceId: 'webapp' });
    expect(r.bid).toMatchObject({ currency: 'USD' });
    // irisan: [max(8jt, 16jt), min(35jt, 48jt)] = [16jt, 35jt] -> tengah 25.5jt = $1593.75
    expect(r.bid.amount).toBeCloseTo(25_500_000 / 16000, 0);
    expect(r.text).toMatch(/Typical delivery .*20-60 working days/);
  });

  it('proposal: anggaran klien di bawah harga minimum pemilik -> peringatan, bukan angka', () => {
    const cat = defaultCatalog();
    cat.services.find((s) => s.id === 'webapp').price = { min: 8_000_000, max: 35_000_000, unit: 'proyek', approved: true };
    const p = { ...fl({ budget: { minimum: 50, maximum: 100 } }), serviceId: 'webapp', budgetMin: 50, budgetMax: 100 };
    const r = freelancerProposal(p, cat, FACTS, { serviceId: 'webapp' });
    expect(r.bid).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/di bawah harga minimum Mas/);
  });

  it('banyak penawar: diperingatkan agar baris pertama menonjol', () => {
    const r = freelancerProposal({ ...fl({ bid_stats: { bid_count: 120 } }), serviceId: 'webapp', budgetMin: 500, budgetMax: 900 }, defaultCatalog(), FACTS, {});
    expect(r.warnings.join(' ')).toMatch(/120 penawar/);
  });

  it('waLink hanya angka', () => { expect(waLink('+62 812-34', 'a b')).toBe('https://wa.me/6281234?text=a%20b'); });
});

// ------------------------------------------------------------------ store & service

function makeSvc({ now = NOON, env = {}, notify = vi.fn(async () => {}), fetchImpl = null } = {}) {
  let clock = now;
  const db = new Database(':memory:');
  db.exec('CREATE TABLE agent_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL DEFAULT \'info\', title TEXT NOT NULL, detail TEXT, ref TEXT)');
  const logs = [];
  const log = (e) => { logs.push(e); db.prepare('INSERT INTO agent_activity (ts, agent, kind, level, title, detail, ref) VALUES (?,?,?,?,?,?,?)').run(clock, e.agent || 'system', e.kind || 'info', e.level || 'info', e.title, e.detail || null, e.ref || null); };
  const store = new ProspectStore(db, { now: () => clock });
  const fetcher = fetchImpl || vi.fn(async (url) => {
    if (String(url).includes('freelancer.com')) return new Response(JSON.stringify({ status: 'success', result: { projects: [rawFl({ title: 'Build a Laravel admin panel and dashboard', description: 'Laravel backend, MySQL and a dashboard.' })] } }));
    return new Response(JSON.stringify({ elements: [
      { type: 'node', id: 1, tags: { name: 'Kedai Satu', amenity: 'restaurant', phone: '0812 1111 2222' } },
      { type: 'node', id: 2, tags: { name: 'Kafe Dua', amenity: 'cafe', phone: '0812 3333 4444' } },
      { type: 'node', id: 3, tags: { name: 'Toko Tiga', shop: 'clothes', phone: '(021) 555 666' } },
    ] }));
  });
  const svc = createProspects({ store, getCatalog: defaultCatalog, getFacts: () => FACTS, notify, ownerChat: () => '55555', log, fetchImpl: fetcher, now: () => clock, env: { CAREER_TELEGRAM: 'on', SALES_LOCAL_AREAS: 'Bekasi', SALES_OSM_DELAY_MS: '0', SALES_OSM_RETRY_MS: '0', ...env } });
  return { svc, store, db, logs, notify, fetcher, tick: (ms) => { clock += ms; }, set: (t) => { clock = t; } };
}

describe('ProspectStore', () => {
  it('upsert tidak menggandakan; status contacted menjadwalkan tindak lanjut 2 hari, lalu 4 hari, lalu berhenti', () => {
    const { store, tick } = makeSvc();
    const p = osm();
    const sc = scoreProspect(p, defaultCatalog(), FACTS, { now: NOON });
    const a = store.upsert(p, sc);
    expect(a.inserted).toBe(true);
    expect(store.upsert(p, sc)).toMatchObject({ inserted: false, id: a.id });
    expect(store.list().total).toBe(1);

    store.setStatus(a.id, 'contacted');
    expect(store.dueFollowUps()).toHaveLength(0);
    tick(2 * DAY + 1000);
    expect(store.dueFollowUps().map((x) => x.id)).toEqual([a.id]);
    expect(store.recordFollowUp(a.id)).toBe(1);
    expect(store.dueFollowUps()).toHaveLength(0);
    tick(4 * DAY + 1000);
    expect(store.dueFollowUps()).toHaveLength(1);
    expect(store.recordFollowUp(a.id)).toBe(2);
    tick(30 * DAY);
    expect(store.dueFollowUps()).toHaveLength(0); // maksimal dua kali
  });

  it('klien membalas / menolak menghentikan tindak lanjut; status tidak valid ditolak', () => {
    const { store, tick } = makeSvc();
    const p = osm();
    const id = store.upsert(p, scoreProspect(p, defaultCatalog(), FACTS)).id;
    store.setStatus(id, 'contacted'); tick(3 * DAY);
    expect(store.dueFollowUps()).toHaveLength(1);
    store.setStatus(id, 'replied');
    expect(store.dueFollowUps()).toHaveLength(0);
    expect(() => store.setStatus(id, 'hack')).toThrow(/tidak valid/);
    expect(store.setStatus(9999, 'won')).toBeNull();
  });
});

describe('ProspectService.scan', () => {
  it('membaca Freelancer & usaha lokal, menilai, mencatat; usaha lokal tidak dipindai ulang dalam 3 hari kecuali dipaksa', async () => {
    const { svc, store, fetcher, tick } = makeSvc();
    const r = await svc.scan();
    expect(r).toMatchObject({ fetched: 4, fresh: 4, errors: [] });
    expect(store.stats()).toMatchObject({ total: 4, goodLocal: 2 });
    const calls = fetcher.mock.calls.length;
    await svc.scan();
    expect(fetcher.mock.calls.length).toBe(calls + 1); // hanya Freelancer
    tick(3 * DAY + 1000);
    await svc.scan();
    expect(fetcher.mock.calls.length).toBe(calls + 3); // Freelancer + Overpass lagi
    await svc.scan({ force: true });
    expect(fetcher.mock.calls.length).toBe(calls + 5);
  });

  it('satu sumber gagal tidak menghentikan yang lain; galat dicatat sebagai peringatan', async () => {
    const fetchImpl = vi.fn(async (url) => (String(url).includes('freelancer.com') ? new Response('x', { status: 503 }) : new Response(JSON.stringify({ elements: [{ type: 'node', id: 1, tags: { name: 'A', amenity: 'cafe', phone: '0812 1111 2222' } }] }))));
    const { svc, logs } = makeSvc({ fetchImpl });
    const r = await svc.scan();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/freelancer: HTTP 503/);
    expect(r.fresh).toBe(1);
    expect(logs.some((l) => l.kind === 'prospect_error' && l.level === 'warn')).toBe(true);
  });

  it('Overpass sibuk (502): dicoba ulang sampai berhasil; galat selain sibuk tidak diulang; menyerah setelah 3 kali', async () => {
    let n = 0;
    const busyThenOk = vi.fn(async (url) => {
      if (String(url).includes('freelancer.com')) return new Response(JSON.stringify({ status: 'success', result: { projects: [] } }));
      n += 1;
      return n < 3 ? new Response('busy', { status: 502 }) : new Response(JSON.stringify({ elements: [{ type: 'node', id: 1, tags: { name: 'A', amenity: 'cafe', phone: '0812 1111 2222' } }] }));
    });
    const a = makeSvc({ fetchImpl: busyThenOk });
    expect((await a.svc.scan()).fresh).toBe(1);
    expect(n).toBe(3);

    let m = 0;
    const always = vi.fn(async (url) => (String(url).includes('freelancer.com') ? new Response(JSON.stringify({ status: 'success', result: { projects: [] } })) : (m += 1, new Response('x', { status: 502 }))));
    const b = makeSvc({ fetchImpl: always });
    const r = await b.svc.scan();
    expect(m).toBe(3);
    expect(r.errors[0]).toMatch(/osm:Bekasi: HTTP 502/);

    let k = 0;
    const bad = vi.fn(async (url) => (String(url).includes('freelancer.com') ? new Response(JSON.stringify({ status: 'success', result: { projects: [] } })) : (k += 1, new Response('x', { status: 400 }))));
    await makeSvc({ fetchImpl: bad }).svc.scan();
    expect(k).toBe(1);
  });

  it('dua pemindaian bersamaan memakai satu proses', async () => {
    const { svc, fetcher } = makeSvc();
    await Promise.all([svc.scan(), svc.scan()]);
    expect(fetcher.mock.calls.length).toBe(2); // 1 Freelancer + 1 Overpass
  });
});

describe('paket pagi & tindak lanjut (selalu dikirim ke PEMILIK, tidak pernah ke calon klien)', () => {
  it('08.00 WIB: header + satu pesan per usaha lokal cocok (hanya ponsel), sekali per hari', async () => {
    const { svc, notify, store } = makeSvc({ now: EARLY });
    await svc.scan();
    expect(await svc.morningBatch()).toBe(2);
    const texts = notify.mock.calls.map((c) => c[1]);
    expect(notify.mock.calls.every((c) => c[0] === '55555')).toBe(true); // semua ke pemilik
    expect(texts[0]).toContain('2 usaha lokal tanpa website');
    expect(texts.slice(1).every((t) => /Buka WhatsApp: https:\/\/wa\.me\/628/.test(t))).toBe(true);
    expect(texts.join(' ')).not.toContain('Toko Tiga'); // telepon rumah tidak dikirim
    expect(store.list({ status: 'new' }).prospects.filter((p) => p.pushed_at).length).toBe(2);
    expect(await svc.morningBatch()).toBe(0); // sudah hari ini
    svc.tick?.(0);
  });

  it('tidak sebelum 08.00 WIB, tidak di jam tenang, tidak di instance tanpa CAREER_TELEGRAM=on', async () => {
    const early = makeSvc({ now: Date.parse('2026-10-16T00:30:00Z') }); // 07.30
    await early.svc.scan(); expect(await early.svc.morningBatch()).toBe(0);
    const night = makeSvc({ now: NIGHT });
    await night.svc.scan(); expect(await night.svc.morningBatch()).toBe(0);
    const laptop = makeSvc({ now: EARLY, env: { CAREER_TELEGRAM: '' } });
    await laptop.svc.scan(); expect(await laptop.svc.morningBatch()).toBe(0); expect(laptop.notify).not.toHaveBeenCalled();
  });

  it('batas harian SALES_OUTREACH_PER_DAY dihormati dan yang sudah dikirim tidak dikirim lagi esoknya', async () => {
    const { svc, notify, tick } = makeSvc({ now: EARLY, env: { SALES_OUTREACH_PER_DAY: '1' } });
    await svc.scan();
    expect(await svc.morningBatch()).toBe(1);
    tick(DAY);
    expect(await svc.morningBatch()).toBe(1); // besok: yang kedua, bukan yang sama
    const ids = notify.mock.calls.map((c) => c[1]).filter((t) => t.startsWith('Peluang #')).map((t) => /#(\d+)/.exec(t)[1]);
    expect(new Set(ids).size).toBe(2);
  });

  it('10.00 WIB: tindak lanjut hanya yang sudah dihubungi & belum membalas, maksimal dua kali', async () => {
    const { svc, store, notify, tick, set } = makeSvc({ now: EARLY });
    await svc.scan();
    const [a, b] = store.list({ kind: 'local', verdict: 'good' }).prospects;
    svc.setStatus(a.id, 'contacted'); svc.setStatus(b.id, 'contacted'); svc.setStatus(b.id, 'replied');
    expect(await svc.followUps()).toBe(0); // belum jatuh tempo
    set(TEN + 2 * DAY + 1000);
    expect(await svc.followUps()).toBe(1);  // hanya yang belum membalas
    const sent = notify.mock.calls.map((c) => c[1]);
    expect(sent.some((t) => t.includes(`Tindak lanjut #${a.id}`) && t.includes('1 dari 2'))).toBe(true);
    expect(sent.join(' ')).not.toContain(`#${b.id}:`);
    tick(DAY); expect(await svc.followUps()).toBe(0); // sekali per hari
    set(TEN + 8 * DAY);
    expect(await svc.followUps()).toBe(1);  // tindak lanjut kedua
    set(TEN + 20 * DAY);
    expect(await svc.followUps()).toBe(0);  // tidak mengejar lebih dari dua kali
    expect(sent.length).toBeGreaterThan(0);
  });

  it('baris laporan harian: peluang baru dan tindak lanjut', async () => {
    const { svc, store, tick } = makeSvc({ now: NOON });
    await svc.scan();
    const lines = svc.reportLines({ since: NOON - DAY });
    expect(lines[0]).toMatch(/^Peluang klien: \d+ baru cocok \(usaha lokal 2, Freelancer \d\)/);
    const id = store.list({ kind: 'local', verdict: 'good' }).prospects[0].id;
    svc.setStatus(id, 'contacted'); tick(3 * DAY);
    expect(svc.reportLines({ since: NOON + 2 * DAY }).join('\n')).toContain('Tindak lanjut: 1 calon klien belum membalas');
    expect(makeSvc().svc.reportLines({ since: 0 })).toEqual([]);
  });

  it('Telegram gagal di tengah paket: yang sudah terkirim tetap ditandai, tidak melempar', async () => {
    const notify = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValue(new Error('down'));
    const { svc, store } = makeSvc({ now: EARLY, notify });
    await svc.scan();
    const n = await svc.morningBatch();
    expect(n).toBe(1);
    expect(store.list().prospects.filter((p) => p.pushed_at)).toHaveLength(1);
  });
});

describe('draft()', () => {
  it('usaha lokal: pesan + tautan + bahan tindak lanjut; Freelancer: proposal + tautan proyek', async () => {
    const { svc, store } = makeSvc();
    await svc.scan();
    const local = store.list({ kind: 'local', verdict: 'good' }).prospects[0];
    const d = svc.draft(local.id);
    expect(d).toMatchObject({ kind: 'local', channel: 'whatsapp' });
    expect(d.link).toMatch(/^https:\/\/wa\.me\/628/);
    expect(d.followUp.text).toContain('menghubungi soal website');
    const mk = store.list({ kind: 'marketplace' }).prospects[0];
    const m = svc.draft(mk.id);
    expect(m).toMatchObject({ kind: 'marketplace', channel: 'platform', link: mk.url });
    expect(m.text).toContain('I read your project');
    expect(svc.draft(99999)).toBeNull();
  });
});

// ------------------------------------------------------------------ saran balasan, rute, Telegram

function makeSales({ approved = false } = {}) {
  const base = makeSvc({ now: NOON });
  const store = new SalesStore(base.db, { now: () => NOON });
  const sales = createSales({ store, getFacts: () => FACTS, log: () => {}, env: { CAREER_TELEGRAM: '' }, now: () => NOON });
  if (approved) sales.approvePrices();
  sales.prospects = base.svc;
  return { ...base, sales };
}

describe('SalesService.suggest (saran balasan untuk kanal yang tidak terlihat agent)', () => {
  it('menyusun jawaban dari mesin percakapan; tidak mencatat/mengirim apa pun', () => {
    const { sales, store } = makeSales();
    const s = sales.suggest({ text: 'Berapa harga website toko online?' });
    expect(s).toMatchObject({ intent: 'price', escalate: false, service: { id: 'ecommerce' } });
    expect(s.text).not.toMatch(/Rp\s?\d/);
    expect(store.stats().total).toBe(0);
    const ready = sales.suggest({ text: 'oke deal, kapan bisa mulai?' });
    expect(ready).toMatchObject({ intent: 'ready', escalate: true });
    expect(() => sales.suggest({ text: '  ' })).toThrow(/kosong/);
  });
});

describe('HTTP /api/sales: peluang & saran balasan', () => {
  async function app(opts) {
    const m = makeSales(opts);
    await m.svc.scan();
    return { ...m, http: express().use('/api/sales', createSalesRouter({ sales: m.sales })) };
  }

  it('daftar, detail dengan draf, ubah status, dan pindai', async () => {
    const { http } = await app();
    const list = (await request(http).get('/api/sales/prospects').query({ kind: 'local', verdict: 'good' })).body;
    expect(list.total).toBe(2);
    expect(list.stats.goodLocal).toBe(2);
    const id = list.prospects[0].id;
    const d = (await request(http).get(`/api/sales/prospects/${id}`)).body;
    expect(d).toMatchObject({ kind: 'local' });
    expect(d.link).toMatch(/wa\.me/);
    expect((await request(http).get('/api/sales/prospects/9999')).status).toBe(404);
    expect((await request(http).get('/api/sales/prospects').query({ kind: 'x' })).status).toBe(400);
    expect((await request(http).post(`/api/sales/prospects/${id}/status`).send({ status: 'hack' })).status).toBe(400);
    const ok = await request(http).post(`/api/sales/prospects/${id}/status`).send({ status: 'contacted' });
    expect(ok.body.prospect).toMatchObject({ status: 'contacted' });
    expect((await request(http).post('/api/sales/prospects/scan').send({})).status).toBe(202);
  });

  it('POST /suggest', async () => {
    const { http } = await app();
    const r = await request(http).post('/api/sales/suggest').send({ text: 'terlalu mahal, bisa nego?' });
    expect(r.body).toMatchObject({ intent: 'haggle', escalate: true });
    expect((await request(http).post('/api/sales/suggest').send({ text: '' })).status).toBe(400);
  });

  it('tanpa radar klien: 404 yang jelas', async () => {
    const m = makeSales(); m.sales.prospects = null;
    const http = express().use('/api/sales', createSalesRouter({ sales: m.sales }));
    expect((await request(http).get('/api/sales/prospects')).status).toBe(404);
  });
});

describe('perintah Telegram: peluang', () => {
  async function seeded() { const m = makeSales(); await m.svc.scan(); return m; }

  it('daftar peluang: usaha lokal dan Freelancer dengan nomor, plus petunjuk', async () => {
    const { sales } = await seeded();
    const r = await quickSales(sales, 'peluang');
    expect(r).toContain('Usaha lokal tanpa website:');
    expect(r).toMatch(/#\d+ \[\d+\] Kedai Satu \(restoran\)/);
    expect(r).toContain('Ketik "peluang <nomor>"');
  });

  it('detail usaha lokal: nomor, tautan WhatsApp, pesan, dan cara menandai terkirim', async () => {
    const { sales, store } = await seeded();
    const id = store.list({ kind: 'local', verdict: 'good' }).prospects[0].id;
    const r = await quickSales(sales, `peluang ${id}`);
    expect(r).toContain(`Peluang #${id}:`);
    expect(r).toMatch(/Buka WhatsApp dengan pesan terisi: https:\/\/wa\.me\/628/);
    expect(r).toContain('Pesan:\nHalo, selamat siang. Saya Wisnu');
    expect(r).toContain(`balas: peluang ${id} dihubungi`);
    expect(await quickSales(sales, 'peluang 99999')).toMatch(/tidak ditemukan/);
  });

  it('detail Freelancer: ringkasan, catatan, dan pesan penawaran', async () => {
    const { sales, store } = await seeded();
    const id = store.list({ kind: 'marketplace' }).prospects[0].id;
    const r = await quickSales(sales, `peluang ${id}`);
    expect(r).toContain('(Freelancer.com)');
    expect(r).toContain('Pesan penawaran:');
    expect(r).toMatch(/belum Mas setujui/); // harga belum disetujui: tidak ada saran angka
  });

  it('menandai: dihubungi (menjadwalkan tindak lanjut), menang dengan nilai', async () => {
    const { sales, store } = await seeded();
    const id = store.list({ kind: 'local', verdict: 'good' }).prospects[0].id;
    expect(await quickSales(sales, `peluang ${id} dihubungi`)).toMatch(/sudah dihubungi.*dua hari lagi/);
    expect(await quickSales(sales, `peluang ${id} menang 4,5jt`)).toMatch(/menang, nilai Rp4\.500\.000/);
    expect(store.get(id)).toMatchObject({ status: 'won', value_idr: 4_500_000 });
    expect(await quickSales(sales, `peluang ${id} lewati`)).toMatch(/dilewati/);
  });

  it('saran balasan: menyarankan jawaban & menandai bagian yang harus dijawab pemilik', async () => {
    const { sales } = await seeded();
    const a = await quickSales(sales, 'saran balasan: klien bilang terlalu mahal, bisa nego?');
    expect(a).toMatch(/^Saran balasan \(maksud: haggle/);
    expect(a).toContain('sebaiknya Mas sendiri yang menjawab');
    const b = await quickSales(sales, 'saran balasan: berapa lama pengerjaan website company profile?');
    expect(b).toContain('maksud: timeline');
    expect(await quickSales(sales, 'saran balasan: tidak tertarik, terima kasih')).toContain('jangan dikejar lagi');
  });

  it('kalimat biasa tidak dibajak; radar mati = perintah peluang diteruskan ke model', async () => {
    const { sales } = await seeded();
    for (const q of ['peluang usaha apa yang bagus', 'peluang kerja di Bekasi', 'saran investasi', 'saran balasan', 'peluang 12 mungkin besok']) expect(await quickSales(sales, q), q).toBeNull();
    sales.prospects = null;
    expect(await quickSales(sales, 'peluang')).toBeNull();
  });
});
