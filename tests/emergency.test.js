/**
 * Test Suite: src/emergency/*
 * In-memory SQLite, injected clock, no network, no real contact is ever
 * reached: every test either stays in simulate mode or uses a stub channel.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';

import {
  scoreRisk, motionMagnitude, rotationMagnitude, peakImpact, buildEmergencyMessage,
  SENSITIVITY_PRESETS, DEFAULT_DETECT,
} from '../src/emergency/detect.js';
import { createEmergencyStore, DEFAULT_EMERGENCY } from '../src/emergency/store.js';
import { EmergencyService, EmergencyError } from '../src/emergency/service.js';
import { createEmergencyRouter } from '../src/emergency/routes.js';

const T0 = Date.parse('2026-10-12T01:00:00Z'); // 08:00 WIB

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function build({ channels = {}, ownerNotify = null, env = {}, location = null, memory = null } = {}) {
  const db = new Database(':memory:');
  let clock = T0;
  const store = createEmergencyStore(db);
  const svc = new EmergencyService({ store, location, channels, ownerNotify, now: () => clock, env, memory, log: () => {} });
  return { db, store, svc, set: (ms) => { clock = ms; }, advance: (ms) => { clock += ms; } };
}

/** A verified contact with a WhatsApp channel — the only way escalate() will call anyone. */
function addContact(store, { name = 'Ibu', phone = '08123456789', whatsapp = true } = {}) {
  const c = store.contacts.create({ name, phone, relation: 'keluarga', verified: true, consent: true });
  if (whatsapp) store.contacts.update(c.id, { whatsapp: true });
  return store.contacts.get(c.id);
}

const speedSamples = (speeds, { dtMs = 3000, start = T0, lat = -6.2383, lon = 106.9756 } = {}) =>
  speeds.map((v, i) => ({ ts: start + i * dtMs, lat: lat + i * 0.0002, lon: lon + i * 0.0002, speed: v }));

function makeApp(module, env = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/emergency', createEmergencyRouter({ emergency: module, env }));
  return app;
}

// ============================================================== risk scoring

