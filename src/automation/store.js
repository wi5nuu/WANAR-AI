/**
 * src/automation/store.js
 *
 * Persistence for the automation module (SQLite, same database as the rest of
 * Wanar AI). Exposed as a factory so tests can inject an in-memory database.
 *
 * Tables
 *   automation_jobs     scheduled work (email / ai_task / ai_email)
 *   automation_runs     one row per execution of a job
 *   email_campaigns     a batch of emails sharing one template
 *   email_outbox        one row per recipient — the durable send queue
 *   email_suppressions  addresses that must never be mailed (opt-out/bounce)
 *   inbound_messages    provider message ids already handled (webhook dedup)
 *   people              contact memory: everyone who ever messaged, per channel
 *   chat_proposals      risky chat actions waiting for the owner's "YA"
 *
 * @author Wisnu Alfian Nur Ashar
 */

import crypto from 'node:crypto';

export const JobStatus = Object.freeze({
  PENDING_APPROVAL: 'pending_approval', // proposed (e.g. by the agent); inert until a human approves
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
});

export const CampaignStatus = Object.freeze({
  DRAFT: 'draft',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

export const OutboxStatus = Object.freeze({
  QUEUED: 'queued',
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

const id = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

/**
 * Suppression keys. Email keeps the bare address (backwards compatible);
 * every other channel is namespaced so a Telegram id can never collide with,
 * or be mistaken for, an email address.
 */
export function suppressionKey(channel, address) {
  const a = String(address).toLowerCase();
  return !channel || channel === 'email' ? a : `${channel}:${a}`;
}
const parse = (s, fallback) => {
  if (s == null || s === '') return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

export function createStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      schedule TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending_approval',
      status_reason TEXT,
      created_by TEXT DEFAULT 'user',
      approved_by TEXT,
      approved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_status TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      fail_streak INTEGER NOT NULL DEFAULT 0,
      max_runs INTEGER,
      ends_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_auto_jobs_due ON automation_jobs(status, next_run_at);

    CREATE TABLE IF NOT EXISTS automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      trigger TEXT NOT NULL DEFAULT 'schedule',
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      output TEXT,
      error TEXT,
      meta TEXT,
      FOREIGN KEY (job_id) REFERENCES automation_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_auto_runs_job ON automation_runs(job_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS email_campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      body_html TEXT,
      from_name TEXT,
      reply_to TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      status_reason TEXT,
      mode TEXT,
      channel TEXT NOT NULL DEFAULT 'email',
      throttle_ms INTEGER NOT NULL DEFAULT 1000,
      total INTEGER NOT NULL DEFAULT 0,
      source_job_id TEXT,
      created_by TEXT DEFAULT 'user',
      approved_by TEXT,
      approved_at INTEGER,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      paused_at INTEGER,
      finished_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS email_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      vars TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      message_id TEXT,
      sent_at INTEGER,
      updated_at INTEGER,
      UNIQUE (campaign_id, email),
      FOREIGN KEY (campaign_id) REFERENCES email_campaigns(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_campaign ON email_outbox(campaign_id, status);
    CREATE INDEX IF NOT EXISTS idx_outbox_sent ON email_outbox(sent_at);

    CREATE TABLE IF NOT EXISTS email_attachments (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_subscribers (
      channel TEXT NOT NULL,
      address TEXT NOT NULL,
      name TEXT,
      username TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (channel, address)
    );

    CREATE TABLE IF NOT EXISTS email_suppressions (
      email TEXT PRIMARY KEY,
      reason TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbound_messages (
      channel TEXT NOT NULL,
      message_id TEXT NOT NULL,
      from_address TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (channel, message_id)
    );

    CREATE TABLE IF NOT EXISTS people (
      channel TEXT NOT NULL,
      address TEXT NOT NULL,
      name TEXT,
      is_owner INTEGER NOT NULL DEFAULT 0,
      seen_count INTEGER NOT NULL DEFAULT 1,
      last_message TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (channel, address)
    );
    CREATE INDEX IF NOT EXISTS idx_people_seen ON people(last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS chat_proposals (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_chat_proposals_pending ON chat_proposals(chat_id, status);
  `);

  // Additive migration: databases created before attachments existed.
  const campaignCols = db.prepare('PRAGMA table_info(email_campaigns)').all().map((c) => c.name);
  if (!campaignCols.includes('channel')) {
    db.exec("ALTER TABLE email_campaigns ADD COLUMN channel TEXT NOT NULL DEFAULT 'email'");
  }
  if (!campaignCols.includes('attachment_ids')) {
    db.exec("ALTER TABLE email_campaigns ADD COLUMN attachment_ids TEXT NOT NULL DEFAULT '[]'");
  }

  const now = () => Date.now();

  // ---------------------------------------------------------------- jobs

  const hydrateJob = (r) => (r ? { ...r, payload: parse(r.payload, {}) } : null);

  const jobs = {
    create({ name, type, schedule, timezone, payload, status, createdBy, nextRunAt, maxRuns, endsAt }) {
      const jid = id('job');
      const t = now();
      db.prepare(`
        INSERT INTO automation_jobs
          (id, name, type, schedule, timezone, payload, status, created_by, created_at, updated_at, next_run_at, max_runs, ends_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        jid, name, type, schedule, timezone, JSON.stringify(payload || {}),
        status || JobStatus.PENDING_APPROVAL, createdBy || 'user', t, t, nextRunAt ?? null,
        maxRuns ?? null, endsAt ?? null
      );
      return jobs.get(jid);
    },
    get: (jid) => hydrateJob(db.prepare('SELECT * FROM automation_jobs WHERE id = ?').get(jid)),
    list: () => db.prepare('SELECT * FROM automation_jobs ORDER BY created_at DESC').all().map(hydrateJob),
    due(atMs) {
      return db.prepare(`
        SELECT * FROM automation_jobs
        WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC
      `).all(atMs).map(hydrateJob);
    },
    update(jid, fields) {
      const allowed = [
        'name', 'schedule', 'timezone', 'status', 'status_reason', 'approved_by', 'approved_at',
        'next_run_at', 'last_run_at', 'last_status', 'run_count', 'fail_streak', 'max_runs', 'ends_at',
      ];
      const sets = [];
      const values = [];
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'payload') {
          sets.push('payload = ?');
          values.push(JSON.stringify(v || {}));
        } else if (allowed.includes(k)) {
          sets.push(`${k} = ?`);
          values.push(v);
        }
      }
      if (!sets.length) return jobs.get(jid);
      sets.push('updated_at = ?');
      values.push(now(), jid);
      db.prepare(`UPDATE automation_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      return jobs.get(jid);
    },
    remove: (jid) => db.prepare('DELETE FROM automation_jobs WHERE id = ?').run(jid).changes > 0,
  };

  // ---------------------------------------------------------------- runs

  const runs = {
    start(jobId, trigger = 'schedule') {
      const info = db.prepare(
        "INSERT INTO automation_runs (job_id, trigger, status, started_at) VALUES (?, ?, 'running', ?)"
      ).run(jobId, trigger, now());
      return Number(info.lastInsertRowid);
    },
    finish(runId, { status, output, error, meta }) {
      db.prepare(`
        UPDATE automation_runs SET status = ?, finished_at = ?, output = ?, error = ?, meta = ? WHERE id = ?
      `).run(
        status, now(),
        output == null ? null : String(output).slice(0, 20000),
        error == null ? null : String(error).slice(0, 2000),
        meta ? JSON.stringify(meta) : null,
        runId
      );
    },
    forJob: (jobId, limit = 30) =>
      db.prepare('SELECT * FROM automation_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?')
        .all(jobId, limit)
        .map((r) => ({ ...r, meta: parse(r.meta, null) })),
    recent: (limit = 50) =>
      db.prepare(`
        SELECT r.*, j.name AS job_name, j.type AS job_type
        FROM automation_runs r LEFT JOIN automation_jobs j ON j.id = r.job_id
        ORDER BY r.started_at DESC LIMIT ?
      `).all(limit).map((r) => ({ ...r, meta: parse(r.meta, null) })),
    /** Marks runs that were mid-flight when the process died. */
    failInterrupted() {
      return db.prepare(`
        UPDATE automation_runs SET status = 'failed', finished_at = ?, error = 'Terputus (server restart)'
        WHERE status = 'running'
      `).run(now()).changes;
    },
  };

  // ----------------------------------------------------------- campaigns

  const campaigns = {
    create({ name, subject, bodyText, bodyHtml, fromName, replyTo, throttleMs, sourceJobId, createdBy, attachmentIds, channel }) {
      const cid = id('cmp');
      db.prepare(`
        INSERT INTO email_campaigns
          (id, name, subject, body_text, body_html, from_name, reply_to, throttle_ms, source_job_id, created_by, created_at, attachment_ids, channel)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cid, name, subject, bodyText, bodyHtml || null, fromName || null, replyTo || null,
        throttleMs ?? 1000, sourceJobId || null, createdBy || 'user', now(),
        JSON.stringify(Array.isArray(attachmentIds) ? attachmentIds : []),
        channel || 'email'
      );
      return campaigns.get(cid);
    },
    get(cid) {
      const row = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(cid);
      if (!row) return null;
      return { ...row, attachmentIds: parse(row.attachment_ids, []), stats: campaigns.stats(cid) };
    },
    list(limit = 100) {
      return db.prepare('SELECT * FROM email_campaigns ORDER BY created_at DESC LIMIT ?')
        .all(limit)
        .map((r) => ({ ...r, attachmentIds: parse(r.attachment_ids, []), stats: campaigns.stats(r.id) }));
    },
    stats(cid) {
      const rows = db.prepare(
        'SELECT status, COUNT(*) AS n FROM email_outbox WHERE campaign_id = ? GROUP BY status'
      ).all(cid);
      const s = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0, total: 0 };
      for (const r of rows) {
        s[r.status] = r.n;
        s.total += r.n;
      }
      s.done = s.sent + s.failed + s.skipped;
      s.percent = s.total ? Math.round((s.done / s.total) * 100) : 0;
      return s;
    },
    update(cid, fields) {
      const allowed = [
        'name', 'subject', 'body_text', 'body_html', 'from_name', 'reply_to', 'status', 'status_reason',
        'mode', 'throttle_ms', 'total', 'approved_by', 'approved_at', 'started_at', 'paused_at', 'finished_at',
      ];
      const sets = [];
      const values = [];
      for (const [k, v] of Object.entries(fields)) {
        if (allowed.includes(k)) {
          sets.push(`${k} = ?`);
          values.push(v);
        }
      }
      if (!sets.length) return campaigns.get(cid);
      values.push(cid);
      db.prepare(`UPDATE email_campaigns SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      return campaigns.get(cid);
    },
    remove: (cid) => db.prepare('DELETE FROM email_campaigns WHERE id = ?').run(cid).changes > 0,
    byStatus: (status) => db.prepare('SELECT * FROM email_campaigns WHERE status = ?').all(status),
  };

  // -------------------------------------------------------------- outbox

  const insertOutbox = db.prepare(`
    INSERT OR IGNORE INTO email_outbox (campaign_id, email, name, vars, status, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const outbox = {
    /** Bulk insert in one transaction. `skipped` rows carry their reason. */
    addMany(campaignId, rows) {
      const tx = db.transaction((items) => {
        let n = 0;
        for (const r of items) {
          const res = insertOutbox.run(
            campaignId, r.email, r.name || null, JSON.stringify(r.vars || {}),
            r.status || OutboxStatus.QUEUED, r.reason || null, now()
          );
          n += res.changes;
        }
        return n;
      });
      const added = tx(rows);
      db.prepare('UPDATE email_campaigns SET total = (SELECT COUNT(*) FROM email_outbox WHERE campaign_id = ?) WHERE id = ?')
        .run(campaignId, campaignId);
      return added;
    },
    nextQueued(campaignId) {
      const r = db.prepare(
        "SELECT * FROM email_outbox WHERE campaign_id = ? AND status = 'queued' ORDER BY id ASC LIMIT 1"
      ).get(campaignId);
      return r ? { ...r, vars: parse(r.vars, {}) } : null;
    },
    page(campaignId, { status, limit = 100, offset = 0 } = {}) {
      const where = status ? 'AND status = ?' : '';
      const args = status ? [campaignId, status, limit, offset] : [campaignId, limit, offset];
      return db.prepare(
        `SELECT id, email, name, status, attempts, last_error, message_id, sent_at
         FROM email_outbox WHERE campaign_id = ? ${where} ORDER BY id ASC LIMIT ? OFFSET ?`
      ).all(...args);
    },
    all(campaignId) {
      return db.prepare('SELECT * FROM email_outbox WHERE campaign_id = ? ORDER BY id ASC')
        .all(campaignId)
        .map((r) => ({ ...r, vars: parse(r.vars, {}) }));
    },
    mark(rowId, { status, error, messageId, attempts }) {
      db.prepare(`
        UPDATE email_outbox
        SET status = ?, last_error = ?, message_id = COALESCE(?, message_id),
            attempts = COALESCE(?, attempts), sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
            updated_at = ?
        WHERE id = ?
      `).run(status, error || null, messageId || null, attempts ?? null, status, now(), now(), rowId);
    },
    requeueFailed(campaignId) {
      return db.prepare(
        "UPDATE email_outbox SET status = 'queued', attempts = 0, last_error = NULL WHERE campaign_id = ? AND status = 'failed'"
      ).run(campaignId).changes;
    },
    /** At-most-once: a row that was mid-send when we crashed is NOT retried blindly. */
    failInterrupted() {
      return db.prepare(`
        UPDATE email_outbox SET status = 'failed',
          last_error = 'Terputus saat pengiriman — periksa kotak keluar sebelum kirim ulang'
        WHERE status = 'sending'
      `).run().changes;
    },
    /** Live messages sent since `sinceMs` on one channel (default email). */
    sentSince(sinceMs, channel = 'email') {
      return db.prepare(
        "SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'sent' AND sent_at >= ? AND campaign_id IN (SELECT id FROM email_campaigns WHERE mode = 'live' AND channel = ?)"
      ).get(sinceMs, channel).n;
    },
    /** Sent today per channel, for the dashboard. */
    sentSinceByChannel(sinceMs) {
      const out = {};
      for (const r of db.prepare(
        "SELECT c.channel AS channel, COUNT(*) AS n FROM email_outbox o JOIN email_campaigns c ON c.id = o.campaign_id WHERE o.status = 'sent' AND o.sent_at >= ? AND c.mode = 'live' GROUP BY c.channel"
      ).all(sinceMs)) out[r.channel] = r.n;
      return out;
    },
  };

  // -------------------------------------------------------- suppressions

  const suppressions = {
    add(email, reason = 'manual') {
      db.prepare('INSERT OR REPLACE INTO email_suppressions (email, reason, created_at) VALUES (?, ?, ?)')
        .run(String(email).toLowerCase(), reason, now());
    },
    remove: (email) => db.prepare('DELETE FROM email_suppressions WHERE email = ?').run(String(email).toLowerCase()).changes > 0,
    has: (email) => Boolean(db.prepare('SELECT 1 FROM email_suppressions WHERE email = ?').get(String(email).toLowerCase())),
    list: () => db.prepare('SELECT * FROM email_suppressions ORDER BY created_at DESC').all(),
    /** Returns the subset of `emails` that is suppressed, as a Set. */
    filter(emails) {
      const all = new Set(db.prepare('SELECT email FROM email_suppressions').all().map((r) => r.email));
      return new Set(emails.filter((e) => all.has(String(e).toLowerCase())));
    },
  };

  // --------------------------------------------------------- attachments

  const toAttachment = (r) => (r ? {
    id: r.id, filename: r.filename, contentType: r.content_type, size: r.size,
    sha256: r.sha256, storedName: r.stored_name, createdAt: r.created_at,
  } : null);

  const attachments = {
    add({ filename, contentType, size, sha256, storedName }) {
      const aid = id('att');
      db.prepare(`
        INSERT INTO email_attachments (id, filename, content_type, size, sha256, stored_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(aid, filename, contentType, size, sha256, storedName, now());
      return attachments.get(aid);
    },
    get: (aid) => toAttachment(db.prepare('SELECT * FROM email_attachments WHERE id = ?').get(aid)),
    getMany(ids) {
      return ids.map((i) => attachments.get(i)).filter(Boolean);
    },
    list: () => db.prepare('SELECT * FROM email_attachments ORDER BY created_at DESC').all().map(toAttachment),
    remove: (aid) => db.prepare('DELETE FROM email_attachments WHERE id = ?').run(aid).changes > 0,
  };

  // --------------------------------------------------------- subscribers

  const subscribers = {
    /** Insert or refresh; re-subscribing reactivates. */
    upsert({ channel, address, name, username }) {
      const t = now();
      db.prepare(`
        INSERT INTO channel_subscribers (channel, address, name, username, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(channel, address) DO UPDATE SET
          name = COALESCE(excluded.name, name), username = COALESCE(excluded.username, username),
          active = 1, updated_at = excluded.updated_at
      `).run(channel, String(address), name || null, username || null, t, t);
      return subscribers.get(channel, address);
    },
    get: (channel, address) =>
      db.prepare('SELECT * FROM channel_subscribers WHERE channel = ? AND address = ?').get(channel, String(address)) || null,
    setActive(channel, address, active) {
      return db.prepare('UPDATE channel_subscribers SET active = ?, updated_at = ? WHERE channel = ? AND address = ?')
        .run(active ? 1 : 0, now(), channel, String(address)).changes > 0;
    },
    list(channel, { activeOnly = false } = {}) {
      return db.prepare(
        `SELECT * FROM channel_subscribers WHERE channel = ? ${activeOnly ? 'AND active = 1' : ''} ORDER BY created_at ASC`
      ).all(channel);
    },
    remove: (channel, address) =>
      db.prepare('DELETE FROM channel_subscribers WHERE channel = ? AND address = ?').run(channel, String(address)).changes > 0,
    counts(channel) {
      const r = db.prepare(
        'SELECT COUNT(*) AS total, COALESCE(SUM(active), 0) AS active FROM channel_subscribers WHERE channel = ?'
      ).get(channel);
      return { total: r.total, active: r.active };
    },
  };

  // ------------------------------------------------------------ inbound dedup

  const inbound = {
    /**
     * Claims a provider message id (WhatsApp is push-based and Meta retries
     * webhooks). `true` = first time seen — process it; `false` = duplicate —
     * do not react twice.
     */
    claim(channel, messageId, from = null) {
      if (!messageId) return true;
      const res = db.prepare(
        'INSERT OR IGNORE INTO inbound_messages (channel, message_id, from_address, created_at) VALUES (?, ?, ?, ?)'
      ).run(String(channel), String(messageId).slice(0, 200), from ? String(from).slice(0, 40) : null, now());
      return res.changes > 0;
    },
    count: (channel) => db.prepare('SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = ?').get(String(channel)).n,
  };

  // ------------------------------------------------------------- people
  // Contact memory: everyone who ever messaged the owner's channels — the
  // WhatsApp/Telegram counterpart of the email desk's contacts. One cheap
  // upsert per inbound message; read by the owner's AI context so questions
  // like "siapa yang chat tadi?" can be answered from real data. The owner's
  // own addresses are flagged `is_owner` and hidden from the list.

  const people = {
    /** Records one inbound message. `message` = short preview of the last text. */
    touch({ channel, address, name = null, owner = false, message = null }) {
      const t = now();
      db.prepare(`
        INSERT INTO people (channel, address, name, is_owner, seen_count, last_message, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(channel, address) DO UPDATE SET
          name = COALESCE(excluded.name, people.name),
          is_owner = MAX(people.is_owner, excluded.is_owner),
          seen_count = people.seen_count + 1,
          last_message = COALESCE(excluded.last_message, people.last_message),
          last_seen_at = excluded.last_seen_at
      `).run(
        String(channel), String(address),
        name ? String(name).slice(0, 120) : null,
        owner ? 1 : 0,
        message ? String(message).slice(0, 200) : null,
        t, t
      );
      return people.get(channel, address);
    },
    get: (channel, address) =>
      db.prepare('SELECT * FROM people WHERE channel = ? AND address = ?').get(String(channel), String(address)) || null,
    /** Most recent contacts first; the owner's own numbers are excluded by default. */
    list({ limit = 12, includeOwner = false } = {}) {
      return db.prepare(
        `SELECT * FROM people ${includeOwner ? '' : 'WHERE is_owner = 0'} ORDER BY last_seen_at DESC LIMIT ?`
      ).all(limit);
    },
    count({ includeOwner = false } = {}) {
      return db.prepare(
        `SELECT COUNT(*) AS n FROM people ${includeOwner ? '' : 'WHERE is_owner = 0'}`
      ).get().n;
    },
    remove: (channel, address) =>
      db.prepare('DELETE FROM people WHERE channel = ? AND address = ?').run(String(channel), String(address)).changes > 0,
  };

  // ------------------------------------------------------- chat proposals
  // Risky actions proposed from chat ("kirim kampanye X") wait here until the
  // owner replies YA in the same chat. Managed by automation/chat-actions.js;
  // statuses: pending -> approved -> done | failed, or cancelled / expired /
  // superseded (a newer proposal replaces a stale one).

  const hydrateProposal = (r) => (r ? { ...r, payload: parse(r.payload, {}) } : null);

  const proposals = {
    /** One live proposal per chat: creating a new one supersedes the previous. */
    create({ chatId, kind, payload = {}, ttlMs = 600_000, at = Date.now() }) {
      db.prepare("UPDATE chat_proposals SET status = 'superseded', decided_at = ? WHERE chat_id = ? AND status = 'pending'")
        .run(at, String(chatId));
      const pid = id('prp');
      db.prepare(`
        INSERT INTO chat_proposals (id, chat_id, kind, payload, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `).run(pid, String(chatId), String(kind), JSON.stringify(payload || {}), at, at + ttlMs);
      return proposals.get(pid);
    },
    get: (pid) => hydrateProposal(db.prepare('SELECT * FROM chat_proposals WHERE id = ?').get(pid)),
    /** Latest still-pending proposal for a chat (may be past expiry — caller decides). */
    latest: (chatId) => hydrateProposal(db.prepare(
      "SELECT * FROM chat_proposals WHERE chat_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
    ).get(String(chatId))),
    /** Atomic claim: true only for the first caller (a double YA can never run twice). */
    decide(pid, status, { note = null, at = Date.now() } = {}) {
      return db.prepare(
        "UPDATE chat_proposals SET status = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'"
      ).run(String(status), note == null ? null : String(note).slice(0, 300), at, String(pid)).changes > 0;
    },
    /** Unconditional status set for post-claim outcomes (done / failed / expired). */
    finish(pid, status, { note = null, at = Date.now() } = {}) {
      return db.prepare(
        'UPDATE chat_proposals SET status = ?, note = ?, decided_at = ? WHERE id = ?'
      ).run(String(status), note == null ? null : String(note).slice(0, 300), at, String(pid)).changes > 0;
    },
  };

  return { jobs, runs, campaigns, outbox, suppressions, attachments, subscribers, inbound, people, proposals, _db: db };
}

let defaultStore = null;

/** Lazily binds the shared application database. */
export async function getDefaultStore() {
  if (!defaultStore) {
    const { default: db } = await import('../database.js');
    defaultStore = createStore(db);
  }
  return defaultStore;
}
