/**
 * src/automation/campaigns.js
 *
 * Bulk / scheduled email engine.
 *
 * Lifecycle:  draft -> running -> (paused <-> running) -> completed | cancelled
 *
 * Guarantees
 *  - Durable queue: every recipient is a row in `email_outbox`; progress
 *    survives restarts.
 *  - At-most-once delivery: a row caught mid-send by a crash is marked failed
 *    for manual review, never blindly re-sent (no duplicate mail to clients).
 *  - One recipient per (campaign, address): the UNIQUE index prevents repeats.
 *  - Suppression list is always honoured, hard bounces are added automatically.
 *  - Throttled and capped per day; auth / quota errors PAUSE the campaign
 *    rather than burning through every recipient as "failed".
 *  - Nothing sends until `start()` — i.e. an explicit human approval.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { EventEmitter } from 'node:events';
import { CampaignStatus, OutboxStatus } from './store.js';
import { parseRecipients } from './recipients.js';
import { render, builtinVars, textToHtml, extractVars } from './templates.js';
import { ErrorKind, MailError } from './mailer.js';
import { zonedParts, zonedToUtc, DEFAULT_TIMEZONE } from './cron.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CampaignError extends Error {
  constructor(message, code = 'bad_request') {
    super(message);
    this.name = 'CampaignError';
    this.code = code;
  }
}

/** Epoch ms of local midnight (in the automation timezone) for `atMs`. */
export function startOfLocalDay(atMs = Date.now(), tz = DEFAULT_TIMEZONE) {
  const p = zonedParts(atMs, tz);
  return zonedToUtc(p.year, p.month, p.day, 0, 0, tz);
}

export class CampaignEngine extends EventEmitter {
  /**
   * @param {{store: object, mailer: object, backoffBaseMs?: number}} deps
   */
  constructor({ store, mailer, attachments = null, backoffBaseMs = 4000 }) {
    super();
    this.store = store;
    this.mailer = mailer;
    this.attachments = attachments;
    this.backoffBaseMs = backoffBaseMs;
    this.workers = new Map(); // campaignId -> Promise
  }

  get cfg() {
    return this.mailer.cfg;
  }

  // ------------------------------------------------------------- recovery

  /** Call once at boot: repairs half-finished work and resumes approved runs. */
  init() {
    const interruptedRows = this.store.outbox.failInterrupted();
    const resumed = [];
    for (const c of this.store.campaigns.byStatus(CampaignStatus.RUNNING)) {
      resumed.push(c.id);
      this._kick(c.id);
    }
    return { interruptedRows, resumed };
  }

  // --------------------------------------------------------------- create

