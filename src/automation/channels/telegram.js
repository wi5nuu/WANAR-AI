/**
 * src/automation/channels/telegram.js
 *
 * Telegram Bot API channel (official, free).
 *
 * Environment
 *   TELEGRAM_BOT_TOKEN     token from @BotFather
 *   TELEGRAM_API_BASE      override (self-hosted Bot API / tests)
 *   TELEGRAM_DAILY_CAP     default 5000        TELEGRAM_THROTTLE_MS  default 60
 *   TELEGRAM_MAX_RECIPIENTS default 5000       TELEGRAM_DRY_RUN=true forces simulation
 *
 * Telegram's rule: a bot can only message people who started it (or groups it
 * was added to). Recipients are chat ids; the inbox (telegram-inbox.js)
 * collects them when people send /start, which is the opt-in.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import fs from 'node:fs';
import { normalizeChatId } from '../recipients.js';
import {
  MailError, ErrorKind, chunkText, httpRequest, classifyHttp, missingList, intEnv, boolEnv, dryId,
} from './base.js';

const TEXT_LIMIT = 4096;
const CHUNK = 3600; // leaves headroom for HTML escaping growth

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Maps a Telegram failure onto the engine's error vocabulary. */
export function classifyTelegram(status, json, headers) {
  const desc = String(json?.description || '');
  const lower = desc.toLowerCase();
  const code = Number(json?.error_code) || status;

  if (code === 401 || (code === 404 && /not found|unauthorized/i.test(desc))) {
    return new MailError('Token bot Telegram ditolak — periksa TELEGRAM_BOT_TOKEN.', ErrorKind.AUTH, { responseCode: code });
  }
  if (code === 403) {
    // blocked / kicked / deactivated / never pressed Start
    return new MailError(
      `Penerima tidak dapat dikirimi: ${desc || 'bot diblokir atau belum /start'}`,
      ErrorKind.PERMANENT,
      { responseCode: 403, hardBounce: true }
    );
  }
  if (code === 400 && /chat not found|user not found|peer_id_invalid|chat_id is empty/.test(lower)) {
    return new MailError(`Chat tidak ditemukan: ${desc}`, ErrorKind.PERMANENT, { responseCode: 400, hardBounce: true });
  }
  if (code === 400 && /can't parse entities|message is too long|message text is empty/.test(lower)) {
    return new MailError(`Pesan ditolak Telegram: ${desc}`, ErrorKind.INVALID, { responseCode: 400 });
  }
  if (code === 429) {
    const wait = Number(json?.parameters?.retry_after) || 5;
    // Short flood-control: wait and retry. Very long: treat as a quota stop.
    if (wait > 120) {
      return new MailError(`Telegram membatasi pengiriman selama ${wait} detik`, ErrorKind.QUOTA, { responseCode: 429 });
    }
    return new MailError(`Telegram flood control, tunggu ${wait} detik`, ErrorKind.TRANSIENT, { responseCode: 429, retryAfterMs: wait * 1000 });
  }
  return classifyHttp(status, desc || `HTTP ${status}`, headers);
}

