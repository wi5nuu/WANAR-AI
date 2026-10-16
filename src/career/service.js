/**
 * src/career/service.js
 *
 * The career radar: every few hours it reads the remote-job sources, scores each posting against
 * the owner's real profile, remembers what it has seen, and tells the owner on Telegram ONLY about
 * new postings that are worth acting on. Everything it does is written to the activity feed so the
 * owner can open one screen and see what the agent has been up to.
 *
 * It reads and reports. It does not apply, submit forms or send anything to employers: that is a
 * separate, gated stage (see the apply queue) so a scoring mistake can never cost the owner a
 * wrongly-sent application.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { EventEmitter } from 'node:events';
import { fetchAll, buildSources, enrichGreenhouse } from './sources.js';
import { scoreJob, parseSkills, SCORING_DEFAULTS } from './scoring.js';
import { CareerStore } from './store.js';
import { buildDailyReport, wib, wibDay } from './report.js';
import { skillsFromFacts } from './facts.js';
import { buildKit } from './kit.js';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_INTERVAL_H = 6;
const FIRST_SCAN_DELAY_MS = 2 * 60_000;
const DIGEST_MAX = 8;
const ENRICH_MAX = 60;
const TICK_MS = 5 * 60_000;         // report + watchdog heartbeat
const REPORT_RETRIES = 3;           // a failed report is retried, never repeated after it succeeded

/** Notifications are held back between 22:00 and 06:00 WIB (UTC+7): a job post can wait for morning. */
export function inQuietHours(now = Date.now()) {
  const h = new Date(now + 7 * 3_600_000).getUTCHours();
  return h >= 22 || h < 6;
}

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

export class CareerService extends EventEmitter {
  constructor({ store, getProfile = () => null, getFacts = () => null, notify = null, chatId = () => null, fetchImpl = globalThis.fetch, env = process.env, now = Date.now, sources = null } = {}) {
    super();
    this.store = store;
    this.getProfile = getProfile;
    this.getFacts = getFacts;
    // Telegram goes out ONLY from the instance that is switched on for it (the production server).
    // A laptop running the same code with the same bot token must stay silent, or every message doubles.
    this.notify = String(env.CAREER_TELEGRAM || '').toLowerCase() === 'on' ? notify : null;
    this.reportHour = Math.min(23, Math.max(0, Number(env.CAREER_REPORT_HOUR) || 19));
    this.sections = [];            // other modules add report lines: () => string[]
    this.tickTimer = null;
    this._stallAlerted = false;
    this.chatId = chatId;
    this.fetchImpl = fetchImpl;
    this.env = env;
    this.now = now;
    this.sources = sources;
    this.timer = null;
    this.first = null;
    this.running = false;
    this.intervalMs = Math.max(1, Number(env.CAREER_SCAN_HOURS) || DEFAULT_INTERVAL_H) * 3_600_000;
  }

  get enabled() { return String(this.env.CAREER_RADAR || 'on').toLowerCase() !== 'off'; }

  /** Scoring inputs from the owner's profile (skills, preferred fields) + env limits. */
  profile() {
    const p = this.getProfile() || {};
    // The profile row plus the portfolio's fact sheet (the fuller, owner-maintained list of skills).
    let factSkills = [];
    try { factSkills = skillsFromFacts(this.getFacts()); } catch { /* facts are optional */ }
    const skills = [...new Set([...parseSkills(`${p.skills || ''},${(this.env.CAREER_EXTRA_SKILLS || '')}`), ...factSkills])];
    return {
      skills,
      maxYears: Number(this.env.CAREER_MAX_YEARS) || SCORING_DEFAULTS.maxYears,
      minApply: Number(this.env.CAREER_MIN_APPLY) || SCORING_DEFAULTS.minApply,
      minMaybe: Number(this.env.CAREER_MIN_MAYBE) || SCORING_DEFAULTS.minMaybe,
      now: this.now(),
    };
  }

