/**
 * src/automation/channels/meta.js
 *
 * Static facts about channels that do not need a live adapter — used by
 * payload validation (which is pure) and by the UI.
 *
 * @author Wisnu Alfian Nur Ashar
 */

export const CHANNEL_IDS = Object.freeze(['email', 'telegram', 'whatsapp', 'slack', 'discord', 'teams', 'webhook']);

/** Which recipient syntax a channel uses (see recipients.js KINDS). */
export const CHANNEL_KINDS = Object.freeze({
  email: 'email',
  telegram: 'chat_id',
  whatsapp: 'phone',
  slack: 'destination',
  discord: 'destination',
  teams: 'destination',
  webhook: 'destination',
});

/** Channels whose single destination lives in .env (no per-recipient address). */
export const FIXED_DESTINATION = Object.freeze(new Set(['slack', 'discord', 'teams', 'webhook']));

export function isChannelId(id) {
  return CHANNEL_IDS.includes(id);
}
