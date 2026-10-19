/**
 * src/automation/channels/whatsapp.js
 *
 * WhatsApp Business **Cloud API** (official, by Meta).
 *
 * Deliberately NOT built on unofficial libraries that drive a personal account
 * through WhatsApp Web: that violates WhatsApp's terms and gets numbers banned.
 *
 * Environment
 *   WHATSAPP_TOKEN              permanent system-user access token
 *   WHATSAPP_PHONE_NUMBER_ID    the sending number's id (Meta dashboard)
 *   WHATSAPP_TEMPLATE_NAME      approved template (body has ONE variable {{1}});
 *                               required to start conversations (outside 24h window)
 *   WHATSAPP_TEMPLATE_LANG      default "id"
 *   WHATSAPP_API_VERSION        default v21.0     WHATSAPP_API_BASE  override (tests)
 *   WHATSAPP_DAILY_CAP          default 250 (Meta starter tier)
 *   WHATSAPP_THROTTLE_MS        default 800       WHATSAPP_MAX_RECIPIENTS default 1000
 *   WHATSAPP_DRY_RUN=true       forces simulation
 *
 * Two sending modes:
 *   - template mode (WHATSAPP_TEMPLATE_NAME set): works for ANY opted-in number.
 *     The rendered message is sent as the template's single variable.
 *   - text mode: free-form text (+ documents), but Meta only delivers it inside
 *     the 24h customer-service window opened by the customer's own message.
 *
 * Inbox replies (whatsapp-inbox.js) pass `freeform: true`: the owner just
 * messaged us, so the 24h window is open and the text mode always applies —
 * even when a template is configured for campaigns.
 *
 * Inbound configuration (used by the webhook + inbox, surfaced in describe()):
 *   WHATSAPP_VERIFY_TOKEN  must match the Meta dashboard "Verify token"
 *   WHATSAPP_APP_SECRET    Meta App Secret — verifies X-Hub-Signature-256
 *
 * @author Wisnu Alfian Nur Ashar
 */

import fs from 'node:fs';
import { normalizePhone } from '../recipients.js';
import {
  MailError, ErrorKind, chunkText, httpRequest, classifyHttp, missingList, intEnv, boolEnv, dryId,
} from './base.js';

const TEXT_LIMIT = 4096;
const TEMPLATE_PARAM_LIMIT = 1024;

/** Template parameters may not contain newlines, tabs or 4+ consecutive spaces. */
export function sanitizeTemplateParam(text) {
  return String(text || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {4,}/g, '   ')
    .trim()
    .slice(0, TEMPLATE_PARAM_LIMIT);
}

/** Maps a Cloud API error body onto the engine's error vocabulary. */
export function classifyWhatsApp(status, json, headers) {
  const err = json?.error;
  if (!err) return classifyHttp(status, '', headers);
  const code = Number(err.code);
  const detail = err.error_data?.details || err.message || `error ${code}`;

  if (code === 190 || status === 401) {
    return new MailError('Token WhatsApp ditolak/kedaluwarsa — perbarui WHATSAPP_TOKEN.', ErrorKind.AUTH, { responseCode: status, code: String(code) });
  }
  if (code === 131047) {
    return new MailError(
      'Lewat 24 jam sejak pesan terakhir pelanggan: WhatsApp mewajibkan template. Isi WHATSAPP_TEMPLATE_NAME dengan template yang disetujui.',
      ErrorKind.PERMANENT, { responseCode: status, code: '131047' }
    );
  }
  if (code === 131026) {
    return new MailError('Nomor tidak terdaftar di WhatsApp atau tidak dapat dikirimi pesan.', ErrorKind.PERMANENT, { responseCode: status, code: '131026', hardBounce: true });
  }
  if (code === 131030) {
    return new MailError('Nomor tidak ada di daftar penerima uji (akun masih mode sandbox).', ErrorKind.PERMANENT, { responseCode: status, code: '131030' });
  }
  if (code === 131056) {
    return new MailError('Terlalu banyak pesan ke nomor yang sama, coba lagi sebentar.', ErrorKind.TRANSIENT, { responseCode: status, code: '131056', retryAfterMs: 30_000 });
  }
  if ([131048, 130429, 80007, 4, 17, 613].includes(code)) {
    return new MailError(`Batas pengiriman WhatsApp tercapai: ${detail}`, ErrorKind.QUOTA, { responseCode: status, code: String(code) });
  }
  // 132xxx = template problems (missing / not approved / parameter mismatch)
  if (code >= 132000 && code < 133000) {
    return new MailError(`Template WhatsApp bermasalah: ${detail}`, ErrorKind.CONFIG, { responseCode: status, code: String(code) });
  }
  if (status >= 500) return new MailError(`Server WhatsApp bermasalah: ${detail}`, ErrorKind.TRANSIENT, { responseCode: status });
  return new MailError(String(detail).slice(0, 220), ErrorKind.PERMANENT, { responseCode: status, code: String(code) });
}

