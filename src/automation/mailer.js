/**
 * src/automation/mailer.js
 *
 * SMTP delivery for the automation module, built on nodemailer.
 *
 * Environment
 *   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE ("true" for 465), SMTP_USER, SMTP_PASS
 *   MAIL_FROM            "Nama <alamat@domain>" or a bare address (default: SMTP_USER)
 *   MAIL_FROM_NAME       display name when MAIL_FROM is a bare address
 *   EMAIL_DRY_RUN        "true" forces simulation even when SMTP is configured
 *   EMAIL_UNSUBSCRIBE_MAILTO   optional; adds a List-Unsubscribe header
 *
 * When SMTP is not configured the mailer runs in **dry-run** mode: messages are
 * fully built and validated but never leave the machine. That makes it safe to
 * develop and preview campaigns before any credentials exist.
 *
 * Credentials are read from the environment only — they are never written to
 * the database, returned by the API, or logged.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import nodemailer from 'nodemailer';
import { cleanName, isValidEmail } from './recipients.js';
import { BrevoTransport } from './brevo.js';

export const ErrorKind = Object.freeze({
  TRANSIENT: 'transient', // retry later (timeouts, 4xx)
  PERMANENT: 'permanent', // this recipient will never work (unknown user)
  AUTH: 'auth',           // credentials rejected — nothing will work
  CONFIG: 'config',       // channel misconfigured (bad template, revoked webhook...)
  QUOTA: 'quota',         // provider daily/rate quota — stop for now
  INVALID: 'invalid',     // we refused to build the message
});

export class MailError extends Error {
  constructor(message, kind, extra = {}) {
    super(message);
    this.name = 'MailError';
    this.kind = kind;
    this.code = extra.code;
    this.responseCode = extra.responseCode;
    this.hardBounce = Boolean(extra.hardBounce);
    this.retryAfterMs = Number.isFinite(extra.retryAfterMs) ? extra.retryAfterMs : undefined;
  }
}

/** Maps a nodemailer/SMTP failure onto something the campaign runner can act on. */
export function classifyMailError(err) {
  const msg = String(err?.response || err?.message || err || '');
  const code = err?.code;
  const rc = Number(err?.responseCode) || 0;

  if (code === 'EAUTH' || rc === 535 || rc === 534 || /invalid login|authentication (failed|unsuccessful)|username and password not accepted/i.test(msg)) {
    return new MailError('Autentikasi SMTP ditolak — periksa SMTP_USER / SMTP_PASS (untuk Gmail gunakan App Password).', ErrorKind.AUTH, { code, responseCode: rc });
  }
  if (/daily (user )?sending (quota|limit)|quota exceeded|sending limit|rate limit|too many (messages|emails|recipients)|exceeded.*(limit|quota)/i.test(msg) || rc === 421 || rc === 452 || (rc === 550 && /5\.4\.5|quota|limit/i.test(msg))) {
    return new MailError(`Batas pengiriman penyedia SMTP tercapai: ${msg.slice(0, 160)}`, ErrorKind.QUOTA, { code, responseCode: rc });
  }
  if (code === 'EENVELOPE' || [550, 551, 553, 554].includes(rc) || /user unknown|no such user|mailbox (unavailable|not found)|does not exist|invalid (recipient|address)|recipient address rejected/i.test(msg)) {
    return new MailError(msg.slice(0, 200) || 'Penerima ditolak server', ErrorKind.PERMANENT, {
      code, responseCode: rc, hardBounce: [550, 551, 553].includes(rc) || /user unknown|no such user|does not exist/i.test(msg),
    });
  }
  return new MailError(msg.slice(0, 200) || 'Gagal mengirim email', ErrorKind.TRANSIENT, { code, responseCode: rc });
}

export function readMailConfig(env = process.env) {
  const host = (env.SMTP_HOST || '').trim();
  const user = (env.SMTP_USER || '').trim();
  const pass = env.SMTP_PASS || '';
  const port = parseInt(env.SMTP_PORT || '587', 10);
  const brevoKey = String(env.BREVO_API_KEY || '').trim();
  const secure = String(env.SMTP_SECURE || (port === 465 ? 'true' : 'false')).toLowerCase() === 'true';

  let fromAddress = (env.MAIL_FROM || user || '').trim();
  let fromName = (env.MAIL_FROM_NAME || '').trim();
  const m = /^(.*?)<([^>]+)>$/.exec(fromAddress);
  if (m) {
    fromAddress = m[2].trim();
    if (!fromName) fromName = m[1].trim().replace(/^"|"$/g, '');
  }

  return {
    host, port, secure, user, hasPassword: Boolean(pass), pass,
    fromAddress, fromName: cleanName(fromName),
    brevoKey,
    provider: brevoKey ? 'brevo-api' : 'smtp',
    configured: Boolean((brevoKey || (host && user && pass)) && isValidEmail(fromAddress)),
    forceDryRun: String(env.EMAIL_DRY_RUN || '').toLowerCase() === 'true',
    unsubscribeMailto: (env.EMAIL_UNSUBSCRIBE_MAILTO || '').trim(),
    dailyCap: Math.max(1, parseInt(env.EMAIL_DAILY_CAP || '450', 10) || 450),
    maxRecipients: Math.max(1, parseInt(env.EMAIL_MAX_RECIPIENTS || '1000', 10) || 1000),
    throttleMs: Math.max(0, parseInt(env.EMAIL_THROTTLE_MS || '1200', 10) || 0),
    maxAttempts: Math.max(1, parseInt(env.EMAIL_MAX_ATTEMPTS || '3', 10) || 3),
  };
}