describe('crash-risk scoring (deterministic, honest about limits)', () => {
  it('caps a sensor-less device at "watch" and says why', () => {
    const r = scoreRisk(
      { samples: speedSamples([9, 9, 9, 0]), motion: [], sensorAgeMs: null, place: null, stillnessMs: 180_000, now: T0 + 10_000 },
      { now: T0 + 10_000, sensitivity: 'medium' }
    );
    expect(r.signals.map((s) => s.name)).toEqual(expect.arrayContaining(['sudden_deceleration', 'post_event_stillness']));
    expect(r.sensorAvailable).toBe(false);
    expect(r.score).toBeLessThanOrEqual(0.45);
    expect(r.level).toBe('watch'); // cannot reach "suspected" without sensors
    expect(r.guards.join(' ')).toMatch(/akselerometer/);
  });

  it('uses real accelerometer/gyroscope data when the device sends it', () => {
    const r = scoreRisk(
      {
        samples: speedSamples([9, 9, 9, 0]), motion: [{ ts: T0 + 8000, mag: 4.2, rot: 380 }],
        sensorAgeMs: 2000, place: null, stillnessMs: 120_000, now: T0 + 10_000,
      },
      { now: T0 + 10_000, sensitivity: 'medium' }
    );
    expect(r.sensorAvailable).toBe(true);
    expect(r.signals.map((s) => s.name)).toEqual(expect.arrayContaining(['impact', 'abrupt_rotation']));
    expect(r.score).toBeGreaterThan(0.7);
    expect(r.level).toBe('high');
  });

  it('never concludes a crash from a single signal', () => {
    const r = scoreRisk(
      { samples: speedSamples([8, 8, 8]), motion: [{ ts: T0 + 5000, mag: 4.2 }], sensorAgeMs: 1000, stillnessMs: 0, now: T0 + 6000 },
      { now: T0 + 6000, sensitivity: 'medium' }
    );
    expect(r.signals).toHaveLength(1); // impact only
    expect(r.score).toBeLessThanOrEqual(0.42);
    expect(r.level).toBe('watch');
    expect(r.guards.join(' ')).toMatch(/satu sinyal/);
  });

  it('halves the score when the stop happened at a known place', () => {
    const input = { samples: speedSamples([9, 9, 9, 0]), motion: [], sensorAgeMs: null, stillnessMs: 180_000, now: T0 + 10_000 };
    const plain = scoreRisk(input, { now: T0 + 10_000, sensitivity: 'medium' });
    const atHome = scoreRisk({ ...input, place: { kind: 'home', label: 'Rumah', confidence: 0.9 } }, { now: T0 + 10_000, sensitivity: 'medium' });
    expect(atHome.score).toBeLessThan(plain.score);
    expect(atHome.guards.join(' ')).toMatch(/lokasi yang dikenal/);
  });

  it('weakens every conclusion when the data stream has a big gap', () => {
    const gapped = speedSamples([9, 9, 9, 0]);
    gapped[3].ts = T0 + 40_000; // a 34-second hole before the last fix
    const r = scoreRisk(
      { samples: gapped, motion: [], sensorAgeMs: null, stillnessMs: 0, now: T0 + 45_000 },
      { now: T0 + 45_000, sensitivity: 'medium' }
    );
    expect(r.guards.join(' ')).toMatch(/jeda data/);
  });

  it('reads raw sensor magnitudes and presets without inventing numbers', () => {
    expect(motionMagnitude({ accelerationIncludingGravity: { x: 0, y: 0, z: 2 } })).toBe(2);
    expect(motionMagnitude({})).toBeNull();
    expect(rotationMagnitude({ rotationRate: { alpha: 3, beta: 4, gamma: 0 } })).toBe(5);
    expect(peakImpact([{ ts: Date.now(), mag: 1 }, { ts: Date.now(), mag: 3.5 }]).peak).toBe(3.5);
    expect(Object.keys(SENSITIVITY_PRESETS)).toEqual(['low', 'medium', 'high']);
    expect(DEFAULT_DETECT.sensitivity).toBe('medium');
    expect(DEFAULT_EMERGENCY.mode).toBe('simulate'); // safety default is never live
  });

  it('writes an honest escalation message, stale location included', () => {
    const stale = { lat: -6.2383, lon: 106.9756, accuracy: 25, ts: Date.now() - 10 * 60_000 };
    const msg = buildEmergencyMessage({
      location: stale,
      event: { ts: Date.now(), trigger: { level: 'suspected', score: 0.58 } },
      baseUrl: 'https://contoh.test/',
    });
    expect(msg).toMatch(/lokasi terakhir yang diketahui/);
    expect(msg).toMatch(/bukan posisi live/);
    expect(msg).toMatch(/openstreetmap\.org/);
    expect(msg).toMatch(/bukan konfirmasi kecelakaan/);
    const empty = buildEmergencyMessage({ location: null, event: null });
    expect(empty).toMatch(/Lokasi terakhir: tidak tersedia/);
  });
});

// ========================================================= workflow service

