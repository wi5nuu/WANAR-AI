/**
 * src/emergency/routes.js
 *
 * REST + SSE for the emergency workflow.
 *
 * The safety invariant lives here too: the DEFAULT for anything that could
 * contact a real person is simulation. Going live needs the owner's explicit
 * settings change (or EMERGENCY_MODE=live in the environment), and the UI is
 * told which mode is effective so it can never mislabel a test as a real alert.
 *
 *   GET    /status  /contacts  /history  /history/:id  /settings
 *   GET    /events                     SSE (countdown, escalations, attempts)
 *   POST   /contacts        PATCH /contacts/:id    DELETE /contacts/:id
 *   POST   /contacts/:id/verify        owner confirms a contact may be called
 *   POST   /contacts/:id/test          one deliberate test message (confirm:"UJI")
 *   POST   /sos                        manual emergency (mode from settings/env)
 *   POST   /respond                    "aman" / "bantuan" for the open incident
 *   POST   /resolve                    close an incident with a note
 *   POST   /test                       full simulated walk-through, zero real sends
 *   PUT    /settings
 *
 * @author Wisnu Alfian Nur Ashar
 */

import express from 'express';
import { createAccessGuard, issueStreamTicket } from '../automation/routes.js';
import { EmergencyError } from './service.js';

const STATUS_FOR_CODE = { not_found: 404, bad_state: 409, disabled: 403, bad_request: 400 };
const BOOL = (v) => (v === true || v === 'true' || v === 1 || v === '1');

/** Phone-number sanity only (never a strict validator: the owner's contacts are his own). */
const cleanPhone = (v) => {
  const s = String(v || '').replace(/[\s().-]/g, '');
  if (!s) return null;
  if (!/^\+?\d{6,20}$/.test(s)) throw new EmergencyError('Nomor telepon tidak valid (contoh: 08123456789 atau +628123456789).', 'bad_request');
  return s;
};
const cleanEmail = (v) => {
  const s = String(v || '').trim();
  if (!s) return null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw new EmergencyError('Alamat email tidak valid.', 'bad_request');
  return s;
};

