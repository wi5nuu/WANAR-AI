/**
 * src/automation/brevo.js
 *
 * Brevo (ex-Sendinblue) transactional email over HTTPS (api.brevo.com/v3).
 * Drop-in for the nodemailer transport the Mailer already uses, so quotas,
 * dry-run and error classification keep working.
 *
 * Why not SMTP: a Brevo "xkeysib-…" key is an API key. SMTP relay needs a
 * different login + "xsmtpsib-…" key. The API also works where outbound SMTP
 * ports are blocked (common on VPS providers).
 *
 * Note: Brevo only SENDS. Replies go to the From/Reply-To mailbox, which must
 * be a real inbox (read via IMAP by the Email Desk watcher).
 *
 * @author Wisnu Alfian Nur Ashar
 */

const API = 'https://api.brevo.com/v3';

function httpError(status, body) {
  const msg = String(body?.message || body?.code || `HTTP ${status}`);
  const err = new Error(msg);
  err.responseCode = status;
  if (status === 401) {
    err.code = 'EAUTH';
    err.message = `Brevo menolak API key (401): ${msg}`;
  } else if (status === 403 || /ip address|unauthorized ip/i.test(msg)) {
    err.code = 'EAUTH';
    err.message = `Brevo menolak akses (403) — IP server belum diizinkan di Brevo > SMTP & API > Authorized IPs, atau sender belum terverifikasi: ${msg}`;
  } else if (status === 429) {
    err.message = `rate limit Brevo: ${msg}`;
  } else if (status === 400 && /sender|from/i.test(msg)) {
    err.message = `Sender belum terverifikasi di Brevo (Senders, domains, IPs): ${msg}`;
  }
  return err;
}

const addr = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return { email: v };
  return v.address ? { email: v.address, ...(v.name ? { name: v.name } : {}) } : null;
};

const CONNECT_PHASE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

export class BrevoTransport {
  constructor({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /** One retry for transient network failures (never for HTTP errors). */
  async _call(path, opts = {}) {
    try {
      return await this._once(path, opts);
    } catch (e) {
      if (e.responseCode || !e.beforeSend) throw e;
      await new Promise((r) => setTimeout(r, 1200));
      return this._once(path, opts);
    }
  }

  async _once(path, { method = 'GET', body } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${API}${path}`, {
        method,
        headers: { 'api-key': this.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      let data = {};
      try { data = await res.json(); } catch { /* empty body */ }
      if (!res.ok) throw httpError(res.status, data);
      return data;
    } catch (e) {
      if (e.responseCode) throw e;
      const why = e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.cause?.message || e.code || e.message);
      const err = new Error(`Tidak bisa menghubungi Brevo (${why})`);
      // Only connection-phase failures are safe to retry: the request never left.
      err.beforeSend = CONNECT_PHASE.has(String(e.cause?.code || e.code || ''));
      err.code = 'ECONNECTION';
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** nodemailer-compatible: resolves {messageId, accepted}. */
  async sendMail(msg) {
    const sender = addr(msg.from);
    const to = (Array.isArray(msg.to) ? msg.to : [msg.to]).map(addr).filter(Boolean);
    if (!sender || !to.length) throw Object.assign(new Error('Pengirim/tujuan tidak valid'), { code: 'EENVELOPE' });
    const payload = {
      sender,
      to,
      subject: msg.subject,
      ...(msg.text ? { textContent: msg.text } : {}),
      ...(msg.html ? { htmlContent: msg.html } : {}),
      ...(msg.replyTo ? { replyTo: addr(msg.replyTo) } : {}),
    };
    if (!payload.textContent && !payload.htmlContent) throw Object.assign(new Error('Isi email kosong'), { code: 'EENVELOPE' });
    if (msg.headers && Object.keys(msg.headers).length) payload.headers = msg.headers;
    if (Array.isArray(msg.attachments) && msg.attachments.length) {
      payload.attachment = msg.attachments.map((a) => ({
        name: a.filename || 'lampiran',
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(String(a.content || '')).toString('base64'),
      }));
    }
    const data = await this._call('/smtp/email', { method: 'POST', body: payload });
    return { messageId: data.messageId || null, accepted: to.map((t) => t.email) };
  }

  async verify() {
    await this._call('/account');
    return true;
  }

  close() { /* stateless */ }
}
