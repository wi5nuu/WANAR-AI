/**
 * src/memory/routes.js
 *
 * REST + SSE for personal memory. Owner-only, like every other dashboard.
 *
 *   GET    /overview  /items?q=&kind=  /items/:id/history  /about
 *   GET    /events            SSE (memory changed)
 *   POST   /items             remember something
 *   PATCH  /items/:id         correct it
 *   DELETE /items/:id         forget it
 *   POST   /forget            forget by phrase (or everything, with confirm)
 *
 * @author Wisnu Alfian Nur Ashar
 */

import express from 'express';
import { createAccessGuard } from '../automation/routes.js';
import { PersonalError } from './personal.js';
import { MEMORY_KINDS } from './personal-store.js';

const STATUS_FOR_CODE = { not_found: 404, bad_request: 400 };

export function createMemoryRouter({ memory, rateLimiters = {}, env = process.env }) {
  const svc = memory.service;
  const router = express.Router();
  router.use(createAccessGuard(env));
  const noop = (req, res, next) => next();
  const act = rateLimiters.automation || noop;

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof PersonalError) {
        return res.status(STATUS_FOR_CODE[err.code] || 400).json({ success: false, error: err.message, code: err.code });
      }
      console.error('[MEMORY] route error:', err);
      return res.status(500).json({ success: false, error: 'Kesalahan internal memori pribadi' });
    }
  };

  router.get('/overview', wrap((req, res) => res.json({ success: true, ...svc.overview() })));

  router.get('/items', wrap((req, res) => {
    const q = String(req.query.q || '').trim();
    const items = q ? svc.search(q, { limit: 100 }) : svc.store.items.list({
      kind: MEMORY_KINDS.includes(req.query.kind) ? req.query.kind : null,
      activeOnly: req.query.all !== '1',
      limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000),
    });
    res.json({ success: true, items, query: q || null });
  }));

  router.get('/items/:id/history', wrap((req, res) => {
    res.json({ success: true, history: svc.store.items.history(req.params.id, 50) });
  }));

  router.get('/about', wrap((req, res) => {
    const block = svc.buildPromptBlock({ text: String(req.query.q || '') });
    res.json({ success: true, block: block.text, ids: block.ids, summary: svc.summaryLine() });
  }));

  router.post('/items', act, wrap((req, res) => {
    const b = req.body || {};
    const item = svc.remember({
      kind: b.kind || 'fact',
      key: b.key,
      value: b.value ?? b.text,
      tags: b.tags,
      source: 'owner',
      confidence: b.confidence ?? 1,
    });
    res.status(201).json({ success: true, item });
  }));

  router.patch('/items/:id', act, wrap((req, res) => {
    const item = svc.update(req.params.id, req.body || {});
    res.json({ success: true, item });
  }));

  router.delete('/items/:id', act, wrap((req, res) => {
    svc.forget(req.params.id);
    res.json({ success: true });
  }));

  router.post('/forget', act, wrap((req, res) => {
    const b = req.body || {};
    if (b.all === true) {
      if (b.confirm !== 'LUPA SEMUA') throw new PersonalError('Konfirmasi diperlukan: kirim {"all":true,"confirm":"LUPA SEMUA"}.', 'bad_request');
      const n = svc.forgetByText('', { all: true });
      return res.json({ success: true, forgotten: n });
    }
    const q = String(b.q || b.text || '').trim();
    if (!q) throw new PersonalError('Sebutkan apa yang ingin dilupakan (q).', 'bad_request');
    const n = svc.forgetByText(q);
    res.json({ success: true, forgotten: n, matched: n > 0 });
  }));

  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 5000\n\n');
    const send = (e) => { try { res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`); } catch { /* closed */ } };
    svc.on('change', send);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);
    req.on('close', () => { clearInterval(hb); svc.off('change', send); });
  });

  return router;
}
