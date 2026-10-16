/**
 * src/sales/store.js
 *
 * SQLite storage for the sales desk: leads (people who asked for a service), the messages exchanged
 * with them, and the owner's catalog (services, prices, terms). Additive tables only.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { defaultCatalog } from './catalog.js';

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'negotiating', 'won', 'lost', 'spam'];
const OPEN = ['new', 'contacted', 'qualified', 'proposal', 'negotiating'];

const jparse = (v, d) => { try { return JSON.parse(v); } catch { return d; } };

export class SalesStore {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS sales_leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        contact TEXT NOT NULL,
        name TEXT,
        service_id TEXT,
        need TEXT,
        budget_min INTEGER,
        budget_max INTEGER,
        deadline_days INTEGER,
        urgent INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'new',
        escalated INTEGER NOT NULL DEFAULT 0,
        escalate_reason TEXT,
        hot_notified_at INTEGER,
        last_in_at INTEGER,
        last_out_at INTEGER,
        auto_replies INTEGER NOT NULL DEFAULT 0,
        value_idr INTEGER,
        notes TEXT,
        UNIQUE(source, contact)
      );
      CREATE INDEX IF NOT EXISTS idx_sales_status ON sales_leads(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS sales_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL REFERENCES sales_leads(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        direction TEXT NOT NULL,
        text TEXT NOT NULL,
        auto INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sales_msg_lead ON sales_messages(lead_id, id);
      CREATE TABLE IF NOT EXISTS sales_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  // ------------------------------------------------------------ catalog

  /** The owner's catalog: stored copy, or the defaults (all prices unapproved) the first time. */
  catalog() {
    const row = this.db.prepare("SELECT v FROM sales_meta WHERE k = 'catalog'").get();
    const saved = row ? jparse(row.v, null) : null;
    const base = defaultCatalog();
    if (!saved) return base;
    // Re-attach the match regex (not serialisable) and keep any service added to the defaults later.
    const byId = new Map(base.services.map((s) => [s.id, s]));
    const merged = (saved.services || []).filter((s) => byId.has(s.id)).map((s) => ({ ...byId.get(s.id), ...s, match: byId.get(s.id).match }));
    for (const s of base.services) if (!merged.some((m) => m.id === s.id)) merged.push(s);
    return { services: merged, terms: { ...base.terms, ...(saved.terms || {}) } };
  }

  saveCatalog(cat) {
    const plain = { services: cat.services.map(({ match, ...s }) => s), terms: cat.terms };
    this.db.prepare("INSERT INTO sales_meta (k, v) VALUES ('catalog', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(plain));
  }

  // ------------------------------------------------------------ leads

  _shape(r) {
    if (!r) return null;
    return { ...r, urgent: Boolean(r.urgent), escalated: Boolean(r.escalated), escalate_reason: r.escalate_reason ? jparse(r.escalate_reason, [r.escalate_reason]) : [] };
  }

  getLead(id) { return this._shape(this.db.prepare('SELECT * FROM sales_leads WHERE id = ?').get(Number(id))); }

  findLead(source, contact) { return this._shape(this.db.prepare('SELECT * FROM sales_leads WHERE source = ? AND contact = ?').get(source, contact)); }

  createLead({ source, contact, name = null }) {
    const now = this.now();
    const info = this.db.prepare('INSERT INTO sales_leads (created_at, updated_at, source, contact, name) VALUES (?, ?, ?, ?, ?)').run(now, now, source, contact, name);
    return this.getLead(info.lastInsertRowid);
  }

  /** Applies a patch of known columns. */
  updateLead(id, patch) {
    const cols = ['name', 'service_id', 'need', 'budget_min', 'budget_max', 'deadline_days', 'urgent', 'score', 'status', 'escalated', 'escalate_reason',
      'hot_notified_at', 'last_in_at', 'last_out_at', 'auto_replies', 'value_idr', 'notes'];
    const sets = []; const args = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!cols.includes(k)) continue;
      sets.push(`${k} = ?`);
      args.push(typeof v === 'boolean' ? Number(v) : (k === 'escalate_reason' && v != null && typeof v !== 'string' ? JSON.stringify(v) : v));
    }
    sets.push('updated_at = ?'); args.push(this.now());
    this.db.prepare(`UPDATE sales_leads SET ${sets.join(', ')} WHERE id = ?`).run(...args, Number(id));
    return this.getLead(id);
  }

  addMessage(leadId, direction, text, auto = false) {
    const info = this.db.prepare('INSERT INTO sales_messages (lead_id, ts, direction, text, auto) VALUES (?, ?, ?, ?, ?)')
      .run(Number(leadId), this.now(), direction, String(text).slice(0, 4000), Number(auto));
    return Number(info.lastInsertRowid);
  }

  messages(leadId, limit = 50) {
    return this.db.prepare('SELECT * FROM sales_messages WHERE lead_id = ? ORDER BY id DESC LIMIT ?').all(Number(leadId), limit).reverse()
      .map((m) => ({ ...m, auto: Boolean(m.auto) }));
  }

  /** Inbound messages from this contact in the last hour (flood guard). */
  recentInbound(leadId, windowMs = 3_600_000) {
    return this.db.prepare("SELECT COUNT(*) c FROM sales_messages WHERE lead_id = ? AND direction = 'in' AND ts >= ?").get(Number(leadId), this.now() - windowMs).c;
  }

  listLeads({ status = null, open = false, q = '', limit = 50, offset = 0 } = {}) {
    const where = []; const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    else if (open) { where.push(`status IN (${OPEN.map(() => '?').join(',')})`); args.push(...OPEN); }
    if (q) { where.push('(name LIKE ? OR contact LIKE ? OR need LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM sales_leads ${w} ORDER BY escalated DESC, score DESC, updated_at DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(200, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
    const total = this.db.prepare(`SELECT COUNT(*) n FROM sales_leads ${w}`).get(...args).n;
    return { total, leads: rows.map((r) => this._shape(r)) };
  }

  stats() {
    const q = (sql, ...a) => this.db.prepare(sql).get(...a);
    const day = this.now() - 86_400_000;
    const month = this.now() - 30 * 86_400_000;
    return {
      open: q(`SELECT COUNT(*) n FROM sales_leads WHERE status IN (${OPEN.map(() => '?').join(',')})`, ...OPEN).n,
      newToday: q("SELECT COUNT(*) n FROM sales_leads WHERE created_at >= ? AND status != 'spam'", day).n,
      needsOwner: q(`SELECT COUNT(*) n FROM sales_leads WHERE escalated = 1 AND status IN (${OPEN.map(() => '?').join(',')})`, ...OPEN).n,
      hot: q(`SELECT COUNT(*) n FROM sales_leads WHERE score >= 60 AND status IN (${OPEN.map(() => '?').join(',')})`, ...OPEN).n,
      won30: q("SELECT COUNT(*) n, COALESCE(SUM(value_idr), 0) v FROM sales_leads WHERE status = 'won' AND updated_at >= ?", month),
      lost30: q("SELECT COUNT(*) n FROM sales_leads WHERE status = 'lost' AND updated_at >= ?", month).n,
      byStatus: Object.fromEntries(this.db.prepare('SELECT status, COUNT(*) n FROM sales_leads GROUP BY status').all().map((r) => [r.status, r.n])),
    };
  }
}
