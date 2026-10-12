/**
 * src/automation/scheduler.js
 *
 * In-process job scheduler: wakes every few seconds, runs whatever is due, and
 * records every execution.
 *
 * Job types
 *   email     send a fixed template to a recipient list
 *   ai_email  have the AI write an email from a brief, then send (or queue for review)
 *   ai_task   run an AI prompt/code task; optionally deliver the result by email
 *
 * Safety model
 *   - A job proposed by the agent starts as `pending_approval` and is inert.
 *     Only an explicit human action (`approveJob`) arms it.
 *   - AI-written mail defaults to `autoSend: false`: it lands as a DRAFT for
 *     review. The operator must opt in to unattended sending per job.
 *   - A job that fails N times in a row is paused instead of retrying forever.
 *   - A job never overlaps itself, and missed runs older than the catch-up
 *     window are skipped (logged) rather than fired in a burst.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { EventEmitter } from 'node:events';
import { JobStatus } from './store.js';
import {
  parseSchedule, nextRun, previewSchedule, describe, ScheduleError, DEFAULT_TIMEZONE,
} from './cron.js';
import { generateEmail, generateText, generateCode } from './ai-compose.js';
import { parseRecipients } from './recipients.js';

export const JOB_TYPES = Object.freeze(['email', 'ai_email', 'ai_task']);

export class JobError extends Error {
  constructor(message, code = 'bad_request') {
    super(message);
    this.name = 'JobError';
    this.code = code;
  }
}

const withTimeout = (promise, ms, label) => {
  let timer;
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} melebihi batas waktu ${Math.round(ms / 1000)} detik`)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
};

/** Validates + normalises a job payload. Throws JobError with a clear message. */
export function validatePayload(type, payload, { maxRecipients = 1000 } = {}) {
  const p = payload && typeof payload === 'object' ? { ...payload } : {};
  const needRecipients = () => {
    const parsed = parseRecipients(p.recipients, { max: maxRecipients + 1 });
    if (!parsed.recipients.length) throw new JobError('Daftar penerima kosong atau tidak valid');
    if (parsed.recipients.length > maxRecipients) {
      throw new JobError(`Maksimal ${maxRecipients} penerima per eksekusi`);
    }
    // Store the cleaned list so the job never re-parses hostile input.
    p.recipients = parsed.recipients.map((r) => ({ email: r.email, name: r.name, ...r.vars }));
  };
  const str = (k, max = 5000) => (p[k] == null ? '' : String(p[k]).slice(0, max));
  const attachmentIds = Array.isArray(p.attachmentIds)
    ? [...new Set(p.attachmentIds.map(String))].slice(0, 20)
    : [];

  switch (type) {
    case 'email':
      if (!str('subject').trim()) throw new JobError('Subjek wajib diisi');
      if (!str('bodyText', 20000).trim() && !str('bodyHtml', 40000).trim()) throw new JobError('Isi email wajib diisi');
      needRecipients();
      return {
        recipients: p.recipients, subject: str('subject', 300), bodyText: str('bodyText', 20000),
        bodyHtml: str('bodyHtml', 40000) || undefined, fromName: str('fromName', 120) || undefined,
        replyTo: str('replyTo', 254) || undefined, attachmentIds,
      };

    case 'ai_email':
      if (!str('brief').trim()) throw new JobError('Brief email wajib diisi');
      needRecipients();
      return {
        brief: str('brief', 4000), recipients: p.recipients, tone: str('tone', 100) || undefined,
        language: str('language', 60) || undefined, audience: str('audience', 200) || undefined,
        signature: str('signature', 500) || undefined, personalize: p.personalize !== false,
        autoSend: p.autoSend === true, fromName: str('fromName', 120) || undefined,
        replyTo: str('replyTo', 254) || undefined,
        provider: str('provider', 40) || undefined, model: str('model', 100) || undefined,
        attachmentIds,
      };

    case 'ai_task': {
      if (!str('prompt').trim()) throw new JobError('Prompt wajib diisi');
      const kind = p.kind === 'code' ? 'code' : 'text';
      let emailTo;
      if (p.recipients) {
        needRecipients();
        emailTo = p.recipients;
      }
      return {
        prompt: str('prompt', 6000), kind, language: str('language', 40) || undefined,
        recipients: emailTo, subject: str('subject', 300) || undefined,
        autoSend: p.autoSend === true,
        provider: str('provider', 40) || undefined, model: str('model', 100) || undefined,
        attachmentIds,
      };
    }

    default:
      throw new JobError(`Tipe job tidak dikenal: ${type}. Pilih salah satu: ${JOB_TYPES.join(', ')}`);
  }
}

