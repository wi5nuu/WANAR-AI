/**
 * src/automation/index.js
 *
 * Composition root for the automation module.
 *
 *   const automation = createAutomation({ db, aiManager });
 *   automation.scheduler.start();
 *
 * Everything is injectable so tests can run against an in-memory database with
 * a fake transport and a stub AI manager.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { EventEmitter } from 'node:events';
import { createStore } from './store.js';
import { Mailer } from './mailer.js';
import { CampaignEngine } from './campaigns.js';
import { createAttachmentService } from './attachments.js';
import { createChannels } from './channels/index.js';
import { TelegramInbox, makeChatResponder } from './telegram-inbox.js';
import { AutomationScheduler } from './scheduler.js';

export function createAutomation({
  db, aiManager, env = process.env, transport, engineOptions = {}, schedulerOptions = {}, attachmentsDir, fetchImpl,
}) {
  if (!db) throw new Error('createAutomation: `db` is required');
  const store = createStore(db);
  const mailer = new Mailer(env, { transport });
  const attachments = createAttachmentService({
    store,
    ...(attachmentsDir ? { dir: attachmentsDir } : {}),
  });
  const channels = createChannels({ env, mailer, fetchImpl });
  const engine = new CampaignEngine({ store, mailer, channels, attachments, ...engineOptions });
  // How long after a missed slot a job may still be run (laptop was off/asleep).
  const catchUpHours = parseFloat(env.AUTOMATION_CATCHUP_HOURS || '6');
  const inbox = new TelegramInbox({
    channel: channels.get('telegram'),
    store,
    env,
    responder: aiManager ? makeChatResponder({ aiManager }) : null,
  });
  const scheduler = new AutomationScheduler({
    store,
    engine,
    aiManager,
    ...(Number.isFinite(catchUpHours) && catchUpHours >= 0 ? { catchUpWindowMs: catchUpHours * 3_600_000 } : {}),
    ...schedulerOptions,
  });

  // One merged realtime stream for SSE consumers.
  const events = new EventEmitter();
  events.setMaxListeners(50);
  engine.on('campaign', (e) => events.emit('event', { channel: 'campaign', ...e }));
  engine.on('alert', (e) => events.emit('event', { channel: 'alert', ...e }));
  scheduler.on('job', (e) => events.emit('event', { channel: 'job', ...e }));
  inbox.on('subscribed', (e) => events.emit('event', { channel: 'subscriber', type: 'subscribed', ...e }));
  inbox.on('ai_reply', (e) => events.emit('event', { channel: 'subscriber', type: 'ai_reply', ...e }));
  inbox.on('unsubscribed', (e) => events.emit('event', { channel: 'subscriber', type: 'unsubscribed', ...e }));
  scheduler.on('review_needed', (e) => events.emit('event', { channel: 'review', ...e }));

  return { store, mailer, engine, scheduler, events, attachments, channels, inbox };
}

export * from './store.js';
export { parseSchedule, nextRun, previewSchedule, describe, upcoming, ScheduleError } from './cron.js';
export { parseRecipients, isValidEmail } from './recipients.js';
export { render, extractVars, builtinVars } from './templates.js';
export { generateEmail, generateCode, generateText } from './ai-compose.js';
export { JOB_TYPES, JobError } from './scheduler.js';
export { CampaignError } from './campaigns.js';
export { AttachmentError, sanitizeFilename } from './attachments.js';
export { MailError, ErrorKind } from './mailer.js';
export { CHANNEL_IDS, CHANNEL_KINDS, createChannels } from './channels/index.js';
