/**
 * src/automation/telegram-inbox.js
 *
 * Receives Telegram updates (long polling). Two jobs:
 *
 *  1. Opt-in / opt-out, so people can subscribe themselves:
 *
 *   /start [kode]   subscribe this chat      /stop   unsubscribe + suppress
 *   /id             reply with the chat id   /help   list commands
 *
 * This is what makes "send to all subscribers" legitimate: the recipient list is
 * built from people who pressed Start, and /stop is honoured immediately and
 * permanently (it also lands in the suppression list).
 *
 * Opt-in controls
 *   TELEGRAM_POLLING=true            enable the inbox (off by default so it never
 *                                    fights an existing webhook of your own bot)
 *   TELEGRAM_JOIN_CODE=rahasia       require "/start rahasia" (keeps a public bot private)
 *   TELEGRAM_ALLOWED_CHAT_IDS=1,2    only these chats may subscribe
 *   TELEGRAM_WELCOME="..."           welcome text; {nama} is substituted
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { EventEmitter } from 'node:events';
import { suppressionKey } from './store.js';
import { ErrorKind } from './mailer.js';
import { collect } from './ai-compose.js';
import { chunkText } from './channels/base.js';

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Builds the function that answers a plain chat message with the AI.
 *
 * Deliberately CHAT ONLY: no tools, no file/shell/browser access. A Telegram
 * bot is reachable by anyone who finds its username, and its text is untrusted
 * input, so it must never be able to act on the host.
 */