  status() {
    return { enabled: this.enabled, running: this.running, intervalHours: this.intervalMs / 3_600_000, ...this.store.stats() };
  }

  /**
   * One full sweep. Safe to call by hand; a second call while one is running returns that run's promise.
   * @returns {Promise<{fetched:number, fresh:number, apply:number, maybe:number, report:Array, announced:number}>}
   */
  scan({ only = null, announce = true } = {}) {
    if (this._scanning) return this._scanning;
    this._scanning = this._scan({ only, announce }).finally(() => { this._scanning = null; });
    return this._scanning;
  }

  async _scan({ only, announce }) {
    this.running = true;
    const t0 = this.now();
    this.store.log({ agent: 'career', kind: 'scan_start', title: 'Mulai memindai lowongan remote', detail: only ? `sumber: ${only.join(', ')}` : 'semua sumber' });
    try {
      const profile = this.profile();
      const { jobs, report } = await fetchAll({ fetchImpl: this.fetchImpl, env: this.env, only, sources: this.sources });

      let fresh = 0; let apply = 0; let maybe = 0; let enriched = 0;
      for (let job of jobs) {
        let result = scoreJob(job, profile);
        // Greenhouse lists carry no description. Without it a posting can never score well, so waiting for a
        // decent score before reading it would mean never reading it. Read it for every software role that is
        // not already ruled out by region; remember what was read so the next scan does not fetch it again.
        if (job.source.startsWith('greenhouse:') && !job.description) {
          const known = this.store.descriptionOf(job.source, job.extId);
          if (known) {
            job = { ...job, description: known };
            result = scoreJob(job, profile);
          } else if (enriched < ENRICH_MAX && result.eligibility !== 'no' && result.reasons.some((r) => r.startsWith('peran:'))) {
            enriched += 1;
            job = await enrichGreenhouse(this.fetchImpl, job);
            result = scoreJob(job, profile);
          }
        }
        const up = this.store.upsertJob(job, result);
        if (up.inserted) {
          fresh += 1;
          if (result.verdict === 'apply') apply += 1;
          else if (result.verdict === 'maybe') maybe += 1;
        }
      }

      for (const r of report) {
        if (!r.ok) this.store.log({ agent: 'career', kind: 'source_error', level: 'warn', title: `Sumber ${r.label} gagal`, detail: r.error, ref: r.source });
      }
      const failed = report.filter((r) => !r.ok).length;
      const summary = { fetched: jobs.length, fresh, apply, maybe, report, announced: 0, ms: this.now() - t0 };
      this.store.log({
        agent: 'career', kind: 'scan', level: failed && failed === report.length ? 'error' : 'info',
        title: `Pemindaian selesai: ${jobs.length} lowongan dibaca, ${fresh} baru, ${apply} layak dilamar`,
        detail: report.map((r) => `${r.label}: ${r.ok ? r.count : `GAGAL (${r.error})`}`).join('\n'),
      });
      // One Telegram message per scan is noise: the owner gets ONE daily report instead (see dailyReport).
      // The old per-scan digest stays available for anyone who wants it: CAREER_INSTANT_DIGEST=on.
      const instant = String(this.env.CAREER_INSTANT_DIGEST || '').toLowerCase() === 'on';
      if (announce && instant) summary.announced = await this.announce();
      this.emit('scan', summary);
      return summary;
    } catch (e) {
      this.store.log({ agent: 'career', kind: 'scan', level: 'error', title: 'Pemindaian gagal', detail: String(e?.message || e) });
      throw e;
    } finally {
      this.running = false;
    }
  }

