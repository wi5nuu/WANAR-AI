/**
 * src/ops/manager.js
 *
 * Operations manager: one place that knows whether every part of the assistant is actually working,
 * instead of each agent keeping its own silence. It
 *   - runs a health check per component (Telegram reader, AI provider, email, career radar, client radar,
 *     sales desk, memory),
 *   - answers "status sistem" with the real result of those checks,
 *   - watches them in the background and tells the owner ONCE when something goes wrong (and once when it
 *     recovers), never in quiet hours, never the same problem twice within the cooldown.
 *
 * A check never throws into the manager: a check that itself crashes counts as a problem of its own.
 *
 * @author Wisnu Alfian Nur Ashar
 */

const HOUR = 3_600_000;
export const LEVELS = { ok: 0, warn: 1, down: 2 };
const ICON = { ok: '✓', warn: '!', down: '✗' };

const ago = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return 'baru saja';
  if (ms < 90_000) return 'baru saja';
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} menit lalu`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)} jam lalu`;
  return `${Math.round(ms / (24 * HOUR))} hari lalu`;
};

/**
 * Builds the standard checks from the live components (any of them may be missing).
 * @returns {Array<{id:string,label:string,run:()=>{level:'ok'|'warn'|'down',detail:string}}>}
 */
export function buildChecks({ automation = null, aiManager = null, emailDesk = null, career = null, sales = null, env = process.env, now = Date.now, memoryLimitMb = 1400 } = {}) {
  const checks = [];

  if (automation?.inbox?.status) {
    checks.push({
      id: 'telegram', label: 'Telegram (membaca pesan Mas)',
      run: () => {
        const st = automation.inbox.status();
        if (!st.wanted) return { level: 'down', detail: 'TELEGRAM_POLLING bukan "true": bot tidak membaca pesan masuk' };
        if (!st.running) return { level: 'down', detail: 'pembaca pesan sedang tidak berjalan' };
        return { level: 'ok', detail: 'membaca pesan masuk' };
      },
    });
  }

  if (aiManager) {
    checks.push({
      id: 'ai', label: 'Model AI',
      run: () => {
        const configured = aiManager.getConfiguredProviders?.() || [];
        if (!configured.length) return { level: 'down', detail: 'tidak ada provider AI yang terkonfigurasi' };
        const main = String(env.DEFAULT_PROVIDER || '').trim().toLowerCase();
        const sk = main ? aiManager.failover?.skipReason?.(main, '*') : null;
        if (sk) return { level: 'warn', detail: `penyedia utama (${main}) ditolak (${sk.why}); memakai cadangan yang lebih lambat` };
        return { level: 'ok', detail: `${main || aiManager.getProvider?.() || 'aktif'}, ${configured.length} provider siap` };
      },
    });
  }

  if (emailDesk || automation?.channels) {
    checks.push({
      id: 'email', label: 'Email',
      run: () => {
        let mode = emailDesk ? (emailDesk.live ? 'live' : 'simulasi') : null;
        try { if (!mode && automation.channels.has('email')) mode = automation.channels.get('email').mode; } catch { /* ignore */ }
        if (mode && mode !== 'live') return { level: 'down', detail: `belum tersambung (mode ${mode}): balasan dan kampanye tidak terkirim` };
        return { level: 'ok', detail: 'terkirim sungguhan' };
      },
    });
  }

  if (career) {
    checks.push({
      id: 'career', label: 'Radar lowongan',
      run: () => {
        if (!career.enabled) return { level: 'warn', detail: 'dimatikan (CAREER_RADAR=off)' };
        const last = career.store.lastGoodScan();
        const limit = (career.intervalMs || 6 * HOUR) * 2;
        if (!last) return { level: 'warn', detail: 'belum ada pemindaian yang berhasil' };
        if (now() - last > limit) return { level: 'down', detail: `pemindaian terakhir ${ago(now() - last)}` };
        return { level: 'ok', detail: `pemindaian terakhir ${ago(now() - last)}` };
      },
    });
  }

  const pr = sales?.prospects;
  if (pr) {
    checks.push({
      id: 'clients', label: 'Radar klien',
      run: () => {
        if (!pr.enabled) return { level: 'warn', detail: 'dimatikan' };
        const last = pr._lastRun?.('freelancer') || 0;
        if (!last) return { level: 'warn', detail: 'belum ada pemindaian Freelancer yang berhasil' };
        if (now() - last > 18 * HOUR) return { level: 'down', detail: `pindaian Freelancer terakhir ${ago(now() - last)} (seharusnya tiap 6 jam)` };
        return { level: 'ok', detail: `pindaian Freelancer terakhir ${ago(now() - last)}` };
      },
    });
  }

  if (sales) {
    checks.push({
      id: 'sales', label: 'Meja penjualan',
      run: () => {
        const st = sales.store.stats();
        const unapproved = sales.catalog().services.filter((s) => !s.price.approved).length;
        if (unapproved) return { level: 'warn', detail: `${unapproved} harga layanan belum disetujui: balasan harga ke klien tertahan` };
        return { level: 'ok', detail: `${st.open} calon klien aktif, ${st.needsOwner} menunggu Mas` };
      },
    });
  }

  checks.push({
    id: 'memory', label: 'Memori server',
    run: () => {
      const mb = Math.round(process.memoryUsage().rss / 1048576);
      return mb > memoryLimitMb ? { level: 'warn', detail: `pemakaian ${mb} MB (batas wajar ${memoryLimitMb} MB)` } : { level: 'ok', detail: `${mb} MB` };
    },
  });

  return checks;
}

