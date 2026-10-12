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
import { CampaignStatus, OutboxStatus, suppressionKey } from './store.js';
import { parseRecipients, extractSubscribersToken } from './recipients.js';
import { CHANNEL_KINDS } from './channels/meta.js';
import { createChannels } from './channels/index.js';
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
  constructor({ store, mailer, channels = null, attachments = null, backoffBaseMs = 4000 }) {
    super();
    this.store = store;
    this.mailer = mailer;
    // Every outbound medium is a channel adapter; email is just the default one.
    this.channels = channels || createChannels({ env: process.env, mailer });
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
    throttleMs, sourceJobId, createdBy, attachmentIds, channel = 'email', useSubscribers = false,
  }) {
    const channelId = String(channel || 'email');
    if (!this.channels.has(channelId)) throw new CampaignError(`Kanal tidak dikenal: ${channelId}`);
    const adapter = this.channels.get(channelId);
    const caps = adapter.capabilities;
    const isEmail = channelId === 'email';

    const subj = String(subject || '').replace(/[\r\n]+/g, ' ').trim();
    const text = String(bodyText || '').trim();
    if (caps.subject === 'required' && !subj) throw new CampaignError('Subjek wajib diisi');
    if (!text && !(caps.html && String(bodyHtml || '').trim())) {
      throw new CampaignError(isEmail ? 'Isi email wajib diisi' : 'Isi pesan wajib diisi');
    }
    if (attachmentIds?.length && !caps.attachments) {
      throw new CampaignError(`${adapter.label} tidak mendukung lampiran pada konfigurasi saat ini`);
    }

    // Fail fast (and before anything is persisted) if an attachment is unusable.
    const attachmentList = this.attachments
      ? this.attachments.assertAvailable(attachmentIds)
      : [];

    const max = adapter.limits.maxRecipients;
    const kind = CHANNEL_KINDS[channelId];

    // "@subscribers" = everyone who opted in to this channel (resolved now).
    let wantsSubscribers = Boolean(useSubscribers);
    let input = recipients;
    if (adapter.supportsSubscribers) {
      const t = extractSubscribersToken(recipients);
      if (t.useSubscribers) wantsSubscribers = true;
      input = t.input;
    }
    // Fixed-destination channels (Slack, webhook...) have exactly one recipient.
    if (caps.fixedDestination && !String(Array.isArray(input) ? input.join('') : input || '').trim()) input = 'default';

    const parsed = parseRecipients(input, { kind, max: max + 1 });
    if (wantsSubscribers) {
      const have = new Set(parsed.recipients.map((r) => r.email));
      for (const sub of this.store.subscribers.list(channelId, { activeOnly: true })) {
        if (!have.has(sub.address)) {
          parsed.recipients.push({ email: sub.address, name: sub.name || '', vars: {} });
          have.add(sub.address);
        }
      }
    }

    if (parsed.recipients.length === 0) {
      throw new CampaignError(
        parsed.invalid.length
          ? `Tidak ada alamat tujuan valid (${parsed.invalid.length} baris ditolak)`
          : (wantsSubscribers ? 'Belum ada pelanggan aktif di kanal ini' : 'Daftar penerima kosong')
      );
    }
    if (parsed.recipients.length > max) {
      throw new CampaignError(`Maksimal ${max} penerima per kampanye${isEmail ? ' (EMAIL_MAX_RECIPIENTS)' : ''}`, 'too_many');
    }

    const keyOf = (addr) => suppressionKey(channelId, addr);
    const supKeys = this.store.suppressions.filter(parsed.recipients.map((r) => keyOf(r.email)));
    const suppressed = new Set(parsed.recipients.filter((r) => supKeys.has(keyOf(r.email))).map((r) => r.email));
    const used = [...new Set([...extractVars(subj), ...extractVars(text), ...extractVars(bodyHtml || '')])];

    const campaign = this.store.campaigns.create({
      name: String(name || '').trim() || `Kampanye ${new Date().toLocaleDateString('id-ID')}`,
      subject: subj,
      bodyText: text,
      bodyHtml: bodyHtml || null,
      fromName,
      replyTo,
      throttleMs: throttleMs ?? adapter.limits.throttleMs,
      sourceJobId,
      createdBy,
      attachmentIds: attachmentList,
      channel: channelId,
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

    // Channel-specific heads-ups the operator should see before approving.
    const warnings = [];
    if (text.length > caps.maxTextLength) {
      warnings.push(
        channelId === 'whatsapp'
          ? `Pesan ${text.length} karakter akan DIPOTONG menjadi ${caps.maxTextLength} (batas parameter template WhatsApp).`
          : `Pesan ${text.length} karakter akan dipecah menjadi beberapa pesan (batas ${caps.maxTextLength}).`
      );
    }
    if (channelId === 'whatsapp' && adapter.mode === 'live' && !String(adapter.describe().sendMode).startsWith('template')) {
      warnings.push('Tanpa WHATSAPP_TEMPLATE_NAME, pesan hanya terkirim ke pelanggan yang membalas dalam 24 jam terakhir.');
    }

    const report = {
      channel: channelId,
      warnings,
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
    const isEmail = (campaign.channel || 'email') === 'email';
    let html = { text: '', missing: [] };
    if (isEmail) {
      html = campaign.body_html
        ? render(campaign.body_html, vars, { html: true })
        : { text: textToHtml(text.text), missing: [] };
    }
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
      mode: fresh ? this.channels.get(c.channel || 'email').mode : (c.mode || this.channels.get(c.channel || 'email').mode),
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
      const channelId = c.channel || 'email';
      const adapter = this.channels.get(channelId);

      // Daily cap — only live traffic counts against the provider's limit.
      if (c.mode === 'live') {
        const sentToday = this.store.outbox.sentSince(startOfLocalDay(), channelId);
        if (sentToday >= adapter.limits.dailyCap) {
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
      const supKey = suppressionKey(channelId, row.email);
      if (this.store.suppressions.has(supKey)) {
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
        const res = await adapter.send({
          to: row.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          replyTo: c.reply_to,
          fromName: c.from_name,
          mode: c.mode || undefined,
          attachments,
          recipient: { name: row.name, vars: row.vars },
          campaign: { id: c.id, name: c.name },
        });
        this.store.outbox.mark(row.id, {
          status: OutboxStatus.SENT, messageId: res.messageId, attempts: row.attempts + 1,
        });
        this._emit(campaignId, 'progress');
      } catch (err) {
        const e = err instanceof MailError ? err : new MailError(err.message, ErrorKind.TRANSIENT);

        const stopsCampaign = [ErrorKind.AUTH, ErrorKind.QUOTA, ErrorKind.CONFIG].includes(e.kind);
        if (stopsCampaign) {
          // Not this recipient's fault: put it back and stop the whole campaign.
          const reason = e.kind; // 'auth' | 'quota' | 'config'
          this.store.outbox.mark(row.id, { status: OutboxStatus.QUEUED, error: e.message, attempts: row.attempts });
          this.pause(campaignId, reason);
          this.store.campaigns.update(campaignId, { status_reason: reason });
          this.emit('alert', { campaignId, kind: e.kind, messageChannel: channelId, message: e.message });
          return;
        }

        if (e.kind === ErrorKind.TRANSIENT && row.attempts + 1 < adapter.limits.maxAttempts) {
          this.store.outbox.mark(row.id, {
            status: OutboxStatus.QUEUED, error: e.message, attempts: row.attempts + 1,
          });
          // Honour the provider's own "retry after" (Telegram flood control...).
          const wait = Number.isFinite(e.retryAfterMs)
            ? Math.min(e.retryAfterMs, 120_000)
            : this.backoffBaseMs * 2 ** row.attempts;
          await sleep(wait);
          continue;
        }

        this.store.outbox.mark(row.id, {
          status: OutboxStatus.FAILED, error: e.message, attempts: row.attempts + 1,
        });
        if (e.hardBounce) {
          this.store.suppressions.add(supKey, 'bounce');
          // Someone who blocked the bot / left the channel is no longer a subscriber.
          this.store.subscribers.setActive(channelId, row.email, false);
        }
        this._emit(campaignId, 'progress');
      }

      const gap = c.throttle_ms ?? adapter.limits.throttleMs;
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
      messageChannel: c.channel || 'email',
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

  /** One-off test message straight through a channel (the "Tes" buttons). */
  async testChannel(channelId, { to, fromName } = {}) {
    const adapter = this.channels.get(channelId);
    const address = adapter.capabilities.fixedDestination ? 'default' : to;
    const stamp = new Date().toLocaleString('id-ID', { timeZone: DEFAULT_TIMEZONE });
    return adapter.send({
      to: address,
      fromName,
      subject: 'Tes koneksi Wanar AI',
      text: `Ini pesan uji dari Wanar AI.\nDikirim: ${stamp}\n\nJika Anda menerima pesan ini, kanal ${adapter.label} sudah terhubung.`,
      mode: adapter.mode,
    });
  }

  /** Backwards-compatible email test. */
  async sendTest({ to, fromName }) {
    return this.testChannel('email', { to, fromName });
  }
}
