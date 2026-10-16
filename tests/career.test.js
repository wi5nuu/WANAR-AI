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
import { extractLiteral, parseProfileTs, normalizeProfile, importPortfolio } from '../src/career/portfolio.js';
import { validateFacts, loadFacts, cleanSkill, skillsFromFacts, experienceMonths, factSummary } from '../src/career/facts.js';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

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
    getProfile: () => ({ skills: 'React, Node.js, PostgreSQL, TypeScript' }), env: { CAREER_GREENHOUSE_BOARDS: '', CAREER_TELEGRAM: 'on', CAREER_INSTANT_DIGEST: 'on', ...env },
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

  it('GET /report: teks laporan harian + angka di baliknya', async () => {
    const { http } = await app();
    const r = (await request(http).get('/api/career/report')).body;
    expect(r.text).toMatch(/^Laporan harian agent/);
    expect(r.facts).toMatchObject({ newJobs: 2, newApply: 1, applied: 0, stalled: false });
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


// --------------------------------------------------------------- laporan harian, penjaga 24 jam

const D = (iso) => Date.parse(iso); // WIB = UTC+7: '2026-10-16T12:00:00Z' = 19.00 WIB

describe('laporan harian (satu pesan, jam 19.00 WIB)', () => {
  const jobs = [job({ source: 's1', extId: 'a', url: 'https://x/a', title: 'Junior Full Stack Developer', postedAt: D('2026-10-16T01:00:00Z') })];

  it('pemindaian tidak lagi mengirim pesan per pemindaian (bawaan: mati)', async () => {
    const notify = vi.fn(async () => {});
    const { svc } = makeService({ jobs, notify, env: { CAREER_INSTANT_DIGEST: '' } });
    expect((await svc.scan()).announced).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('instance yang tidak dinyalakan untuk Telegram (mis. laptop) tidak pernah mengirim', async () => {
    const notify = vi.fn(async () => {});
    const { svc } = makeService({ jobs, notify, now: D('2026-10-16T12:30:00Z'), env: { CAREER_TELEGRAM: '' } });
    await svc.scan();
    expect(await svc.dailyReport()).toBe('off');
    expect(await svc.dailyReport({ force: true })).toBe('off');
    expect(notify).not.toHaveBeenCalled();
  });

  it('belum jam 19.00 = tidak kirim; setelahnya kirim SEKALI per hari, selamat dari restart', async () => {
    const notify = vi.fn(async () => {});
    const { svc, store, tick } = makeService({ jobs, notify, now: D('2026-10-16T11:30:00Z'), env: { CAREER_INSTANT_DIGEST: '' } }); // 18.30 WIB
    await svc.scan();
    expect(await svc.dailyReport()).toBe('not_yet');
    tick(45 * 60_000); // 19.15 WIB
    expect(await svc.dailyReport()).toBe('sent');
    expect(await svc.dailyReport()).toBe('already');
    // proses baru memakai database yang sama (restart/deploy): tetap tidak mengirim ulang
    const again = createCareer({ store, sources: [], notify, chatId: () => '55555', now: () => D('2026-10-16T13:00:00Z'), env: { CAREER_TELEGRAM: 'on' } });
    expect(await again.dailyReport()).toBe('already');
    expect(notify).toHaveBeenCalledTimes(1);
    tick(24 * 3_600_000); // besok 19.15 WIB
    expect(await svc.dailyReport()).toBe('sent');
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('isi laporan: ringkas, angka lamaran, kabar baik, kesehatan, dan satu hal untuk diputuskan', async () => {
    const { svc } = makeService({ jobs, notify: async () => {}, now: D('2026-10-16T12:00:00Z') });
    await svc.scan();
    const { text } = svc.reportText();
    expect(text).toMatch(/^Laporan harian agent - Jumat, 16 Okt \(19\.00 WIB\)/);
    expect(text).toContain('Lamaran: 0 terkirim dalam 24 jam (total 0)');
    expect(text).toContain('Kabar baik: belum ada');
    expect(text).toMatch(/Radar: 1 lowongan baru dibaca, 1 layak dilamar, 0 perlu dicek/);
    expect(text).toMatch(/Kesehatan: aktif terus \(1 pemindaian, terakhir 19\.00 WIB, restart 0x/);
    expect(text).toContain('Menunggu keputusan Mas: 1 lowongan layak dilamar');
    expect(text.length).toBeLessThan(900); // terbaca dalam sepuluh detik
  });

  it('kabar baik & lamaran terkirim dihitung dari status yang berubah dalam 24 jam', async () => {
    const mk = (n) => job({ source: 's1', extId: n, url: `https://x/${n}`, title: `Junior Full Stack Developer ${n}` });
    const { svc, store, tick } = makeService({ jobs: [mk('a'), mk('b'), mk('c')], notify: async () => {}, now: D('2026-10-16T05:00:00Z') });
    await svc.scan();
    const ids = store.listJobs().jobs.map((j) => j.id);
    store.setStatus(ids[0], 'applied'); store.setStatus(ids[1], 'interview'); store.setStatus(ids[2], 'offer');
    tick(3_600_000);
    const { text, facts } = svc.reportText();
    expect(text).toContain('Lamaran: 1 terkirim dalam 24 jam (total 3)');
    expect(text).toContain('Kabar baik: 1 penawaran kerja, 1 undangan wawancara');
    expect(facts).toMatchObject({ applied: 1, interview: 1, offer: 1 });
    expect(text).toContain('Tidak ada yang perlu Mas putuskan sekarang.');
  });

  it('modul lain menambah baris lewat addCountSection; hanya muncul bila ada isinya', async () => {
    const { svc, store } = makeService({ jobs: [], notify: async () => {}, now: D('2026-10-16T12:00:00Z') });
    svc.addCountSection('Pasar', 'alarm harga tercapai', 'market', 'alert_fired');
    expect(svc.reportText().text).not.toContain('Pasar:');
    store.log({ agent: 'market', kind: 'alert_fired', title: 'x' }); store.log({ agent: 'market', kind: 'alert_fired', title: 'y' });
    expect(svc.reportText().text).toContain('Pasar: 2 alarm harga tercapai');
  });

  it('bagian laporan yang rusak tidak menggagalkan laporan', async () => {
    const { svc } = makeService({ jobs: [], notify: async () => {}, now: D('2026-10-16T12:00:00Z') });
    svc.sections.push(() => { throw new Error('boom'); });
    expect(svc.reportText().text).toContain('Kesehatan:');
  });

  it('gagal kirim dicoba lagi paling banyak 3 kali; perintah manual tetap bisa', async () => {
    const notify = vi.fn().mockRejectedValue(new Error('telegram down'));
    const { svc } = makeService({ jobs: [], notify, now: D('2026-10-16T12:30:00Z') });
    expect(await svc.dailyReport()).toBe('failed');
    expect(await svc.dailyReport()).toBe('failed');
    expect(await svc.dailyReport()).toBe('failed');
    expect(notify).toHaveBeenCalledTimes(3);
    expect(await svc.dailyReport()).toBe('failed'); // jatah habis: tidak memberondong
    expect(notify).toHaveBeenCalledTimes(3);
    notify.mockResolvedValue(undefined);
    expect(await svc.dailyReport({ force: true })).toBe('sent');
  });
});

describe('penjaga 24 jam (watchdog)', () => {
  it('radar diam > 2 interval: dicatat, pemindaian dinyalakan ulang, pemilik diberi tahu SEKALI', async () => {
    const notify = vi.fn(async () => {});
    const jobs = [job({ source: 's1', extId: 'a', url: 'https://x/a', title: 'Junior Full Stack Developer', postedAt: D('2026-10-16T01:00:00Z') })];
    const { svc, store, tick } = makeService({ jobs, notify, now: D('2026-10-16T01:00:00Z') });
    await svc.scan({ announce: false });
    tick(13 * 3_600_000); // 13 jam tanpa pemindaian (interval 6 jam)
    await svc.tick();
    expect(store.activity().some((a) => a.kind === 'stalled')).toBe(true);
    await svc._scanning; // pemindaian ulang yang dipicu penjaga
    await svc.tick(); await svc.tick();
    expect(notify.mock.calls.filter(([, t]) => /berhenti memindai/.test(t))).toHaveLength(1);
    expect(store.activity().some((a) => a.kind === 'recovered')).toBe(true); // sudah memindai lagi: pulih tercatat
  });

  it('radar sehat: tidak ada peringatan', async () => {
    const notify = vi.fn(async () => {});
    const { svc, store, tick } = makeService({ jobs: [], notify, now: D('2026-10-16T03:00:00Z') });
    svc.startedAt = D('2026-10-16T03:00:00Z');
    await svc.scan({ announce: false });
    tick(5 * 3_600_000);
    await svc.tick();
    expect(store.activity().some((a) => a.kind === 'stalled')).toBe(false);
  });
});

describe('perintah "laporan agent"', () => {
  it('menjawab dengan laporan yang sama; tidak membajak kalimat lain', async () => {
    const { svc } = makeService({ jobs: [], notify: async () => {}, now: D('2026-10-16T12:00:00Z') });
    for (const q of ['laporan agent', 'rekap harian agen', 'laporan kerja agent', 'agent hari ini ngapain aja?', 'agen kerja apa']) {
      expect(await quickCareer(svc, q), q).toMatch(/^Laporan harian agent/);
    }
    for (const q of ['laporan keuangan bulan ini', 'buat laporan harian untuk kantor', 'agent saya error', 'laporan']) {
      expect(await quickCareer(svc, q), q).toBeNull();
    }
  });
});

// --------------------------------------------------------------- portofolio -> lembar fakta

const PROFILE_TS = `
interface Profile { personalInfo: { name: string } }
// komentar { dengan kurung
export const profile: Profile = {
  personalInfo: { name: "Wisnu Contoh", role: "Full-Stack Engineer", location: "Bekasi", tagline: "t", summary: "Ringkasan {dengan} kurung", email: "a@b.c", phone: "+62", linkedin: "l", github: "g", website: "https://contoh.my.id" },
  skills: {
    programming: [{ name: "Python", icon: "python" }, { name: "Golang" }],
    webTech: [{ name: "Next.js", icon: "n" }, { name: "React" }, { name: "Technical SEO" }],
    aiMl: [{ name: "MCP (Model Context Protocol)" }, { name: "RAG & LLM Integration" }],
    securityCloud: [{ name: "Cloudflare (WAF, DNS & SSL)" }],
    tools: [{ name: "Node.js" }],
    soft: [{ name: "Teamwork" }]
  },
  experience: [
    { role: "Software Developer Intern", company: "PT A", type: "Internship", duration: "August 2026 - December 2026", location: "x", description: "d", skills: ["PHP", "Agile", "SDLC"] },
    { role: "Full Stack Engineer", company: "Toko", type: "Self-employed", duration: "December 2025 - Present", location: "x", description: "d", skills: ["Laravel"] },
    { role: "Web Development Intern", company: "B", type: "Internship", duration: "April 2026 - July 2026", location: "x", description: "d", skills: ["WordPress"] }
  ],
  organizationalExperience: [{ role: "Member", company: "Org", type: "Organization", duration: "2026", location: "x", description: "d", skills: [] }],
  projects: [{ title: "P1", role: "dev", status: "Production", link: "https://p1", description: "d", techStack: ["Next.js 16", "PostgreSQL 16", "Redis 7", "Go (Golang)", "JWT"] }],
  education: { institution: "Univ", degree: "S1", duration: "2023-2027", location: "Bekasi", focus: "IT" },
  educationHistory: ["SMA"], organization: [],
  certifications: [{ name: "C1", issuer: "I", date: "2026", id: "x", description: "d" }],
  competitions: [], openSource: []
};
export const other = { a: 1 };
`;

describe('portfolio.js (membaca profile.ts)', () => {
  it('extractLiteral: kurung dalam string/komentar tidak mengacaukan pencocokan', () => {
    const lit = extractLiteral(PROFILE_TS);
    expect(lit.startsWith('{')).toBe(true);
    expect(lit.trim().endsWith('}')).toBe(true);
    expect(lit).not.toContain('export const other');
    expect(parseProfileTs(PROFILE_TS).personalInfo.summary).toContain('{dengan}');
  });

  it('literal berbahaya tidak bisa menjalankan kode (sandbox kosong)', () => {
    expect(() => parseProfileTs('export const profile: P = { a: process.exit(1) };')).toThrow();
    expect(() => parseProfileTs("export const profile: P = { a: require('fs').readFileSync('x') };")).toThrow();
    expect(() => parseProfileTs('export const profile: P = { a: (() => { while(true){} })() };')).toThrow();
    expect(() => parseProfileTs('const nothing = 1;')).toThrow(/tidak ditemukan/);
  });

  it('importPortfolio dari folder: membaca HANYA src/data/profile*.ts, tidak membuka .env', () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wanar-pf-'));
    nodeFs.mkdirSync(nodePath.join(dir, 'src', 'data'), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, 'src', 'data', 'profile.ts'), PROFILE_TS);
    nodeFs.writeFileSync(nodePath.join(dir, '.env'), 'RAHASIA_JANGAN_DIBACA=abc123');
    nodeFs.writeFileSync(nodePath.join(dir, 'src', 'data', 'backupdatesocialregis'), 'password=hunter2');
    const facts = importPortfolio(dir, { now: new Date('2026-10-16T00:00:00Z') });
    expect(facts).toMatchObject({ version: 1, importedAt: '2026-10-16T00:00:00.000Z', id: null });
    expect(JSON.stringify(facts)).not.toMatch(/RAHASIA|hunter2|abc123/);
    expect(validateFacts(facts).ok).toBe(true);
    expect(() => importPortfolio(nodePath.join(dir, 'kosong'))).toThrow(/tidak ditemukan/);
  });
});

describe('facts.js (lembar fakta di run time)', () => {
  const facts = { version: 1, importedAt: 'x', en: normalizeProfile(parseProfileTs(PROFILE_TS)), id: null };

  it('validateFacts menolak data rusak', () => {
    expect(validateFacts(facts).ok).toBe(true);
    expect(validateFacts(null).ok).toBe(false);
    expect(validateFacts({ ...facts, version: 2 }).ok).toBe(false);
    expect(validateFacts({ version: 1, en: { personalInfo: { name: 'x' }, experience: [], projects: [], skills: {} } }).errors.join()).toMatch(/keahlian kosong/);
  });

  it('cleanSkill & skillsFromFacts: versi/kurung dibuang, filler dibuang, varian nextjs ditambah', () => {
    expect(cleanSkill('Next.js 16')).toBe('next.js');
    expect(cleanSkill('Cloudflare (WAF, DNS & SSL)')).toBe('cloudflare');
    expect(cleanSkill('Go (Golang)')).toBe('golang');
    expect(cleanSkill('PostgreSQL 16')).toBe('postgresql');
    const sk = skillsFromFacts(facts);
    expect(sk).toEqual(expect.arrayContaining(['python', 'golang', 'next.js', 'nextjs', 'react', 'mcp', 'rag', 'llm integration', 'cloudflare', 'node.js', 'php', 'laravel', 'postgresql', 'redis']));
    for (const noise of ['teamwork', 'agile', 'sdlc', 'jwt']) expect(sk).not.toContain(noise);
    expect(new Set(sk).size).toBe(sk.length);
  });

  it('experienceMonths: gabungan periode tumpang tindih, dibatasi sampai "sekarang", organisasi tidak dihitung', () => {
    // Des 2025 - sekarang (16 Okt 2026) mencakup Apr-Jul 2026; Agu-Des 2026 dipotong di "sekarang"
    expect(experienceMonths(facts, D('2026-10-16T00:00:00Z'))).toBe(10);
    expect(experienceMonths(facts, D('2025-06-01T00:00:00Z'))).toBe(0);
    expect(experienceMonths({ en: { experience: [] } })).toBe(0);
    expect(experienceMonths(null)).toBe(0);
  });

  it('factSummary hanya berisi hitungan, bukan data pribadi', () => {
    const s = factSummary(facts, D('2026-10-16T00:00:00Z'));
    expect(s).toMatchObject({ experience: 3, organizations: 1, projects: 1, certifications: 1, professionalMonths: 10, hasIndonesian: false });
    expect(JSON.stringify(s)).not.toMatch(/Wisnu|a@b\.c|\+62/);
  });

  it('loadFacts: file hilang / rusak = null (bukan error), dan cache mengikuti perubahan file', () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wanar-ff-'));
    const file = nodePath.join(dir, 'owner-facts.json');
    expect(loadFacts(file)).toBeNull();
    nodeFs.writeFileSync(file, '{ bukan json');
    expect(loadFacts(file)).toBeNull();
    nodeFs.writeFileSync(file, JSON.stringify(facts));
    nodeFs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(loadFacts(file)?.en.personalInfo.name).toBe('Wisnu Contoh');
  });

  it('service.profile menggabungkan keahlian profil lama dengan portofolio', () => {
    const { svc } = makeService({ jobs: [] });
    svc.getFacts = () => facts;
    const p = svc.profile();
    expect(p.skills).toEqual(expect.arrayContaining(['react', 'laravel', 'cloudflare']));
  });
});

// --------------------------------------------------------------- peringatan kanal terputus

import { channelWarnings } from '../src/career/health.js';

describe('channelWarnings (setelan yang hilang diam-diam harus terlihat)', () => {
  const reg = (modes) => ({ has: (id) => id in modes, get: (id) => ({ mode: modes[id] }) });

  it('semua tersambung: tidak ada baris', () => {
    expect(channelWarnings(reg({ email: 'live', telegram: 'live' }))).toEqual([]);
  });

  it('email dry-run: peringatan jelas dengan akibatnya; Telegram sehat tidak disebut', () => {
    const w = channelWarnings(reg({ email: 'dry-run', telegram: 'live' }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/PERHATIAN: Email belum tersambung \(mode dry-run\).*tidak terkirim/);
  });

  it('kanal yang tidak terdaftar atau registri rusak tidak melempar galat', () => {
    expect(channelWarnings(reg({}))).toEqual([]);
    expect(channelWarnings({ has: () => { throw new Error('boom'); }, get: () => null })).toEqual([]);
  });

  it('masuk ke laporan harian lewat sections', async () => {
    const { svc } = makeService({ jobs: [], notify: async () => {}, now: Date.parse('2026-10-16T12:00:00Z') });
    svc.sections.push(() => channelWarnings(reg({ email: 'dry-run' })));
    expect(svc.reportText().text).toContain('PERHATIAN: Email belum tersambung');
  });
});