describe('emergency workflow (simulate by default, never a fake delivery)', () => {
  it('raises, counts down, cancels on "aman", and remembers the false positive', () => {
    const remembered = [];
    const t = build({ memory: (e) => remembered.push(e) });
    const ev = t.svc.raise({ origin: 'detector', trigger: { level: 'suspected', summary: 'anomali gerak' } });
    expect(ev.status).toBe('confirming');
    expect(ev.mode).toBe('simulate');
    expect(ev.confirm_deadline).toBe(T0 + t.store.settings.get().countdownMs);

    const done = t.svc.respond(ev.id, 'aman');
    expect(done.status).toBe('cancelled');
    expect(done.response).toBe('safe');
    expect(t.store.events.openOne()).toBeNull();
    expect(remembered[0].kind).toBe('emergency_false_positive');

    // Answering again after resolution changes nothing.
    expect(t.svc.respond(ev.id, 'bantuan').status).toBe('cancelled');
    // Unknown answers are refused, not guessed.
    const ev2 = t.svc.raise({ origin: 'manual', trigger: { level: 'manual', summary: 'x' } });
    expect(() => t.svc.respond(ev2.id, 'mungkin')).toThrowError(EmergencyError);
    expect(() => t.svc.respond('emg_tidakada', 'aman')).toThrowError(/tidak ditemukan/);
  });

  it('escalates on "butuh bantuan" but records ONLY simulated attempts, without calling the provider', async () => {
    const sends = [];
    const t = build({ channels: { whatsapp: (phone, text) => { sends.push({ phone, text }); return { ok: true, id: 'wamid.1' }; } } });
    const contact = addContact(t.store);
    const ev = t.svc.raise({ origin: 'manual', trigger: { level: 'manual', summary: 'tombol darurat' }, skipCountdown: true });
    const escalated = await t.svc.respond(ev.id, 'bantuan');
    expect(escalated.response).toBe('help');
    const attempts = t.store.attempts.forEvent(ev.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].channel).toBe('whatsapp');
    expect(attempts[0].status).toBe('simulated'); // never "sent"
    expect(attempts[0].sent_at).toBeNull();
    expect(t.store.contacts.get(contact.id).last_status).toBe('simulated');
    expect(sends).toHaveLength(0); // the provider was never touched
  });

  it('records the real provider outcome in live mode — success and failure alike', async () => {
    const sends = [];
    const t = build({ channels: { whatsapp: (phone, text) => { sends.push({ phone, text }); return { ok: true, id: 'wamid.ok' }; } } });
    const contact = addContact(t.store);
    t.svc.updateSettings({ mode: 'live' });
    const ev = t.svc.raise({ origin: 'manual', trigger: { level: 'manual', summary: 'uji live' }, skipCountdown: true });
    expect(ev.mode).toBe('live');
    await t.svc.escalate(ev, { reason: 'uji live' });
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toMatch(/Sistem mendeteksi kemungkinan keadaan darurat/);
    const sent = t.store.attempts.forEvent(ev.id)[0];
    expect(sent.status).toBe('sent');
    expect(sent.provider_response).toBe('wamid.ok');
    expect(t.store.contacts.get(contact.id).last_status).toBe('sent');

    const t2 = build({ channels: { whatsapp: () => { throw new Error('provider mati'); } } });
    addContact(t2.store);
    t2.svc.updateSettings({ mode: 'live' });
    const ev2 = t2.svc.raise({ origin: 'manual', trigger: { level: 'manual', summary: 'gagal' }, skipCountdown: true });
    await t2.svc.escalate(ev2, { reason: 'uji gagal' });
    const failed = t2.store.attempts.forEvent(ev2.id)[0];
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/provider mati/);
  });

  it('says honestly when no verified contact can be reached', async () => {
    const t = build();
    t.store.contacts.create({ name: 'Belum diverifikasi', phone: '08123456789' }); // verified=false
    const ev = t.svc.raise({ origin: 'manual', trigger: { level: 'manual', summary: 'x' }, skipCountdown: true });
    const out = await t.svc.escalate(ev, { reason: 'tanpa kontak' });
    expect(out.status).toBe('escalated_no_contacts');
    expect(out.resolution).toMatch(/Tidak ada kontak darurat terverifikasi/);
    expect(t.store.attempts.forEvent(ev.id)).toHaveLength(0);
  });

  it('reports "nothing was delivered" when the contact has no usable channel', async () => {
    const t = build();
    t.store.contacts.create({ name: 'Hanya nomor', phone: '08123456789', verified: true, consent: true }); // whatsapp flag off
    const ev = t.svc.raise({ origin: 'manual', trigger: { level: 'manual', summary: 'x' }, skipCountdown: true });
    const out = await t.svc.escalate(ev, { reason: 'tanpa kanal' });
    expect(out.resolution).toMatch(/tidak ada pesan yang terkirim|semua upaya pengiriman gagal/);
  });

  it('tick() escalates when the countdown expires, and honours the auto-escalate switch', async () => {
    const t = build();
    addContact(t.store);
    const ev = t.svc.raise({ origin: 'detector', trigger: { level: 'suspected', summary: 'anomali' } });
    t.advance(30_000);
    const out = t.svc.tick();
    expect(out.escalated).toBe(1);
    await settle();
    const after = t.store.events.get(ev.id);
    expect(after.escalated_at).not.toBeNull();
    expect(t.store.attempts.forEvent(ev.id)[0].status).toBe('simulated');
    // A second tick adds nothing (the attempt already "delivered" in simulation).
    t.svc.tick();
    await settle();
    expect(t.store.attempts.forEvent(ev.id)).toHaveLength(1);

    const t2 = build();
    t2.svc.updateSettings({ autoEscalateOnTimeout: false });
    const ev2 = t2.svc.raise({ origin: 'detector', trigger: { level: 'suspected', summary: 'x' } });
    t2.advance(60_000);
    t2.svc.tick();
    const parked = t2.store.events.get(ev2.id);
    expect(parked.status).toBe('awaiting_owner');
    expect(parked.resolution).toMatch(/eskalasi otomatis dimatikan/);
    expect(t2.store.attempts.forEvent(ev2.id)).toHaveLength(0);
  });

  it('retries a failed live attempt only after the backoff', async () => {
    let calls = 0;
    const t = build({ channels: { whatsapp: () => { calls++; return calls === 1 ? { ok: false, error: 'timeout' } : { ok: true, id: 'ok2' }; } } });
    addContact(t.store);
    t.svc.updateSettings({ mode: 'live' });
    const ev = t.svc.raise({ origin: 'manual', trigger: { level: 'manual', summary: 'x' }, skipCountdown: true });
    await t.svc.escalate(ev, { reason: 'awal' });
    expect(t.store.attempts.forEvent(ev.id)).toHaveLength(1);
    t.svc.tick(); // too early: the attempt row is newer than the backoff
    await settle();
    expect(t.store.attempts.forEvent(ev.id)).toHaveLength(1);
    // Advance behind the backoff window (attempt rows use wall-clock createdAt).
    t.advance(10 * 86_400_000);
    const out = t.svc.tick();
    expect(out.retried).toBe(1);
    await settle();
    const attempts = t.store.attempts.forEvent(ev.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].status).toBe('sent');
  });

  it('refuses to raise anything while the module is disabled', () => {
    const t = build();
    t.svc.updateSettings({ enabled: false });
    expect(() => t.svc.raise({ origin: 'manual', trigger: { level: 'manual', summary: 'x' } })).toThrowError(/dimatikan/);
  });

  it('env EMERGENCY_MODE overrides settings, in both directions', () => {
    const forcedSim = build({ env: { EMERGENCY_MODE: 'simulate' } });
    forcedSim.svc.updateSettings({ mode: 'live' });
    expect(forcedSim.svc.effectiveMode()).toBe('simulate');
    expect(forcedSim.svc.status().modeSource).toBe('settings'); // env=simulate keeps settings source label
    const forcedLive = build({ env: { EMERGENCY_MODE: 'live' } });
    expect(forcedLive.svc.effectiveMode()).toBe('live');
    expect(forcedLive.svc.status().notice).toMatch(/LIVE/);
  });
});

