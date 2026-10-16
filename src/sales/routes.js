/**
 * src/sales/routes.js
 *
 *  Owner API  (/api/sales, operator guard)
 *    GET  /summary                 counters + whether the agent may quote prices yet
 *    GET  /leads                   ?status= &open=1 &q= &limit= &offset=
 *    GET  /leads/:id               the lead and its conversation
 *    POST /leads/:id/status        { status, notes?, value? }
 *    POST /leads/:id/reply         { text }  the owner's own answer (sent on the lead's channel if it can send)
 *    GET  /catalog                 services, prices, terms
 *    PUT  /catalog/:id             edit a service (a changed price must be approved again)
 *    POST /catalog/approve         { ids?, terms? }  the owner's "yes" to quoted prices
 *
 *  Public inquiry intake  (/webhook/inquiry): called by the owner's website (server to server), signed.
 *    POST /   { name?, contact, message, website? }  -> { ok, reply, escalate }
 *    X-Wanar-Signature: t=<unix>,v1=<hmac-sha256 of "<t>.<raw body>" with SALES_INTAKE_SECRET>
 *    `website` is a honeypot: real visitors never fill it.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import express from 'express';
import { createAccessGuard } from '../automation/routes.js';
import { verifyKirimSignature } from '../automation/whatsapp-inbox.js';
import { LEAD_STATUSES } from './store.js';

export function createSalesRouter({ sales, env = process.env }) {
  const router = express.Router();
  router.use(createAccessGuard(env));
  router.use(express.json({ limit: '20kb' }));

  router.get('/summary', (_req, res) => {
    const cat = sales.catalog();
    res.json({
      stats: sales.store.stats(), autoReply: sales.autoReply,
      catalog: { services: cat.services.length, pricesApproved: cat.services.filter((s) => s.price.approved).length, termsApproved: Boolean(cat.terms.approved) },
    });
  });

  router.get('/leads', (req, res) => {
    const { status, open, q, limit, offset } = req.query;
    if (status && !LEAD_STATUSES.includes(String(status))) return res.status(400).json({ error: 'status tidak valid' });
    res.json(sales.store.listLeads({ status: status ? String(status) : null, open: open === '1' || open === 'true', q: q ? String(q).slice(0, 80) : '', limit, offset }));
  });

  router.get('/leads/:id', (req, res) => {
    const lead = sales.store.getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'prospek tidak ditemukan' });
    res.json({ lead, messages: sales.store.messages(lead.id) });
  });

  router.post('/leads/:id/status', (req, res) => {
    const { status, notes, value } = req.body || {};
    if (!LEAD_STATUSES.includes(status)) return res.status(400).json({ error: `status harus salah satu dari: ${LEAD_STATUSES.join(', ')}` });
    try { res.json({ ok: true, lead: sales.setStatus(req.params.id, status, { notes, value }) }); } catch (e) { res.status(404).json({ error: e.message }); }
  });

  router.post('/leads/:id/reply', async (req, res) => {
    try { res.json({ ok: true, ...(await sales.ownerReply(req.params.id, req.body?.text)) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.get('/catalog', (_req, res) => {
    const { services, terms } = sales.catalog();
    res.json({ services: services.map(({ match, ...s }) => s), terms });
  });

  router.put('/catalog/:id', (req, res) => {
    try { const { match, ...s } = sales.updateService(req.params.id, req.body || {}); res.json({ ok: true, service: s }); } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post('/catalog/approve', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
    res.json({ ok: true, ...sales.approvePrices({ ids, terms: req.body?.terms === true }) });
  });

  return router;
}

const IP_WINDOW_MS = 3_600_000;
const IP_MAX = 12;

export function createInquiryRouter({ sales, env = process.env, now = Date.now }) {
  const router = express.Router();
  router.use(express.raw({ type: () => true, limit: '20kb' }));
  const hits = new Map(); // ip -> [timestamps]

  router.post('/', async (req, res) => {
    const secrets = String(env.SALES_INTAKE_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!secrets.length) return res.status(503).json({ ok: false, error: 'belum dikonfigurasi' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    if (!verifyKirimSignature(raw, req.get('x-wanar-signature'), secrets)) return res.status(401).json({ ok: false, error: 'tanda tangan tidak valid' });

    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    const t = now();
    const recent = (hits.get(ip) || []).filter((x) => t - x < IP_WINDOW_MS);
    if (recent.length >= IP_MAX) return res.status(429).json({ ok: false, error: 'terlalu banyak permintaan' });
    recent.push(t); hits.set(ip, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < IP_WINDOW_MS)) hits.delete(k);

    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ ok: false, error: 'JSON tidak valid' }); }
    if (body?.website) return res.json({ ok: true, reply: null, escalate: false }); // honeypot: pretend all is well
    const message = String(body?.message || '').trim();
    const contact = String(body?.contact || '').trim();
    if (message.length < 5 || !contact) return res.status(400).json({ ok: false, error: 'pesan dan kontak wajib diisi' });

    try {
      const r = await sales.intake({ source: 'site', contact, name: String(body?.name || '').slice(0, 80), text: message });
      return res.json({ ok: true, reply: r.reply, escalate: r.escalate });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'gagal memproses' });
    }
  });

  return router;
}
