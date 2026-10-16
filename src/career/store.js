/**
 * src/career/store.js
 *
 * SQLite storage for the career radar and for the agent's activity feed.
 *
 *   career_jobs      every posting the agent has seen, its score/verdict and where it stands
 *   agent_activity   a plain-language log of what the agent did and why (the monitoring screen)
 *
 * Both are additive (CREATE TABLE IF NOT EXISTS): nothing existing is touched.
 *
 * @author Wisnu Alfian Nur Ashar
 */

export const STATUSES = ['new', 'shortlisted', 'applying', 'applied', 'interview', 'offer', 'rejected', 'skipped'];
const ACTIVITY_KEEP = 4000;

const j = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };

export class CareerStore {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS career_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        ext_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        company TEXT,
        location TEXT,
        remote INTEGER,
        tags TEXT,
        seniority TEXT,
        salary_text TEXT,
        posted_at INTEGER,
        description TEXT,
        score INTEGER NOT NULL DEFAULT 0,
        verdict TEXT NOT NULL DEFAULT 'skip',
        eligibility TEXT,
        reasons TEXT,
        warnings TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        notified_at INTEGER,
        status_at INTEGER,
        notes TEXT,
        UNIQUE(source, ext_id)
      );
      CREATE INDEX IF NOT EXISTS idx_career_verdict ON career_jobs(verdict, score DESC);
      CREATE INDEX IF NOT EXISTS idx_career_status ON career_jobs(status, status_at DESC);
      CREATE INDEX IF NOT EXISTS idx_career_seen ON career_jobs(first_seen DESC);

      CREATE TABLE IF NOT EXISTS agent_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        detail TEXT,
        ref TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_activity_ts ON agent_activity(id DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_agent ON agent_activity(agent, id DESC);
    `);
    this._insert = db.prepare(`INSERT INTO career_jobs
      (source, ext_id, url, title, company, location, remote, tags, seniority, salary_text, posted_at, description,
       score, verdict, eligibility, reasons, warnings, status, first_seen, last_seen)
      VALUES (@source, @extId, @url, @title, @company, @location, @remote, @tags, @seniority, @salaryText, @postedAt, @description,
       @score, @verdict, @eligibility, @reasons, @warnings, 'new', @now, @now)`);
    this._byKey = db.prepare('SELECT id, status, score, verdict FROM career_jobs WHERE source = ? AND ext_id = ?');
    this._touch = db.prepare(`UPDATE career_jobs SET last_seen = @now, score = @score, verdict = @verdict, eligibility = @eligibility,
      reasons = @reasons, warnings = @warnings, description = CASE WHEN length(@description) > length(COALESCE(description,'')) THEN @description ELSE description END
      WHERE id = @id`);
    this._logStmt = db.prepare('INSERT INTO agent_activity (ts, agent, kind, level, title, detail, ref) VALUES (?, ?, ?, ?, ?, ?, ?)');
  }

  /** Inserts a new posting or refreshes score/last_seen of a known one. @returns {{id:number, inserted:boolean}} */
  upsertJob(job, result) {
    const now = this.now();
    const row = {
      ...job, now, remote: job.remote == null ? null : (job.remote ? 1 : 0),
      tags: JSON.stringify(job.tags || []), description: job.description || '',
      score: result.score, verdict: result.verdict, eligibility: result.eligibility,
      reasons: JSON.stringify(result.reasons || []), warnings: JSON.stringify(result.warnings || []),
    };
    const known = this._byKey.get(job.source, job.extId);
    if (known) { this._touch.run({ ...row, id: known.id }); return { id: known.id, inserted: false, previous: known }; }
    const info = this._insert.run(row);
    return { id: Number(info.lastInsertRowid), inserted: true, previous: null };
  }

  _shape(r) {
    if (!r) return null;
    return { ...r, remote: r.remote == null ? null : Boolean(r.remote), tags: j(r.tags, []), reasons: j(r.reasons, []), warnings: j(r.warnings, []) };
  }

  getJob(id) { return this._shape(this.db.prepare('SELECT * FROM career_jobs WHERE id = ?').get(Number(id))); }

  listJobs({ verdict = null, status = null, q = '', minScore = 0, limit = 50, offset = 0, includeDescription = false } = {}) {
    const where = []; const args = [];
    if (verdict) { where.push('verdict = ?'); args.push(verdict); }
    if (status) { where.push('status = ?'); args.push(status); }
    if (minScore) { where.push('score >= ?'); args.push(Number(minScore)); }
    if (q) { where.push('(title LIKE ? OR company LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    const cols = includeDescription ? '*' : 'id, source, ext_id, url, title, company, location, remote, tags, seniority, salary_text, posted_at, score, verdict, eligibility, reasons, warnings, status, first_seen, last_seen, notified_at, status_at, notes';
    const rows = this.db.prepare(`SELECT ${cols} FROM career_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE verdict WHEN 'apply' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END, score DESC, first_seen DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(200, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM career_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(...args).n;
    return { total, jobs: rows.map((r) => this._shape(r)) };
  }

  setStatus(id, status, notes = null) {
    if (!STATUSES.includes(status)) throw new Error(`status tidak valid: ${status}`);
    const info = this.db.prepare('UPDATE career_jobs SET status = ?, status_at = ?, notes = COALESCE(?, notes) WHERE id = ?')
      .run(status, this.now(), notes, Number(id));
    return info.changes > 0;
  }

  /** Not-yet-announced good postings, best first. */
  unannounced({ verdict = 'apply', limit = 8 } = {}) {
    return this.db.prepare(`SELECT id, source, title, company, location, url, score, reasons, warnings, salary_text, posted_at
      FROM career_jobs WHERE verdict = ? AND notified_at IS NULL AND status = 'new' ORDER BY score DESC, first_seen DESC LIMIT ?`)
      .all(verdict, limit).map((r) => this._shape(r));
  }

  markNotified(ids) {
    const st = this.db.prepare('UPDATE career_jobs SET notified_at = ? WHERE id = ?');
    const now = this.now();
    this.db.transaction(() => { for (const id of ids) st.run(now, id); })();
  }

  stats() {
    const q = (sql, ...a) => this.db.prepare(sql).get(...a);
    const day = this.now() - 86_400_000;
    return {
      total: q('SELECT COUNT(*) n FROM career_jobs').n,
      apply: q("SELECT COUNT(*) n FROM career_jobs WHERE verdict = 'apply' AND status = 'new'").n,
      maybe: q("SELECT COUNT(*) n FROM career_jobs WHERE verdict = 'maybe' AND status = 'new'").n,
      newToday: q('SELECT COUNT(*) n FROM career_jobs WHERE first_seen >= ?', day).n,
      byStatus: Object.fromEntries(this.db.prepare('SELECT status, COUNT(*) n FROM career_jobs GROUP BY status').all().map((r) => [r.status, r.n])),
      lastScan: q("SELECT ts FROM agent_activity WHERE agent = 'career' AND kind = 'scan' ORDER BY id DESC LIMIT 1")?.ts || null,
    };
  }

  // ---------------------------------------------------------- activity feed

  log({ agent = 'system', kind = 'info', level = 'info', title, detail = null, ref = null }) {
    if (!title) return null;
    const info = this._logStmt.run(this.now(), agent, kind, level, String(title).slice(0, 200), detail == null ? null : String(detail).slice(0, 2000), ref == null ? null : String(ref).slice(0, 200));
    if (Number(info.lastInsertRowid) % 200 === 0) this.db.prepare('DELETE FROM agent_activity WHERE id <= (SELECT MAX(id) FROM agent_activity) - ?').run(ACTIVITY_KEEP);
    return Number(info.lastInsertRowid);
  }

  activity({ afterId = 0, agent = null, level = null, limit = 80 } = {}) {
    const where = ['id > ?']; const args = [Number(afterId) || 0];
    if (agent) { where.push('agent = ?'); args.push(agent); }
    if (level) { where.push('level = ?'); args.push(level); }
    return this.db.prepare(`SELECT * FROM agent_activity WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...args, Math.min(300, Math.max(1, Number(limit) || 80)));
  }
}
