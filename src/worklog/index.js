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
    notify: telegram
      ? async (chatId, text) => {
        if (telegram.mode !== 'live') throw new Error('Telegram belum dikonfigurasi (mode simulasi)');
        await telegram.send({ to: chatId, text });
      }
      : null,
  });

  if (automation?.inbox?.registerCommands) {
    automation.inbox.registerCommands(worklogTelegramCommands(service));
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
