/**
 * Test Suite: paket lamaran — surat lamaran dirakit HANYA dari fakta portofolio pemilik (tidak boleh
 * menyebut keahlian/angka/pengalaman yang tidak ada di lembar fakta), jawaban standar, hal yang hanya
 * bisa dijawab pemilik, rute HTTP, perintah Telegram, dan perbaikan pembacaan deskripsi Greenhouse.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { coverLetter, buildKit, kitMessage, matchedFactSkills } from '../src/career/kit.js';
import { CareerStore } from '../src/career/store.js';
import { createCareer } from '../src/career/service.js';
import { createCareerRouter } from '../src/career/routes.js';
import { quickCareer } from '../src/career/quick.js';

const NOW = Date.parse('2026-10-16T05:00:00Z');

const FACTS = {
  version: 1, importedAt: 'x',
  en: {
    personalInfo: { name: 'Wisnu Alfian Nur Ashar', role: 'Full-Stack Engineer', location: 'Bekasi, West Java, Indonesia', email: 'portfolio@contoh.id', phone: '+62 813-0000-0000', linkedin: 'https://linkedin.com/in/wisnu', github: 'https://github.com/wi5nuu', website: 'https://contoh.my.id' },
    skills: { programming: ['Python', 'PHP', 'Golang', 'PostgreSQL'], webTech: ['React', 'Next.js', 'TypeScript', 'Tailwind CSS', 'Laravel'], aiMl: [], securityCloud: ['Docker', 'Cloudflare (WAF, DNS & SSL)'], tools: ['Node.js'], soft: ['Teamwork'] },
    experience: [
      { role: 'Software Developer Intern', company: 'PT Contoh', type: 'Internship', duration: 'August 2026 - December 2026', location: 'x', description: 'd', skills: ['PHP', 'Node.js'] },
      { role: 'Full Stack Engineer', company: 'Toko Contoh', type: 'Self-employed', duration: 'December 2025 - Present', location: 'x', description: 'd', skills: ['Laravel', 'Next.js', 'PostgreSQL'] },
      { role: 'Web Development Intern', company: 'GAOTEK', type: 'Internship', duration: 'April 2026 - July 2026', location: 'x', description: 'Built and maintained responsive WordPress websites using PHP, HTML and CSS. Applied SEO best practices.', skills: ['PHP', 'WordPress', 'SEO'] },
    ],
    organizationalExperience: [],
    projects: [
      { title: 'Toko Contoh', role: 'dev', status: 'Production', link: '', github: '', description: 'Official E-Commerce platform serving 15,000+ partners. Optimized for scale.', techStack: ['React', 'TypeScript', 'Cloudflare'] },
      { title: 'Finance-Requester', role: 'dev', status: 'Completed', link: '', github: '', description: 'Enterprise payment requisition system with approvals. Built with Docker.', techStack: ['Next.js 16', 'Laravel 12', 'PostgreSQL 16', 'Docker'] },
      { title: 'ColonyAI', role: 'dev', status: 'Completed', link: '', github: '', description: 'Computer vision tool for plate counting.', techStack: ['YOLOv8', 'OpenCV'] },
    ],
    education: { institution: 'President University', degree: 'Bachelor of Information Technology', duration: '2023-2027', location: 'Bekasi', focus: 'Software Engineering' },
    educationHistory: [], certifications: [], competitions: [], openSource: [],
  },
  id: null,
};

const JOB = (over = {}) => ({
  id: 5, title: 'Full Stack Developer', company: 'Acme', url: 'https://boards.example/acme/1', location: 'Worldwide', score: 74, eligibility: 'yes',
  tags: ['react'], description: 'We use React, Next.js, TypeScript and PostgreSQL. Experience with Rust and Kubernetes is a plus.', ...over,
});

describe('coverLetter: hanya fakta pemilik', () => {
  it('menyebut keahlian yang dimiliki dan diminta, memakai tulisan pemilik; tidak menyebut yang tidak ia miliki', () => {
    const l = coverLetter(JOB(), FACTS, { now: NOW });
    expect(l.text).toContain('Dear Acme Hiring Team,');
    expect(l.text).toContain('Full Stack Developer position');
    for (const s of ['React', 'Next.js', 'TypeScript', 'PostgreSQL']) expect(l.text, s).toContain(s);
    // diminta lowongan tetapi TIDAK ada di portofolio: tidak boleh muncul
    for (const s of ['Rust', 'Kubernetes']) expect(l.text, s).not.toContain(s);
    expect(l.skills).toEqual(expect.arrayContaining(['React', 'Next.js', 'TypeScript', 'PostgreSQL']));
  });

  it('proyek relevan dikutip persis dari kalimat pertama deskripsi di portofolio', () => {
    const l = coverLetter(JOB(), FACTS, { now: NOW });
    expect(l.text).toContain('- Toko Contoh (Production): Official E-Commerce platform serving 15,000+ partners.');
    expect(l.text).toContain('- Finance-Requester (Completed): Enterprise payment requisition system with approvals.');
    expect(l.text).not.toContain('ColonyAI'); // tidak relevan dengan lowongan ini
    expect(l.text).not.toContain('Optimized for scale'); // hanya kalimat pertama
  });

  it('pengalaman kerja yang relevan dikutip persis dari portofolio (kalimat pertama), hanya bila keahliannya beririsan', () => {
    const wp = coverLetter(JOB({ title: 'WordPress Developer', tags: [], description: 'PHP and WordPress sites for clients.' }), FACTS, { now: NOW });
    expect(wp.text).toContain('Relevant experience:');
    expect(wp.text).toContain('- Web Development Intern, GAOTEK: Built and maintained responsive WordPress websites using PHP, HTML and CSS.');
    expect(wp.text).not.toContain('Applied SEO best practices'); // hanya kalimat pertama
    // lowongan React tanpa irisan dengan keahlian magang itu: blok pengalaman tidak muncul
    expect(coverLetter(JOB({ description: 'React and TypeScript only.', tags: [] }), FACTS, { now: NOW }).text).not.toContain('GAOTEK');
  });

  it('pengalaman = bulan kerja sebenarnya (gabungan, dibatasi sampai sekarang); tidak ada klaim "tahun"', () => {
    const l = coverLetter(JOB(), FACTS, { now: NOW });
    expect(l.text).toContain('about 10 months of hands-on professional experience (internships and self-employed full-stack work)');
    expect(l.text).not.toMatch(/\b\d+\+?\s*years?\b/i);
    expect(l.text).toContain('My most recent role is Software Developer Intern at PT Contoh.');
  });

  it('tautan portofolio/GitHub/LinkedIn dan tanda tangan berasal dari fakta', () => {
    const l = coverLetter(JOB(), FACTS, { now: NOW });
    expect(l.text).toContain('https://contoh.my.id | https://github.com/wi5nuu | https://linkedin.com/in/wisnu');
    expect(l.text.trim().endsWith('Wisnu Alfian Nur Ashar')).toBe(true);
    expect(l.text).toContain('I work remotely from Indonesia (UTC+7).');
  });

  it('tidak ada keahlian yang cocok: surat tetap jujur dan tidak mengarang keahlian', () => {
    const l = coverLetter(JOB({ title: 'Embedded Developer', tags: [], description: 'C firmware, RTOS, Zephyr.' }), FACTS, { now: NOW });
    expect(l.skills).toEqual([]);
    expect(l.text).not.toContain('Your posting asks for');
    expect(l.text).not.toContain('Relevant work:');
  });

  it('lowongan berbahasa Indonesia dijawab bahasa Indonesia bila fakta Indonesia tersedia', () => {
    const id = JSON.parse(JSON.stringify(FACTS.en));
    id.projects[0].description = 'Platform e-commerce resmi yang melayani 15.000+ mitra. Dioptimalkan untuk skala.';
    const facts = { ...FACTS, id };
    const l = coverLetter(JOB({ description: 'Kami mencari developer yang menguasai React dan PostgreSQL untuk bekerja dengan tim kami dan membangun produk untuk pelanggan.' }), facts, { now: NOW });
    expect(l.lang).toBe('id');
    expect(l.text).toContain('Yth. Tim Rekrutmen Acme,');
    expect(l.text).toContain('Platform e-commerce resmi yang melayani 15.000+ mitra.');
    // tanpa fakta Indonesia: tetap Inggris, tidak menerjemahkan sendiri
    expect(coverLetter(JOB({ description: 'Kami mencari developer React untuk tim kami dan produk untuk pelanggan.' }), FACTS, { now: NOW }).lang).toBe('en');
  });

  it('matchedFactSkills: judul/tag didahulukan, maksimal 5, tanpa duplikat nextjs', () => {
    const s = matchedFactSkills(JOB({ title: 'Laravel Developer', tags: [], description: 'React, Next.js, TypeScript, Docker, PostgreSQL, Python, PHP' }), FACTS);
    expect(s[0]).toBe('Laravel');
    expect(s).toHaveLength(5);
    expect(new Set(s.map((x) => x.toLowerCase())).size).toBe(5);
    expect(s.filter((x) => /^next/i.test(x))).toHaveLength(Math.min(1, s.filter((x) => /^next/i.test(x)).length));
  });
});

describe('buildKit', () => {
  it('jawaban standar: nama dipecah, email = kotak masuk yang dipantau agent, hal sensitif ke pemilik', () => {
    const kit = buildKit(JOB(), FACTS, { now: NOW, email: 'dipantau@gmail.com', resumeFile: 'CV.pdf' });
    expect(kit.ok).toBe(true);
    const a = Object.fromEntries(kit.answers.map((x) => [x.label, x.value]));
    expect(a['First name']).toBe('Wisnu');
    expect(a['Last name']).toBe('Alfian Nur Ashar');
    expect(a.Email).toBe('dipantau@gmail.com');
    expect(a.Country).toBe('Indonesia');
    expect(a['Professional experience']).toContain('10 months');
    expect(kit.resume).toEqual({ file: 'CV.pdf' });
    const need = kit.needsOwner.map((n) => n.label).join(' | ');
    for (const w of ['visa', 'gaji', 'mulai', 'Alasan']) expect(need).toContain(w);
    expect(kit.subject).toBe('Application: Full Stack Developer - Wisnu Alfian Nur Ashar');
  });

  it('email bawaan dari portofolio bila tidak ada kotak masuk yang dipantau', () => {
    expect(buildKit(JOB(), FACTS, { now: NOW }).answers.find((x) => x.label === 'Email').value).toBe('portfolio@contoh.id');
  });

  it('catatan: situs berpelindung bot, kelayakan belum pasti, tanpa keahlian cocok', () => {
    const wwr = buildKit(JOB({ url: 'https://weworkremotely.com/remote-jobs/x' }), FACTS, { now: NOW });
    expect(wwr.warnings.join(' ')).toMatch(/pemeriksaan bot/);
    expect(buildKit(JOB({ eligibility: 'maybe' }), FACTS, { now: NOW }).warnings.join(' ')).toMatch(/belum pasti/);
    expect(buildKit(JOB({ title: 'Embedded', tags: [], description: 'firmware' }), FACTS, { now: NOW }).warnings.join(' ')).toMatch(/tidak menyebut keahlian/);
    expect(buildKit(JOB(), FACTS, { now: NOW }).warnings).toEqual([]);
  });

  it('tanpa lembar fakta: gagal dengan pesan jelas (bukan surat kosong)', () => {
    expect(buildKit(JOB(), null)).toEqual({ ok: false, error: 'Lembar fakta portofolio belum ada.' });
  });

  it('kitMessage: ringkas, memuat tautan, surat, dan hal yang perlu jawaban pemilik', () => {
    const m = kitMessage(buildKit(JOB(), FACTS, { now: NOW, email: 'dipantau@gmail.com' }));
    expect(m).toContain('Paket lamaran: Full Stack Developer - Acme (skor 74)');
    expect(m).toContain('Buka: https://boards.example/acme/1');
    expect(m).toContain('SURAT LAMARAN');
    expect(m).toContain('Email: dipantau@gmail.com');
    expect(m).toContain('Perlu jawaban Mas sendiri:');
    expect(m.length).toBeLessThan(4000); // muat dalam satu pesan Telegram
    expect(kitMessage({ ok: false, error: 'gagal' })).toBe('gagal');
  });
});

// ------------------------------------------------------------------ service, routes, quick

function make({ facts = FACTS, env = {} } = {}) {
  const store = new CareerStore(new Database(':memory:'), { now: () => NOW });
  const svc = createCareer({ store, sources: [], getFacts: () => facts, env: { CAREER_TELEGRAM: '', ...env }, now: () => NOW, getProfile: () => ({ skills: 'react, php' }) });
  const job = { source: 's1', extId: 'a', url: 'https://boards.example/acme/1', title: 'Full Stack Developer', company: 'Acme', location: 'Worldwide', remote: true, tags: ['react'], seniority: null, salaryText: '', postedAt: NOW - 3_600_000, description: JOB().description, regions: [], timezones: [] };
  const id = store.upsertJob(job, { score: 74, verdict: 'apply', eligibility: 'yes', reasons: ['peran: full-stack'], warnings: [] }).id;
  return { svc, store, id };
}

describe('CareerService.kit & HTTP', () => {
  it('kit lowongan tersimpan; id tidak dikenal = tidak ditemukan', () => {
    const { svc, id } = make({ env: { IMAP_USER: 'agent@gmail.com' } });
    const kit = svc.kit(id);
    expect(kit.ok).toBe(true);
    expect(kit.answers.find((x) => x.label === 'Email').value).toBe('agent@gmail.com');
    expect(kit.resume).toBeNull(); // CV belum diunggah
    expect(svc.kit(999)).toMatchObject({ ok: false });
    expect(make({ facts: null }).svc.kit(1).ok).toBe(false);
  });

  it('APPLY_EMAIL menimpa kotak masuk IMAP; CV terdeteksi bila filenya ada', () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wanar-cv-'));
    const cv = nodePath.join(dir, 'CV_Test.pdf');
    nodeFs.writeFileSync(cv, '%PDF-1.4 uji');
    const { svc, id } = make({ env: { APPLY_EMAIL: 'lamaran@gmail.com', IMAP_USER: 'agent@gmail.com', OWNER_CV_FILE: cv } });
    const kit = svc.kit(id);
    expect(kit.answers.find((x) => x.label === 'Email').value).toBe('lamaran@gmail.com');
    expect(kit.resume).toEqual({ file: 'CV_Test.pdf' });
  });

  it('GET /jobs/:id/kit dan GET /cv', async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'wanar-cv-'));
    const cv = nodePath.join(dir, 'CV_Test.pdf');
    const { svc, id } = make({ env: { OWNER_CV_FILE: cv } });
    const http = express().use('/api/career', createCareerRouter({ career: svc }));
    const kit = (await request(http).get(`/api/career/jobs/${id}/kit`)).body;
    expect(kit).toMatchObject({ ok: true, job: { id, title: 'Full Stack Developer' } });
    expect(kit.coverLetter).toContain('Dear Acme Hiring Team');
    expect((await request(http).get('/api/career/jobs/9999/kit')).status).toBe(404);
    expect((await request(http).get('/api/career/cv')).status).toBe(404); // belum diunggah
    nodeFs.writeFileSync(cv, '%PDF-1.4 uji');
    const dl = await request(http).get('/api/career/cv');
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('CV_Test.pdf');
    const noFacts = make({ facts: null });
    const http2 = express().use('/api/career', createCareerRouter({ career: noFacts.svc }));
    expect((await request(http2).get(`/api/career/jobs/${noFacts.id}/kit`)).status).toBe(409);
  });

  it('Telegram: "kit <id>" menjawab paket; daftar lowongan memuat #id dan petunjuk; kalimat lain tidak dibajak', async () => {
    const { svc, id } = make();
    const msg = await quickCareer(svc, `kit ${id}`);
    expect(msg).toContain('Paket lamaran: Full Stack Developer - Acme');
    expect(await quickCareer(svc, `paket lamaran #${id}`)).toContain('SURAT LAMARAN');
    expect(await quickCareer(svc, 'kit 9999')).toBe('Lowongan tidak ditemukan.');
    const list = await quickCareer(svc, 'lowongan baru');
    expect(list).toContain(`#${id} [74] Full Stack Developer`);
    expect(list).toContain(`Ketik "kit ${id}"`);
    for (const q of ['kit', 'kit baru', 'buatkan kit pertolongan pertama', 'paket data internet', 'kit lamaran saya mana']) expect(await quickCareer(svc, q), q).toBeNull();
  });
});

// ------------------------------------------------------------------ Greenhouse: deskripsi dibaca untuk semua peran software yang belum tertutup wilayah

describe('radar membaca deskripsi Greenhouse untuk peran software yang belum tertutup wilayah', () => {
  const gh = (extId, title, location) => ({ source: 'greenhouse:acme', extId, url: `https://job-boards.greenhouse.io/acme/jobs/${extId}`, title, company: 'Acme', location, remote: true, tags: [], seniority: null, salaryText: '', postedAt: NOW - 3_600_000, description: '', regions: [], timezones: [] });

  function setup(jobs) {
    const calls = [];
    const fetchImpl = vi.fn(async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ content: '&lt;p&gt;We use React and Node.js. 1 year of experience.&lt;/p&gt;', location: { name: 'Remote' } }), { status: 200 });
    });
    const store = new CareerStore(new Database(':memory:'), { now: () => NOW });
    const svc = createCareer({ store, sources: [{ id: 'greenhouse:acme', label: 'GH', fetch: async () => jobs.map((j) => ({ ...j })) }], fetchImpl, now: () => NOW,
      getProfile: () => ({ skills: 'react, node.js' }), env: { CAREER_TELEGRAM: '' } });
    return { svc, store, calls };
  }

  it('lowongan software dengan wilayah belum jelas: deskripsi dibaca, lalu dinilai ulang dengan deskripsinya', async () => {
    const { svc, store, calls } = setup([gh('1', 'Software Engineer', 'Remote')]);
    await svc.scan({ announce: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/boards/acme/jobs/1');
    const j = store.listJobs({ includeDescription: true }).jobs[0];
    expect(j.description).toContain('React and Node.js');
    expect(j.reasons.join(' ')).toMatch(/keahlian cocok: .*react/);
  });

  it('tidak membaca yang jelas tertutup wilayah atau bukan peran software (hemat permintaan)', async () => {
    const { svc, calls } = setup([gh('2', 'Software Engineer', 'USA Only'), gh('3', 'Account Executive', 'Remote'), gh('4', 'Software Engineer', 'Remote, France')]);
    await svc.scan({ announce: false });
    expect(calls).toHaveLength(0);
  });

  it('pemindaian berikutnya memakai deskripsi yang sudah tersimpan, tidak mengambil lagi', async () => {
    const { svc, calls, store } = setup([gh('1', 'Software Engineer', 'Remote')]);
    await svc.scan({ announce: false });
    await svc.scan({ announce: false });
    expect(calls).toHaveLength(1);
    expect(store.descriptionOf('greenhouse:acme', '1')).toContain('React');
    expect(store.descriptionOf('greenhouse:acme', 'tidak-ada')).toBe('');
  });
});
