/**
 * src/automation/channels/webhooks.js
 *
 * Incoming-webhook style channels: Slack, Discord, Microsoft Teams, and a
 * generic signed JSON webhook (n8n / Zapier / Make / your own bot or service).
 *
 * The destination URL is a credential, so it lives only in .env:
 *   SLACK_WEBHOOK_URL   DISCORD_WEBHOOK_URL   TEAMS_WEBHOOK_URL
 *   WEBHOOK_URL         WEBHOOK_SECRET (HMAC-SHA256 signing)   WEBHOOK_BEARER_TOKEN
 *   <ID>_DAILY_CAP  <ID>_THROTTLE_MS  <ID>_DRY_RUN
 *
 * These channels have one fixed destination, so a campaign addressed to them
 * has the single implicit recipient "default".
 *
 * Operator-configured URLs are trusted (a LAN n8n instance is a legitimate
 * target), so the SSRF guard that protects user-supplied URLs is not applied.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import crypto from 'node:crypto';
import { normalizeDestination } from '../recipients.js';
import {
  MailError, ErrorKind, chunkText, httpRequest, classifyHttp, retryAfterMs, missingList, intEnv, boolEnv, dryId,
} from './base.js';

const escSlack = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Per-service wire formats. Each returns the list of JSON bodies to POST. */
const FORMATS = {
  slack({ subject, text }) {
    const header = subject ? `*${escSlack(subject)}*\n` : '';
    return chunkText(`${header}${escSlack(text)}`, 3500).map((t) => ({ text: t }));
  },

  discord({ subject, text }) {
    const header = subject ? `**${subject}**\n` : '';
    return chunkText(`${header}${text}`, 1900).map((content) => ({
      content,
      // Template values come from CSV cells: never let them ping @everyone/@here.
      allowed_mentions: { parse: [] },
    }));
  },

  teams({ subject, text }) {
    return chunkText(text, 5000).map((chunk, i) => ({
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            ...(i === 0 && subject ? [{ type: 'TextBlock', text: subject, weight: 'Bolder', size: 'Medium', wrap: true }] : []),
            { type: 'TextBlock', text: chunk, wrap: true },
          ],
        },
      }],
    }));
  },

  webhook({ subject, text, html, recipient, campaign }) {
    return [{
      event: 'wanar.message',
      subject: subject || null,
      text,
      html: html || null,
      recipient: { name: recipient?.name || null },
      campaign: campaign ? { id: campaign.id, name: campaign.name } : null,
      sentAt: new Date().toISOString(),
    }];
  },
};

const META = {
  slack: { label: 'Slack', env: 'SLACK', https: true, hint: 'Buat Incoming Webhook di Slack (Apps → Incoming Webhooks) lalu isi SLACK_WEBHOOK_URL.' },
  discord: { label: 'Discord', env: 'DISCORD', https: true, hint: 'Server Settings → Integrations → Webhooks → salin URL ke DISCORD_WEBHOOK_URL.' },
  teams: { label: 'Microsoft Teams', env: 'TEAMS', https: true, hint: 'Pakai Workflows (Power Automate) "Post to a channel when a webhook request is received", salin URL ke TEAMS_WEBHOOK_URL.' },
  webhook: { label: 'Webhook (n8n/Zapier/bot sendiri)', env: 'WEBHOOK', https: false, hint: 'Menerima POST JSON bertanda tangan HMAC (header X-Wanar-Signature) — cocok untuk n8n, Zapier, Make, atau layanan Anda sendiri.' },
};

function parseUrl(raw, httpsOnly) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol === 'https:' || (!httpsOnly && u.protocol === 'http:')) return u;
  } catch { /* invalid */ }
  return null;
}

