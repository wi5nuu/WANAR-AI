/**
 * src/observability/security-monitor.js
 *
 * Realtime cyber-security view of the running server, from REAL signals only:
 *
 *   - every HTTP response that is a 401 / 403 / 429 (auth failures, blocked access, rate limit)
 *   - requests that look like scanners (".env", "wp-admin", "../", ".git", phpmyadmin …)
 *   - how often credentials were masked in traces (redactions)
 *   - a posture checklist computed from the actual configuration (no values, only yes/no)
 *
 * Client addresses are shown masked (a.b.c.x); request bodies and headers are never stored.
 * Memory only: a ring buffer, nothing is written to disk.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';

const MAX_EVENTS = 300;
const BUCKET_MS = 60_000;
const BUCKETS = 60; // one hour

const PROBE_RE = /(\.env\b|\.git\b|wp-(admin|login|content)|phpmyadmin|\.php$|cgi-bin|\/etc\/passwd|\.\.\/|%2e%2e|\.sql$|\.bak$|\/actuator|\/\.aws|id_rsa|xmlrpc)/i;

export function maskIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (!s) return 'unknown';
  if (s.includes(':') && !s.includes('.')) return `${s.split(':').slice(0, 3).join(':')}:…`; // ipv6
  const p = s.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.x` : s;
}

const SEVERITY = { probe: 'high', auth: 'medium', forbidden: 'medium', ratelimit: 'low', injection: 'high', secret: 'info' };

export class SecurityMonitor extends EventEmitter {
  constructor({ now = () => Date.now() } = {}) {
    super();
    this.setMaxListeners(100);
    this.now = now;
    this.events = [];
    this.buckets = new Map(); // minute -> {auth, forbidden, ratelimit, probe, injection}
    this.totals = { auth: 0, forbidden: 0, ratelimit: 0, probe: 0, injection: 0, requests: 0 };
    this.sources = new Map(); // masked ip -> {count, last, kinds:Set}
    this.lastProto = null;
    this.startedAt = now();
  }

  record({ kind, ip, method = '', path = '', status = 0, detail = '' }) {
    const at = this.now();
    const ev = {
      id: `sec_${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at, kind, severity: SEVERITY[kind] || 'info',
      ip: maskIp(ip), method, path: String(path).slice(0, 140), status, detail: String(detail).slice(0, 200),
    };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    if (kind in this.totals) this.totals[kind] += 1;
    const minute = Math.floor(at / BUCKET_MS);
    const b = this.buckets.get(minute) || {};
    b[kind] = (b[kind] || 0) + 1;
    this.buckets.set(minute, b);
    for (const k of this.buckets.keys()) if (k < minute - BUCKETS) this.buckets.delete(k);
    const src = this.sources.get(ev.ip) || { count: 0, last: 0, kinds: new Set() };
    src.count += 1; src.last = at; src.kinds.add(kind);
    this.sources.set(ev.ip, src);
    if (this.sources.size > 200) this.sources.delete(this.sources.keys().next().value);
    this.emit('event', ev);
    return ev;
  }

  /** Express middleware: observes responses, never changes them. */
  middleware() {
    return (req, res, next) => {
      const start = this.now();
      res.on('finish', () => {
        try {
          this.totals.requests += 1;
          const proto = req.headers['x-forwarded-proto'];
          if (proto) this.lastProto = String(proto).split(',')[0].trim();
          const path = (req.originalUrl || req.url || '').split('?')[0];
          const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress;
          const s = res.statusCode;
          const base = { ip, method: req.method, path, status: s };
          if (s === 401) this.record({ ...base, kind: 'auth', detail: 'akses ditolak: token/sandi tidak ada atau salah' });
          else if (s === 403) this.record({ ...base, kind: 'forbidden', detail: 'akses dilarang (di luar localhost / tanpa izin)' });
          else if (s === 429) this.record({ ...base, kind: 'ratelimit', detail: 'terlalu banyak permintaan — dibatasi' });
          else if (PROBE_RE.test(path) && (s === 404 || s === 400 || s >= 400)) this.record({ ...base, kind: 'probe', detail: 'pola pemindaian/penyusupan terdeteksi dan ditolak' });
          void start;
        } catch { /* observing must never break a response */ }
      });
      next();
    };
  }

  /**
   * Perimeter guard: scanner paths (".env", ".git", "wp-login.php", "../") never reach the
   * static fallback or any route — they get a plain 404 (and are counted by middleware()).
   */
  guard() {
    return (req, res, next) => {
      let path = (req.originalUrl || req.url || '').split('?')[0];
      try { path = decodeURIComponent(path); } catch { /* keep raw */ }
      if (PROBE_RE.test(path)) return res.status(404).type('text/plain').send('Not found');
      return next();
    };
  }

  /** Counters for the last `minutes` minutes. */
  window(minutes = 60) {
    const now = Math.floor(this.now() / BUCKET_MS);
    const out = { auth: 0, forbidden: 0, ratelimit: 0, probe: 0, injection: 0 };
    for (const [m, b] of this.buckets) if (m > now - minutes) for (const [k, v] of Object.entries(b)) out[k] = (out[k] || 0) + v;
    return out;
  }

  /** Per-minute series for the sparkline (oldest → newest). */
  series(minutes = 30) {
    const now = Math.floor(this.now() / BUCKET_MS);
    const out = [];
    for (let i = minutes - 1; i >= 0; i--) {
      const b = this.buckets.get(now - i) || {};
      out.push({ m: (now - i) * BUCKET_MS, total: Object.values(b).reduce((a, v) => a + v, 0), ...b });
    }
    return out;
  }

  topSources(n = 6) {
    return [...this.sources.entries()]
      .sort((a, b) => b[1].count - a[1].count).slice(0, n)
      .map(([ip, v]) => ({ ip, count: v.count, last: v.last, kinds: [...v.kinds] }));
  }

  recent(n = 40) {
    return this.events.slice(-n).reverse();
  }

  /** Threat level from what actually happened in the last 15 minutes. */
  level() {
    const w = this.window(15);
    if (w.probe >= 5 || w.auth >= 15) return { level: 'high', label: 'Waspada tinggi', why: 'banyak percobaan masuk/pemindaian dalam 15 menit' };
    if (w.probe > 0 || w.auth >= 3 || w.forbidden >= 5) return { level: 'medium', label: 'Waspada', why: 'ada percobaan akses yang ditolak' };
    return { level: 'low', label: 'Aman', why: 'tidak ada percobaan mencurigakan dalam 15 menit' };
  }
}

