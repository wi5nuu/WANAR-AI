#!/usr/bin/env node
/**
 * Menyimpan tiga tempat yang diberikan pemilik sebagai geofence awal:
 *
 *   Rumah  — apartemen Grand Centerpoint Tower C & D
 *   Kantor — Marketing Gallery Jababeka
 *   Toko   — ASHAR GROSIR PARFUM BEKASI
 *
 *   node scripts/seed-places.mjs [data/wanar.db]
 *
 * Aman dijalankan berulang: tempat dengan nama yang sama diperbarui ke
 * koordinat ini (bukan diduplikasi). Hanya tabel loc_* yang dibuat/diubah.
 * Koordinat berasal dari tautan Google Maps yang dikirim pemilik.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createLocationStore } from '../src/location/store.js';
import { geohash } from '../src/location/geo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.resolve(process.argv[2] || process.env.WANAR_DB_PATH || path.join(root, 'data', 'wanar.db'));

const PLACES = [
  {
    name: 'Rumah',
    kind: 'home',
    lat: -6.2445669,
    lon: 106.9933984,
    radiusM: 150,
    aliases: ['Grand Centerpoint', 'Grand Centerpoint Tower C', 'Grand Centerpoint Tower D', 'Apartemen Grand Centerpoint'],
    note: 'apartemen Grand Centerpoint Tower C & D',
  },
  {
    name: 'Kantor',
    kind: 'office',
    lat: -6.2937417,
    lon: 107.175738,
    radiusM: 200,
    aliases: ['Marketing Gallery Jababeka', 'Kantor Marketing Gallery Jababeka', 'Jababeka'],
    note: 'Marketing Gallery Jababeka',
  },
  {
    name: 'Toko',
    kind: 'shop',
    lat: -6.2356042,
    lon: 107.0072126,
    radiusM: 120,
    aliases: ['ASHAR GROSIR PARFUM BEKASI', 'ASHAR Grosir Parfum', 'Ashar Grosir Parfum Bekasi', 'Toko ASHAR'],
    note: 'ASHAR GROSIR PARFUM BEKASI',
  },
];

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
const store = createLocationStore(db);

let created = 0;
let updated = 0;
const existingPlaces = store.places.list({ includeInactive: true });

for (const p of PLACES) {
  const gh = geohash(p.lat, p.lon, 6);
  const existing = existingPlaces.find((row) => String(row.name).toLowerCase() === p.name.toLowerCase());
  if (existing) {
    // store.places.update expects the column names (radius_m, confirm_state).
    store.places.update(existing.id, {
      kind: p.kind,
      lat: p.lat,
      lon: p.lon,
      radius_m: p.radiusM,
      aliases: p.aliases,
      geohash: gh,
      active: 1,
      confirm_state: 'confirmed',
    });
    updated++;
    console.log(`↻ ${p.name} (${p.kind}) diperbarui: ${p.lat}, ${p.lon} · radius ${p.radiusM} m — ${p.note}`);
  } else {
    store.places.create({
      name: p.name,
      kind: p.kind,
      lat: p.lat,
      lon: p.lon,
      radiusM: p.radiusM,
      aliases: p.aliases,
      source: 'user',
      confirmState: 'confirmed',
      geohash: gh,
    });
    created++;
    console.log(`+ ${p.name} (${p.kind}) disimpan: ${p.lat}, ${p.lon} · radius ${p.radiusM} m — ${p.note}`);
  }
}

const total = store.places.list().length;
db.close();
console.log(`Selesai: ${created} baru, ${updated} diperbarui, ${total} tempat aktif di ${dbPath}`);
