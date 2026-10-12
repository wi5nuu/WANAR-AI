/**
 * src/automation/routes.js
 *
 * REST + realtime (SSE) API for the Automation page.
 *
 *   GET    /overview                    dashboard summary
 *   GET    /events                      SSE stream (campaign progress, job runs, alerts)
 *   POST   /schedule/preview            validate a schedule, return next runs
 *   POST   /recipients/parse            parse & validate a pasted list
 *
 *   GET    /jobs            POST /jobs
 *   PATCH  /jobs/:id        DELETE /jobs/:id
 *   POST   /jobs/:id/approve | pause | run
 *   GET    /jobs/:id/runs
 *   GET    /runs                        recent executions
 *
 *   GET    /campaigns       POST /campaigns
 *   GET    /campaigns/:id   DELETE /campaigns/:id
 *   POST   /campaigns/:id/preview | start | pause | resume | cancel | retry-failed
 *
 *   GET/POST/DELETE /suppressions
 *   POST   /smtp/test
 *   POST   /compose/email | code | text
 *
 * Every state-changing route is a human-facing action: pressing "Setujui &
 * Kirim" in the UI is the consent that arms a job / starts a campaign.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import express from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { previewSchedule, ScheduleError, DEFAULT_TIMEZONE } from './cron.js';
import { parseRecipients, isValidEmail } from './recipients.js';
import { CHANNEL_KINDS, FIXED_DESTINATION, isChannelId } from './channels/meta.js';
import { generateEmail, generateMessage, generatePackage, generateCode, generateText, ComposeError } from './ai-compose.js';
import { CampaignError, startOfLocalDay } from './campaigns.js';
import { JobError, JOB_TYPES } from './scheduler.js';
import { MailError } from './mailer.js';
import { AttachmentError } from './attachments.js';

/**
 * busboy decodes multipart filenames as latin1; browsers send UTF-8. Undo that
 * so "Laporan Bulan Ágústus.pdf" does not arrive as mojibake.
 */
function fixFilenameEncoding(name) {
  const raw = String(name || '');
  if (!/[-ÿ]/.test(raw)) return raw;
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  return decoded.includes('�') ? raw : decoded;
}

const STATUS_FOR_CODE = {
  not_found: 404,
  bad_state: 409,
  busy: 409,
  not_approved: 409,
  too_many: 413,
  too_large: 413,
  blocked_type: 415,
  missing: 409,
};