export class Mailer {
  /**
   * @param {NodeJS.ProcessEnv} [env]
   * @param {{transport?: object}} [options]  inject a transport (tests)
   */
  constructor(env = process.env, options = {}) {
    this.cfg = readMailConfig(env);
    this._injected = options.transport || null;
    this._live = null;
    this._dry = null;
  }

  /** 'live' only when SMTP is configured and dry-run is not forced. */
  get mode() {
    if (this._injected) return 'live';
    return this.cfg.configured && !this.cfg.forceDryRun ? 'live' : 'dry-run';
  }

  /** Safe-to-expose description (never contains the password). */
  describe() {
    const c = this.cfg;
    return {
      mode: this.mode,
      configured: c.configured,
      provider: c.provider,
      host: c.host || null,
      port: c.port,
      secure: c.secure,
      user: c.user ? c.user.replace(/(^.).*(@.*$)/, '$1***$2') : null,
      hasPassword: c.hasPassword,
      from: c.fromAddress || null,
      fromName: c.fromName || null,
      forceDryRun: c.forceDryRun,
      dailyCap: c.dailyCap,
      maxRecipients: c.maxRecipients,
      throttleMs: c.throttleMs,
      maxAttempts: c.maxAttempts,
      missing: [
        !c.brevoKey && !c.host && 'SMTP_HOST',
        !c.brevoKey && !c.user && 'SMTP_USER',
        !c.brevoKey && !c.hasPassword && 'SMTP_PASS',
        !isValidEmail(c.fromAddress) && 'MAIL_FROM',
      ].filter(Boolean),
    };
  }

  _transport(mode) {
    if (this._injected) return this._injected;
    if (mode === 'live') {
      if (!this._live && this.cfg.brevoKey) this._live = new BrevoTransport({ apiKey: this.cfg.brevoKey });
      if (!this._live) {
        this._live = nodemailer.createTransport({
          host: this.cfg.host,
          port: this.cfg.port,
          secure: this.cfg.secure,
          auth: { user: this.cfg.user, pass: this.cfg.pass },
          pool: true,
          maxConnections: 3,
          maxMessages: 100,
          connectionTimeout: 15_000,
          greetingTimeout: 15_000,
          socketTimeout: 45_000,
        });
      }
      return this._live;
    }
    if (!this._dry) this._dry = nodemailer.createTransport({ jsonTransport: true });
    return this._dry;
  }

  async verify() {
    if (this.mode !== 'live') {
      return { ok: false, mode: 'dry-run', error: 'SMTP belum dikonfigurasi (mode simulasi)' };
    }
    try {
      await this._transport('live').verify();
      return { ok: true, mode: 'live' };
    } catch (err) {
      const e = classifyMailError(err);
      return { ok: false, mode: 'live', kind: e.kind, error: e.message };
    }
  }

  /**
   * Sends one message. The From address is always the configured identity —
   * callers can only choose the display name, so mail cannot be spoofed as
   * someone else through the API.
   */
  async send({ to, subject, text, html, replyTo, fromName, headers = {}, mode, attachments }) {
    if (!isValidEmail(to)) throw new MailError(`Alamat tujuan tidak valid: ${String(to).slice(0, 60)}`, ErrorKind.INVALID);
    const subj = String(subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
    if (!subj) throw new MailError('Subjek kosong', ErrorKind.INVALID);
    if (!String(text || '').trim() && !String(html || '').trim()) throw new MailError('Isi email kosong', ErrorKind.INVALID);
    if (replyTo && !isValidEmail(replyTo)) throw new MailError('Reply-To tidak valid', ErrorKind.INVALID);

    const useMode = mode || this.mode;
    const transport = this._transport(useMode);
    const fromAddress = this.cfg.fromAddress || 'no-reply@localhost.invalid';
    const display = cleanName(fromName || this.cfg.fromName);

    const hdrs = { 'X-Mailer': 'Wanar-AI-Automation', ...headers };
    if (this.cfg.unsubscribeMailto) {
      hdrs['List-Unsubscribe'] = `<mailto:${this.cfg.unsubscribeMailto}?subject=unsubscribe>`;
    }

    try {
      const info = await transport.sendMail({
        from: display ? { name: display, address: fromAddress } : fromAddress,
        to,
        subject: subj,
        text: text || undefined,
        html: html || undefined,
        replyTo: replyTo || undefined,
        headers: hdrs,
        attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined,
      });
      return {
        messageId: info.messageId || null,
        accepted: info.accepted || [to],
        dryRun: useMode !== 'live',
      };
    } catch (err) {
      throw err instanceof MailError ? err : classifyMailError(err);
    }
  }

  close() {
    try { this._live?.close?.(); } catch { /* ignore */ }
  }
}