  /**
   * Creates a DRAFT campaign. Nothing is sent.
   * @returns {{campaign: object, report: object}}
   */
  create({
    name, subject, bodyText, bodyHtml, recipients, fromName, replyTo,
    throttleMs, sourceJobId, createdBy, attachmentIds,
  }) {
    const subj = String(subject || '').replace(/[\r\n]+/g, ' ').trim();
    const text = String(bodyText || '').trim();
    if (!subj) throw new CampaignError('Subjek wajib diisi');
    if (!text && !String(bodyHtml || '').trim()) throw new CampaignError('Isi email wajib diisi');

    // Fail fast (and before anything is persisted) if an attachment is unusable.
    const attachmentList = this.attachments
      ? this.attachments.assertAvailable(attachmentIds)
      : [];

    const max = this.cfg.maxRecipients;
    const parsed = parseRecipients(recipients, { max: max + 1 });
    if (parsed.recipients.length === 0) {
      throw new CampaignError(
        parsed.invalid.length
          ? `Tidak ada alamat email valid (${parsed.invalid.length} baris ditolak)`
          : 'Daftar penerima kosong'
      );
    }
    if (parsed.recipients.length > max) {
      throw new CampaignError(`Maksimal ${max} penerima per kampanye (EMAIL_MAX_RECIPIENTS)`, 'too_many');
    }

    const suppressed = this.store.suppressions.filter(parsed.recipients.map((r) => r.email));
    const used = [...new Set([...extractVars(subj), ...extractVars(text), ...extractVars(bodyHtml || '')])];

    const campaign = this.store.campaigns.create({
      name: String(name || '').trim() || `Kampanye ${new Date().toLocaleDateString('id-ID')}`,
      subject: subj,
      bodyText: text,
      bodyHtml: bodyHtml || null,
      fromName,
      replyTo,
      throttleMs: throttleMs ?? this.cfg.throttleMs,
      sourceJobId,
      createdBy,
      attachmentIds: attachmentList,
    });

    this.store.outbox.addMany(
      campaign.id,
      parsed.recipients.map((r) => ({
        email: r.email,
        name: r.name,
        vars: r.vars,
        status: suppressed.has(r.email) ? OutboxStatus.SKIPPED : OutboxStatus.QUEUED,
        reason: suppressed.has(r.email) ? 'Ada di daftar suppress (opt-out/bounce)' : null,
      }))
    );

    // Which recipients would render with a missing variable?
    const missingFor = [];
    for (const r of parsed.recipients) {
      const vars = this._varsFor(r);
      const miss = new Set([
        ...render(subj, vars).missing,
        ...render(text, vars).missing,
      ]);
      if (miss.size) missingFor.push({ email: r.email, missing: [...miss] });
    }

    const report = {
      totalLines: parsed.total,
      valid: parsed.recipients.length,
      invalid: parsed.invalid,
      duplicates: parsed.duplicates,
      suppressed: [...suppressed],
      variables: used,
      recipientsWithMissing: missingFor.slice(0, 50),
      recipientsWithMissingCount: missingFor.length,
    };
    return { campaign: this.store.campaigns.get(campaign.id), report };
  }

  _varsFor(row) {
    return {
      ...builtinVars(),
      ...(row.vars || {}),
      nama: row.name || row.vars?.nama || '',
      name: row.name || row.vars?.name || '',
      email: row.email,
    };
  }

  _renderFor(campaign, row) {
    const vars = this._varsFor(row);
    const subject = render(campaign.subject, vars);
    const text = render(campaign.body_text, vars);
    const html = campaign.body_html
      ? render(campaign.body_html, vars, { html: true })
      : { text: textToHtml(text.text), missing: [] };
    const missing = [...new Set([...subject.missing, ...text.missing, ...html.missing])];
    return { subject: subject.text, text: text.text, html: html.text, missing };
  }

  /** Renders the first `n` queued recipients exactly as they would be sent. */
  preview(campaignId, n = 3) {
    const c = this.store.campaigns.get(campaignId);
    if (!c) throw new CampaignError('Kampanye tidak ditemukan', 'not_found');
    return this.store.outbox
      .all(campaignId)
      .filter((r) => r.status === OutboxStatus.QUEUED)
      .slice(0, Math.min(Math.max(n, 1), 10))
      .map((r) => ({ to: r.email, name: r.name, ...this._renderFor(c, r) }));
  }

  // ------------------------------------------------------------ lifecycle

  /** Explicit human approval + launch. This is the ONLY way mail starts moving. */
  start(campaignId, { approvedBy = 'operator' } = {}) {
    const c = this.store.campaigns.get(campaignId);
    if (!c) throw new CampaignError('Kampanye tidak ditemukan', 'not_found');
    if (![CampaignStatus.DRAFT, CampaignStatus.PAUSED].includes(c.status)) {
      throw new CampaignError(`Kampanye berstatus "${c.status}" tidak bisa dimulai`, 'bad_state');
    }
    if (c.stats.queued === 0) throw new CampaignError('Tidak ada penerima yang antre untuk dikirim', 'empty');

    const fresh = c.status === CampaignStatus.DRAFT;
    this.store.campaigns.update(campaignId, {
      status: CampaignStatus.RUNNING,
      status_reason: null,
      mode: fresh ? this.mailer.mode : (c.mode || this.mailer.mode),
      approved_by: fresh ? approvedBy : c.approved_by || approvedBy,
      approved_at: fresh ? Date.now() : c.approved_at || Date.now(),
      started_at: c.started_at || Date.now(),
      paused_at: null,
    });
    this._emit(campaignId, 'status');
    this._kick(campaignId);
    return this.store.campaigns.get(campaignId);
  }