export function createWebhookChannel(id, env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const meta = META[id];
  if (!meta) throw new Error(`Unknown webhook channel: ${id}`);

  const urlKey = `${meta.env}_${id === 'webhook' ? 'URL' : 'WEBHOOK_URL'}`;
  const url = parseUrl(env[urlKey], meta.https);
  const secret = env.WEBHOOK_SECRET || '';
  const bearer = env.WEBHOOK_BEARER_TOKEN || '';
  const forceDry = boolEnv(env, `${meta.env}_DRY_RUN`);

  const limits = {
    dailyCap: intEnv(env, `${meta.env}_DAILY_CAP`, 1000, { min: 1 }),
    throttleMs: intEnv(env, `${meta.env}_THROTTLE_MS`, id === 'webhook' ? 200 : 1100),
    maxRecipients: 1,
    maxAttempts: intEnv(env, 'EMAIL_MAX_ATTEMPTS', 3, { min: 1 }),
  };

  const adapter = {
    id,
    label: meta.label,
    recipientKind: 'destination',
    capabilities: { subject: 'optional', html: id === 'webhook', attachments: false, maxTextLength: 20000, subscribers: false, fixedDestination: true },
    limits,
    supportsSubscribers: false,

    get configured() { return Boolean(url); },
    get mode() { return url && !forceDry ? 'live' : 'dry-run'; },

    describe() {
      return {
        id, label: meta.label, mode: adapter.mode, configured: Boolean(url), forceDryRun: forceDry,
        limits, capabilities: adapter.capabilities, recipientKind: 'destination',
        // Show where it goes without leaking the secret path/token of the URL.
        destination: url ? `${url.protocol}//${url.host}/…` : null,
        signed: id === 'webhook' ? Boolean(secret) : undefined,
        hasSecret: Boolean(url),
        missing: missingList([[urlKey, Boolean(url)]]),
        hint: meta.hint,
      };
    },

    normalizeAddress: normalizeDestination,

    async verify() {
      if (adapter.mode !== 'live') return { ok: false, mode: 'dry-run', error: `${urlKey} belum dikonfigurasi (mode simulasi)` };
      return { ok: true, mode: 'live', detail: `${url.host}` };
    },

    async send({ to, subject, text, html, recipient, campaign, mode }) {
      if (normalizeDestination(to) !== 'default') {
        throw new MailError(`Tujuan tidak dikenal untuk ${meta.label}: ${String(to).slice(0, 40)}`, ErrorKind.INVALID);
      }
      const subj = String(subject || '').replace(/\s+/g, ' ').trim().slice(0, 250);
      const body = String(text || '').trim();
      if (!subj && !body) throw new MailError('Isi pesan kosong', ErrorKind.INVALID);

      const payloads = FORMATS[id]({ subject: subj, text: body, html, recipient, campaign });
      const useMode = mode || adapter.mode;
      if (useMode !== 'live') return { messageId: dryId(id), accepted: ['default'], dryRun: true, parts: payloads.length };

      let first = null;
      for (const payload of payloads) {
        const raw = JSON.stringify(payload);
        const headers = { 'Content-Type': 'application/json' };
        if (id === 'webhook') {
          if (secret) headers['X-Wanar-Signature'] = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
          if (bearer) headers.Authorization = `Bearer ${bearer}`;
        }
        const target = id === 'discord' ? `${url.href}${url.search ? '&' : '?'}wait=true` : url.href;
        const r = await httpRequest(fetchImpl, target, { headers, body: raw });

        if (r.status === 410) {
          throw new MailError('Webhook sudah dicabut/dihapus (410) — buat ulang dan perbarui .env.', ErrorKind.CONFIG, { responseCode: 410 });
        }
        if (r.status === 429) {
          const ms = Number(r.json?.retry_after) > 0 ? Number(r.json.retry_after) * 1000 : retryAfterMs(r.headers, 5);
          throw new MailError('Terlalu banyak permintaan ke webhook', ErrorKind.TRANSIENT, { responseCode: 429, retryAfterMs: Math.min(ms, 120_000) });
        }
        if (!r.ok) throw classifyHttp(r.status, r.json?.message || r.text, r.headers);
        if (first == null) first = r.json?.id || `${id}-${Date.now().toString(36)}`;
      }
      return { messageId: String(first), accepted: ['default'], dryRun: false, parts: payloads.length };
    },

    close() {},
  };

  return adapter;
}