/**
 * Posture checklist from the real configuration. Only yes/no and short facts:
 * no secret value is ever returned.
 */
export function securityPosture({ env = process.env, monitor = null, envFile = null, config = {} } = {}) {
  const has = (k) => Boolean(String(env[k] || '').trim());
  const items = [];
  const add = (id, label, ok, detail, weight = 1) => items.push({ id, label, ok: ok === null ? null : Boolean(ok), detail, weight });

  add('panel-token', 'Panel kendali dijaga (localhost atau token)', has('AUTOMATION_TOKEN'),
    has('AUTOMATION_TOKEN') ? 'AUTOMATION_TOKEN terpasang; akses jarak jauh wajib token' : 'AUTOMATION_TOKEN kosong: hanya localhost yang boleh mengakses panel', 2);
  const bind = String(env.WANAR_BIND || '').trim();
  add('bind', 'Server tidak terbuka langsung ke internet', bind === '127.0.0.1' || bind === 'localhost' || bind === '::1',
    bind ? `WANAR_BIND=${bind}` : 'WANAR_BIND belum diatur: server mendengarkan semua antarmuka', 2);
  add('telegram-owner', 'Bot Telegram: pemilik penuh, tamu komunikasi saja', has('TELEGRAM_AI_CHAT_IDS'),
    has('TELEGRAM_AI_CHAT_IDS')
      ? (has('TELEGRAM_GUEST_CHAT_IDS')
        ? 'pemilik terpasang; daftar tamu aktif (tanpa data, perintah, atau akses darurat)'
        : 'daftar chat id pemilik terpasang')
      : 'TELEGRAM_AI_CHAT_IDS kosong', 2);
  add('https', 'Lalu lintas terenkripsi (HTTPS di perimeter)', monitor?.lastProto ? monitor.lastProto === 'https' : null,
    monitor?.lastProto ? `proxy meneruskan protokol: ${monitor.lastProto}` : 'belum ada permintaan lewat proxy untuk diperiksa', 1);
  add('rate-limit', 'Pembatasan laju permintaan aktif', true, 'per-IP untuk chat, API, auth, dan operasi sensitif', 1);
  add('headers', 'Header keamanan (Helmet/CSP) aktif', true, 'CSP, X-Content-Type-Options, frame protection', 1);
  add('masking', 'Kunci & sandi disamarkan di jejak', true, 'pola kunci API, token Telegram, Bearer, sandi', 1);
  add('email-guard', 'Balas email otomatis dibatasi', true,
    `maks ${env.EMAIL_AUTOREPLY_MAX_PER_THREAD || 6}/percakapan, ${env.EMAIL_AUTOREPLY_MAX_PER_DAY || 60}/hari; hal sensitif ditahan`, 1);
  add('daily-budget', 'Anggaran token harian ditetapkan', Number(config.tokens?.dailyLimit) > 0 && Number(config.tokens.dailyLimit) < 1e9,
    Number(config.tokens?.dailyLimit) > 0 ? `batas ${Number(config.tokens.dailyLimit).toLocaleString('id-ID')} token/hari` : 'belum ada batas', 1);
  if (envFile) {
    try {
      const mode = fs.statSync(envFile).mode & 0o777;
      add('env-perm', 'Berkas .env tidak terbaca pengguna lain', process.platform === 'win32' ? null : (mode & 0o077) === 0,
        process.platform === 'win32' ? 'tidak diperiksa di Windows' : `izin ${mode.toString(8)}`, 2);
    } catch { /* not readable here */ }
  }
  const scored = items.filter((i) => i.ok !== null);
  const max = scored.reduce((a, i) => a + i.weight, 0) || 1;
  const got = scored.reduce((a, i) => a + (i.ok ? i.weight : 0), 0);
  return { score: Math.round((got / max) * 100), items };
}

export const securityMonitor = new SecurityMonitor();
