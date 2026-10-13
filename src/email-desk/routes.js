/**
 * src/email-desk/routes.js
 *
 * REST + SSE for the Email Desk. Guarded like automation/worklog: localhost,
 * or AUTOMATION_TOKEN for network access (it can send email as the owner).
 *
 * @author Wisnu Alfian Nur Ashar
 */

import express from 'express';
import { createAccessGuard } from '../automation/routes.js';
import { EmailDeskError } from './service.js';

export function createEmailDeskRouter({ emailDesk, env = process.env, rateLimiters = {} }) {
  const { desk, watcher } = emailDesk;
  const router = express.Router();
  router.use(createAccessGuard(env));
  if (rateLimiters.api) router.use(rateLimiters.api);

  const wrap = (fn) => async (req, res) => {
    try {
      res.json({ success: true, ...(await fn(req)) });
    } catch (e) {
      const status = e.code === 'not_found' ? 404 : (e instanceof EmailDeskError ? 400 : 500);
      res.status(status).json({ success: false, code: e.code || 'error', error: e instanceof EmailDeskError ? e.message : 'Terjadi kesalahan' });
    }
  };

  router.get('/status', wrap(async () => ({ smtp: desk.mailer?.describe?.() || null, imap: watcher.describe() })));
  router.get('/drafts', wrap(async () => ({ drafts: desk.pendingDrafts() })));
  router.get('/threads', wrap(async () => ({ threads: desk.threads(50) })));
  router.get('/threads/:id', wrap(async (req) => {
    const t = desk.store.threads.get(req.params.id);
    if (!t) throw new EmailDeskError('Percakapan tidak ditemukan', 'not_found');
    return { thread: t, messages: desk.threadMessages(t.id, 100) };
  }));
  router.post('/drafts', express.json({ limit: '64kb' }), wrap(async (req) => {
    const b = req.body || {};
    return { draft: await desk.draft({ to: b.to, subject: b.subject, body: b.body, brief: b.brief, autoMode: b.autoMode, autoInstructions: b.autoInstructions, origin: 'web' }) };
  }));
  router.post('/drafts/:id/send', wrap(async (req) => {
    const r = await desk.sendDraft(req.params.id);
    return { thread: r.thread, dryRun: r.dryRun };
  }));
  router.post('/drafts/:id/cancel', wrap(async (req) => ({ draft: desk.cancelDraft(req.params.id) })));
  router.post('/threads/:id/mode', express.json({ limit: '16kb' }), wrap(async (req) => {
    const t = desk.store.threads.get(req.params.id);
    if (!t) throw new EmailDeskError('Percakapan tidak ditemukan', 'not_found');
    return { thread: desk.setAutoMode(t, req.body?.mode, req.body?.instructions) };
  }));
  router.post('/check', wrap(async () => ({ processed: await watcher.check() })));

  router.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    const off = desk.onEvent((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { off(); clearInterval(ping); });
  });

  return router;
}
