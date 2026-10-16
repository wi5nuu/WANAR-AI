/**
 * src/market/service.js
 *
 * The owner's market desk: a watchlist with live quotes (cached ~15 s), price alerts
 * that message Telegram when they trigger, a neutral AI digest, and the scenario
 * calculator. It INFORMS; it never trades, never moves money and never tells the
 * owner to buy or sell.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fetchQuotes, resolveSymbol, DEFAULT_WATCHLIST } from './sources.js';
import { scenarios } from './scenario.js';

const QUOTE_TTL_MS = 15_000;
const HISTORY_POINTS = 90;
export const DISCLAIMER = 'Informasi pasar, bukan nasihat investasi. Data bursa bisa tertunda dan tidak ada jaminan untung.';

const OPS = {
  gte: { label: 'naik ke / di atas', test: (q, v) => q.price >= v },
  lte: { label: 'turun ke / di bawah', test: (q, v) => q.price <= v },
  pct_up: { label: 'naik hari ini ≥', test: (q, v) => Number.isFinite(q.changePct) && q.changePct >= v, unit: '%' },
  pct_down: { label: 'turun hari ini ≥', test: (q, v) => Number.isFinite(q.changePct) && q.changePct <= -v, unit: '%' },
};

export const fmtPrice = (q) => {
  const n = Number(q.price);
  if (q.kind === 'index') return `${n.toLocaleString('id-ID', { maximumFractionDigits: 2 })} poin`;
  const digits = q.currency && !String(q.currency).startsWith('IDR') ? (n < 10 ? 4 : 2) : 0;
  const s = n.toLocaleString('id-ID', { maximumFractionDigits: digits });
  return String(q.currency || '').startsWith('IDR') ? `Rp${s}${q.currency === 'IDR/gram' ? '/gram' : ''}` : `${s} ${q.currency || ''}`.trim();
};
export const fmtPct = (p) => (Number.isFinite(p) ? `${p >= 0 ? '+' : ''}${p.toFixed(2)}%` : '—');

export class MarketService extends EventEmitter {
  constructor({ db, aiManager = null, notify = null, chatId = () => null, now = Date.now, fetchImpl = globalThis.fetch, env = process.env } = {}) {
    super();
    this.db = db;
    this.ai = aiManager;
    this.notify = notify;
    this.chatId = chatId;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.env = env;
    this.cache = { at: 0, key: '', data: null };
    this.history = new Map(); // symbol -> [{t, p}]
    this.timer = null;
    this.ticking = false;
    db.exec(`
      CREATE TABLE IF NOT EXISTS mk_watch (symbol TEXT PRIMARY KEY, added_at INTEGER NOT NULL, pos INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS mk_alerts (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, op TEXT NOT NULL, value REAL NOT NULL, note TEXT,
        status TEXT NOT NULL DEFAULT 'armed', created_at INTEGER NOT NULL, fired_at INTEGER, fired_price REAL
      );
      CREATE INDEX IF NOT EXISTS idx_mk_alert_status ON mk_alerts(status);
    `);
    if (!db.prepare('SELECT COUNT(*) c FROM mk_watch').get().c) {
      const ins = db.prepare('INSERT INTO mk_watch (symbol, added_at, pos) VALUES (?, ?, ?)');
      DEFAULT_WATCHLIST.forEach((s, i) => ins.run(s, this.now(), i));
    }
  }

  // ---------------------------------------------------------------- watchlist

  watchlist() {
    return this.db.prepare('SELECT symbol FROM mk_watch ORDER BY pos ASC, added_at ASC').all().map((r) => r.symbol);
  }

  addWatch(input) {
    const r = resolveSymbol(input);
    if (!r) throw new Error('Kode tidak dikenali. Contoh: BBCA, IHSG, BTC, EMAS, NASDAQ:AAPL');
    if (this.watchlist().length >= 30) throw new Error('Watchlist maksimal 30 kode');
    const pos = (this.db.prepare('SELECT COALESCE(MAX(pos), -1) m FROM mk_watch').get().m) + 1;
    this.db.prepare('INSERT OR IGNORE INTO mk_watch (symbol, added_at, pos) VALUES (?, ?, ?)').run(r.symbol, this.now(), pos);
    this.cache.at = 0;
    this.emit('change', { kind: 'watch' });
    return r.symbol;
  }

  removeWatch(input) {
    const r = resolveSymbol(input);
    const sym = r?.symbol || String(input || '').toUpperCase();
    const n = this.db.prepare('DELETE FROM mk_watch WHERE symbol = ?').run(sym).changes;
    if (n) { this.cache.at = 0; this.emit('change', { kind: 'watch' }); }
    return n > 0;
  }

  // ------------------------------------------------------------------- quotes

  async quotes({ force = false, symbols = null } = {}) {
    const list = symbols ? symbols.map((s) => resolveSymbol(s)?.symbol).filter(Boolean) : this.watchlist();
    const key = list.join(',');
    const t = this.now();
    if (!force && this.cache.data && this.cache.key === key && t - this.cache.at < QUOTE_TTL_MS) return { ...this.cache.data, cached: true };
    try {
      const data = await fetchQuotes(list, { fetchImpl: this.fetchImpl, now: this.now });
      // Every source failed (offline / blocked): keep serving the last good numbers, flagged stale.
      if (!data.quotes.length && this.cache.data && this.cache.key === key) {
        return { ...this.cache.data, stale: true, errors: [...(data.errors || [])] };
      }
      for (const q of data.quotes) {
        const h = this.history.get(q.symbol) || [];
        if (!h.length || t - h[h.length - 1].t >= 10_000) h.push({ t, p: q.price });
        if (h.length > HISTORY_POINTS) h.shift();
        this.history.set(q.symbol, h);
        q.spark = h.map((x) => x.p);
      }
      // keep the owner's order
      const order = new Map(list.map((s, i) => [s, i]));
      data.quotes.sort((a, b) => (order.get(a.symbol) ?? 99) - (order.get(b.symbol) ?? 99));
      const out = { ...data, at: t, disclaimer: DISCLAIMER };
      this.cache = { at: t, key, data: out };
      return out;
    } catch (e) {
      if (this.cache.data && this.cache.key === key) return { ...this.cache.data, stale: true, errors: [...(this.cache.data.errors || []), e.message] };
      throw e;
    }
  }

  async quote(input) {
    const r = resolveSymbol(input);
    if (!r) throw new Error('Kode tidak dikenali');
    const d = await this.quotes({ symbols: [r.symbol] });
    const q = d.quotes.find((x) => x.symbol === r.symbol);
    if (!q) throw new Error(`Data ${r.symbol} tidak tersedia sekarang (${(d.errors || []).join('; ') || 'kode tidak ditemukan'})`);
    return q;
  }

  // ------------------------------------------------------------------- alerts

  alerts() {
    return this.db.prepare('SELECT * FROM mk_alerts ORDER BY (status = \'armed\') DESC, created_at DESC LIMIT 60').all()
      .map((a) => ({ ...a, opLabel: OPS[a.op]?.label || a.op, unit: OPS[a.op]?.unit || '' }));
  }

  addAlert({ symbol, op, value, note = null }) {
    const r = resolveSymbol(symbol);
    if (!r) throw new Error('Kode tidak dikenali');
    if (!OPS[op]) throw new Error('Jenis alarm: gte | lte | pct_up | pct_down');
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) throw new Error('Nilai alarm harus angka positif');
    if (this.db.prepare("SELECT COUNT(*) c FROM mk_alerts WHERE status = 'armed'").get().c >= 40) throw new Error('Terlalu banyak alarm aktif (maks 40)');
    const id = `mka_${crypto.randomBytes(5).toString('hex')}`;
    this.db.prepare('INSERT INTO mk_alerts (id, symbol, op, value, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, r.symbol, op, v, note, this.now());
    this.emit('change', { kind: 'alert' });
    return this.alerts().find((a) => a.id === id);
  }

  removeAlert(id) {
    const n = this.db.prepare('DELETE FROM mk_alerts WHERE id = ?').run(id).changes;
    if (n) this.emit('change', { kind: 'alert' });
    return n > 0;
  }

  /** Evaluates armed alerts against fresh quotes; each fires once and messages Telegram. */
  async tick() {
    if (this.ticking) return [];
    this.ticking = true;
    const fired = [];
    try {
      const armed = this.db.prepare("SELECT * FROM mk_alerts WHERE status = 'armed'").all();
      if (!armed.length) return [];
      const symbols = [...new Set(armed.map((a) => a.symbol))];
      const { quotes } = await this.quotes({ force: true, symbols });
      const by = new Map(quotes.map((q) => [q.symbol, q]));
      for (const a of armed) {
        const q = by.get(a.symbol);
        if (!q || !OPS[a.op].test(q, a.value)) continue;
        // mark first: an alert can never fire twice
        if (!this.db.prepare("UPDATE mk_alerts SET status = 'fired', fired_at = ?, fired_price = ? WHERE id = ? AND status = 'armed'").run(this.now(), q.price, a.id).changes) continue;
        const text = `🔔 Alarm harga — ${q.label}\n${OPS[a.op].label} ${a.op.startsWith('pct') ? `${a.value}%` : a.value.toLocaleString('id-ID')}\nSekarang: ${fmtPrice(q)} (${fmtPct(q.changePct)} hari ini)${q.delayed ? '\n(data bursa bisa tertunda ±10–15 menit)' : ''}${a.note ? `\nCatatan: ${a.note}` : ''}\n\n${DISCLAIMER}`;
        fired.push({ alert: a, quote: q, text });
        try {
          const cid = this.chatId();
          if (this.notify && cid) await this.notify(cid, text);
        } catch (e) { console.warn('[MARKET] gagal kirim alarm:', e.message); }
        this.emit('change', { kind: 'fired', id: a.id });
      }
    } catch (e) {
      console.warn('[MARKET] tick gagal:', e.message);
    } finally {
      this.ticking = false;
    }
    return fired;
  }

  start() {
    if (this.timer) return false;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, Math.max(20_000, parseInt(this.env.MARKET_ALERT_SECONDS || '60', 10) * 1000 || 60_000));
    this.timer.unref?.();
    return true;
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // ------------------------------------------------------------------- digest

  /** Plain, code-written summary: always available, no AI needed. */
  factsText(quotes) {
    const rows = quotes.filter((q) => Number.isFinite(q.changePct));
    const up = [...rows].sort((a, b) => b.changePct - a.changePct).slice(0, 2);
    const down = [...rows].sort((a, b) => a.changePct - b.changePct).slice(0, 2);
    const line = (q) => `${q.label} ${fmtPrice(q)} (${fmtPct(q.changePct)})`;
    const ihsg = quotes.find((q) => q.symbol === 'IHSG');
    const out = [];
    if (ihsg) out.push(`IHSG ${ihsg.price.toLocaleString('id-ID', { maximumFractionDigits: 2 })} (${fmtPct(ihsg.changePct)}).`);
    for (const k of ['USDIDR', 'EMAS', 'BTC', 'ETH']) { const q = quotes.find((x) => x.symbol === k); if (q) out.push(line(q) + '.'); }
    if (up.length) out.push(`Naik terbesar: ${up.map(line).join('; ')}.`);
    if (down.length) out.push(`Turun terbesar: ${down.map(line).join('; ')}.`);
    return out.join('\n');
  }

  async digest({ useAi = true } = {}) {
    const data = await this.quotes({ force: true });
    const facts = this.factsText(data.quotes);
    let text = facts;
    let ai = false;
    if (useAi && this.ai) {
      try {
        const { collect } = await import('../automation/ai-compose.js');
        const system = [
          'Kamu menulis ringkasan pasar yang NETRAL dalam Bahasa Indonesia sehari-hari, 3–5 kalimat, hanya dari DATA yang diberikan.',
          'DILARANG: rekomendasi beli/jual/tahan, target harga, prediksi, janji untung, atau menyuruh berinvestasi.',
          'Boleh: menyebut apa yang naik/turun, kondisi IHSG, kurs, emas, kripto, dan hal yang perlu dicermati secara umum (volatilitas, data tertunda).',
          'Jangan mengarang angka yang tidak ada di data. Akhiri dengan satu kalimat pendek: ini informasi, bukan nasihat investasi.',
          'FORMAT: satu paragraf teks biasa. TANPA tabel, TANPA markdown (**, #, |), TANPA daftar, TANPA pertanyaan atau tawaran di akhir, TANPA komentar tentang dirimu atau tentang data.',
        ].join('\n');
        const r = await collect(this.ai, [{ role: 'user', content: `DATA (${new Date(data.at).toISOString()}):\n${facts}` }], { systemPrompt: system, temperature: 0.3, maxTokens: 500, traceChannel: 'automation', traceTitle: 'Ringkasan pasar' });
        const t = String(r.text || '').trim();
        // Anything that is not a short plain paragraph is rejected: the facts are the safe answer.
        const wellFormed = t.length > 30 && t.length < 900 && !/[|*#]/.test(t) && !/\?\s*$/.test(t)
          && !/\b(mau saya|apakah (?:anda|mas)|ingin saya|silakan pilih)\b/i.test(t)
          && !/\b(beli|jual|tahan|akumulasi|target harga|rekomendasi)\b/i.test(t);
        if (wellFormed) { text = t; ai = true; }
      } catch { /* the facts alone are fine */ }
    }
    return { text, facts, ai, quotes: data.quotes, at: data.at, disclaimer: DISCLAIMER, errors: data.errors || [] };
  }

  // ----------------------------------------------------------------- scenario

  scenario(params) {
    return scenarios(params);
  }
}

export function createMarket(deps) {
  return new MarketService(deps);
}
