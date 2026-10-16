/**
 * Test Suite: Career radar — normalisasi sumber lowongan, penilaian kecocokan (aturan tertulis,
 * tanpa AI), penyimpanan, pemindaian terjadwal, laporan Telegram, jam tenang, dan rute HTTP.
 * Semua tanpa jaringan: sumber diganti fetch palsu berbentuk data asli tiap penyedia.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';

import {
  normRemotive, normRemoteOk, normArbeitnow, normHimalayas, normJobicy, normGreenhouse,
  parseRssItems, normWwr, stripHtml, toMs, fetchAll, buildSources,
} from '../src/career/sources.js';
import { scoreJob, requiredYears, eligibility, parseSkills } from '../src/career/scoring.js';
import { CareerStore } from '../src/career/store.js';
import { createCareer, inQuietHours } from '../src/career/service.js';
import { createCareerRouter } from '../src/career/routes.js';

const SKILLS = parseSkills('Python, C++, Java, PHP, Golang, PostgreSQL, MySQL, MongoDB, React, Next.js, TypeScript, Tailwind CSS, Laravel, Docker, Cybersecurity, Kali Linux, FastAPI, Node.js, Burp Suite, Zero-Trust Architecture');
const PROFILE = { skills: SKILLS, maxYears: 2, now: Date.parse('2026-10-16T05:00:00Z') };
const FRESH = Date.parse('2026-10-15T08:00:00Z');

const job = (over = {}) => ({
  source: 'remotive', extId: String(Math.random()), url: 'https://example.com/j', title: 'Junior Full Stack Developer',
  company: 'Acme', location: 'Worldwide', remote: true, tags: ['react', 'node.js', 'typescript'], seniority: null,
  employmentType: 'full_time', salaryMin: null, salaryMax: null, salaryCurrency: null, salaryText: '', postedAt: FRESH,
  description: 'We use React, Node.js and PostgreSQL. 1-2 years of experience required.', regions: [], timezones: [], ...over,
});

// --------------------------------------------------------------- normalisers

describe('normalisasi sumber (bentuk data asli tiap penyedia)', () => {
  it('Remotive', () => {
    const j = normRemotive({ id: 1680495, url: 'https://remotive.com/remote-jobs/x-1', title: 'Remote Office Assistant', company_name: 'Coalition ',
      tags: ['CSS', 'php'], job_type: 'full_time', publication_date: '2026-10-11T20:17:27', candidate_required_location: 'Worldwide', salary: '$35k', description: '<p>Hi &amp; <b>welcome</b></p>' });
    expect(j).toMatchObject({ source: 'remotive', extId: '1680495', company: 'Coalition', location: 'Worldwide', salaryText: '$35k' });
    expect(j.description).toBe('Hi & welcome');
    expect(j.postedAt).toBeGreaterThan(0);
  });

  it('RemoteOK (epoch detik, gaji min/max)', () => {
    const j = normRemoteOk({ id: '1137525', epoch: 1792051217, position: 'Dev', company: 'M', tags: ['dev'], url: 'https://remoteok.com/r', salary_min: 40000, salary_max: 60000, description: 'x' });
    expect(j).toMatchObject({ source: 'remoteok', extId: '1137525', salaryMin: 40000, salaryCurrency: 'USD' });
    expect(j.postedAt).toBe(1792051217 * 1000);
  });

  it('Arbeitnow, Himalayas (zona waktu & wilayah), Jobicy, Greenhouse', () => {
    expect(normArbeitnow({ slug: 'a', url: 'https://a', title: 'ML', company_name: 'X', remote: true, location: 'Berlin', created_at: 1792137661, tags: ['Remote'], job_types: ['professional'] }))
      .toMatchObject({ source: 'arbeitnow', location: 'Berlin', remote: true });
    const h = normHimalayas({ title: 'Dev', companyName: 'S', guid: 'https://h/1', applicationLink: 'https://h/1', seniority: ['Mid-level'], locationRestrictions: ['United States'], timezoneRestrictions: [-8, -5], minSalary: null, pubDate: 1792140923, description: '<h3>x</h3>' });
    expect(h).toMatchObject({ source: 'himalayas', seniority: 'Mid-level', regions: ['United States'], timezones: [-8, -5] });
    expect(normHimalayas({ title: 'Dev', companyName: 'S', guid: 'g', locationRestrictions: [] }).location).toBe('Worldwide');
    expect(normJobicy({ id: 147750, url: 'https://j', jobTitle: 'IAM', companyName: 'Vercel', jobGeo: 'USA', jobLevel: 'Senior', jobType: ['Full-Time'], salaryMin: 208000, salaryCurrency: 'USD', pubDate: '2026-10-16T03:50:03+00:00', jobDescription: '<div>x</div>' }))
      .toMatchObject({ source: 'jobicy', seniority: 'Senior', salaryMin: 208000 });
    const g = normGreenhouse('gitlab', { id: 8860302002, absolute_url: 'https://gh/1', title: 'AE', company_name: 'GitLab', location: { name: 'Remote, France' }, first_published: '2026-10-02T11:31:50-04:00' });
    expect(g).toMatchObject({ source: 'greenhouse:gitlab', location: 'Remote, France', remote: true, description: '' });
  });

  it('RSS We Work Remotely: judul "Perusahaan: Peran", entity di-decode', () => {
    const xml = `<rss><channel><item><title>Salesloft: Principal Software Engineer, AI</title><region>Anywhere in the World</region><category>Full-Stack Programming</category>
      <description>&lt;p&gt;&lt;strong&gt;Headquarters:&lt;/strong&gt; United States&lt;/p&gt;</description><pubDate>Wed, 30 Sep 2026 07:31:24 +0000</pubDate>
      <guid>https://weworkremotely.com/remote-jobs/salesloft</guid><link>https://weworkremotely.com/remote-jobs/salesloft</link></item></channel></rss>`;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(1);
    const j = normWwr(items[0]);
    expect(j).toMatchObject({ source: 'weworkremotely', company: 'Salesloft', title: 'Principal Software Engineer, AI', location: 'Anywhere in the World' });
    expect(j.description).toContain('Headquarters: United States');
  });

  it('stripHtml & toMs', () => {
    expect(stripHtml('<ul><li>a</li><li>b</li></ul><script>x()</script>')).toBe('- a\n- b');
    expect(toMs(1700000000)).toBe(1700000000000);
    expect(toMs('2026-10-16T03:50:03+00:00')).toBe(Date.parse('2026-10-16T03:50:03Z'));
    expect(toMs('')).toBe(0);
    expect(toMs('bukan tanggal')).toBe(0);
  });

  it('fetchAll: satu sumber gagal tidak menghentikan yang lain, duplikat dibuang', async () => {
    const sources = [
      { id: 'a', label: 'A', fetch: async () => [job({ source: 'a', extId: '1' }), job({ source: 'a', extId: '1' })] },
      { id: 'b', label: 'B', fetch: async () => { throw new Error('HTTP 503'); } },
      { id: 'c', label: 'C', fetch: async () => [job({ source: 'c', extId: '9' }), { source: 'c', extId: 'x', title: '', url: '' }] },
    ];
    const { jobs, report } = await fetchAll({ sources });
    expect(jobs.map((j) => `${j.source}:${j.extId}`)).toEqual(['a:1', 'c:9']);
    expect(report.find((r) => r.source === 'b')).toMatchObject({ ok: false, error: 'HTTP 503' });
    expect(report.filter((r) => r.ok).map((r) => r.count)).toEqual([1, 1]);
  });

  it('buildSources memuat semua penyedia & papan Greenhouse dari env', () => {
    const ids = buildSources({ CAREER_GREENHOUSE_BOARDS: 'gitlab, bukan valid!, vercel' }).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['remotive', 'remoteok', 'arbeitnow', 'himalayas', 'jobicy', 'greenhouse:gitlab', 'greenhouse:vercel']));
    expect(ids.filter((i) => i.startsWith('wwr:'))).toHaveLength(3);
    expect(ids.some((i) => i.includes('bukan'))).toBe(false);
  });
});

// --------------------------------------------------------------- scoring

describe('requiredYears', () => {
  it('membaca syarat pengalaman, mengabaikan usia perusahaan', () => {
    expect(requiredYears('3+ years of experience with Node.js')).toBe(3);
    expect(requiredYears('1-2 years of professional experience')).toBe(1);
    expect(requiredYears('Minimal pengalaman 2 tahun sebagai developer')).toBe(2);
    expect(requiredYears('We were founded 10 years ago and grew fast')).toBeNull();
    expect(requiredYears('Over the past 8 years our experience team has grown')).toBeNull();
    expect(requiredYears('No requirements listed')).toBeNull();
  });
});

describe('eligibility (apakah orang Indonesia bisa mengambilnya)', () => {
  it('worldwide / Asia = yes; USA only = no; kosong = maybe', () => {
    expect(eligibility({ location: 'Worldwide', description: '' }).value).toBe('yes');
    expect(eligibility({ location: 'Anywhere in the World' }).value).toBe('yes');
    expect(eligibility({ location: 'APAC' }).value).toBe('yes');
    expect(eligibility({ location: 'USA Only' }).value).toBe('no');
    expect(eligibility({ location: 'Remote, France' }).value).toBe('no');
    expect(eligibility({ location: '' }).value).toBe('maybe');
  });
  it('"worldwide" tetapi deskripsi menyebut izin kerja negara lain -> maybe, bukan yes', () => {
    expect(eligibility({ location: 'Worldwide', description: 'You must be located in the US and have work authorization.' }).value).toBe('maybe');
  });
  it('zona waktu tanpa WIB (+7) = no; bukan remote = no', () => {
    expect(eligibility({ location: 'Worldwide', timezones: [-8, -5] }).value).toBe('no');
    expect(eligibility({ location: 'Worldwide', timezones: [0, 7] }).value).toBe('yes');
    expect(eligibility({ location: 'Worldwide', remote: false }).value).toBe('no');
  });
});

describe('scoreJob', () => {
  it('junior full-stack worldwide dengan keahlian cocok = apply', () => {
    const r = scoreJob(job(), PROFILE);
    expect(r.verdict).toBe('apply');
    expect(r.score).toBeGreaterThanOrEqual(62);
    expect(r.matchedSkills).toEqual(expect.arrayContaining(['react', 'node.js', 'postgresql']));
    expect(r.reasons.join(' ')).toMatch(/full-stack/);
  });

  it('senior / lead / principal = skip, apa pun keahliannya', () => {
    for (const title of ['Senior Backend Engineer', 'Staff Software Engineer', 'Principal Software Engineer, AI', 'Lead Full Stack Developer', 'Engineering Manager']) {
      expect(scoreJob(job({ title }), PROFILE).verdict, title).toBe('skip');
    }
  });

  it('bukan peran software = skip', () => {
    for (const title of ['Account Executive - France', 'Marketing Manager', 'Customer Support Specialist', 'Senior Recruiter']) {
      const r = scoreJob(job({ title }), PROFILE);
      expect(r.verdict, title).toBe('skip');
      expect(r.reasons[0]).toMatch(/bukan peran software/);
    }
  });

  it('dibatasi wilayah (USA only / zona waktu) = skip', () => {
    expect(scoreJob(job({ location: 'USA Only' }), PROFILE).verdict).toBe('skip');
    expect(scoreJob(job({ location: 'Worldwide', timezones: [-8, -5], regions: ['United States'] }), PROFILE).verdict).toBe('skip');
  });

  it('syarat 5+ tahun = skip; 3 tahun = paling tinggi maybe', () => {
    expect(scoreJob(job({ description: 'React Node.js. 5+ years of experience required.' }), PROFILE).verdict).toBe('skip');
    const three = scoreJob(job({ title: 'Full-Stack Developer', description: 'React Node.js TypeScript. 3 years of experience.' }), PROFILE);
    expect(three.verdict).not.toBe('apply');
    expect(three.warnings.join(' ')).toMatch(/3 tahun/);
  });

  it('tanpa syarat tahun & hampir tanpa keahlian cocok tidak boleh "apply"', () => {
    const r = scoreJob(job({ title: 'Software Engineer', tags: [], description: 'Build things with Rust and Elixir.' }), PROFILE);
    expect(r.verdict).not.toBe('apply');
  });

  it('lowongan lama (>30 hari) diturunkan, yang baru diberi nilai tambah', () => {
    const fresh = scoreJob(job({ postedAt: PROFILE.now - 86_400_000 }), PROFILE);
    const old = scoreJob(job({ postedAt: PROFILE.now - 45 * 86_400_000 }), PROFILE);
    expect(fresh.score).toBeGreaterThan(old.score);
    expect(old.warnings.join(' ')).toMatch(/hari/);
  });

  it('keahlian cocok dihitung per kata utuh (java tidak cocok dengan javascript)', () => {
    const r = scoreJob(job({ title: 'Web Developer', tags: [], description: 'We use JavaScript and Rust only.' }), { ...PROFILE, skills: ['java'] });
    expect(r.matchedSkills).toEqual([]);
  });
});

// --------------------------------------------------------------- store

const makeStore = (now = () => 1_000_000) => new CareerStore(new Database(':memory:'), { now });

describe('CareerStore', () => {
  it('upsert: baru -> inserted; yang sama -> diperbarui, status pengguna tidak tertimpa', () => {
    const s = makeStore();
    const j = job({ source: 'x', extId: '1' });
    const a = s.upsertJob(j, scoreJob(j, PROFILE));
    expect(a.inserted).toBe(true);
    s.setStatus(a.id, 'applied', 'dikirim manual');
    const b = s.upsertJob(j, scoreJob(j, PROFILE));
    expect(b).toMatchObject({ inserted: false, id: a.id });
    expect(s.getJob(a.id)).toMatchObject({ status: 'applied', notes: 'dikirim manual' });
  });

  it('listJobs: urut apply > maybe > skip lalu skor; filter & total', () => {
    const s = makeStore();
    const add = (title, verdict, score) => s.upsertJob(job({ extId: title, title }), { score, verdict, eligibility: 'yes', reasons: [], warnings: [] });
    add('c', 'skip', 90); add('a', 'apply', 70); add('b', 'maybe', 80); add('d', 'apply', 75);
    expect(s.listJobs().jobs.map((x) => x.title)).toEqual(['d', 'a', 'b', 'c']);
    expect(s.listJobs({ verdict: 'apply' }).total).toBe(2);
    expect(s.listJobs({ q: 'b' }).jobs.map((x) => x.title)).toEqual(['b']);
    expect(s.listJobs({ minScore: 76 }).jobs.map((x) => x.title)).toEqual(['b', 'c']);
  });

  it('status tidak valid ditolak', () => {
    const s = makeStore();
    const a = s.upsertJob(job({ extId: 'z' }), { score: 1, verdict: 'skip', eligibility: 'no', reasons: [], warnings: [] });
    expect(() => s.setStatus(a.id, 'hacked')).toThrow(/tidak valid/);
  });

  it('activity: terbaru dulu, afterId untuk polling, judul kosong diabaikan', () => {
    const s = makeStore();
    s.log({ agent: 'career', title: 'satu' }); s.log({ agent: 'market', title: 'dua', level: 'good' }); s.log({ title: '' });
    const all = s.activity();
    expect(all.map((x) => x.title)).toEqual(['dua', 'satu']);
    expect(s.activity({ afterId: all[1].id }).map((x) => x.title)).toEqual(['dua']);
    expect(s.activity({ agent: 'market' })).toHaveLength(1);
  });
});

// --------------------------------------------------------------- service

function makeService({ jobs, notify, chat = '55555', now, env = {} } = {}) {
  let clock = now ?? Date.parse('2026-10-16T05:00:00Z'); // 12:00 WIB
  const store = makeStore(() => clock);
  const sources = [{ id: 's1', label: 'S1', fetch: async () => jobs }];
  const svc = createCareer({
    store, sources, notify, chatId: () => chat, now: () => clock,
    getProfile: () => ({ skills: 'React, Node.js, PostgreSQL, TypeScript' }), env: { CAREER_GREENHOUSE_BOARDS: '', ...env },
  });
  return { svc, store, tick: (ms) => { clock += ms; } };
}

describe('CareerService.scan', () => {
  const good = (n, over = {}) => job({ source: 's1', extId: `g${n}`, url: `https://x/${n}`, title: `Junior Full Stack Developer ${n}`, postedAt: Date.parse('2026-10-16T01:00:00Z'), ...over });

  it('menyimpan, menilai, dan melaporkan yang layak ke Telegram sekali saja', async () => {
    const notify = vi.fn(async () => {});
    const { svc, store } = makeService({ jobs: [good(1), good(2), job({ source: 's1', extId: 'bad', url: 'https://x/b', title: 'Account Executive' })], notify });
    const r = await svc.scan();
    expect(r).toMatchObject({ fetched: 3, fresh: 3, apply: 2, announced: 2 });
    expect(notify).toHaveBeenCalledTimes(1);
    const [chat, text] = notify.mock.calls[0];
    expect(chat).toBe('55555');
    expect(text).toContain('Junior Full Stack Developer 1');
    expect(text).toContain('https://x/1');
    expect(text).not.toContain('Account Executive');

    const again = await svc.scan();
    expect(again).toMatchObject({ fresh: 0, announced: 0 });
    expect(notify).toHaveBeenCalledTimes(1); // tidak mengulang laporan yang sama
    expect(store.stats()).toMatchObject({ total: 3, apply: 2 });
  });

  it('aktivitas tercatat: mulai, selesai, laporan terkirim', async () => {
    const { svc, store } = makeService({ jobs: [good(1)], notify: async () => {} });
    await svc.scan();
    const kinds = store.activity().map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['scan_start', 'scan', 'digest']));
  });

  it('jam tenang (22.00-06.00 WIB): laporan ditahan, lalu dikirim paginya', async () => {
    const notify = vi.fn(async () => {});
    const night = Date.parse('2026-10-16T18:00:00Z'); // 01:00 WIB
    const { svc, tick } = makeService({ jobs: [good(1)], notify, now: night });
    expect(inQuietHours(night)).toBe(true);
    expect((await svc.scan()).announced).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    tick(7 * 3_600_000); // 08:00 WIB
    expect((await svc.scan()).announced).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('Telegram gagal: tidak ditandai terkirim, dicoba lagi di pemindaian berikut', async () => {
    const notify = vi.fn().mockRejectedValueOnce(new Error('telegram down')).mockResolvedValue(undefined);
    const { svc, store } = makeService({ jobs: [good(1)], notify });
    expect((await svc.scan()).announced).toBe(0);
    expect(store.activity().some((a) => a.level === 'warn' && /gagal terkirim/.test(a.title))).toBe(true);
    expect((await svc.scan()).announced).toBe(1);
  });

  it('tanpa notifier / chat id: tetap menyimpan, tidak mengirim, tidak menandai', async () => {
    const { svc, store } = makeService({ jobs: [good(1)], notify: null });
    expect((await svc.scan()).announced).toBe(0);
    expect(store.unannounced()).toHaveLength(1);
  });

  it('sumber gagal dicatat sebagai peringatan, sumber lain tetap diproses', async () => {
    const store = makeStore();
    const sources = [
      { id: 'ok', label: 'OK', fetch: async () => [good(1)] },
      { id: 'down', label: 'DOWN', fetch: async () => { throw new Error('HTTP 503'); } },
    ];
    const svc = createCareer({ store, sources, getProfile: () => ({ skills: 'react' }), env: {} });
    const r = await svc.scan({ announce: false });
    expect(r.fresh).toBe(1);
    expect(store.activity().some((a) => a.kind === 'source_error' && a.ref === 'down')).toBe(true);
  });

  it('dua pemindaian bersamaan memakai satu proses yang sama', async () => {
    let calls = 0;
    const store = makeStore();
    const svc = createCareer({ store, sources: [{ id: 'x', label: 'X', fetch: async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return []; } }], env: {} });
    await Promise.all([svc.scan({ announce: false }), svc.scan({ announce: false })]);
    expect(calls).toBe(1);
  });

  it('CAREER_RADAR=off mematikan penjadwal', () => {
    const { svc } = makeService({ jobs: [], env: { CAREER_RADAR: 'off' } });
    expect(svc.start()).toBe(false);
  });
});

// --------------------------------------------------------------- HTTP

describe('HTTP /api/career', () => {
  async function app() {
    const { svc } = makeService({ jobs: [
      job({ source: 's1', extId: 'a', url: 'https://x/a', title: 'Junior Full Stack Developer', postedAt: Date.parse('2026-10-16T01:00:00Z') }),
      job({ source: 's1', extId: 'b', url: 'https://x/b', title: 'Senior Backend Engineer' }),
    ] });
    await svc.scan({ announce: false });
    return { svc, http: express().use('/api/career', createCareerRouter({ career: svc })) };
  }

  it('status, daftar & filter', async () => {
    const { http } = await app();
    expect((await request(http).get('/api/career/status')).body).toMatchObject({ enabled: true, total: 2, apply: 1 });
    const apply = await request(http).get('/api/career/jobs').query({ verdict: 'apply' });
    expect(apply.body.total).toBe(1);
    expect(apply.body.jobs[0].title).toBe('Junior Full Stack Developer');
    expect((await request(http).get('/api/career/jobs').query({ verdict: 'hack' })).status).toBe(400);
  });

  it('detail & perubahan status (tercatat di aktivitas), status ngawur ditolak', async () => {
    const { http } = await app();
    const list = (await request(http).get('/api/career/jobs').query({ verdict: 'apply' })).body.jobs;
    const id = list[0].id;
    expect((await request(http).get(`/api/career/jobs/${id}`)).body.description).toContain('React');
    expect((await request(http).get('/api/career/jobs/99999')).status).toBe(404);

    const ok = await request(http).post(`/api/career/jobs/${id}/status`).send({ status: 'interview', notes: 'HR call Senin' });
    expect(ok.body.job).toMatchObject({ status: 'interview', notes: 'HR call Senin' });
    expect((await request(http).post(`/api/career/jobs/${id}/status`).send({ status: 'pwned' })).status).toBe(400);
    const act = (await request(http).get('/api/career/activity')).body.items;
    expect(act.some((a) => a.kind === 'status' && a.level === 'good')).toBe(true);
  });

  it('lewat proxy tanpa token ditolak; dengan token benar diterima', async () => {
    const { svc } = await app();
    const guarded = express().use('/api/career', createCareerRouter({ career: svc, env: { AUTOMATION_TOKEN: 'rahasia-uji-123456' } }));
    const viaProxy = (r) => r.set('X-Forwarded-For', '203.0.113.9');
    expect((await viaProxy(request(guarded).get('/api/career/status'))).status).toBe(401);
    expect((await viaProxy(request(guarded).get('/api/career/status')).set('X-Automation-Token', 'salah')).status).toBe(401);
    expect((await viaProxy(request(guarded).get('/api/career/status')).set('X-Automation-Token', 'rahasia-uji-123456')).status).toBe(200);
    const noSecret = express().use('/api/career', createCareerRouter({ career: svc, env: {} }));
    expect((await viaProxy(request(noSecret).get('/api/career/status'))).status).toBe(403);
  });

  it('scan mengembalikan 202 dan tidak menumpuk', async () => {
    const { http } = await app();
    expect((await request(http).post('/api/career/scan').send({})).status).toBe(202);
  });
});

// --------------------------------------------------------------- perintah Telegram/WhatsApp

import { quickCareer } from '../src/career/quick.js';

describe('quickCareer (perintah bahasa biasa)', () => {
  async function seeded() {
    const { svc } = makeService({ jobs: [
      job({ source: 's1', extId: 'a', url: 'https://x/a', title: 'Junior Full Stack Developer', postedAt: Date.parse('2026-10-16T01:00:00Z') }),
      job({ source: 's1', extId: 'b', url: 'https://x/b', title: 'Senior Backend Engineer' }),
    ] });
    await svc.scan({ announce: false });
    return svc;
  }

  it('"lowongan baru" menampilkan yang cocok lengkap dengan tautan', async () => {
    const svc = await seeded();
    for (const q of ['lowongan baru', 'ada lowongan cocok?', 'loker hari ini', 'lowongan apa yang cocok', 'radar lowongan']) {
      const r = await quickCareer(svc, q);
      expect(r, q).toContain('Junior Full Stack Developer');
      expect(r, q).toContain('https://x/a');
      expect(r, q).not.toContain('Senior Backend');
    }
  });

  it('kosong -> jawaban jujur, bukan karangan', async () => {
    const { svc } = makeService({ jobs: [] });
    expect(await quickCareer(svc, 'lowongan baru')).toMatch(/Belum ada lowongan/);
  });

  it('"status lamaran" merangkum angka dari database', async () => {
    const svc = await seeded();
    const id = svc.store.listJobs({ verdict: 'apply' }).jobs[0].id;
    svc.store.setStatus(id, 'applied');
    const r = await quickCareer(svc, 'status lamaran');
    expect(r).toMatch(/2 lowongan terpantau/);
    expect(r).toMatch(/sudah dilamar: 1/);
  });

  it('"pindai lowongan sekarang" memulai pemindaian tanpa menumpuk', async () => {
    const svc = await seeded();
    const spy = vi.spyOn(svc, 'scan').mockResolvedValue({});
    expect(await quickCareer(svc, 'pindai lowongan sekarang')).toMatch(/pindai semua sumber/);
    expect(spy).toHaveBeenCalledTimes(1);
    svc.running = true;
    expect(await quickCareer(svc, 'cari lowongan sekarang')).toMatch(/masih berjalan/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('kalimat lain yang menyebut lowongan TIDAK dibajak (diteruskan ke model)', async () => {
    const svc = await seeded();
    for (const q of [
      'buatkan cover letter untuk lowongan backend di Vercel',
      'tolong ingatkan saya besok interview lowongan di Gitlab jam 9',
      'kenapa lowongan itu ditolak?',
      'halo', 'apa kabar?', 'lowongan', '',
      'x'.repeat(200),
    ]) {
      const r = await quickCareer(svc, q);
      if (q === 'lowongan') expect(r).not.toBeNull(); // kata tunggal ini sah: setara "lowongan baru"
      else expect(r, q).toBeNull();
    }
  });
});
