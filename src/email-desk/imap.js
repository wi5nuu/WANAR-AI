/**
 * src/email-desk/imap.js
 *
 * Real-time inbox watcher. Uses IMAP IDLE (push from the mail server) so a
 * reply reaches Telegram within seconds, with a periodic poll as a safety net
 * and automatic reconnect with backoff. Read-only: messages are fetched with
 * PEEK, so nothing is marked as read or moved.
 *
 * Only new mail is processed: on first start the cursor is set to the current
 * end of the inbox, so old messages are never replied to.
 *
 * @author Wisnu Alfian Nur Ashar
 */

export function readImapConfig(env = process.env) {
  const smtpHost = String(env.SMTP_HOST || '').trim();
  const host = String(env.IMAP_HOST || (smtpHost.startsWith('smtp.') ? `imap.${smtpHost.slice(5)}` : '')).trim();
  const port = parseInt(env.IMAP_PORT || '993', 10) || 993;
  const user = String(env.IMAP_USER || env.SMTP_USER || '').trim();
  const pass = String(env.IMAP_PASS || env.SMTP_PASS || '').replace(/[^\x20-\x7e]/g, '').trim();
  const enabled = String(env.EMAIL_WATCH ?? 'true').toLowerCase() !== 'false';
  return {
    host, port, user, pass,
    secure: String(env.IMAP_SECURE || (port === 993 ? 'true' : 'false')).toLowerCase() === 'true',
    mailbox: env.IMAP_MAILBOX || 'INBOX',
    pollMs: Math.max(15_000, parseInt(env.IMAP_POLL_MS || '60000', 10) || 60_000),
    configured: Boolean(enabled && host && user && pass),
  };
}

export class ImapWatcher {
  /**
   * @param {object} o
   * @param {(mail:object) => Promise<any>} o.onMail
   * @param {{get:Function,set:Function}} o.cursor  persistent last-UID storage
   */
  constructor({ env = process.env, onMail, cursor, log = console, loadLibs = null }) {
    this.cfg = readImapConfig(env);
    this.onMail = onMail;
    this.cursor = cursor;
    this.log = log;
    this.loadLibs = loadLibs || (async () => ({ ImapFlow: (await import('imapflow')).ImapFlow, simpleParser: (await import('mailparser')).simpleParser }));
    this.client = null;
    this.stopped = true;
    this.backoff = 5_000;
    this.busy = false;
    this.status = { state: 'idle', lastError: null, lastCheck: null, processed: 0 };
  }

  describe() {
    const c = this.cfg;
    return { configured: c.configured, host: c.host || null, user: c.user ? c.user.replace(/(^.).*(@.*$)/, '$1***$2') : null, mailbox: c.mailbox, ...this.status };
  }

  start() {
    if (!this.cfg.configured || !this.stopped) return false;
    this.stopped = false;
    this._connect();
    this._poll = setInterval(() => { this.check().catch(() => {}); }, this.cfg.pollMs);
    this._poll.unref?.();
    return true;
  }

  stop() {
    this.stopped = true;
    clearInterval(this._poll);
    clearTimeout(this._retry);
    try { this.client?.logout?.().catch(() => {}); } catch { /* ignore */ }
    this.client = null;
    this.status.state = 'stopped';
  }

  async _connect() {
    if (this.stopped) return;
    try {
      const { ImapFlow, simpleParser } = await this.loadLibs();
      this.simpleParser = simpleParser;
      const c = new ImapFlow({
        host: this.cfg.host, port: this.cfg.port, secure: this.cfg.secure,
        auth: { user: this.cfg.user, pass: this.cfg.pass }, logger: false,
      });
      c.on('exists', () => { this.check().catch(() => {}); });
      c.on('close', () => this._scheduleReconnect('koneksi tertutup'));
      c.on('error', (e) => { this.status.lastError = e.message; });
      await c.connect();
      await c.mailboxOpen(this.cfg.mailbox, { readOnly: true });
      this.client = c;
      this.backoff = 5_000;
      this.status.state = 'watching';
      this.status.lastError = null;
      if (this.cursor.get() == null) this.cursor.set(Math.max(0, (c.mailbox?.uidNext || 1) - 1));
      await this.check();
    } catch (e) {
      this.status.lastError = e.message;
      this._scheduleReconnect(e.message);
    }
  }

  _scheduleReconnect(reason) {
    if (this.stopped) return;
    this.client = null;
    this.status.state = 'reconnecting';
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this._connect(), this.backoff);
    this._retry.unref?.();
    this.log.warn?.(`[EMAIL-DESK] IMAP: ${reason} — sambung ulang dalam ${Math.round(this.backoff / 1000)} dtk`);
    this.backoff = Math.min(this.backoff * 2, 5 * 60_000);
  }

  /** Fetches and processes mail newer than the cursor. Safe to call often. */
  async check() {
    const c = this.client;
    if (!c || this.busy) return 0;
    this.busy = true;
    let n = 0;
    try {
      const last = Number(this.cursor.get() || 0);
      const batch = [];
      for await (const msg of c.fetch(`${last + 1}:*`, { uid: true, source: true }, { uid: true })) {
        if (msg.uid > last) batch.push(msg);
        if (batch.length >= 50) break;
      }
      batch.sort((a, b) => a.uid - b.uid);
      for (const msg of batch) {
        try {
          const p = await this.simpleParser(msg.source);
          const headers = {};
          for (const [k, v] of p.headers || []) headers[k] = typeof v === 'string' ? v : (v?.text || v?.value || String(v));
          await this.onMail({
            messageId: p.messageId || null,
            inReplyTo: p.inReplyTo || null,
            references: Array.isArray(p.references) ? p.references : (p.references ? [p.references] : []),
            from: p.from?.value?.[0] ? { address: p.from.value[0].address, name: p.from.value[0].name } : null,
            subject: p.subject || '',
            text: p.text || '',
            date: p.date || null,
            headers,
          });
          n++;
        } catch (e) {
          this.log.warn?.('[EMAIL-DESK] gagal memproses email:', e.message);
        }
        this.cursor.set(msg.uid); // advance even on failure: never loop on a poison message
      }
      this.status.processed += n;
      this.status.lastCheck = Date.now();
    } catch (e) {
      this.status.lastError = e.message;
    } finally {
      this.busy = false;
    }
    return n;
  }
}
