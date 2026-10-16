/**
 * src/automation/whatsapp-inbox.js
 *
 * Receives WhatsApp Cloud API webhooks — the counterpart of telegram-inbox.js.
 * Telegram is poll-based; WhatsApp *pushes* (Meta calls our /webhook/whatsapp).
 *
 * Three jobs:
 *
 *  1. The owner's plain messages are answered by the AI. Only numbers listed in
 *     WHATSAPP_AI_CHAT_IDS reach the responder — anyone else is ignored. The
 *     owner opened the 24h customer-service window by messaging first, so
 *     replies go out as free-form text (no approved template needed).
 *
 *  2. Opt-in / opt-out, as Meta's business-messaging policy requires:
 *       START [kode] / DAFTAR / SUBSCRIBE   subscribe this number
 *       STOP / BERHENTI / UNSUBSCRIBE       unsubscribe + permanent suppression
 *     The suppression list is what campaigns consult before sending.
 *
 *  3. Delivery statuses (sent/delivered/read/failed) are re-emitted for the
 *     realtime dashboard; duplicate deliveries (Meta retries) are dropped via
 *     the inbound_messages table, so a message is never answered twice.
 *
 *  4. Contact memory: every messenger is recorded once in the `people` table
 *     (profile name, message count, last-seen, last text preview) so the
 *     owner's AI can answer questions like "siapa yang chat tadi?".
 *
 * Configuration
 *   WHATSAPP_VERIFY_TOKEN      must match the Meta dashboard "Verify token"
 *   WHATSAPP_APP_SECRET        Meta App Secret — verifies X-Hub-Signature-256
 *   WHATSAPP_AI_CHAT_IDS       62812..., 62813... (empty = AI chat OFF)
 *   WHATSAPP_ALLOWED_NUMBERS   optional allowlist for START (public numbers)
 *   WHATSAPP_JOIN_CODE         optional: "START KODE" required to subscribe
 *   WHATSAPP_OPEN_SUBSCRIPTION true = anyone may START (default: owner-only
 *                              when AI chats are configured and no allowlist)
 *   WHATSAPP_WELCOME           welcome text after START; {nama} substituted
 *
 * The webhook endpoint (whatsapp-webhook.js) refuses any payload whose
 * signature does not verify, so this inbox only ever sees genuine Meta traffic.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { normalizePhone } from './recipients.js';
import { suppressionKey } from './store.js';
import { chunkText } from './channels/base.js';
import { withTrace, traceStep } from '../observability/trace-hub.js';

const HISTORY_TURNS = 12;           // messages remembered per number
const HISTORY_TTL_MS = 60 * 60_000; // forgotten after an hour of silence
const CHAT_RATE_WINDOW_MS = 10 * 60_000;
const CHAT_RATE_MAX = 20;           // AI replies per number per window
const MAX_TEXT = 4000;
const REPLY_CHUNK = 3500;           // WhatsApp's hard limit is 4096

/** Exact commands only: "stop itu apa ya" is a question; "stop" is an opt-out. */
const STOP_RE = /^\s*(?:stop|stop all|berhenti|unsubscribe|berhenti berlangganan)\s*$/i;
const HELP_RE = /^\s*(?:help|bantuan|menu)\s*$/i;

/** Timing-safe string comparison (signatures, tokens). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Verifies Meta's `X-Hub-Signature-256: sha256=<hex>` header against the raw
 * request body. Pure and exported so tests can exercise it directly.
 */
export function verifyWebhookSignature(rawBody, header, secret) {
  const sec = String(secret || '');
  const sig = String(header || '').trim();
  if (!sec || !sig.startsWith('sha256=')) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const want = crypto.createHmac('sha256', sec).update(body).digest('hex');
  return safeEqual(sig.slice(7), want);
}

/**
 * Verifies a Kirimdev webhook: `X-Kirim-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`,
 * HMAC-SHA256 over "<t>.<raw body>". Any active secret may match (rotation), and
 * stale timestamps are rejected (replay protection, default 5 minutes).
 */