// ============================================================ feed from GPS

describe('feed() from the location stream', () => {
  it('asks the owner about a low-risk anomaly and opens no incident, then throttles', async () => {
    const notices = [];
    const t = build({ ownerNotify: (text, meta) => { notices.push({ text, meta }); return { ok: true }; } });
    const pts = speedSamples([9, 9, 0], { dtMs: 4000 });
    t.set(T0 + 9000);
    const res = t.svc.feed({ sessionId: 's1', samples: pts });
    expect(res.level).toBe('watch');
    await settle();
    expect(t.store.events.openOne()).toBeNull();
    expect(t.store.events.countSince(0)).toBe(0); // a watch is NOT an incident
    expect(notices.some((n) => /risiko rendah|abaikan/.test(n.text))).toBe(true);
    // Re-feeding within the throttle window does not ask again.
    expect(t.svc.feed({ sessionId: 's1', samples: pts })).toBeNull();
  });

  it('stays silent on a normal ride, and respects the module switch', () => {
    const notices = [];
    const t = build({ ownerNotify: (text) => { notices.push(text); return { ok: true }; } });
    const calm = speedSamples([10, 10, 10, 10]);
    t.set(T0 + 12_000);
    expect(t.svc.feed({ sessionId: 's1', samples: calm })).toBeNull();
    t.svc.updateSettings({ enabled: false });
    t.advance(60_000);
    expect(t.svc.feed({ sessionId: 's1', samples: speedSamples([9, 9, 0]) })).toBeNull();
  });
});

// ============================================================== simulation

