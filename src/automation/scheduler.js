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
import { generateEmail, generateMessage, generateText, generateCode } from './ai-compose.js';
import { parseRecipients, extractSubscribersToken } from './recipients.js';
import { CHANNEL_KINDS, FIXED_DESTINATION, isChannelId, CHANNEL_IDS } from './channels/meta.js';

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

/**
 * Resolves the delivery targets of a payload. Supports the legacy single-channel
 * shape ({channel?, recipients}) and the multi-channel shape ({targets: [...]}).
 */
export function targetsOf(p) {
  if (Array.isArray(p.targets) && p.targets.length) return p.targets;
  if (p.recipients || p.channel) return [{ channel: p.channel || 'email', recipients: p.recipients, useSubscribers: p.useSubscribers }];
  return [];
}

/** Validates + normalises a job payload. Throws JobError with a clear message. */
export function validatePayload(type, payload, { maxRecipients = 1000, maxFor } = {}) {
  const p = payload && typeof payload === 'object' ? { ...payload } : {};
  const limitFor = (channel) => (typeof maxFor === 'function' ? maxFor(channel) : maxRecipients);

  const cleanTargets = ({ required }) => {
    const raw = targetsOf(p);
    if (!raw.length) {
      if (required) throw new JobError('Pilih minimal satu kanal tujuan beserta penerimanya');
      return [];
    }
    if (raw.length > CHANNEL_IDS.length) throw new JobError('Terlalu banyak target');

    const seen = new Set();
    return raw.map((t) => {
      const channel = String(t?.channel || 'email');
      if (!isChannelId(channel)) throw new JobError(`Kanal tidak dikenal: ${channel}. Pilih: ${CHANNEL_IDS.join(', ')}`);
      if (seen.has(channel)) throw new JobError(`Kanal ${channel} dipilih lebih dari sekali`);
      seen.add(channel);

      // Webhook-style channels have one fixed destination configured in .env.
      if (FIXED_DESTINATION.has(channel)) return { channel, recipients: [{ email: 'default' }] };

      let input = t.recipients;
      let useSubscribers = t.useSubscribers === true;
      if (channel === 'telegram') {
        const x = extractSubscribersToken(input);
        useSubscribers = useSubscribers || x.useSubscribers;
        input = x.input;
      }
      const empty = !String(Array.isArray(input) ? input.join('') : input ?? '').trim();
      if (empty && !useSubscribers) throw new JobError(`Penerima untuk ${channel} kosong`);

      let recipients = [];
      if (!empty) {
        const max = limitFor(channel);
        const parsed = parseRecipients(input, { kind: CHANNEL_KINDS[channel], max: max + 1 });
        if (!parsed.recipients.length) throw new JobError(`Daftar penerima ${channel} kosong atau tidak valid`);
        if (parsed.recipients.length > max) throw new JobError(`Maksimal ${max} penerima ${channel} per eksekusi`);
        // Store the cleaned list so the job never re-parses hostile input.
        recipients = parsed.recipients.map((r) => ({ email: r.email, name: r.name, ...r.vars }));
      }
      return { channel, recipients, ...(useSubscribers ? { useSubscribers: true } : {}) };
    });
  };

  const str = (k, max = 5000) => (p[k] == null ? '' : String(p[k]).slice(0, max));
  const attachmentIds = Array.isArray(p.attachmentIds)
    ? [...new Set(p.attachmentIds.map(String))].slice(0, 20)
    : [];

  switch (type) {
    case 'email': {
      const targets = cleanTargets({ required: true });
      const hasEmail = targets.some((t) => t.channel === 'email');
      if (hasEmail && !str('subject').trim()) throw new JobError('Subjek wajib diisi untuk email');
      if (!str('bodyText', 20000).trim() && !(hasEmail && str('bodyHtml', 40000).trim())) {
        throw new JobError('Isi pesan wajib diisi');
      }
      return {
        targets, subject: str('subject', 300), bodyText: str('bodyText', 20000),
        bodyHtml: str('bodyHtml', 40000) || undefined, fromName: str('fromName', 120) || undefined,
        replyTo: str('replyTo', 254) || undefined, attachmentIds,
      };
    }

    case 'ai_email': {
      if (!str('brief').trim()) throw new JobError('Brief pesan wajib diisi');
      const targets = cleanTargets({ required: true });
      return {
        brief: str('brief', 4000), targets, tone: str('tone', 100) || undefined,
        language: str('language', 60) || undefined, audience: str('audience', 200) || undefined,
        signature: str('signature', 500) || undefined, personalize: p.personalize !== false,
        autoSend: p.autoSend === true, fromName: str('fromName', 120) || undefined,
        replyTo: str('replyTo', 254) || undefined,
        provider: str('provider', 40) || undefined, model: str('model', 100) || undefined,
        attachmentIds,
      };
    }

    case 'ai_task': {
      if (!str('prompt').trim()) throw new JobError('Prompt wajib diisi');
      const kind = p.kind === 'code' ? 'code' : 'text';
      const targets = cleanTargets({ required: false });
      return {
        prompt: str('prompt', 6000), kind, language: str('language', 40) || undefined,
        targets, subject: str('subject', 300) || undefined,
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

    const payload = validatePayload(input.type, input.payload, this._validationOptions());
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
      fields.payload = validatePayload(job.type, patch.payload, this._validationOptions());
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

  _validationOptions() {
    const channels = this.engine.channels;
    return {
      maxRecipients: this.engine.cfg.maxRecipients,
      maxFor: (id) => (channels?.has(id) ? channels.get(id).limits.maxRecipients : this.engine.cfg.maxRecipients),
    };
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
    const targets = targetsOf(p);
    const multi = targets.length > 1;
    const channels = this.engine.channels;

    /** Create (and, when allowed, start) one campaign per channel target. */
    const deliver = ({ subjectFor, bodyFor, htmlFor, autoSend, awaiting }) => {
      const results = [];
      const errors = [];
      for (const t of targets) {
        try {
          const caps = channels.get(t.channel).capabilities;
          const input = {
            createdBy: 'scheduler', sourceJobId: job.id,
            name: `${job.name} — ${stamp}${multi ? ` [${t.channel}]` : ''}`,
            channel: t.channel, recipients: t.recipients, useSubscribers: t.useSubscribers,
            subject: subjectFor(t.channel), bodyText: bodyFor(t.channel),
            bodyHtml: htmlFor ? htmlFor(t.channel) : undefined,
            fromName: p.fromName, replyTo: p.replyTo,
            attachmentIds: caps.attachments ? p.attachmentIds : [],
          };
          if (autoSend) {
            const { campaign, report } = this.engine.quickSend({ ...input, approvedBy });
            results.push({ channel: t.channel, campaignId: campaign.id, recipients: report.valid, mode: campaign.mode, started: true });
          } else {
            const { campaign, report } = this.engine.create(input);
            results.push({ channel: t.channel, campaignId: campaign.id, recipients: report.valid, started: false });
            if (awaiting) this.emit('review_needed', { jobId: job.id, campaignId: campaign.id });
          }
        } catch (e) {
          errors.push({ channel: t.channel, error: e.message });
        }
      }
      if (!results.length && errors.length) {
        throw new Error(errors.map((e) => `${e.channel}: ${e.error}`).join('; '));
      }
      return { results, errors };
    };

    const summary = ({ results, errors }, verb) => {
      const lines = results.map(
        (r) => `• ${channels.get(r.channel).label}: ${r.recipients} penerima — ${verb(r)} (${r.campaignId}${r.mode ? `, ${r.mode}` : ''})`
      );
      for (const e of errors) lines.push(`• ${channels.get(e.channel).label}: GAGAL — ${e.error}`);
      return lines.join('\n');
    };

    if (job.type === 'email') {
      const out = deliver({
        subjectFor: () => p.subject, bodyFor: () => p.bodyText,
        htmlFor: (ch) => (ch === 'email' ? p.bodyHtml : undefined),
        autoSend: true,
      });
      return {
        output: `Pesan dikirim ke ${out.results.length} kanal.\n${summary(out, () => 'dimulai')}`,
        meta: { channels: out.results, errors: out.errors, partial: out.errors.length > 0 },
      };
    }

    if (job.type === 'ai_email') {
      // Email wants subject + formal body; chat apps want a short plain message.
      const wantsEmail = targets.some((t) => t.channel === 'email');
      const wantsChat = targets.some((t) => t.channel !== 'email');
      const base = {
        brief: p.brief, tone: p.tone, language: p.language, audience: p.audience,
        signature: p.signature, personalize: p.personalize, provider: p.provider, model: p.model,
      };
      const emailDraft = wantsEmail ? await generateEmail(this.aiManager, base) : null;
      const chatDraft = wantsChat
        ? await generateMessage(this.aiManager, { ...base, channel: targets.find((t) => t.channel !== 'email').channel })
        : null;
      const pick = (ch) => (ch === 'email' ? emailDraft : chatDraft);

      const out = deliver({
        subjectFor: (ch) => (ch === 'email' ? emailDraft.subject : chatDraft.subject || ''),
        bodyFor: (ch) => pick(ch).body,
        autoSend: p.autoSend === true,
        awaiting: true,
      });
      const shown = [emailDraft && `[Email] ${emailDraft.subject}\n${emailDraft.body}`, chatDraft && `[Chat]\n${chatDraft.body}`]
        .filter(Boolean).join('\n\n');
      return {
        output: `${shown}\n\n${summary(out, (r) => (r.started ? 'terkirim otomatis' : 'draf menunggu review'))}`,
        meta: {
          channels: out.results, errors: out.errors, partial: out.errors.length > 0,
          autoSend: p.autoSend === true, awaitingReview: p.autoSend !== true,
          model: (emailDraft || chatDraft).model,
        },
      };
    }

    if (job.type === 'ai_task') {
      const out = p.kind === 'code'
        ? await generateCode(this.aiManager, { brief: p.prompt, language: p.language, provider: p.provider, model: p.model })
        : await generateText(this.aiManager, { prompt: p.prompt, provider: p.provider, model: p.model });
      const meta = { model: out.model, kind: p.kind };

      if (targets.length) {
        const sent = deliver({
          subjectFor: () => p.subject || `${job.name} — ${stamp}`,
          bodyFor: () => out.text,
          autoSend: p.autoSend === true,
          awaiting: true,
        });
        meta.channels = sent.results;
        meta.errors = sent.errors;
        meta.awaitingReview = p.autoSend !== true;
        return { output: `${out.text}\n\n${summary(sent, (r) => (r.started ? 'terkirim otomatis' : 'draf menunggu review'))}`, meta };
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
