/**
 * src/automation/telegram-inbox.js
 *
 * Receives Telegram updates (long polling) so people can opt in/out themselves:
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

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TelegramInbox extends EventEmitter {
  /**
   * @param {{channel: object, store: object, env?: object, pollSeconds?: number}} deps
   */
  constructor({ channel, store, env = process.env, pollSeconds = 25 }) {
    super();
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
    if (!match) return null;

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

  async _reply(chatId, html) {
    try {
      await this.channel.reply(chatId, html);
    } catch (e) {
      // A failed courtesy reply must never undo the subscription change.
      console.warn('[TELEGRAM-INBOX] balasan gagal:', e.message);
    }
  }
}