  /** Telegram digest of unannounced "apply" postings. Returns how many were listed. */
  async announce() {
    const chat = this.chatId();
    if (!this.notify || !chat) return 0;
    if (inQuietHours(this.now())) {
      this.store.log({ agent: 'career', kind: 'digest_held', title: 'Laporan ditahan sampai pagi (jam tenang 22.00-06.00 WIB)' });
      return 0;
    }
    const batch = this.store.unannounced({ verdict: 'apply', limit: 50 });
    if (!batch.length) return 0;
    const top = batch.slice(0, DIGEST_MAX);
    const lines = [`Radar lowongan: ${batch.length} lowongan remote baru yang cocok dengan profil Mas`, ''];
    top.forEach((j, i) => {
      lines.push(`${i + 1}. [${j.score}] ${clip(j.title, 80)} - ${clip(j.company || 'perusahaan tidak disebut', 40)}`);
      const meta = [j.location, j.salary_text].filter(Boolean).join(' | ');
      if (meta) lines.push(`   ${clip(meta, 90)}`);
      if (j.reasons?.length) lines.push(`   ${clip(j.reasons.slice(0, 3).join('; '), 120)}`);
      if (j.warnings?.length) lines.push(`   Catatan: ${clip(j.warnings.slice(0, 2).join('; '), 100)}`);
      lines.push(`   ${j.url}`);
    });
    if (batch.length > top.length) lines.push('', `...dan ${batch.length - top.length} lainnya di halaman Pusat Agen.`);
    try {
      await this.notify(chat, lines.join('\n'));
    } catch (e) {
      this.store.log({ agent: 'career', kind: 'digest', level: 'warn', title: 'Laporan Telegram gagal terkirim', detail: String(e?.message || e) });
      return 0;
    }
    this.store.markNotified(batch.map((j) => j.id));
    this.store.log({ agent: 'career', kind: 'digest', level: 'good', title: `Laporan lowongan terkirim ke Telegram (${top.length} teratas dari ${batch.length})`,
      detail: top.map((j) => `${j.score} - ${j.title} @ ${j.company}`).join('\n') });
    return top.length;
  }

  // ---------------------------------------------------------- application kit

  /** Where the owner's CV (PDF) lives; the file is optional. */
  cvPath() {
    return this.env.OWNER_CV_FILE || path.join(process.cwd(), 'data', 'owner-cv.pdf');
  }