export function createWhatsAppChannel(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const token = (env.WHATSAPP_TOKEN || '').trim();
  const phoneId = (env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const version = (env.WHATSAPP_API_VERSION || 'v21.0').trim();
  const base = (env.WHATSAPP_API_BASE || 'https://graph.facebook.com').replace(/\/+$/, '');
  const templateName = (env.WHATSAPP_TEMPLATE_NAME || '').trim();
  const templateLang = (env.WHATSAPP_TEMPLATE_LANG || 'id').trim();
  const configured = Boolean(token && /^\d{5,}$/.test(phoneId));
  const forceDry = boolEnv(env, 'WHATSAPP_DRY_RUN');
  const verifyToken = (env.WHATSAPP_VERIFY_TOKEN || '').trim();
  const appSecret = (env.WHATSAPP_APP_SECRET || '').trim();
  const kirimSecret = (env.KIRIMDEV_WEBHOOK_SECRET || '').trim();

  const limits = {
    dailyCap: intEnv(env, 'WHATSAPP_DAILY_CAP', 250, { min: 1 }),
    throttleMs: intEnv(env, 'WHATSAPP_THROTTLE_MS', 800),
    maxRecipients: intEnv(env, 'WHATSAPP_MAX_RECIPIENTS', 1000, { min: 1 }),
    maxAttempts: intEnv(env, 'EMAIL_MAX_ATTEMPTS', 3, { min: 1 }),
  };

  const url = (path) => `${base}/${version}/${phoneId}/${path}`;
  const authHeaders = { Authorization: `Bearer ${token}` };
  // Meta answers { messages: [{ id }] }; Kirimdev wraps the same data as
  // { data: { id } }. Accept both so a real send is never recorded without id.
  const providerMessageId = (res) => res?.messages?.[0]?.id || res?.data?.id || res?.id || null;
  // Media ids stay valid for ~30 days: upload each file once per process, not
  // once per recipient.
  const mediaCache = new Map();

  async function post(path, payload) {
    const r = await httpRequest(fetchImpl, url(path), {
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok || r.json?.error) throw classifyWhatsApp(r.status, r.json, r.headers);
    return r.json;
  }

  async function uploadMedia(att) {
    const stat = fs.statSync(att.path);
    const key = `${att.path}:${stat.size}:${stat.mtimeMs}`;
    if (mediaCache.has(key)) return mediaCache.get(key);

    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append('type', att.contentType || 'application/octet-stream');
    fd.append('file', new Blob([fs.readFileSync(att.path)], { type: att.contentType || 'application/octet-stream' }), att.filename);
    const r = await httpRequest(fetchImpl, url('media'), { headers: authHeaders, body: fd, timeoutMs: 60_000 });
    if (!r.ok || r.json?.error || !r.json?.id) throw classifyWhatsApp(r.status, r.json, r.headers);
    mediaCache.set(key, r.json.id);
    return r.json.id;
  }

  const adapter = {
    id: 'whatsapp',
    label: 'WhatsApp Business',
    recipientKind: 'phone',
    limits,
    supportsSubscribers: false,

    get capabilities() {
      return {
        subject: 'optional', html: false,
        // Documents need a free-form message, which template mode cannot carry.
        attachments: !templateName,
        maxTextLength: templateName ? TEMPLATE_PARAM_LIMIT : TEXT_LIMIT,
        subscribers: false, fixedDestination: false,
      };
    },

    get configured() { return configured; },
    get mode() { return configured && !forceDry ? 'live' : 'dry-run'; },

    describe() {
      const isKirim = /kirimdev\.com/i.test(base);
      return {
        id: 'whatsapp', label: adapter.label, mode: adapter.mode, configured,
        provider: isKirim ? 'kirimdev' : 'meta',
        forceDryRun: forceDry, limits, capabilities: adapter.capabilities, recipientKind: 'phone',
        hasSecret: Boolean(token),
        sendMode: templateName ? `template: ${templateName} (${templateLang})` : 'teks bebas (hanya dalam 24 jam setelah pelanggan membalas)',
        // Inbound side: what the webhook (/webhook/whatsapp) needs to be alive.
        inbound: {
          // Meta direct needs the verify token + app secret; Kirimdev only its signing secret.
          ready: Boolean(configured && ((verifyToken && appSecret) || kirimSecret)),
          missing: kirimSecret ? [] : missingList([['WHATSAPP_VERIFY_TOKEN', Boolean(verifyToken)], ['WHATSAPP_APP_SECRET', Boolean(appSecret)]]),
        },
        missing: missingList([['WHATSAPP_TOKEN', Boolean(token)], ['WHATSAPP_PHONE_NUMBER_ID', /^\d{5,}$/.test(phoneId)]]),
        fix: isKirim
          ? 'Hubungkan nomor WhatsApp di app.kirimdev.com, lalu isi WHATSAPP_PHONE_NUMBER_ID dari GET /v1/accounts. Teks bebas hanya berlaku 24 jam setelah kontak membalas; di luar itu wajib template disetujui.'
          : 'Isi WHATSAPP_PHONE_NUMBER_ID dari dashboard Meta (WhatsApp → API Setup). Teks bebas hanya berlaku 24 jam setelah kontak membalas; di luar itu wajib template disetujui.',
        hint: isKirim
          ? 'Penyedia: Kirimdev (kompatibel Cloud API). Untuk pesan MASUK, isi KIRIMDEV_WEBHOOK_SECRET.'
          : 'Memakai WhatsApp Business Cloud API resmi (Meta). Untuk mengirim ke pelanggan baru wajib template yang disetujui dan persetujuan (opt-in) pelanggan. Untuk pesan MASUK, daftarkan https://domain-anda/webhook/whatsapp di dashboard Meta (isi WHATSAPP_VERIFY_TOKEN & WHATSAPP_APP_SECRET).',
      };
    },

    normalizeAddress: (v) => normalizePhone(v),

    async verify() {
      if (adapter.mode !== 'live') return { ok: false, mode: 'dry-run', error: 'WhatsApp belum dikonfigurasi (mode simulasi)' };
      try {
        const r = await httpRequest(fetchImpl, `${base}/${version}/${phoneId}?fields=display_phone_number,verified_name,quality_rating`, {
          method: 'GET', headers: authHeaders,
        });
        if (!r.ok || r.json?.error) throw classifyWhatsApp(r.status, r.json, r.headers);
        return { ok: true, mode: 'live', detail: `${r.json.display_phone_number || ''} ${r.json.verified_name || ''} (kualitas: ${r.json.quality_rating || '?'})`.trim() };
      } catch (e) {
        return { ok: false, mode: 'live', kind: e.kind, error: e.message };
      }
    },

    /**
     * @param {{to:string, subject?:string, text?:string, attachments?:Array,
     *          mode?:string, freeform?:boolean}} msg
     *   freeform: force free-form text mode even when a template is configured
     *   (only valid inside the 24h window — used by the inbox to answer the
     *   owner, who opened the window by messaging first).
     */
    async send({ to, subject, text, attachments, mode, freeform = false }) {
      const phone = normalizePhone(to);
      if (!phone) throw new MailError(`Nomor WhatsApp tidak valid: ${String(to).slice(0, 40)}`, ErrorKind.INVALID);
      const subj = String(subject || '').replace(/\s+/g, ' ').trim().slice(0, 150);
      const body = String(text || '').trim();
      if (!subj && !body) throw new MailError('Isi pesan kosong', ErrorKind.INVALID);

      const useMode = mode || adapter.mode;
      const hasFiles = Boolean(attachments && attachments.length);
      if (templateName && !freeform && hasFiles) {
        throw new MailError('Lampiran tidak didukung pada mode template WhatsApp.', ErrorKind.INVALID);
      }

      if (templateName && !freeform) {
        const param = sanitizeTemplateParam(subj ? `${subj} - ${body}` : body);
        if (useMode !== 'live') return { messageId: dryId('wa'), accepted: [phone], dryRun: true, mode: 'template' };
        const res = await post('messages', {
          messaging_product: 'whatsapp',
          to: phone,
          type: 'template',
          template: {
            name: templateName,
            language: { code: templateLang },
            components: [{ type: 'body', parameters: [{ type: 'text', text: param }] }],
          },
        });
        return { messageId: providerMessageId(res), accepted: [phone], dryRun: false, mode: 'template' };
      }

      const composed = subj ? `*${subj}*\n\n${body}` : body;
      const parts = chunkText(composed, TEXT_LIMIT);
      if (useMode !== 'live') return { messageId: dryId('wa'), accepted: [phone], dryRun: true, mode: 'text', parts: parts.length };

      let firstId = null;
      for (const part of parts) {
        const res = await post('messages', {
          messaging_product: 'whatsapp', recipient_type: 'individual', to: phone,
          type: 'text', text: { preview_url: false, body: part },
        });
        if (firstId == null) firstId = providerMessageId(res);
      }
      for (const att of attachments || []) {
        const mediaId = await uploadMedia(att);
        await post('messages', {
          messaging_product: 'whatsapp', recipient_type: 'individual', to: phone,
          type: 'document', document: { id: mediaId, filename: att.filename },
        });
      }
      return { messageId: firstId, accepted: [phone], dryRun: false, mode: 'text', parts: parts.length };
    },

    /** Marks an inbound message as read (best effort). Also clears the phone's unread badge. */
    async markRead(messageId) {
      if (!messageId || adapter.mode !== 'live') return { ok: false };
      try {
        await post('messages', { messaging_product: 'whatsapp', status: 'read', message_id: String(messageId) });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },

    close() { mediaCache.clear(); },
  };

  return adapter;
}