export function createEmergencyRouter({ emergency, rateLimiters = {}, env = process.env }) {
  const store = emergency.store;
  const svc = emergency.service;
  const router = express.Router();
  router.use(createAccessGuard(env));
  const noop = (req, res, next) => next();
  const act = rateLimiters.automation || noop;

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof EmergencyError) {
        return res.status(STATUS_FOR_CODE[err.code] || 400).json({ success: false, error: err.message, code: err.code });
      }
      console.error('[EMERGENCY] route error:', err);
      return res.status(500).json({ success: false, error: 'Kesalahan internal modul darurat' });
    }
  };

  router.get('/stream-ticket', (req, res) => {
    const secret = String(env.AUTOMATION_TOKEN || '');
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ticket: secret ? issueStreamTicket(secret) : null });
  });

  // ------------------------------------------------------------------ status

  router.get('/status', wrap((req, res) => res.json({ success: true, status: svc.status() })));

  router.get('/overview', wrap((req, res) => {
    res.json({
      success: true,
      status: svc.status(),
      contacts: store.contacts.list(),
      recentEvents: store.events.list(10),
      recentAttempts: store.attempts.all(20),
    });
  }));

  // ---------------------------------------------------------------- contacts

  router.get('/contacts', wrap((req, res) => res.json({ success: true, contacts: store.contacts.list() })));

  router.post('/contacts', act, wrap((req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim()) throw new EmergencyError('Nama kontak wajib diisi.', 'bad_request');
    const phone = cleanPhone(b.phone);
    const email = cleanEmail(b.email);
    const telegram = b.telegramChatId ? String(b.telegramChatId).trim() : null;
    if (!phone && !email && !telegram) throw new EmergencyError('Isi minimal satu kanal: telepon (WhatsApp), email, atau Telegram chat id.', 'bad_request');
    const contact = store.contacts.create({
      name: String(b.name).trim().slice(0, 80),
      phone,
      email,
      telegramChatId: telegram,
      relation: b.relation ? String(b.relation).slice(0, 60) : null,
      priority: Number.isFinite(Number(b.priority)) ? Number(b.priority) : 10,
      channels: Array.isArray(b.channels) ? b.channels : null,
      // A new contact starts UNVERIFIED: the owner must confirm the number himself.
      verified: false,
      consent: false,
      // Honour the channel switches the owner saw in the form; default to the
      // channel implied by each address when the API caller omitted them.
      whatsapp: b.whatsapp !== undefined ? BOOL(b.whatsapp) : Boolean(phone),
      emailOk: b.emailOk !== undefined ? BOOL(b.emailOk) : Boolean(email),
      telegramOk: b.telegramOk !== undefined ? BOOL(b.telegramOk) : Boolean(telegram),
      notes: b.notes ? String(b.notes).slice(0, 400) : null,
    });
    res.status(201).json({ success: true, contact, next: 'Kontak belum terverifikasi. Tekan "Verifikasi" setelah Anda memastikan nomornya benar dan orangnya bersedia dihubungi saat darurat.' });
  }));

  router.patch('/contacts/:id', act, wrap((req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) patch.name = String(b.name).trim().slice(0, 80);
    if (b.phone !== undefined) patch.phone = cleanPhone(b.phone);
    if (b.email !== undefined) patch.email = cleanEmail(b.email);
    if (b.telegramChatId !== undefined) patch.telegram_chat_id = b.telegramChatId ? String(b.telegramChatId).trim() : null;
    if (b.relation !== undefined) patch.relation = b.relation ? String(b.relation).slice(0, 60) : null;
    if (b.priority !== undefined && Number.isFinite(Number(b.priority))) patch.priority = Number(b.priority);
    if (b.active !== undefined) patch.active = BOOL(b.active);
    if (b.notes !== undefined) patch.notes = String(b.notes || '').slice(0, 400);
    if (b.whatsapp !== undefined) patch.whatsapp = BOOL(b.whatsapp);
    if (b.emailOk !== undefined) patch.email_ok = BOOL(b.emailOk);
    if (b.telegramOk !== undefined) patch.telegram_ok = BOOL(b.telegramOk);
    const contact = store.contacts.update(req.params.id, patch);
    if (!contact) throw new EmergencyError('Kontak tidak ditemukan.', 'not_found');
    res.json({ success: true, contact });
  }));

  router.delete('/contacts/:id', act, wrap((req, res) => {
    const ok = store.contacts.remove(req.params.id);
    if (!ok) throw new EmergencyError('Kontak tidak ditemukan.', 'not_found');
    res.json({ success: true });
  }));

  router.post('/contacts/:id/verify', act, wrap((req, res) => {
    const contact = store.contacts.get(req.params.id);
    if (!contact) throw new EmergencyError('Kontak tidak ditemukan.', 'not_found');
    if (req.body?.consent !== true) {
      throw new EmergencyError('Verifikasi butuh pernyataan persetujuan: kirim {"consent":true} setelah Anda memastikan orang ini bersedia dihubungi saat darurat.', 'bad_request');
    }
    const updated = store.contacts.update(contact.id, {
      verified: true,
      consent: true,
      consent_note: req.body?.note ? String(req.body.note).slice(0, 300) : 'pemilik menyatakan kontak ini bersedia dihubungi saat darurat',
    });
    res.json({ success: true, contact: updated });
  }));

  /**
   * One deliberate test message to one contact. Simulation mode never sends;
   * live mode sends a CLEARLY-WORDED test (bukan darurat) only after the owner
   * types UJI — so a test can never be mistaken for a real emergency alert.
   */
  router.post('/contacts/:id/test', act, wrap(async (req, res) => {
    const contact = store.contacts.get(req.params.id);
    if (!contact) throw new EmergencyError('Kontak tidak ditemukan.', 'not_found');
    if (req.body?.confirm !== 'UJI') throw new EmergencyError('Konfirmasi diperlukan: kirim {"confirm":"UJI"}.', 'bad_request');
    const mode = svc.effectiveMode();
    const text = `${mode === 'simulate' ? '[SIMULASI] ' : '[UJI, BUKAN DARURAT] '}Ini pesan uji dari sistem Wanar AI. Tidak ada keadaan darurat. Pemilik sistem memeriksa apakah kanal ini benar-benar sampai ke ${contact.name}.`
      + (mode === 'simulate' ? ' (mode simulasi: pesan ini tidak dikirim ke siapa pun)' : '');
    const channels = svc._channelsFor(contact);
    const results = [];
    for (const ch of channels) {
      const attempt = await svc._attempt({
        event: { id: null }, contact, channel: ch, message: text, mode, attemptNo: 1,
      });
      results.push({ channel: ch.channel, target: ch.target, status: attempt.status, error: attempt.error || null });
    }
    if (!channels.length) {
      throw new EmergencyError('Kontak ini belum punya kanal yang bisa dihubungi. Isi nomor WA/Telegram/email, lalu verifikasi.', 'bad_state');
    }
    res.json({ success: true, mode, results, note: mode === 'simulate' ? 'Mode simulasi aktif: tidak ada pesan nyata yang dikirim.' : 'Pesan uji dikirim melalui kanal yang aktif. Hasil per kanal ada di daftar.' });
  }));

  // ----------------------------------------------------------------- events

  router.get('/history', wrap((req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 200);
    const events = store.events.list(limit).map((e) => ({ ...e, attempts: store.attempts.forEvent(e.id) }));
    res.json({ success: true, events });
  }));

  router.get('/history/:id', wrap((req, res) => {
    const event = store.events.get(req.params.id);
    if (!event) throw new EmergencyError('Kejadian tidak ditemukan.', 'not_found');
    res.json({ success: true, event, attempts: store.attempts.forEvent(event.id) });
  }));

  router.post('/sos', act, wrap((req, res) => {
    const mode = req.body?.mode === 'simulate' ? 'simulate' : null; // "live" is never accepted from a query body
    const event = svc.sos({ note: req.body?.note || 'tombol darurat dari dashboard', mode, sessionId: req.body?.sessionId || null });
    res.status(201).json({ success: true, event: store.events.get(event.id), mode: svc.effectiveMode(req.body?.mode || null) });
  }));

  router.post('/respond', act, wrap(async (req, res) => {
    const open = store.events.openOne();
    if (!open) throw new EmergencyError('Tidak ada kejadian darurat yang menunggu jawaban.', 'not_found');
    // respond() returns a promise when the answer starts an escalation — the
    // dashboard must receive the real event, not a serialized Promise.
    const updated = await svc.respond(open.id, req.body?.answer);
    res.json({ success: true, event: updated });
  }));

  router.post('/resolve', act, wrap((req, res) => {
    const open = req.body?.eventId ? store.events.get(req.body.eventId) : store.events.openOne();
    if (!open) throw new EmergencyError('Tidak ada kejadian untuk ditutup.', 'not_found');
    const updated = svc.resolve(open.id, { resolution: req.body?.resolution || 'ditutup dari dashboard', notes: req.body?.notes || null });
    res.json({ success: true, event: updated });
  }));

  // ------------------------------------------------------------------ tests

  router.post('/test', act, wrap(async (req, res) => {
    const r = await svc.simulate({
      preset: req.body?.preset || 'sudden_stop',
      auto: req.body?.auto === true,
      answer: req.body?.answer || null,
      countdownMs: Number.isFinite(Number(req.body?.countdownMs)) ? Math.max(1000, Number(req.body.countdownMs)) : undefined,
    });
    res.json({ success: true, ...r, mode: 'simulate', guarantee: 'Uji ini tidak mungkin mengirim pesan nyata ke kontak.' });
  }));

  // --------------------------------------------------------------- settings

  router.get('/settings', wrap((req, res) => res.json({ success: true, settings: svc.settings() })));

  router.put('/settings', act, wrap((req, res) => {
    const b = req.body || {};
    const clean = {};
    if (b.enabled !== undefined) clean.enabled = BOOL(b.enabled);
    if (b.mode !== undefined) {
      if (!['simulate', 'live'].includes(b.mode)) throw new EmergencyError('Mode harus "simulate" atau "live".', 'bad_request');
      if (b.mode === 'live' && b.confirmLive !== 'LIVE') {
        throw new EmergencyError('Untuk mengaktifkan mode LIVE, kirim {"mode":"live","confirmLive":"LIVE"} dan pastikan kontak sudah terverifikasi.', 'bad_request');
      }
      clean.mode = b.mode;
    }
    if (b.sensitivity !== undefined) {
      if (!['low', 'medium', 'high'].includes(b.sensitivity)) throw new EmergencyError('Sensitivitas harus low, medium, atau high.', 'bad_request');
      clean.sensitivity = b.sensitivity;
    }
    if (b.countdownMs !== undefined) {
      const n = Number(b.countdownMs);
      if (!Number.isFinite(n) || n < 5_000 || n > 300_000) throw new EmergencyError('Hitung mundur harus 5–300 detik.', 'bad_request');
      clean.countdownMs = Math.round(n);
    }
    for (const key of ['requireConfirmation', 'autoEscalateOnTimeout', 'notifyOwnerFirst', 'includeLastKnownLocation']) {
      if (b[key] !== undefined) clean[key] = BOOL(b[key]);
    }
    for (const [key, min, max] of [['maxAttemptsPerContact', 1, 10], ['retryDelayMs', 5_000, 3_600_000]]) {
      if (b[key] !== undefined) {
        const n = Number(b[key]);
        if (!Number.isFinite(n) || n < min || n > max) throw new EmergencyError(`${key} tidak valid (${min}–${max}).`, 'bad_request');
        clean[key] = Math.round(n);
      }
    }
    const settings = svc.updateSettings(clean);
    res.json({ success: true, settings, effectiveMode: svc.effectiveMode() });
  }));

  // --------------------------------------------------------------- realtime

  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 2000\n\n');
    const send = (e) => { try { res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`); } catch { /* closed */ } };
    svc.on('change', send);
    svc.on('score', send);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15_000);
    req.on('close', () => { clearInterval(hb); svc.off('change', send); svc.off('score', send); });
  });

  return router;
}
