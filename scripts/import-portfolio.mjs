#!/usr/bin/env node
/**
 * Mengimpor portofolio (folder Astro milik pemilik) menjadi lembar fakta untuk agent.
 *
 *   node scripts/import-portfolio.mjs "D:\portofolio_wisnualfiannurashar" [data/owner-facts.json]
 *
 * Hanya membaca src/data/profile.ts dan profile_id.ts. .env dan berkas lain TIDAK dibuka.
 * Hasilnya ada di data/ (di-ignore Git) karena berisi data pribadi. Yang dicetak hanya hitungan.
 */
import fs from 'node:fs';
import path from 'node:path';
import { importPortfolio } from '../src/career/portfolio.js';
import { validateFacts, factSummary, skillsFromFacts } from '../src/career/facts.js';

const dir = process.argv[2];
const out = path.resolve(process.argv[3] || 'data/owner-facts.json');
if (!dir) { console.error('Pakai: node scripts/import-portfolio.mjs <folder-portofolio> [keluaran.json]'); process.exit(1); }

const facts = importPortfolio(path.resolve(dir));
const v = validateFacts(facts);
if (!v.ok) { console.error('Hasil impor tidak valid:', v.errors.join('; ')); process.exit(1); }
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(facts, null, 2)}\n`, { mode: 0o600 });
console.log('Tersimpan:', out);
console.log('Ringkasan:', JSON.stringify(factSummary(facts)));
console.log('Contoh keahlian untuk penilaian:', skillsFromFacts(facts).slice(0, 18).join(', '), '...');