describe('guided simulation (the only path tests and the UI button use)', () => {
  it('runs the whole flow with contacts and closes itself — nothing is sent, nothing lingers', async () => {
    const sends = [];
    const t = build({ channels: { whatsapp: (...a) => { sends.push(a); return { ok: true }; } } });
    addContact(t.store);
    const r = await t.svc.simulate({ preset: 'sudden_stop', auto: true });
    expect(r.event.mode).toBe('simulate');
    expect(r.event.origin).toBe('simulation');
    expect(r.attempts.length).toBeGreaterThan(0);
    expect(r.attempts.every((a) => a.status === 'simulated')).toBe(true);
    expect(sends).toHaveLength(0);
    expect(r.steps.join(' ')).toMatch(/tidak ada pesan nyata yang dikirim/);
    // Closed automatically: a leftover test event would block real detection.
    expect(r.event.status).toBe('resolved');
    expect(t.store.events.openOne()).toBeNull();
  });

  it('honours "aman" and "manual" presets', async () => {
    const t = build();
    addContact(t.store);
    const safe = await t.svc.simulate({ preset: 'sudden_stop', auto: true, answer: 'safe' });
    expect(safe.event.status).toBe('cancelled');
    expect(safe.steps.join(' ')).toMatch(/aman/);
    const manual = await t.svc.simulate({ preset: 'manual', auto: true, answer: 'help' });
    expect(manual.event.status).toBe('resolved');
    expect(manual.attempts.every((a) => a.status === 'simulated')).toBe(true);
  });

  it('explains the no-contact gap instead of pretending to reach someone', async () => {
    const t = build();
    const r = await t.svc.simulate({ auto: true });
    expect(r.event.status).toBe('escalated_no_contacts');
    expect(r.attempts).toHaveLength(0);
    expect(t.store.events.openOne()).toBeNull(); // escalated_no_contacts never blocks scoring
  });

  it('answers summaryLine() without inventing state', () => {
    const t = build();
    expect(t.svc.summaryLine()).toMatch(/0 kontak|belum ada/);
    const ev = t.svc.raise({ origin: 'manual', trigger: { level: 'manual', summary: 'tombol' }, skipCountdown: true });
    expect(t.svc.summaryLine()).toMatch(/kejadian darurat/);
    expect(ev.id).toBeTruthy();
  });
});

// ================================================================== routes