export function createTelegramChannel(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const base = (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const tokenLooksValid = /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token);
  const forceDry = boolEnv(env, 'TELEGRAM_DRY_RUN');

  const limits = {
    dailyCap: intEnv(env, 'TELEGRAM_DAILY_CAP', 5000, { min: 1 }),
    throttleMs: intEnv(env, 'TELEGRAM_THROTTLE_MS', 60),
    maxRecipients: intEnv(env, 'TELEGRAM_MAX_RECIPIENTS', 5000, { min: 1 }),
    maxAttempts: intEnv(env, 'EMAIL_MAX_ATTEMPTS', 3, { min: 1 }),
  };

  const api = (method) => `${base}/bot${token}/${method}`;

  async function call(method, payload) {
    const r = await httpRequest(fetchImpl, api(method), {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok || !r.json?.ok) throw classifyTelegram(r.status, r.json, r.headers);
    return r.json.result;
  }

  async function sendDocument(chatId, att, caption) {
    const fd = new FormData();
    fd.append('chat_id', chatId);
    if (caption) fd.append('caption', caption.slice(0, 1000));
    fd.append('document', new Blob([fs.readFileSync(att.path)], { type: att.contentType || 'application/octet-stream' }), att.filename);
    const r = await httpRequest(fetchImpl, api('sendDocument'), { body: fd, timeoutMs: 60_000 });
    if (!r.ok || !r.json?.ok) throw classifyTelegram(r.status, r.json, r.headers);
    return r.json.result;
  }

  const adapter = {
    id: 'telegram',
    label: 'Telegram Bot',
    recipientKind: 'chat_id',
    capabilities: { subject: 'optional', html: false, attachments: true, maxTextLength: TEXT_LIMIT, subscribers: true, fixedDestination: false },
    limits,
    supportsSubscribers: true,

    get configured() { return tokenLooksValid; },
    get mode() { return tokenLooksValid && !forceDry ? 'live' : 'dry-run'; },

    describe() {
      return {
        id: 'telegram', label: adapter.label, mode: adapter.mode, configured: adapter.configured,
        forceDryRun: forceDry, limits, capabilities: adapter.capabilities, recipientKind: 'chat_id',
        hasSecret: Boolean(token),
        missing: missingList([['TELEGRAM_BOT_TOKEN', tokenLooksValid]]),
        hint: 'Buat bot lewat @BotFather, salin token ke TELEGRAM_BOT_TOKEN. Pelanggan menekan /start pada bot agar bisa dikirimi pesan.',
      };
    },

    normalizeAddress: normalizeChatId,

    async verify() {
      if (adapter.mode !== 'live') return { ok: false, mode: 'dry-run', error: 'Token bot belum dikonfigurasi (mode simulasi)' };
      try {
        const me = await call('getMe', {});
        return { ok: true, mode: 'live', detail: `@${me.username}` };
      } catch (e) {
        return { ok: false, mode: 'live', kind: e.kind, error: e.message };
      }
    },

    /**
     * @param {{to:string, subject?:string, text?:string, attachments?:Array, mode?:string}} msg
     */
    async send({ to, subject, text, attachments, mode }) {
      const chatId = normalizeChatId(to);
      if (!chatId) throw new MailError(`Chat ID tidak valid: ${String(to).slice(0, 40)}`, ErrorKind.INVALID);
      const subj = String(subject || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const body = String(text || '').trim();
      if (!subj && !body) throw new MailError('Isi pesan kosong', ErrorKind.INVALID);

      const plain = subj ? `${subj}\n\n${body}` : body;
      const parts = chunkText(plain, CHUNK).map((chunk, i) => {
        if (i === 0 && subj) return `<b>${escapeHtml(subj)}</b>${escapeHtml(chunk.slice(subj.length))}`;
        return escapeHtml(chunk);
      });

      const useMode = mode || adapter.mode;
      if (useMode !== 'live') return { messageId: dryId('tg'), accepted: [chatId], dryRun: true, parts: parts.length };

      let firstId = null;
      for (const html of parts) {
        const res = await call('sendMessage', {
          chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
        });
        if (firstId == null) firstId = res.message_id;
      }
      for (const att of attachments || []) await sendDocument(chatId, att);
      return { messageId: String(firstId), accepted: [chatId], dryRun: false, parts: parts.length };
    },

    /** Used by the inbox to reply to /start, /stop etc. */
    async reply(chatId, html) {
      return call('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
    },

    /** Long-poll for inbound updates (inbox). */
    async getUpdates(offset, timeoutSec = 25) {
      const r = await httpRequest(fetchImpl, api('getUpdates'), {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset, timeout: timeoutSec, allowed_updates: ['message', 'my_chat_member'] }),
        timeoutMs: (timeoutSec + 10) * 1000,
      });
      if (!r.ok || !r.json?.ok) throw classifyTelegram(r.status, r.json, r.headers);
      return r.json.result;
    },

    close() {},
  };

  return adapter;
}
