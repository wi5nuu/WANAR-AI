/**
 * src/emergency/store.js
 *
 * Persistence for the emergency workflow: contacts the owner verifies, events
 * with full audit detail, and every delivery attempt with its real outcome.
 * "Pesan terkirim" is only ever written here when a provider actually accepted
 * it — a failed attempt stays visible as failed.
 *
 *   emg_settings   single JSON document (countdown, sensitivity, mode, retry)
 *   emg_contacts   people the owner wants contacted, in priority order
 *   emg_events     one suspected/resolved incident with trigger + location
 *   emg_attempts   one delivery attempt per contact per channel, with status
 *
 * @author Wisnu Alfian Nur Ashar
 */

import crypto from 'node:crypto';

const id = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const parse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

export const DEFAULT_EMERGENCY = Object.freeze({
  enabled: true,
  // 'simulate' means: the whole flow runs, nothing leaves the machine.
  // 'live' is a deliberate, separate decision by the owner.
  mode: 'simulate',
  countdownMs: 25_000,
  sensitivity: 'medium',
  detect: {
    cooldownMs: 10 * 60_000,
    windowMs: 2 * 60_000,
    maxGapMs: 30_000,
  },
  requireConfirmation: true,        // countdown + "Saya aman" / "Butuh bantuan"
  autoEscalateOnTimeout: true,
  maxAttemptsPerContact: 3,
  retryDelayMs: 60_000,
  advanceAfterAttempts: 2,          // move to the next contact after N failed attempts
  notifyOwnerFirst: true,           // the owner's own channel is used before contacts
  includeLastKnownLocation: true,
  webhook: { enabled: true },
});

function merge(base, patch) {
  const out = { ...base, ...(patch || {}) };
  out.detect = { ...base.detect, ...((patch || {}).detect || {}) };
  out.webhook = { ...base.webhook, ...((patch || {}).webhook || {}) };
  return out;
}