describe('emergency routes', () => {
  it('keeps a new contact unverified until the owner confirms consent', async () => {
    const t = build();
    const app = makeApp({ store: t.store, service: t.svc });
    const created = await request(app).post('/api/emergency/contacts').send({ name: 'Ibu', phone: '0812-3456-789', relation: 'keluarga' });
    expect(created.status).toBe(201);
    expect(created.body.contact.verified).toBe(false);
    expect(created.body.contact.phone).toBe('08123456789'); // cleaned, not trusted raw
    const id = created.body.contact.id;

    const gate = await request(app).post(`/api/emergency/contacts/${id}/verify`).send({});
    expect(gate.status).toBe(400);
    const verified = await request(app).post(`/api/emergency/contacts/${id}/verify`).send({ consent: true });
    expect(verified.body.contact.verified).toBe(true);
    expect(t.store.contacts.reachable()).toHaveLength(1);

    const badPhone = await request(app).post('/api/emergency/contacts').send({ name: 'X', phone: 'bukan-nomor' });
    expect(badPhone.status).toBe(400);
    const noChannel = await request(app).post('/api/emergency/contacts').send({ name: 'Tanpa kanal' });
    expect(noChannel.status).toBe(400);
  });

  it('sends a channel test only after typing UJI, and still simulates it', async () => {
    const sends = [];
    const t = build({ channels: { whatsapp: (phone, text) => { sends.push(text); return { ok: true, id: 'x' }; } } });
    const c = t.store.contacts.create({ name: 'Ayah', phone: '08129876543', verified: true, consent: true });
    t.store.contacts.update(c.id, { whatsapp: true });
    const app = makeApp({ store: t.store, service: t.svc });

    const noConfirm = await request(app).post(`/api/emergency/contacts/${c.id}/test`).send({});
    expect(noConfirm.status).toBe(400);
    const res = await request(app).post(`/api/emergency/contacts/${c.id}/test`).send({ confirm: 'UJI' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('simulate');
    expect(res.body.results[0].status).toBe('simulated');
    expect(res.body.note).toMatch(/tidak ada pesan nyata/);
    expect(sends).toHaveLength(0);
    // The probe is recorded with no incident attached (event_id NULL).
    expect(t.store.attempts.all(10)[0].event_id).toBeNull();

    const noChannel = t.store.contacts.create({ name: 'Hanya nomor', phone: '08121231234', verified: true, consent: true });
    const gated = await request(app).post(`/api/emergency/contacts/${noChannel.id}/test`).send({ confirm: 'UJI' });
    expect(gated.status).toBe(409);
  });

  it('runs the dashboard walk-through and guarantees no real send', async () => {
    const t = build();
    addContact(t.store);
    const app = makeApp({ store: t.store, service: t.svc });
    const res = await request(app).post('/api/emergency/test').send({ auto: true, answer: 'help' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('simulate');
    expect(res.body.attempts.every((a) => a.status === 'simulated')).toBe(true);
    expect(res.body.guarantee).toMatch(/tidak mungkin mengirim/);
    expect(t.store.events.openOne()).toBeNull();
  });

  it('records a manual SOS, lets the owner answer it, and resolves with a note', async () => {
    const t = build();
    addContact(t.store);
    const app = makeApp({ store: t.store, service: t.svc });

    const sos = await request(app).post('/api/emergency/sos').send({ note: 'uji tombol' });
    expect(sos.status).toBe(201);
    expect(sos.body.event.origin).toBe('manual');
    expect(sos.body.mode).toBe('simulate');

    const answered = await request(app).post('/api/emergency/respond').send({ answer: 'bantuan' });
    expect(answered.status).toBe(200);
    expect(answered.body.event.response).toBe('help');
    expect(t.store.attempts.forEvent(sos.body.event.id)[0].status).toBe('simulated');

    const resolved = await request(app).post('/api/emergency/resolve').send({ notes: 'sudah terhubung, aman' });
    expect(resolved.body.event.status).toBe('resolved');
    expect(resolved.body.event.notes).toMatch(/sudah terhubung/);
    expect(t.store.events.openOne()).toBeNull();

    const none = await request(app).post('/api/emergency/respond').send({ answer: 'aman' });
    expect(none.status).toBe(404);
  });

  it('refuses to go live without the explicit confirmation word, and reports the effective mode', async () => {
    const t = build();
    const app = makeApp({ store: t.store, service: t.svc });
    const denied = await request(app).put('/api/emergency/settings').send({ mode: 'live' });
    expect(denied.status).toBe(400);
    const ok = await request(app).put('/api/emergency/settings').send({ mode: 'live', confirmLive: 'LIVE' });
    expect(ok.status).toBe(200);
    expect(ok.body.effectiveMode).toBe('live');
    const status = await request(app).get('/api/emergency/status');
    expect(status.body.status.notice).toMatch(/LIVE/);
    // Put it back before the test ends, so nothing downstream is ever live.
    expect((await request(app).put('/api/emergency/settings').send({ mode: 'simulate' })).body.effectiveMode).toBe('simulate');
  });

  it('serves status, history and settings', async () => {
    const t = build();
    const app = makeApp({ store: t.store, service: t.svc });
    const status = await request(app).get('/api/emergency/status');
    expect(status.body.status.mode).toBe('simulate');
    expect(status.body.status.channels.ownerNotify).toBe(false);
    expect(status.body.status.notice).toMatch(/SIMULASI/);

    await request(app).post('/api/emergency/test').send({ auto: true, preset: 'manual' });
    const history = await request(app).get('/api/emergency/history');
    expect(history.body.events.length).toBeGreaterThan(0);
    const one = await request(app).get(`/api/emergency/history/${history.body.events[0].id}`);
    expect(one.body.event.id).toBe(history.body.events[0].id);
    expect(one.body.attempts).toBeDefined();

    const settings = await request(app).get('/api/emergency/settings');
    expect(settings.body.settings.countdownMs).toBeGreaterThanOrEqual(5_000);
    const badSens = await request(app).put('/api/emergency/settings').send({ sensitivity: 'ekstrem' });
    expect(badSens.status).toBe(400);
    const badCount = await request(app).put('/api/emergency/settings').send({ countdownMs: 1_000 });
    expect(badCount.status).toBe(400);
  });

  it('blocks SOS entirely while the module is switched off (403)', async () => {
    const t = build();
    const app = makeApp({ store: t.store, service: t.svc });
    await request(app).put('/api/emergency/settings').send({ enabled: false });
    const res = await request(app).post('/api/emergency/sos').send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('disabled');
  });
});
