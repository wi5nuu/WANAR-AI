/**
 * src/sales/prospects/service.js
 *
 * The client radar: finds people who may need the owner's services, scores them, prepares the first
 * message, and nudges the owner at the right moments (a morning batch of local businesses, a polite
 * follow-up two days later). It never contacts a prospect itself: that is the owner's tap.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { EventEmitter } from 'node:events';
import { fetchFreelancer, fetchOsmBusinesses } from './sources.js';
import { scoreProspect } from './score.js';
import { localOffer, followUpText, freelancerProposal } from './drafts.js';
import { inQuietHours } from '../../career/service.js';
import { wib, wibDay } from '../../career/report.js';
import { rupiah } from '../catalog.js';

export const PROSPECT_STATUSES = ['new', 'contacted', 'replied', 'negotiating', 'won', 'lost', 'skipped'];
const FOLLOWUP_DAYS = [2, 4];          // first nudge after 2 days, second 4 days after that, then stop
const MAX_FOLLOWUPS = 2;
const SCAN_EVERY_MS = 6 * 3_600_000;
const OSM_EVERY_MS = 3 * 86_400_000;
const FIRST_SCAN_DELAY_MS = 3 * 60_000;
const TICK_MS = 5 * 60_000;
const BATCH_HOUR = 8;                  // 08.00 WIB: today's local businesses to contact
const FOLLOWUP_HOUR = 10;              // 10.00 WIB: who to follow up

const jparse = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Words too common in business names to identify one ("Toko", "Laundry", the street, the city). */
const GENERIC = new Set(['toko', 'kedai', 'warung', 'laundry', 'restoran', 'resto', 'cafe', 'kafe', 'coffee', 'shop', 'store', 'official', 'bekasi', 'jakarta', 'depok', 'indah', 'harapan', 'raya', 'jalan',
  'mie', 'bakso', 'ayam', 'salon', 'bengkel', 'apotek', 'klinik', 'sekolah', 'cabang', 'outlet', 'factory', 'boutique', 'bisa', 'kiloan', 'antar', 'jemput', 'barat', 'timur', 'selatan', 'utara', 'pusat', 'group', 'jaya', 'makmur', 'sejahtera']);