  /**
   * Cover letter + standard answers + CV for one stored posting. The e-mail shown is the mailbox the
   * agent watches (employers' replies must reach it), falling back to the portfolio's address.
   */
  kit(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) return { ok: false, error: 'Lowongan tidak ditemukan.' };
    const cv = this.cvPath();
    return buildKit(job, this.getFacts(), {
      now: this.now(), email: this.env.APPLY_EMAIL || this.env.IMAP_USER || null,
      resumeFile: fs.existsSync(cv) ? path.basename(cv) : null,
    });
  }

  // ---------------------------------------------------------- daily report

  /**
   * Lets any module add a line to the daily report by logging activity: "Pasar: 2 alarm harga tercapai".
   * A line appears only when the count is above zero, so a quiet day stays short.
   */
  addCountSection(label, what, agent, kind) {
    this.sections.push(({ since }) => {
      const c = this.store.db.prepare('SELECT COUNT(*) c FROM agent_activity WHERE agent = ? AND kind = ? AND ts >= ?').get(agent, kind, since).c;
      return c > 0 ? [`${label}: ${c} ${what}`] : [];
    });
  }

  /** The report text as of now (read-only; also what "laporan agent" answers with). */
  reportText() {
    return buildDailyReport(this.store, { now: this.now(), sections: this.sections, intervalMs: this.intervalMs });
  }

  /**
   * Sends the daily report once per WIB day, from the first heartbeat at/after the report hour.
   * The "already sent today" fact lives in the activity table, so a restart can never send it twice;
   * a failed send is retried a few times, a successful one never repeated.
   * @returns {Promise<'sent'|'not_yet'|'already'|'off'|'failed'>}
   */
  async dailyReport({ force = false } = {}) {
    const now = this.now();
    if (!this.notify || !this.chatId()) return 'off';
    const today = wibDay(now);
    if (!force) {
      if (wib(now).h < this.reportHour) return 'not_yet';
      const sent = this.store.db.prepare("SELECT 1 FROM agent_activity WHERE kind = 'daily_report' AND ref = ?").get(today);
      if (sent) return 'already';
      const failed = this.store.db.prepare("SELECT COUNT(*) c FROM agent_activity WHERE kind = 'daily_report_fail' AND ref = ?").get(today).c;
      if (failed >= REPORT_RETRIES) return 'failed';
    }
    const { text, facts } = this.reportText();
    try {
      await this.notify(this.chatId(), text);
    } catch (e) {
      this.store.log({ agent: 'career', kind: 'daily_report_fail', level: 'warn', title: 'Laporan harian gagal terkirim, akan dicoba lagi', detail: String(e?.message || e), ref: today });
      return 'failed';
    }
    this.store.log({ agent: 'career', kind: 'daily_report', level: 'good', title: `Laporan harian terkirim ke Telegram (${facts.applied} lamaran, ${facts.newApply} lowongan layak)`, detail: text, ref: today });
    return 'sent';
  }

  // ---------------------------------------------------------- 24-hour watchdog

  /**
   * Heartbeat (every few minutes): the report is due? the radar still scanning? If the radar has gone
   * quiet for two intervals it is restarted, the incident is logged, and the owner is told ONCE.
   */
  async tick() {
    const now = this.now();
    const last = this.store.lastGoodScan();
    const upFor = now - (this.startedAt || now);
    const stalled = this.enabled && !this._scanning && (last ? now - last > this.intervalMs * 2 : upFor > 20 * 60_000);
    if (stalled && !this._stallAlerted) {
      this._stallAlerted = true;
      const since = last ? `sejak pukul ${String(wib(last).h).padStart(2, '0')}.${String(wib(last).min).padStart(2, '0')} WIB` : 'sejak dinyalakan';
      this.store.log({ agent: 'career', kind: 'stalled', level: 'error', title: `Radar berhenti memindai ${since}; menyalakan ulang pemindaian` });
      if (this.notify && this.chatId()) {
        this.notify(this.chatId(), `Peringatan: radar lowongan berhenti memindai ${since}. Saya sudah mencoba menyalakannya lagi dan akan mengabari jika masih bermasalah.`).catch(() => {});
      }
      this.scan({ announce: false }).catch(() => {});
    } else if (!stalled && this._stallAlerted && last && now - last <= this.intervalMs * 2) {
      this._stallAlerted = false;
      this.store.log({ agent: 'career', kind: 'recovered', level: 'good', title: 'Radar kembali memindai seperti biasa' });
    }
    return this.dailyReport();
  }

  start() {
    if (!this.enabled || this.timer) return false;
    this.startedAt = this.now();
    const last = this.store.lastGoodScan();
    const due = last ? Math.max(0, last + this.intervalMs - this.now()) : 0;
    // Never hammer the free APIs after a restart/deploy: honour the previous scan time.
    this.first = setTimeout(() => this.scan().catch(() => {}), Math.max(FIRST_SCAN_DELAY_MS, due));
    this.first.unref?.();
    this.timer = setInterval(() => this.scan().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
    this.tickTimer = setInterval(() => this.tick().catch(() => {}), TICK_MS);
    this.tickTimer.unref?.();
    this.store.log({ agent: 'career', kind: 'start', title: `Radar lowongan aktif (tiap ${this.intervalMs / 3_600_000} jam)` });
    return true;
  }

  stop() {
    clearTimeout(this.first); clearInterval(this.timer); clearInterval(this.tickTimer);
    this.first = null; this.timer = null; this.tickTimer = null;
  }
}

export function createCareer(deps) {
  const store = deps.store || new CareerStore(deps.db);
  return new CareerService({ ...deps, store });
}

export { buildSources };
