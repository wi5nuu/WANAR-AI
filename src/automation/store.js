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

    CREATE TABLE IF NOT EXISTS email_suppressions (
      email TEXT PRIMARY KEY,
      reason TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL
    );
  `);

  // Additive migration: databases created before attachments existed.
  const campaignCols = db.prepare('PRAGMA table_info(email_campaigns)').all().map((c) => c.name);
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
    create({ name, subject, bodyText, bodyHtml, fromName, replyTo, throttleMs, sourceJobId, createdBy, attachmentIds }) {
      const cid = id('cmp');
      db.prepare(`
        INSERT INTO email_campaigns
          (id, name, subject, body_text, body_html, from_name, reply_to, throttle_ms, source_job_id, created_by, created_at, attachment_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cid, name, subject, bodyText, bodyHtml || null, fromName || null, replyTo || null,
        throttleMs ?? 1000, sourceJobId || null, createdBy || 'user', now(),
        JSON.stringify(Array.isArray(attachmentIds) ? attachmentIds : [])
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
    sentSince(sinceMs) {
      return db.prepare(
        "SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'sent' AND sent_at >= ? AND campaign_id IN (SELECT id FROM email_campaigns WHERE mode = 'live')"
      ).get(sinceMs).n;
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

  return { jobs, runs, campaigns, outbox, suppressions, attachments, _db: db };
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
