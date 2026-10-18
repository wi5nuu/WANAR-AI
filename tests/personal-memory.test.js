/**
 * Test Suite: src/memory/personal*.js
 * In-memory SQLite, injected clock, no network. The rules under test:
 * memory is upserted by (kind, key), every change is versioned, forgetting is
 * a hard delete with history, the prompt block is bounded + redacted, and the
 * chat intents work without any model call.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';

import { createPersonalStore, MEMORY_KINDS } from '../src/memory/personal-store.js';
import { PersonalMemory, PersonalError, MEMORY_KIND_LABELS } from '../src/memory/personal.js';
import { quickMemory, kindFor, keyFor } from '../src/memory/quick.js';
import { createMemoryRouter } from '../src/memory/routes.js';

const T0 = Date.parse('2026-10-12T01:00:00Z'); // 08:00 WIB

function build() {
  const db = new Database(':memory:');
  let clock = T0;
  const store = createPersonalStore(db);
  const svc = new PersonalMemory({ store, now: () => clock });
  return { db, store, svc, set: (ms) => { clock = ms; } };
}

function makeApp(module) {
  const app = express();
  app.use(express.json());
  app.use('/api/memory', createMemoryRouter({ memory: module }));
  return app;
}

// ================================================================ write path

describe('personal memory write path', () => {
  it('upserts by (kind, key) and versions every change', () => {
    const t = build();
    const a = t.svc.remember({ kind: 'preference', key: 'kopi', value: 'kopi tanpa gula' });
    expect(a.kind).toBe('preference');
    const b = t.svc.remember({ kind: 'preference', key: 'kopi', value: 'kopi dengan satu gula', note: 'berubah pikiran' });
    expect(b.id).toBe(a.id);
    const actions = t.store.items.history(a.id).map((h) => h.action);
    expect(actions).toContain('updated');
    expect(actions).toContain('noted');
    expect(t.svc.overview().counts.total).toBe(1);
    // The same key under a different kind is a different memory.
    t.svc.remember({ kind: 'fact', key: 'kopi', value: 'kopi di kantor dari mesin' });
    expect(t.svc.overview().counts.total).toBe(2);
  });

  it('refuses empty memory and unknown kinds instead of guessing', () => {
    const t = build();
    expect(() => t.svc.remember({ key: '  ', value: 'x' })).toThrowError(PersonalError);
    expect(() => t.svc.remember({ key: 'k', value: '   ' })).toThrowError(PersonalError);
    expect(() => t.svc.remember({ key: 'k', value: 'x', kind: 'rahasia' })).toThrowError(/Jenis memori/);
    expect(MEMORY_KINDS).toEqual(['preference', 'fact', 'place', 'person', 'routine', 'note']);
    expect(MEMORY_KIND_LABELS.place).toBe('Tempat');
  });

  it('updates a memory and refuses unknown ids', () => {
    const t = build();
    const item = t.svc.remember({ kind: 'fact', key: 'a', value: 'nilai lama' });
    const updated = t.svc.update(item.id, { value: 'nilai baru' });
    expect(updated.value).toBe('nilai baru');
    expect(t.store.items.history(item.id).some((h) => h.action === 'updated')).toBe(true);
    expect(() => t.svc.update('mem_tidakada', { value: 'x' })).toThrowError(/tidak ditemukan/);
  });
});

// ================================================================ read paths

describe('search, forget and the prompt block', () => {
  it('searches, forgets by text, and keeps the deleted value in history', () => {
    const t = build();
    t.svc.remember({ kind: 'place', key: 'warung-bu-yati', value: 'Warung Bu Yati dekat pasar' });
    t.svc.remember({ kind: 'preference', key: 'kopi', value: 'kopi tanpa gula' });
    expect(t.svc.search('warung').map((i) => i.key)).toEqual(['warung-bu-yati']);

    const n = t.svc.forgetByText('kopi');
    expect(n).toBe(1);
    expect(t.svc.search('kopi')).toHaveLength(0);

    const item = t.store.items.byKey('place', 'warung-bu-yati');
    t.svc.forget(item.id);
    expect(t.store.items.get(item.id)).toBeNull();
    expect(t.store.items.history(item.id).some((h) => h.action === 'forgotten' && /Bu Yati/.test(h.old_value))).toBe(true);
    expect(() => t.svc.forget(item.id)).toThrowError(/tidak ditemukan/);
  });

  it('only forgets everything with an explicit "all"', () => {
    const t = build();
    t.svc.remember({ kind: 'fact', key: 'a', value: 'aaa' });
    t.svc.remember({ kind: 'fact', key: 'b', value: 'bbb' });
    expect(t.svc.forgetByText('tidak-ada-yang-cocok-xyz')).toBe(0);
    expect(t.svc.overview().counts.total).toBe(2);
    expect(t.svc.forgetByText('', { all: true })).toBe(2);
    expect(t.svc.overview().counts.total).toBe(0);
  });

  it('builds a bounded, redacted prompt block and marks usage', () => {
    const t = build();
    const item = t.svc.remember({ kind: 'preference', key: 'kopi', value: 'kopi tanpa gula' });
    const secret = t.svc.remember({ kind: 'note', key: 'token kredensial', value: 'token: rahasia123456789' });
    const block = t.svc.buildPromptBlock({ text: 'kopi saya bagaimana?' });
    expect(block.text).toMatch(/MEMORI PRIBADI PEMILIK/);
    expect(block.text).toMatch(/kopi tanpa gula/);
    expect(block.text).not.toContain('rahasia123456789'); // redact() runs before the model ever sees it
    expect(block.ids).toContain(item.id);
    expect(block.ids).toContain(secret.id);
    expect(t.store.items.get(item.id).times_used).toBeGreaterThan(0);
    expect(block.text.length).toBeLessThanOrEqual(t.svc.maxContextChars);
  });

  it('summarises what it knows without exaggerating', () => {
    const t = build();
    expect(t.svc.summaryLine()).toMatch(/masih kosong/);
    t.svc.remember({ kind: 'place', key: 'kantor', value: 'Kantor di Jalan Melati' });
    expect(t.svc.summaryLine()).toMatch(/1 item aktif/);
    expect(t.svc.summaryLine()).toMatch(/Tempat/);
  });
});

// ============================================================ ingest hooks

describe('ingest hooks from other modules', () => {
  it('stores place corrections, false positives, calibrations and services with stable keys', () => {
    const t = build();
    const place = t.svc.ingest({
      kind: 'place_correction',
      place: { name: 'Warung Bu Yati', kind: 'food', lat: -6.2383, lon: 106.9756, radius_m: 80 },
    });
    expect(place.kind).toBe('place');
    expect(place.key).toBe('place:Warung Bu Yati');
    expect(place.value).toMatch(/-6.23830, 106.97560/);
    expect(place.tags).toContain('lokasi');
    // A second correction for the same place updates instead of duplicating.
    const again = t.svc.ingest({ kind: 'place_correction', stop: { corrected_label: 'Warung Bu Yati', lat: -6.2383, lon: 106.9756 } });
    expect(again.id).toBe(place.id);
    expect(t.svc.overview().counts.total).toBe(1);

    const fp = t.svc.ingest({ kind: 'emergency_false_positive', trigger: { summary: 'anomali gerak' } });
    expect(fp.kind).toBe('note');
    expect(fp.source).toBe('system');
    expect(fp.value).toMatch(/anomali gerak/);

    const cal = t.svc.ingest({ kind: 'fuel_calibration', current: 50, proposed: 44, samples: 4 });
    expect(cal.key).toBe('motor:konsumsi-acuan');
    expect(cal.value).toMatch(/44 km\/L/);

    const svc = t.svc.ingest({ kind: 'service_record', itemKey: 'oli_mesin', odoKm: 5321, workshop: 'AHASS', ts: T0 });
    expect(svc.key).toMatch(/^motor:servis:oli_mesin:/);
    expect(svc.value).toMatch(/5321 km/);
    expect(svc.value).toMatch(/AHASS/);

    expect(t.svc.ingest({ kind: 'tidak_dikenal' })).toBeNull();
    expect(t.svc.ingest({})).toBeNull();
  });
});

// =========================================================== quick intents

describe('quick memory intents (code, no model)', () => {
  it('remembers, recalls and forgets in plain Indonesian', () => {
    const t = build();
    const remembered = quickMemory({ service: t.svc }, 'ingat ya, kopi saya tanpa gula');
    expect(remembered).toMatch(/Saya ingat/);
    expect(t.store.items.search('kopi')).toHaveLength(1);

    const recalled = quickMemory({ service: t.svc }, 'kamu ingat apa tentang kopi saya?');
    expect(recalled).toMatch(/Yang saya ingat/);
    expect(recalled).toMatch(/kopi saya tanpa gula/);

    const all = quickMemory({ service: t.svc }, 'apa saja yang kamu ingat?');
    expect(all).toMatch(/Saya menyimpan 1 hal/);

    const gone = quickMemory({ service: t.svc }, 'lupakan kopi tanpa gula');
    expect(gone).toMatch(/Saya lupakan 1 memori/);
    expect(t.store.items.search('kopi')).toHaveLength(0);
  });

  it('classifies kinds and keys cheaply, and ignores unrelated text', () => {
    expect(kindFor('rumah saya dekat masjid')).toBe('place');
    expect(kindFor('istri saya suka teh')).toBe('person');
    expect(kindFor('saya selalu pesan kopi hitam')).toMatch(/preference|routine/);
    expect(keyFor('Kopi saya tanpa gula, ya!')).toBe('kopi-saya-tanpa-gula');
    expect(quickMemory({ service: build().svc }, 'berapa jam saya kerja hari ini?')).toBeNull();
    expect(quickMemory({ service: build().svc }, 'tolong buatkan email')).toBeNull();
    expect(quickMemory(null, 'ingat ya, kopi')).toBeNull();
  });
});

// ================================================================== routes

describe('memory routes', () => {
  it('serves the full CRUD surface and history', async () => {
    const t = build();
    const app = makeApp({ store: t.store, service: t.svc });
    const created = await request(app).post('/api/memory/items').send({ kind: 'place', key: 'warung-bu-yati', value: 'Warung Bu Yati dekat pasar', tags: ['lokasi'] });
    expect(created.status).toBe(201);
    const id = created.body.item.id;

    const missing = await request(app).post('/api/memory/items').send({ key: 'x' });
    expect(missing.status).toBe(400); // no value

    const list = await request(app).get('/api/memory/items?q=warung');
    expect(list.body.items).toHaveLength(1);
    const byKind = await request(app).get('/api/memory/items?kind=place');
    expect(byKind.body.items).toHaveLength(1);
    expect((await request(app).get('/api/memory/items?kind=preference')).body.items).toHaveLength(0);

    const patched = await request(app).patch(`/api/memory/items/${id}`).send({ value: 'Warung Bu Yati, dekat pasar baru' });
    expect(patched.body.item.value).toMatch(/pasar baru/);
    expect((await request(app).patch('/api/memory/items/mem_tidakada').send({ value: 'x' })).status).toBe(404);
    expect((await request(app).patch(`/api/memory/items/${id}`).send({ kind: 'rahasia' })).status).toBe(400);

    const history = await request(app).get(`/api/memory/items/${id}/history`);
    expect(history.body.history.length).toBeGreaterThanOrEqual(2);

    const about = await request(app).get('/api/memory/about?q=warung');
    expect(about.body.block).toMatch(/MEMORI PRIBADI PEMILIK/);
    expect(about.body.summary).toMatch(/1 item aktif/);

    expect((await request(app).delete(`/api/memory/items/${id}`)).status).toBe(200);
    expect((await request(app).delete(`/api/memory/items/${id}`)).status).toBe(404);

    const overview = await request(app).get('/api/memory/overview');
    expect(overview.body.counts.total).toBe(0);
    expect(overview.body.kinds).toEqual(MEMORY_KINDS);
  });

  it('requires an explicit confirmation to forget everything', async () => {
    const t = build();
    const app = makeApp({ store: t.store, service: t.svc });
    await request(app).post('/api/memory/items').send({ key: 'a', value: 'aaa' });
    await request(app).post('/api/memory/items').send({ key: 'b', value: 'bbb' });

    const denied = await request(app).post('/api/memory/forget').send({ all: true });
    expect(denied.status).toBe(400);
    const empty = await request(app).post('/api/memory/forget').send({});
    expect(empty.status).toBe(400);

    const phrase = await request(app).post('/api/memory/forget').send({ q: 'aaa' });
    expect(phrase.body.forgotten).toBe(1);
    expect(phrase.body.matched).toBe(true);
    const none = await request(app).post('/api/memory/forget').send({ q: 'tidak-ada-xyz' });
    expect(none.body.forgotten).toBe(0);
    expect(none.body.matched).toBe(false);

    const all = await request(app).post('/api/memory/forget').send({ all: true, confirm: 'LUPA SEMUA' });
    expect(all.body.forgotten).toBe(1);
  });
});