  pause(campaignId, reason = 'manual') {
    const c = this.store.campaigns.get(campaignId);
    if (!c) throw new CampaignError('Kampanye tidak ditemukan', 'not_found');
    if (c.status !== CampaignStatus.RUNNING) return c;
    this.store.campaigns.update(campaignId, {
      status: CampaignStatus.PAUSED, status_reason: reason, paused_at: Date.now(),
    });
    this._emit(campaignId, 'status');
    return this.store.campaigns.get(campaignId);
  }

  resume(campaignId, opts) {
    return this.start(campaignId, opts);
  }

  cancel(campaignId) {
    const c = this.store.campaigns.get(campaignId);
    if (!c) throw new CampaignError('Kampanye tidak ditemukan', 'not_found');
    if ([CampaignStatus.COMPLETED, CampaignStatus.CANCELLED].includes(c.status)) return c;
    this.store.campaigns.update(campaignId, {
      status: CampaignStatus.CANCELLED, status_reason: 'dibatalkan', finished_at: Date.now(),
    });
    this._emit(campaignId, 'status');
    return this.store.campaigns.get(campaignId);
  }

  retryFailed(campaignId) {
    const c = this.store.campaigns.get(campaignId);
    if (!c) throw new CampaignError('Kampanye tidak ditemukan', 'not_found');
    const n = this.store.outbox.requeueFailed(campaignId);
    if (n && [CampaignStatus.COMPLETED].includes(c.status)) {
      this.store.campaigns.update(campaignId, {
        status: CampaignStatus.PAUSED, status_reason: 'manual', finished_at: null, paused_at: Date.now(),
      });
    }
    this._emit(campaignId, 'status');
    return { requeued: n, campaign: this.store.campaigns.get(campaignId) };
  }

  /** Called by the scheduler tick: wakes campaigns that hit a daily limit. */
  resumeDue(atMs = Date.now()) {
    const woke = [];
    const todayStart = startOfLocalDay(atMs);
    for (const c of this.store.campaigns.byStatus(CampaignStatus.PAUSED)) {
      if (!['daily_cap', 'quota'].includes(c.status_reason)) continue;
      if (c.paused_at && c.paused_at >= todayStart) continue; // wait for the next local day
      try {
        this.start(c.id, { approvedBy: c.approved_by || 'auto-resume' });
        woke.push(c.id);
      } catch { /* ignore */ }
    }
    return woke;
  }

  // --------------------------------------------------------------- worker

  _kick(campaignId) {
    if (this.workers.has(campaignId)) return;
    const p = this._work(campaignId)
      .catch((err) => {
        console.error(`[AUTOMATION] worker ${campaignId} crashed:`, err);
        try { this.pause(campaignId, `error: ${err.message}`.slice(0, 120)); } catch { /* ignore */ }
      })
      .finally(() => this.workers.delete(campaignId));
    this.workers.set(campaignId, p);
  }

  /** Resolves when the worker for a campaign (if any) has stopped. */
  async idle(campaignId) {
    const p = this.workers.get(campaignId);
    if (p) await p;
  }