export function makeChatResponder({ aiManager, systemPrompt }) {
  const system = systemPrompt || [
    'Kamu adalah Wanar AI, asisten pribadi milik Wisnu Alfian Nur Ashar.',
    'Kamu sedang mengobrol lewat Telegram: jawab singkat dan jelas (sekitar 1-4 kalimat, lebih panjang hanya bila diminta).',
    'Gunakan Bahasa Indonesia yang sopan dan santai. Teks biasa saja: tanpa markdown, tanpa HTML.',
    'Dari Telegram kamu hanya bisa mengobrol: kamu tidak bisa membuka file, menjalankan perintah, atau mengakses sistem.',
    'Jika diminta melakukan hal itu, jelaskan singkat bahwa itu dilakukan lewat aplikasi web Wanar AI.',
    'Jangan mengarang fakta. Jika tidak tahu, katakan tidak tahu.',
  ].join('\n');

  return async ({ history, text }) => {
    const date = new Date().toLocaleDateString('id-ID', {
      timeZone: process.env.AUTOMATION_TZ || 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    const messages = [...history, { role: 'user', content: text }];
    const out = await collect(aiManager, messages, {
      systemPrompt: `${system}\nHari ini: ${date}.`, temperature: 0.6, maxTokens: 1500,
    });
    return out.text;
  };
}

const HISTORY_TURNS = 12;          // messages remembered per chat
const HISTORY_TTL_MS = 60 * 60_000; // forgotten after an hour of silence
const CHAT_RATE_WINDOW_MS = 10 * 60_000;
const CHAT_RATE_MAX = 20;           // AI replies per chat per window

export class TelegramInbox extends EventEmitter {
  /**
   * @param {{channel: object, store: object, env?: object, pollSeconds?: number}} deps
   */
  constructor({ channel, store, env = process.env, pollSeconds = 25, responder = null }) {
    super();
    this.responder = responder;
    // Who may talk to the AI. Empty = AI chat is OFF (safe default).
    this.aiChats = new Set(
      String(env.TELEGRAM_AI_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
    );
    this.history = new Map();   // chatId -> { at, turns: [{role, content}] }
    this.rate = new Map();      // chatId -> [timestamps]
    this._chains = new Map();   // chatId -> Promise (serialises replies per chat)
    this.channel = channel;
    this.store = store;
    this.pollSeconds = pollSeconds;
    this.joinCode = (env.TELEGRAM_JOIN_CODE || '').trim();
    this.allowed = new Set(
      String(env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
    );
    this.welcome = env.TELEGRAM_WELCOME
      || 'Halo {nama}! Anda sekarang terdaftar untuk menerima pesan dari kami. Kirim /stop kapan saja untuk berhenti.';
    this.wanted = String(env.TELEGRAM_POLLING || '').toLowerCase() === 'true';
    this.offset = undefined;
    this.running = false;
    this._abort = false;
    this._loopPromise = null;
  }

  get enabled() {
    return this.wanted && this.channel.mode === 'live';
  }

  status() {
    return {
      enabled: this.enabled,
      wanted: this.wanted,
      running: this.running,
      requiresJoinCode: Boolean(this.joinCode),
      restricted: this.allowed.size > 0,
      aiChat: { enabled: Boolean(this.responder) && this.aiChats.size > 0, chats: this.aiChats.size },
      ...this.store.subscribers.counts('telegram'),
    };
  }

  start() {
    if (!this.enabled || this.running) return false;
    this.running = true;
    this._abort = false;
    this._loopPromise = this._loop().finally(() => { this.running = false; });
    return true;
  }

  async stop() {
    this._abort = true;
    await Promise.race([this._loopPromise, sleep(1500)]);
  }

  async _loop() {
    let backoff = 2000;
    while (!this._abort) {
      try {
        const updates = await this.channel.getUpdates(this.offset, this.pollSeconds);
        backoff = 2000;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          try {
            await this.handleUpdate(u);
          } catch (e) {
            console.error('[TELEGRAM-INBOX] handler error:', e.message);
          }
        }
      } catch (e) {
        if (e.kind === ErrorKind.AUTH) {
          console.error('[TELEGRAM-INBOX] token ditolak — inbox dihentikan.');
          this.emit('error_fatal', e);
          return;
        }
        if (e.responseCode === 409) {
          console.error('[TELEGRAM-INBOX] bentrok dengan webhook/consumer lain (409) — inbox dihentikan.');
          this.emit('error_fatal', e);
          return;
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** Processes a single Telegram update. Exposed for tests. */
  async handleUpdate(update) {
    const msg = update.message;
    if (!msg?.chat || typeof msg.text !== 'string') return null;

    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+(.+))?$/i.exec(text);
    if (!match) return this._maybeChat(msg, chatId, text);

    const command = match[1].toLowerCase();
    const arg = (match[2] || '').trim();
    const person = msg.chat.type === 'private'
      ? [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ')
      : msg.chat.title || '';
    const username = msg.from?.username || msg.chat.username || null;
    const key = suppressionKey('telegram', chatId);

    if (command === 'id') {
      await this._reply(chatId, `Chat ID: <code>${escapeHtml(chatId)}</code>`);
      return { action: 'id', chatId };
    }

    if (command === 'help') {
      await this._reply(chatId, '/start — berlangganan pesan\n/stop — berhenti berlangganan\n/id — tampilkan Chat ID');
      return { action: 'help', chatId };
    }

    if (command === 'start') {
      if (this.allowed.size && !this.allowed.has(chatId)) {
        await this._reply(chatId, 'Maaf, chat ini tidak diizinkan untuk berlangganan.');
        this.emit('rejected', { chatId, reason: 'not_allowed' });
        return { action: 'rejected', reason: 'not_allowed', chatId };
      }
      if (this.joinCode && arg !== this.joinCode) {
        await this._reply(chatId, 'Kode undangan diperlukan. Kirim: /start KODE');
        this.emit('rejected', { chatId, reason: 'bad_code' });
        return { action: 'rejected', reason: 'bad_code', chatId };
      }
      this.store.subscribers.upsert({ channel: 'telegram', address: chatId, name: person, username });
      this.store.suppressions.remove(key); // explicitly opting back in
      await this._reply(chatId, escapeHtml(this.welcome.replace('{nama}', person || 'Anda')));
      this.emit('subscribed', { chatId, name: person, username });
      return { action: 'subscribed', chatId };
    }

    if (command === 'stop') {
      this.store.subscribers.setActive('telegram', chatId, false);
      this.store.suppressions.add(key, 'opt-out');
      await this._reply(chatId, 'Anda telah berhenti berlangganan. Kirim /start untuk berlangganan kembali.');
      this.emit('unsubscribed', { chatId });
      return { action: 'unsubscribed', chatId };
    }

    return null;
  }

  // ---------------------------------------------------------- AI chat

  _historyFor(chatId) {
    const h = this.history.get(chatId);
    if (!h || Date.now() - h.at > HISTORY_TTL_MS) return [];
    return h.turns;
  }

  _remember(chatId, role, content) {
    const turns = this._historyFor(chatId).slice();
    turns.push({ role, content });
    this.history.set(chatId, { at: Date.now(), turns: turns.slice(-HISTORY_TURNS) });
  }

  /**
   * Plain (non-command) text. Answered by the AI only for allow-listed PRIVATE
   * chats; everyone else is ignored silently.
   */
  _maybeChat(msg, chatId, text) {
    if (!this.responder || !this.aiChats.has(chatId) || msg.chat.type !== 'private') return null;

    const now = Date.now();
    const stamps = (this.rate.get(chatId) || []).filter((t) => now - t < CHAT_RATE_WINDOW_MS);
    if (stamps.length >= CHAT_RATE_MAX) {
      this._reply(chatId, 'Terlalu banyak pesan dalam waktu singkat. Coba lagi beberapa menit lagi ya.');
      return { action: 'rate_limited', chatId };
    }
    stamps.push(now);
    this.rate.set(chatId, stamps);

    // Serialise per chat so answers stay in order, but never block polling:
    // a slow model must not freeze the whole inbox.
    const previous = this._chains.get(chatId) || Promise.resolve();
    const done = previous.then(() => this._answer(chatId, text)).catch(() => {});
    this._chains.set(chatId, done);
    done.finally(() => { if (this._chains.get(chatId) === done) this._chains.delete(chatId); });
    return { action: 'ai_reply', chatId, done };
  }

  async _answer(chatId, text) {
    try {
      await this.channel.sendAction?.(chatId, 'typing').catch(() => {});
      const history = this._historyFor(chatId).slice();
      const answer = String(await this.responder({ chatId, text: text.slice(0, 4000), history }) || '').trim();
      if (!answer) throw new Error('empty');
      this._remember(chatId, 'user', text.slice(0, 4000));
      this._remember(chatId, 'assistant', answer.slice(0, 4000));
      for (const part of chunkText(answer, 3500)) await this._reply(chatId, escapeHtml(part));
      this.emit('ai_reply', { chatId });
    } catch (e) {
      console.warn('[TELEGRAM-INBOX] jawaban AI gagal:', e.message);
      await this._reply(chatId, 'Maaf, AI sedang tidak tersedia. Coba lagi sebentar ya.');
    }
  }

  async _reply(chatId, html) {
    try {
      await this.channel.reply(chatId, html);
    } catch (e) {
      // A failed courtesy reply must never undo the subscription change.
      console.warn('[TELEGRAM-INBOX] balasan gagal:', e.message);
    }
  }
}
