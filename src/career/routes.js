/**
 * src/career/routes.js
 *
 *   GET  /status              radar state + counters
 *   GET  /report              the daily report text + the numbers behind it
 *   GET  /jobs                postings (?verdict=apply|maybe|skip &status= &q= &minScore= &limit= &offset=)
 *   GET  /jobs/:id            one posting with its description
 *   GET  /jobs/:id/kit        application kit: cover letter, standard answers, what only the owner can answer
 *   GET  /cv                  the owner's CV (PDF), when uploaded
 *   POST /jobs/:id/status     { status, notes? }  move a posting through the pipeline
 *   POST /scan                start a sweep now (returns at once; progress shows in the activity feed)
 *   GET  /activity            what the agent has been doing (?afterId= &agent= &level= &limit=)
 *
 * Access: the operator guard shared with the Command Center (direct localhost, or X-Automation-Token),
 * on top of the nginx basic-auth that fronts the whole site.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createAccessGuard } from '../automation/routes.js';
import { STATUSES } from './store.js';

export function createCareerRouter({ career, env = process.env }) {
  const router = express.Router();
  // Same operator guard as the Command Center: localhost, or the AUTOMATION_TOKEN header.
  router.use(createAccessGuard(env));
  router.use(express.json({ limit: '20kb' }));

  router.get('/status', (_req, res) => res.json(career.status()));

  // The same text the owner receives at 19.00 WIB, built from live data (read-only).
  router.get('/report', (_req, res) => res.json(career.reportText()));

  router.get('/jobs', (req, res) => {
    const { verdict, status, q, minScore, limit, offset } = req.query;
    if (verdict && !['apply', 'maybe', 'skip'].includes(String(verdict))) return res.status(400).json({ error: 'verdict tidak valid' });
    if (status && !STATUSES.includes(String(status))) return res.status(400).json({ error: 'status tidak valid' });
    res.json(career.store.listJobs({
      verdict: verdict ? String(verdict) : null, status: status ? String(status) : null,
      q: q ? String(q).slice(0, 80) : '', minScore: Number(minScore) || 0, limit, offset,
    }));
  });

  router.get('/jobs/:id', (req, res) => {
    const job = career.store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'lowongan tidak ditemukan' });
    res.json(job);
  });

  // Everything needed to apply by hand in two minutes: cover letter, standard answers, what only the owner can answer.
  router.get('/jobs/:id/kit', (req, res) => {
    const kit = career.kit(req.params.id);
    if (!kit.ok) return res.status(kit.error?.startsWith('Lowongan') ? 404 : 409).json({ error: kit.error });
    res.json(kit);
  });

  router.get('/cv', (_req, res) => {
    const file = career.cvPath();
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'CV belum diunggah ke server.' });
    res.download(file, path.basename(file));
  });

  router.post('/jobs/:id/status', (req, res) => {
    const { status, notes } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `status harus salah satu dari: ${STATUSES.join(', ')}` });
    const job = career.store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'lowongan tidak ditemukan' });
    career.store.setStatus(job.id, status, notes ? String(notes).slice(0, 500) : null);
    const level = ['interview', 'offer'].includes(status) ? 'good' : (status === 'rejected' ? 'warn' : 'info');
    career.store.log({ agent: 'career', kind: 'status', level, title: `${job.company || 'Lowongan'}: ${job.title} -> ${status}`, ref: String(job.id) });
    res.json({ ok: true, job: career.store.getJob(job.id) });
  });

  router.post('/scan', (req, res) => {
    if (career.running) return res.status(202).json({ started: false, message: 'Pemindaian sedang berjalan.' });
    const only = Array.isArray(req.body?.only) ? req.body.only.map(String).slice(0, 20) : null;
    career.scan({ only }).catch(() => {});
    res.status(202).json({ started: true });
  });

  router.get('/activity', (req, res) => {
    const { afterId, agent, level, limit } = req.query;
    res.json({ items: career.store.activity({ afterId, agent: agent ? String(agent) : null, level: level ? String(level) : null, limit }) });
  });

  return router;
}
