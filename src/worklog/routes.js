/**
 * src/worklog/routes.js
 *
 * REST + SSE for the "Jurnal Kerja" page. Guarded exactly like the automation
 * API: localhost only, or AUTOMATION_TOKEN for network access — this journal
 * contains income, expenses and filesystem paths.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import express from 'express';
import { createAccessGuard } from '../automation/routes.js';
import { WorklogError } from './service.js';
import { formatMinutes } from './time.js';

const STATUS = { not_found: 404, bad_state: 409, unavailable: 503 };

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Neutralise spreadsheet formula injection (=, +, -, @ at the start).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function createWorklogRouter({ worklog, rateLimiters = {}, env = process.env }) {
  const svc = worklog.service;
  const router = express.Router();
  router.use(createAccessGuard(env));
  const noop = (req, res, next) => next();
  const act = rateLimiters.automation || noop;
  const ai = rateLimiters.chat || noop;

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof WorklogError) {
        return res.status(STATUS[err.code] || 400).json({ success: false, error: err.message, code: err.code });
      }
      console.error('[WORKLOG] route error:', err);
      return res.status(500).json({ success: false, error: 'Kesalahan internal jurnal kerja' });
    }
  };

  // --------------------------------------------------------------- read

  router.get('/overview', wrap((req, res) => {
    const date = req.query.date || svc.today();
    res.json({
      success: true,
      status: svc.status(),
      day: svc.day(date),
      week: svc.week(date),
      settings: svc.getSettings(),
      telegram: { connected: Boolean(svc.notify), chatId: svc._chatId() },
      github: { tokenConfigured: Boolean(env.GITHUB_TOKEN) },
    });
  }));

  router.get('/status', wrap((req, res) => res.json({ success: true, status: svc.status() })));
  router.get('/days/:date', wrap((req, res) => res.json({ success: true, day: svc.day(req.params.date) })));
  router.get('/range', wrap((req, res) => res.json({ success: true, ...svc.range(req.query.from, req.query.to) })));
  router.get('/month/:ym', wrap((req, res) => res.json({ success: true, ...svc.month(req.params.ym) })));
  router.get('/history', wrap((req, res) => {
    const dates = svc.store.datesWithData(Math.min(parseInt(req.query.limit, 10) || 60, 365));
    res.json({
      success: true,
      days: dates.map((d) => {
        const x = svc.day(d, { light: true });
        return { date: d, workedMin: x.workedMin, tasksDone: x.tasks.done, net: x.money.net, report: (svc.store.reports.get(d)?.text || '').slice(0, 140) };
      }),
    });
  }));

  // ------------------------------------------------------------ realtime

  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    const send = (e) => { try { res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`); } catch { /* closed */ } };
    svc.on('change', send);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20_000);
    req.on('close', () => { clearInterval(hb); svc.off('change', send); });
  });

  // --------------------------------------------------------------- clock

  router.post('/clock/start', act, wrap((req, res) => res.json({ success: true, status: svc.clockStart('web') })));
  router.post('/clock/pause', act, wrap((req, res) => res.json({ success: true, status: svc.clockPause('web') })));
  router.post('/clock/resume', act, wrap((req, res) => res.json({ success: true, status: svc.clockResume('web') })));
  router.post('/clock/stop', act, wrap((req, res) => res.json({ success: true, status: svc.clockStop() })));

  // ------------------------------------------------------------- entries

  router.post('/days/:date/reset', act, wrap((req, res) => {
    const b = req.body || {};
    res.json({ success: true, removed: svc.resetDay(req.params.date, {
      segments: b.segments !== false, tasks: b.tasks === true, finance: b.finance === true, report: b.report === true,
    }) });
  }));

  router.post('/segments', act, wrap((req, res) => res.status(201).json({ success: true, segment: svc.addSegment(req.body || {}) })));
  router.delete('/segments/:id', act, wrap((req, res) => res.json({ success: svc.removeSegment(req.params.id) })));

  router.post('/tasks', act, wrap((req, res) => res.status(201).json({ success: true, task: svc.addTask(req.body || {}) })));
  router.patch('/tasks/:id', act, wrap((req, res) => res.json({ success: true, task: svc.updateTask(req.params.id, req.body || {}) })));
  router.delete('/tasks/:id', act, wrap((req, res) => res.json({ success: svc.removeTask(req.params.id) })));

  router.post('/finance', act, wrap((req, res) => res.status(201).json({ success: true, entry: svc.addFinance(req.body || {}) })));
  router.delete('/finance/:id', act, wrap((req, res) => res.json({ success: svc.removeFinance(req.params.id, req.query.date) })));

  router.put('/report/:date', act, wrap((req, res) => res.json({ success: true, report: svc.setReport(req.params.date, req.body || {}) })));

  // ---------------------------------------------------- free text + AI

  router.post('/parse', ai, wrap(async (req, res) => {
    const r = await svc.parseText(req.body?.text, { useAi: req.body?.useAi !== false });
    res.json({ success: true, ...r });
  }));

  router.post('/apply', act, wrap((req, res) => {
    const saved = svc.applyProposal(req.body?.date || svc.today(), req.body?.proposal || {}, 'web');
    res.json({ success: true, saved });
  }));

  router.post('/evaluate/:date', ai, wrap(async (req, res) => {
    res.json({ success: true, evaluation: await svc.evaluate(req.params.date) });
  }));

  router.post('/activity/:date/refresh', act, wrap(async (req, res) => {
    res.json({ success: true, activity: await svc.refreshActivity(req.params.date, { force: true }) });
  }));

  // ------------------------------------------------------------ settings

  router.get('/settings', wrap((req, res) => res.json({ success: true, settings: svc.getSettings() })));
  router.put('/settings', act, wrap((req, res) => res.json({ success: true, settings: svc.updateSettings(req.body || {}) })));
  router.post('/sources/folders', act, wrap((req, res) => {
    res.status(201).json({ success: true, folders: svc.addFolder(req.body?.path, req.body?.label) });
  }));
  router.delete('/sources/folders', act, wrap((req, res) => {
    res.json({ success: true, folders: svc.removeFolder(req.body?.path || req.query.path) });
  }));

  router.post('/telegram/send', act, wrap(async (req, res) => {
    const r = await svc.sendDailySummary(req.body?.date || svc.today(), { withEvaluation: req.body?.withEvaluation !== false });
    res.json({ success: true, chatId: r.chatId });
  }));

  // --------------------------------------------------------------- export

  router.get('/export.csv', wrap((req, res) => {
    const to = req.query.to || svc.today();
    const from = req.query.from || to.slice(0, 8) + '01';
    const r = svc.range(from, to);
    const rows = [['tanggal', 'jam_kerja', 'menit_kerja', 'menit_istirahat', 'target_menit', 'tugas_selesai', 'tugas_total', 'pemasukan', 'pengeluaran', 'bersih', 'commit', 'file_diubah', 'produktivitas', 'keseimbangan', 'laporan']];
    for (const d of r.days) {
      rows.push([
        d.date, formatMinutes(d.workedMin), d.workedMin, d.breakMin, d.targetMin, d.tasks.done, d.tasks.total,
        d.money.income, d.money.expense, d.money.net, d.activity.commits, d.activity.filesChanged,
        d.productivity, d.balance?.score ?? '', svc.store.reports.get(d.date)?.text || '',
      ]);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="jurnal-kerja-${from}_${to}.csv"`);
    res.send(`﻿${rows.map((r2) => r2.map(csvCell).join(',')).join('\r\n')}`);
  }));

  return router;
}
