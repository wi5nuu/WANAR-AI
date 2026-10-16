/**
 * src/worklog/index.js
 *
 * Composition root + process-wide handle for the work journal.
 *
 * @author Wisnu Alfian Nur Ashar
 */

import { createWorklogStore } from './store.js';
import { WorklogService } from './service.js';
import { worklogTelegramCommands } from './telegram.js';
import { createAlarms } from './alarms.js';
import { quickAlarm } from './quick-alarm.js';

let instance = null;

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} [deps.aiManager]
 * @param {object} [deps.automation]  automation module (for Telegram delivery + inbox)
 */
export function createWorklog({ db, aiManager = null, automation = null, env = process.env, now, fetchImpl, execFileImpl }) {
  const store = createWorklogStore(db);
  const telegram = automation?.channels?.has?.('telegram') ? automation.channels.get('telegram') : null;
  const ownerChats = String(env.TELEGRAM_AI_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

  const service = new WorklogService({
    store,
    aiManager,
    env,
    now,
    fetchImpl,
    execFileImpl,
    defaultChatId: () => ownerChats[0] || null,
    // Prefer the shared router: it understands "wa:628..." (WhatsApp) as well as
    // Telegram chat ids, so reminders follow the channel they were created in.
    notify: automation?.notify
      ? (chatId, text) => automation.notify(chatId, text)
      : telegram
        ? async (chatId, text) => {
          if (telegram.mode !== 'live') throw new Error('Telegram belum dikonfigurasi (mode simulasi)');
          await telegram.send({ to: chatId, text });
        }
        : null,
  });

  // Alarms ("bangunkan saya jam 4 subuh"): ring repeatedly until the owner answers.
  service.alarms = createAlarms({
    db,
    notify: service.notify,
    chatId: () => service._chatId(),
    now: () => service.now(),
    env,
    onChange: () => { try { service._changed(service.today(), 'alarm'); } catch { /* realtime is best effort */ } },
    call: `Mas ${String(env.OWNER_NAME || 'Wisnu Alfian Nur Ashar').split(/\s+/)[0]}`,
  });

  if (automation?.inbox?.registerCommands) {
    automation.inbox.registerCommands(worklogTelegramCommands(service));
    automation.inbox.registerCommands({
      alarm: {
        description: 'alarm bangun: /alarm 04:00 subuh · /alarm (daftar) · /alarm stop',
        run: async ({ arg }) => {
          const a = String(arg || '').trim();
          const text = !a ? 'alarm apa saja' : /^(stop|mati|matikan|off|batal)$/i.test(a) ? 'matikan alarm' : `alarm ${a}`;
          return quickAlarm(service, text, service.now(), env) || 'Format: /alarm 04:00 subuh';
        },
      },
    });
  }
  return { store, service };
}

export function initWorklog(deps) {
  if (!instance) instance = createWorklog(deps);
  return instance;
}

export function getWorklog() {
  return instance;
}

export function _resetWorklog() {
  instance?.service?.stop();
  instance = null;
}