const tokens = (s) => [...new Set(String(s || '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4))];

/** Equal, or one typo apart (Asmi ~ Azmi): only for words of 4+ letters. */
function within1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length === b.length) { i += 1; j += 1; } else if (a.length > b.length) i += 1; else j += 1;
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export class ProspectStore {
  constructor(db, { now = Date.now } = {}) {
    this.db = db; this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS sales_prospects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, ext_id TEXT NOT NULL, kind TEXT NOT NULL,
        url TEXT, title TEXT NOT NULL, description TEXT, contact TEXT, mobile INTEGER NOT NULL DEFAULT 0,
        category TEXT, email TEXT, location TEXT,
        currency TEXT, budget_min REAL, budget_max REAL, budget_idr_min INTEGER, budget_idr_max INTEGER,
        hourly INTEGER NOT NULL DEFAULT 0, bids INTEGER NOT NULL DEFAULT 0, posted_at INTEGER, skills TEXT,
        service_id TEXT, score INTEGER NOT NULL DEFAULT 0, verdict TEXT NOT NULL DEFAULT 'skip', reasons TEXT, warnings TEXT,
        status TEXT NOT NULL DEFAULT 'new', status_at INTEGER, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        pushed_at INTEGER, contacted_at INTEGER, followups INTEGER NOT NULL DEFAULT 0, followup_at INTEGER,
        notes TEXT, value_idr INTEGER,
        UNIQUE(source, ext_id)
      );
      CREATE INDEX IF NOT EXISTS idx_prospects_rank ON sales_prospects(verdict, score DESC);
      CREATE INDEX IF NOT EXISTS idx_prospects_status ON sales_prospects(status, followup_at);
    `);
    this._ins = db.prepare(`INSERT INTO sales_prospects
      (source, ext_id, kind, url, title, description, contact, mobile, category, email, location, currency, budget_min, budget_max, budget_idr_min, budget_idr_max,
       hourly, bids, posted_at, skills, service_id, score, verdict, reasons, warnings, first_seen, last_seen)
      VALUES (@source, @extId, @kind, @url, @title, @description, @contact, @mobile, @category, @email, @location, @currency, @budgetMin, @budgetMax, @budgetIdrMin, @budgetIdrMax,
       @hourly, @bids, @postedAt, @skills, @serviceId, @score, @verdict, @reasons, @warnings, @now, @now)`);
    this._upd = db.prepare(`UPDATE sales_prospects SET last_seen = @now, bids = @bids, score = @score, verdict = @verdict, service_id = @serviceId, reasons = @reasons, warnings = @warnings,
      budget_min = @budgetMin, budget_max = @budgetMax, budget_idr_min = @budgetIdrMin, budget_idr_max = @budgetIdrMax WHERE id = @id`);
    this._key = db.prepare('SELECT id FROM sales_prospects WHERE source = ? AND ext_id = ?');
  }

  upsert(p, s) {
    const now = this.now();
    const row = {
      ...p, now, mobile: p.mobile ? 1 : 0, hourly: p.hourly ? 1 : 0, skills: JSON.stringify(p.skills || []), email: p.email || null, location: p.location || '',
      serviceId: s.serviceId, score: s.score, verdict: s.verdict, reasons: JSON.stringify(s.reasons), warnings: JSON.stringify(s.warnings),
    };
    const known = this._key.get(p.source, p.extId);
    if (known) { this._upd.run({ ...row, id: known.id }); return { id: known.id, inserted: false }; }
    return { id: Number(this._ins.run(row).lastInsertRowid), inserted: true };
  }

  _shape(r) {
    if (!r) return null;
    return { ...r, mobile: Boolean(r.mobile), hourly: Boolean(r.hourly), skills: jparse(r.skills, []), reasons: jparse(r.reasons, []), warnings: jparse(r.warnings, []) };
  }

  get(id) { return this._shape(this.db.prepare('SELECT * FROM sales_prospects WHERE id = ?').get(Number(id))); }

  list({ kind = null, verdict = null, status = null, q = '', limit = 50, offset = 0 } = {}) {
    const where = []; const args = [];
    if (kind) { where.push('kind = ?'); args.push(kind); }
    if (verdict) { where.push('verdict = ?'); args.push(verdict); }
    if (status) { where.push('status = ?'); args.push(status); }
    if (q) { where.push('(title LIKE ? OR description LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM sales_prospects ${w} ORDER BY CASE verdict WHEN 'good' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END, score DESC, first_seen DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(200, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
    return { total: this.db.prepare(`SELECT COUNT(*) n FROM sales_prospects ${w}`).get(...args).n, prospects: rows.map((r) => this._shape(r)) };
  }

  setStatus(id, status, { notes = null, value = null } = {}) {
    if (!PROSPECT_STATUSES.includes(status)) throw new Error(`status tidak valid: ${status}`);
    const now = this.now();
    const cur = this.get(id);
    if (!cur) return null;
    const contactedAt = status === 'contacted' && !cur.contacted_at ? now : cur.contacted_at;
    const followupAt = status === 'contacted' ? now + FOLLOWUP_DAYS[Math.min(cur.followups, FOLLOWUP_DAYS.length - 1)] * 86_400_000 : (['replied', 'negotiating', 'won', 'lost', 'skipped'].includes(status) ? null : cur.followup_at);
    this.db.prepare('UPDATE sales_prospects SET status = ?, status_at = ?, contacted_at = ?, followup_at = ?, notes = COALESCE(?, notes), value_idr = COALESCE(?, value_idr) WHERE id = ?')
      .run(status, now, contactedAt, followupAt, notes, value, Number(id));
    return this.get(id);
  }

  markPushed(ids) {
    const st = this.db.prepare('UPDATE sales_prospects SET pushed_at = ? WHERE id = ?'); const now = this.now();
    this.db.transaction(() => { for (const id of ids) st.run(now, id); })();
  }

  /** Contacted prospects who have not answered and are due a polite nudge. */
  dueFollowUps(limit = 6) {
    return this.db.prepare("SELECT * FROM sales_prospects WHERE status = 'contacted' AND followups < ? AND followup_at IS NOT NULL AND followup_at <= ? ORDER BY followup_at LIMIT ?")
      .all(MAX_FOLLOWUPS, this.now(), limit).map((r) => this._shape(r));
  }

  recordFollowUp(id) {
    const cur = this.get(id);
    const n = cur.followups + 1;
    const next = n < MAX_FOLLOWUPS ? this.now() + FOLLOWUP_DAYS[Math.min(n, FOLLOWUP_DAYS.length - 1)] * 86_400_000 : null;
    this.db.prepare('UPDATE sales_prospects SET followups = ?, followup_at = ? WHERE id = ?').run(n, next, Number(id));
    return n;
  }

  stats() {
    const q = (sql, ...a) => this.db.prepare(sql).get(...a);
    const day = this.now() - 86_400_000;
    return {
      total: q('SELECT COUNT(*) n FROM sales_prospects').n,
      good: q("SELECT COUNT(*) n FROM sales_prospects WHERE verdict = 'good' AND status = 'new'").n,
      goodLocal: q("SELECT COUNT(*) n FROM sales_prospects WHERE verdict = 'good' AND status = 'new' AND kind = 'local'").n,
      goodMarket: q("SELECT COUNT(*) n FROM sales_prospects WHERE verdict = 'good' AND status = 'new' AND kind = 'marketplace'").n,
      newGood24: q("SELECT COUNT(*) n FROM sales_prospects WHERE verdict = 'good' AND first_seen >= ?", day).n,
      dueFollowUps: this.dueFollowUps(50).length,
      byStatus: Object.fromEntries(this.db.prepare('SELECT status, COUNT(*) n FROM sales_prospects GROUP BY status').all().map((r) => [r.status, r.n])),
      won: q("SELECT COUNT(*) n, COALESCE(SUM(value_idr), 0) v FROM sales_prospects WHERE status = 'won'"),
    };
  }
}

export class ProspectService extends EventEmitter {
  constructor({ store, getCatalog, getFacts = () => null, notify = null, ownerChat = () => null, log = () => {}, fetchImpl = globalThis.fetch, env = process.env, now = Date.now } = {}) {
    super();
    this.store = store; this.getCatalog = getCatalog; this.getFacts = getFacts;
    this.notify = String(env.CAREER_TELEGRAM || '').toLowerCase() === 'on' ? notify : null;
    this.ownerChat = ownerChat; this.log = log; this.fetchImpl = fetchImpl; this.env = env; this.now = now;
    this.usdIdr = Number(env.USD_IDR) || 16500;
    this.perDay = Math.min(15, Math.max(1, Number(env.SALES_OUTREACH_PER_DAY) || 8));
    this.areas = String(env.SALES_LOCAL_AREAS || 'Bekasi,Jakarta Timur,Jakarta Barat,Jakarta Selatan,Depok').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);
    this.osmDelayMs = env.SALES_OSM_DELAY_MS != null ? Number(env.SALES_OSM_DELAY_MS) : 3000;
    this.osmRetryMs = env.SALES_OSM_RETRY_MS != null ? Number(env.SALES_OSM_RETRY_MS) : 8000;
    this.timers = []; this._scanning = null;
  }

  get enabled() { return String(this.env.SALES_RADAR || 'on').toLowerCase() !== 'off'; }

  // ------------------------------------------------------------ scanning

  scan({ force = false } = {}) {
    if (this._scanning) return this._scanning;
    this._scanning = this._scan({ force }).finally(() => { this._scanning = null; });
    return this._scanning;
  }

  _lastRun(kind) {
    return this.store.db.prepare("SELECT MAX(ts) t FROM agent_activity WHERE agent = 'sales' AND kind = 'prospect_scan' AND ref = ?").get(kind)?.t || 0;
  }

  async _scan({ force }) {
    const catalog = this.getCatalog(); const facts = this.getFacts(); const now = this.now();
    const summary = { fetched: 0, fresh: 0, good: 0, errors: [] };
    const run = async (kind, fn) => {
      try {
        const items = await fn();
        let fresh = 0; let good = 0;
        for (const p of items) {
          const s = scoreProspect(p, catalog, facts, { now });
          const r = this.store.upsert(p, s);
          if (r.inserted) { fresh += 1; if (s.verdict === 'good') good += 1; }
        }
        summary.fetched += items.length; summary.fresh += fresh; summary.good += good;
        this.log({ agent: 'sales', kind: 'prospect_scan', ref: kind, title: `Radar klien (${kind}): ${items.length} dibaca, ${fresh} baru, ${good} cocok` });
      } catch (e) {
        summary.errors.push(`${kind}: ${String(e?.message || e).slice(0, 100)}`);
        this.log({ agent: 'sales', kind: 'prospect_error', level: 'warn', title: `Radar klien: sumber ${kind} gagal`, detail: String(e?.message || e), ref: kind });
      }
    };
    await run('freelancer', () => fetchFreelancer(this.fetchImpl, { usdIdr: this.usdIdr }));
    for (const area of this.areas) {
      if (!force && now - this._lastRun(`osm:${area}`) < OSM_EVERY_MS) continue;
      // Overpass is a free shared service: be polite, and retry when it is merely busy (502/503/504/429).
      await run(`osm:${area}`, async () => {
        for (let attempt = 1; ; attempt += 1) {
          try { return await fetchOsmBusinesses(this.fetchImpl, { area }); } catch (e) {
            if (attempt >= 3 || !/HTTP (?:429|5\d\d)/.test(String(e?.message))) throw e;
            await sleep(this.osmRetryMs * attempt);
          }
        }
      });
      await sleep(this.osmDelayMs);
    }
    this.emit('scan', summary);
    return summary;
  }

  // ------------------------------------------------------------ drafts

  /** The message the owner sends, with a one-tap WhatsApp link when the prospect has a mobile number. */
  draft(id) {
    const p = this.store.get(id);
    if (!p) return null;
    const facts = this.getFacts(); const catalog = this.getCatalog();
    if (p.kind === 'local') {
      const first = localOffer(p, facts);
      const followUp = p.followups < 2 ? followUpText(p, facts, p.followups + 1) : null;
      return { prospect: p, kind: 'local', ...first, followUp };
    }
    // Stored rows use snake_case columns; the proposal writer reads the normalised (camelCase) shape.
    const view = { ...p, budgetMin: p.budget_min, budgetMax: p.budget_max, budgetIdrMin: p.budget_idr_min, budgetIdrMax: p.budget_idr_max, postedAt: p.posted_at };
    const prop = freelancerProposal(view, catalog, facts, { serviceId: p.service_id, usdIdr: this.usdIdr });
    return { prospect: p, kind: 'marketplace', channel: 'platform', text: prop.text, link: p.url, bid: prop.bid, warnings: prop.warnings };
  }

  setStatus(id, status, opts = {}) {
    const p = this.store.setStatus(id, status, opts);
    if (!p) throw new Error('peluang tidak ditemukan');
    this.log({ agent: 'sales', kind: 'prospect_status', level: status === 'won' ? 'good' : 'info', title: `Peluang #${id} (${p.title}) -> ${status}${status === 'won' && p.value_idr ? ` (${rupiah(p.value_idr)})` : ''}`, ref: String(id) });
    return p;
  }

  // ------------------------------------------------------------ the owner's daily rhythm

  _doneToday(kind) {
    return Boolean(this.store.db.prepare('SELECT 1 FROM agent_activity WHERE kind = ? AND ref = ?').get(kind, wibDay(this.now())));
  }

  /**
   * 08.00 WIB: today's best local businesses, each with a ready message and a one-tap WhatsApp link.
   * `force` (the owner asked: "peluang lagi") skips the schedule and the once-a-day rule, and `count` sets how many.
   */
  async morningBatch({ force = false, count = null } = {}) {
    if (!this.notify || !this.ownerChat()) return 0;
    if (!force && (wib(this.now()).h < BATCH_HOUR || inQuietHours(this.now()) || this._doneToday('outreach_batch'))) return 0;
    const kind = force ? 'outreach_extra' : 'outreach_batch';
    const limit = Math.min(15, Math.max(1, Number(count) || this.perDay));
    const rows = this.store.db.prepare("SELECT id FROM sales_prospects WHERE kind = 'local' AND verdict = 'good' AND status = 'new' AND mobile = 1 AND pushed_at IS NULL ORDER BY score DESC, first_seen LIMIT ?")
      .all(limit);
    if (!rows.length) { this.log({ agent: 'sales', kind, ref: wibDay(this.now()), title: 'Paket kontak: tidak ada usaha lokal baru yang cocok' }); return 0; }
    const sent = [];
    try {
      await this.notify(this.ownerChat(), `${force ? 'Siap, Mas. Ini' : 'Pagi, Mas. Ada'} ${rows.length} usaha lokal tanpa website yang cocok${force ? ' (tambahan)' : ' untuk dihubungi hari ini'}. Tiap pesan di bawah siap dikirim: ketuk tautannya, WhatsApp terbuka dengan pesan terisi, tinggal tekan kirim. Setelah terkirim, balas "peluang <nomor> dihubungi" supaya saya menindaklanjuti dua hari lagi.`);
      for (const { id } of rows) {
        const d = this.draft(id);
        await this.notify(this.ownerChat(), [`Peluang #${id}: ${d.prospect.title} (${d.prospect.description.split(' · ')[0] || d.prospect.category}), skor ${d.prospect.score}`, '', d.link ? `Buka WhatsApp: ${d.link}` : 'Tidak ada nomor ponsel.', '', 'Pesan:', d.text].join('\n'));
        sent.push(id);
      }
    } catch (e) {
      this.log({ agent: 'sales', kind: 'outreach_fail', level: 'warn', title: 'Paket kontak pagi gagal terkirim sebagian', detail: String(e?.message || e) });
    }
    if (sent.length) this.store.markPushed(sent);
    this.log({ agent: 'sales', kind, level: 'good', ref: wibDay(this.now()), title: `Paket kontak ${force ? 'tambahan ' : 'pagi '}terkirim ke Telegram (${sent.length} usaha lokal)` });
    return sent.length;
  }

  // ------------------------------------------------------------ what the owner asks about

  /** Everything the owner's chat needs to talk about the radar truthfully (also feeds the assistant's prompt). */
  overview() {
    const stats = this.store.stats();
    const q = this.store.db.prepare("SELECT MAX(ts) t FROM agent_activity WHERE agent = 'sales' AND kind = ?");
    const recent = this.store.db.prepare("SELECT id, title, status FROM sales_prospects WHERE pushed_at IS NOT NULL ORDER BY pushed_at DESC, id DESC LIMIT 6").all();
    return {
      stats, areas: this.areas, recent,
      lastFreelancer: this._lastRun('freelancer') || null,
      lastBatch: q.get('outreach_batch')?.t || null,
    };
  }

  /** The answer to "hasil pencarian?" / "sudah dapat berapa klien?". */
  overviewText() {
    const o = this.overview(); const s = o.stats;
    const hhmm = (ts) => new Date(ts).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }).replace(':', '.');
    const lines = [
      'Hasil radar klien (jalan otomatis setiap hari, tanpa Mas minta):',
      `- ${s.total} peluang terdata: ${s.goodLocal} usaha lokal tanpa website yang cocok, ${s.goodMarket} proyek Freelancer yang cocok.`,
      `- Freelancer.com dipindai tiap 6 jam (terakhir ${o.lastFreelancer ? `${hhmm(o.lastFreelancer)} WIB` : 'belum'}); usaha lokal tiap 3 hari (${o.areas.join(', ')}).`,
      `- Paket pagi terakhir: ${o.lastBatch ? `${hhmm(o.lastBatch)} WIB` : 'belum pernah'}. Sudah dihubungi: ${s.byStatus.contacted || 0}, membalas: ${s.byStatus.replied || 0}, menang: ${s.byStatus.won || 0}.`,
      'Saya tidak menghubungi calon klien sendiri; Mas yang mengetuk tautan WhatsApp di paket pagi.',
      'Ketik "peluang" untuk daftarnya, atau "peluang lagi" untuk tambahan usaha sekarang.',
    ];
    return lines.join('\n');
  }

  /**
   * A business the owner mentions by name ("Asmi laundry tadi nanya tarif"): fuzzy on distinctive words only,
   * tolerant of one typo, and only among prospects already sent to or worked by the owner.
   * @returns {object|null} the prospect row, or null when nothing (or more than one thing) matches
   */
  findByName(text) {
    const words = tokens(text);
    if (!words.length) return null;
    const rows = this.store.db.prepare("SELECT * FROM sales_prospects WHERE kind = 'local' AND (pushed_at IS NOT NULL OR status != 'new') ORDER BY COALESCE(pushed_at, status_at) DESC LIMIT 400").all();
    let best = null; let bestScore = 0; let tie = false;
    for (const r of rows) {
      const hit = tokens(r.title).filter((t) => !GENERIC.has(t)).filter((t) => words.some((w) => within1(w, t))).length;
      if (!hit) continue;
      if (hit > bestScore) { best = r; bestScore = hit; tie = false; } else if (hit === bestScore) tie = true;
    }
    return best && !tie ? this.store._shape(best) : null;
  }

  /** 10.00 WIB: contacted prospects who have not answered, with the follow-up text ready. Max two per prospect. */
  async followUps({ force = false } = {}) {
    if (!this.notify || !this.ownerChat()) return 0;
    if (!force && (wib(this.now()).h < FOLLOWUP_HOUR || inQuietHours(this.now()) || this._doneToday('followup_batch'))) return 0;
    const due = this.store.dueFollowUps(6);
    if (!due.length) { this.log({ agent: 'sales', kind: 'followup_batch', ref: wibDay(this.now()), title: 'Tindak lanjut: tidak ada yang jatuh tempo' }); return 0; }
    let n = 0;
    try {
      await this.notify(this.ownerChat(), `Tindak lanjut hari ini: ${due.length} calon klien belum membalas. Pesan singkat di bawah siap dikirim, dan sesudah ini saya tidak mengejar lebih dari dua kali.`);
      for (const p of due) {
        const f = followUpText(p, this.getFacts(), p.followups + 1);
        await this.notify(this.ownerChat(), [`Tindak lanjut #${p.id}: ${p.title} (${p.followups + 1} dari 2)`, '', f.link ? `Buka WhatsApp: ${f.link}` : '', '', f.text].filter((x, i) => x || i === 2).join('\n'));
        this.store.recordFollowUp(p.id); n += 1;
      }
    } catch (e) {
      this.log({ agent: 'sales', kind: 'outreach_fail', level: 'warn', title: 'Tindak lanjut gagal terkirim sebagian', detail: String(e?.message || e) });
    }
    this.log({ agent: 'sales', kind: 'followup_batch', level: 'good', ref: wibDay(this.now()), title: `Tindak lanjut dikirim ke Telegram (${n})` });
    return n;
  }

  reportLines({ since }) {
    const s = this.store.stats();
    const out = [];
    const fresh = this.store.db.prepare("SELECT kind, COUNT(*) c FROM sales_prospects WHERE verdict = 'good' AND first_seen >= ? GROUP BY kind").all(since);
    const by = Object.fromEntries(fresh.map((r) => [r.kind, r.c]));
    const total = (by.local || 0) + (by.marketplace || 0);
    if (total) out.push(`Peluang klien: ${total} baru cocok (usaha lokal ${by.local || 0}, Freelancer ${by.marketplace || 0}). Ketik "peluang" untuk melihatnya`);
    if (s.dueFollowUps) out.push(`Tindak lanjut: ${s.dueFollowUps} calon klien belum membalas`);
    return out;
  }

  // ------------------------------------------------------------ scheduling

  start() {
    if (!this.enabled || this.timers.length) return false;
    const last = this._lastRun('freelancer');
    const due = last ? Math.max(0, last + SCAN_EVERY_MS - this.now()) : 0;
    const first = setTimeout(() => this.scan().catch(() => {}), Math.max(FIRST_SCAN_DELAY_MS, due));
    const scan = setInterval(() => this.scan().catch(() => {}), SCAN_EVERY_MS);
    const tick = setInterval(() => { this.morningBatch().catch(() => {}); this.followUps().catch(() => {}); }, TICK_MS);
    for (const t of [first, scan, tick]) t.unref?.();
    this.timers = [first, scan, tick];
    return true;
  }

  stop() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; }
}

export function createProspects(deps) {
  const store = deps.store || new ProspectStore(deps.db);
  return new ProspectService({ ...deps, store });
}