export function verifyKirimSignature(rawBody, header, secrets, { toleranceSec = 300, now = Date.now() } = {}) {
  const list = (Array.isArray(secrets) ? secrets : [secrets]).map((s) => String(s || '').trim()).filter(Boolean);
  const h = String(header || '').trim();
  if (!list.length || !h) return false;
  const parts = h.split(',').map((p) => p.trim());
  const t = Number(parts.find((p) => p.startsWith('t='))?.slice(2));
  const received = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!Number.isFinite(t) || t <= 0 || !received.length) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const signed = `${t}.${body}`;
  return list.some((secret) => {
    const want = crypto.createHmac('sha256', secret).update(signed).digest('hex');
    return received.some((r) => /^[0-9a-f]+$/i.test(r) && safeEqual(r.toLowerCase(), want));
  });
}

/** "0812-3456-7890" -> "6281234567890" (skip entries we cannot normalise). */
function normaliseNumbers(raw) {
  const out = [];
  for (const item of String(raw || '').split(',')) {
    const n = normalizePhone(item.trim());
    if (n) out.push(n);
  }
  return out;
}

function maskPhone(phone) {
  const s = String(phone || '');
  return s.length > 4 ? `…${s.slice(-4)}` : s;
}

export class WhatsAppInbox extends EventEmitter {
  /**
   * @param {{channel: object, store: object, env?: object, responder?: Function|null}} deps
   */
  constructor({ channel, store, env = process.env, responder = null }) {
    super();
    this.channel = channel;
    this.store = store;
    this.responder = responder;

    this.verifyToken = String(env.WHATSAPP_VERIFY_TOKEN || '').trim();
    this.appSecret = String(env.WHATSAPP_APP_SECRET || '').trim();
    this.phoneNumberId = String(env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
    // Kirimdev signs with its own secret(s); comma-separated while a secret is rotated.
    this.kirimSecrets = String(env.KIRIMDEV_WEBHOOK_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean);

    // Who may talk to the AI. Empty = AI chat is OFF (safe default).
    this.aiChats = new Set(normaliseNumbers(env.WHATSAPP_AI_CHAT_IDS));
    // Who may subscribe with START. Personal agent: unless an explicit list or
    // join code exists, only the owner's own numbers may subscribe.
    this.allowed = new Set(normaliseNumbers(env.WHATSAPP_ALLOWED_NUMBERS));
    this.joinCode = String(env.WHATSAPP_JOIN_CODE || '').trim();
    if (!this.allowed.size && !this.joinCode && this.aiChats.size
      && String(env.WHATSAPP_OPEN_SUBSCRIPTION || '').toLowerCase() !== 'true') {
      this.allowed = new Set(this.aiChats);
    }
    this.welcome = env.WHATSAPP_WELCOME
      || 'Halo {nama}! Nomor ini terdaftar menerima pesan dari kami. Balas STOP kapan saja untuk berhenti.';

    this.history = new Map();   // phone -> { at, turns: [{role, content}] }
    this.rate = new Map();      // phone -> [timestamps]
    this._chains = new Map();   // phone -> Promise (serialises AI replies per number)

    /** Optional persistence hooks (set by the server): transcripts in the DB. */
    this.onExchange = null;   // ({chatId, user, assistant}) => void
    this.onOutgoing = null;   // ({chatId, assistant}) => void  (assistant-initiated)
    this.loadHistory = null;  // (chatId) => [{role, content}]
  }

  /**
   * Alive with a configured number plus either Meta's pair (verify token + app
   * secret) or a Kirimdev signing secret (no GET handshake there).
   */
  get webhookReady() {
    const meta = Boolean(this.verifyToken && this.appSecret);
    return Boolean((meta || this.kirimSecrets.length) && this.channel.configured);
  }

  /**
   * Authenticates one POST: Kirimdev's X-Kirim-Signature, or Meta's
   * X-Hub-Signature-256. Returns the provider that vouched for it, or null.
   */
  verifyRequest(raw, headers = {}) {
    const get = (n) => (typeof headers.get === 'function' ? headers.get(n) : headers[n]);
    const kirim = get('x-kirim-signature');
    if (kirim) return verifyKirimSignature(raw, kirim, this.kirimSecrets) ? 'kirimdev' : null;
    const hub = get('x-hub-signature-256');
    if (hub && verifyWebhookSignature(raw, hub, this.appSecret)) return 'meta';
    return null;
  }

  /** True when at least one way of authenticating inbound traffic is configured. */
  get hasWebhookSecret() {
    return Boolean(this.appSecret || this.kirimSecrets.length);
  }

  get enabled() { return this.webhookReady; }

  status() {
    return {
      enabled: this.enabled,
      webhook: {
        ready: this.webhookReady,
        verifyToken: Boolean(this.verifyToken),
        appSecret: Boolean(this.appSecret),
        kirimdev: this.kirimSecrets.length > 0,
      },
      aiChat: { enabled: Boolean(this.responder) && this.aiChats.size > 0, chats: this.aiChats.size },
      ...this.store.subscribers.counts('whatsapp'),
    };
  }

  isOwner(phone) {
    return this.aiChats.has(String(phone));
  }

  /**
   * Meta's GET verification handshake: answers with hub.challenge when the
   * verify token matches, null otherwise (the route then replies 403).
   */
  verifyChallenge(query = {}) {
    if (!this.verifyToken) return null;
    if (String(query['hub.mode'] || '') !== 'subscribe') return null;
    const token = String(query['hub.verify_token'] || '');
    const challenge = String(query['hub.challenge'] || '');
    if (!challenge || !safeEqual(token, this.verifyToken)) return null;
    return challenge;
  }

  /**
   * Processes one webhook payload. Answers a Meta retry is handled by the
   * inbound_messages dedup; AI replies run on per-number chains so a slow model
   * never blocks the webhook response.
   * @returns {Promise<{handled:number, results:Array}>}
   */
  async handleWebhook(payload) {
    if (!payload || typeof payload !== 'object' || payload.object !== 'whatsapp_business_account') {
      return { handled: 0, results: [] };
    }
    const results = [];
    for (const entry of payload.entry || []) {
      for (const change of entry?.changes || []) {
        const value = change?.value || {};
        // Another phone number sharing this webhook: not ours.
        if (this.phoneNumberId && value.metadata?.phone_number_id
          && String(value.metadata.phone_number_id) !== this.phoneNumberId) continue;

        for (const message of value.messages || []) {
          try {
            results.push(await this.handleMessage(value, message));
          } catch (e) {
            console.error('[WHATSAPP-INBOX] handler error:', e?.message || e);
            results.push({ action: 'error', error: String(e?.message || e).slice(0, 200) });
          }
        }
        for (const status of value.statuses || []) this._onStatus(value, status);
      }
    }
    const handled = results.filter((r) => r && r.action
      && !['duplicate', 'ignored', 'error'].includes(r.action)).length;
    return { handled, results };
  }

  /** Processes a single inbound message. Exposed for tests. */
  async handleMessage(value = {}, message = {}) {
    if (!message || typeof message !== 'object') return { action: 'ignored' };
    const phone = normalizePhone(message.from);
    if (!phone) return { action: 'ignored' };
    // Meta retries deliveries: react once per message id.
    if (!this.store.inbound.claim('whatsapp', message.id, phone)) return { action: 'duplicate', phone };

    traceStep('receive', {
      channel: 'whatsapp', kind: message.type || 'unknown',
      chars: message.text?.body?.length || 0, from: maskPhone(phone),
    });

    const contact = (value.contacts || []).find((c) => String(c.wa_id) === String(message.from));
    const name = String(contact?.profile?.name || '').slice(0, 120);

    if (message.type !== 'text') {
      this._touchPerson(phone, name, null); // still remembered in the contact list
      // Voice notes / photos / documents are not readable yet.
      if (this.isOwner(phone) && this.responder) {
        await this._reply(phone, 'Maaf, saya baru bisa membaca pesan teks di WhatsApp. Tulis saja ya.');
        return { action: 'unsupported_reply', phone };
      }
      return { action: 'ignored', phone };
    }

    const text = String(message.text?.body || '').trim().slice(0, MAX_TEXT);
    this._touchPerson(phone, name, text || null);
    if (!text) return { action: 'ignored', phone };

    // STOP is an opt-out, never a conversation (Meta policy requires this).
    if (STOP_RE.test(text)) {
      this.store.subscribers.setActive('whatsapp', phone, false);
      this.store.suppressions.add(suppressionKey('whatsapp', phone), 'opt-out');
      await this._reply(phone, 'Baik, nomor ini berhenti berlangganan. Balas START kapan saja untuk berlangganan lagi.');
      this.emit('unsubscribed', { phone });
      return { action: 'unsubscribed', phone };
    }

    // START [kode] opts back in (mirrors Telegram's /start, without the slash).
    let startArg = null;
    if (/^\s*(?:start|daftar|subscribe)\s*$/i.test(text)) startArg = '';
    else if (this.joinCode) {
      const m = /^\s*(?:start|daftar|subscribe)\s+(\S+)\s*$/i.exec(text);
      if (m) startArg = m[1].trim();
    }
    if (startArg !== null) {
      if (this.allowed.size && !this.allowed.has(phone)) {
        await this._reply(phone, 'Maaf, nomor ini tidak diizinkan untuk berlangganan.');
        this.emit('rejected', { phone, reason: 'not_allowed' });
        return { action: 'rejected', reason: 'not_allowed', phone };
      }
      if (this.joinCode && startArg !== this.joinCode) {
        await this._reply(phone, 'Kode undangan diperlukan. Balas: START KODE');
        this.emit('rejected', { phone, reason: 'bad_code' });
        return { action: 'rejected', reason: 'bad_code', phone };
      }
      this.store.subscribers.upsert({ channel: 'whatsapp', address: phone, name });
      this.store.suppressions.remove(suppressionKey('whatsapp', phone)); // explicitly opting back in
      await this._reply(phone, this.welcome.replace('{nama}', name || 'Bapak/Ibu'));
      this.emit('subscribed', { phone, name });
      return { action: 'subscribed', phone };
    }

    if (HELP_RE.test(text)) {
      await this._reply(phone, [
        'Halo! Nomor ini bisa menerima pesan dari Wanar AI.',
        'Balas STOP untuk berhenti, START untuk berlangganan kembali.',
        this.isOwner(phone) ? 'Tulis saja apa pun — saya siap membantu.' : '',
      ].filter(Boolean).join('\n'));
      return { action: 'help', phone };
    }

    // Plain text: only the owner's own numbers talk to the AI.
    // Anyone else who writes in is a possible client: the sales desk answers from the owner's catalog.
    if (this.sales && !this.isOwner(phone)) return this._maybeSales(phone, name, text);
    if (!this.responder || !this.isOwner(phone)) return { action: 'ignored', phone };
    return this._maybeChat(phone, text, message.id);
  }

  /** A stranger's message: qualified and answered by the sales desk (never throws). */
  async _maybeSales(phone, name, text) {
    try {
      const r = await this.sales.intake({ source: 'whatsapp', contact: phone, name, text });
      if (r.autoSend && r.reply) await this._reply(phone, r.reply);
      return { action: 'sales', phone, leadId: r.leadId };
    } catch (e) {
      console.warn('[WHATSAPP-INBOX] sales desk error:', e?.message || e);
      return { action: 'ignored', phone };
    }
  }

  /** Contact memory (people table): best-effort — must never break messaging. */
  _touchPerson(phone, name, message) {
    try {
      this.store.people?.touch({
        channel: 'whatsapp', address: phone, name: name || null,
        owner: this.isOwner(phone), message: message || null,
      });
    } catch { /* contact memory is best-effort */ }
  }

  // ---------------------------------------------------------- AI chat

  _historyFor(phone) {
    const h = this.history.get(phone);
    if (h && Date.now() - h.at <= HISTORY_TTL_MS) return h.turns;
    if (!h && typeof this.loadHistory === 'function') {
      try {
        const turns = (this.loadHistory(`wa:${phone}`) || []).slice(-HISTORY_TURNS);
        if (turns.length) {
          this.history.set(phone, { at: Date.now(), turns });
          return turns;
        }
      } catch { /* history is best-effort */ }
    }
    return [];
  }

  _remember(phone, role, content) {
    const turns = this._historyFor(phone).slice();
    turns.push({ role, content });
    this.history.set(phone, { at: Date.now(), turns: turns.slice(-HISTORY_TURNS) });
  }

  /**
   * A message the assistant sent on its own initiative (reminder, briefing...).
   * Remembered as an assistant turn so the owner's reply to it makes sense.
   */
  noteOutgoing(phone, text) {
    const t = String(text || '').slice(0, 4000);
    if (!t) return;
    traceStep('deliver', { channel: 'whatsapp', kind: 'outgoing', chars: t.length, ok: true });
    this._remember(String(phone), 'assistant', t);
    try { this.onOutgoing?.({ chatId: `wa:${phone}`, assistant: t }); } catch { /* best effort */ }
  }

  _maybeChat(phone, text, messageId) {
    const now = Date.now();
    const stamps = (this.rate.get(phone) || []).filter((t) => now - t < CHAT_RATE_WINDOW_MS);
    if (stamps.length >= CHAT_RATE_MAX) {
      this._reply(phone, 'Terlalu banyak pesan dalam waktu singkat. Coba lagi beberapa menit lagi ya.');
      return { action: 'rate_limited', phone };
    }
    stamps.push(now);
    this.rate.set(phone, stamps);

    // Serialise per number so answers stay in order; never block the webhook.
    const previous = this._chains.get(phone) || Promise.resolve();
    const done = previous.then(() => this._answer(phone, text, messageId)).catch(() => {});
    this._chains.set(phone, done);
    done.finally(() => { if (this._chains.get(phone) === done) this._chains.delete(phone); });
    return { action: 'ai_reply', phone, done };
  }

  async _answer(phone, text, messageId) {
    return withTrace(
      { channel: 'whatsapp', title: 'Pesan WhatsApp', input: text, meta: { from: maskPhone(phone), kind: 'chat' } },
      async () => {
        try {
          this.channel.markRead?.(messageId).catch(() => {});
          const history = this._historyFor(phone).slice();
          traceStep('receive', { channel: 'whatsapp', kind: 'chat', chars: text.length, history: history.length });

          // Slow model? Say so once instead of leaving the owner waiting in silence.
          let waited = false;
          const ackTimer = setTimeout(() => {
            waited = true;
            this._reply(phone, process.env.AI_SLOW_NOTICE || 'Sebentar ya, saya masih menyiapkan jawabannya…').catch(() => {});
          }, Math.max(5000, parseInt(process.env.AI_SLOW_NOTICE_MS || '15000', 10) || 15000));

          let answer;
          try {
            // "wa:" prefix routes reminders/alarms created here back to WhatsApp
            // (automation.notify), instead of the default Telegram chat.
            answer = String(await this.responder({
              chatId: `wa:${phone}`, text, history, commands: [],
            }) || '').trim();
          } finally {
            clearTimeout(ackTimer);
          }
          void waited;
          if (!answer) throw new Error('empty');

          this._remember(phone, 'user', text);
          this._remember(phone, 'assistant', answer);
          try { this.onExchange?.({ chatId: `wa:${phone}`, user: text, assistant: answer }); } catch { /* never block the reply */ }

          const parts = chunkText(answer, REPLY_CHUNK);
          for (const part of parts) await this._reply(phone, part);
          traceStep('deliver', { channel: 'whatsapp', parts: parts.length, chars: answer.length, ok: true, preview: answer.slice(0, 160) });
          this.emit('ai_reply', { phone });
          return answer;
        } catch (e) {
          console.warn('[WHATSAPP-INBOX] jawaban AI gagal:', e?.message || e);
          traceStep('error', { error: String(e?.message || e).slice(0, 200) });
          const sorry = 'Maaf, AI sedang tidak tersedia. Coba lagi sebentar ya.';
          await this._reply(phone, sorry);
          return sorry;
        }
      }
    );
  }

  /** Free-form text to a number (inside the 24h window). Never throws. */
  async _reply(phone, text) {
    try {
      await this.channel.send({ to: phone, text, freeform: true });
    } catch (e) {
      // A failed courtesy reply must never undo a subscription change.
      console.warn('[WHATSAPP-INBOX] balasan gagal:', e?.message || e);
    }
  }

  _onStatus(value, status = {}) {
    const phone = normalizePhone(status.recipient_id) || String(status.recipient_id || '');
    const event = {
      phone,
      status: String(status.status || ''),
      messageId: status.id || null,
      errors: (status.errors || []).map((e) => e?.title).filter(Boolean).slice(0, 3),
      at: Date.now(),
    };
    traceStep('deliver', { channel: 'whatsapp', kind: 'status', status: event.status, from: maskPhone(phone) });
    this.emit('delivery_status', event);
  }
}
