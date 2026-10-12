/**
 * src/automation/channels/index.js
 *
 * Channel registry. Every outbound medium implements the same small contract so
 * the campaign engine, scheduler, API and UI never special-case a service:
 *
 *   id, label, recipientKind, capabilities, limits, mode ('live'|'dry-run'),
 *   configured, describe(), normalizeAddress(), verify(), send(), close()
 *
 * Adding a channel (SMS, LINE, ...) means writing one adapter and registering it
 * here; nothing else changes.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { isValidEmail } from '../recipients.js';
import { createTelegramChannel } from './telegram.js';
import { createWhatsAppChannel } from './whatsapp.js';
import { createWebhookChannel } from './webhooks.js';
import { CHANNEL_IDS } from './meta.js';

export { CHANNEL_IDS, CHANNEL_KINDS, FIXED_DESTINATION, isChannelId } from './meta.js';

/** Wraps the existing SMTP Mailer in the channel contract. */
export function createEmailChannel(mailer) {
  const adapter = {
    id: 'email',
    label: 'Email (SMTP)',
    recipientKind: 'email',
    capabilities: { subject: 'required', html: true, attachments: true, maxTextLength: 100000, subscribers: false, fixedDestination: false },
    supportsSubscribers: false,
    mailer,

    get limits() {
      const c = mailer.cfg;
      return { dailyCap: c.dailyCap, throttleMs: c.throttleMs, maxRecipients: c.maxRecipients, maxAttempts: c.maxAttempts };
    },
    get configured() { return mailer.cfg.configured; },
    get mode() { return mailer.mode; },

    describe() {
      return {
        ...mailer.describe(),
        id: 'email', label: adapter.label, recipientKind: 'email',
        limits: adapter.limits, capabilities: adapter.capabilities,
        hint: 'SMTP biasa (Gmail memakai App Password). Isi SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM di .env.',
      };
    },

    normalizeAddress: (v) => {
      const e = String(v).trim().toLowerCase();
      return isValidEmail(e) ? e : null;
    },
    verify: () => mailer.verify(),
    send: (msg) => mailer.send(msg),
    close: () => mailer.close(),
  };
  return adapter;
}

/**
 * @param {{env?: object, mailer: object, fetchImpl?: Function}} deps
 */
export function createChannels({ env = process.env, mailer, fetchImpl }) {
  const opts = fetchImpl ? { fetchImpl } : {};
  const map = new Map();
  map.set('email', createEmailChannel(mailer));
  map.set('telegram', createTelegramChannel(env, opts));
  map.set('whatsapp', createWhatsAppChannel(env, opts));
  for (const id of ['slack', 'discord', 'teams', 'webhook']) {
    map.set(id, createWebhookChannel(id, env, opts));
  }

  return {
    ids: CHANNEL_IDS,
    has: (id) => map.has(id),
    get(id) {
      const ch = map.get(id);
      if (!ch) throw new Error(`Kanal tidak dikenal: ${id}`);
      return ch;
    },
    list: () => CHANNEL_IDS.map((id) => map.get(id)),
    describeAll: () => CHANNEL_IDS.map((id) => map.get(id).describe()),
    closeAll() {
      for (const ch of map.values()) {
        try { ch.close?.(); } catch { /* ignore */ }
      }
    },
  };
}