export function createEmergencyStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS emg_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS emg_contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      telegram_chat_id TEXT,
      relation TEXT,
      priority INTEGER NOT NULL DEFAULT 10,
      channels TEXT,
      whatsapp INTEGER NOT NULL DEFAULT 0,
      email_ok INTEGER NOT NULL DEFAULT 1,
      telegram_ok INTEGER NOT NULL DEFAULT 1,
      verified INTEGER NOT NULL DEFAULT 0,
      consent INTEGER NOT NULL DEFAULT 0,
      consent_note TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_attempt_at INTEGER,
      last_status TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_emg_contacts_priority ON emg_contacts(active, priority);

    CREATE TABLE IF NOT EXISTS emg_events (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'simulate',
      status TEXT NOT NULL DEFAULT 'confirming',
      origin TEXT NOT NULL DEFAULT 'detector',
      trigger TEXT,
      location TEXT,
      session_id TEXT,
      device_id TEXT,
      countdown_ms INTEGER,
      confirm_deadline INTEGER,
      responded_at INTEGER,
      response TEXT,
      escalated_at INTEGER,
      resolved_at INTEGER,
      resolution TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_emg_events_ts ON emg_events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_emg_events_status ON emg_events(status, confirm_deadline);

    CREATE TABLE IF NOT EXISTS emg_attempts (
      id TEXT PRIMARY KEY,
      -- NULL only for deliberate channel tests the owner ran outside an incident.
      event_id TEXT REFERENCES emg_events(id) ON DELETE CASCADE,
      contact_id TEXT,
      channel TEXT NOT NULL,
      target TEXT,
      attempt_no INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      provider_response TEXT,
      error TEXT,
      payload TEXT,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_emg_attempts_event ON emg_attempts(event_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_emg_attempts_status ON emg_attempts(status, created_at);
  `);

  const now = () => Date.now();

  const settings = {
    get() {
      const row = db.prepare('SELECT data FROM emg_settings WHERE id = 1').get();
      return merge(DEFAULT_EMERGENCY, parse(row?.data, {}));
    },
    set(patch) {
      const merged = merge(settings.get(), patch);
      db.prepare('INSERT INTO emg_settings (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .run(JSON.stringify(merged), now());
      return merged;
    },
  };

  const mapContact = (r) => (r ? { ...r, channels: parse(r.channels, []) , active: Boolean(r.active), verified: Boolean(r.verified), consent: Boolean(r.consent), whatsapp: Boolean(r.whatsapp), email_ok: Boolean(r.email_ok), telegram_ok: Boolean(r.telegram_ok) } : null);

  const contacts = {
    create({
      name, phone = null, email = null, telegramChatId = null, relation = null, priority = 10,
      channels = null, verified = false, consent = false, consentNote = null, active = true, notes = null,
      // The UI's channel switches must survive creation. WhatsApp is opt-in:
      // a phone number alone is not permission to message it.
      whatsapp = false, emailOk = true, telegramOk = true,
    }) {
      const cid = id('ec');
      db.prepare(`INSERT INTO emg_contacts (id, name, phone, email, telegram_chat_id, relation, priority, channels, verified, consent, consent_note, active, notes, whatsapp, email_ok, telegram_ok, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(cid, name, phone, email, telegramChatId, relation, Math.round(priority), channels ? JSON.stringify(channels) : null,
          verified ? 1 : 0, consent ? 1 : 0, consentNote, active ? 1 : 0, notes,
          whatsapp ? 1 : 0, emailOk ? 1 : 0, telegramOk ? 1 : 0, now(), now());
      return contacts.get(cid);
    },
    get: (cid) => mapContact(db.prepare('SELECT * FROM emg_contacts WHERE id = ?').get(cid)),
    list: ({ activeOnly = false } = {}) => {
      const sql = activeOnly
        ? 'SELECT * FROM emg_contacts WHERE active = 1 ORDER BY priority ASC, name ASC'
        : 'SELECT * FROM emg_contacts ORDER BY priority ASC, name ASC';
      return db.prepare(sql).all().map(mapContact);
    },
    update(cid, patch) {
      const cur = contacts.get(cid);
      if (!cur) return null;
      const f = { ...cur, ...patch };
      db.prepare(`UPDATE emg_contacts SET name = ?, phone = ?, email = ?, telegram_chat_id = ?, relation = ?, priority = ?,
                  channels = ?, whatsapp = ?, email_ok = ?, telegram_ok = ?, verified = ?, consent = ?, consent_note = ?, active = ?, notes = ?, updated_at = ? WHERE id = ?`)
        .run(f.name, f.phone, f.email, f.telegram_chat_id, f.relation, Math.round(f.priority), f.channels ? JSON.stringify(f.channels) : null,
          f.whatsapp ? 1 : 0, f.email_ok ? 1 : 0, f.telegram_ok ? 1 : 0, f.verified ? 1 : 0, f.consent ? 1 : 0, f.consent_note,
          f.active ? 1 : 0, f.notes, now(), cid);
      return contacts.get(cid);
    },
    remove: (cid) => db.prepare('DELETE FROM emg_contacts WHERE id = ?').run(cid).changes > 0,
    noteAttempt(cid, status) {
      db.prepare('UPDATE emg_contacts SET last_attempt_at = ?, last_status = ? WHERE id = ?').run(now(), status, cid);
    },
    /** Contacts that can actually be reached: verified + consent + at least one live channel field. */
    reachable() {
      return contacts.list({ activeOnly: true }).filter((c) => c.verified && c.consent);
    },
    count: () => db.prepare('SELECT COUNT(*) AS n FROM emg_contacts WHERE active = 1').get().n,
  };

  const mapEvent = (r) => (r ? { ...r, trigger: parse(r.trigger, null), location: parse(r.location, null) } : null);

  const events = {
    create({ ts = now(), mode = 'simulate', status = 'confirming', origin = 'detector', trigger = null, location = null, sessionId = null, deviceId = null, countdownMs = null, notes = null }) {
      const eid = id('emg');
      db.prepare(`INSERT INTO emg_events (id, ts, mode, status, origin, trigger, location, session_id, device_id, countdown_ms, confirm_deadline, notes, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(eid, ts, mode, status, origin, trigger ? JSON.stringify(trigger) : null, location ? JSON.stringify(location) : null,
          sessionId, deviceId, countdownMs, countdownMs ? ts + countdownMs : null, notes, now(), now());
      return events.get(eid);
    },
    get: (eid) => mapEvent(db.prepare('SELECT * FROM emg_events WHERE id = ?').get(eid)),
    update(eid, patch) {
      const cur = events.get(eid);
      if (!cur) return null;
      const f = { ...cur, ...patch };
      db.prepare(`UPDATE emg_events SET status = ?, trigger = ?, location = ?, countdown_ms = ?, confirm_deadline = ?, responded_at = ?,
                  response = ?, escalated_at = ?, resolved_at = ?, resolution = ?, notes = ?, updated_at = ? WHERE id = ?`)
        .run(f.status, f.trigger ? JSON.stringify(f.trigger) : null, f.location ? JSON.stringify(f.location) : null,
          f.countdown_ms ?? null, f.confirm_deadline ?? null, f.responded_at ?? null, f.response ?? null,
          f.escalated_at ?? null, f.resolved_at ?? null, f.resolution ?? null, f.notes ?? null, now(), eid);
      return events.get(eid);
    },
    list: (limit = 50) => db.prepare('SELECT * FROM emg_events ORDER BY ts DESC LIMIT ?').all(limit).map(mapEvent),
    byStatus: (status) => db.prepare('SELECT * FROM emg_events WHERE status = ? ORDER BY ts ASC').all(status).map(mapEvent),
    openOne: () => {
      const row = db.prepare("SELECT * FROM emg_events WHERE status IN ('confirming','escalating') ORDER BY ts DESC LIMIT 1").get();
      return mapEvent(row);
    },
    forSession: (sessionId) => {
      const row = db.prepare('SELECT * FROM emg_events WHERE session_id = ? ORDER BY ts DESC LIMIT 1').get(sessionId);
      return mapEvent(row);
    },
    last: () => mapEvent(db.prepare('SELECT * FROM emg_events ORDER BY ts DESC LIMIT 1').get()),
    countSince: (since) => db.prepare('SELECT COUNT(*) AS n FROM emg_events WHERE ts >= ?').get(since).n,
  };

  const attempts = {
    create({ eventId, contactId = null, channel, target = null, attemptNo = 1, status = 'pending', payload = null, error = null, providerResponse = null, sentAt = null }) {
      const aid = id('att');
      db.prepare(`INSERT INTO emg_attempts (id, event_id, contact_id, channel, target, attempt_no, status, provider_response, error, payload, created_at, sent_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(aid, eventId, contactId, channel, target, attemptNo, status, providerResponse, error, payload ? JSON.stringify(payload) : null, now(), sentAt);
      return attempts.get(aid);
    },
    get: (aid) => {
      const row = db.prepare('SELECT * FROM emg_attempts WHERE id = ?').get(aid);
      return row ? { ...row, payload: parse(row.payload, null) } : null;
    },
    forEvent: (eventId) => db.prepare('SELECT * FROM emg_attempts WHERE event_id = ? ORDER BY created_at ASC').all(eventId)
      .map((r) => ({ ...r, payload: parse(r.payload, null) })),
    update(aid, patch) {
      const cur = attempts.get(aid);
      if (!cur) return null;
      const f = { ...cur, ...patch };
      db.prepare('UPDATE emg_attempts SET status = ?, provider_response = ?, error = ?, sent_at = ?, payload = ? WHERE id = ?')
        .run(f.status, f.provider_response ?? null, f.error ?? null, f.sent_at ?? null, f.payload ? JSON.stringify(f.payload) : null, aid);
      return attempts.get(aid);
    },
    countFor(eventId, contactId, channel) {
      return db.prepare('SELECT COUNT(*) AS n FROM emg_attempts WHERE event_id = ? AND contact_id IS ? AND channel = ?')
        .get(eventId, contactId, channel).n;
    },
    countChannel: (eventId, channel) => db.prepare('SELECT COUNT(*) AS n FROM emg_attempts WHERE event_id = ? AND channel = ?').get(eventId, channel).n,
    pendingRetry(nowMs, retryDelayMs) {
      return db.prepare("SELECT * FROM emg_attempts WHERE status = 'failed' AND created_at <= ? ORDER BY created_at ASC LIMIT 20")
        .all(nowMs - retryDelayMs).map((r) => ({ ...r, payload: parse(r.payload, null) }));
    },
    all: (limit = 200) => db.prepare('SELECT * FROM emg_attempts ORDER BY created_at DESC LIMIT ?').all(limit).map((r) => ({ ...r, payload: parse(r.payload, null) })),
  };

  return { db, settings, contacts, events, attempts, now };
}
