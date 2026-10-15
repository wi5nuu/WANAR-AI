/**
 * src/command-center/routes.js
 *
 * "Pusat Kendali" — one place to watch and steer the whole personal agent:
 * work clock, reminders, email desk (drafts, batches, who-waits-on-whom,
 * follow-ups), channel health (Telegram, email send, inbox watcher) and the
 * server itself. One aggregated GET, a few safe actions, and one SSE stream
 * that fires whenever the journal or the email desk changes.
 *
 * Guarded like the other operator APIs (localhost, or AUTOMATION_TOKEN).
 *
 * @author Wisnu Alfian Nur Ashar
 */

import os from 'os';
import express from 'express';
import { createAccessGuard } from '../automation/routes.js';
import { localDate } from '../worklog/time.js';

const STARTED = Date.now();

export function createCommandCenterRouter({ worklog, emailDesk = null, automation = null, briefing = null, env = process.env, rateLimiters = {} }) {
  const svc = worklog.service;
  const desk = emailDesk?.desk || null;
  const watcher = emailDesk?.watcher || null;
  const router = express.Router();
  router.use(createAccessGuard(env));
  if (rateLimiters.api) router.use(rateLimiters.api);
  router.use(express.json({ limit: '32kb' }));

  const wrap = (fn) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, ...(await fn(req)) });
    } catch (e) {
      const status = e.code === 'not_found' ? 404 : (e.expose || e.name === 'WorklogError' || e.name === 'EmailDeskError' ? 400 : 500);
      res.status(status).json({ success: false, error: status === 500 ? 'Terjadi kesalahan' : e.message });
    }
  };

  router.get('/overview', wrap(async () => {
    const status = svc.status();
    const today = svc.day(status.date, { light: true });
    const s = svc.getSettings();
    const mem = process.memoryUsage();
    return {
      now: Date.now(),
      work: {
        status,
        today: { workedMin: today.workedMin, breakMin: today.breakMin, targetMin: today.targetMin, achievement: today.achievement, tasks: today.tasks, money: today.money },
        schedule: { workStart: s.workStart, workEnd: s.workEnd, breakStart: s.breakStart, breakEnd: s.breakEnd, workdays: s.workdays, autoStart: s.autoStart, followSchedule: s.followSchedule },
        reminders: svc.listReminders(30).map((r) => ({ id: r.id, at: r.at, text: r.text, source: r.source })),
        week: (() => {
          const w = svc.week(status.date);
          return { summary: w.summary, days: w.days.map((d) => ({ date: d.date, workedMin: d.workedMin, tasksDone: d.tasks.done, net: d.money.net })) };
        })(),
      },
      email: desk ? desk.overview() : null,
      channels: {
        telegram: automation?.inbox?.status?.() || null,
        mail: automation?.mailer?.describe?.() ? (({ mode, provider, configured, from, dailyCap, missing }) => ({ mode, provider, configured, from, dailyCap, missing }))(automation.mailer.describe()) : null,
        inbox: watcher?.describe?.() || null,
      },
      system: {
        uptimeSec: Math.round((Date.now() - STARTED) / 1000),
        rssMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
        load: os.loadavg().map((x) => Math.round(x * 100) / 100),
        freeMemMb: Math.round(os.freemem() / 1048576),
        totalMemMb: Math.round(os.totalmem() / 1048576),
        node: process.version,
        backgroundJobs: String(env.WANAR_BACKGROUND_JOBS || 'true').toLowerCase() !== 'false',
      },
      briefing: briefing ? briefing.build() : null,
    };
  }));

  // ---------------------------------------------------------------- actions

  router.post('/reminders', wrap(async (req) => {
    const { date = localDate(Date.now()), time, text } = req.body || {};
    if (!/^\d{1,2}[:.]\d{2}$/.test(String(time || ''))) throw Object.assign(new Error('Jam tidak valid (HH:MM)'), { expose: true });
    return { reminder: svc.addReminder({ at: `${date} ${String(time).replace('.', ':')}`, text, source: 'web' }) };
  }));
  router.delete('/reminders/:id', wrap(async (req) => ({ cancelled: svc.cancelReminder(req.params.id) })));

  router.post('/email/drafts/:id/send', wrap(async (req) => {
    const d = desk.findDraft(req.params.id);
    if (d.batch) return { batch: await desk.sendBatch(d.batch) };
    const r = await desk.sendDraft(d);
    return { thread: r.thread, dryRun: r.dryRun };
  }));
  router.post('/email/drafts/:id/cancel', wrap(async (req) => {
    const d = desk.findDraft(req.params.id);
    return d.batch ? { cancelled: desk.cancelBatch(d.batch) } : { draft: desk.cancelDraft(d) };
  }));
  router.post('/email/threads/:id/mode', wrap(async (req) => {
    const t = desk.store.threads.get(req.params.id);
    if (!t) throw Object.assign(new Error('Percakapan tidak ditemukan'), { code: 'not_found' });
    return { thread: desk.setAutoMode(t, req.body?.mode, req.body?.instructions || null) };
  }));
  router.post('/email/threads/:id/followup', wrap(async (req) => {
    const t = desk.store.threads.get(req.params.id);
    if (!t) throw Object.assign(new Error('Percakapan tidak ditemukan'), { code: 'not_found' });
    return { thread: desk.setFollowUp(t, req.body?.days) };
  }));
  router.get('/email/threads/:id', wrap(async (req) => {
    const t = desk.store.threads.get(req.params.id);
    if (!t) throw Object.assign(new Error('Percakapan tidak ditemukan'), { code: 'not_found' });
    return { thread: t, messages: desk.threadMessages(t.id, 50) };
  }));
  // One switch for all email: notify | approve | auto. 'auto' also answers what is already waiting.
  router.post('/email/policy', wrap(async (req) => {
    const mode = String(req.body?.mode || '');
    if (!['notify', 'approve', 'auto'].includes(mode)) throw Object.assign(new Error('Mode: notify | approve | auto'), { expose: true });
    const r = await desk.applyPolicy(mode, { clearExceptions: req.body?.clearExceptions === true });
    return { policy: { mode: r.mode }, answered: r.answered };
  }));
  router.post('/email/check', wrap(async () => ({ processed: watcher ? await watcher.check() : 0 })));

  // People close to the owner (pasangan/keluarga/sahabat): answered personally and automatically.
  router.get('/email/contacts', wrap(async () => ({ contacts: desk.contactsList() })));
  router.post('/email/contacts', wrap(async (req) => {
    const { address, relation, name, call, notes } = req.body || {};
    const c = desk.setContact({ address, relation, name: name || null, call: call || null, notes: notes || null, autoReply: true });
    return { contact: c, contacts: desk.contactsList() };
  }));
  router.delete('/email/contacts/:address', wrap(async (req) => ({ removed: desk.removeContact(req.params.address), contacts: desk.contactsList() })));

  router.post('/briefing/send', wrap(async () => {
    const chat = String(env.TELEGRAM_AI_CHAT_IDS || '').split(',')[0]?.trim();
    const tg = automation?.channels?.has?.('telegram') ? automation.channels.get('telegram') : null;
    if (!briefing || !chat || !tg || tg.mode !== 'live') throw Object.assign(new Error('Telegram belum aktif'), { expose: true });
    await tg.send({ to: chat, text: briefing.build() });
    return { sent: true };
  }));

  // --------------------------------------------------------------- realtime

  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    const send = (source) => (e) => {
      try { res.write(`event: change\ndata: ${JSON.stringify({ source, type: e?.type || e?.kind || 'change', at: Date.now() })}\n\n`); } catch { /* closed */ }
    };
    const onWork = send('worklog');
    svc.on('change', onWork);
    const offDesk = desk ? desk.onEvent(send('email')) : () => {};
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20_000);
    req.on('close', () => { clearInterval(hb); svc.off('change', onWork); offDesk(); });
  });

  return router;
}