function fail(res, err) {
  const known =
    err instanceof CampaignError || err instanceof JobError || err instanceof ScheduleError ||
    err instanceof ComposeError || err instanceof MailError || err instanceof AttachmentError;
  if (!known) {
    console.error('[AUTOMATION] route error:', err);
    return res.status(500).json({ success: false, error: 'Kesalahan internal modul otomasi' });
  }
  const status = STATUS_FOR_CODE[err.code] || (err instanceof ComposeError && err.code !== 'bad_request' ? 502 : 400);
  return res.status(status).json({ success: false, error: err.message, code: err.code || err.kind });
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Network access guard.
 *
 * The server listens on every interface, so without this anyone on the office
 * LAN could list recipients or start a campaign through the operator's SMTP
 * account. Rules:
 *   - direct loopback connections (this computer)      -> allowed
 *   - anything else, or anything that came through a
 *     proxy (X-Forwarded-For present)                  -> needs AUTOMATION_TOKEN
 *   - no AUTOMATION_TOKEN configured                   -> remote access refused
 *
 * EventSource cannot set headers, so /events also accepts ?token=.
 */
export function createAccessGuard(env = process.env) {
  const secret = String(env.AUTOMATION_TOKEN || '');
  return (req, res, next) => {
    const proxied = Boolean(req.headers['x-forwarded-for'] || req.headers.forwarded);
    if (LOOPBACK.has(req.socket?.remoteAddress) && !proxied) return next();

    if (!secret) {
      return res.status(403).json({
        success: false,
        code: 'remote_forbidden',
        error: 'Otomasi hanya dapat diakses dari komputer server (localhost). Untuk akses jaringan, set AUTOMATION_TOKEN di .env.',
      });
    }
    const given = String(req.headers['x-automation-token'] || req.query?.token || '');
    const a = Buffer.from(given);
    const b = Buffer.from(secret);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    return res.status(401).json({ success: false, code: 'token_required', error: 'Token otomasi diperlukan atau salah.' });
  };
}

export function createAutomationRouter({ automation, rateLimiters = {}, actorOf = () => 'operator', env = process.env }) {
  const { store, engine, scheduler, mailer, events } = automation;
  const router = express.Router();
  router.use(createAccessGuard(env));
  const noop = (req, res, next) => next();
  const strict = rateLimiters.automation || rateLimiters.strict || noop;
  const chat = rateLimiters.chat || noop;

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      fail(res, err);
    }
  };

  // ----------------------------------------------------------- overview

  router.get('/overview', wrap((req, res) => {
    const jobs = store.jobs.list();
    const campaigns = store.campaigns.list(200);
    const channelUsage = store.outbox.sentSinceByChannel(startOfLocalDay());
    const sentToday = channelUsage.email || 0;
    const mail = mailer.describe();
    res.json({
      success: true,
      mailer: mail,
      timezone: DEFAULT_TIMEZONE,
      jobTypes: JOB_TYPES,
      attachmentLimits: automation.attachments?.limits || null,
      channels: automation.channels
        ? automation.channels.describeAll().map((c) => ({ ...c, sentToday: channelUsage[c.id] || 0 }))
        : [],
      telegramInbox: automation.inbox ? automation.inbox.status() : null,
      usage: { sentToday, dailyCap: mail.dailyCap, remaining: Math.max(0, mail.dailyCap - sentToday) },
      counts: {
        jobsActive: jobs.filter((j) => j.status === 'active').length,
        jobsPending: jobs.filter((j) => j.status === 'pending_approval').length,
        jobsPaused: jobs.filter((j) => j.status === 'paused').length,
        campaignsRunning: campaigns.filter((c) => c.status === 'running').length,
        campaignsDraft: campaigns.filter((c) => c.status === 'draft').length,
        suppressed: store.suppressions.list().length,
      },
      upcoming: jobs
        .filter((j) => j.status === 'active' && j.next_run_at)
        .sort((a, b) => a.next_run_at - b.next_run_at)
        .slice(0, 5)
        .map((j) => ({ id: j.id, name: j.name, type: j.type, nextRunAt: j.next_run_at })),
    });
  }));

  // ---------------------------------------------------- realtime (SSE)

  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);

    const onEvent = (e) => {
      try {
        res.write(`event: ${e.channel}\ndata: ${JSON.stringify(e)}\n\n`);
      } catch { /* socket gone; cleanup below */ }
    };
    events.on('event', onEvent);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 20_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      events.off('event', onEvent);
    });
  });

  // ------------------------------------------------------------ helpers

  router.post('/schedule/preview', wrap((req, res) => {
    const { schedule, timezone } = req.body || {};
    try {
      res.json({ success: true, ...previewSchedule(schedule, timezone || DEFAULT_TIMEZONE, 5) });
    } catch (e) {
      // A bad expression is an expected, user-facing state — not a 4xx storm.
      res.json({ success: false, error: e.message });
    }
  }));

  router.post('/recipients/parse', wrap((req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string') throw new CampaignError('Field "text" wajib berupa string');
    if (text.length > 2_000_000) throw new CampaignError('Daftar terlalu besar', 'too_many');
    const channel = isChannelId(req.body?.channel) ? req.body.channel : 'email';
    const adapter = automation.channels?.get(channel);
    const max = adapter ? adapter.limits.maxRecipients : mailer.cfg.maxRecipients;
    const parsed = parseRecipients(text, { kind: CHANNEL_KINDS[channel], max: max + 1 });
    const keyOf = (a) => (channel === 'email' ? a : `${channel}:${a}`);
    const supKeys = store.suppressions.filter(parsed.recipients.map((r) => keyOf(r.email)));
    const suppressed = parsed.recipients.filter((r) => supKeys.has(keyOf(r.email))).map((r) => r.email);
    res.json({
      success: true,
      valid: parsed.recipients.length,
      overLimit: parsed.recipients.length > max,
      maxRecipients: max,
      invalid: parsed.invalid.slice(0, 50),
      invalidCount: parsed.invalid.length,
      duplicates: parsed.duplicates.slice(0, 50),
      duplicateCount: parsed.duplicates.length,
      suppressed,
      channel,
      fixedDestination: FIXED_DESTINATION.has(channel),
      sample: parsed.recipients.slice(0, 5),
      columns: [...new Set(parsed.recipients.flatMap((r) => Object.keys(r.vars)))],
    });
  }));

  // --------------------------------------------------------------- jobs

  router.get('/jobs', wrap((req, res) => {
    res.json({ success: true, jobs: store.jobs.list().map((j) => scheduler.present(j)) });
  }));

  router.post('/jobs', strict, wrap((req, res) => {
    const b = req.body || {};
    const job = scheduler.createJob(
      {
        name: b.name, type: b.type, schedule: b.schedule, timezone: b.timezone,
        payload: b.payload, maxRuns: b.maxRuns, endsAt: b.endsAt,
      },
      { activate: b.activate === true, actor: actorOf(req) }
    );
    res.status(201).json({ success: true, job: scheduler.present(job) });
  }));

  router.patch('/jobs/:id', strict, wrap((req, res) => {
    const job = scheduler.updateJob(req.params.id, req.body || {});
    res.json({ success: true, job: scheduler.present(job) });
  }));

  router.delete('/jobs/:id', strict, wrap((req, res) => {
    res.json({ success: scheduler.deleteJob(req.params.id) });
  }));

  router.post('/jobs/:id/approve', strict, wrap((req, res) => {
    const job = scheduler.approveJob(req.params.id, actorOf(req));
    res.json({ success: true, job: scheduler.present(job) });
  }));

  router.post('/jobs/:id/pause', strict, wrap((req, res) => {
    const job = scheduler.pauseJob(req.params.id);
    res.json({ success: true, job: scheduler.present(job) });
  }));

  router.post('/jobs/:id/run', strict, wrap((req, res) => {
    scheduler.runNow(req.params.id, { actor: actorOf(req) });
    res.status(202).json({ success: true, started: true });
  }));

  router.get('/jobs/:id/runs', wrap((req, res) => {
    if (!store.jobs.get(req.params.id)) throw new JobError('Job tidak ditemukan', 'not_found');
    res.json({ success: true, runs: store.runs.forJob(req.params.id, 50) });
  }));

  router.get('/runs', wrap((req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    res.json({ success: true, runs: store.runs.recent(limit) });
  }));

  // ---------------------------------------------------------- campaigns

  router.get('/campaigns', wrap((req, res) => {
    res.json({ success: true, campaigns: store.campaigns.list(100) });
  }));

  router.post('/campaigns', strict, wrap((req, res) => {
    const b = req.body || {};
    const { campaign, report } = engine.create({
      name: b.name, subject: b.subject, bodyText: b.bodyText, bodyHtml: b.bodyHtml,
      recipients: b.recipients, fromName: b.fromName, replyTo: b.replyTo,
      throttleMs: Number.isFinite(b.throttleMs) ? Math.max(0, b.throttleMs) : undefined,
      attachmentIds: Array.isArray(b.attachmentIds) ? b.attachmentIds : undefined,
      channel: isChannelId(b.channel) ? b.channel : 'email',
      useSubscribers: b.useSubscribers === true,
      createdBy: actorOf(req),
    });
    res.status(201).json({
      success: true, campaign, report, preview: engine.preview(campaign.id, 3), mode: mailer.mode,
    });
  }));

  router.get('/campaigns/:id', wrap((req, res) => {
    const c = store.campaigns.get(req.params.id);
    if (!c) throw new CampaignError('Kampanye tidak ditemukan', 'not_found');
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    res.json({
      success: true,
      campaign: c,
      attachments: store.attachments.getMany(c.attachmentIds || []),
      recipients: store.outbox.page(c.id, { status: req.query.status || undefined, limit, offset }),
    });
  }));

  router.post('/campaigns/:id/preview', wrap((req, res) => {
    res.json({ success: true, preview: engine.preview(req.params.id, parseInt(req.body?.count, 10) || 3) });
  }));

  router.post('/campaigns/:id/start', strict, wrap((req, res) => {
    const c = engine.start(req.params.id, { approvedBy: actorOf(req) });
    res.status(202).json({ success: true, campaign: c });
  }));

  router.post('/campaigns/:id/pause', strict, wrap((req, res) => {
    res.json({ success: true, campaign: engine.pause(req.params.id, 'manual') });
  }));

  router.post('/campaigns/:id/resume', strict, wrap((req, res) => {
    res.json({ success: true, campaign: engine.resume(req.params.id, { approvedBy: actorOf(req) }) });
  }));

  router.post('/campaigns/:id/cancel', strict, wrap((req, res) => {
    res.json({ success: true, campaign: engine.cancel(req.params.id) });
  }));

  router.post('/campaigns/:id/retry-failed', strict, wrap((req, res) => {
    res.json({ success: true, ...engine.retryFailed(req.params.id) });
  }));

  router.delete('/campaigns/:id', strict, wrap((req, res) => {
    const c = store.campaigns.get(req.params.id);
    if (!c) throw new CampaignError('Kampanye tidak ditemukan', 'not_found');
    if (c.status === 'running') throw new CampaignError('Hentikan kampanye yang sedang berjalan dulu', 'bad_state');
    res.json({ success: store.campaigns.remove(req.params.id) });
  }));

  // ----------------------------------------------------------- channels

  router.get('/channels', wrap((req, res) => {
    const used = store.outbox.sentSinceByChannel(startOfLocalDay());
    res.json({
      success: true,
      channels: automation.channels.describeAll().map((c) => ({
        ...c,
        sentToday: used[c.id] || 0,
        subscribers: c.id === 'telegram' ? store.subscribers.counts('telegram') : undefined,
      })),
      telegramInbox: automation.inbox ? automation.inbox.status() : null,
    });
  }));

  router.post('/channels/:id/test', strict, wrap(async (req, res) => {
    const id = req.params.id;
    if (!isChannelId(id)) throw new CampaignError('Kanal tidak dikenal', 'not_found');
    const adapter = automation.channels.get(id);
    const fixed = adapter.capabilities.fixedDestination;

    let to = 'default';
    if (!fixed) {
      to = adapter.normalizeAddress(req.body?.to);
      if (!to) throw new CampaignError(`Tujuan tes tidak valid untuk ${adapter.label}`);
    }
    if (adapter.mode !== 'live') {
      return res.json({
        success: false, mode: 'dry-run',
        error: `${adapter.label} belum dikonfigurasi — pesan tidak dikirim (mode simulasi).`,
        missing: adapter.describe().missing,
      });
    }
    const verified = await adapter.verify();
    if (!verified.ok) return res.json({ success: false, mode: 'live', error: verified.error, kind: verified.kind });
    const r = await engine.testChannel(id, { to });
    res.json({ success: true, mode: 'live', messageId: r.messageId, verified: verified.detail });
  }));

  router.get('/subscribers/:channel', wrap((req, res) => {
    const ch = req.params.channel;
    if (!isChannelId(ch)) throw new CampaignError('Kanal tidak dikenal', 'not_found');
    res.json({
      success: true,
      counts: store.subscribers.counts(ch),
      subscribers: store.subscribers.list(ch),
    });
  }));

  router.post('/subscribers/:channel', strict, wrap((req, res) => {
    const ch = req.params.channel;
    if (!isChannelId(ch) || FIXED_DESTINATION.has(ch)) throw new CampaignError('Kanal ini tidak memiliki daftar pelanggan');
    const address = automation.channels.get(ch).normalizeAddress(req.body?.address);
    if (!address) throw new CampaignError('Alamat tidak valid');
    const sub = store.subscribers.upsert({ channel: ch, address, name: String(req.body?.name || '').slice(0, 120) });
    res.status(201).json({ success: true, subscriber: sub });
  }));

  router.delete('/subscribers/:channel/:address', strict, wrap((req, res) => {
    res.json({ success: store.subscribers.remove(req.params.channel, req.params.address) });
  }));

  // One brief -> a ready template for every channel + a campaign name.
  router.post('/compose/package', chat, wrap(async (req, res) => {
    const b = req.body || {};
    const out = await generatePackage(automation.scheduler.aiManager, {
      brief: b.brief, tone: b.tone, language: b.language, audience: b.audience,
      signature: b.signature, personalize: b.personalize !== false,
      provider: b.provider, model: b.model,
    });
    res.json({ success: true, ...out });
  }));

  router.post('/compose/message', chat, wrap(async (req, res) => {
    const b = req.body || {};
    const out = await generateMessage(automation.scheduler.aiManager, {
      brief: b.brief, channel: isChannelId(b.channel) ? b.channel : 'telegram', tone: b.tone,
      language: b.language, audience: b.audience, personalize: b.personalize !== false,
      provider: b.provider, model: b.model,
    });
    res.json({ success: true, ...out });
  }));

  // -------------------------------------------------------- attachments

  const attachments = automation.attachments;
  const uploader = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: attachments?.limits.maxFileBytes ?? 10 * 1048576, files: 1 },
  }).single('file');

  router.get('/attachments', wrap((req, res) => {
    if (!attachments) throw new AttachmentError('Lampiran tidak tersedia');
    res.json({
      success: true,
      limits: attachments.limits,
      attachments: store.attachments.list().map((a) => ({
        id: a.id, filename: a.filename, contentType: a.contentType, size: a.size,
        createdAt: a.createdAt, inUse: attachments.inUse(a.id),
      })),
    });
  }));

  router.post('/attachments', strict, (req, res) => {
    if (!attachments) return fail(res, new AttachmentError('Lampiran tidak tersedia'));
    uploader(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        const tooLarge = err.code === 'LIMIT_FILE_SIZE';
        return res.status(tooLarge ? 413 : 400).json({
          success: false,
          code: tooLarge ? 'too_large' : 'bad_request',
          error: tooLarge
            ? `File terlalu besar. Maksimal ${(attachments.limits.maxFileBytes / 1048576).toFixed(0)} MB per file.`
            : `Unggahan gagal: ${err.message}`,
        });
      }
      if (err) return fail(res, err);
      if (!req.file) return fail(res, new AttachmentError('Pilih file pada field "file"'));
      try {
        const att = attachments.save({
          originalName: fixFilenameEncoding(req.file.originalname),
          buffer: req.file.buffer,
          contentType: req.file.mimetype,
        });
        return res.status(201).json({
          success: true,
          attachment: { id: att.id, filename: att.filename, contentType: att.contentType, size: att.size },
        });
      } catch (e) {
        return fail(res, e);
      }
    });
  });

  router.delete('/attachments/:id', strict, wrap((req, res) => {
    if (!attachments) throw new AttachmentError('Lampiran tidak tersedia');
    const id = req.params.id;
    if (!store.attachments.get(id)) throw new AttachmentError('Lampiran tidak ditemukan', 'not_found');
    if (attachments.inUse(id)) {
      throw new AttachmentError('Lampiran masih dipakai kampanye/job yang belum selesai', 'bad_state');
    }
    res.json({ success: attachments.remove(id) });
  }));

  // -------------------------------------------------------- suppression

  router.get('/suppressions', wrap((req, res) => {
    res.json({ success: true, suppressions: store.suppressions.list() });
  }));

  router.post('/suppressions', strict, wrap((req, res) => {
    const emails = [].concat(req.body?.emails ?? req.body?.email ?? []).map(String);
    const valid = emails.filter(isValidEmail);
    if (!valid.length) throw new CampaignError('Tidak ada alamat email valid');
    for (const e of valid) store.suppressions.add(e, req.body?.reason || 'manual');
    res.status(201).json({ success: true, added: valid.length });
  }));

  router.delete('/suppressions/:email', strict, wrap((req, res) => {
    res.json({ success: store.suppressions.remove(req.params.email) });
  }));

  // --------------------------------------------------------------- smtp

  router.post('/smtp/test', strict, wrap(async (req, res) => {
    const to = String(req.body?.to || '').trim();
    if (!isValidEmail(to)) throw new CampaignError('Alamat tujuan tes tidak valid');
    const verified = await mailer.verify();
    if (mailer.mode !== 'live') {
      return res.json({
        success: false, mode: 'dry-run',
        error: 'SMTP belum dikonfigurasi — email tidak dikirim (mode simulasi).',
        missing: mailer.describe().missing,
      });
    }
    if (!verified.ok) return res.json({ success: false, mode: 'live', error: verified.error, kind: verified.kind });
    const r = await engine.sendTest({ to });
    res.json({ success: true, mode: 'live', messageId: r.messageId });
  }));

  // ------------------------------------------------------- AI compose

  router.post('/compose/email', chat, wrap(async (req, res) => {
    const b = req.body || {};
    const out = await generateEmail(automation.scheduler.aiManager, {
      brief: b.brief, tone: b.tone, language: b.language, audience: b.audience,
      signature: b.signature, personalize: b.personalize !== false,
      provider: b.provider, model: b.model,
    });
    res.json({ success: true, ...out });
  }));

  router.post('/compose/code', chat, wrap(async (req, res) => {
    const b = req.body || {};
    const out = await generateCode(automation.scheduler.aiManager, {
      brief: b.brief, language: b.language, provider: b.provider, model: b.model,
    });
    res.json({ success: true, ...out });
  }));

  router.post('/compose/text', chat, wrap(async (req, res) => {
    const b = req.body || {};
    const out = await generateText(automation.scheduler.aiManager, {
      prompt: b.prompt, provider: b.provider, model: b.model,
    });
    res.json({ success: true, ...out });
  }));

  return router;
}
