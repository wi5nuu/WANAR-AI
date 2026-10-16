/**
 * src/automation/whatsapp-webhook.js
 *
 * Public HTTP surface for WhatsApp Cloud API webhooks, mounted by the server at
 *
 *   GET  /webhook/whatsapp   Meta's verification handshake (hub.challenge)
 *   POST /webhook/whatsapp   inbound messages + delivery statuses
 *
 * Security
 *   - The POST is authenticated by Meta's signature: X-Hub-Signature-256 is an
 *     HMAC-SHA256 of the *exact* request bytes keyed with WHATSAPP_APP_SECRET.
 *     That is why this router uses express.raw() and must be mounted BEFORE the
 *     app-wide express.json(): once the JSON parser has consumed the body, the
 *     original bytes (and so the signature) are gone.
 *   - No WHATSAPP_APP_SECRET configured -> the endpoint refuses everything.
 *   - Non-200 responses make Meta retry; we ack 200 as soon as the payload has
 *     been parsed and dispatched (AI replies continue in the background).
 *
 * @author Wisnu Alfian Nur Ashar
 */

import express from 'express';
import { verifyWebhookSignature } from './whatsapp-inbox.js';

const MAX_BODY = '1mb'; // messages and statuses are tiny; signatures cover the bytes

/**
 * @param {{inbox: object, env?: object, log?: object}} deps
 */
export function createWhatsAppWebhookRouter({ inbox, env = process.env, log = console }) {
  const router = express.Router();
  const logger = {
    warn: (...a) => { try { log.warn?.(...a); } catch { /* never break the route */ } },
    error: (...a) => { try { log.error?.(...a); } catch { /* never break the route */ } },
  };

  // Raw bytes for every method/content-type: the signature is over the body.
  router.use(express.raw({ type: () => true, limit: MAX_BODY }));

  // ------------------------------------------------- handshake (Meta GET)
  router.get('/', (req, res) => {
    const challenge = inbox?.verifyChallenge?.(req.query || {});
    if (!challenge) {
      logger.warn('[WHATSAPP-WEBHOOK] verifikasi GET gagal — periksa WHATSAPP_VERIFY_TOKEN');
      return res.status(403).type('text/plain').send('forbidden');
    }
    res.set('Cache-Control', 'no-store');
    return res.status(200).type('text/plain').send(challenge);
  });

  // ------------------------------------------------- inbound (Meta POST)
  router.post('/', async (req, res) => {
    const secret = inbox?.appSecret || env.WHATSAPP_APP_SECRET || '';
    if (!secret && !inbox?.hasWebhookSecret) {
      logger.warn('[WHATSAPP-WEBHOOK] WHATSAPP_APP_SECRET / KIRIMDEV_WEBHOOK_SECRET belum diisi — payload ditolak.');
      return res.status(503).type('text/plain').send('webhook not configured');
    }

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    // Kirimdev (X-Kirim-Signature) or Meta direct (X-Hub-Signature-256): one must verify.
    const via = inbox?.verifyRequest
      ? inbox.verifyRequest(raw, req)
      : (verifyWebhookSignature(raw, req.get('x-hub-signature-256'), secret) ? 'meta' : null);
    const viaEnv = !via && !inbox?.appSecret && secret
      && verifyWebhookSignature(raw, req.get('x-hub-signature-256'), secret);
    if (!via && !viaEnv) {
      logger.warn('[WHATSAPP-WEBHOOK] tanda tangan webhook tidak valid — payload diabaikan.');
      return res.status(401).type('text/plain').send('invalid signature');
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).type('text/plain').send('bad json');
    }

    try {
      // Dispatch (dedup + enqueue AI replies) before acking; the replies
      // themselves continue in the background so Meta is never kept waiting.
      await inbox.handleWebhook(payload);
    } catch (e) {
      logger.error('[WHATSAPP-WEBHOOK] handler error:', e?.message || e);
    }
    return res.status(200).type('text/plain').send('EVENT_RECEIVED');
  });

  return router;
}