  async _work(campaignId) {
    for (;;) {
      const c = this.store.campaigns.get(campaignId);
      if (!c || c.status !== CampaignStatus.RUNNING) return;

      // Daily cap — only live mail counts against the provider's limit.
      if (c.mode === 'live') {
        const sentToday = this.store.outbox.sentSince(startOfLocalDay());
        if (sentToday >= this.cfg.dailyCap) {
          this.pause(campaignId, 'daily_cap');
          return;
        }
      }

      const row = this.store.outbox.nextQueued(campaignId);
      if (!row) {
        this.store.campaigns.update(campaignId, {
          status: CampaignStatus.COMPLETED, status_reason: null, finished_at: Date.now(),
        });
        this._emit(campaignId, 'status');
        return;
      }

      // Re-check suppression at send time (it may have changed since creation).
      if (this.store.suppressions.has(row.email)) {
        this.store.outbox.mark(row.id, { status: OutboxStatus.SKIPPED, error: 'Ada di daftar suppress' });
        this._emit(campaignId, 'progress');
        continue;
      }

      const rendered = this._renderFor(c, row);
      if (rendered.missing.length) {
        this.store.outbox.mark(row.id, {
          status: OutboxStatus.SKIPPED,
          error: `Variabel kosong: ${rendered.missing.join(', ')}`,
        });
        this._emit(campaignId, 'progress');
        continue;
      }

      // Attachments are re-checked right before every send: a file deleted from
      // disk pauses the campaign instead of mailing recipients without it.
      let attachments;
      if (c.attachmentIds?.length) {
        try {
          attachments = this.attachments.resolveForSend(c.attachmentIds);
        } catch (e) {
          this.pause(campaignId, 'attachment_missing');
          this.emit('alert', { campaignId, kind: 'attachment', message: e.message });
          return;
        }
      }

      this.store.outbox.mark(row.id, { status: OutboxStatus.SENDING, attempts: row.attempts + 1 });

      try {
        const res = await this.mailer.send({
          to: row.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          replyTo: c.reply_to,
          fromName: c.from_name,
          mode: c.mode || undefined,
          attachments,
        });
        this.store.outbox.mark(row.id, {
          status: OutboxStatus.SENT, messageId: res.messageId, attempts: row.attempts + 1,
        });
        this._emit(campaignId, 'progress');
      } catch (err) {
        const e = err instanceof MailError ? err : new MailError(err.message, ErrorKind.TRANSIENT);

        if (e.kind === ErrorKind.AUTH || e.kind === ErrorKind.QUOTA) {
          // Not this recipient's fault: put it back and stop the whole campaign.
          this.store.outbox.mark(row.id, { status: OutboxStatus.QUEUED, error: e.message, attempts: row.attempts });
          this.pause(campaignId, e.kind === ErrorKind.AUTH ? 'auth' : 'quota');
          this.store.campaigns.update(campaignId, { status_reason: e.kind === ErrorKind.AUTH ? 'auth' : 'quota' });
          this.emit('alert', { campaignId, kind: e.kind, message: e.message });
          return;
        }

        if (e.kind === ErrorKind.TRANSIENT && row.attempts + 1 < this.cfg.maxAttempts) {
          this.store.outbox.mark(row.id, {
            status: OutboxStatus.QUEUED, error: e.message, attempts: row.attempts + 1,
          });
          await sleep(this.backoffBaseMs * 2 ** row.attempts);
          continue;
        }

        this.store.outbox.mark(row.id, {
          status: OutboxStatus.FAILED, error: e.message, attempts: row.attempts + 1,
        });
        if (e.hardBounce) this.store.suppressions.add(row.email, 'bounce');
        this._emit(campaignId, 'progress');
      }

      const gap = c.throttle_ms ?? this.cfg.throttleMs;
      if (gap > 0) await sleep(gap);
    }
  }

  _emit(campaignId, kind) {
    const c = this.store.campaigns.get(campaignId);
    if (!c) return;
    this.emit('campaign', {
      type: kind,
      campaignId,
      status: c.status,
      reason: c.status_reason,
      mode: c.mode,
      stats: c.stats,
    });
  }

  // ----------------------------------------------------------- conveniences

  /** Create + start in one step (used by scheduled jobs that are pre-approved). */
  quickSend({ approvedBy, ...input }) {
    const { campaign, report } = this.create(input);
    const started = this.start(campaign.id, { approvedBy });
    return { campaign: started, report };
  }

  /** One-off test mail straight through the transport (SMTP "test" button). */
  async sendTest({ to, fromName }) {
    return this.mailer.send({
      to,
      fromName,
      subject: 'Tes koneksi Wanar AI Automation',
      text: `Ini email uji dari Wanar AI.\nDikirim: ${new Date().toLocaleString('id-ID')}\n\nJika Anda menerima email ini, konfigurasi SMTP sudah benar.`,
    });
  }
}