export class AutomationScheduler extends EventEmitter {
  constructor({
    store, engine, aiManager,
    tickMs = 15_000,
    catchUpWindowMs = 6 * 3_600_000,
    maxConsecutiveFailures = 5,
    runTimeoutMs = 10 * 60_000,
  }) {
    super();
    this.store = store;
    this.engine = engine;
    this.aiManager = aiManager;
    this.tickMs = tickMs;
    this.catchUpWindowMs = catchUpWindowMs;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.runTimeoutMs = runTimeoutMs;
    this.running = new Map(); // jobId -> Promise
    this._timer = null;
    this._ticking = false;
  }

  // ------------------------------------------------------------ lifecycle

  start() {
    if (this._timer) return;
    const repaired = this.store.runs.failInterrupted();
    const recovery = this.engine.init();
    if (repaired || recovery.interruptedRows) {
      console.log(`[AUTOMATION] pemulihan: ${repaired} run & ${recovery.interruptedRows} email terputus ditandai gagal`);
    }
    this._timer = setInterval(() => { this.tick().catch((e) => console.error('[AUTOMATION] tick', e)); }, this.tickMs);
    this._timer.unref?.();
    setTimeout(() => this.tick().catch(() => {}), 2000).unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** Resolves when every in-flight job has finished (used by tests / shutdown). */
  async idle() {
    while (this.running.size) await Promise.allSettled([...this.running.values()]);
  }

  // ----------------------------------------------------------------- CRUD

  /**
   * @param {object} input
   * @param {{activate?: boolean, actor?: string}} [opts]
   *   `activate` must only be true on a human-facing surface.
   */
  createJob(input, { activate = false, actor = 'user' } = {}) {
    const name = String(input.name || '').trim().slice(0, 120);
    if (!name) throw new JobError('Nama job wajib diisi');
    const timezone = input.timezone || DEFAULT_TIMEZONE;

    let schedule;
    try {
      previewSchedule(input.schedule, timezone, 1);
      schedule = parseSchedule(input.schedule);
    } catch (e) {
      throw new JobError(e instanceof ScheduleError ? e.message : `Jadwal tidak valid: ${e.message}`);
    }

    const payload = validatePayload(input.type, input.payload, { maxRecipients: this.engine.cfg.maxRecipients });
    this._assertAttachments(payload);

    const status = activate ? JobStatus.ACTIVE : JobStatus.PENDING_APPROVAL;
    const job = this.store.jobs.create({
      name, type: input.type, schedule: String(input.schedule).trim(), timezone, payload,
      status, createdBy: actor,
      nextRunAt: nextRun(schedule, Date.now(), timezone),
      maxRuns: Number.isInteger(input.maxRuns) && input.maxRuns > 0 ? input.maxRuns : null,
      endsAt: input.endsAt ? Number(input.endsAt) : null,
    });
    if (activate) {
      this.store.jobs.update(job.id, { approved_by: actor, approved_at: Date.now() });
    }
    this._emit('job_created', job.id);
    return this.store.jobs.get(job.id);
  }

  updateJob(id, patch) {
    const job = this._must(id);
    const fields = {};
    if (patch.name !== undefined) fields.name = String(patch.name).trim().slice(0, 120) || job.name;
    const tz = patch.timezone || job.timezone;
    if (patch.timezone !== undefined) fields.timezone = tz;

    if (patch.schedule !== undefined || patch.timezone !== undefined) {
      const expr = patch.schedule ?? job.schedule;
      try {
        previewSchedule(expr, tz, 1);
        fields.schedule = String(expr).trim();
        fields.next_run_at = nextRun(parseSchedule(expr), Date.now(), tz);
      } catch (e) {
        throw new JobError(e.message);
      }
    }
    if (patch.payload !== undefined) {
      fields.payload = validatePayload(job.type, patch.payload, { maxRecipients: this.engine.cfg.maxRecipients });
      this._assertAttachments(fields.payload);
    }
    if (patch.maxRuns !== undefined) fields.max_runs = patch.maxRuns || null;
    const out = this.store.jobs.update(id, fields);
    this._emit('job_updated', id);
    return out;
  }

  /** Human approval: arms a pending job. The next run is computed from NOW. */
  approveJob(id, approvedBy = 'operator') {
    const job = this._must(id);
    if (job.status !== JobStatus.PENDING_APPROVAL && job.status !== JobStatus.PAUSED) {
      throw new JobError(`Job berstatus "${job.status}" tidak perlu persetujuan`, 'bad_state');
    }
    const next = nextRun(parseSchedule(job.schedule), Date.now(), job.timezone);
    const out = this.store.jobs.update(id, {
      status: JobStatus.ACTIVE, status_reason: null, approved_by: approvedBy, approved_at: Date.now(),
      next_run_at: next, fail_streak: 0,
    });
    this._emit('job_updated', id);
    return out;
  }

  pauseJob(id, reason = 'dijeda manual') {
    this._must(id);
    const out = this.store.jobs.update(id, { status: JobStatus.PAUSED, status_reason: reason });
    this._emit('job_updated', id);
    return out;
  }

  deleteJob(id) {
    this._must(id);
    const ok = this.store.jobs.remove(id);
    this._emit('job_deleted', id);
    return ok;
  }

  _assertAttachments(payload) {
    if (payload.attachmentIds?.length && this.engine.attachments) {
      try {
        payload.attachmentIds = this.engine.attachments.assertAvailable(payload.attachmentIds);
      } catch (e) {
        throw new JobError(e.message);
      }
    }
  }

  _must(id) {
    const job = this.store.jobs.get(id);
    if (!job) throw new JobError('Job tidak ditemukan', 'not_found');
    return job;
  }

  // ---------------------------------------------------------------- ticks

  async tick(atMs = Date.now()) {
    if (this._ticking) return { started: [], skipped: [] };
    this._ticking = true;
    const started = [];
    const skipped = [];
    try {
      for (const job of this.store.jobs.due(atMs)) {
        if (this.running.has(job.id)) continue; // never overlap

        const schedule = parseSchedule(job.schedule);
        const late = atMs - job.next_run_at;
        const nxt = nextRun(schedule, atMs, job.timezone);

        // Lifecycle limits
        const spent = job.max_runs && job.run_count >= job.max_runs;
        const expired = job.ends_at && atMs > job.ends_at;
        if (spent || expired || nxt == null) {
          this.store.jobs.update(job.id, {
            status: JobStatus.COMPLETED, status_reason: spent ? 'batas run tercapai' : 'selesai', next_run_at: null,
          });
          this._emit('job_updated', job.id);
          continue;
        }

        // Advance BEFORE running so a crash can never cause a re-fire storm.
        this.store.jobs.update(job.id, { next_run_at: nxt });

        if (late > this.catchUpWindowMs) {
          const runId = this.store.runs.start(job.id, 'schedule');
          this.store.runs.finish(runId, {
            status: 'skipped',
            error: `Terlewat ${Math.round(late / 60000)} menit (di luar jendela catch-up) — dilewati`,
          });
          skipped.push(job.id);
          continue;
        }

        started.push(job.id);
        this._launch(job, 'schedule');
      }
      this.engine.resumeDue(atMs);
    } finally {
      this._ticking = false;
    }
    return { started, skipped };
  }

  /** Manual "run now". Allowed for active and paused jobs, never for unapproved ones. */
  runNow(id, { actor = 'operator' } = {}) {
    const job = this._must(id);
    if (job.status === JobStatus.PENDING_APPROVAL) {
      throw new JobError('Job belum disetujui — setujui dulu sebelum dijalankan', 'not_approved');
    }
    if (this.running.has(id)) throw new JobError('Job sedang berjalan', 'busy');
    this._launch({ ...job, approved_by: job.approved_by || actor }, 'manual');
    return { started: true };
  }

  _launch(job, trigger) {
    const p = this._runJob(job, trigger).finally(() => this.running.delete(job.id));
    this.running.set(job.id, p);
    return p;
  }

  async _runJob(job, trigger) {
    const runId = this.store.runs.start(job.id, trigger);
    this._emit('run_started', job.id, { runId });
    let result;
    let failed = null;
    try {
      result = await withTimeout(this._execute(job), this.runTimeoutMs, 'Job');
    } catch (err) {
      failed = err;
    }

    this.store.runs.finish(runId, failed
      ? { status: 'failed', error: failed.message }
      : { status: 'success', output: result.output, meta: result.meta });

    const fresh = this.store.jobs.get(job.id);
    if (!fresh) return;
    const streak = failed ? fresh.fail_streak + 1 : 0;
    const patch = {
      last_run_at: Date.now(),
      last_status: failed ? 'failed' : 'success',
      run_count: fresh.run_count + 1,
      fail_streak: streak,
    };
    if (failed && streak >= this.maxConsecutiveFailures && fresh.status === JobStatus.ACTIVE) {
      patch.status = JobStatus.PAUSED;
      patch.status_reason = `Dijeda otomatis: gagal ${streak}x berturut-turut (${failed.message.slice(0, 80)})`;
    }
    if (fresh.max_runs && patch.run_count >= fresh.max_runs && fresh.status === JobStatus.ACTIVE) {
      patch.status = JobStatus.COMPLETED;
      patch.status_reason = 'batas run tercapai';
      patch.next_run_at = null;
    }
    this.store.jobs.update(job.id, patch);
    this._emit('run_finished', job.id, {
      runId, status: failed ? 'failed' : 'success', error: failed?.message,
    });
  }

  // ------------------------------------------------------------ executors

  async _execute(job) {
    const p = job.payload || {};
    const stamp = new Date().toLocaleDateString('id-ID', { timeZone: job.timezone });
    const approvedBy = job.approved_by || 'scheduler';

    if (job.type === 'email') {
      const { campaign, report } = this.engine.quickSend({
        approvedBy, createdBy: 'scheduler', sourceJobId: job.id,
        name: `${job.name} — ${stamp}`,
        subject: p.subject, bodyText: p.bodyText, bodyHtml: p.bodyHtml,
        recipients: p.recipients, fromName: p.fromName, replyTo: p.replyTo,
        attachmentIds: p.attachmentIds,
      });
      return {
        output: `Kampanye ${campaign.id} dimulai untuk ${report.valid} penerima (${campaign.mode}).`,
        meta: { campaignId: campaign.id, recipients: report.valid, mode: campaign.mode },
      };
    }

    if (job.type === 'ai_email') {
      const draft = await generateEmail(this.aiManager, {
        brief: p.brief, tone: p.tone, language: p.language, audience: p.audience,
        signature: p.signature, personalize: p.personalize, provider: p.provider, model: p.model,
      });
      const input = {
        createdBy: 'scheduler', sourceJobId: job.id, name: `${job.name} — ${stamp}`,
        subject: draft.subject, bodyText: draft.body, recipients: p.recipients,
        fromName: p.fromName, replyTo: p.replyTo, attachmentIds: p.attachmentIds,
      };
      if (p.autoSend) {
        const { campaign, report } = this.engine.quickSend({ ...input, approvedBy });
        return {
          output: `Subjek: ${draft.subject}\n\n${draft.body}\n\n→ Terkirim otomatis ke ${report.valid} penerima (kampanye ${campaign.id}).`,
          meta: { campaignId: campaign.id, autoSend: true, model: draft.model },
        };
      }
      const { campaign, report } = this.engine.create(input);
      this.emit('review_needed', { jobId: job.id, campaignId: campaign.id });
      return {
        output: `Subjek: ${draft.subject}\n\n${draft.body}\n\n→ Draf ${campaign.id} menunggu review Anda (${report.valid} penerima).`,
        meta: { campaignId: campaign.id, autoSend: false, awaitingReview: true, model: draft.model },
      };
    }

    if (job.type === 'ai_task') {
      const out = p.kind === 'code'
        ? await generateCode(this.aiManager, { brief: p.prompt, language: p.language, provider: p.provider, model: p.model })
        : await generateText(this.aiManager, { prompt: p.prompt, provider: p.provider, model: p.model });
      const meta = { model: out.model, kind: p.kind };

      if (p.recipients?.length) {
        const input = {
          createdBy: 'scheduler', sourceJobId: job.id, name: `${job.name} — ${stamp}`,
          subject: p.subject || `${job.name} — ${stamp}`, bodyText: out.text, recipients: p.recipients,
          attachmentIds: p.attachmentIds,
        };
        if (p.autoSend) {
          const { campaign } = this.engine.quickSend({ ...input, approvedBy });
          meta.campaignId = campaign.id;
        } else {
          const { campaign } = this.engine.create(input);
          meta.campaignId = campaign.id;
          meta.awaitingReview = true;
          this.emit('review_needed', { jobId: job.id, campaignId: campaign.id });
        }
      }
      return { output: out.text, meta };
    }

    throw new JobError(`Tipe job tidak didukung: ${job.type}`);
  }

  _emit(type, jobId, extra = {}) {
    this.emit('job', { type, jobId, ...extra });
  }

  /** Decorates a job row with human-readable schedule info for the UI. */
  present(job) {
    if (!job) return null;
    let description = job.schedule;
    try {
      description = describe(parseSchedule(job.schedule));
    } catch { /* keep raw */ }
    return { ...job, scheduleDescription: description, running: this.running.has(job.id) };
  }
}
