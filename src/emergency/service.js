/**
 * src/emergency/service.js
 *
 * The escalation engine. Deliberately NOT an AI feature: the whole safety path
 * is deterministic, auditable code, and it keeps working when every model
 * provider is down.
 *
 *   detector → event(confirming) → countdown
 *        ├─ owner answers "Saya aman"      → cancelled, recorded for evaluation
 *        ├─ owner answers "Butuh bantuan"  → escalate now
 *        └─ no answer until the deadline   → escalate
 *
 *   escalate → contacts in priority order → attempts per channel
 *            → retry with backoff → next contact → honest summary
 *
 * Two modes, never mixed up:
 *   - simulate: the entire flow runs, attempts are recorded as "simulated" and
 *     no message leaves the machine. Only the OWNER's own chat may show a copy,
 *     clearly labelled SIMULASI.
 *   - live: attempts go to the real channels that are actually configured;
 *     each one stores the provider's real outcome. A failure is never reported
 *     as a delivery.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { EventEmitter } from 'node:events';
import { scoreRisk, buildEmergencyMessage, SENSITIVITY_PRESETS } from './detect.js';
import { localTime } from '../worklog/time.js';

const SIM_TAG = '[SIMULASI]';

export class EmergencyError extends Error {
  constructor(message, code = 'bad_request') {
    super(message);
    this.name = 'EmergencyError';
    this.code = code;
  }
}

export class EmergencyService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.store
   * @param {object} [deps.location]  location service (for last known position & places)
   * @param {object} [deps.channels]  { telegram(chatId,text), whatsapp(phone,text), email({to,subject,text}), webhook(payload) }
   * @param {Function} [deps.ownerNotify] async (text, {urgent}) => {ok, channel, error}
   * @param {Function} [deps.now]
   * @param {object} [deps.env]
   * @param {Function} [deps.memory]  hook for learning from false positives
   */
  constructor({ store, location = null, channels = {}, ownerNotify = null, now = () => Date.now(), env = process.env, memory = null, log = null }) {
    super();
    this.store = store;
    this.location = location;
    this.channels = channels;
    this.ownerNotify = ownerNotify;
    this.now = now;
    this.env = env;
    this.memory = memory;
    this.logger = log || ((m) => console.log(m));
    this._timer = null;
    this._ticking = false;
    this._lastFeedAt = 0;
  }

  settings() { return this.store.settings.get(); }

  updateSettings(patch) {
    const s = this.store.settings.set(patch || {});
    if (patch?.sensitivity && !SENSITIVITY_PRESETS[patch.sensitivity]) {
      throw new EmergencyError('Sensitivitas harus low, medium, atau high.', 'bad_request');
    }
    this.emit('change', { kind: 'settings', ts: this.now() });
    return s;
  }

  /** The mode actually used for NEW events: env can force simulation globally. */
  effectiveMode(requested = null) {
    const envMode = String(this.env.EMERGENCY_MODE || '').toLowerCase();
    const settingsMode = this.settings().mode;
    const mode = requested || (envMode === 'live' || envMode === 'simulate' ? envMode : settingsMode);
    return mode === 'live' ? 'live' : 'simulate';
  }

  // -------------------------------------------------------------- detection

  /** Called by the location service for every accepted batch. */
  feed({ sessionId, samples = [], state = {} }) {
    const s = this.settings();
    if (!s.enabled) return null;
    const now = this.now();
    if (now - this._lastFeedAt < 5_000) return null; // scoring 10x/minute buys nothing
    this._lastFeedAt = now;
    if (this.store.events.openOne()) return null;     // one open incident at a time

    const last = samples[samples.length - 1];
    if (!last) return null;

    const recent = this.location
      ? this.location.store.samples.range(sessionId, now - 10 * 60_000, now, 300)
      : samples.slice(-300);
    const motion = recent
      .filter((r) => r.motion)
      .map((r) => ({ ts: r.ts, mag: r.motion.mag ?? r.motion.accel, rot: r.motion.rot ?? r.motion.gyro }));
    const sensorAgeMs = motion.length ? now - Math.max(...motion.map((m) => m.ts)) : null;

    const movement = this.location ? this.location.currentStatus().movement : { state: 'unknown' };
    const place = this.location?.placeAt ? this.location.placeAt(last.lat, last.lon, last.accuracy) : null;
    const stillnessMs = movement?.state === 'moving' ? 0 : Math.max(0, now - (movement?.since || last.ts));

    const result = scoreRisk(
      { samples: recent, motion, sensorAgeMs, place, stillnessMs, now },
      { now, sensitivity: s.sensitivity, detect: s.detect }
    );

    if (result.level === 'none') return null;
    this.emit('score', { sessionId, ...result });

    if (result.level === 'watch') {
      // Low risk: the owner is asked, contacts are NOT touched.
      this._ownerMessage(
        `Ada perubahan gerak yang tidak biasa di perjalanan (${result.signals.map((x) => x.name).join(', ') || 'pola berhenti'}); risikonya rendah. Kalau aman, abaikan pesan ini. ${result.guards.join(' ')}`.trim(),
        { urgent: false, kind: 'watch' }
      );
      return { level: 'watch', score: result.score };
    }

    const event = this.raise({
      origin: 'detector',
      mode: this.effectiveMode(),
      trigger: { level: result.level, score: result.score, signals: result.signals, guards: result.guards, sensorAvailable: result.sensorAvailable, confidence: result.confidence, summary: result.summary },
      location: this._lastKnown(),
      sessionId,
    });
    return { level: result.level, score: result.score, eventId: event.id };
  }

  /** Manual trigger: the panic button on the phone, or an operator test. */
  sos({ note = null, mode = null, deviceId = null, sessionId = null } = {}) {
    const event = this.raise({
      origin: 'manual',
      mode: this.effectiveMode(mode),
      trigger: { level: 'manual', score: null, signals: [{ name: 'manual_sos', weight: null, detail: 'tombol darurat ditekan pemilik perangkat' }], guards: [], sensorAvailable: null, confidence: 1, summary: 'Permintaan bantuan manual dari perangkat.' },
      location: this._lastKnown(),
      sessionId,
      deviceId,
      notes: note,
      skipCountdown: true,
    });
    return event;
  }

  _lastKnown() {
    if (!this.location) return null;
    try {
      const st = this.location.currentStatus();
      if (!st.position) return null;
      return {
        lat: st.position.lat,
        lon: st.position.lon,
        accuracy: st.position.accuracy,
        ts: st.position.ts,
        fresh: st.position.fresh,
        label: st.position.label,
        movement: st.movement?.state || 'unknown',
        place: st.place || null,
      };
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------------- events

  /**
   * Creates an event and starts the confirmation window. Deterministic: the
   * deadline is persisted, so a server restart during a countdown resumes it.
   */
  raise({ origin = 'detector', mode = null, trigger = null, location = null, sessionId = null, deviceId = null, notes = null, skipCountdown = false, countdownMs = null } = {}) {
    const s = this.settings();
    if (!s.enabled) throw new EmergencyError('Modul darurat dimatikan di pengaturan.', 'disabled');
    const realMode = this.effectiveMode(mode);
    const cd = skipCountdown || !s.requireConfirmation ? 0 : (countdownMs ?? s.countdownMs);
    const event = this.store.events.create({
      ts: this.now(),
      mode: realMode,
      status: cd > 0 ? 'confirming' : 'escalating',
      origin,
      trigger,
      location,
      sessionId,
      deviceId,
      countdownMs: cd || null,
      notes,
    });
    this.store.events.update(event.id, realMode === 'simulate' ? { notes: `${notes ? `${notes} · ` : ''}mode simulasi: tidak ada pesan nyata ke kontak` } : (notes ? { notes } : {}));
    const label = realMode === 'simulate' ? 'SIMULASI · ' : '';
    this._ownerMessage(
      `${label}${trigger?.summary || 'Dugaan keadaan darurat.'} Yakin ${cd > 0 ? `dalam ${Math.round(cd / 1000)} detik` : 'sekarang'}: bila memang darurat, kontak darurat akan diberi tahu.\n` +
      `Balas "aman" kalau Anda baik-baik saja, atau "butuh bantuan" untuk langsung menjalankan prosedur darurat.` +
      (s.requireConfirmation && cd > 0 ? `\nJika tidak ada jawaban sampai hitung mundur habis, prosedur darurat berjalan otomatis.` : ''),
      { urgent: true, kind: 'event_raised', eventId: event.id }
    );
    this.emit('change', { kind: 'event', eventId: event.id, status: event.status, mode: realMode });
    this.store.events.update(event.id, {});
    return this.store.events.get(event.id);
  }

  /** Owner (or device UI) answers the countdown. */
  respond(eventId, answer) {
    const event = this.store.events.get(eventId);
    if (!event) throw new EmergencyError('Kejadian darurat tidak ditemukan.', 'not_found');
    if (!['confirming', 'escalating'].includes(event.status)) {
      return event; // already resolved/cancelled: answering again changes nothing
    }
    const yes = String(answer || '').toLowerCase();
    const safe = ['safe', 'aman', 'saya_aman', 'ok', 'oke', 'ya'].includes(yes);
    const help = ['help', 'bantuan', 'butuh_bantuan', 'tolong', 'sos'].includes(yes);
    if (!safe && !help) throw new EmergencyError('Jawaban harus "safe" atau "help".', 'bad_request');

    if (safe) {
      const resolved = this.store.events.update(eventId, {
        status: 'cancelled',
        response: 'safe',
        responded_at: this.now(),
        resolved_at: this.now(),
        resolution: 'pemilik menyatakan aman — eskalasi dibatalkan, kejadian disimpan untuk evaluasi deteksi',
      });
      this.store.events.update(eventId, {});
      try {
        this.memory?.({
          kind: 'emergency_false_positive',
          note: `kejadian ${eventId} dibatalkan pemilik ("aman")`,
          trigger: event.trigger,
          at: this.now(),
        });
      } catch { /* memory optional */ }
      this._ownerMessage(`Siap, eskalasi dibatalkan. Kejadian tetap tercatat untuk mengevaluasi sensitivitas deteksi.`, { urgent: false, kind: 'event_cancelled' });
      this.emit('change', { kind: 'event', eventId, status: 'cancelled' });
      return resolved;
    }

    const updated = this.store.events.update(eventId, { status: 'escalating', response: 'help', responded_at: this.now() });
    this.store.events.update(eventId, {});
    this.emit('change', { kind: 'event', eventId, status: 'escalating' });
    return this.escalate(updated, { reason: 'pemilik meminta bantuan' });
  }

  /** Explicit close by the operator after everything is fine. */
  resolve(eventId, { resolution = 'ditutup operator', notes = null } = {}) {
    const event = this.store.events.get(eventId);
    if (!event) throw new EmergencyError('Kejadian darurat tidak ditemukan.', 'not_found');
    const updated = this.store.events.update(eventId, {
      status: 'resolved', resolved_at: this.now(), resolution,
      notes: [event.notes, notes].filter(Boolean).join(' · ') || null,
    });
    this.emit('change', { kind: 'event', eventId, status: 'resolved' });
    return updated;
  }

  // -------------------------------------------------------------- escalation

  /** Builds the message and walks the contact list, recording each attempt. */
  async escalate(event, { reason = 'timeout' } = {}) {
    const s = this.settings();
    const mode = event.mode || this.effectiveMode();
    const message = buildEmergencyMessage({
      ownerName: String(this.env.OWNER_NAME || 'Wisnu Alfian Nur Ashar').split(/\s+/)[0],
      location: event.location,
      event,
      baseUrl: this.env.PUBLIC_BASE_URL || null,
      callName: String(this.env.OWNER_PHONE || '').trim() || null,
    });

    if (!event.escalated_at) {
      event = this.store.events.update(event.id, { escalated_at: this.now(), status: 'escalating' });
      this.store.events.update(event.id, {});
      // The owner gets the version with the controls first.
      this._ownerMessage(
        `${mode === 'simulate' ? `${SIM_TAG} ` : ''}Prosedur darurat dijalankan (${reason}).\n${message}\n\nBalas "aman" bila sudah teratasi, atau "selesai" untuk menutup kejadian.`,
        { urgent: true, kind: 'event_escalated', eventId: event.id }
      );
    }

    const contacts = this.store.contacts.reachable();
    if (!contacts.length) {
      this.store.events.update(event.id, {
        status: 'escalated_no_contacts',
        resolution: 'Tidak ada kontak darurat terverifikasi yang bisa dihubungi. Tambahkan dan verifikasi kontak di halaman Pelacakan → Darurat.',
      });
      this.store.events.update(event.id, {});
      this._ownerMessage(`Tidak ada kontak darurat terverifikasi/aktif. Saya tidak bisa memberi tahu siapa pun — mohon atur kontak darurat.`, { urgent: true, kind: 'no_contacts' });
      this.emit('change', { kind: 'event', eventId: event.id, status: 'escalated_no_contacts' });
      return this.store.events.get(event.id);
    }

    const results = [];
    for (const contact of contacts) {
      const channels = this._channelsFor(contact);
      for (const ch of channels) {
        const sent = this.store.attempts.countFor(event.id, contact.id, ch.channel);
        if (sent >= s.maxAttemptsPerContact) continue;
        const attempt = await this._attempt({ event, contact, channel: ch, message, mode, attemptNo: sent + 1 });
        results.push(attempt);
      }
      // Enough attempts on this contact? Move to the next one in the next tick.
      const tried = this.store.attempts.forEvent(event.id).filter((a) => a.contact_id === contact.id);
      const delivered = tried.some((a) => a.status === 'sent' || a.status === 'simulated');
      if (delivered || tried.length >= s.advanceAfterAttempts) break;
    }

    const all = this.store.attempts.forEvent(event.id);
    const anyDelivered = all.some((a) => a.status === 'sent');
    const anySimulated = all.some((a) => a.status === 'simulated');
    if (!results.length || (all.length && this._exhausted(all, contacts, s))) {
      this.store.events.update(event.id, {
        status: 'escalated',
        resolution: anyDelivered
          ? 'pesan darurat terkirim ke setidaknya satu kontak; menunggu tindakan manusia'
          : anySimulated
            ? 'mode simulasi: seluruh alur berjalan, tidak ada pesan nyata ke kontak'
            : 'semua upaya pengiriman gagal — tidak ada pesan yang terkirim',
      });
      this.store.events.update(event.id, {});
    }
    this.emit('change', { kind: 'event', eventId: event.id, status: this.store.events.get(event.id).status, attempts: all.length });
    return this.store.events.get(event.id);
  }

  _exhausted(all, contacts, s) {
    for (const c of contacts) {
      const rows = all.filter((a) => a.contact_id === c.id);
      if (rows.length < s.maxAttemptsPerContact) return false;
      if (rows.some((a) => a.status === 'sent' || a.status === 'simulated')) return false;
    }
    return true;
  }

  _channelsFor(contact) {
    const out = [];
    if (contact.telegram_chat_id && contact.telegram_ok) {
      out.push({ channel: 'telegram', target: contact.telegram_chat_id, call: (msg) => this.channels.telegram?.(contact.telegram_chat_id, msg) });
    }
    if (contact.phone && contact.whatsapp) {
      out.push({ channel: 'whatsapp', target: contact.phone, call: (msg) => this.channels.whatsapp?.(contact.phone, msg) });
    }
    if (contact.email && contact.email_ok) {
      out.push({ channel: 'email', target: contact.email, call: (msg) => this.channels.email?.({ to: contact.email, subject: 'DARURAT — kemungkinan kecelakaan', text: msg }) });
    }
    if (this.env.EMERGENCY_WEBHOOK_URL) {
      out.push({ channel: 'webhook', target: 'EMERGENCY_WEBHOOK_URL', call: (msg) => this.channels.webhook?.({ contact: { id: contact.id, name: contact.name }, message: msg }) });
    }
    return out;
  }

  async _attempt({ event, contact, channel, message, mode, attemptNo }) {
    const payload = { channel: channel.channel, target: channel.target, text: message, mode, attemptNo };
    if (mode === 'simulate') {
      const attempt = this.store.attempts.create({
        eventId: event.id, contactId: contact.id, channel: channel.channel, target: channel.target,
        attemptNo, status: 'simulated', payload,
      });
      this.store.contacts.noteAttempt(contact.id, 'simulated');
      this.logger(`[EMERGENCY][SIMULASI] pesan untuk ${contact.name} via ${channel.channel} TIDAK dikirim (mode simulasi).`);
      return attempt;
    }
    if (typeof channel.call !== 'function') {
      return this.store.attempts.create({
        eventId: event.id, contactId: contact.id, channel: channel.channel, target: channel.target,
        attemptNo, status: 'unavailable', error: `kanal ${channel.channel} belum dikonfigurasi`, payload,
      });
    }
    const attempt = this.store.attempts.create({
      eventId: event.id, contactId: contact.id, channel: channel.channel, target: channel.target,
      attemptNo, status: 'pending', payload,
    });
    try {
      const res = await channel.call(message);
      const ok = res?.ok !== false && !res?.error;
      const updated = this.store.attempts.update(attempt.id, {
        status: ok ? 'sent' : 'failed',
        provider_response: res?.id || res?.messageId || res?.status || null,
        error: ok ? null : (res?.error || 'provider menolak'),
        sent_at: ok ? this.now() : null,
      });
      this.store.contacts.noteAttempt(contact.id, updated.status);
      return updated;
    } catch (e) {
      const updated = this.store.attempts.update(attempt.id, { status: 'failed', error: e?.message || 'error pengiriman' });
      this.store.contacts.noteAttempt(contact.id, 'failed');
      return updated;
    }
  }

  // -------------------------------------------------------------------- tick

  tick() {
    if (this._ticking) return { acted: false };
    this._ticking = true;
    const now = this.now();
    const s = this.settings();
    try {
      const out = { escalated: 0, retried: 0, closed: 0 };
      // 1) countdown expired with no answer
      for (const event of this.store.events.byStatus('confirming')) {
        if (!event.confirm_deadline || event.confirm_deadline > now) continue;
        if (!s.autoEscalateOnTimeout) {
          this.store.events.update(event.id, { status: 'awaiting_owner', resolution: 'hitung mundur habis; eskalasi otomatis dimatikan di pengaturan' });
          this.store.events.update(event.id, {});
          continue;
        }
        this.escalate(event, { reason: 'tidak ada jawaban sampai hitung mundur habis' }).catch(() => {});
        out.escalated++;
      }
      // 2) retry failed attempts with backoff, and continue the contact walk
      for (const event of this.store.events.byStatus('escalating')) {
        const attempts = this.store.attempts.forEvent(event.id);
        const failedPending = attempts.filter((a) => a.status === 'failed' && now - a.created_at >= s.retryDelayMs * Math.max(1, a.attempt_no));
        if (failedPending.length) {
          this.escalate(event, { reason: 'percobaan ulang setelah kegagalan pengiriman' }).catch(() => {});
          out.retried++;
        } else if (now - (event.escalated_at || event.ts) > 30 * 60_000 && !this._attemptsProgress(attempts)) {
          this.store.events.update(event.id, { status: 'escalated', resolution: 'upaya pengiriman berhenti: tidak ada kanal yang tersedia' });
          this.store.events.update(event.id, {});
          out.closed++;
        }
      }
      return out;
    } finally {
      this._ticking = false;
    }
  }

  _attemptsProgress(attempts) {
    const s = this.settings();
    return attempts.some((a) => a.status === 'sent' || a.status === 'simulated')
      || attempts.every((a) => (a.attempt_no || 1) < s.maxAttemptsPerContact);
  }

  start() {
    if (this._timer) return false;
    this._timer = setInterval(() => { try { this.tick(); } catch (e) { this.logger(`[EMERGENCY] tick error: ${e.message}`); } }, 5_000);
    if (this._timer.unref) this._timer.unref();
    return true;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ------------------------------------------------------------------ status

  status() {
    const s = this.settings();
    const open = this.store.events.openOne();
    const reachable = this.store.contacts.reachable();
    const last = this.store.events.last();
    return {
      enabled: s.enabled,
      mode: this.effectiveMode(),
      modeSource: String(this.env.EMERGENCY_MODE || '').toLowerCase() === 'live' ? 'env' : 'settings',
      countdownMs: s.countdownMs,
      sensitivity: s.sensitivity,
      requireConfirmation: s.requireConfirmation,
      autoEscalateOnTimeout: s.autoEscalateOnTimeout,
      maxAttemptsPerContact: s.maxAttemptsPerContact,
      retryDelayMs: s.retryDelayMs,
      contacts: { total: this.store.contacts.count(), reachable: reachable.length },
      channels: {
        telegram: Boolean(this.channels.telegram),
        whatsapp: Boolean(this.channels.whatsapp),
        email: Boolean(this.channels.email),
        webhook: Boolean(this.env.EMERGENCY_WEBHOOK_URL),
        ownerNotify: Boolean(this.ownerNotify),
      },
      openEvent: open || null,
      lastEvent: last || null,
      // The label follows the EFFECTIVE mode: an env-forced live mode must
      // never be shown to the operator as a simulation.
      notice: this.effectiveMode() === 'live'
        ? 'Mode LIVE: pesan darurat akan benar-benar dikirim ke kontak terverifikasi.'
        : 'Mode SIMULASI: seluruh alur berjalan tanpa mengirim pesan nyata ke kontak.',
    };
  }

  /**
   * End-to-end test that cannot reach a real contact: forces simulate mode,
   * uses a short countdown, and (with auto=true) fast-forwards the whole flow
   * so the operator can see every step in the audit log.
   */
  async simulate({ preset = 'sudden_stop', auto = false, answer = null, countdownMs = 8_000 } = {}) {
    const presets = {
      sudden_stop: {
        level: 'suspected', score: 0.58, sensorAvailable: false, confidence: 0.58,
        signals: [{ name: 'sudden_deceleration', weight: 0.34, detail: 'kecepatan turun dari 34 ke 0 km/jam dalam 4.1 detik' }, { name: 'post_event_stillness', weight: 0.22, detail: 'perangkat diam 2 menit setelah anomali' }],
        guards: ['tidak ada data akselerometer/giroskop dari perangkat — deteksi benturan tidak dapat dilakukan, hanya pola gerak GPS'],
        summary: 'Ada indikasi anomali gerak yang perlu dikonfirmasi ke pemilik perangkat. Bukan berarti kecelakaan sudah terjadi.',
      },
      impact_sensors: {
        level: 'high', score: 0.76, sensorAvailable: true, confidence: 0.8,
        signals: [{ name: 'impact', weight: 0.5, detail: 'benturan terdeteksi dari akselerometer: 3.42 g (ambang 3 g)' }, { name: 'abrupt_rotation', weight: 0.16, detail: 'perubahan orientasi cepat 380 °/s' }, { name: 'post_event_stillness', weight: 0.22, detail: 'perangkat diam 3 menit setelah anomali' }],
        guards: [],
        summary: 'Beberapa sinyal anomali kuat terdeteksi bersamaan. Perlu konfirmasi segera; ini belum terkonfirmasi sebagai kecelakaan.',
      },
      manual: {
        level: 'manual', score: null, sensorAvailable: null, confidence: 1,
        signals: [{ name: 'manual_sos', weight: null, detail: 'tombol darurat ditekan pemilik perangkat (simulasi)' }],
        guards: [], summary: 'Permintaan bantuan manual dari perangkat (simulasi).',
      },
    };
    const trigger = presets[preset] || presets.sudden_stop;
    const event = this.raise({
      origin: 'simulation',
      mode: 'simulate',
      trigger,
      location: this._lastKnown() || { lat: -6.2383, lon: 106.9756, accuracy: 18, ts: this.now(), fresh: false, label: 'lokasi contoh untuk pengujian (tidak ada data GPS nyata)', movement: 'stopped', place: null },
      countdownMs,
      skipCountdown: preset === 'manual' && auto,
    });
    if (!auto) return { event, steps: ['hitung mundur berjalan — jawab "aman" untuk membatalkan atau tunggu tanpa jawaban untuk melihat eskalasi simulasi'] };

    // Fast-forward the whole flow deterministically (used by tests and by the
    // "Uji alur darurat" button) so nothing depends on wall-clock waits.
    const steps = [`kejadian dibuat (${event.status})`];
    if (answer === 'safe') {
      const r = this.respond(event.id, 'safe');
      steps.push(`jawaban pemilik: aman → status ${r.status}`);
      return { event: this.store.events.get(event.id), steps };
    }
    if (answer === 'help') {
      steps.push('jawaban pemilik: butuh bantuan');
    } else {
      steps.push('tidak ada jawaban → hitung mundur habis');
    }
    const escalated = await this.escalate({ ...event, confirm_deadline: this.now() - 1 }, { reason: answer === 'help' ? 'pemilik meminta bantuan (simulasi)' : 'tidak ada jawaban sampai hitung mundur habis (simulasi)' });
    steps.push(`eskalasi dijalankan → status ${escalated.status}`);
    const attempts = this.store.attempts.forEvent(event.id);
    steps.push(`${attempts.length} upaya tercatat: ${attempts.map((a) => `${a.channel}=${a.status}`).join(', ') || 'tidak ada kanal'}`);
    if (!attempts.some((a) => a.status === 'sent')) steps.push('tidak ada pesan nyata yang dikirim (sesuai mode simulasi)');
    // A finished simulation must never linger as an open incident: `feed()`
    // refuses to score while one is open, so a leftover test event would block
    // real detection. It is closed with an explicit, auditable resolution.
    const current = this.store.events.get(event.id);
    if (['confirming', 'escalating'].includes(current?.status)) {
      this.resolve(event.id, { resolution: 'simulasi pengujian alur selesai — tidak ada pesan nyata ke kontak' });
      steps.push('kejadian uji ditutup otomatis supaya tidak menghalangi deteksi nyata');
    }
    return { event: this.store.events.get(event.id), attempts, steps };
  }

  _ownerMessage(text, { urgent = false, kind = 'info', eventId = null } = {}) {
    if (!this.ownerNotify) {
      this.logger(`[EMERGENCY] ${text}`);
      return;
    }
    Promise.resolve()
      .then(() => this.ownerNotify(text, { urgent, kind, eventId }))
      .catch((e) => this.logger(`[EMERGENCY] gagal memberi tahu pemilik: ${e.message}`));
  }

  /** Quick textual summary for the AI chat: never invents, just reports. */
  summaryLine() {
    const s = this.settings();
    const open = this.store.events.openOne();
    const reachable = this.store.contacts.reachable();
    if (!s.enabled) return 'Modul darurat sedang dimatikan.';
    if (open) {
      return `Ada kejadian darurat berstatus "${open.status}" sejak ${localTime(open.ts)} (pemicu: ${open.trigger?.summary || 'tidak diketahui'}, mode ${open.mode}).`;
    }
    return `Modul darurat aktif dalam mode ${this.effectiveMode()}; ${reachable.length} kontak darurat terverifikasi${reachable.length === 0 ? ' (belum ada — tambahkan di halaman Pelacakan)' : ''}.`;
  }
}