export class OpsManager {
  /**
   * @param {{checks: Array, notify?: (text:string)=>Promise<void>, quiet?: (ts:number)=>boolean,
   *          now?: ()=>number, cooldownMs?: number, log?: (e:object)=>void}} o
   */
  constructor({ checks = [], notify = null, quiet = () => false, now = Date.now, cooldownMs = 6 * HOUR, log = () => {} } = {}) {
    this.checks = checks;
    this.notify = notify;
    this.quiet = quiet;
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.log = log;
    this.state = new Map(); // id -> { level, since, alertedAt, alerted }
    this.timer = null;
    this.startedAt = now();
  }

  /** Runs every check; a crashing check becomes a "down" result for itself. */
  run() {
    return this.checks.map((c) => {
      let r;
      try { r = c.run(); } catch (e) { r = { level: 'down', detail: `pemeriksaan gagal: ${String(e?.message || e).slice(0, 100)}` }; }
      const level = LEVELS[r?.level] !== undefined ? r.level : 'warn';
      return { id: c.id, label: c.label, level, detail: String(r?.detail || '') };
    });
  }

  summary() {
    const results = this.run();
    const bad = results.filter((r) => r.level !== 'ok');
    return { ok: bad.length === 0, results, problems: bad };
  }

  text() {
    const { ok, results, problems } = this.summary();
    const up = Math.round((this.now() - this.startedAt) / HOUR);
    const head = ok
      ? `Semua ${results.length} bagian berjalan normal, Mas. Server menyala ${up < 1 ? 'kurang dari satu jam' : `${up} jam`} sejak restart terakhir.`
      : `${problems.length} dari ${results.length} bagian perlu perhatian, Mas:`;
    const lines = results.map((r) => `${ICON[r.level]} ${r.label}: ${r.detail}`);
    return [head, '', ...lines].join('\n');
  }

  /**
   * One watchdog pass. Tells the owner about a NEW problem (or one still unresolved after the cooldown)
   * and about recovery; logs every change. Returns what it announced.
   */
  async tick() {
    const t = this.now();
    const announced = [];
    for (const r of this.run()) {
      const prev = this.state.get(r.id) || { level: 'ok', since: t, alerted: false, alertedAt: 0 };
      const bad = r.level !== 'ok';
      if (r.level !== prev.level) {
        this.log({ agent: 'ops', kind: bad ? 'problem' : 'recovered', level: r.level === 'down' ? 'error' : bad ? 'warn' : 'good', title: `${r.label}: ${bad ? r.detail : 'kembali normal'}` });
        prev.level = r.level; prev.since = t;
      }
      if (bad && !this.quiet(t) && (!prev.alerted || t - prev.alertedAt > this.cooldownMs)) {
        prev.alerted = true; prev.alertedAt = t;
        announced.push({ id: r.id, text: `Peringatan sistem: ${r.label} — ${r.detail}.` });
      } else if (!bad && prev.alerted && !this.quiet(t)) {
        prev.alerted = false;
        announced.push({ id: r.id, text: `Kabar baik: ${r.label} sudah kembali normal.` });
      }
      this.state.set(r.id, prev);
    }
    if (announced.length && this.notify) {
      try { await this.notify(announced.map((a) => a.text).join('\n')); } catch { /* the alert is best-effort */ }
    }
    return announced;
  }

  start(everyMs = 10 * 60_000, firstDelayMs = 5 * 60_000) {
    if (this.timer) return false;
    // A restart makes several components look late for a few minutes: look first after a grace period.
    this.first = setTimeout(() => { this.tick().catch(() => {}); }, firstDelayMs);
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, everyMs);
    this.first.unref?.(); this.timer.unref?.();
    return true;
  }

  stop() { clearTimeout(this.first); clearInterval(this.timer); this.first = null; this.timer = null; }
}

const STATUS = /^\s*(?:tolong\s+)?(?:cek|lihat|tampilkan|kasih\s+tahu|kasih\s+tau)?\s*(?:status|kondisi|kesehatan)\s+(?:sistem|agen|agent|semua|bot|kamu)\b|^\s*(?:apa\s+(?:yang\s+)?(?:rusak|error|bermasalah)|ada\s+(?:yang\s+)?(?:rusak|error|masalah))(?:\s+di\s+(?:sistem|agen|agent|bot))?\s*[?.!]*\s*$|^\s*semua\s+(?:agen|agent|sistem)\s+(?:jalan|normal|aman|sehat)\b/i;

/** Natural-language "status sistem" -> the real check results, answered by code (no model). */
export function quickOps(ops, text) {
  if (!ops) return null;
  const t = String(text || '').trim();
  if (!t || t.length > 120 || !STATUS.test(t)) return null;
  return ops.text();
}
